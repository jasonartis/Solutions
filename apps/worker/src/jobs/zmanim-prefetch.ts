import postgres from 'postgres'
import {
  myzmanimCredsFromEnv,
  parseZmanim,
  requestMyzmanimDay,
} from '../../../../modules/synagogue-schedules/src/myzmanim'

// synagogue.zmanim-prefetch — keeps a rolling one-year window of myzmanim
// responses in `syn_zmanim_cache`, so a schedule render costs zero API calls.
// Design and the founder's decisions: docs/23.
//
// WHY A DIRECT CONNECTION RATHER THAN THE SERVICE-ROLE CLIENT. The gap query is
// a `generate_series` LEFT JOIN anti-join, which PostgREST cannot express; the
// same pattern as `login-events-prune`, which also takes a connection string.
//
// WHAT ONE RUN DOES
//   1. read the switch (`platform_settings` -> 'zmanim.prefetch')
//   2. if disabled, stop — the switch is also what the breaker flips
//   3. if the breaker condition is met, DISABLE the switch and stop
//   4. for each configured location, find the missing dates in the window and
//      fetch up to `budgetPerRun` of them, nearest-date-first
//   5. log EVERY call, success or failure; write the cache only on success
//
// THE ONE RULE THAT MATTERS MOST (docs/23 section 5): NEVER CACHE A FAILURE.
// myzmanim answers a bad key with HTTP 200, `ErrMsg` set, and a full skeleton of
// '0001-01-01' sentinel values. Writing that would poison the cache with 365
// rows per location that the read-through would then serve forever WITHOUT ever
// calling the API again — silent in both directions, because pages still render
// and the cache looks full. So a row is written only when the response has no
// `ErrMsg` AND parses to at least one real time.

export type PrefetchSettings = {
  enabled: boolean
  horizonDays: number
  budgetPerRun: number
  pauseAfterDays: number
}

export type PrefetchResult = {
  ran: boolean
  reason?: string
  written: number
  failed: number
  locations: number
}

/** Read the switch. Booleans come out with `->>`, never a `::boolean` cast —
 * that cast raises 22023 on a JSON string and aborts the whole query, a trap
 * this repo has already hit on an unconstrained settings blob. */
async function readSettings(sql: postgres.Sql): Promise<PrefetchSettings | null> {
  const rows = await sql<
    { enabled: string | null; horizon: string | null; budget: string | null; pause: string | null }[]
  >`
    select value ->> 'enabled'       as enabled,
           value ->> 'horizonDays'   as horizon,
           value ->> 'budgetPerRun'  as budget,
           value ->> 'pauseAfterDays' as pause
    from public.platform_settings
    where key = 'zmanim.prefetch'
  `
  const row = rows[0]
  if (!row) return null
  return {
    enabled: row.enabled === 'true',
    horizonDays: Number(row.horizon ?? 365),
    budgetPerRun: Number(row.budget ?? 40),
    pauseAfterDays: Number(row.pause ?? 3),
  }
}

/** Founder decision 7: pause after N DAYS with no successful SWEEP call.
 *
 * `origin = 'sweep'` is load-bearing and not a detail. A maker's manual fetch
 * also writes `ok = true`, so a naive `max(fetched_at) where ok` is reset by it
 * — the breaker would then never trip while the sweep was dead, which is
 * precisely the case it exists to catch (adversarial review, 2026-09-23).
 *
 * Evaluated in SQL against `fetched_at` so it compares database time with
 * database time; doing it in JS would make it sensitive to worker clock skew.
 *
 * A sweep that has NEVER succeeded is measured from its first attempt, so a
 * brand-new deployment does not trip on day one for lack of history. */
async function breakerTripped(sql: postgres.Sql, pauseAfterDays: number): Promise<string | null> {
  const rows = await sql<{ stale_since: string | null; days: number | null; ever_ok: boolean }[]>`
    with sweep as (
      select
        max(fetched_at) filter (where ok) as last_ok,
        min(fetched_at)                   as first_attempt
      from public.syn_zmanim_fetch_log
      where origin = 'sweep'
    )
    select coalesce(last_ok, first_attempt) as stale_since,
           extract(epoch from (now() - coalesce(last_ok, first_attempt))) / 86400 as days,
           last_ok is not null as ever_ok
    from sweep
  `
  const row = rows[0]
  if (!row?.stale_since || row.days == null) return null // never attempted
  if (Number(row.days) < pauseAfterDays) return null

  // Say which timestamp this actually is. An earlier draft always wrote "last
  // success", which was a plain falsehood whenever the sweep had NEVER
  // succeeded — the timestamp is the first ATTEMPT in that case, and a
  // superadmin reading "last success <date>" would reasonably conclude the key
  // had worked until then.
  const since = new Date(row.stale_since).toISOString()
  const days = Number(row.days).toFixed(1)
  return row.ever_ok
    ? `auto-paused after ${days} days without a successful sweep call (last success ${since})`
    : `auto-paused: no sweep call has EVER succeeded, and the first attempt was ${days} days ago (${since})`
}

/** Every distinct myzmanim location across every org with the module ENABLED.
 * The cache is per location and shared across orgs (founder decision 2), so two
 * orgs at the same shul cost one set of calls, not two. */
async function activeLocations(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ location_key: string }[]>`
    select distinct settings ->> 'myzmanimLocationId' as location_key
    from public.org_modules
    where module_key = 'synagogue-schedules'
      and enabled
      and coalesce(settings ->> 'myzmanimLocationId', '') <> ''
    order by 1
  `
  return rows.map((r) => r.location_key)
}

