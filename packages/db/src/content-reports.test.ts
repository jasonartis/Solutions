import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'

// ---------------------------------------------------------------------------
// CONTENT REPORTS (20261114010000, module-9 spec §B1/§H(c)).
//
// The one write path open to the anonymous internet. Every probe runs AS anon
// or as a signed-in user inside a transaction that is ALWAYS rolled back;
// throwaway accounts are hard-deleted afterwards. Every refusal has a positive
// control beside it (docs/03 vacuity rule).
//
//   s = the superadmin      m = an ordinary member (no read path)
//   TOKEN = the server's token, installed per transaction
// ---------------------------------------------------------------------------

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const ownerDbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const sql = postgres(ownerDbUrl, { prepare: false, max: 1 })
const admin = () => createClient(url, serviceKey, { auth: { persistSession: false } })

const who = ['s', 'm'] as const
type Who = (typeof who)[number] | 'anon'
const ids: Record<(typeof who)[number], string> = { s: '', m: '' }
const TOKEN = 'content-report-test-token'

beforeAll(async () => {
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for this suite')
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  for (const k of who) {
    const { data, error } = await admin().auth.admin.createUser({
      email: `reports-${k}-${tag}@demo.local`, password: 'password123', email_confirm: true,
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
type Outcome = { error: string | null; data: postgres.Row[] }

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
    if (user === 'anon') {
      await tx.unsafe('set local role anon')
    } else {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: ids[user], role: 'authenticated' })}, true)`
      await tx.unsafe('set local role authenticated')
    }
    const r = await stmt()
    await tx.unsafe('release savepoint sp')
    out = { error: null, data: [...r] }
  } catch (e: unknown) {
    await tx.unsafe('rollback to savepoint sp')
    out = { error: String((e as Error).message), data: [] }
  }
  await tx.unsafe('reset role')
  await tx`select set_config('request.jwt.claims', '', true)`
  return out
}

/** Installs TOKEN as the server's token (whatever the seed put there) and makes s superadmin. */
async function setup(tx: Tx) {
  await tx`insert into content_report_intake_config (id, token_sha256)
           values (true, encode(sha256(convert_to(${TOKEN}, 'UTF8')), 'hex'))
           on conflict (id) do update set token_sha256 = excluded.token_sha256`
  await tx`update user_private set is_superadmin = true where user_id = ${ids.s}`
}

function submit(tx: Tx, o: { token?: string | null; ip?: string; where?: string; reason?: string | null; details?: string | null; email?: string; accurate?: boolean; signature?: string | null; nonconsent?: boolean }) {
  return tx`select public.content_report_submit(
    ${o.token === undefined ? TOKEN : o.token}, ${o.ip ?? '203.0.113.1'}, ${o.where ?? 'https://example.test/o/x'},
    ${o.reason === undefined ? 'copyright' : o.reason}, ${o.details ?? null}, ${o.email ?? 'reporter@example.test'},
    ${o.accurate ?? true}, ${o.signature ?? null}, ${o.nonconsent ?? false})`
}

describe('content reports — the public intake', () => {
  it('anon can submit WITH the token, and nothing without it', async () => {
    await rolledBack(async (tx) => {
      await setup(tx)
      const ok = await as(tx, 'anon', () => submit(tx, {}))
      expect(ok.error).toBeNull()
      for (const token of [null, 'wrong-token']) {
        const r = await as(tx, 'anon', () => submit(tx, { token }))
        expect(r.error).toContain('Report intake unavailable')
      }
      const { n } = (await tx<{ n: number }[]>`select count(*)::int as n from content_reports where where_seen = 'https://example.test/o/x'`)[0]!
      expect(n).toBe(1)
    })
  })

  it('refuses everything when no token is configured', async () => {
    await rolledBack(async (tx) => {
      await tx`delete from content_report_intake_config`
      const r = await as(tx, 'anon', () => submit(tx, {}))
      expect(r.error).toContain('Report intake unavailable')
    })
  })

  it('rejects bad input with a plain message, never a raw constraint error', async () => {
    await rolledBack(async (tx) => {
      await setup(tx)
      const bad = [
        { where: '\n\t ' }, { reason: null }, { reason: 'spam' }, { accurate: false },
        { email: 'not-an-email' }, { where: 'x'.repeat(1001) }, { details: 'é'.repeat(2001) },
      ]
      for (const b of bad) {
        const r = await as(tx, 'anon', () => submit(tx, b))
        expect(r.error, JSON.stringify(b)).toBe('Invalid report')
      }
      // Control: the same shape with valid values goes through, trimmed and lower-cased.
      const ok = await as(tx, 'anon', () => submit(tx, { where: '  https://a.test/p  ', email: ' Dana@Example.TEST ', details: '  the 1987 portrait ' }))
      expect(ok.error).toBeNull()
      const [row] = await tx`select where_seen, reporter_email, details, status from content_reports where where_seen = 'https://a.test/p'`
      expect(row).toMatchObject({ reporter_email: 'dana@example.test', details: 'the 1987 portrait', status: 'new' })
    })
  })

  it('an intimate-image report needs a signature and the good-faith statement; other reasons store neither', async () => {
    await rolledBack(async (tx) => {
      await setup(tx)
      const missing = [
        { reason: 'intimate', where: 'ti-1', signature: null, nonconsent: true },
        { reason: 'intimate', where: 'ti-2', signature: '   ', nonconsent: true },
        { reason: 'intimate', where: 'ti-3', signature: 'Dana Reporter', nonconsent: false },
        { reason: 'intimate', where: 'ti-4', signature: 'x'.repeat(201), nonconsent: true },
      ]
      for (const b of missing) {
        const r = await as(tx, 'anon', () => submit(tx, b))
        expect(r.error, JSON.stringify(b)).toBe('Invalid report')
      }
      // Control: signed and attested goes through and is kept as the record.
      const ok = await as(tx, 'anon', () => submit(tx, { reason: 'intimate', where: 'ti-ok', signature: '  Dana Reporter ', nonconsent: true }))
      expect(ok.error).toBeNull()
      const [row] = await tx`select signature_name, attested_nonconsent from content_reports where where_seen = 'ti-ok'`
      expect(row).toMatchObject({ signature_name: 'Dana Reporter', attested_nonconsent: true })
      // Another reason: a signature sent anyway is not stored.
      const other = await as(tx, 'anon', () => submit(tx, { reason: 'copyright', where: 'ti-cr', signature: 'Dana', nonconsent: true }))
      expect(other.error).toBeNull()
      const [cr] = await tx`select signature_name, attested_nonconsent from content_reports where where_seen = 'ti-cr'`
      expect(cr).toMatchObject({ signature_name: null, attested_nonconsent: false })
    })
  })

  it('caps one address at 5 a day; another address is unaffected; the email is not a cap', async () => {
    await rolledBack(async (tx) => {
      await setup(tx)
      for (let i = 0; i < 5; i++) {
        const r = await as(tx, 'anon', () => submit(tx, { ip: '198.51.100.7', email: `r${i}@example.test`, where: `cap-${i}` }))
        expect(r.error).toBeNull()
      }
      const sixth = await as(tx, 'anon', () => submit(tx, { ip: '198.51.100.7', email: 'fresh@example.test', where: 'cap-6' }))
      expect(sixth.error).toContain('Too many reports')
      // Same email, different address: accepted (a victim's email cannot be burned).
      const other = await as(tx, 'anon', () => submit(tx, { ip: '198.51.100.8', email: 'r0@example.test', where: 'cap-7' }))
      expect(other.error).toBeNull()
      // No raw address is stored anywhere.
      const { n } = (await tx<{ n: number }[]>`select count(*)::int as n from content_report_intake where client_hash like '%198.51%'`)[0]!
      expect(n).toBe(0)
    })
  })

  it('records a refusal at most once a minute per address', async () => {
    await rolledBack(async (tx) => {
      await setup(tx)
      for (let i = 0; i < 3; i++) {
        const r = await as(tx, 'anon', () => tx`select public.content_report_note_refusal(${TOKEN}, '192.0.2.9')`)
        expect(r.error).toBeNull()
      }
      const bad = await as(tx, 'anon', () => tx`select public.content_report_note_refusal('wrong', '192.0.2.9')`)
      expect(bad.error).toContain('Report intake unavailable')
      const { n } = (await tx<{ n: number }[]>`select count(*)::int as n from content_report_intake where not accepted`)[0]!
      expect(n).toBe(1)
    })
  })
})

describe('content reports — who reads and reviews', () => {
  it('only the superadmin reads reports; anon and members cannot reach the tables', async () => {
    await rolledBack(async (tx) => {
      await setup(tx)
      await as(tx, 'anon', () => submit(tx, { where: 'read-probe' }))
      const sa = await as(tx, 's', () => tx`select id from content_reports where where_seen = 'read-probe'`)
      expect(sa.data.length).toBe(1) // control
      const mem = await as(tx, 'm', () => tx`select id from content_reports`)
      expect(mem.error).toBeNull()
      expect(mem.data.length).toBe(0)
      const an = await as(tx, 'anon', () => tx`select id from content_reports`)
      expect(an.error).toContain('permission denied')
      for (const t of ['content_report_intake', 'content_report_intake_config']) {
        for (const u of ['s', 'm', 'anon'] as const) {
          const r = await as(tx, u, () => tx.unsafe(`select 1 from public.${t}`))
          expect(r.error, `${u} reading ${t}`).toContain('permission denied')
        }
      }
      const write = await as(tx, 's', () => tx`update content_reports set status = 'dismissed'`)
      expect(write.error).toContain('permission denied')
      const del = await as(tx, 's', () => tx`delete from content_reports`)
      expect(del.error).toContain('permission denied')
    })
  })

  it('the superadmin changes status; the first close time survives a reopen; others get "not found"', async () => {
    await rolledBack(async (tx) => {
      await setup(tx)
      await as(tx, 'anon', () => submit(tx, { where: 'status-probe' }))
      const { id } = (await tx<{ id: string }[]>`select id from content_reports where where_seen = 'status-probe'`)[0]!

      const m = await as(tx, 'm', () => tx`select public.content_report_set_status(${id}, 'dismissed', null)`)
      expect(m.error).toContain('Report not found')
      const missing = await as(tx, 's', () => tx`select public.content_report_set_status(gen_random_uuid(), 'dismissed', null)`)
      expect(missing.error).toContain('Report not found')
      const badStatus = await as(tx, 's', () => tx`select public.content_report_set_status(${id}, 'deleted', null)`)
      expect(badStatus.error).toContain('Unknown status')

      expect((await as(tx, 's', () => tx`select public.content_report_set_status(${id}, 'actioned', 'removed the file')`)).error).toBeNull()
      const [closed] = await tx`select status, closed_at, first_closed_at, staff_note, reviewed_by from content_reports where id = ${id}`
      expect(closed).toMatchObject({ status: 'actioned', staff_note: 'removed the file', reviewed_by: ids.s })
      expect(closed!.closed_at).not.toBeNull()

      expect((await as(tx, 's', () => tx`select public.content_report_set_status(${id}, 'reviewing', null)`)).error).toBeNull()
      const [reopened] = await tx`select closed_at, first_closed_at, staff_note from content_reports where id = ${id}`
      expect(reopened!.closed_at).toBeNull()
      expect(reopened!.first_closed_at).toEqual(closed!.first_closed_at)
      expect(reopened!.staff_note).toBe('removed the file')
    })
  })

  it('intake status is superadmin-only and counts accepted and refused', async () => {
    await rolledBack(async (tx) => {
      await setup(tx)
      await as(tx, 'anon', () => submit(tx, { where: 'count-probe' }))
      await as(tx, 'anon', () => tx`select public.content_report_note_refusal(${TOKEN}, '192.0.2.50')`)
      const s = await as(tx, 's', () => tx`select * from public.content_report_intake_status()`)
      expect(s.error).toBeNull()
      expect(s.data[0]).toMatchObject({ configured: true, daily_cap: 500 })
      expect(Number(s.data[0]!.accepted_24h)).toBeGreaterThanOrEqual(1)
      expect(Number(s.data[0]!.refused_24h)).toBeGreaterThanOrEqual(1)
      const m = await as(tx, 'm', () => tx`select * from public.content_report_intake_status()`)
      expect(m.error).toContain('Not allowed')
      const an = await as(tx, 'anon', () => tx`select * from public.content_report_intake_status()`)
      expect(an.error).toContain('permission denied')
    })
  })
})
