import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'

// ---------------------------------------------------------------------------
// VENDOR ACCOUNTS PAGE (20261113010000, docs/28 Part A).
//
// Same harness as feedback.test.ts: every probe runs AS a signed-in user inside
// a transaction that is ALWAYS rolled back; throwaway accounts are hard-deleted
// afterwards. Every refusal has a positive control beside it (docs/03 vacuity
// rule) — the superadmin doing the same thing successfully.
//
//   s = the superadmin       a = an org ADMIN (no read path at all)
// ---------------------------------------------------------------------------

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const ownerDbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const sql = postgres(ownerDbUrl, { prepare: false, max: 1 })
const admin = () => createClient(url, serviceKey, { auth: { persistSession: false } })

const who = ['s', 'a'] as const
type Who = (typeof who)[number]
const ids = Object.fromEntries(who.map((k) => [k, ''])) as Record<Who, string>

beforeAll(async () => {
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for this suite')
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  for (const k of who) {
    const { data, error } = await admin().auth.admin.createUser({
      email: `vendors-${k}-${tag}@demo.local`, password: 'password123', email_confirm: true,
    })
    if (error) throw new Error(`createUser ${k}: ${error.message}`)
    ids[k] = data.user!.id
  }
})

afterAll(async () => {
  try {
    for (const id of Object.values(ids).filter(Boolean)) {
      const { error } = await admin().auth.admin.deleteUser(id)
      expect(error, 'could not hard-delete a probe account').toBeNull()
    }
  } finally {
    await sql.end()
  }
})

type Tx = postgres.TransactionSql
type Outcome = { error: string | null; rows: number; data: postgres.Row[] }

async function rolledBack<T>(body: (tx: Tx) => Promise<T>): Promise<T> {
  let result!: T
  await sql
    .begin(async (tx) => {
      result = await body(tx)
      throw new Error('__rollback__')
    })
    .catch((e: unknown) => {
      if ((e as Error)?.message !== '__rollback__') throw e
    })
  return result
}

