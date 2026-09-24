// Does the zmanim prefetch sweep behave against a REAL, CURRENTLY-FAILING API?
//
//   pnpm exec tsx scripts/verify-zmanim-prefetch.mts
//
// This is the one behaviour that cannot be proved with a mock, because the
// failure mode is specific and nasty: myzmanim answers an unauthorized key with
// HTTP 200, no error status, and a FULL skeleton of '0001-01-01' sentinel
// values. A sweep that trusted the HTTP status would write 365 poisoned rows per
// location, and the read-through would then serve them forever without ever
// calling the API again — silent in both directions, since pages still render
// and the cache looks full (docs/23 section 5).
//
// So this runs the actual job against the actual API and asserts the cache stays
// EMPTY while the log fills with failures. Right now our key is unauthorized,
// which makes this the perfect moment to prove it.
//
// It mutates local state (the switch, the log) and RESTORES it in a finally.
// LOCAL ONLY — it refuses to run against a pooler host.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { runZmanimPrefetch } from '../apps/worker/src/jobs/zmanim-prefetch'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

// Credentials live in the web app's env locally; the job reads them from
// process.env, so load them in before it runs.
for (const file of ['apps/web/.env.local', '.env.deploy']) {
  try {
    for (const line of readFileSync(resolve(root, file), 'utf8').split(/\r?\n/)) {
      const m = /^(MYZMANIM_[A-Z_]+)=(.*)$/.exec(line)
      if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  } catch { /* next */ }
}

const url = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
if (url.includes('pooler.supabase.com')) {
  throw new Error('refusing to run: this script mutates state and is LOCAL ONLY')
}

const sql = postgres(url, { max: 1 })

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? '  ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`) }
}

const LOC = 'US11210'
let savedSetting: unknown = null

