// Zmanim console — server plumbing (docs/23-zmanim-cache-and-global-batches.md §5c).
//
// KEYSTONE, same argument as lib/engagement.ts and lib/data-browser.ts: every
// query below runs on the CALLER's ordinary RLS-enforced client. `platform_settings`
// and `syn_zmanim_fetch_log` both carry a superadmin-only SELECT policy, and
// `syn_zmanim_cache` itself is service_role-only by design — this file never reads
// it directly, only through the `syn_zmanim_cached()` definer, exactly like the
// module's own read-through cache does.
//
// V1 SCOPE (docs/23 §5c, "the honest v1 is READ-ONLY surfaces"): status, the
// coverage strip, API health, the call counter and the settings knobs. The knobs
// ARE writable — `platform_setting_merge()` is a pure metadata write with no
// worker dependency, unlike the per-location action buttons (Fill gaps / Backfill
// year / Run sweep now), which would enqueue a `job_requests` row nothing on prod
// drains today. Those stay out of v1; filling coverage stays
// `scripts/zmanim-backfill.mts`.

import type { SupabaseClient } from '@supabase/supabase-js'

export type ZmanimPrefetchSettings = {
  enabled: boolean
  horizonDays: number
  budgetPerRun: number
  pauseAfterDays: number
  pausedReason: string | null
  updatedAt: string | null
}

export async function getZmanimPrefetchSettings(supabase: SupabaseClient): Promise<ZmanimPrefetchSettings> {
  const { data } = await supabase
    .from('platform_settings')
    .select('value, updated_at')
    .eq('key', 'zmanim.prefetch')
    .maybeSingle()
  const value = (data?.value ?? {}) as Record<string, unknown>
  return {
    enabled: value.enabled === true,
    horizonDays: typeof value.horizonDays === 'number' ? value.horizonDays : 365,
    budgetPerRun: typeof value.budgetPerRun === 'number' ? value.budgetPerRun : 40,
    pauseAfterDays: typeof value.pauseAfterDays === 'number' ? value.pauseAfterDays : 3,
    pausedReason: typeof value.pausedReason === 'string' ? value.pausedReason : null,
    updatedAt: data?.updated_at ?? null,
  }
}

export type ZmanimApiHealth = {
  /** Whether the MOST RECENT call succeeded — never means "has anything ever worked". */
  healthy: boolean
  everCalled: boolean
  lastCallAt: string | null
  lastErrMsg: string | null
  lastSuccessAt: string | null
}

