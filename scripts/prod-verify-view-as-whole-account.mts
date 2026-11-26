// Prod verification for 20261125010000_view_as_whole_account.sql — migration A
// of whole-account View as (docs/13 "WHOLE-ACCOUNT VIEW AS", four-way review
// revisions 1–11) — and, in B mode, for supabase/migrations/20261126010000_view_as_widen.sql.
// Copied from prod-verify-real-view-as.mts.
//
//   node node_modules/tsx/dist/cli.mjs scripts/prod-verify-view-as-whole-account.mts --local
//   node node_modules/tsx/dist/cli.mjs scripts/prod-verify-view-as-whole-account.mts
//
// Run it BEFORE and AFTER `migrate:prod`: before, the structure checks fail, the
// behaviour section prints SKIPPED (the 1-argument view_as_real_start does not
// exist yet) and the CONTROLS pass; after, everything passes. The evidence is
// the before/after.
//
// A/B MODE (read from the database, not a flag): the script reads the
// restrictive `<table>_no_view_as` policies and reports which state the
// database is in — "A" (every one still the 20261116010000 §4b form: no view
// token reads a module table) or "B" (every one but sd_notes is
// view_as_may_read; sd_notes keeps the §4b form for ever). It FAILS only on a
// MIXED state. The expected mm_ensure_answer body and the behaviour
// expectations (A: dark to every view; B: the person's own rows to a live
// whole-account view) follow the state it found.
//
// [1] STRUCTURE: every function the migration creates or re-creates (body md5
//     matches the file — B's file for mm_ensure_answer in B mode; definer or
//     not; search_path pinned; EXECUTE exactly as intended, never PUBLIC); the
//     3-argument start still there; module_key nullable; no open v1 session;
//     the hook still on authenticator; the A/B policy state.
// [2] BEHAVIOUR as real users, in ONE transaction that is ALWAYS ROLLED BACK:
//     a member cannot start a whole-account view; the superadmin can; the check
//     scopes /dashboard vs /console; the hook sets read-only AND the sticky
//     flag; private_text masks under the view (also after the claims are
//     blanked) and not without it; view_as_may_read true for a live
//     whole-account token, false for a v1 token and for person X carrying
//     person Y's session; the render-time writers return without error under
//     the read-only view; an invitation is SHOWN under the view but 0 claimed;
//     mm_my_answers / mm_ensure_answer per the A/B state; sd_notes stays dark
//     to a direct read (with a control: the person has a note) and sd_my_notes
//     returns the masked shape `‹private note · N characters›`. If the database
//     has no note at all, one is inserted inside the rolled-back transaction.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL = process.argv.includes('--local')

let ref = '(local)'
let sql: ReturnType<typeof postgres>
if (LOCAL) {
  sql = postgres(process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres', { max: 1, onnotice: () => {} })
} else {
  const env = readFileSync(resolve(root, '.env.deploy'), 'utf8')
  const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''
  ref = get('SUPABASE_PROJECT_REF')
  const pw = get('SUPABASE_DB_PASSWORD')
  if (!ref || !pw) throw new Error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD in .env.deploy')
  sql = postgres(
    `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`,
    { ssl: 'require', max: 1, onnotice: () => {} },
  )
}

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${detail})`}`)
}
const skipped = (what: string) => console.log(`  SKIPPED  ${what}`)

async function rolledBack(body: (tx: postgres.TransactionSql) => Promise<void>) {
  await sql
    .begin(async (tx) => {
      await body(tx)
      throw new Error('__rollback__')
    })
    .catch((e: unknown) => {
      if ((e as Error)?.message !== '__rollback__') throw e
    })
}

