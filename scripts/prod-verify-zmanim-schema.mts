// Prod verification for `20260923010000_zmanim_cache_and_platform_settings.sql`.
//
//   pnpm exec tsx scripts/prod-verify-zmanim-schema.mts
//   pnpm exec tsx scripts/prod-verify-zmanim-schema.mts --local
//
// WHY THIS FILE EXISTS. `prod-verify-migration.ts` parses `create function`
// blocks only. This migration is mostly TABLES, GRANTS, POLICIES and a seeded
// row, so a function-only run would report "0 failures" while asserting nothing
// about any of it — the vacuity trap docs/03 names. Copied from
// `prod-verify-superadmin-log.mts`, the worked template for table work.
//
// EVERY ASSERTION CARRIES A CONTROL: a catalog query returning zero rows looks
// exactly like "the thing is absent", so each negative is paired with a positive
// that proves the query can see anything at all.
//
// READ-ONLY: every statement is a SELECT (plus one GET to the Vercel API in
// section [7], which reads env var NAMES only, never values).
//
// HARMLESS NOISE ON WINDOWS: after the final line this may print
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING) ... async.c`. That is
// Node tearing down an undici keepalive socket during process.exit, it happens
// AFTER every check has run and printed, and the exit code is still correct
// (measured). Do not read it as a failure.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const env = readFileSync(resolve(root, '.env.deploy'), 'utf8')
const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''

const LOCAL = process.argv.includes('--local')
let ref = '(local)'
let sql: ReturnType<typeof postgres>
if (LOCAL) {
  sql = postgres(process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres', { max: 1 })
} else {
  ref = get('SUPABASE_PROJECT_REF')
  const pw = get('SUPABASE_DB_PASSWORD')
  if (!ref || !pw) throw new Error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD in .env.deploy')
  sql = postgres(
    `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`,
    { ssl: 'require', max: 1 },
  )
}

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? '  ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`) }
}
const priv = async (role: string, table: string, p: string) =>
  (await sql<{ p: boolean }[]>`select has_table_privilege(${role}, ${table}, ${p}) as p`)[0]!.p

console.log(`\nProd verification — zmanim cache + platform settings  (project ${ref})\n`)

