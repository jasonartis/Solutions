import type { DayContext } from './evaluator'
import { getDayFacts, getZmanimFallback } from './calendar'

// myzmanim.com connector — the PRIMARY zmanim source (spec). API shape learned
// from the founder's Apps Script: POST form fields to engine1.json.aspx/getDay,
// zip-based locationid (e.g. 'US11210'), response { Zman: { Field: ISO }, ErrMsg }.
// hebcal remains the fallback.
//
// ---------------------------------------------------------------------------
// TWO BUGS FIXED 2026-09-23, both measured against the live API
// ---------------------------------------------------------------------------
// 1. CREDENTIALS MUST BE POSTED AS FORM FIELDS, NOT SENT AS QUERY PARAMS.
//    A previous pass (2026-07-07) switched this to `GET ?user=..&key=..`,
//    reasoning that "form-POST trips the WCF backend". That reverted the shape
//    the founder's own Apps Script used, and the API silently IGNORES
//    credentials supplied in the query string — they arrive BLANK, and the
//    response is `ErrMsg: NotAuthorizedSeeApiDashboardForDetails`, which reads
//    exactly like an expired subscription.
//
//    PROVEN with myzmanim's own published demo credentials (pre-filled on their
//    public demo form at api.myzmanim.com/engine1.json.aspx), which give two
//    DIFFERENT errors depending only on request shape:
//      POST form-urlencoded -> "DoNotUseDemoCredentials"  (creds were READ)
//      GET  query params    -> "NotAuthorized..."         (creds arrived blank)
//    The documentation agrees: "Credentials are not accepted via URL path or
//    query parameters." `scripts/verify-myzmanim-request-shape.mts` re-runs
//    that control on demand — it needs no subscription of our own.
//
//    NOTE the earlier finding was not baseless: a JSON *body* really does fail
//    (HTTP 401 with a WCF stack trace). It is specifically
//    `application/x-www-form-urlencoded` that works — what their demo form posts.
//
// 2. THE "MISSING VALUE" SENTINEL NEVER MATCHED, so absent times became year-1
//    dates. The sentinel was compared against '0001-01-01T00:00:00Z' by exact
//    string equality, and the guard was dead, so `new Date(...)` produced a
//    valid year-1 Date that flowed into the schedule as if it were a real time.
//    Two consequences, the second worse than the first: a genuinely empty field
//    (`Candles` on a Tuesday) renders a year-1 time instead of nothing; and
//    because `buildWeek` only falls back to hebcal when the parsed map is EMPTY,
//    a mostly-sentinel response would suppress the fallback entirely.
//    Now filtered by YEAR.
//
//    CORRECTED 2026-09-24, once a working key existed: this comment used to say
//    "the API sends it WITHOUT the trailing Z". That was measured against the
//    UNAUTHORIZED-error skeleton only. A real response uses the Z spelling, and
//    the error skeleton does not — **both forms genuinely occur**, so neither
//    exact-match guard would have been correct. Filtering by year was defensive
//    when it was written and turns out to have been necessary.
//
// 3. THE `Z` IS A LIE — found 2026-09-24, see parseZmanim's own header. This is
//    the one that could not have been found without a working key, and it made
//    every single time in every response wrong by the location's UTC offset.

export type MyzmanimCredentials = { user: string; key: string }

const API_URL = 'https://api.myzmanim.com/engine1.json.aspx/getDay'

/** The raw getDay response. `Place` and `Time` are retained in the type because
 * the API returns them in the same call — see docs/23 on caching the payload. */
export type MyzmanimResponse = {
  ErrMsg?: string
  Zman?: Record<string, unknown>
  Place?: Record<string, unknown>
  Time?: Record<string, unknown>
}

// Per-process memo: one API call per (location, date) per server lifetime.
const memo = new Map<string, Partial<Record<string, Date>>>()

export async function fetchMyzmanimDay(
  dateISO: string,
  locationId: string,
  creds: MyzmanimCredentials,
  timeZone: string,
): Promise<Partial<Record<string, Date>>> {
  const memoKey = `${locationId}|${dateISO}|${timeZone}`
  const cached = memo.get(memoKey)
  if (cached) return cached

  const data = await requestMyzmanimDay(dateISO, locationId, creds)
  if (data.ErrMsg) throw new Error(`myzmanim: ${data.ErrMsg}`)

  const out = parseZmanim(data, timeZone)
  memo.set(memoKey, out)
  return out
}

