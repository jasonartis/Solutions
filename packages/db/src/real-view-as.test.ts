import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'
import { dataBrowserDeclarations } from '@platform/core'

// ---------------------------------------------------------------------------
// REAL VIEW-AS (20261116010000; docs/13 "REAL VIEW-AS" → "THE DESIGN").
//
// Every probe runs AS a real role inside a transaction that is ALWAYS rolled
// back; throwaway accounts are hard-deleted afterwards. Each refusal has a
// positive control: the same statement WITHOUT the view_as claim succeeds.
//
//   s  = made superadmin inside the transaction
//   p  = the person viewed: an active member of a throwaway org with classroom on
//   x  = an ordinary account in no org
// ---------------------------------------------------------------------------

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const ownerDbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const sql = postgres(ownerDbUrl, { prepare: false, max: 1 })
const admin = () => createClient(url, serviceKey, { auth: { persistSession: false } })

const who = ['s', 'p', 'x'] as const
type Who = (typeof who)[number]
const ids: Record<Who, string> = { s: '', p: '', x: '' }

beforeAll(async () => {
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for this suite')
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  for (const k of who) {
    const { data, error } = await admin().auth.admin.createUser({
      email: `realview-${k}-${tag}@demo.local`, password: 'password123', email_confirm: true,
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

/** Runs `stmt` as `user`; `viewAs` adds the claim a real-view token carries. */
async function as(tx: Tx, user: Who, stmt: () => Promise<postgres.RowList<postgres.Row[]>>, viewAs = false): Promise<Outcome> {
  await tx.unsafe('savepoint sp')
  let out: Outcome
  try {
    const claims: Record<string, unknown> = { sub: ids[user], role: 'authenticated' }
    if (viewAs) claims.view_as = { session: 'test', actor: ids.s }
    await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`
    await tx.unsafe('set local role authenticated')
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

/** A throwaway org with classroom on, p an active member, s superadmin. */
async function setup(tx: Tx) {
  await tx`update user_private set is_superadmin = true where user_id = ${ids.s}`
  const [org] = await tx`insert into orgs (name, slug) values ('Real view probe', ${'real-view-' + Date.now()}) returning id, slug`
  await tx`insert into org_modules (org_id, module_key, enabled) values (${org!.id}, 'classroom', true)`
  await tx`insert into org_members (org_id, user_id, role, status) values (${org!.id}, ${ids.p}, 'member', 'active')`
  return org as { id: string; slug: string }
}

const start = (tx: Tx, target: string, org: string, module = 'classroom') => () =>
  tx`select public.view_as_real_start(${target}, ${org}, ${module}) as id`

describe('view_as_real_start — who may start a view, of whom', () => {
  it('the superadmin may view an active member; nobody else may start one', async () => {
    await rolledBack(async (tx) => {
      const org = await setup(tx)
      const ok = await as(tx, 's', start(tx, ids.p, org.id))
      expect(ok.error).toBeNull()
      expect(ok.data[0]!.id).toMatch(/[0-9a-f-]{36}/)
      expect((await as(tx, 'x', start(tx, ids.p, org.id))).error).toMatch(/Not allowed/)
      expect((await as(tx, 'p', start(tx, ids.x, org.id))).error).toMatch(/Not allowed/)
      // A viewed screen can never start another view (the claim is refused even for a superadmin).
      expect((await as(tx, 's', start(tx, ids.p, org.id), true)).error).toMatch(/Not allowed/)
    })
  })

  it('refuses: oneself, a superadmin, a non-member, another module, a module that is off', async () => {
    await rolledBack(async (tx) => {
      const org = await setup(tx)
      expect((await as(tx, 's', start(tx, ids.s, org.id))).error).toMatch(/someone else/)
      expect((await as(tx, 's', start(tx, ids.x, org.id))).error).toMatch(/not an active member/)
      expect((await as(tx, 's', start(tx, ids.p, org.id, 'speed-dating'))).error).toMatch(/not available for this module/)
      await tx`update user_private set is_superadmin = true where user_id = ${ids.p}`
      expect((await as(tx, 's', start(tx, ids.p, org.id))).error).toMatch(/superadmin cannot be viewed/)
      await tx`update user_private set is_superadmin = false where user_id = ${ids.p}`
      // Not an UPDATE: org_modules_pin_enablement silently reverts `enabled` for anyone but the
      // superadmin, which would make this check pass for the wrong reason. Remove the row instead.
      await tx`delete from org_modules where org_id = ${org.id} and module_key = 'classroom'`
      expect((await tx`select count(*)::int as n from org_modules where org_id = ${org.id}`)[0]!.n).toBe(0)
      expect((await as(tx, 's', start(tx, ids.p, org.id))).error).toMatch(/does not have this module on/)
    })
  })
})

describe('view_as_real_check — the proxy’s question, and the page log', () => {
  it('answers the owner of an open session, scopes the path, logs only in scope, and ends', async () => {
    await rolledBack(async (tx) => {
      const org = await setup(tx)
      const id = (await as(tx, 's', start(tx, ids.p, org.id))).data[0]!.id as string
      const check = (path: string, log = true) => () => tx`select * from public.view_as_real_check(${id}, ${path}, ${log})`

      const inside = await as(tx, 's', check(`/o/${org.slug}/m/classroom/homework/abc`))
      expect(inside.data[0]).toMatchObject({ target_user_id: ids.p, org_slug: org.slug, in_scope: true })
      expect((await as(tx, 's', check(`/o/${org.slug}/m/classroom`))).data[0]!.in_scope).toBe(true)
      // Not in scope: another module, another org's slug that merely starts the same, the console.
      expect((await as(tx, 's', check(`/o/${org.slug}/m/speed-dating`))).data[0]!.in_scope).toBe(false)
      expect((await as(tx, 's', check(`/o/${org.slug}/m/classroomx`))).data[0]!.in_scope).toBe(false)
      expect((await as(tx, 's', check(`/o/${org.slug}x/m/classroom`))).data[0]!.in_scope).toBe(false)
      expect((await as(tx, 's', check('/console'))).data[0]!.in_scope).toBe(false)

      const [logged] = await tx`select count(*)::int as n from view_as_real_page_views where session_id = ${id}`
      expect(logged!.n).toBe(2) // the two in-scope page loads only

      // Someone else asking about this session gets nothing.
      expect((await as(tx, 'x', check(`/o/${org.slug}/m/classroom`))).data).toHaveLength(0)

      // Revoked: once the person is no longer an ACTIVE member, the session answers nothing.
      await tx`update org_members set status = 'pending' where org_id = ${org.id} and user_id = ${ids.p}`
      expect((await as(tx, 's', check(`/o/${org.slug}/m/classroom`))).data).toHaveLength(0)
      await tx`update org_members set status = 'active' where org_id = ${org.id} and user_id = ${ids.p}`

      const end = await as(tx, 's', () => tx`select public.view_as_real_end(${id})`)
      expect(end.error).toBeNull()
      expect((await as(tx, 's', check(`/o/${org.slug}/m/classroom`))).data).toHaveLength(0)
    })
  })
})

describe('the read-only gate', () => {
  it('a view_as token cannot write a table, inside a definer, or a storage object; without it the same write works', async () => {
    await rolledBack(async (tx) => {
      await setup(tx)
      // The pre-request hook is what PostgREST runs; here it is called the same way.
      const viaHook = async (viewAs: boolean) =>
        as(tx, 'p', async () => {
          await tx`select public.view_as_pre_request()`
          return tx`select public.feedback_open('bug', 'probe title', 'probe body', null, null, '{}'::jsonb) as id`
        }, viewAs)
      const blocked = await viaHook(true)
      expect(blocked.error).toMatch(/read-only transaction/)
      const allowed = await viaHook(false)
      expect(allowed.error).toBeNull() // the control: the same call writes without the claim

      // Storage: the restrictive policy refuses an insert for the claim. A
      // throwaway bucket with an allow-all insert policy (rolled back) gives the
      // control: without the claim the same insert succeeds, so the refusal is
      // the view-as policy and not just the bucket's ordinary rules.
      await tx`insert into storage.buckets (id, name, public) values ('view-as-probe', 'view-as-probe', false)`
      await tx.unsafe(`create policy view_as_probe_put on storage.objects for insert to authenticated with check (bucket_id = 'view-as-probe')`)
      const put = (viewAs: boolean) =>
        as(tx, 'p', () => tx`insert into storage.objects (bucket_id, name, owner) values ('view-as-probe', ${'probe/' + viewAs + '.png'}, ${ids.p})`, viewAs)
      expect((await put(true)).error).toMatch(/row-level security/)
      expect((await put(false)).error).toBeNull()
    })
  })

  it('the hook is installed on the authenticator role', async () => {
    const [r] = await sql`select rolconfig from pg_roles where rolname = 'authenticator'`
    expect(r!.rolconfig).toContain('pgrst.db_pre_request=public.view_as_pre_request')
  })

  it('every neverReadable table has a restrictive <table>_no_view_as policy', async () => {
    const tables = Object.values(dataBrowserDeclarations).flatMap((d) => d.neverReadable.map((u) => u.table))
    expect(tables.length).toBeGreaterThan(0) // sd_notes today
    for (const t of tables) {
      const [p] = await sql`
        select polpermissive from pg_policy where polname = ${t + '_no_view_as'} and polrelid = ${'public.' + t}::regclass`
      expect(p, `${t} lacks ${t}_no_view_as`).toBeTruthy()
      expect(p!.polpermissive).toBe(false)
    }
  })

  it('the log tables: superadmin reads, nobody writes directly', async () => {
    await rolledBack(async (tx) => {
      const org = await setup(tx)
      await as(tx, 's', start(tx, ids.p, org.id))
      expect((await as(tx, 's', () => tx`select * from view_as_real_sessions`)).data.length).toBeGreaterThan(0)
      expect((await as(tx, 'p', () => tx`select * from view_as_real_sessions`)).data).toHaveLength(0)
      const direct = await as(tx, 's', () => tx`insert into view_as_real_sessions (module_key) values ('classroom')`)
      expect(direct.error).toMatch(/permission denied/)
    })
  })
})

describe('what a viewed screen may read (docs/13 Q3)', () => {
  // Fable review finding 2: "a real view shows only what the superadmin already reads" was proven by
  // measurement; this makes it a test. For each ALLOWED module, every one of its tables must read the
  // same number of rows as the superadmin as it does as the database owner (all rows). Widening the
  // allowed list re-runs this for the new module's tables.
  const ALLOWED_PREFIXES = ['cls_']

  it('the superadmin reads every row of every allowed-module table (so a viewed screen adds nothing)', async () => {
    await rolledBack(async (tx) => {
      await tx`update user_private set is_superadmin = true where user_id = ${ids.s}`
      const tables = await tx<{ relname: string }[]>`
        select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
          and c.relname ~ ${'^(' + ALLOWED_PREFIXES.map((p) => p.replace('_', '')).join('|') + ')_'} order by 1`
      expect(tables.length).toBeGreaterThan(10)
      let seeded = 0
      for (const { relname } of tables) {
        const [own] = await tx.unsafe(`select count(*)::int as n from public.${relname}`)
        const sa = await as(tx, 's', () => tx.unsafe(`select count(*)::int as n from public.${relname}`))
        expect(sa.error, relname).toBeNull()
        expect(sa.data[0]!.n, `${relname}: superadmin reads fewer rows than exist`).toBe(own!.n)
        if (own!.n > 0) seeded++
      }
      expect(seeded, 'non-vacuous: the seed puts rows in several classroom tables').toBeGreaterThan(5)
    })
  })

  it('every table of a module that is NOT allowed carries a restrictive <table>_no_view_as', async () => {
    const tables = await sql<{ relname: string; pol: boolean | null }[]>`
      select c.relname,
             (select not p.polpermissive from pg_policy p where p.polrelid = c.oid and p.polname = c.relname || '_no_view_as') as pol
      from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
        and c.relname ~ '^(mm|syn|vm|sal|sd|smp)_' order by 1`
    expect(tables.length).toBeGreaterThan(30)
    for (const t of tables) expect(t.pol, `${t.relname} lacks a restrictive ${t.relname}_no_view_as`).toBe(true)
  })

  it('with the view_as claim, a member reads nothing from another module they DO use', async () => {
    await rolledBack(async (tx) => {
      const org = await setup(tx)
      await tx`insert into org_modules (org_id, module_key, enabled) values (${org.id}, 'speed-dating', true)`
      const [ev] = await tx`insert into sd_events (org_id, name) values (${org.id}, 'probe') returning id`
      await tx`insert into sd_participants (org_id, event_id, user_id) values (${org.id}, ${ev!.id}, ${ids.p})`
      const read = (viewAs: boolean) => as(tx, 'p', () => tx`select id from sd_participants where user_id = ${ids.p}`, viewAs)
      expect((await read(false)).data).toHaveLength(1) // the control: he reads his own seat
      expect((await read(true)).data).toHaveLength(0)
    })
  })
})
