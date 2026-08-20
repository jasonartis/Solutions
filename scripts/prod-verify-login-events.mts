// PROD verification for 20260809010000_login_events.sql — the half
// `scripts/prod-verify-migration.ts` structurally CANNOT check.
//
//   pnpm exec tsx scripts/prod-verify-login-events.mts
//
// No arguments and NO app credentials: it connects through the session pooler
// with `SUPABASE_DB_PASSWORD` from `.env.deploy`. Read-only.
//
// COPIED FROM scripts/prod-verify-superadmin-log.mts, which is the template for
// any migration creating a TABLE, POLICY, GRANT, TRIGGER or CONSTRAINT. Note
// that unlike that migration, this one DOES define functions, so
// `prod-verify-migration.ts` is not vacuous here — it will check the two
// function bodies and their ACLs. It still cannot see the tables, the policies,
// the trigger BINDING, the FK actions or the backfill, which is everything below.
//
// EVERY ASSERTION CARRIES A CONTROL. A catalog query that silently returns zero
// rows looks exactly like "the thing is absent", which would let this script
// PASS a missing policy as a correctly-absent one.
//
// WHAT THIS FILE IS REALLY FOR, in one line: prod's
// `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` grants the FULL privilege set —
// including the whole-table wipe privilege RLS provably does not gate — to
// `anon`, `authenticated` AND `service_role` on every newly created table in
// `public`, and EXECUTE on every new function. Measured on this project
// 2026-08-09: 15 default-ACL entries name an api role. The migration's
// four-role revokes have to beat that, and local cannot tell us whether they did.
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

const TABLES = ['login_events', 'login_rollup'] as const

