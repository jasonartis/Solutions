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
//    dates. The sentinel was compared against '0001-01-01T00:00:00Z', but the
//    API sends it WITHOUT the trailing Z ('0001-01-01T00:00:00'), so the guard
//    was dead and `new Date(...)` produced a valid year-1 Date that flowed into
//    the schedule as if it were a real time.
//    Two consequences, the second worse than the first: a genuinely empty field
//    (`Candles` on a Tuesday) renders a year-1 time instead of nothing; and
//    because `buildWeek` only falls back to hebcal when the parsed map is EMPTY,
//    a mostly-sentinel response would suppress the fallback entirely.
//    Now filtered by YEAR, which is robust to either spelling.

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
): Promise<Partial<Record<string, Date>>> {
  const memoKey = `${locationId}|${dateISO}`
  const cached = memo.get(memoKey)
  if (cached) return cached

  const data = await requestMyzmanimDay(dateISO, locationId, creds)
  if (data.ErrMsg) throw new Error(`myzmanim: ${data.ErrMsg}`)

  const out = parseZmanim(data)
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

/** Pull the usable times out of a getDay response.
 *
 * A field is ABSENT when the API sends its missing-value sentinel. Detected by
 * YEAR rather than by string equality: the sentinel is documented in the
 * founder's Apps Script as '0001-01-01T00:00:00Z' but the live API sends
 * '0001-01-01T00:00:00' with no trailing Z, and an exact-match guard on either
 * spelling silently lets the other through as a real year-1 Date. */
export function parseZmanim(data: MyzmanimResponse): Partial<Record<string, Date>> {
  const out: Partial<Record<string, Date>> = {}
  for (const [field, value] of Object.entries(data.Zman ?? {})) {
    if (typeof value !== 'string') continue
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) continue
    if (d.getUTCFullYear() < 1900) continue // the sentinel, however it is spelled
    out[field] = d
  }
  return out
}

export type WeekSourceOptions = {
  latitude?: number
  longitude?: number
  timeZone: string
  israel?: boolean
  /** myzmanim location id, e.g. 'US11210'. */
  myzmanimLocationId?: string
  credentials?: MyzmanimCredentials | null
}

/** Build the seven DayContexts for the week starting at sundayISO.
 * myzmanim primary when location id + credentials are available;
 * hebcal fallback otherwise or on API failure. */
export async function buildWeek(sundayISO: string, opts: WeekSourceOptions): Promise<DayContext[]> {
  const sunday = new Date(`${sundayISO}T12:00:00`)
  const days: DayContext[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(sunday)
    d.setDate(sunday.getDate() + i)
    const dateISO = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

    let zmanim: Partial<Record<string, Date>> = {}
    if (opts.myzmanimLocationId && opts.credentials?.user && opts.credentials?.key) {
      try {
        zmanim = await fetchMyzmanimDay(dateISO, opts.myzmanimLocationId, opts.credentials)
      } catch (err) {
        console.warn(`myzmanim failed for ${dateISO}, falling back to hebcal:`, err)
      }
    }
    if (Object.keys(zmanim).length === 0 && opts.latitude != null && opts.longitude != null) {
      zmanim = getZmanimFallback(d, opts.latitude, opts.longitude, opts.timeZone)
    }

    days.push({ facts: getDayFacts(d, opts.israel ?? false), zmanim })
  }
  return days
}

/** Read credentials from process env (web server / worker). */
export function myzmanimCredsFromEnv(): MyzmanimCredentials | null {
  const user = process.env.MYZMANIM_USER
  const key = process.env.MYZMANIM_KEY
  return user && key ? { user, key } : null
}