const bodies = (file: string) => {
  const text = readFileSync(resolve(root, file), 'utf8')
  const out = new Map<string, string>()
  const re = /create or replace function public\.(\w+)\([\s\S]*?\nas \$\$([\s\S]*?)\$\$;/g
  for (let m = re.exec(text); m; m = re.exec(text)) out.set(m[1]!, createHash('md5').update(m[2]!).digest('hex'))
  return out
}
const expected = bodies('supabase/migrations/20261125010000_view_as_whole_account.sql')
// B moved from supabase/pending/ into supabase/migrations/ on 2026-11-26.
const expectedB = bodies('supabase/migrations/20261126010000_view_as_widen.sql')

// name -> [nargs, security definer?, search_path, anon?, authenticated?, service_role?]
const EMPTY = 'search_path=""'
const PUB = 'search_path=public'
const INTENT: Record<string, [number, boolean, string, boolean, boolean, boolean]> = {
  in_view_as: [0, false, EMPTY, true, true, true],
  view_as_pre_request: [0, false, EMPTY, true, true, true],
  view_as_may_read: [2, true, EMPTY, true, true, true],
  private_text: [2, false, EMPTY, false, true, true],
  sd_my_notes: [1, true, EMPTY, false, true, false],
  mm_my_answers: [1, false, EMPTY, false, true, false],
  mm_ensure_answer: [1, true, PUB, false, true, true],
  pending_invite_would_apply: [2, true, EMPTY, false, false, false],
  org_my_pending_invites: [0, true, PUB, false, true, true],
  vm_my_pending_invites: [1, true, PUB, false, true, true],
  pending_invites_claim_mine: [0, true, PUB, false, true, false],
  account_deletion_resume: [0, true, PUB, false, true, false],
  feedback_mark_read: [1, true, PUB, false, true, false],
  view_as_real_start: [1, true, EMPTY, false, true, false],
  view_as_real_check: [3, true, EMPTY, false, true, false],
}

const MASK = /^‹private note · (\d+) characters›$/

try {
  console.log(`[1] structure — ${LOCAL ? 'LOCAL' : `PROD (${ref})`}`)
  const [{ n: allFns }] = await sql<{ n: number }[]>`select count(*)::int as n from pg_proc where pronamespace = 'public'::regnamespace`
  check('CONTROL: the catalog read works', allFns > 50, `${allFns}`)
  check(`CONTROL: the migration file parsed (${Object.keys(INTENT).length} bodies)`, expected.size === Object.keys(INTENT).length, `${expected.size}`)
  check('CONTROL: migration B parsed (its mm_ensure_answer)', expectedB.has('mm_ensure_answer') && expectedB.get('mm_ensure_answer') !== expected.get('mm_ensure_answer'))

  // The A/B state, from the policies.
  const [pol] = await sql<{ total: number; old: number; neu: number; sdn_old: number }[]>`
    select count(*)::int as total,
           count(*) filter (where pg_get_expr(p.polqual, p.polrelid) like '%is_view_as_request%'
                              and pg_get_expr(p.polqual, p.polrelid) not like '%view_as_may_read%')::int as old,
           count(*) filter (where pg_get_expr(p.polqual, p.polrelid) like '%view_as_may_read%')::int as neu,
           count(*) filter (where c.relname = 'sd_notes'
                              and pg_get_expr(p.polqual, p.polrelid) like '%is_view_as_request%'
                              and pg_get_expr(p.polqual, p.polrelid) not like '%view_as_may_read%')::int as sdn_old
    from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relnamespace = 'public'::regnamespace and p.polname = c.relname || '_no_view_as' and not p.polpermissive`
  const state: 'A' | 'B' | 'MIXED' =
    pol!.total > 40 && pol!.old === pol!.total ? 'A'
    : pol!.total > 40 && pol!.sdn_old === 1 && pol!.neu === pol!.total - 1 ? 'B'
    : 'MIXED'
  console.log(`  policy state: ${state === 'A' ? 'A (B not applied: no view token reads a module table)' : state === 'B' ? 'B (widened: a live whole-account view reads the person\'s module rows)' : 'MIXED'}  ${JSON.stringify(pol)}`)
  check('the module policies are wholly A or wholly B (never mixed); sd_notes keeps the §4b form', state !== 'MIXED' && pol!.sdn_old === 1, JSON.stringify(pol))

  for (const [name, [nargs, secdef, path, anon, auth, svc]] of Object.entries(INTENT)) {
    const [f] = await sql<{ secdef: boolean; config: string[] | null; md5: string; a: boolean; u: boolean; s: boolean; p: boolean }[]>`
      select p.prosecdef as secdef, p.proconfig as config, md5(p.prosrc) as md5,
             has_function_privilege('anon', p.oid, 'execute') as a,
             has_function_privilege('authenticated', p.oid, 'execute') as u,
             has_function_privilege('service_role', p.oid, 'execute') as s,
             coalesce(p.proacl::text, '') ~ '(^|[{,])=X/' as p
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = ${name} and p.pronargs = ${nargs}`
    const want = name === 'mm_ensure_answer' && state === 'B' ? expectedB.get(name) : expected.get(name)
    check(`${name}/${nargs} exists, body matches ${want === expected.get(name) ? 'migration A' : 'migration B'}`, f?.md5 === want, `db=${f?.md5 ?? '-'}`)
    check(`  definer = ${secdef}, ${path}`, f?.secdef === secdef && JSON.stringify(f?.config) === JSON.stringify([path]), JSON.stringify(f?.config))
    check(`  EXECUTE anon=${anon} authenticated=${auth} service_role=${svc}, never PUBLIC`, !!f && f.a === anon && f.u === auth && f.s === svc && !f.p, f ? `${f.a}/${f.u}/${f.s}/public=${f.p}` : '-')
  }
  const [old3] = await sql<{ n: number }[]>`select count(*)::int as n from pg_proc where proname = 'view_as_real_start' and pronargs = 3 and pronamespace = 'public'::regnamespace`
  check('the 3-argument view_as_real_start is still there (dropped in a later cleanup)', old3?.n === 1)
  const [col] = await sql<{ nn: boolean }[]>`
    select attnotnull as nn from pg_attribute where attrelid = 'public.view_as_real_sessions'::regclass and attname = 'module_key'`
  check('view_as_real_sessions.module_key is nullable', col?.nn === false, JSON.stringify(col))
  const [v1open] = await sql<{ open: number; all: number }[]>`
    select count(*) filter (where ended_at is null and module_key is not null)::int as open, count(*)::int as all
    from public.view_as_real_sessions`
  check('no open v1 (org-scoped) session (the migration ended them)', v1open?.open === 0, JSON.stringify(v1open))
  const [setting] = await sql<{ cfg: string[] }[]>`
    select setconfig as cfg from pg_db_role_setting where setrole = 'authenticator'::regrole and setdatabase = 0`
  check('the hook is still set on authenticator', (setting?.cfg ?? []).includes('pgrst.db_pre_request=public.view_as_pre_request'), JSON.stringify(setting?.cfg))

  // The hook must still never raise and leave ordinary requests read-write.
  for (const [roleName, claims] of [['anon', ''], ['authenticated', ''], ['authenticated', 'not json']] as const) {
    let outcome = ''
    await rolledBack(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${claims}, true)`
      await tx.unsafe(`set local role ${roleName}`)
      try {
        await tx`select public.view_as_pre_request()`
        const [r] = await tx<{ ro: string; v: boolean; m: boolean }[]>`
          select current_setting('transaction_read_only') as ro, public.in_view_as() as v, public.view_as_may_read(null, 'x') as m`
        outcome = `${r!.ro}/${r!.v}/${r!.m}`
      } catch (e) {
        outcome = `raised: ${(e as Error).message}`
      }
    })
    check(`  hook + in_view_as + view_as_may_read as ${roleName}, claims ${JSON.stringify(claims)}: no error, read-write, not a view`, outcome === 'off/false/true', outcome)
  }

  console.log(`[2] behaviour as real users (rolled back; expectations for state ${state})`)
  const [has1] = await sql<{ n: number }[]>`select count(*)::int as n from pg_proc where proname = 'view_as_real_start' and pronargs = 1 and pronamespace = 'public'::regnamespace`
  const [sa] = await sql<{ user_id: string }[]>`select user_id from public.user_private where is_superadmin limit 1`
  const live = sql`
    select m.user_id, au.email from public.org_members m
    join public.user_private u on u.user_id = m.user_id
    join auth.users au on au.id = m.user_id
    where m.status = 'active' and not u.is_superadmin and au.deleted_at is null
      and au.email is not null and au.email_confirmed_at is not null and coalesce(au.is_anonymous, false) = false
      and (au.banned_until is null or au.banned_until <= now())
      and not exists (select 1 from public.account_deletions d where d.user_id = m.user_id and d.state <> 'cancelled')`
  const people = await sql<{ user_id: string; email: string }[]>`select distinct user_id, email from (${live}) l limit 2`
  const [target, other] = people
  check('CONTROL: a superadmin and two live, non-superadmin members exist', !!sa && !!target && !!other)
  if (has1?.n !== 1) {
    skipped('every behaviour probe: the 1-argument view_as_real_start does not exist (migration A not applied — the BEFORE run)')
  } else if (state === 'MIXED') {
    skipped('every behaviour probe: the policy state is MIXED (already failed above)')
  } else if (!(sa && target && other && expected.size === Object.keys(INTENT).length)) {
    skipped('every behaviour probe: missing fixtures (see the CONTROL above)')
  } else {
    const B = state === 'B'
    await rolledBack(async (tx) => {
      const asUser = async (id: string, view?: string) => {
        const claims: Record<string, unknown> = { sub: id, role: 'authenticated' }
        if (view) claims.view_as = { session: view, actor: sa.user_id }
        await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`
        await tx.unsafe('set local role authenticated')
      }
      // Runs stmt as `id` (with the hook when viewing), then undoes everything it did.
      const attempt = async <T>(id: string, view: string | undefined, stmt: () => Promise<T>) => {
        await tx.unsafe('savepoint a')
        await asUser(id, view)
        if (view) await tx`select public.view_as_pre_request()`
        let err = ''
        let out: T | undefined
        try {
          out = await stmt()
        } catch (e) {
          err = String((e as Error).message)
        }
        await tx.unsafe('rollback to savepoint a')
        await tx.unsafe('reset role')
        await tx`select set_config('request.jwt.claims', '', true)`
        return { err, out }
      }
      const rows = (r: { out?: unknown }) => (r.out as postgres.Row[] | undefined) ?? []
      // A session row made directly (owner), so it does not end the others.
      const session = async (targetId: string, org: string | null, module: string | null) => {
        const [r] = await tx`insert into public.view_as_real_sessions (actor_user_id, target_user_id, org_id, module_key)
                             values (${sa.user_id}, ${targetId}, ${org}, ${module}) returning id`
        return r!.id as string
      }

      const member = await attempt(target.user_id, undefined, () => tx`select public.view_as_real_start(${sa.user_id}::uuid)`)
      check('  a member cannot start a whole-account view', /Not allowed/.test(member.err), member.err || 'no error')

      // The session must outlive its savepoint for the checks below.
      await asUser(sa.user_id)
      const [{ id }] = await tx`select public.view_as_real_start(${target.user_id}::uuid) as id`
      const [dash] = await tx`select * from public.view_as_real_check(${id}, '/dashboard', false)`
      const [cons] = await tx`select * from public.view_as_real_check(${id}, '/console', false)`
      await tx.unsafe('reset role')
      await tx`select set_config('request.jwt.claims', '', true)`
      check('  the superadmin starts one; /dashboard in scope, /console not, org/module null',
        dash?.in_scope === true && cons?.in_scope === false && dash?.org_id === null && dash?.module_key === null,
        JSON.stringify({ dash, cons }))

      // view_as_may_read: positive and negative tokens.
      const [anyOrg] = await tx<{ id: string }[]>`select org_id as id from public.org_members where user_id = ${target.user_id} and status = 'active' limit 1`
      const v1 = await session(target.user_id, anyOrg!.id, 'classroom')
      const may = async (who: string, view: string) =>
        rows(await attempt(who, view, () => tx`select public.view_as_may_read(${anyOrg!.id}, 'matchmaking') as m`))[0]?.m
      check('  view_as_may_read: TRUE for a live whole-account token (its own person)', (await may(target.user_id, id)) === true)
      check('  view_as_may_read: false for an org-scoped (v1) token', (await may(target.user_id, v1)) === false)
      check('  view_as_may_read: false for person X carrying person Y\'s session', (await may(other.user_id, id)) === false)

      const flags = await attempt(target.user_id, id, () =>
        tx`select current_setting('transaction_read_only') as ro, current_setting('sp.view_as', true) as flag,
                  public.private_text('twelve chars', 'private note') as t`)
      const f0 = rows(flags)[0]
      check('  under the view: read-only, sticky flag on, private text masked',
        !flags.err && f0?.ro === 'on' && f0?.flag === 'on' && f0?.t === '‹private note · 12 characters›', flags.err || JSON.stringify(f0))
      const blanked = await attempt(target.user_id, id, async () => {
        await tx`select set_config('request.jwt.claims', '', true)`
        return tx`select public.is_view_as_request() as c, public.private_text('twelve chars', 'private note') as t`
      })
      const b0 = rows(blanked)[0]
      check('  claims blanked mid-request: still masked (the sticky flag)', !blanked.err && b0?.c === false && b0?.t === '‹private note · 12 characters›', blanked.err || JSON.stringify(b0))
      const own = await attempt(target.user_id, undefined, () => tx`select public.private_text('twelve chars', 'private note') as t`)
      check('  CONTROL: without the view the text is returned', rows(own)[0]?.t === 'twelve chars', own.err)

      for (const [label, stmt] of [
        ['account_deletion_resume', () => tx`select public.account_deletion_resume() as r`],
        ['sd_my_notes (unknown event)', () => tx`select * from public.sd_my_notes(gen_random_uuid())`],
      ] as const) {
        const r = await attempt(target.user_id, id, stmt)
        check(`  under the read-only view, ${label} runs without error`, r.err === '', r.err)
      }
      const feedbackRo = await attempt(target.user_id, id, () => tx`select public.feedback_mark_read(gen_random_uuid())`)
      check('  feedback_mark_read keeps its own check before the view branch (unknown ticket refused)', /Ticket not found/.test(feedbackRo.err), feedbackRo.err || 'no error')

      // Invitations: an org invitation for the person, from the superadmin, to a fresh org.
      const [inviteOrg] = await tx`insert into public.orgs (name, slug) values ('verify probe', ${'verify-probe-' + Date.now()}) returning id`
      await tx`insert into public.pending_invites (kind, org_id, target_id, email, role, invited_by, expires_at)
               values ('org', ${inviteOrg!.id}, ${inviteOrg!.id}, ${target.email.trim().toLowerCase()}, 'member', ${sa.user_id}, now() + interval '7 days')`
      const shown = await attempt(target.user_id, id, () => tx`select org_id from public.org_my_pending_invites()`)
      check('  CONTROL: under the view, the invitation is SHOWN (as the pending seat the claim would make)',
        !shown.err && rows(shown).some((r) => r.org_id === inviteOrg!.id), shown.err || JSON.stringify(rows(shown)))
      const claimed = await attempt(target.user_id, id, () => tx`select public.pending_invites_claim_mine() as n`)
      check('  under the view, pending_invites_claim_mine claims 0', !claimed.err && rows(claimed)[0]?.n === 0, claimed.err || JSON.stringify(rows(claimed)))
      const ctl = await attempt(target.user_id, undefined, () => tx`select public.pending_invites_claim_mine() as n`)
      check('  CONTROL: without the view the same claim applies it (then rolled back)', !ctl.err && (rows(ctl)[0]?.n ?? 0) >= 1, ctl.err || JSON.stringify(rows(ctl)))

      // Matchmaking: a single with an approved question in the same org.
      const [mq] = await tx<{ q: string; u: string; org: string }[]>`
        select q.id as q, r.user_id as u, q.org_id as org from public.mm_questions q
        join public.module_roles r on r.org_id = q.org_id and r.module_key = 'matchmaking' and r.role = 'single' and r.scope_ref is null
        join public.org_members m on m.org_id = q.org_id and m.user_id = r.user_id and m.status = 'active'
        join public.org_modules om on om.org_id = q.org_id and om.module_key = 'matchmaking' and om.enabled
        join public.user_private up on up.user_id = r.user_id and not up.is_superadmin
        join auth.users au on au.id = r.user_id and au.deleted_at is null and (au.banned_until is null or au.banned_until <= now())
        where q.status = 'approved'
          and not exists (select 1 from public.account_deletions d where d.user_id = r.user_id and d.state <> 'cancelled')
        limit 1`
      if (mq) {
        const mWhole = await session(mq.u, null, null)
        const mV1 = await session(mq.u, mq.org, 'classroom')
        const mine = (view?: string) => attempt(mq.u, view, () => tx`select * from public.mm_my_answers(${mq.org})`)
        const plain = await mine()
        check('  CONTROL: mm_my_answers returns rows for a single (no view)', !plain.err && rows(plain).length > 0, plain.err || '0 rows')
        const viewed = await mine(mWhole)
        check(`  mm_my_answers under a whole-account view: ${B ? 'the same rows (B)' : 'none (A: the policies are dark)'}`,
          !viewed.err && rows(viewed).length === (B ? rows(plain).length : 0), viewed.err || `${rows(viewed).length} vs ${rows(plain).length}`)
        check('  mm_my_answers under a v1 view: none', rows(await mine(mV1)).length === 0)
        const ens = async (view?: string) =>
          attempt(mq.u, view, () => tx`select (public.mm_ensure_answer(${mq.q})).position as p`)
        const eWhole = await ens(mWhole)
        check(`  mm_ensure_answer under a whole-account view: ${B ? 'an answer (B)' : 'NULL (A)'}, no error`,
          eWhole.err === '' && (B ? typeof rows(eWhole)[0]?.p === 'number' : rows(eWhole)[0]?.p === null), eWhole.err || JSON.stringify(rows(eWhole)))
        const eV1 = await ens(mV1)
        check('  mm_ensure_answer under a v1 view: NULL', eV1.err === '' && rows(eV1)[0]?.p === null, eV1.err || JSON.stringify(rows(eV1)))
        const eOwn = await ens()
        check('  CONTROL: mm_ensure_answer without a view returns an answer', eOwn.err === '' && typeof rows(eOwn)[0]?.p === 'number', eOwn.err)
      } else {
        skipped('matchmaking probes: no live single with an approved question on this database')
      }

      // Private notes: a person WITH a note (or one inserted here, rolled back).
      let [nt] = await tx<{ author: string; event: string; n: number }[]>`
        select n.author_user_id as author, n.event_id as event, count(*)::int as n
        from public.sd_notes n
        join (${live}) l on l.user_id = n.author_user_id
        group by 1, 2 limit 1`
      let inserted = false
      if (!nt) {
        let [ev] = await tx<{ id: string }[]>`select id from public.sd_events limit 1`
        if (!ev) [ev] = await tx<{ id: string }[]>`insert into public.sd_events (org_id, name) values (${inviteOrg!.id}, 'verify probe') returning id`
        // No JWT claims here, so sd_notes_guard lets the owner insert.
        await tx`insert into public.sd_notes (event_id, author_user_id, about_user_id, body, org_id)
                 select ${ev!.id}, ${target.user_id}, ${other.user_id}, 'verify probe note', e.org_id from public.sd_events e where e.id = ${ev!.id}`
        nt = { author: target.user_id, event: ev!.id, n: 1 }
        inserted = true
      }
      console.log(`  (notes probe: ${inserted ? 'no note on this database — one inserted, rolled back' : 'a real note author'})`)
      const nWhole = await session(nt.author, null, null)
      const direct = (view?: string) => attempt(nt!.author, view, () => tx`select count(*)::int as n from public.sd_notes where author_user_id = ${nt!.author}`)
      const dPlain = await direct()
      check('  CONTROL: without a view the person reads their notes directly (count > 0)', !dPlain.err && (rows(dPlain)[0]?.n ?? 0) > 0, dPlain.err || JSON.stringify(rows(dPlain)))
      const dView = await direct(nWhole)
      check('  a direct sd_notes read under a whole-account view is empty', !dView.err && rows(dView)[0]?.n === 0, dView.err || JSON.stringify(rows(dView)))
      const mn = (view?: string) => attempt(nt!.author, view, () => tx`select body from public.sd_my_notes(${nt!.event})`)
      const mnPlain = rows(await mn())
      const mnView = await mn(nWhole)
      const lens = mnPlain.map((r) => String(r.body).length).sort()
      const masked = rows(mnView).map((r) => MASK.exec(String(r.body))?.[1]).map(Number).sort()
      check('  CONTROL: sd_my_notes without a view returns the real text', mnPlain.length > 0 && mnPlain.every((r) => !MASK.test(String(r.body))), JSON.stringify(mnPlain.length))
      check('  sd_my_notes under a whole-account view: every body is ‹private note · N characters›, N = the real length',
        !mnView.err && rows(mnView).length === mnPlain.length && JSON.stringify(masked) === JSON.stringify(lens),
        mnView.err || JSON.stringify({ masked, lens }))
    })
  }
} finally {
  await sql.end()
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
