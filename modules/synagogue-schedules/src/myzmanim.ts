import type { DayContext } from './evaluator'
import { getDayFacts, getZmanimFallback } from './calendar'

// myzmanim.com connector — the PRIMARY zmanim source (spec). API shape learned
// from the founder's Apps Script: POST form fields to engine1.json.aspx/getDay,
// zip-based locationid (e.g. 'US11210'), response { Zman: { Field: ISO }, ErrMsg }.
// Missing values arrive as '0001-01-01T00:00:00Z'. hebcal remains the fallback.

export type MyzmanimCredentials = { user: string; key: string }

const API_URL = 'https://api.myzmanim.com/engine1.json.aspx/getDay'

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

  const body = new URLSearchParams({
    user: creds.user,
    key: creds.key,
    coding: 'JS',
    language: 'en',
    inputdate: dateISO,
    locationid: locationId,
  })
  const res = await fetch(API_URL, { method: 'POST', body })
  if (!res.ok) throw new Error(`myzmanim HTTP ${res.status}`)
  const data = (await res.json()) as { ErrMsg?: string; Zman?: Record<string, unknown> }
  if (data.ErrMsg) throw new Error(`myzmanim: ${data.ErrMsg}`)

  const out: Partial<Record<string, Date>> = {}
  for (const [field, value] of Object.entries(data.Zman ?? {})) {
    if (typeof value !== 'string' || value === '0001-01-01T00:00:00Z') continue
    const d = new Date(value)
    if (!Number.isNaN(d.getTime())) out[field] = d
  }
  memo.set(memoKey, out)
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