try {
  // -------------------------------------------------------------------------
  console.log('[1] the cache column rename (founder decision 1: STORE RAW)')
  const cols = await sql<{ column_name: string }[]>`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'syn_zmanim_cache'`
  const names = cols.map((c) => c.column_name)
  check('CONTROL: syn_zmanim_cache is readable and has columns', names.length > 0, names.join(', '))
  check('`payload` exists', names.includes('payload'))
  check('`times` is gone', !names.includes('times'))

  // -------------------------------------------------------------------------
  console.log('\n[2] platform_settings — superadmin-only, every verb')
  const tables = await sql<{ relname: string; relrowsecurity: boolean }[]>`
    select c.relname, c.relrowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('platform_settings', 'syn_zmanim_fetch_log')`
  check('CONTROL: both new tables exist', tables.length === 2, tables.map((t) => t.relname).join(', '))
  check('platform_settings has RLS ENABLED',
    tables.find((t) => t.relname === 'platform_settings')?.relrowsecurity === true)

  const pol = await sql<{ polname: string; cmd: string; qual: string | null; withcheck: string | null }[]>`
    select p.polname, p.polcmd::text as cmd,
           pg_get_expr(p.polqual, p.polrelid) as qual,
           pg_get_expr(p.polwithcheck, p.polrelid) as withcheck
    from pg_policy p where p.polrelid = 'public.platform_settings'::regclass`
  check('exactly one policy, covering ALL verbs', pol.length === 1 && pol[0]?.cmd === '*',
    pol.map((p) => `${p.polname}:${p.cmd}`).join(', '))
  check('its USING is is_superadmin()', (pol[0]?.qual ?? '').includes('is_superadmin'), pol[0]?.qual ?? '-')
  check('its WITH CHECK is is_superadmin() too — or an ordinary user could INSERT',
    (pol[0]?.withcheck ?? '').includes('is_superadmin'), pol[0]?.withcheck ?? '(none)')

  check('anon holds NOTHING on platform_settings', !(await priv('anon', 'public.platform_settings', 'select')))
  // authenticated legitimately holds the verbs; RLS is what restricts it, and
  // that dependency is why the policy above is asserted so carefully.
  check('CONTROL: authenticated DOES hold select (RLS is the gate, not the grant)',
    await priv('authenticated', 'public.platform_settings', 'select'))

  // -------------------------------------------------------------------------
  console.log('\n[3] syn_zmanim_fetch_log — append-only BY GRANT, superadmin reads')
  for (const role of ['authenticated', 'service_role', 'anon']) {
    for (const verb of ['update', 'delete', 'truncate']) {
      check(`${role} cannot ${verb} the log`, !(await priv(role, 'public.syn_zmanim_fetch_log', verb)))
    }
  }
  check('anon cannot even read it', !(await priv('anon', 'public.syn_zmanim_fetch_log', 'select')))
  check('CONTROL: service_role CAN insert (the worker writes the log)',
    await priv('service_role', 'public.syn_zmanim_fetch_log', 'insert'))
  check('authenticated cannot insert', !(await priv('authenticated', 'public.syn_zmanim_fetch_log', 'insert')))

  const origin = await sql<{ is_nullable: string }[]>`
    select is_nullable from information_schema.columns
    where table_schema = 'public' and table_name = 'syn_zmanim_fetch_log' and column_name = 'origin'`
  check('`origin` exists and is NOT NULL — the breaker depends on it',
    origin[0]?.is_nullable === 'NO', origin[0]?.is_nullable ?? 'missing')

  // -------------------------------------------------------------------------
  console.log('\n[4] the seeded switch — OFF, and readable the safe way')
  const setting = await sql<{ enabled: string | null; pause: string | null; horizon: string | null }[]>`
    select value ->> 'enabled' as enabled,
           value ->> 'pauseAfterDays' as pause,
           value ->> 'horizonDays' as horizon
    from public.platform_settings where key = 'zmanim.prefetch'`
  check('the zmanim.prefetch row exists', setting.length === 1)
  check('it is seeded OFF — a sweep defaulting ON would hammer the API from deploy',
    setting[0]?.enabled === 'false', `enabled=${setting[0]?.enabled}`)
  check('the founder-configurable knobs are present',
    setting[0]?.pause === '3' && !!setting[0]?.horizon,
    `pauseAfterDays=${setting[0]?.pause} horizonDays=${setting[0]?.horizon}`)

  // -------------------------------------------------------------------------
  console.log('\n[5] the two functions')
  const fns = await sql<{ proname: string; prosecdef: boolean; proconfig: string[] | null; proacl: string | null }[]>`
    select p.proname, p.prosecdef, p.proconfig, p.proacl::text as proacl
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('syn_zmanim_cached', 'platform_setting_merge')`
  check('CONTROL: both functions exist', fns.length === 2, fns.map((f) => f.proname).join(', '))
  for (const f of fns) {
    check(`${f.proname} is SECURITY DEFINER`, f.prosecdef === true)
    check(`${f.proname} pins search_path`, (f.proconfig ?? []).includes('search_path=public'))
  }
  const cached = fns.find((f) => f.proname === 'syn_zmanim_cached')
  check('syn_zmanim_cached IS callable by anon (the public viewer is anonymous by design)',
    (cached?.proacl ?? '').includes('anon=X/'), cached?.proacl ?? '-')
  const merge = fns.find((f) => f.proname === 'platform_setting_merge')
  check('platform_setting_merge is NOT callable by anon',
    !(merge?.proacl ?? '').includes('anon=X/'), merge?.proacl ?? '-')

  // -------------------------------------------------------------------------
  console.log('\n[6] LIVE DATA — can production actually serve a week from cache?')
  const held = await sql<{ location_key: string; n: number; lo: string; hi: string }[]>`
    select location_key, count(*)::int as n,
           to_char(min(date), 'YYYY-MM-DD') as lo, to_char(max(date), 'YYYY-MM-DD') as hi
    from public.syn_zmanim_cache where source = 'myzmanim'
    group by location_key order by location_key`
  if (held.length === 0) {
    console.log('      cache is EMPTY — this section is VACUOUS and proves nothing about serving.')
  } else {
    for (const h of held) console.log(`      ${h.location_key}: ${h.n} days, ${h.lo} .. ${h.hi}`)
    check('every configured location has a populated cache',
      (await sql<{ missing: number }[]>`
        select count(*)::int as missing from (
          select distinct settings ->> 'myzmanimLocationId' as loc
          from public.org_modules
          where module_key = 'synagogue-schedules' and enabled
            and coalesce(settings ->> 'myzmanimLocationId', '') <> ''
        ) l
        where not exists (
          select 1 from public.syn_zmanim_cache c
          where c.location_key = l.loc and c.source = 'myzmanim')`)[0]!.missing === 0)

    // The definer is the ONLY read path the app has, so exercise it rather than
    // the table — a populated table nobody can read through is not "working".
    const loc = held[0]!.location_key
    const week = await sql<{ n: number }[]>`
      select count(*)::int as n from public.syn_zmanim_cached(${loc}, ${held[0]!.lo}::date, (${held[0]!.lo}::date + 6))`
    check('the definer returns a full week for a cached location', (week[0]?.n ?? 0) === 7,
      `${week[0]?.n} of 7 days`)

    // THE CLAIM WORTH CHECKING: with a year cached, production renders real
    // zmanim WITHOUT any myzmanim credentials at all.
    const horizon = await sql<{ days: number }[]>`
      select (max(date) - current_date)::int as days
      from public.syn_zmanim_cache where source = 'myzmanim'`
    check('the cache reaches far enough forward that no API call is needed for a year',
      (horizon[0]?.days ?? 0) > 300, `${horizon[0]?.days} days of headroom`)
  }

  // -------------------------------------------------------------------------
  // [7] GO-LIVE READINESS — what is still between here and "fully live"?
  //
  // Reported rather than asserted: none of this is a FAILURE today, because the
  // deliberate position is that production runs from cache with no credential
  // (docs/23 §7). The point is that when a paid plan arrives, the remaining
  // steps are visible and few.
  if (!LOCAL) {
    console.log('\n[7] GO-LIVE READINESS (reported, not asserted)')
    const token = get('VERCEL_TOKEN')
    const project = get('VERCEL_PROJECT_ID') || 'prj_reUQNNvf0XcjS6YcRGEYRXBC8XYM'
    let vercelKeys: string[] | null = null
    if (token) {
      try {
        const res = await fetch(`https://api.vercel.com/v9/projects/${project}/env`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        const body = (await res.json()) as { envs?: { key: string }[]; error?: { message: string } }
        vercelKeys = body.error ? null : (body.envs ?? []).map((e) => e.key)
      } catch { vercelKeys = null }
    }

    const hasCreds = !!vercelKeys?.includes('MYZMANIM_USER') && !!vercelKeys?.includes('MYZMANIM_KEY')
    const enabled = setting[0]?.enabled === 'true'
    const cacheDays = held[0]?.n ?? 0

    console.log(`      schema on production .................. yes (verified above)`)
    console.log(`      cache populated ...................... ${cacheDays > 0 ? `yes (${cacheDays} days)` : 'NO'}`)
    console.log(`      myzmanim creds in Vercel ............. ${vercelKeys === null ? 'UNKNOWN (no VERCEL_TOKEN)' : hasCreds ? 'yes' : 'no'}`)
    console.log(`      prefetch switch ...................... ${enabled ? 'ON' : 'OFF'}`)
    console.log('')
    if (!hasCreds && cacheDays > 0) {
      console.log('      => Production serves real zmanim FROM CACHE with no credential.')
      console.log('         That is the intended state while the account is on trial.')
    }
    if (!hasCreds) {
      console.log('      => WHEN A PAID PLAN EXISTS, to go fully live:')
      console.log('         1. Add MYZMANIM_USER and MYZMANIM_KEY to Vercel (production),')
      console.log('            then redeploy. Only needed so a cache MISS can fall back to')
      console.log('            the API — with a warm cache the pages never call it.')
      console.log('         2. Turn the prefetch switch on, so the rolling horizon is')
      console.log('            topped up: select public.platform_setting_merge(')
      console.log(`              'zmanim.prefetch', '{"enabled":true}'::jsonb);`)
      console.log('            (as a superadmin — or from the console screen once built)')
      console.log('         3. Make sure the worker RUNS (docs/23 §7): prod has no')
      console.log('            continuously-running worker, so the nightly sweep fires only')
      console.log('            while `pnpm worker:prod` is up. Until then, top up with')
      console.log('            `pnpm exec tsx scripts/zmanim-backfill.mts --to-prod`.')
    }
  }

  console.log(`\n${pass} checks passed, ${fail} failed`)
} finally {
  await sql.end()
}
process.exit(fail === 0 ? 0 : 1)
