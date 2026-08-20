// PROD verification for 20260810010000_activity_events.sql — engagement
// monitoring PHASE 2 (docs/17-engagement-monitoring.md). The half
// `scripts/prod-verify-migration.ts` structurally CANNOT check.
//
//   pnpm exec tsx scripts/prod-verify-activity-events.mts
//
// No arguments and NO app credentials: it connects through the session pooler
// with `SUPABASE_DB_PASSWORD` from `.env.deploy`. Read-only (every statement
// below is a SELECT against catalogs or the two tables themselves — nothing
// here writes).
//
// COPIED FROM scripts/prod-verify-login-events.mts, which is itself copied
// from scripts/prod-verify-superadmin-log.mts — the template for any
// migration creating a TABLE, POLICY, GRANT, TRIGGER or CONSTRAINT. That
// migration defines two functions, so `prod-verify-migration.ts` is not
// vacuous here either — it checks the two trigger functions' bodies and ACLs.
// It still cannot see the tables, the policies, the trigger BINDINGS, the FK
// actions, the CHECK constraints, the composite primary key or whether
// activity has actually landed — everything below.
//
// *** THE ONE PLACE THIS SCRIPT DELIBERATELY DIVERGES FROM ITS TEMPLATE ***
// `login_events`/`login_rollup` have NO user-facing write path at all — their
// only writer is a trigger on `auth.users` running as the owner — so the
// login-events template asserts `authenticated` holds exactly SELECT and
// nothing else, on BOTH tables. Copying that assumption here would be wrong
// and would not even be a stricter check: `activity_events` has a REAL
// caller-facing INSERT path (~30 call sites across 6 modules insert into it
// AS THE CALLER, per the migration's own header on "the write shape is new
// for this platform's logs"). So section [2] below asserts `authenticated`
// holds exactly SELECT, INSERT on activity_events, and — the asymmetry the
// migration's ACL comment calls out explicitly — exactly SELECT (no INSERT)
// on activity_rollup, which is maintained ONLY by the definer trigger.
//
// EVERY ASSERTION CARRIES A CONTROL. A catalog query that silently returns
// zero rows looks exactly like "the thing is absent", which would let this
// script PASS a missing policy/trigger/constraint as a correctly-absent one.
//
// WHAT THIS FILE IS REALLY FOR, in one line: prod's
// `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` grants the FULL privilege set
// — including the whole-table wipe privilege RLS provably does not gate — to
// `anon`, `authenticated` AND `service_role` on every newly created table in
// `public`, and EXECUTE on every new function. The migration's explicit
// four-role revokes have to beat that on THIS project, and local cannot tell
// us whether they did.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const env = readFileSync(resolve(root, '.env.deploy'), 'utf8')
const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''

const ref = get('SUPABASE_PROJECT_REF')
const pw = get('SUPABASE_DB_PASSWORD')
if (!ref || !pw) throw new Error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD in .env.deploy')

const sql = postgres(
  `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`,
  { ssl: 'require', max: 1 },
)

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? `  [${detail}]` : ''}`) }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`) }
}

const TABLES = ['activity_events', 'activity_rollup'] as const
const MODULE_KEYS = ['classroom', 'nail-salon', 'matchmaking', 'speed-dating', 'synagogue-schedules', 'visual-messaging']

