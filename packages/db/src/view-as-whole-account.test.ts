import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// WHOLE-ACCOUNT VIEW AS — migration A (20261125010000) and the widening B
// (20261126010000, kept in supabase/pending/ until A and the app are on prod;
// applied here INSIDE each rolled-back transaction, so these tests run the
// same on CI, which never applies it). docs/13 "WHOLE-ACCOUNT VIEW AS".
//
// Every probe runs AS a real role inside a transaction that is ALWAYS rolled
// back; throwaway accounts are hard-deleted afterwards. Every refusal or
// "nothing written" has a control: the same call without the view writes.
//
//   s = made superadmin inside the transaction   p = the person viewed
//   x = an ordinary account
// ---------------------------------------------------------------------------

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const ownerDbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const sql = postgres(ownerDbUrl, { prepare: false, max: 1, onnotice: () => {} })
const admin = () => createClient(url, serviceKey, { auth: { persistSession: false } })

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const B_NAME = '20261126010000_view_as_widen.sql'
const bPath = [resolve(root, 'supabase/migrations', B_NAME), resolve(root, 'supabase/pending', B_NAME)].find((p) => existsSync(p))

const who = ['s', 'p', 'x'] as const
type Who = (typeof who)[number]
const ids: Record<Who, string> = { s: '', p: '', x: '' }
const emails: Record<Who, string> = { s: '', p: '', x: '' }