async function as(tx: Tx, user: Who, stmt: () => Promise<postgres.RowList<postgres.Row[]>>): Promise<Outcome> {
  await tx.unsafe('savepoint sp')
  let out: Outcome
  try {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: ids[user], role: 'authenticated' })}, true)`
    await tx.unsafe('set local role authenticated')
    const r = await stmt()
    await tx.unsafe('release savepoint sp')
    out = { error: null, rows: r.count, data: [...r] }
  } catch (e: unknown) {
    await tx.unsafe('rollback to savepoint sp')
    out = { error: String((e as Error).message), rows: 0, data: [] }
  }
  await tx.unsafe('reset role')
  await tx`select set_config('request.jwt.claims', '', true)`
  return out
}

/** s is made superadmin; a is the admin of a throwaway org. Returns one seeded account id. */
async function setup(tx: Tx): Promise<string> {
  const [o] = await tx<{ id: string }[]>`
    insert into orgs (name, slug) values ('Vendor probe', ${`vp-${Math.random().toString(36).slice(2, 10)}`}) returning id`
  await tx`insert into org_members (org_id, user_id, role, status, accepted_at) values (${o!.id}, ${ids.a}, 'admin', 'active', now())`
  await tx`insert into user_private (user_id, is_superadmin) values (${ids.s}, true)
           on conflict (user_id) do update set is_superadmin = true`
  const [v] = await tx<{ id: string }[]>`select id from vendor_accounts where service = 'Supabase'`
  return v!.id
}

describe('vendor accounts: only the superadmin reads or writes', () => {
  it('the seed exists, so a zero below is a real refusal', async () => {
    const [c] = await sql<{ n: number; creds: number }[]>`
      select (select count(*)::int from vendor_accounts) n, (select count(*)::int from vendor_account_credentials) creds`
    expect(c!.n).toBeGreaterThanOrEqual(9)
    expect(c!.creds).toBeGreaterThan(0)
  })

  it('an org admin reads nothing from any of the four tables; the superadmin reads all', async () => {
    await rolledBack(async (tx) => {
      await setup(tx)
      await tx`insert into vendor_account_opens (account_id, opened_by) select id, ${ids.s} from vendor_accounts limit 1`
      for (const t of ['vendor_accounts', 'vendor_account_dates', 'vendor_account_credentials', 'vendor_account_opens']) {
        const adminRead = await as(tx, 'a', () => tx.unsafe(`select * from ${t}`))
        const superRead = await as(tx, 's', () => tx.unsafe(`select * from ${t}`))
        expect(adminRead.error, t).toBeNull()
        expect(adminRead.rows, `${t}: org admin`).toBe(0)
        expect(superRead.rows, `${t}: superadmin control`).toBeGreaterThan(0)
      }
    })
  })

  it('an org admin cannot add, change or remove anything; the superadmin can', async () => {
    await rolledBack(async (tx) => {
      const acct = await setup(tx)
      const ins = await as(tx, 'a', () => tx`insert into vendor_accounts (service) values ('evil')`)
      expect(ins.error).toMatch(/row-level security/)
      const upd = await as(tx, 'a', () => tx`update vendor_accounts set notes = 'x' where id = ${acct}`)
      expect(upd.rows).toBe(0)
      const del = await as(tx, 'a', () => tx`delete from vendor_account_credentials where account_id = ${acct}`)
      expect(del.rows).toBe(0)
      const open = await as(tx, 'a', () => tx`insert into vendor_account_opens (account_id) values (${acct})`)
      expect(open.error).toMatch(/row-level security/)

      const sIns = await as(tx, 's', () => tx`insert into vendor_accounts (service) values ('Probe vendor')`)
      expect(sIns.error).toBeNull()
      const sUpd = await as(tx, 's', () => tx`update vendor_accounts set notes = 'checked' where id = ${acct}`)
      expect(sUpd.rows).toBe(1)
      const sDel = await as(tx, 's', () => tx`delete from vendor_account_credentials where account_id = ${acct}`)
      expect(sDel.rows).toBeGreaterThan(0)
    })
  })

  it('an account is never deleted, even by the superadmin (it is closed instead)', async () => {
    await rolledBack(async (tx) => {
      const acct = await setup(tx)
      const del = await as(tx, 's', () => tx`delete from vendor_accounts where id = ${acct}`)
      expect(del.error).toMatch(/permission denied/)
      const close = await as(tx, 's', () => tx`update vendor_accounts set status = 'closed' where id = ${acct}`)
      expect(close.rows).toBe(1)
    })
  })
})

describe('vendor accounts: the open history is append-only and cannot be forged', () => {
  it('an open records the caller and the time; neither can be supplied', async () => {
    await rolledBack(async (tx) => {
      const acct = await setup(tx)
      const ok = await as(tx, 's', () => tx`insert into vendor_account_opens (account_id) values (${acct})`)
      expect(ok.error).toBeNull()
      const [row] = await tx<{ opened_by: string; age: number }[]>`
        select opened_by, extract(epoch from now() - opened_at)::int age from vendor_account_opens where account_id = ${acct}`
      expect(row!.opened_by).toBe(ids.s)
      expect(row!.age).toBeLessThan(60)

      const backdated = await as(tx, 's', () =>
        tx`insert into vendor_account_opens (account_id, opened_at) values (${acct}, now() - interval '1 day')`)
      expect(backdated.error).toMatch(/permission denied/)
      const forged = await as(tx, 's', () =>
        tx`insert into vendor_account_opens (account_id, opened_by) values (${acct}, ${ids.a})`)
      expect(forged.error).toMatch(/permission denied/)
    })
  })

  it('no one can change or delete an open', async () => {
    await rolledBack(async (tx) => {
      const acct = await setup(tx)
      await as(tx, 's', () => tx`insert into vendor_account_opens (account_id) values (${acct})`)
      const upd = await as(tx, 's', () => tx`update vendor_account_opens set opened_at = now() - interval '1 year'`)
      expect(upd.error).toMatch(/permission denied/)
      const del = await as(tx, 's', () => tx`delete from vendor_account_opens`)
      expect(del.error).toMatch(/permission denied/)
    })
  })
})

describe('vendor accounts: the page cannot hold a password or key', () => {
  const refused = [
    ['notes', 'Root password: hunter2xyz'],
    ['notes', 'Summer2026!'],
    ['notes', 'key 9dd4e461268c8034f5c8564e155c67a6'],
    ['notes', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abc'],
    ['plan', 'sk_live_51HaBcDeFgHiJkLmNoPq'],
    ['owner_login', 'admin P@ssw0rd1'],
  ] as const

  for (const [column, value] of refused) {
    it(`refuses ${column} = ${JSON.stringify(value)}`, async () => {
      await rolledBack(async (tx) => {
        const acct = await setup(tx)
        const r = await as(tx, 's', () => tx.unsafe(`update vendor_accounts set ${column} = $1 where id = $2`, [value, acct]))
        expect(r.error).toMatch(/never stores passwords or keys/)
      })
    })
  }

  it('lets ordinary notes through (the control)', async () => {
    await rolledBack(async (tx) => {
      const acct = await setup(tx)
      const r = await as(tx, 's', () =>
        tx`update vendor_accounts set notes = ${'Password: in 1Password. Key kept in .env.deploy as JAAS_PRIVATE_KEY; renews 2026-12-01, $15/yr.'}
           where id = ${acct}`)
      expect(r.error).toBeNull()
      expect(r.rows).toBe(1)
    })
  })

  it('a date label is checked too (the trigger reads every text column)', async () => {
    await rolledBack(async (tx) => {
      const acct = await setup(tx)
      const bad = await as(tx, 's', () =>
        tx`insert into vendor_account_dates (account_id, kind, label) values (${acct}, 'other', 'token = abc123def')`)
      expect(bad.error).toMatch(/never stores passwords or keys/)
      const good = await as(tx, 's', () =>
        tx`insert into vendor_account_dates (account_id, kind, label) values (${acct}, 'key_expiry', 'VERCEL_TOKEN expires')`)
      expect(good.error).toBeNull()
    })
  })

  it('a credential is a NAME, never a value', async () => {
    await rolledBack(async (tx) => {
      const acct = await setup(tx)
      for (const value of ['hunter2', 'K005abcdefGHIJKLmnop', 'JBSWY3DPEHPK3PXP', 'b2 app key']) {
        const r = await as(tx, 's', () =>
          tx`insert into vendor_account_credentials (account_id, store, name) values (${acct}, 'env_deploy', ${value})`)
        expect(r.error, value).toMatch(/check constraint|violates|never stores/)
      }
      const noName = await as(tx, 's', () =>
        tx`insert into vendor_account_credentials (account_id, store) values (${acct}, 'github_secret')`)
      expect(noName.error).toMatch(/check constraint|violates/)
      const ok = await as(tx, 's', () =>
        tx`insert into vendor_account_credentials (account_id, store, name) values (${acct}, 'vercel_env', 'JAAS_PRIVATE_KEY')`)
      expect(ok.error).toBeNull()
    })
  })

  it('a sign-in link may not carry a password, query or fragment', async () => {
    await rolledBack(async (tx) => {
      const acct = await setup(tx)
      for (const link of ['https://bob:pw@example.com/', 'https://example.com/login?token=abc', 'http://example.com/', 'javascript:alert(1)']) {
        const r = await as(tx, 's', () => tx`update vendor_accounts set sign_in_url = ${link} where id = ${acct}`)
        expect(r.error, link).not.toBeNull()
      }
      const ok = await as(tx, 's', () => tx`update vendor_accounts set sign_in_url = 'https://supabase.com/dashboard/sign-in' where id = ${acct}`)
      expect(ok.error).toBeNull()
    })
  })
})