try {
  console.log(`\nProd verification — engagement monitoring phase 2 / activity capture (project ${ref})\n`)

  // -------------------------------------------------------------------------
  console.log('[0] This connection really authenticates as `postgres` through the pooler')
  // Same load-bearing assumption as phase 1's pruner (see the equivalent check
  // added to scripts/prod-verify-login-events.mts, 2026-08-16, following a
  // confirmed-Fable re-review): "the owner-only activity_events_prune() is
  // invocable by the worker and nobody else" rests on the worker's pooler
  // connection (`postgres.<ref>` username) actually assuming the `postgres`
  // ROLE, not merely looking like it from the connection string. Assert it
  // directly rather than trusting the naming convention.
  const who = await sql`select current_user as u`
  check('this connection authenticates as postgres (not some other pooler-mapped role)',
    who[0]?.u === 'postgres', `current_user=${who[0]?.u}`)

  // -------------------------------------------------------------------------
  console.log('[1] The tables exist with RLS enabled')
  const tables = await sql`
    select c.relname, c.relrowsecurity, c.relforcerowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'`
  check('CONTROL: the catalog read returns public tables at all', tables.length > 20, `${tables.length} tables`)
  for (const t of TABLES) {
    const row = tables.find((r) => r.relname === t)
    check(`${t} exists on prod`, row !== undefined)
    check(`RLS is ENABLED on ${t}`, row?.relrowsecurity === true)
  }

  // -------------------------------------------------------------------------
  console.log('\n[2] The ACL — and the asymmetry that makes this table UNLIKE phase 1')
  // activity_events has a real caller-facing INSERT path (~30 call sites across
  // 6 modules, insert AS THE CALLER). activity_rollup does not: it is maintained
  // ONLY by the definer trigger, so authenticated gets SELECT there and nothing
  // else. Both facts are asserted explicitly rather than assumed from the
  // login-events template, which had neither an INSERT grant nor this asymmetry.
  const grants = await sql`
    select table_name, grantee, privilege_type
    from information_schema.role_table_grants
    where table_schema = 'public' and table_name in ${sql(TABLES)}`
  check('CONTROL: the grants read returns rows', grants.length > 0, `${grants.length} grant rows`)

  const privsOf = (table: string, role: string) =>
    grants.filter((g) => g.table_name === table && g.grantee === role)
      .map((g) => g.privilege_type).sort()
  const setEq = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

  check('activity_events: authenticated holds exactly INSERT, SELECT',
    setEq(privsOf('activity_events', 'authenticated'), ['INSERT', 'SELECT']),
    JSON.stringify(privsOf('activity_events', 'authenticated')))
  check('activity_rollup: authenticated holds exactly SELECT (NO insert — trigger-maintained only)',
    setEq(privsOf('activity_rollup', 'authenticated'), ['SELECT']),
    JSON.stringify(privsOf('activity_rollup', 'authenticated')))

  for (const t of TABLES) {
    check(`${t}: anon holds NOTHING`, privsOf(t, 'anon').length === 0, JSON.stringify(privsOf(t, 'anon')))
    check(`${t}: service_role holds NOTHING`, privsOf(t, 'service_role').length === 0,
      JSON.stringify(privsOf(t, 'service_role')))
    for (const role of ['authenticated', 'service_role', 'anon']) {
      const bad = privsOf(t, role).filter((p) => ['UPDATE', 'DELETE', 'TRUNCATE'].includes(p))
      check(`${t}: ${role} holds no UPDATE/DELETE/TRUNCATE`, bad.length === 0, JSON.stringify(bad))
    }
  }

  // -------------------------------------------------------------------------
  console.log('\n[3] The policies — one INSERT, two SELECT, and the arm that must NOT exist')
  const policies = await sql`
    select tablename, policyname, cmd, qual, with_check
    from pg_policies where schemaname = 'public' and tablename in ${sql(TABLES)}`
  const allPolicies = await sql`select count(*)::int as n from pg_policies where schemaname = 'public'`
  check("CONTROL: pg_policies returns the schema's policies at all",
    (allPolicies[0]?.n ?? 0) > 100, `${allPolicies[0]?.n} policies in public`)

  check('exactly THREE policies across both tables', policies.length === 3,
    JSON.stringify(policies.map((p) => `${p.tablename}.${p.policyname}:${p.cmd}`)))
  check('none of the three is FOR ALL (a FOR ALL policy\'s USING silently covers SELECT too)',
    !policies.some((p) => String(p.cmd) === 'ALL'))

  const insertPolicies = policies.filter((p) => String(p.cmd) === 'INSERT')
  const selectPolicies = policies.filter((p) => String(p.cmd) === 'SELECT')
  check('exactly ONE insert policy: activity_events_insert_self',
    insertPolicies.length === 1 && insertPolicies[0]?.policyname === 'activity_events_insert_self',
    JSON.stringify(insertPolicies.map((p) => p.policyname)))
  check('the insert policy pins user_id to the caller AND requires active membership',
    /auth\.uid\(\)/.test(String(insertPolicies[0]?.with_check)) && /is_org_member/.test(String(insertPolicies[0]?.with_check)),
    String(insertPolicies[0]?.with_check))

  check('exactly TWO select policies: one per table, both superadmin-gated by name',
    selectPolicies.length === 2 &&
      selectPolicies.some((p) => p.policyname === 'activity_events_select_superadmin') &&
      selectPolicies.some((p) => p.policyname === 'activity_rollup_select_superadmin'),
    JSON.stringify(selectPolicies.map((p) => p.policyname)))
  for (const p of selectPolicies) {
    check(`${p.policyname} is gated on is_superadmin()`, /is_superadmin\(\)/.test(String(p.qual)), String(p.qual))
  }

  // THE NEGATIVE THAT MATTERS MOST, with the count above as its control. A rank
  // arm here would be WORSE than on either existing log: this table's SUBJECT
  // is very often genuinely unranked (a salon customer booking their own
  // appointment holds no module grant at all), and module_position_rank
  // returns 0 for unmapped pairs and never null — so a rank arm would let every
  // rank-1 holder in the org read the engagement of most of the org, silently.
  // Migration header calls this "the central point of this file". docs/17 §7.1.
  const anyRankArm = policies.some((p) =>
    /module_position_rank|module_roles|module_scope_covers/.test(`${p.qual} ${p.with_check}`))
  check('NO policy references a module rank / scope arm (the rank-0 inversion)', !anyRankArm)

  const rollupPolicies = policies.filter((p) => p.tablename === 'activity_rollup')
  check('activity_rollup has no insert/update/delete policy (trigger-maintained only)',
    rollupPolicies.every((p) => String(p.cmd) === 'SELECT'))

  // -------------------------------------------------------------------------
  console.log('\n[4] Both triggers are BOUND and ENABLED on activity_events')
  const triggers = await sql`
    select t.tgname, t.tgenabled
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'activity_events' and not t.tgisinternal`
  check('CONTROL: this query can see triggers on activity_events at all', triggers.length > 0,
    JSON.stringify(triggers.map((r) => r.tgname)))
  const guardTrig = triggers.find((r) => r.tgname === 'activity_events_guard')
  const rollupTrig = triggers.find((r) => r.tgname === 'activity_events_rollup')
  check('activity_events_guard (BEFORE INSERT) is bound', guardTrig !== undefined,
    JSON.stringify(triggers.map((r) => r.tgname)))
  check('activity_events_guard is ENABLED', guardTrig?.tgenabled === 'O', String(guardTrig?.tgenabled))
  check('activity_events_rollup (AFTER INSERT) is bound', rollupTrig !== undefined,
    JSON.stringify(triggers.map((r) => r.tgname)))
  check('activity_events_rollup is ENABLED', rollupTrig?.tgenabled === 'O', String(rollupTrig?.tgenabled))

  // -------------------------------------------------------------------------
  console.log('\n[5] The two trigger functions — and the lock_timeout regression check')
  const fns = await sql`
    select p.proname, p.prosecdef, p.pronargs, p.proacl::text as acl,
           pg_get_functiondef(p.oid) as def, p.proowner::regrole::text as owner
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('activity_event_guard', 'activity_rollup_apply', 'activity_events_prune')`
  check('CONTROL: all three functions are readable from pg_proc', fns.length === 3,
    JSON.stringify(fns.map((f) => f.proname)))

  const guardFn = fns.find((f) => f.proname === 'activity_event_guard')
  const rollupFn = fns.find((f) => f.proname === 'activity_rollup_apply')

  check('activity_event_guard IS security definer', guardFn?.prosecdef === true, `prosecdef=${guardFn?.prosecdef}`)
  check('activity_event_guard pins search_path', /SET\s+search_path/i.test(String(guardFn?.def)))
  check('activity_event_guard sets lock_timeout', /SET\s+lock_timeout/i.test(String(guardFn?.def)))

  check('activity_rollup_apply IS security definer', rollupFn?.prosecdef === true, `prosecdef=${rollupFn?.prosecdef}`)
  check('activity_rollup_apply pins search_path', /SET\s+search_path/i.test(String(rollupFn?.def)))
  // THE SINGLE MOST IMPORTANT REGRESSION TO GUARD AGAINST FOR THIS MIGRATION
  // (per the task brief and the migration's own header on activity_rollup_apply):
  // the first draft set lock_timeout ONLY on the guard, which barely contends —
  // the upsert that actually contends lives in THIS function, in its own
  // function-scoped SET that does not inherit the guard's. Fixed 2026-08-11.
  check('activity_rollup_apply ALSO sets its OWN lock_timeout (2026-08-11 fix — the guard\'s SET does not carry over)',
    /SET\s+lock_timeout/i.test(String(rollupFn?.def)))

  for (const fnSig of ['public.activity_event_guard()', 'public.activity_rollup_apply()']) {
    for (const role of ['authenticated', 'service_role', 'anon']) {
      const r = await sql`select has_function_privilege(${role}, ${fnSig}, 'execute') as ok`
      check(`${role} holds no EXECUTE on ${fnSig}`, r[0]?.ok === false)
    }
  }

  // -------------------------------------------------------------------------
  console.log('\n[6] The CHECK constraints bounding free text on activity_events')
  // These, not the TypeScript union, are the REAL bound — the migration's own
  // header calls out that claiming otherwise was its own mistake, since
  // authenticated reaches this table through PostgREST directly, bypassing
  // activity.ts entirely. activity_rollup is never pruned, so a hole here is
  // permanent.
  const cons = await sql`
    select con.conname, pg_get_constraintdef(con.oid) as def
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'activity_events' and con.contype = 'c'`
  check('CONTROL: CHECK constraints are readable on activity_events', cons.length > 0, `${cons.length} check constraints`)

  const moduleKeyCon = cons.find((r) => r.conname === 'activity_events_module_key_known')
  check('activity_events_module_key_known exists', moduleKeyCon !== undefined)
  check('the closed module_key set names all 6 current modules',
    MODULE_KEYS.every((k) => String(moduleKeyCon?.def).includes(`'${k}'`)),
    String(moduleKeyCon?.def))

  const actionShapeCon = cons.find((r) => r.conname === 'activity_events_action_shape')
  check('activity_events_action_shape exists', actionShapeCon !== undefined)
  check('the action-shape constraint bounds length to 60 and enforces the naming convention',
    /<=\s*60/.test(String(actionShapeCon?.def)) && /~/.test(String(actionShapeCon?.def)),
    String(actionShapeCon?.def))

  const dedupeCon = cons.find((r) => r.conname === 'activity_events_dedupe_key_bounded')
  check('activity_events_dedupe_key_bounded exists', dedupeCon !== undefined)
  check('the dedupe_key constraint bounds length to 200',
    /<=\s*200/.test(String(dedupeCon?.def)), String(dedupeCon?.def))

  // -------------------------------------------------------------------------
  console.log('\n[7] FK actions — diverges from BOTH existing logs, on purpose (migration header §"FK actions")')
  const fkRows = await sql`
    select c.relname as tbl, con.conname, con.confdeltype,
           array_agg(a.attname order by a.attnum) as cols
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    join lateral unnest(con.conkey) as ck(attnum) on true
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = ck.attnum
    where n.nspname = 'public' and c.relname in ${sql(TABLES)} and con.contype = 'f'
    group by c.relname, con.conname, con.confdeltype, con.oid`
  // CONTROL: 2 tables x (user_id, org_id) = 4, plus activity_events.scope_ref = 5.
  check('CONTROL: the expected number of foreign keys is visible', fkRows.length >= 5,
    JSON.stringify(fkRows.map((r) => `${r.tbl}.${r.conname}=[${r.cols}]`)))

  const hasCol = (r: (typeof fkRows)[number], col: string) => (r.cols as string[]).includes(col)
  const cascadeTargets = fkRows.filter((r) => hasCol(r, 'user_id') || hasCol(r, 'org_id'))
  check('CONTROL: user_id/org_id FKs are found on both tables', cascadeTargets.length >= 4,
    JSON.stringify(cascadeTargets.map((r) => `${r.tbl}.${r.conname}`)))
  check('every user_id/org_id FK is ON DELETE CASCADE (an event/rollup row naming nobody or no org is worthless)',
    cascadeTargets.every((r) => r.confdeltype === 'c'),
    JSON.stringify(cascadeTargets.map((r) => `${r.tbl}.${r.conname}=${r.confdeltype}`)))

  const scopeRefFk = fkRows.find((r) => r.tbl === 'activity_events' && hasCol(r, 'scope_ref'))
  check('activity_events.scope_ref FK exists (control for the divergent-action check below)', scopeRefFk !== undefined)
  check('activity_events.scope_ref is ON DELETE SET NULL — diverges from user_id/org_id on purpose ' +
    '(cascading would erase engagement history when a scope node is retired)',
    scopeRefFk?.confdeltype === 'n', `confdeltype=${scopeRefFk?.confdeltype}`)

  // -------------------------------------------------------------------------
  console.log('\n[8] activity_rollup\'s primary key includes `action` — the 2026-08-11 late change')
  const pkRows = await sql`
    select con.oid, array_agg(a.attname order by a.attnum) as cols
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    join lateral unnest(con.conkey) as ck(attnum) on true
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = ck.attnum
    where n.nspname = 'public' and c.relname = 'activity_rollup' and con.contype = 'p'
    group by con.oid`
  check('CONTROL: exactly one primary key constraint is found on activity_rollup', pkRows.length === 1,
    JSON.stringify(pkRows))
  const pkCols = (pkRows[0]?.cols ?? []) as string[]
  check('the primary key is the full 4-column composite (user_id, org_id, module_key, action)',
    pkCols.length === 4, JSON.stringify(pkCols))
  check('`action` IS part of the primary key (subtracting an action must work backwards, not just forwards)',
    pkCols.includes('action'), JSON.stringify(pkCols))

  // -------------------------------------------------------------------------
  console.log('\n[9] The partial unique dedupe index')
  const idxRows = await sql`
    select indexname, indexdef
    from pg_indexes where schemaname = 'public' and tablename = 'activity_events'`
  check('CONTROL: indexes are readable on activity_events', idxRows.length > 0, `${idxRows.length} indexes`)
  const dedupeIdx = idxRows.find((r) => r.indexname === 'activity_events_dedupe_idx')
  check('activity_events_dedupe_idx exists', dedupeIdx !== undefined)
  check('it is UNIQUE', /create unique index/i.test(String(dedupeIdx?.indexdef)), String(dedupeIdx?.indexdef))
  check('it is PARTIAL, on dedupe_key is not null (so the overwhelming majority of rows pay nothing for this)',
    /where/i.test(String(dedupeIdx?.indexdef)) && /dedupe_key/i.test(String(dedupeIdx?.indexdef)),
    String(dedupeIdx?.indexdef))

  // -------------------------------------------------------------------------
  console.log('\n[10] THE PRUNER — the one exception to append-only on this platform')
  const prune = fns.find((f) => f.proname === 'activity_events_prune')
  check('CONTROL: the pruner is readable from pg_proc (already loaded above)', prune !== undefined)
  check('the pruner is NOT security definer (so it can never exceed its caller)',
    prune?.prosecdef === false, `prosecdef=${prune?.prosecdef}`)
  check('the pruner takes NO arguments (the window cannot be caller-supplied)',
    Number(prune?.pronargs) === 0, `pronargs=${prune?.pronargs}`)
  check('the 90-day retention window is intact', /interval\s+'90 days'/.test(String(prune?.def)))
  check('the pruner is owned by postgres (the worker connects as that role)',
    String(prune?.owner) === 'postgres', String(prune?.owner))
  check('the pruner touches only activity_events, never activity_rollup (the tally is permanent)',
    /delete from public\.activity_events/i.test(String(prune?.def)) &&
      !/delete from public\.activity_rollup/i.test(String(prune?.def)))

  const execPrivs = await sql`
    select r.rolname,
           has_function_privilege(r.rolname, 'public.activity_events_prune()', 'execute') as prune,
           has_function_privilege(r.rolname, 'public.is_superadmin()', 'execute')          as control
    from pg_roles r where r.rolname in ('postgres', 'authenticated', 'service_role', 'anon')`
  const ex = (role: string) => execPrivs.find((r) => r.rolname === role)
  check('CONTROL: has_function_privilege reports TRUE for a function that really is granted',
    ex('authenticated')?.control === true)
  check('the OWNER can execute the pruner (or retention can never run at all)',
    ex('postgres')?.prune === true)
  for (const role of ['authenticated', 'service_role', 'anon']) {
    check(`${role} may NOT execute the pruner`, ex(role)?.prune === false, `acl=${prune?.acl}`)
  }

  // -------------------------------------------------------------------------
  console.log('\n[11] Capture is actually working on PROD — THIS MUST FAIL UNTIL REAL ACTIVITY LANDS')
  // Founder decision 3 (docs/17): a failed activity write is swallowed silently
  // by the app helper, and there is NO honesty badge for phase 2 yet (no console
  // reader was built — that is a later phase). So an empty table here is
  // indistinguishable from "capture is broken" and MUST be reported as a
  // failure, not softened or skipped, exactly as CLAUDE.md's "Now" section and
  // docs/17's decisions log require.
  const state = await sql`
    select (select count(*)::int from public.activity_events)  as events,
           (select count(*)::int from public.activity_rollup)  as rollup_rows,
           (select max(occurred_at) from public.activity_events) as newest_event`
  const s = state[0]!
  console.log(`        raw activity_events rows: ${s.events}`)
  console.log(`        permanent activity_rollup rows: ${s.rollup_rows}`)
  console.log(`        newest captured activity: ${s.newest_event ?? '<none yet>'}`)
  if (Number(s.events) === 0) {
    console.log('        ^ NOT YET PROVEN ON PROD. Perform one real instrumented action against')
    console.log('          production — e.g. sign in as a demo user and book a salon appointment,')
    console.log('          or complete any of the ~45 call sites in docs/17 §12.3/§12.6 — then')
    console.log('          re-run this script. Until this number is non-zero, capture is UNVERIFIED')
    console.log('          in the one environment that matters, and by founder decision that failure')
    console.log('          would be SILENT to every real user (no honesty badge exists for phase 2).')
  }
  check('CAPTURE IS PROVEN LIVE ON PROD (at least one real activity event recorded)',
    Number(s.events) > 0, `${s.events} events`)

  console.log(`\n${pass} passed, ${fail} failed`)
} finally {
  await sql.end()
}
process.exit(fail === 0 ? 0 : 1)
