// PROD verification for 20261007090000_account_deletion.sql (docs/21 §7).
//
//   pnpm exec tsx scripts/prod-verify-account-deletion.mts
//   pnpm exec tsx scripts/prod-verify-account-deletion.mts --local
//
// Read-only (selects only). No app credentials: the session pooler with
// SUPABASE_DB_PASSWORD from .env.deploy, same as prod-verify-20261007.mts.
//
// WHY NOT prod-verify-migration.ts ALONE: it is FUNCTION-ONLY. This migration
// also adds a table, its policy and ACL, a pg_cron job and the extension
// itself, none of which it can see. Run both.
//
// STRUCTURAL ON PROD, BEHAVIOURAL LOCALLY, and that is stated rather than
// hidden: proving the silhouette on prod means deleting a real account, which
// is never done to verify a migration. The behaviour is proven by
// packages/db/src/account-deletion.test.ts against local; this script proves
// prod has the SAME OBJECTS, with the same bodies and ACLs, that ran there.
//
// THE ONE BEHAVIOURAL CHECK THAT DOES RUN ON PROD is §[6]: whether pg_cron has
// actually executed the job and whether that run succeeded. Right after the
// migration it is "not yet run" (a WARN, not a fail); from the day after, a
// missing or failed run is a real FAIL, because prod has no other runner.
//
// RUN IT BEFORE AND AFTER migrate:prod — pre-apply it should FAIL the
// migration sections and PASS every CONTROL.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const local = process.argv.includes('--local')