try {
  console.log('\nZmanim prefetch verification (against the live myzmanim API)\n')

  savedSetting = (await sql`select value from public.platform_settings where key = 'zmanim.prefetch'`)[0]?.value ?? null

  // -----------------------------------------------------------------------
  console.log('[0] CONTROLS — the preconditions every assertion below rests on')
  const locs = await sql<{ n: number }[]>`
    select count(*)::int as n from public.org_modules
    where module_key = 'synagogue-schedules' and enabled
      and coalesce(settings ->> 'myzmanimLocationId', '') <> ''`
  check('at least one org has a myzmanim location configured', (locs[0]?.n ?? 0) > 0,
    `${locs[0]?.n} org(s)`)
  check('MYZMANIM_USER / MYZMANIM_KEY are loaded', !!process.env.MYZMANIM_USER && !!process.env.MYZMANIM_KEY)

  await sql`delete from public.syn_zmanim_fetch_log where location_key = ${LOC}`
  await sql`delete from public.syn_zmanim_cache where location_key = ${LOC}`

  // -----------------------------------------------------------------------
  console.log('\n[1] DISABLED is honoured — the switch is seeded OFF')
  const off = await runZmanimPrefetch(url)
  check('a disabled sweep does not run', off.ran === false && off.reason === 'disabled', JSON.stringify(off))
  const afterOff = await sql<{ n: number }[]>`select count(*)::int as n from public.syn_zmanim_fetch_log`
  check('...and makes no API calls at all', (afterOff[0]?.n ?? 0) === 0, `${afterOff[0]?.n} log rows`)

  // -----------------------------------------------------------------------
  console.log('\n[2] ENABLED against the REAL failing API — the poisoning test')
  await sql`
    update public.platform_settings
    set value = value || ${sql.json({ enabled: true, budgetPerRun: 3 })}
    where key = 'zmanim.prefetch'`

  const run = await runZmanimPrefetch(url, { locationKey: LOC })
  check('the sweep ran', run.ran === true, JSON.stringify(run))
  check('it wrote NOTHING to the cache', run.written === 0, `${run.written} written`)

  const cached = await sql<{ n: number }[]>`
    select count(*)::int as n from public.syn_zmanim_cache where location_key = ${LOC}`
  check('THE POISONING TEST: the cache is still empty after a failed fetch',
    (cached[0]?.n ?? 0) === 0, `${cached[0]?.n} cache row(s)`)

  const logged = await sql<{ n: number; ok_n: number; err: string | null; origin: string }[]>`
    select count(*)::int as n,
           count(*) filter (where ok)::int as ok_n,
           max(err_msg) as err,
           max(origin) as origin
    from public.syn_zmanim_fetch_log where location_key = ${LOC}`
  check('the failure WAS logged (a refused call is still a paid call)',
    (logged[0]?.n ?? 0) > 0, `${logged[0]?.n} row(s)`)
  check('no row claims success', (logged[0]?.ok_n ?? 0) === 0)
  check('the log carries the real API error verbatim',
    (logged[0]?.err ?? '').includes('NotAuthorized'), logged[0]?.err ?? '(none)')
  check("the row is attributed to origin='sweep'", logged[0]?.origin === 'sweep', logged[0]?.origin ?? '-')
  check('it STOPPED after the first failure rather than burning the whole budget',
    (logged[0]?.n ?? 0) === 1, `${logged[0]?.n} call(s) for a budget of 3`)

  // -----------------------------------------------------------------------
  console.log('\n[3] THE 3-DAY BREAKER flips the same switch a human uses')
  await sql`update public.syn_zmanim_fetch_log
            set fetched_at = now() - interval '5 days' where location_key = ${LOC}`

  const tripped = await runZmanimPrefetch(url, { locationKey: LOC })
  check('the sweep refuses to run', tripped.ran === false, JSON.stringify(tripped))
  check('...and says why, in days', (tripped.reason ?? '').includes('auto-paused'), tripped.reason ?? '')

  const nowOff = await sql<{ enabled: string; reason: string }[]>`
    select value ->> 'enabled' as enabled, value ->> 'pausedReason' as reason
    from public.platform_settings where key = 'zmanim.prefetch'`
  check('the SWITCH itself is now off — one switch, one honest state',
    nowOff[0]?.enabled === 'false', `enabled=${nowOff[0]?.enabled}`)
  check('the reason is recorded for the console to show',
    (nowOff[0]?.reason ?? '').includes('auto-paused'), nowOff[0]?.reason ?? '')

  // -----------------------------------------------------------------------
  console.log('\n[4] A MAKER FETCH MUST NOT RESET THE BREAKER (the review finding)')
  await sql`
    insert into public.syn_zmanim_fetch_log (location_key, date, origin, ok)
    values (${LOC}, current_date, 'maker', true)`
  const breaker = await sql<{ naive: number; gated: number }[]>`
    select
      extract(epoch from (now() - (select max(fetched_at) from public.syn_zmanim_fetch_log where ok)))/86400 as naive,
      extract(epoch from (now() - (select max(fetched_at) from public.syn_zmanim_fetch_log where ok and origin='sweep')))/86400 as gated`
  check('a naive "any success" breaker would read HEALTHY and never trip',
    Number(breaker[0]?.naive ?? 99) < 1, `${Number(breaker[0]?.naive ?? 0).toFixed(2)} days`)
  check('the origin-gated breaker still sees the sweep as dead',
    breaker[0]?.gated == null || Number(breaker[0]!.gated) > 3,
    breaker[0]?.gated == null ? 'no sweep success at all' : `${Number(breaker[0]!.gated).toFixed(1)} days`)

  console.log(`\n${pass} checks passed, ${fail} failed`)
} finally {
  // Restore: the switch back to whatever it was, and the scratch rows gone.
  await sql`delete from public.syn_zmanim_fetch_log where location_key = ${LOC}`
  await sql`delete from public.syn_zmanim_cache where location_key = ${LOC}`
  if (savedSetting !== null) {
    await sql`update public.platform_settings set value = ${sql.json(savedSetting as never)}
              where key = 'zmanim.prefetch'`
  }
  await sql.end()
}
process.exit(fail === 0 ? 0 : 1)