beforeAll(async () => {
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for this suite')
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  for (const k of who) {
    emails[k] = `wholeview-${k}-${tag}@demo.local`
    const { data, error } = await admin().auth.admin.createUser({ email: emails[k], password: 'password123', email_confirm: true })
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

type AsOpts = {
  /** A view_as claim with this session id (any string; a real id for whole-account checks). */
  view?: string
  /** Run the PostgREST pre-request hook first (read-only + sticky flag), as a real request does. */
  hook?: boolean
  /** Keep the statement's effects (never with `hook`): otherwise everything it did is rolled back. */
  keep?: boolean
}

/** Runs `stmt` as `user` (role authenticated), the way PostgREST would. */
async function as(tx: Tx, user: Who, stmt: () => Promise<postgres.RowList<postgres.Row[]>>, o: AsOpts = {}): Promise<Outcome> {
  await tx.unsafe('savepoint sp')
  let out: Outcome
  try {
    const claims: Record<string, unknown> = { sub: ids[user], role: 'authenticated' }
    if (o.view !== undefined) claims.view_as = { session: o.view, actor: ids.s }
    await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`
    await tx.unsafe('set local role authenticated')
    if (o.hook) await tx`select public.view_as_pre_request()`
    const r = await stmt()
    out = { error: null, data: [...r] }
  } catch (e: unknown) {
    out = { error: String((e as Error).message), data: [] }
  }
  if (out.error === null && o.keep) await tx.unsafe('release savepoint sp')
  else await tx.unsafe('rollback to savepoint sp')
  await tx.unsafe('reset role')
  await tx`select set_config('request.jwt.claims', '', true)`
  return out
}

/** The rows of a call that must not have failed (so an empty result is a real empty). */
function ok(o: Outcome): postgres.Row[] {
  expect(o.error).toBeNull()
  return o.data
}

// Not a migration (no version prefix): its header says how to ship it.
const RB_NAME = 'ROLLBACK-view-as-widen.sql'
const rbPath = [resolve(root, 'supabase/pending', RB_NAME)].find((p) => existsSync(p))

/** The A-only state (the 20261116010000 §4b policies + A's mm_ensure_answer), whether or not this database has B. */
async function withoutB(tx: Tx) {
  expect(rbPath, `${RB_NAME} is missing`).toBeTruthy()
  await tx.unsafe(readFileSync(rbPath!, 'utf8'))
}

async function applyB(tx: Tx) {
  expect(bPath, `${B_NAME} is in neither supabase/migrations nor supabase/pending`).toBeTruthy()
  await tx.unsafe(readFileSync(bPath!, 'utf8'))
}

async function makeOrg(tx: Tx, modules: string[], members: Partial<Record<Who, string>> = { p: 'member' }) {
  const [org] = await tx`insert into orgs (name, slug) values ('Whole view probe', ${'whole-view-' + Date.now() + Math.random().toString(36).slice(2, 6)}) returning id, slug`
  for (const m of modules) await tx`insert into org_modules (org_id, module_key, enabled) values (${org!.id}, ${m}, true)`
  for (const [k, role] of Object.entries(members)) {
    await tx`insert into org_members (org_id, user_id, role, status) values (${org!.id}, ${ids[k as Who]}, ${role!}, 'active')`
  }
  return org as { id: string; slug: string }
}

async function superadmin(tx: Tx) {
  await tx`update user_private set is_superadmin = true where user_id = ${ids.s}`
}

/** s opens a whole-account view of `target`; returns the session id. */
async function startWhole(tx: Tx, target: Who = 'p') {
  const r = await as(tx, 's', () => tx`select public.view_as_real_start(${ids[target]}::uuid) as id`, { keep: true })
  expect(r.error).toBeNull()
  return r.data[0]!.id as string
}

describe('view_as_real_start(person) — whole-account', () => {
  it('the superadmin may view a person; nobody else; never from inside a view', async () => {
    await rolledBack(async (tx) => {
      await superadmin(tx)
      const id = await startWhole(tx)
      const [row] = await tx`select org_id, module_key, target_user_id, actor_user_id, ended_at from view_as_real_sessions where id = ${id}`
      expect(row).toMatchObject({ org_id: null, module_key: null, target_user_id: ids.p, actor_user_id: ids.s, ended_at: null })
      const start = () => tx`select public.view_as_real_start(${ids.p}::uuid) as id`
      expect((await as(tx, 'x', start)).error).toMatch(/Not allowed/)
      expect((await as(tx, 's', start, { view: id })).error).toMatch(/Not allowed/)
      // One view at a time: a second start closes the first.
      const id2 = await startWhole(tx, 'x')
      const [old] = await tx`select ended_at from view_as_real_sessions where id = ${id}`
      expect(old!.ended_at).not.toBeNull()
      expect(id2).not.toBe(id)
    })
  })

  it('refuses oneself, a superadmin, a missing, deleted or banned account (each with a control)', async () => {
    await rolledBack(async (tx) => {
      await superadmin(tx)
      const start = (t: string) => () => tx`select public.view_as_real_start(${t}::uuid) as id`
      expect((await as(tx, 's', start(ids.s))).error).toMatch(/someone else/)
      expect((await as(tx, 's', start('00000000-0000-0000-0000-000000000001'))).error).toMatch(/does not exist/)
      expect((await as(tx, 's', start(ids.p))).error).toBeNull() // control

      await tx`update user_private set is_superadmin = true where user_id = ${ids.p}`
      expect((await as(tx, 's', start(ids.p))).error).toMatch(/superadmin cannot be viewed/)
      await tx`update user_private set is_superadmin = false where user_id = ${ids.p}`

      await tx`update auth.users set banned_until = now() + interval '1 day' where id = ${ids.p}`
      expect((await as(tx, 's', start(ids.p))).error).toMatch(/banned/)
      await tx`update auth.users set banned_until = null where id = ${ids.p}`

      await tx`insert into account_deletions (user_id, state, initiated_via, due_at, deleted_at)
               values (${ids.p}, 'deleted', 'self', now(), now())`
      expect((await as(tx, 's', start(ids.p))).error).toMatch(/deleted/)
      await tx`delete from account_deletions where user_id = ${ids.p}`
      expect((await as(tx, 's', start(ids.p))).error).toBeNull() // control again
    })
  })
})

describe('view_as_real_check — scope and liveness', () => {
  const IN = ['/dashboard', '/dashboard/x', '/account', '/account/password', '/feedback', '/feedback/abc', '/o/some-org', '/o/some-org/m/speed-dating/events/1']
  const OUT = ['/console', '/console/view-as/real', '/view-as/stop', '/auth/callback', '/login', '/', '/privacy', '/report', '/s/some-org', '/api/x', '/dashboardx', '/accounts', '/feedbacks', '/o']

  it('a whole-account session: in scope = the (app) pages only', async () => {
    await rolledBack(async (tx) => {
      await superadmin(tx)
      const id = await startWhole(tx)
      for (const path of [...IN, ...OUT]) {
        const r = await as(tx, 's', () => tx`select * from public.view_as_real_check(${id}, ${path}, false)`)
        expect(r.error, path).toBeNull()
        expect(r.data, path).toHaveLength(1)
        expect(r.data[0], path).toMatchObject({ target_user_id: ids.p, org_id: null, org_slug: null, module_key: null, in_scope: IN.includes(path) })
      }
      // Logged only in scope, only when asked.
      await as(tx, 's', () => tx`select * from public.view_as_real_check(${id}, '/dashboard', true)`, { keep: true })
      await as(tx, 's', () => tx`select * from public.view_as_real_check(${id}, '/console', true)`, { keep: true })
      const [n] = await tx`select count(*)::int as n from view_as_real_page_views where session_id = ${id}`
      expect(n!.n).toBe(1)
      // Someone else asking gets nothing.
      expect(ok(await as(tx, 'x', () => tx`select * from public.view_as_real_check(${id}, '/dashboard', false)`))).toHaveLength(0)
    })
  })

  it('a whole-account session dies while the person is banned, deleted, departed or a superadmin', async () => {
    await rolledBack(async (tx) => {
      await superadmin(tx)
      const id = await startWhole(tx)
      const rows = async () => ok(await as(tx, 's', () => tx`select * from public.view_as_real_check(${id}, '/dashboard', false)`)).length
      expect(await rows()).toBe(1) // control
      await tx`update auth.users set banned_until = now() + interval '1 day' where id = ${ids.p}`
      expect(await rows()).toBe(0)
      await tx`update auth.users set banned_until = now() - interval '1 day' where id = ${ids.p}`
      expect(await rows()).toBe(1) // a past ban is no ban
      await tx`update user_private set is_superadmin = true where user_id = ${ids.p}`
      expect(await rows()).toBe(0)
      await tx`update user_private set is_superadmin = false where user_id = ${ids.p}`
      await tx`insert into account_deletions (user_id, state, initiated_via, due_at) values (${ids.p}, 'departed', 'removal', now() + interval '30 days')`
      expect(await rows()).toBe(0)
      await tx`delete from account_deletions where user_id = ${ids.p}`
      expect(await rows()).toBe(1)
      await tx`update view_as_real_sessions set expires_at = now() - interval '1 second' where id = ${id}`
      expect(await rows()).toBe(0)
    })
  })

  it('an org (v1) session behaves exactly as before; one whose org was deleted is dead, not widened', async () => {
    await rolledBack(async (tx) => {
      await superadmin(tx)
      const org = await makeOrg(tx, ['classroom'])
      const r = await as(tx, 's', () => tx`select public.view_as_real_start(${ids.p}, ${org.id}, 'classroom') as id`, { keep: true })
      const id = r.data[0]!.id as string
      const check = async (path: string) => ok(await as(tx, 's', () => tx`select * from public.view_as_real_check(${id}, ${path}, false)`))
      expect((await check(`/o/${org.slug}/m/classroom/x`))[0]).toMatchObject({ org_id: org.id, org_slug: org.slug, module_key: 'classroom', in_scope: true })
      expect((await check(`/o/${org.slug}/m/classroom`))[0]!.in_scope).toBe(true)
      for (const p of [`/o/${org.slug}/m/speed-dating`, `/o/${org.slug}/m/classroomx`, '/dashboard', '/account', '/console']) {
        expect((await check(p))[0]!.in_scope, p).toBe(false)
      }
      await tx`update org_members set status = 'pending' where org_id = ${org.id} and user_id = ${ids.p}`
      expect(await check(`/o/${org.slug}/m/classroom`)).toHaveLength(0)
      await tx`update org_members set status = 'active' where org_id = ${org.id} and user_id = ${ids.p}`
      expect(await check(`/o/${org.slug}/m/classroom`)).toHaveLength(1)
      // `on delete set null` leaves module_key: never read as a whole-account session.
      await tx`update view_as_real_sessions set org_id = null where id = ${id}`
      expect(await check('/dashboard')).toHaveLength(0)
    })
  })
})

describe('the view flags', () => {
  it('the hook sets read-only AND the sticky flag for a view, neither for an ordinary request', async () => {
    await rolledBack(async (tx) => {
      const probe = () => tx`select current_setting('transaction_read_only') as ro, coalesce(current_setting('sp.view_as', true), '') as flag, public.in_view_as() as v`
      const view = await as(tx, 'p', probe, { view: 'any', hook: true })
      expect(view.data[0]).toMatchObject({ ro: 'on', flag: 'on', v: true })
      const plain = await as(tx, 'p', probe, { hook: true })
      expect(plain.data[0]).toMatchObject({ ro: 'off', flag: '', v: false })
    })
  })

  it('inside a definer that blanks the claims, in_view_as() and private_text still mask (revision 9)', async () => {
    await rolledBack(async (tx) => {
      await tx.unsafe(`
        create function public.zz_probe_blank_claims() returns table (by_claims boolean, sticky boolean, txt text)
        language plpgsql security definer set search_path = '' as $f$
        begin
          perform pg_catalog.set_config('request.jwt.claims', '', true);
          return query select public.is_view_as_request(), public.in_view_as(), public.private_text('twelve chars', 'private note');
        end $f$`)
      await tx.unsafe('grant execute on function public.zz_probe_blank_claims() to authenticated')
      const call = () => tx`select * from public.zz_probe_blank_claims()`
      const viewed = await as(tx, 'p', call, { view: 'any', hook: true })
      expect(viewed.data[0]).toEqual({ by_claims: false, sticky: true, txt: '‹private note · 12 characters›' })
      const own = await as(tx, 'p', call, { hook: true })
      expect(own.data[0]).toEqual({ by_claims: false, sticky: false, txt: 'twelve chars' }) // control
      // NULL stays NULL.
      expect(ok(await as(tx, 'p', () => tx`select public.private_text(null, 'x') as t`, { view: 'any', hook: true }))[0]!.t).toBeNull()
    })
  })
})

describe('sd_my_notes — the private-field reader', () => {
  async function fixture(tx: Tx) {
    await superadmin(tx)
    const org = await makeOrg(tx, ['speed-dating', 'classroom'], { p: 'member', x: 'member' })
    const [ev] = await tx`insert into sd_events (org_id, name) values (${org.id}, 'probe') returning id`
    await tx`insert into sd_participants (org_id, event_id, user_id) values (${org.id}, ${ev!.id}, ${ids.p})`
    await tx`insert into sd_participants (org_id, event_id, user_id) values (${org.id}, ${ev!.id}, ${ids.x})`
    const body = 'Kind, funny; ask about the hiking trip.'
    await tx`insert into sd_notes (org_id, event_id, author_user_id, about_user_id, body) values (${org.id}, ${ev!.id}, ${ids.p}, ${ids.x}, ${body})`
    return { org, event: ev!.id as string, body }
  }

  it('the author reads the text; a whole-account view reads a placeholder; anyone else reads nothing', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      const id = await startWhole(tx)
      const read = () => tx`select * from public.sd_my_notes(${f.event})`
      expect(ok(await as(tx, 'p', read))).toEqual([{ about_user_id: ids.x, body: f.body }])
      const viewed = await as(tx, 'p', read, { view: id, hook: true })
      expect(viewed.error).toBeNull()
      expect(viewed.data).toEqual([{ about_user_id: ids.x, body: `‹private note · ${f.body.length} characters›` }])
      expect(ok(await as(tx, 'x', read))).toHaveLength(0)
      // An org-scoped (v1) view reads nothing from speed dating, masked or not.
      const v1 = ok(await as(tx, 's', () => tx`select public.view_as_real_start(${ids.p}, ${f.org.id}, 'classroom') as id`, { keep: true }))[0]!.id as string
      expect(ok(await as(tx, 'p', read, { view: v1, hook: true }))).toHaveLength(0)
    })
  })

  it('a direct sd_notes read under any view is still empty (with and without B)', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      const id = await startWhole(tx)
      const direct = () => tx`select body from sd_notes where event_id = ${f.event}`
      await withoutB(tx)
      expect(ok(await as(tx, 'p', direct))).toHaveLength(1) // control
      expect(ok(await as(tx, 'p', direct, { view: id, hook: true }))).toHaveLength(0)
      await applyB(tx)
      expect(ok(await as(tx, 'p', direct, { view: id, hook: true }))).toHaveLength(0)
      expect(ok(await as(tx, 'p', direct))).toHaveLength(1)
    })
  })
})

describe('matchmaking — mm_my_answers and mm_ensure_answer', () => {
  async function fixture(tx: Tx) {
    await superadmin(tx)
    const org = await makeOrg(tx, ['matchmaking'], { p: 'member' })
    await tx`insert into module_roles (org_id, user_id, module_key, role) values (${org.id}, ${ids.p}, 'matchmaking', 'single')`
    const [locked] = await tx`insert into mm_questions (org_id, text, scale_labels, admin_locks, status)
      values (${org.id}, 'Locked', ${['a', 'b', 'c', 'd', 'e']}, ${tx.json({ answer: 3, care: -10, dealbreaker: true })}, 'approved') returning id`
    const [plain] = await tx`insert into mm_questions (org_id, text, scale_labels, status)
      values (${org.id}, 'Plain', ${['a', 'b', 'c']}, 'approved') returning id`
    await tx`insert into mm_questions (org_id, text, scale_labels, status) values (${org.id}, 'Pending', ${['a', 'b']}, 'pending')`
    // p has answered `plain` already (a stored, touched row).
    await tx`insert into mm_answers (org_id, question_id, user_id, position, care, auto) values (${org.id}, ${plain!.id}, ${ids.p}, 2, 5, false)`
    return { org, locked: locked!.id as string, plain: plain!.id as string }
  }
  const sortQ = (rows: postgres.Row[]) => [...rows].sort((a, b) => String(a.question_id).localeCompare(String(b.question_id)))
  const answersOf = (tx: Tx) => tx`select count(*)::int as n from mm_answers where user_id = ${ids.p}`

  it('stored rows + locked defaults; equal to what the page showed after materialising; writes nothing', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      const mine = () => tx`select * from public.mm_my_answers(${f.org.id})`
      const before = sortQ(ok(await as(tx, 'p', mine)))
      expect(before).toHaveLength(2)
      expect(before.find((r) => r.question_id === f.locked)).toEqual({
        question_id: f.locked, position: 3, care: -10, dealbreaker: true, share_with_match: false, auto: true,
      })
      expect(before.find((r) => r.question_id === f.plain)).toMatchObject({ position: 2, care: 5, auto: false })
      expect((await answersOf(tx))[0]!.n).toBe(1)

      // What the person's own page load makes (mm_ensure_answer for each question), then reads back.
      const materialised = await as(tx, 'p', async () => {
        for (const q of [f.locked, f.plain]) await tx`select public.mm_ensure_answer(${q})`
        return tx`select question_id, position, care, dealbreaker, share_with_match, auto from mm_answers where user_id = ${ids.p}`
      })
      expect(sortQ(materialised.data)).toEqual(before)

      // Under a whole-account view (B applied): the same rows, nothing written, ensure does not error.
      const id = await startWhole(tx)
      await applyB(tx)
      const viewed = await as(tx, 'p', async () => {
        const e = await tx`select (public.mm_ensure_answer(${f.locked})).*`
        expect(e[0]).toMatchObject({ id: null, position: 3, care: -10, dealbreaker: true, auto: true })
        return mine()
      }, { view: id, hook: true })
      expect(viewed.error).toBeNull()
      expect(sortQ(viewed.data)).toEqual(before)
      expect((await answersOf(tx))[0]!.n).toBe(1)
    })
  })

  it('without B, a view reads no matchmaking rows through mm_my_answers (invoker: the policies decide)', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      const id = await startWhole(tx)
      await withoutB(tx)
      expect(ok(await as(tx, 'p', () => tx`select * from public.mm_my_answers(${f.org.id})`))).toHaveLength(2) // control
      expect(ok(await as(tx, 'p', () => tx`select * from public.mm_my_answers(${f.org.id})`, { view: id, hook: true }))).toHaveLength(0)
    })
  })

  it('mm_ensure_answer under a view: NULL to every view with A only; with B the stored row to a whole-account view, never to a v1 view', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      const cls = await makeOrg(tx, ['classroom'])
      const v1 = ok(await as(tx, 's', () => tx`select public.view_as_real_start(${ids.p}, ${cls.id}, 'classroom') as id`, { keep: true }))[0]!.id as string
      const whole = await startWhole(tx) // closes v1 (one at a time); reopen v1 below after B
      const ensure = (view?: string) =>
        as(tx, 'p', () => tx`select (public.mm_ensure_answer(${f.plain})).*`, view === undefined ? {} : { view, hook: true })
      const nothing = { id: null, question_id: null, user_id: null, position: null, care: null }

      await withoutB(tx)
      // Control: no view, the stored row.
      expect(ok(await ensure())[0]).toMatchObject({ question_id: f.plain, user_id: ids.p, position: 2, care: 5 })
      expect(ok(await ensure(whole))[0]).toMatchObject(nothing)
      expect(ok(await ensure(v1))[0]).toMatchObject(nothing)

      await applyB(tx)
      const stored = ok(await ensure(whole))[0]!
      expect(stored).toMatchObject({ question_id: f.plain, user_id: ids.p, position: 2, care: 5, auto: false })
      expect(stored.id).not.toBeNull()
      // A v1 session (open again) still gets nothing; the whole-account one is closed by it.
      const v1b = ok(await as(tx, 's', () => tx`select public.view_as_real_start(${ids.p}, ${cls.id}, 'classroom') as id`, { keep: true }))[0]!.id as string
      expect(ok(await ensure(v1b))[0]).toMatchObject(nothing)
      expect(ok(await ensure(whole))[0]).toMatchObject(nothing) // ended
      expect(ok(await ensure())[0]).toMatchObject({ position: 2 }) // control
      expect((await answersOf(tx))[0]!.n).toBe(1) // nothing written
    })
  })

  it('the cross-org path: a non-single of org B cannot create an answer row in org B (and a single can)', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      // x is a single in ANOTHER matchmaking org, and an active member of none of B.
      const other = await makeOrg(tx, ['matchmaking'], { x: 'member' })
      await tx`insert into module_roles (org_id, user_id, module_key, role) values (${other.id}, ${ids.x}, 'matchmaking', 'single')`
      const r = await as(tx, 'x', () => tx`select public.mm_ensure_answer(${f.locked})`, { keep: true })
      expect(r.error).toMatch(/Only singles answer questions/)
      const [n] = await tx`select count(*)::int as n from mm_answers where user_id = ${ids.x}`
      expect(n!.n).toBe(0)
      // x as a plain MEMBER of B (no single role): still refused.
      await tx`insert into org_members (org_id, user_id, role, status) values (${f.org.id}, ${ids.x}, 'member', 'active')`
      expect((await as(tx, 'x', () => tx`select public.mm_ensure_answer(${f.locked})`, { keep: true })).error).toMatch(/Only singles/)
      // Control: the single p can.
      expect((await as(tx, 'p', () => tx`select public.mm_ensure_answer(${f.locked})`, { keep: true })).error).toBeNull()
      const [m] = await tx`select count(*)::int as n from mm_answers where user_id = ${ids.p} and question_id = ${f.locked}`
      expect(m!.n).toBe(1)
    })
  })
})

describe('render-time writers write nothing under a view, and still work without one', () => {
  it('account_deletion_resume', async () => {
    await rolledBack(async (tx) => {
      await superadmin(tx)
      const id = await startWhole(tx)
      await tx`insert into account_deletions (user_id, state, initiated_via, requested_at, due_at)
               values (${ids.p}, 'departed', 'self', now() - interval '1 day', now() + interval '29 days')`
      await tx`update auth.users set last_sign_in_at = now() where id = ${ids.p}`
      const call = () => tx`select public.account_deletion_resume() as r`
      const viewed = await as(tx, 'p', call, { view: id, hook: true })
      expect(viewed.error).toBeNull()
      expect(viewed.data[0]!.r).toEqual({ cancelled: false })
      expect((await tx`select state from account_deletions where user_id = ${ids.p}`)[0]!.state).toBe('departed')
      const own = await as(tx, 'p', call, { keep: true })
      expect(own.data[0]!.r).toEqual({ cancelled: true }) // control
    })
  })

  it('feedback_mark_read', async () => {
    await rolledBack(async (tx) => {
      await superadmin(tx)
      const id = await startWhole(tx)
      const opened = await as(tx, 'p', () => tx`select public.feedback_open('bug', 'probe', 'probe body', null, null, '{}'::jsonb) as id`, { keep: true })
      const ticket = opened.data[0]!.id as string
      await tx`update feedback_tickets set user_read_at = null where id = ${ticket}`
      const mark = () => tx`select public.feedback_mark_read(${ticket})`
      expect((await as(tx, 'p', mark, { view: id, hook: true })).error).toBeNull()
      expect((await tx`select user_read_at from feedback_tickets where id = ${ticket}`)[0]!.user_read_at).toBeNull()
      // The view branch sits AFTER the ticket check: someone else's ticket is still refused.
      expect((await as(tx, 'x', mark, { view: id, hook: true })).error).toMatch(/Ticket not found/)
      expect((await as(tx, 'p', mark, { keep: true })).error).toBeNull()
      expect((await tx`select user_read_at from feedback_tickets where id = ${ticket}`)[0]!.user_read_at).not.toBeNull() // control
    })
  })

  it('org invitations: shown under a view without being claimed; the real claim shows the same row', async () => {
    await rolledBack(async (tx) => {
      await superadmin(tx)
      const id = await startWhole(tx)
      const org = await makeOrg(tx, [], {})
      await tx`insert into pending_invites (kind, org_id, target_id, email, role, invited_by, expires_at)
               values ('org', ${org.id}, ${org.id}, ${emails.p}, 'member', ${ids.s}, now() + interval '7 days')`
      const list = () => tx`select org_id, org_name, org_slug, invited_role from public.org_my_pending_invites()`
      const claim = () => tx`select public.pending_invites_claim_mine() as n`

      const shown = await as(tx, 'p', list, { view: id, hook: true })
      expect(shown.error).toBeNull()
      expect(shown.data).toEqual([{ org_id: org.id, org_name: 'Whole view probe', org_slug: org.slug, invited_role: 'member' }])
      const claimed = await as(tx, 'p', claim, { view: id, hook: true })
      expect(claimed.error).toBeNull()
      expect(claimed.data[0]!.n).toBe(0)
      expect((await tx`select count(*)::int as n from pending_invites where org_id = ${org.id}`)[0]!.n).toBe(1)
      expect((await tx`select count(*)::int as n from org_members where org_id = ${org.id}`)[0]!.n).toBe(0)
      // The view arm is view-only: the person's own list before claiming is empty.
      expect(ok(await as(tx, 'p', list))).toHaveLength(0)
      // x (another address) sees nothing under a view.
      expect(ok(await as(tx, 'x', list, { view: id, hook: true }))).toHaveLength(0)
      // Control: the real claim makes the pending seat, and the list then shows exactly what the view showed.
      expect(ok(await as(tx, 'p', claim, { keep: true }))[0]!.n).toBe(1)
      expect(ok(await as(tx, 'p', list))).toEqual(shown.data)
      // And now the view shows it once (the stored seat), not twice.
      expect(ok(await as(tx, 'p', list, { view: id, hook: true }))).toEqual(shown.data)
    })
  })

  it('chat invitations: shown under a view without being claimed; the real claim shows the same row', async () => {
    await rolledBack(async (tx) => {
      await superadmin(tx)
      const id = await startWhole(tx)
      const org = await makeOrg(tx, ['visual-messaging'], { p: 'member' })
      await tx`insert into module_roles (org_id, user_id, module_key, role) values (${org.id}, ${ids.p}, 'visual-messaging', 'member')`
      const [conv] = await tx`insert into vm_conversations (org_id, title, created_by) values (${org.id}, 'Probe chat', ${ids.s}) returning id`
      await tx`insert into pending_invites (kind, org_id, target_id, email, role, invited_by, expires_at)
               values ('vm_conversation', ${org.id}, ${conv!.id}, ${emails.p}, 'participant', ${ids.s}, now() + interval '7 days')`
      const list = () => tx`select conversation_id, title, invited_by_name from public.vm_my_pending_invites(${org.id})`
      const shown = await as(tx, 'p', list, { view: id, hook: true })
      expect(shown.error).toBeNull()
      expect(shown.data).toHaveLength(1)
      expect(shown.data[0]).toMatchObject({ conversation_id: conv!.id, title: 'Probe chat' })
      expect(ok(await as(tx, 'p', () => tx`select public.pending_invites_claim_mine() as n`, { view: id, hook: true }))[0]!.n).toBe(0)
      expect((await tx`select count(*)::int as n from vm_conversation_members where conversation_id = ${conv!.id}`)[0]!.n).toBe(0)
      expect(ok(await as(tx, 'p', list))).toHaveLength(0) // view-only arm
      // An org-scoped (v1) view reads no chat invitations at all.
      const v1org = await makeOrg(tx, ['classroom'])
      const v1 = ok(await as(tx, 's', () => tx`select public.view_as_real_start(${ids.p}, ${v1org.id}, 'classroom') as id`, { keep: true }))[0]!.id as string
      expect(ok(await as(tx, 'p', list, { view: v1, hook: true }))).toHaveLength(0)
      // Control: the real claim, then the list shows the same row.
      expect(ok(await as(tx, 'p', () => tx`select public.pending_invites_claim_mine() as n`, { keep: true }))[0]!.n).toBe(1)
      expect(ok(await as(tx, 'p', list))).toEqual(shown.data)
    })
  })
})

describe('migration B — the widening (applied inside the transaction)', () => {
  it('a superadmin whole-account token reads module rows; an org-scoped, unknown, expired or non-superadmin session does not', async () => {
    await rolledBack(async (tx) => {
      await superadmin(tx)
      const org = await makeOrg(tx, ['speed-dating', 'classroom'])
      const [ev] = await tx`insert into sd_events (org_id, name) values (${org.id}, 'probe') returning id`
      await tx`insert into sd_participants (org_id, event_id, user_id) values (${org.id}, ${ev!.id}, ${ids.p})`
      const id = await startWhole(tx)
      const v1 = ok(await as(tx, 's', () => tx`select public.view_as_real_start(${ids.p}, ${org.id}, 'classroom') as id`, { keep: true }))[0]!.id as string
      // v1 start closed the whole-account session (one at a time): open a fresh one.
      const whole = await startWhole(tx)
      expect(whole).not.toBe(id)
      const seat = (view?: string) => as(tx, 'p', () => tx`select id from sd_participants where user_id = ${ids.p}`, view === undefined ? {} : { view, hook: true })

      await withoutB(tx)
      expect(ok(await seat())).toHaveLength(1) // control
      expect(ok(await seat(whole))).toHaveLength(0) // A only: still dark
      await applyB(tx)
      expect(ok(await seat(whole))).toHaveLength(1)
      expect(ok(await seat())).toHaveLength(1)
      expect(ok(await seat(v1))).toHaveLength(0)
      expect(ok(await seat(id))).toHaveLength(0) // ended
      expect(ok(await seat('test'))).toHaveLength(0) // not a uuid
      expect(ok(await seat('00000000-0000-0000-0000-000000000001'))).toHaveLength(0)
      // The actor must still be a superadmin.
      await tx`update user_private set is_superadmin = false where user_id = ${ids.s}`
      expect(ok(await seat(whole))).toHaveLength(0)
      await tx`update user_private set is_superadmin = true where user_id = ${ids.s}`
      expect(ok(await seat(whole))).toHaveLength(1)
      await tx`update view_as_real_sessions set expires_at = now() - interval '1 second' where id = ${whole}`
      expect(ok(await seat(whole))).toHaveLength(0)
    })
  })

  it('a still-valid token reads nothing once the person is banned, departed or made a superadmin (view_as_may_read liveness)', async () => {
    await rolledBack(async (tx) => {
      await superadmin(tx)
      const org = await makeOrg(tx, ['speed-dating'])
      const [ev] = await tx`insert into sd_events (org_id, name) values (${org.id}, 'probe') returning id`
      await tx`insert into sd_participants (org_id, event_id, user_id) values (${org.id}, ${ev!.id}, ${ids.p})`
      const whole = await startWhole(tx)
      await applyB(tx)
      const seat = () => as(tx, 'p', () => tx`select id from sd_participants where user_id = ${ids.p}`, { view: whole, hook: true })
      const may = () => as(tx, 'p', () => tx`select public.view_as_may_read(${org.id}, 'speed-dating') as m`, { view: whole, hook: true })
      expect(ok(await seat())).toHaveLength(1) // control
      expect(ok(await may())[0]!.m).toBe(true)
      await tx`update auth.users set banned_until = now() + interval '1 day' where id = ${ids.p}`
      expect(ok(await seat())).toHaveLength(0)
      expect(ok(await may())[0]!.m).toBe(false)
      await tx`update auth.users set banned_until = now() - interval '1 day' where id = ${ids.p}`
      expect(ok(await seat())).toHaveLength(1) // a past ban is no ban
      await tx`insert into account_deletions (user_id, state, initiated_via, due_at) values (${ids.p}, 'departed', 'removal', now() + interval '30 days')`
      expect(ok(await seat())).toHaveLength(0)
      await tx`delete from account_deletions where user_id = ${ids.p}`
      expect(ok(await seat())).toHaveLength(1)
      await tx`update user_private set is_superadmin = true where user_id = ${ids.p}`
      expect(ok(await seat())).toHaveLength(0)
      await tx`update user_private set is_superadmin = false where user_id = ${ids.p}`
      expect(ok(await seat())).toHaveLength(1) // control again
    })
  })

  it('a session id of ANOTHER person reads nothing', async () => {
    await rolledBack(async (tx) => {
      await superadmin(tx)
      const org = await makeOrg(tx, ['speed-dating'], { p: 'member', x: 'member' })
      const [ev] = await tx`insert into sd_events (org_id, name) values (${org.id}, 'probe') returning id`
      await tx`insert into sd_participants (org_id, event_id, user_id) values (${org.id}, ${ev!.id}, ${ids.x})`
      const idForP = await startWhole(tx, 'p')
      await applyB(tx)
      const read = (view: string) => as(tx, 'x', () => tx`select id from sd_participants where user_id = ${ids.x}`, { view, hook: true })
      expect(ok(await read(idForP))).toHaveLength(0)
      const idForX = await startWhole(tx, 'x')
      expect(ok(await read(idForX))).toHaveLength(1) // control
    })
  })

  it('B replaces every module policy except sd_notes, keeps them restrictive, and changes no other policy', async () => {
    await rolledBack(async (tx) => {
      const snapshot = () => tx<{ rel: string; polname: string; permissive: boolean; qual: string }[]>`
        select c.relname as rel, p.polname, p.polpermissive as permissive, coalesce(pg_get_expr(p.polqual, p.polrelid), '') as qual
        from pg_policy p join pg_class c on c.oid = p.polrelid order by 1, 2`
      await withoutB(tx)
      const before = await snapshot()
      expect(before.filter((r) => r.qual.includes('view_as_may_read'))).toHaveLength(0) // A-only to start
      await applyB(tx)
      const after = await snapshot()
      expect(after.length).toBe(before.length)
      const moduleTables = await tx<{ relname: string }[]>`
        select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'
          and relname ~ '^(mm|syn|vm|sal|sd|smp)_' order by 1`
      expect(moduleTables.length).toBeGreaterThan(40)
      for (const { relname } of moduleTables) {
        const p = after.find((x) => x.rel === relname && x.polname === `${relname}_no_view_as`)
        expect(p, `${relname} lacks ${relname}_no_view_as`).toBeTruthy()
        expect(p!.permissive, relname).toBe(false)
        if (relname === 'sd_notes') {
          expect(p!.qual).toMatch(/is_view_as_request/)
          expect(p!.qual).not.toMatch(/view_as_may_read/)
        } else {
          expect(p!.qual, relname).toMatch(/view_as_may_read\((org_id|NULL::uuid), '[a-z-]+'::text\)/)
        }
      }
      // Nothing else moved.
      const others = (rows: typeof before) => rows.filter((r) => !r.polname.endsWith('_no_view_as') || r.rel === 'sd_notes')
      expect(others(after)).toEqual(others(before))
    })
  })
})