/** One getDay call, returning the RAW response untouched. Credentials go in a
 * form-urlencoded POST body — see the header; query params are ignored by the
 * API and produce a misleading "not authorized". */
export async function requestMyzmanimDay(
  dateISO: string,
  locationId: string,
  creds: MyzmanimCredentials,
): Promise<MyzmanimResponse> {
  const body = new URLSearchParams({
    user: creds.user,
    key: creds.key,
    coding: 'JS',
    language: 'en',
    inputdate: dateISO,
    locationid: locationId,
  })
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new Error(`myzmanim HTTP ${res.status}`)
  return (await res.json()) as MyzmanimResponse
}

/** Does this response carry at least one REAL time?
 *
 * Deliberately separate from `parseZmanim`, and deliberately timezone-free. The
 * prefetch sweep has to answer "is this worth caching?" for a location whose
 * timezone it does not know — the cache is keyed by location and shared across
 * orgs, while the timezone lives in each org's settings. Conversion is not
 * needed to answer that question, and requiring one would have meant either
 * threading a timezone the sweep cannot know or passing a fake one.
 *
 * This is the gate in front of every cache write: docs/23 section 5 — a response
 * with no ErrMsg but nothing except sentinels is still not usable data, and
 * caching it is indistinguishable from a successful fill. */
export function hasUsableTimes(data: MyzmanimResponse): boolean {
  for (const value of Object.values(data.Zman ?? {})) {
    if (typeof value !== 'string') continue
    const m = /^(\d{4})-/.exec(value)
    if (m && Number(m[1]) >= 1900) return true
  }
  return false
}

/** The zone's UTC offset in milliseconds at a given instant. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asIfUtc - at.getTime()
}

/** Turn a WALL-CLOCK time in `timeZone` into a true instant.
 *
 * Two passes, which matters only near a DST boundary: the first guess uses the
 * offset at the wrong instant, the second uses the offset at (approximately) the
 * right one. */
function wallTimeToInstant(y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string): Date {
  const asIfUtc = Date.UTC(y, mo - 1, d, h, mi, s)
  let instant = new Date(asIfUtc - zoneOffsetMs(new Date(asIfUtc), timeZone))
  instant = new Date(asIfUtc - zoneOffsetMs(instant, timeZone))
  return instant
}

/** Pull the usable times out of a getDay response.
 *
 * ===========================================================================
 * THE `Z` ON A MYZMANIM TIMESTAMP IS A LIE, and believing it shifts every time
 * by the location's UTC offset (found 2026-09-24, the first day we had a
 * working key — no amount of schema reading could have revealed it).
 * ===========================================================================
 * A real response sends sunrise in Brooklyn on 2025-12-12 as
 * `"2025-12-12T07:10:24Z"`. Sunrise there is 7:10 AM local, and the founder's
 * own printed sheet says 7:10 AM — so the value is LOCAL WALL TIME wearing a
 * UTC suffix. `new Date(...)` dutifully reads it as 07:10 UTC, which is 02:10 in
 * New York, and the whole schedule renders five hours early. It is not a
 * rounding error or an edge case: every single time in every response is wrong
 * by the offset, and in summer it is six.
 *
 * So the string is parsed as a NAIVE wall clock and re-anchored in the
 * location's timezone, producing a true instant. That keeps myzmanim and the
 * hebcal fallback in ONE representation — hebcal returns real instants — so
 * `wallMinutes()` and the week aggregates work identically whichever source a
 * day came from. Mixing representations would work until the first week that
 * drew from both.
 *
 * ABSENT FIELDS are detected by YEAR rather than by string equality, and that
 * defensiveness turned out to be necessary rather than merely tidy: the live API
 * uses BOTH spellings of the sentinel — `0001-01-01T00:00:00Z` inside a real
 * response, and `0001-01-01T00:00:00` with no `Z` in the unauthorized-error
 * skeleton. An exact-match guard on either one silently admits the other as a
 * real year-1 Date. */
export function parseZmanim(data: MyzmanimResponse, timeZone: string): Partial<Record<string, Date>> {
  const out: Partial<Record<string, Date>> = {}
  for (const [field, value] of Object.entries(data.Zman ?? {})) {
    if (typeof value !== 'string') continue
    // Deliberately NOT `new Date(value)`: see the header. Read the wall-clock
    // fields out of the string and re-anchor them in the location's zone.
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value)
    if (!m) continue
    const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number]
    if (y < 1900) continue // the sentinel, in either of its two spellings
    const instant = wallTimeToInstant(y, mo, d, h, mi, s, timeZone)
    if (!Number.isNaN(instant.getTime())) out[field] = instant
  }
  return out
}

