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
import { createClient } from '@supabase/supabase-js'
import { buildWeekWithProvenance, zmanimCacheReader } from '../modules/synagogue-schedules/src/myzmanim'

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
  // THE POISONING TEST, forced rather than borrowed.
  //
  // This used to depend on OUR key being broken, which meant it passed for a
  // reason that had nothing to do with the code — and it stopped working the
  // moment a valid key arrived (2026-09-24). The failure is now INDUCED with a
  // deliberately invalid key, so the assertion is permanent and independent of
  // account state. The lesson generalises: a test that passes because the
  // environment happens to be broken is not a test of anything.
  console.log('\n[2] POISONING TEST — an induced failure must write NOTHING')
  await sql`
    update public.platform_settings
    set value = value || ${sql.json({ enabled: true, budgetPerRun: 3 })}
    where key = 'zmanim.prefetch'`

  const realKey = process.env.MYZMANIM_KEY
  process.env.MYZMANIM_KEY = 'deliberately-invalid-key-for-this-test'
  const run = await runZmanimPrefetch(url, { locationKey: LOC })
  process.env.MYZMANIM_KEY = realKey

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
  // [2b] THE HAPPY PATH — only assertable since a working key arrived
  //      (2026-09-24). Makes a small number of REAL calls.
  console.log('\n[2b] HAPPY PATH — a real fetch fills the cache with real data')
  await sql`delete from public.syn_zmanim_fetch_log where location_key = ${LOC}`

  const good = await runZmanimPrefetch(url, { locationKey: LOC, budgetOverride: 2 })
  check('the sweep wrote rows', good.written === 2, `${good.written} written, ${good.failed} failed`)

  const stored = await sql<{ n: number; zman_fields: number; src: string }[]>`
    select count(*)::int as n,
           min((select count(*) from jsonb_object_keys(payload -> 'Zman')))::int as zman_fields,
           max(source) as src
    from public.syn_zmanim_cache where location_key = ${LOC}`
  check('the cache now holds real rows', (stored[0]?.n ?? 0) === 2, `${stored[0]?.n} row(s)`)
  check("they are tagged source='myzmanim'", stored[0]?.src === 'myzmanim', stored[0]?.src ?? '-')
  check('each payload is the WHOLE response, not a parsed subset (founder decision 1)',
    (stored[0]?.zman_fields ?? 0) > 50, `${stored[0]?.zman_fields} Zman fields stored`)

  const sections = await sql<{ has_place: boolean; has_time: boolean }[]>`
    select (payload ? 'Place') as has_place, (payload ? 'Time') as has_time
    from public.syn_zmanim_cache where location_key = ${LOC} limit 1`
  check('Place and Time were kept too — the sections the connector used to discard',
    sections[0]?.has_place === true && sections[0]?.has_time === true,
    `Place=${sections[0]?.has_place} Time=${sections[0]?.has_time}`)

  // Gap-fill correctness: the dates just written must now count as covered, so
  // a second run advances instead of paying for the same days again.
  const second = await runZmanimPrefetch(url, { locationKey: LOC, budgetOverride: 2 })
  const afterTwo = await sql<{ n: number }[]>`
    select count(*)::int as n from public.syn_zmanim_cache where location_key = ${LOC}`
  check('a second run fills the NEXT gaps rather than refetching the same dates',
    (afterTwo[0]?.n ?? 0) === 4 && second.written === 2,
    `${afterTwo[0]?.n} rows after two runs of 2 (second wrote ${second.written})`)

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

  // -----------------------------------------------------------------------
  // [5] END TO END — the question "will a credential change be all it takes?"
  //
  // Everything above tests the WRITE side. This tests the READ side through the
  // exact path a page uses: the definer, the reader, and buildWeek. The API is
  // stubbed to THROW, so if any day resolves from the network instead of the
  // cache the assertion fails loudly rather than passing on a live call.
  console.log('\n[5] END TO END — a page serves the cached week with ZERO API calls')

  const webEnv = (() => {
    for (const f of ['apps/web/.env.local', '.env']) {
      try { return readFileSync(resolve(root, f), 'utf8') } catch { /* next */ }
    }
    return ''
  })()
  const envGet = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(webEnv)?.[1]?.trim() ?? ''
  const supaUrl = envGet('NEXT_PUBLIC_SUPABASE_URL') || envGet('SUPABASE_URL') || 'http://127.0.0.1:54321'
  const supaKey = envGet('SUPABASE_SERVICE_ROLE_KEY') || envGet('NEXT_PUBLIC_SUPABASE_ANON_KEY') || envGet('SUPABASE_ANON_KEY')

  if (!supaKey) {
    check('CONTROL: a Supabase key is available for the end-to-end check', false, 'none found')
  } else {
    // A FULLY warm week is the claim worth testing ("zero API calls"), and the
    // sweep cannot produce one on demand: it fills forward from today, so the
    // week containing its first row always has past days it will never reach.
    //
    // So one REAL payload is copied across a future week. That is not a
    // shortcut around the thing under test — section [2b] already proved the
    // WRITE path against the live API; this section tests the READ path, and a
    // genuine payload replayed over seven dates exercises it exactly.
    const sample = await sql<{ payload: unknown }[]>`
      select payload from public.syn_zmanim_cache
      where location_key = ${LOC} and source = 'myzmanim' limit 1`
    check('CONTROL: a real payload exists to read back', !!sample[0]?.payload)

    if (sample[0]?.payload) {
      // A Sunday comfortably in the future, so nothing collides with [2b].
      const sun = new Date()
      sun.setDate(sun.getDate() + 60)
      sun.setDate(sun.getDate() - sun.getDay())
      const sundayISO = sun.toISOString().slice(0, 10)

      for (let i = 0; i < 7; i++) {
        const day = new Date(`${sundayISO}T12:00:00`)
        day.setDate(day.getDate() + i)
        await sql`
          insert into public.syn_zmanim_cache (location_key, date, source, payload)
          values (${LOC}, ${day.toISOString().slice(0, 10)}, 'myzmanim', ${sql.json(sample[0]!.payload as never)})
          on conflict (location_key, date, source) do nothing`
      }

      const client = createClient(supaUrl, supaKey, { auth: { persistSession: false } })

      const realFetch = globalThis.fetch
      let apiCalls = 0
      globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
        const target = String(args[0])
        if (target.includes('myzmanim')) { apiCalls++; throw new Error('the page reached the API') }
        return realFetch(...args)
      }) as typeof fetch

      let provenance: Record<string, string> = {}
      try {
        const res = await buildWeekWithProvenance(sundayISO, {
          latitude: 40.7128, longitude: -73.9497, timeZone: 'America/New_York',
          myzmanimLocationId: LOC,
          credentials: { user: process.env.MYZMANIM_USER ?? '', key: process.env.MYZMANIM_KEY ?? '' },
          cache: zmanimCacheReader(client),
        })
        provenance = res.provenance
      } finally {
        globalThis.fetch = realFetch
      }

      const sources = Object.values(provenance)
      check('ALL SEVEN days served FROM CACHE', sources.every((v) => v === 'cache'),
        JSON.stringify(provenance))
      check('THE CLAIM: a fully warm week costs ZERO API calls', apiCalls === 0,
        `${apiCalls} call(s) — this page used to make 7`)

      // NON-VACUITY: the reader must not simply answer everything. A week it was
      // NOT given must resolve some other way, or the assertion above would pass
      // for a reader that returns a hit for any date at all.
      const far = new Date()
      far.setDate(far.getDate() + 300)
      far.setDate(far.getDate() - far.getDay())
      const cold = await buildWeekWithProvenance(far.toISOString().slice(0, 10), {
        latitude: 40.7128, longitude: -73.9497, timeZone: 'America/New_York',
        myzmanimLocationId: LOC, credentials: null,
        cache: zmanimCacheReader(client),
      })
      check('CONTROL: an UNFILLED week is not reported as cached',
        Object.values(cold.provenance).every((v) => v !== 'cache'),
        JSON.stringify(Object.values(cold.provenance).slice(0, 3)))
    }
  }

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