export async function getZmanimApiHealth(supabase: SupabaseClient): Promise<ZmanimApiHealth> {
  const [{ data: last }, { data: lastOk }] = await Promise.all([
    supabase
      .from('syn_zmanim_fetch_log')
      .select('ok, err_msg, fetched_at')
      .order('fetched_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('syn_zmanim_fetch_log')
      .select('fetched_at')
      .eq('ok', true)
      .order('fetched_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])
  return {
    healthy: last?.ok === true,
    everCalled: last != null,
    lastCallAt: last?.fetched_at ?? null,
    lastErrMsg: last && !last.ok ? (last.err_msg as string | null) : null,
    lastSuccessAt: lastOk?.fetched_at ?? null,
  }
}

export type ZmanimCallCounts = { sweep: number; maker: number; backfill: number }

/** Calls since the start of the current calendar month, split by origin — the
 * only way to answer docs/23 §3's actual question, who spent the money. */
export async function getZmanimCallCountsThisMonth(supabase: SupabaseClient): Promise<ZmanimCallCounts> {
  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)
  const { data } = await supabase
    .from('syn_zmanim_fetch_log')
    .select('origin')
    .gte('fetched_at', startOfMonth.toISOString())
  const counts: ZmanimCallCounts = { sweep: 0, maker: 0, backfill: 0 }
  for (const row of (data as { origin: string }[] | null) ?? []) {
    if (row.origin === 'sweep') counts.sweep++
    else if (row.origin === 'maker') counts.maker++
    else if (row.origin === 'backfill') counts.backfill++
  }
  return counts
}

export type LastSweepSummary = { atISO: string | null; written: number; failed: number }

/** There is no run-id in the schema (one row per API call, not per sweep
 * invocation), so "the last run" is a heuristic: every sweep-origin row within
 * 20 minutes of the most recent one. docs/23 §4's budget is a handful of calls
 * per run, so a real run's rows land far inside that window; only matters once
 * the sweep is actually enabled (§7). */
export async function getLastSweepSummary(supabase: SupabaseClient): Promise<LastSweepSummary> {
  const { data } = await supabase
    .from('syn_zmanim_fetch_log')
    .select('ok, fetched_at')
    .eq('origin', 'sweep')
    .order('fetched_at', { ascending: false })
    .limit(500)
  const rows = (data as { ok: boolean; fetched_at: string }[] | null) ?? []
  if (rows.length === 0) return { atISO: null, written: 0, failed: 0 }
  const latestMs = new Date(rows[0]!.fetched_at).getTime()
  const WINDOW_MS = 20 * 60 * 1000
  const sameRun = rows.filter((r) => latestMs - new Date(r.fetched_at).getTime() <= WINDOW_MS)
  return {
    atISO: rows[0]!.fetched_at,
    written: sameRun.filter((r) => r.ok).length,
    failed: sameRun.filter((r) => !r.ok).length,
  }
}

export type LocationCoverage = {
  locationKey: string
  orgNames: string[]
  cachedDays: number
  horizonDays: number
  /** null means fully covered through the horizon. */
  firstGapISO: string | null
  /** One entry per week bucket in the horizon; true = every day that week is cached. */
  weeksCovered: boolean[]
}

function toDateOnly(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Every (location, [org names using it]) pair from every enabled synagogue-schedules
 * org, regardless of whether that org has any cached days yet — a location with
 * zero coverage must still appear as a row, not silently vanish. */
async function getLocationOrgs(supabase: SupabaseClient): Promise<Map<string, string[]>> {
  const [{ data: orgs }, { data: orgModules }] = await Promise.all([
    supabase.from('orgs').select('id, name'),
    supabase
      .from('org_modules')
      .select('org_id, settings')
      .eq('module_key', 'synagogue-schedules')
      .eq('enabled', true),
  ])
  const orgNameById = new Map((orgs ?? []).map((o) => [o.id as string, o.name as string]))
  const locationOrgs = new Map<string, string[]>()
  for (const row of (orgModules as { org_id: string; settings: unknown }[] | null) ?? []) {
    const locationKey = (row.settings as { myzmanimLocationId?: string } | null)?.myzmanimLocationId
    if (!locationKey) continue
    const name = orgNameById.get(row.org_id) ?? row.org_id
    const list = locationOrgs.get(locationKey) ?? []
    list.push(name)
    locationOrgs.set(locationKey, list)
  }
  return locationOrgs
}

/** Per-location coverage over [today, today + horizonDays), read entirely through
 * `syn_zmanim_cached()` — the same bounded, anon-safe path the module's own
 * read-through uses, never the raw table. */
export async function getZmanimCoverage(
  supabase: SupabaseClient,
  horizonDays: number,
): Promise<LocationCoverage[]> {
  const locationOrgs = await getLocationOrgs(supabase)
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const todayISO = toDateOnly(today)
  const horizonEnd = new Date(today)
  horizonEnd.setDate(horizonEnd.getDate() + horizonDays - 1)
  const horizonEndISO = toDateOnly(horizonEnd)

  const results: LocationCoverage[] = []
  for (const [locationKey, orgNames] of locationOrgs) {
    const { data, error } = await supabase.rpc('syn_zmanim_cached', {
      check_location_key: locationKey,
      from_day: todayISO,
      to_day: horizonEndISO,
    })
    if (error) throw new Error(`zmanim coverage read failed for ${locationKey}: ${error.message}`)
    const cachedDateSet = new Set(
      ((data as { zman_date: string; zman_source: string }[] | null) ?? [])
        .filter((r) => r.zman_source === 'myzmanim')
        .map((r) => r.zman_date),
    )

    let firstGapISO: string | null = null
    const weeksCovered: boolean[] = []
    let weekHasGap = false
    const cursor = new Date(today)
    for (let i = 0; i < horizonDays; i++) {
      const iso = toDateOnly(cursor)
      const hit = cachedDateSet.has(iso)
      if (!hit) {
        if (firstGapISO === null) firstGapISO = iso
        weekHasGap = true
      }
      if (i % 7 === 6 || i === horizonDays - 1) {
        weeksCovered.push(!weekHasGap)
        weekHasGap = false
      }
      cursor.setDate(cursor.getDate() + 1)
    }

    results.push({
      locationKey,
      orgNames,
      cachedDays: cachedDateSet.size,
      horizonDays,
      firstGapISO,
      weeksCovered,
    })
  }
  return results.sort((a, b) => a.locationKey.localeCompare(b.locationKey))
}