/** Where a day's times actually came from. Founder decision 3 (docs/23): a maker
 * must be told when a schedule is running on the backup source, because hebcal
 * has no candle-lighting at all. */
export type ZmanimSource = 'cache' | 'api' | 'fallback' | 'none'

/** Reads already-cached responses for a whole date range in ONE round trip.
 *
 * Injected rather than imported so this module keeps no database dependency —
 * the web app supplies an RLS-scoped reader, the worker a service-role one, and
 * a test supplies a literal Map. Keyed by `YYYY-MM-DD`. */
export type ZmanimCacheReader = (
  locationId: string,
  fromISO: string,
  toISO: string,
) => Promise<Map<string, MyzmanimResponse>>

export type WeekSourceOptions = {
  latitude?: number
  longitude?: number
  timeZone: string
  israel?: boolean
  /** myzmanim location id, e.g. 'US11210'. */
  myzmanimLocationId?: string
  credentials?: MyzmanimCredentials | null
  /** Optional read-through cache. When it covers a day, NO API call is made. */
  cache?: ZmanimCacheReader
}

/** Build the seven DayContexts for the week starting at sundayISO.
 * Cache first, then myzmanim, then the hebcal fallback. */
export async function buildWeek(sundayISO: string, opts: WeekSourceOptions): Promise<DayContext[]> {
  return (await buildWeekWithProvenance(sundayISO, opts)).days
}

/** `buildWeek`, plus WHERE each day's times came from.
 *
 * Kept as a separate export so the three existing `buildWeek` call sites do not
 * have to change; provenance is only needed by the surfaces that show founder
 * decision 3's badge. */
export async function buildWeekWithProvenance(
  sundayISO: string,
  opts: WeekSourceOptions,
): Promise<{ days: DayContext[]; provenance: Record<string, ZmanimSource> }> {
  const sunday = new Date(`${sundayISO}T12:00:00`)
  const dates: { d: Date; iso: string }[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(sunday)
    d.setDate(sunday.getDate() + i)
    dates.push({
      d,
      iso: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    })
  }

  // ONE round trip for the whole week, not one per day. This is the entire
  // point of the cache: a warm week costs a single query and zero API calls,
  // where today it costs seven serial paid requests on every render.
  let cached = new Map<string, MyzmanimResponse>()
  if (opts.cache && opts.myzmanimLocationId) {
    try {
      cached = await opts.cache(opts.myzmanimLocationId, dates[0]!.iso, dates[6]!.iso)
    } catch (err) {
      // A cache failure must never take the schedule down — it degrades to the
      // pre-cache behaviour, which is the live API and then hebcal.
      console.warn('zmanim cache read failed, continuing without it:', err)
    }
  }

  const days: DayContext[] = []
  const provenance: Record<string, ZmanimSource> = {}

  for (const { d, iso } of dates) {
    let zmanim: Partial<Record<string, Date>> = {}
    let source: ZmanimSource = 'none'

    const hit = cached.get(iso)
    if (hit) {
      zmanim = parseZmanim(hit, opts.timeZone)
      if (Object.keys(zmanim).length > 0) source = 'cache'
    }

    // Only reach for the API when the cache did not answer.
    if (source === 'none' && opts.myzmanimLocationId && opts.credentials?.user && opts.credentials?.key) {
      try {
        zmanim = await fetchMyzmanimDay(iso, opts.myzmanimLocationId, opts.credentials, opts.timeZone)
        if (Object.keys(zmanim).length > 0) source = 'api'
      } catch (err) {
        console.warn(`myzmanim failed for ${iso}, falling back to hebcal:`, err)
      }
    }

    if (Object.keys(zmanim).length === 0 && opts.latitude != null && opts.longitude != null) {
      zmanim = getZmanimFallback(d, opts.latitude, opts.longitude, opts.timeZone)
      source = 'fallback'
    }

    provenance[iso] = source
    days.push({ facts: getDayFacts(d, opts.israel ?? false), zmanim })
  }

  return { days, provenance }
}

/** Read credentials from process env (web server / worker). */
export function myzmanimCredsFromEnv(): MyzmanimCredentials | null {
  const user = process.env.MYZMANIM_USER
  const key = process.env.MYZMANIM_KEY
  return user && key ? { user, key } : null
}