const sql = local
  ? postgres(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres', { max: 1 })
  : (() => {
      const env = readFileSync(resolve(root, '.env.deploy'), 'utf8')
      const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''
      const ref = get('SUPABASE_PROJECT_REF')
      const pw = get('SUPABASE_DB_PASSWORD')
      if (!ref || !pw) throw new Error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD in .env.deploy')
      return postgres(
        `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`,
        { ssl: 'require', max: 1 },
      )
    })()

let pass = 0
let fail = 0
let warn = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`) }
}
const note = (name: string, detail = '') => { warn++; console.log(`  WARN  ${name} ${detail}`) }

const canExec = async (role: string, sig: string) =>
  (await sql<{ ok: boolean | null }[]>`
    select case when to_regprocedure(${sig}) is null then null
                else has_function_privilege(${role}, ${sig}, 'execute') end as ok`)[0]!.ok
// Bodies may come from either file: 20261008020000 (remove from platform)
// restates five of these functions.
const migrationText = ['20261007090000_account_deletion.sql', '20261008020000_account_remove_from_platform.sql']
  .map((f) => readFileSync(resolve(root, 'supabase/migrations', f), 'utf8'))
  .join('\n')

const INTERNAL = [
  'public.account_pending_departure(uuid)',
  'public.account_has_left(uuid)',
  'public.account_deletion_blockers(uuid)',
  'public.account_begin_departure(uuid, text, uuid)',
  'public.account_silhouette(uuid)',
  'public.account_complete_due_deletions()',
]
const CALLABLE = [
  'public.account_request_deletion(text)',
  'public.account_my_deletion_blockers()',
  'public.account_deletion_resume()',
  'public.account_request_deletion_for_email(text)',
  'public.account_cancel_deletion(uuid)',
  'public.account_remove_from_platform(text, text, text)',
  'public.account_lift_signup_block(uuid, text)',
  'public.account_signup_blocks_list()',
  'public.account_signup_block_lookup(text)',
  'public.sd_my_departed_interests(uuid)',
  'public.account_deletion_runner_status()',
  'public.former_members(uuid[])',
  'public.sd_my_departed_matches(uuid)',
]

try {
  console.log(`\nVerification — 20261007090000 account deletion. Target: ${local ? 'LOCAL' : 'PRODUCTION'}\n`)

  console.log('[0] Controls: the catalog reads work at all')
  const nFn = (await sql<{ n: number }[]>`
    select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`)[0]!.n
  check('CONTROL: public functions are visible', nFn > 50, `${nFn}`)
  const nUsers = (await sql<{ n: number }[]>`select count(*)::int as n from auth.users`)[0]!.n
  check('CONTROL: auth.users is readable', nUsers > 0, `${nUsers}`)
  check('CONTROL: an existing function reads as executable by authenticated',
    (await canExec('authenticated', 'public.is_superadmin()')) === true)
  const [ver] = await sql<{ version: string }[]>`
    select version from supabase_migrations.schema_migrations where version = '20261007090000'`
  check('20261007090000 recorded in schema_migrations', !!ver)

  console.log('\n[1] The table, its ACL and its one policy')
  const [tbl] = await sql<{ rls: boolean }[]>`
    select relrowsecurity as rls from pg_class where oid = to_regclass('public.account_deletions')`
  check('account_deletions exists with RLS enabled', tbl?.rls === true)
  if (tbl) {
    const priv = async (role: string, p: string) =>
      (await sql<{ ok: boolean }[]>`select has_table_privilege(${role}, 'public.account_deletions', ${p}) as ok`)[0]!.ok
    check('anon holds nothing on account_deletions', !(await priv('anon', 'select')) && !(await priv('anon', 'insert')))
    check('authenticated may SELECT', await priv('authenticated', 'select'))
    check('authenticated may NOT insert/update/delete (writes are definers only)',
      !(await priv('authenticated', 'insert')) && !(await priv('authenticated', 'update')) && !(await priv('authenticated', 'delete')))
    check('service_role holds nothing (the worker has no business here)',
      !(await priv('service_role', 'select')) && !(await priv('service_role', 'update')))
    const pols = await sql<{ polname: string; cmd: string; qual: string }[]>`
      select polname, polcmd::text as cmd, pg_get_expr(polqual, polrelid) as qual
      from pg_policy where polrelid = 'public.account_deletions'::regclass`
    check('exactly one policy, SELECT, own row or superadmin',
      pols.length === 1 && pols[0]!.cmd === 'r' && /user_id = auth\.uid\(\)/.test(pols[0]!.qual) && /is_superadmin\(\)/.test(pols[0]!.qual),
      JSON.stringify(pols))
  }

  console.log('\n[2] Function ACLs — internal helpers callable by NO api role')
  for (const sig of INTERNAL) {
    const exists = (await canExec('postgres', sig)) !== null
    check(`${sig} exists`, exists)
    if (!exists) continue
    for (const role of ['anon', 'authenticated', 'service_role']) {
      check(`  ${role} cannot execute it`, (await canExec(role, sig)) === false)
    }
  }

  console.log('\n[3] Function ACLs — entry points callable by authenticated ONLY')
  for (const sig of CALLABLE) {
    const exists = (await canExec('postgres', sig)) !== null
    check(`${sig} exists`, exists)
    if (!exists) continue
    check(`  authenticated can execute it`, (await canExec('authenticated', sig)) === true)
    check(`  anon cannot`, (await canExec('anon', sig)) === false)
    check(`  service_role cannot`, (await canExec('service_role', sig)) === false)
  }

  console.log('\n[4] Deployed bodies carry the reviewed properties')
  const body = async (name: string) =>
    (await sql<{ src: string; secdef: boolean; cfg: string[] | null }[]>`
      select p.prosrc as src, p.prosecdef as secdef, p.proconfig as cfg
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = ${name}`)[0]
  const job = await body('account_complete_due_deletions')
  check('completion job refuses any caller with a session', !!job && /auth\.uid\(\) is not null/.test(job.src))
  const fm = await body('former_members')
  check('former_members is bounded to former co-members (not an oracle)', !!fm && /former_org_ids/.test(fm.src))
  const bl = await body('account_deletion_blockers')
  check('blockers ignore a co-admin who is also leaving', !!bl && /account_pending_departure\(other\.user_id\)/.test(bl.src))
  const pin = await body('sd_pin_participant')
  check('sd_pin_participant has the no-session bypass', !!pin && /if auth\.uid\(\) is null then\s+return new;/.test(pin.src))
  for (const name of ['account_silhouette', 'account_complete_due_deletions', 'former_members', 'account_request_deletion']) {
    const b = await body(name)
    check(`${name} is SECURITY DEFINER with a pinned search_path`,
      !!b && b.secdef && (b.cfg ?? []).some((c) => c.startsWith('search_path=')))
    // Body drift: the deployed body must appear verbatim in the migration file.
    check(`${name} deployed body matches the migration file`, !!b && migrationText.includes(b.src.trim().slice(0, 400)))
  }

  // 20261008020000 — remove from platform.
  const via = (await sql<{ d: string | null }[]>`
    select pg_get_constraintdef(oid) as d from pg_constraint
    where conrelid = 'public.account_deletions'::regclass and conname = 'account_deletions_initiated_via_check'`)[0]?.d ?? ''
  check('removal: initiated_via allows removal', via.includes("'removal'"), via)
  const removalOptOut = await Promise.all(
    ['account_pending_departure', 'account_deletion_resume', 'account_complete_due_deletions', 'account_begin_departure']
      .map(async (n) => [n, (await body(n))?.src.includes('(20261008020000)') ?? false] as const),
  )
  for (const [n, ok] of removalOptOut) check(`removal: ${n} carries the removal guard`, ok)
  const cancel = await body('account_cancel_deletion')
  check('removal: cancelling a removal lifts the ban', !!cancel && cancel.src.includes('banned_until = null'))
  const rem = await body('account_remove_from_platform')
  check('removal: it bans at once and deletes sessions and refresh tokens',
    !!rem && rem.src.includes("banned_until = now() + interval '100 years'") &&
      rem.src.includes('delete from auth.sessions') && rem.src.includes('delete from auth.refresh_tokens'))

  // 20261009020000 — re-signup blocks.
  check('blocks: removal records a block', !!rem && rem.src.includes('insert into public.account_signup_blocks'))
  check('blocks: the reason-less removal is gone',
    (await sql<{ p: string | null }[]>`select to_regprocedure('public.account_remove_from_platform(text)')::text as p`)[0]!.p === null)
  const guard = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_trigger
    where tgrelid = 'auth.users'::regclass and tgname = 'account_signup_block_guard' and tgenabled <> 'D'`
  check('blocks: the auth.users guard trigger is BOUND and enabled', guard[0]!.n === 1)
  for (const t of ['account_signup_blocks', 'account_signup_block_lookups']) {
    const g = await sql<{ any: boolean }[]>`
      select bool_or(has_table_privilege(r, ${'public.' + t}, 'select')) as any
      from unnest(array['anon', 'authenticated', 'service_role']) r
      where to_regclass(${'public.' + t}) is not null`
    check(`blocks: no api role can read ${t}`, g[0]?.any === false, JSON.stringify(g))
  }
  check('blocks: the signup hook is callable by GoTrue', await canExec('supabase_auth_admin', 'public.auth_before_user_created(jsonb)'))
  check('blocks: the signup hook is NOT callable by authenticated (no oracle)',
    !(await canExec('authenticated', 'public.auth_before_user_created(jsonb)')))
  console.log('  NOTE  the Before User Created hook must ALSO be switched on in the dashboard (Authentication → Hooks);')
  console.log('        this script cannot read auth config. Without it the trigger still refuses, with a generic error.')

  console.log('\n[5] The schedule')
  const [ext] = await sql<{ v: string }[]>`select extversion as v from pg_extension where extname = 'pg_cron'`
  check('pg_cron is installed', !!ext, ext?.v ?? '')
  if (ext) {
    const jobs = await sql<{ schedule: string; command: string; active: boolean; username: string }[]>`
      select schedule, command, active, username from cron.job where jobname = 'account-deletions-complete-due'`
    check('exactly one job named account-deletions-complete-due', jobs.length === 1, `${jobs.length}`)
    const j = jobs[0]
    check('  it is active', j?.active === true)
    check('  it runs daily', j?.schedule === '17 3 * * *', j?.schedule ?? '')
    check('  it calls the completion function and nothing else',
      j?.command.trim() === 'select public.account_complete_due_deletions()', j?.command ?? '')
    check('  it runs as postgres (no JWT, so the guards see the trusted backend)', j?.username === 'postgres', j?.username ?? '')
  }

  console.log('\n[6] Has the job actually RUN on this database?')
  if (ext) {
    const runs = await sql<{ status: string; start_time: Date; return_message: string | null }[]>`
      select d.status, d.start_time, d.return_message
      from cron.job_run_details d join cron.job j on j.jobid = d.jobid
      where j.jobname = 'account-deletions-complete-due'
      order by d.start_time desc limit 1`
    if (runs.length === 0) {
      note('the job has not run yet', '(expected only on the day of the migration — re-run tomorrow)')
    } else {
      const r = runs[0]!
      const ageH = (Date.now() - r.start_time.getTime()) / 3600_000
      check('the most recent run succeeded', r.status === 'succeeded', `${r.status}: ${r.return_message ?? ''}`)
      check('the most recent run is under ~2 days old', ageH < 50, `${ageH.toFixed(1)}h`)
    }
  }

  console.log('\n[7] Live data (informational)')
  if (tbl) {
    const rows = await sql<{ state: string; n: number; failing: number }[]>`
      select state, count(*)::int as n, count(*) filter (where last_error is not null)::int as failing
      from account_deletions group by state order by state`
    if (rows.length === 0) console.log('  INFO  no deletion requests yet')
    for (const r of rows) {
      console.log(`  INFO  ${r.state}: ${r.n}${r.failing ? ` (${r.failing} failing)` : ''}`)
      if (r.failing) note(`${r.failing} pending deletion(s) are failing`, '— see /console/accounts')
    }
    const overdue = (await sql<{ n: number }[]>`
      select count(*)::int as n from account_deletions where state = 'departed' and due_at < now() - interval '2 days'`)[0]!.n
    check('no pending deletion is more than 2 days overdue', overdue === 0, `${overdue}`)
  }
} finally {
  await sql.end()
}

console.log(`\n${pass} passed, ${fail} failed, ${warn} warnings\n`)
process.exit(fail > 0 ? 1 : 0)