/** The dates in the window with no myzmanim row, NEAREST FIRST.
 *
 * Founder decision 4 in one query: the horizon advancing leaves one missing day,
 * a three-day outage leaves four, and random holes at one month and 2.5 months
 * out are simply more rows. Nearest-first because a hole next week is needed
 * long before a hole in eleven months.
 *
 * TWO SUBTLETIES.
 * `source = 'myzmanim'` sits in the JOIN condition, NOT the WHERE. In the WHERE
 * it would turn the anti-join inside out: dates covered only by a hebcal row
 * would stop being NULL-extended and vanish from "missing", so they would never
 * be fetched from myzmanim at all.
 *
 * The window starts at `current_date - 1`. `date` here is a LOCAL CIVIL date
 * while the database's `current_date` is UTC, so after roughly 19:00 in
 * America/New_York the window would otherwise skip today entirely — and every
 * render of "today" would pay a live API call forever. */
async function missingDates(
  sql: postgres.Sql,
  locationKey: string,
  horizonDays: number,
  budget: number,
): Promise<string[]> {
  const rows = await sql<{ d: string }[]>`
    with win as (
      select generate_series(current_date - 1, current_date + ${horizonDays}::int, interval '1 day')::date as d
    )
    select to_char(w.d, 'YYYY-MM-DD') as d
    from win w
    left join public.syn_zmanim_cache c
           on c.location_key = ${locationKey}
          and c.date = w.d
          and c.source = 'myzmanim'
    where c.date is null
    order by w.d
    limit ${budget}
  `
  return rows.map((r) => r.d)
}

export async function runZmanimPrefetch(
  connectionString: string,
  opts: { origin?: 'sweep' | 'backfill'; locationKey?: string; budgetOverride?: number } = {},
): Promise<PrefetchResult> {
  const origin = opts.origin ?? 'sweep'
  const sql = postgres(connectionString, { max: 1 })
  let written = 0
  let failed = 0

  try {
    const settings = await readSettings(sql)
    if (!settings) {
      console.warn('[zmanim-prefetch] no zmanim.prefetch settings row — skipping')
      return { ran: false, reason: 'no settings row', written, failed, locations: 0 }
    }
    if (!settings.enabled) {
      console.log('[zmanim-prefetch] disabled — skipping')
      return { ran: false, reason: 'disabled', written, failed, locations: 0 }
    }

    // The breaker only governs the unattended sweep. A human asking for a
    // specific backfill is allowed to try even while the sweep is paused —
    // that is how you find out the key works again.
    if (origin === 'sweep') {
      const tripped = await breakerTripped(sql, settings.pauseAfterDays)
      if (tripped) {
        // ONE statement, merging into the value rather than replacing it, so a
        // concurrent console edit is not clobbered (and vice versa).
        await sql`
          update public.platform_settings
          set value = value || ${sql.json({ enabled: false, pausedReason: tripped })},
              updated_at = now()
          where key = 'zmanim.prefetch'
        `
        console.warn(`[zmanim-prefetch] ${tripped}`)
        return { ran: false, reason: tripped, written, failed, locations: 0 }
      }
    }

    const creds = myzmanimCredsFromEnv()
    if (!creds) {
      console.warn('[zmanim-prefetch] MYZMANIM_USER/KEY not set — skipping')
      return { ran: false, reason: 'no credentials', written, failed, locations: 0 }
    }

    const locations = opts.locationKey ? [opts.locationKey] : await activeLocations(sql)
    const budget = opts.budgetOverride ?? settings.budgetPerRun

    for (const locationKey of locations) {
      const dates = await missingDates(sql, locationKey, settings.horizonDays, budget)
      if (dates.length === 0) {
        console.log(`[zmanim-prefetch] ${locationKey}: already complete`)
        continue
      }

      for (const dateISO of dates) {
        let ok = false
        let errMsg: string | null = null
        let payload: unknown = null

        try {
          const res = await requestMyzmanimDay(dateISO, locationKey, creds)
          payload = res
          if (res.ErrMsg) {
            errMsg = res.ErrMsg
          } else if (Object.keys(parseZmanim(res)).length === 0) {
            // A response with no ErrMsg but nothing but sentinels is still not
            // usable data, and caching it would be indistinguishable from a
            // successful fill. Treat it as a failure rather than poisoning the
            // cache with a row the read-through would trust forever.
            errMsg = 'response carried no usable times (all sentinel values)'
          } else {
            ok = true
          }
        } catch (err) {
          errMsg = err instanceof Error ? err.message : String(err)
        }

        // Log EVERY call. A refused call is still a paid call, and the log is
        // what the breaker and the cost counter both read.
        await sql`
          insert into public.syn_zmanim_fetch_log (location_key, date, origin, ok, err_msg)
          values (${locationKey}, ${dateISO}, ${origin}, ${ok}, ${errMsg})
        `

        if (ok) {
          await sql`
            insert into public.syn_zmanim_cache (location_key, date, source, payload, fetched_at)
            values (${locationKey}, ${dateISO}, 'myzmanim', ${sql.json(payload as never)}, now())
            on conflict (location_key, date, source)
              do update set payload = excluded.payload, fetched_at = now()
          `
          written++
        } else {
          failed++
          // Stop hammering a dead API: the first failure for a location ends
          // that location's run. The breaker handles the multi-day case; this
          // handles the within-run case, and without it one bad key would burn
          // the whole budget every single run.
          console.warn(`[zmanim-prefetch] ${locationKey} ${dateISO}: ${errMsg}`)
          break
        }
      }
    }

    console.log(`[zmanim-prefetch] ${written} written, ${failed} failed across ${locations.length} location(s)`)
    return { ran: true, written, failed, locations: locations.length }
  } finally {
    await sql.end()
  }
}