try {
  console.log(`\nProd verification — login capture (project ${ref})\n`)

  // -------------------------------------------------------------------------
  console.log('[0] This connection really authenticates as `postgres` through the pooler')
  // The whole "the owner-only pruner is invocable by the worker and nobody
  // else" argument rests on the worker's pooler connection (`postgres.<ref>`
  // username) actually assuming the `postgres` ROLE, not merely LOOKING like
  // it from the connection string. That was checked once, by hand, on
  // 2026-08-09 (docs/history/platform-journal.md) and never carried into this
  // permanent, re-runnable verifier — so a future change to Supabase's
  // Supavisor username-to-role mapping would go silently unnoticed. Same
  // pattern already used in scripts/verify-acl-hardening.ts (`select
  // current_user as u`), applied here to the actual prod pooler connection
  // this script itself is using — not a separate probe.
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
  console.log('\n[2] The ACL — READ-ONLY to every api role (stronger than append-only)')
  // Neither table has ANY user-facing write path: the only writer is the capture
  // trigger, running as the owner. So unlike the two existing logs, not even
  // INSERT is granted. If prod's default privileges won, this is where it shows.
  const grants = await sql`
    select table_name, grantee, privilege_type
    from information_schema.role_table_grants
    where table_schema = 'public' and table_name in ${sql(TABLES)}`
  check('CONTROL: the grants read returns rows', grants.length > 0, `${grants.length} grant rows`)

  const privsOf = (table: string, role: string) =>
    grants.filter((g) => g.table_name === table && g.grantee === role)
      .map((g) => g.privilege_type).sort()
  const setEq = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

  for (const t of TABLES) {
    check(`${t}: authenticated holds exactly SELECT`, setEq(privsOf(t, 'authenticated'), ['SELECT']),
      JSON.stringify(privsOf(t, 'authenticated')))
    check(`${t}: anon holds NOTHING`, privsOf(t, 'anon').length === 0, JSON.stringify(privsOf(t, 'anon')))
    check(`${t}: service_role holds NOTHING`, privsOf(t, 'service_role').length === 0,
      JSON.stringify(privsOf(t, 'service_role')))
    for (const role of ['authenticated', 'service_role', 'anon']) {
      const bad = privsOf(t, role).filter((p) => ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].includes(p))
      check(`${t}: ${role} holds no write or whole-table-wipe privilege`, bad.length === 0, JSON.stringify(bad))
    }
  }

  // -------------------------------------------------------------------------
  console.log('\n[3] The policies — and the arm that must NOT exist')
  const policies = await sql`
    select tablename, policyname, cmd, qual, with_check
    from pg_policies where schemaname = 'public' and tablename in ${sql(TABLES)}`
  const allPolicies = await sql`select count(*)::int as n from pg_policies where schemaname = 'public'`
  check("CONTROL: pg_policies returns the schema's policies at all",
    (allPolicies[0]?.n ?? 0) > 100, `${allPolicies[0]?.n} policies in public`)

  check('exactly TWO policies across both tables', policies.length === 2,
    JSON.stringify(policies.map((p) => `${p.tablename}.${p.policyname}:${p.cmd}`)))
  for (const p of policies) {
    check(`${p.policyname} is SELECT-only (a FOR ALL policy's USING silently covers SELECT)`,
      p.cmd === 'SELECT', String(p.cmd))
    check(`${p.policyname} is gated on is_superadmin()`,
      /is_superadmin\(\)/.test(String(p.qual)), String(p.qual))
  }

  // THE NEGATIVE THAT MATTERS MOST, with the count above as its control. A rank
  // arm here would be WORSE than on the lookup log: an engagement row's SUBJECT
  // is often genuinely unranked (a customer, a student), and module_position_rank
  // returns 0 for unmapped pairs and never null — so every rank-1 holder would
  // read the engagement of most of their org. docs/17 §7.1.
  const anyRankArm = policies.some((p) =>
    /module_position_rank|module_roles|module_scope_covers/.test(`${p.qual} ${p.with_check}`))
  check('NO policy references a module rank / scope arm (the rank-0 inversion)', !anyRankArm)
  check('no write policy exists on either table',
    !policies.some((p) => ['INSERT', 'UPDATE', 'DELETE', 'ALL'].includes(String(p.cmd))))

  // -------------------------------------------------------------------------
  console.log('\n[4] The capture trigger is BOUND and ENABLED on auth.users')
  // The whole feature is this trigger. A function nothing fires captures nothing,
  // and docs/17 §2 exists because a silently-empty table looks like a true answer.
  const triggers = await sql`
    select t.tgname, t.tgenabled
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'auth' and c.relname = 'users' and not t.tgisinternal`
  // CONTROL: the long-lived sibling proves this query can see auth-schema
  // triggers at all — exactly what an information_schema version would miss.
  check('CONTROL: on_auth_user_created is visible (so this query reads auth triggers)',
    triggers.some((r) => r.tgname === 'on_auth_user_created'),
    JSON.stringify(triggers.map((r) => r.tgname)))
  const capture = triggers.find((r) => r.tgname === 'on_auth_user_login')
  check('the capture trigger is bound to auth.users', capture !== undefined,
    JSON.stringify(triggers.map((r) => r.tgname)))
  check('and it is ENABLED', capture?.tgenabled === 'O', String(capture?.tgenabled))

  // -------------------------------------------------------------------------
  console.log('\n[5] THE PRUNER — the one exception to append-only on this platform')
  const fns = await sql`
    select p.proname, p.prosecdef, p.pronargs, p.proacl::text as acl,
           pg_get_functiondef(p.oid) as def, p.proowner::regrole::text as owner
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('login_events_prune', 'capture_login')`
  check('CONTROL: both functions are readable from pg_proc', fns.length === 2,
    JSON.stringify(fns.map((f) => f.proname)))

  const prune = fns.find((f) => f.proname === 'login_events_prune')
  check('the pruner is NOT security definer (so it can never exceed its caller)',
    prune?.prosecdef === false, `prosecdef=${prune?.prosecdef}`)
  check('the pruner takes NO arguments (the window cannot be caller-supplied)',
    Number(prune?.pronargs) === 0, `pronargs=${prune?.pronargs}`)
  check('the 90-day retention window is intact', /interval\s+'90 days'/.test(String(prune?.def)))
  check('the pruner is owned by postgres (the worker connects as that role)',
    String(prune?.owner) === 'postgres', String(prune?.owner))

  // EXECUTE granted to nobody. This is the assertion prod's default privileges
  // most directly threaten: they grant EXECUTE on every new function in public
  // to anon/authenticated/service_role DIRECTLY, which `revoke ... from public`
  // does not remove — the 2026-07-22 module_scope_covers gap.
  const execPrivs = await sql`
    select r.rolname,
           has_function_privilege(r.rolname, 'public.login_events_prune()', 'execute') as prune,
           has_function_privilege(r.rolname, 'public.is_superadmin()', 'execute')      as control
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
  console.log('\n[6] The capture function itself')
  const cap = fns.find((f) => f.proname === 'capture_login')
  check('capture_login IS security definer (it writes as owner from a GoTrue update)',
    cap?.prosecdef === true, `prosecdef=${cap?.prosecdef}`)
  check('capture_login pins search_path', /SET\s+search_path/i.test(String(cap?.def)))
  // The fix for the review's HIGH finding: WHEN OTHERS does not catch
  // query_canceled, and this project's cluster statement_timeout is 120s, so an
  // unbounded lock wait inside the trigger could abort GoTrue's sign-in.
  check('capture_login bounds its lock wait (SET lock_timeout) so it cannot fail a sign-in',
    /SET\s+lock_timeout/i.test(String(cap?.def)))
  for (const role of ['authenticated', 'service_role', 'anon']) {
    const r = await sql`select has_function_privilege(${role}, 'public.capture_login()', 'execute') as ok`
    check(`${role} holds no EXECUTE on the trigger function`, r[0]?.ok === false)
  }

  // -------------------------------------------------------------------------
  console.log('\n[7] FK actions and the row-coherence CHECK')
  // DIVERGES from both existing logs deliberately: they use `on delete set null`
  // so an oversight log outlives what it describes. An engagement row naming
  // nobody is unattributable and worthless, and account erasure should take it.
  // Asserted explicitly so the divergence is a decision on the record, not drift.
  const cons = await sql`
    select c.relname as tbl, con.conname, con.contype, con.confdeltype,
           pg_get_constraintdef(con.oid) as def
    from pg_constraint con join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ${sql(TABLES)}`
  check('CONTROL: the constraint read returns rows', cons.length > 0, `${cons.length}`)
  const fks = cons.filter((r) => r.contype === 'f')
  check('CONTROL: both tables have a foreign key to check', fks.length >= 2, `${fks.length} FKs`)
  check('EVERY foreign key is ON DELETE CASCADE (account erasure takes the history)',
    fks.every((r) => r.confdeltype === 'c'),
    JSON.stringify(fks.map((r) => `${r.tbl}.${r.conname}=${r.confdeltype}`)))
  check('the login_rollup coherence CHECK is present',
    cons.some((r) => r.conname === 'login_rollup_coherent'))

  // -------------------------------------------------------------------------
  console.log('\n[8] The backfill landed, and capture is actually working on PROD')
  // docs/17 §10 point 3: the control that matters most, because an empty
  // engagement table is indistinguishable from "nobody uses the platform".
  const state = await sql`
    select (select count(*)::int from auth.users)                                       as users,
           (select count(*)::int from auth.users where last_sign_in_at is not null)      as ever_signed_in,
           (select count(*)::int from public.login_rollup)                               as rollup_rows,
           (select count(*)::int from public.login_rollup where observed_logins > 0)     as observed_rows,
           (select count(*)::int from public.login_events)                               as events,
           (select max(occurred_at) from public.login_events)                            as newest_event`
  const s = state[0]!
  check('the backfill wrote one rollup row per user who had ever signed in',
    Number(s.rollup_rows) >= Number(s.ever_signed_in),
    `rollup=${s.rollup_rows} ever_signed_in=${s.ever_signed_in} users=${s.users}`)
  console.log(`        raw events captured since deploy: ${s.events}`)
  console.log(`        rows with an OBSERVED login (i.e. a real post-deploy sign-in): ${s.observed_rows}`)
  console.log(`        newest captured login: ${s.newest_event ?? '<none yet>'}`)
  if (Number(s.events) === 0) {
    console.log('        ^ NOT YET PROVEN ON PROD. Sign in against production as any real user and')
    console.log('          re-run: this number must become non-zero. Until it does, capture is')
    console.log('          UNVERIFIED in the one environment that matters (docs/17 §2, §10 point 3).')
  }
  check('CAPTURE IS PROVEN LIVE ON PROD (at least one real sign-in recorded)',
    Number(s.events) > 0, `${s.events} events`)

  console.log(`\n${pass} passed, ${fail} failed`)
} finally {
  await sql.end()
}
process.exit(fail === 0 ? 0 : 1)
