// Engagement monitoring, phase 3 — server plumbing (docs/17-engagement-monitoring.md).
//
// THE KEYSTONE, restated because it is what makes the superadmin gate on this
// console route safe (same argument as lib/data-browser.ts): every query below
// runs on the CALLER's ordinary RLS-enforced client. No service-role client, no
// `.rpc()`, anywhere on this path.
//
// WHAT THIS ANSWERS: "who has gone quiet, and who should I reach out to" — a
// THIRD question, distinct from the data browser ("what do I hold about this
// person") and view-as ("what does this person see"). docs/03 #19 requires
// saying so on screen, not just here.
//
// THE ONE FACT EVERY FUNCTION HERE MUST RESPECT (docs/17 §3): a login has no
// org. `login_events`/`login_rollup` carry no `org_id`, so the "by organization"
// direction below is really "this org's members' PLATFORM activity" — it
// cannot mean "activity in this org", and the page must say that on screen.
//
// PENDING EXCLUSION (§3): `org_members.status = 'pending'` means invited but
// never accepted. Counting a pending row as a quiet member would tell the
// founder to apologise to someone who never joined — the opposite of the
// truth. Every population query below filters `status = 'active'` and the org
// view separately reports how many were excluded, rather than silently
// dropping them with no trace.
//
// "NO ROLLUP ROW" MEANS NEVER SIGNED IN (§6), not an error — `login_rollup`
// only ever gains a row for someone this log has actually seen (backfilled or
// captured), so an active member absent from it is a clean, intentional
// "never signed in", and every function below reads it that way.

import type { SupabaseClient } from '@supabase/supabase-js'

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

export type EngagementRow = {
  userId: string
  displayName: string
  email: string
  /** Trustworthy for everyone — backfilled from `auth.users` at migration time. */
  lastLoginAt: string | null
  /**
   * NOT a lifetime total (§6, §8b item 4) — counts only sign-ins since
   * `observedSince`, which for a backfilled row is the migration date. Render
   * next to `observedSince`, never alone, or it reads as a full history.
   */
  observedLogins: number
  observedSince: string | null
  /** Live query over `login_events`, not a stored column — see getLoginsLast30d. */
  loginsLast30d: number
}

export type OrgEngagementRow = EngagementRow & { orgRole: string }
export type PlatformEngagementRow = EngagementRow & { orgNames: string[] }

export type PersonEngagement = EngagementRow & {
  orgs: { id: string; name: string; slug: string; role: string }[]
}

export type PickablePerson = { userId: string; displayName: string; email: string }

/**
 * The honesty badge value (§8b item 1, §10 point 4): the newest login this log
 * has ever successfully captured, platform-wide.
 *
 * DELIBERATELY reads `login_rollup`, not `login_events`. The raw table is only
 * a 90-day window, so on a platform where nobody has signed in for >90 days it
 * would read empty for a reason that has nothing to do with capture health.
 * `login_rollup.last_login_at` is permanent and can only advance when the
 * capture trigger actually succeeds (it is maintained at write time, not by the
 * pruner — see the migration header) — so a stuck value here IS the "capture
 * may have stopped" signal. It is the most honest thing this schema can say
 * without `auth` access, which the console path may never have (docs/17 §4).
 */
export async function getNewestCapturedLogin(supabase: SupabaseClient): Promise<string | null> {
  const { data } = await supabase
    .from('login_rollup')
    .select('last_login_at')
    .order('last_login_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as { last_login_at: string } | null)?.last_login_at ?? null
}

type RollupRow = { user_id: string; last_login_at: string; observed_logins: number; observed_since: string }
type ProfileRow = { user_id: string; display_name: string | null; email: string | null }

async function rollupByUser(supabase: SupabaseClient, userIds: string[]): Promise<Map<string, RollupRow>> {
  if (userIds.length === 0) return new Map()
  const { data } = await supabase
    .from('login_rollup')
    .select('user_id, last_login_at, observed_logins, observed_since')
    .in('user_id', userIds)
  return new Map(((data ?? []) as unknown as RollupRow[]).map((r) => [r.user_id, r]))
}

async function profilesByUser(supabase: SupabaseClient, userIds: string[]): Promise<Map<string, ProfileRow>> {
  if (userIds.length === 0) return new Map()
  const { data } = await supabase.from('profiles').select('user_id, display_name, email').in('user_id', userIds)
  return new Map(((data ?? []) as unknown as ProfileRow[]).map((p) => [p.user_id, p]))
}

/**
 * "Logins in the last 30 days" — a LIVE query over `login_events`, never a
 * stored column (§6, §8b item 5): the pruner only ever sees rows already ≥90
 * days old, so a pruner-maintained 30-day counter would be permanently zero.
 * Only meaningful while retention actually holds, which on prod waits on the
 * worker (docs/17 §11) — the page states that caveat once, not per row.
 */
async function loginsLast30dByUser(supabase: SupabaseClient, userIds: string[]): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map()
  const cutoff = new Date(Date.now() - THIRTY_DAYS_MS).toISOString()
  const { data } = await supabase
    .from('login_events')
    .select('user_id')
    .gte('occurred_at', cutoff)
    .in('user_id', userIds)
  const counts = new Map<string, number>()
  for (const row of (data ?? []) as { user_id: string }[]) {
    counts.set(row.user_id, (counts.get(row.user_id) ?? 0) + 1)
  }
  return counts
}

function toRow(
  userId: string,
  profiles: Map<string, ProfileRow>,
  rollups: Map<string, RollupRow>,
  last30: Map<string, number>,
): EngagementRow {
  const p = profiles.get(userId)
  const r = rollups.get(userId)
  return {
    userId,
    displayName: p?.display_name || p?.email || userId,
    email: p?.email ?? '',
    lastLoginAt: r?.last_login_at ?? null,
    observedLogins: r?.observed_logins ?? 0,
    observedSince: r?.observed_since ?? null,
    loginsLast30d: last30.get(userId) ?? 0,
  }
}

/** Never-signed-in first (no rollup row is the quietest anyone can be), then oldest last-login first. */
function quietestFirst(a: EngagementRow, b: EngagementRow): number {
  if (!a.lastLoginAt && !b.lastLoginAt) return 0
  if (!a.lastLoginAt) return -1
  if (!b.lastLoginAt) return 1
  return a.lastLoginAt < b.lastLoginAt ? -1 : a.lastLoginAt > b.lastLoginAt ? 1 : 0
}

export type OrgEngagement = { active: OrgEngagementRow[]; pendingCount: number }

/**
 * Org→people direction (§1, §8b item 11). Members' PLATFORM login activity —
 * NOT "activity in this org", which does not exist (§3). Pending invites are
 * excluded from `active` but counted in `pendingCount` rather than vanishing
 * without a trace.
 */
export async function getOrgMembers(supabase: SupabaseClient, orgId: string): Promise<OrgEngagement> {
  const { data } = await supabase.from('org_members').select('user_id, role, status').eq('org_id', orgId)
  type MemberRow = { user_id: string; role: string; status: string }
  const members = (data ?? []) as unknown as MemberRow[]
  const activeMembers = members.filter((m) => m.status === 'active')
  const pendingCount = members.length - activeMembers.length
  if (activeMembers.length === 0) return { active: [], pendingCount }

  const ids = activeMembers.map((m) => m.user_id)
  const [profiles, rollups, last30] = await Promise.all([
    profilesByUser(supabase, ids),
    rollupByUser(supabase, ids),
    loginsLast30dByUser(supabase, ids),
  ])

  const active = activeMembers
    .map((m) => ({ ...toRow(m.user_id, profiles, rollups, last30), orgRole: m.role }))
    .sort(quietestFirst)
  return { active, pendingCount }
}

/**
 * The platform-wide landing view: every active member of every org, deduped by
 * person, quietest first. This is the direct answer to the founder's stated
 * question ("who should I reach out to") without picking an org or person
 * first — of 12 prod users, 7 have never signed in, which is most of this
 * feature's value (docs/17 decisions log, 2026-08-09).
 *
 * Deriving the population from `org_members` rather than `profiles` (like
 * lib/data-browser.ts's `subjectsIn`) because a bare profile with no org
 * membership isn't a platform member anyone can reach out to about — and
 * because `login_rollup` carries no `org_id`, this join has to happen here in
 * application code; there is no single query that does it (see docs/17 §8b
 * item 12 — recorded as real query friction from being phase 1's first reader).
 */
export async function getQuietestMembers(
  supabase: SupabaseClient,
  limit = 20,
): Promise<PlatformEngagementRow[]> {
  const { data } = await supabase.from('org_members').select('user_id, orgs(name)').eq('status', 'active')
  type Row = { user_id: string; orgs: { name: string } | { name: string }[] | null }
  const memberRows = (data ?? []) as unknown as Row[]
  if (memberRows.length === 0) return []

  const orgNamesByUser = new Map<string, string[]>()
  for (const m of memberRows) {
    const org = Array.isArray(m.orgs) ? m.orgs[0] : m.orgs
    if (!org?.name) continue
    const list = orgNamesByUser.get(m.user_id) ?? []
    list.push(org.name)
    orgNamesByUser.set(m.user_id, list)
  }
  const ids = Array.from(orgNamesByUser.keys())

  const [profiles, rollups, last30] = await Promise.all([
    profilesByUser(supabase, ids),
    rollupByUser(supabase, ids),
    loginsLast30dByUser(supabase, ids),
  ])

  return ids
    .map((id) => ({ ...toRow(id, profiles, rollups, last30), orgNames: orgNamesByUser.get(id)! }))
    .sort(quietestFirst)
    .slice(0, limit)
}

/** People pickable in the "by person" direction — every active member, platform-wide. */
export async function allPeople(supabase: SupabaseClient): Promise<PickablePerson[]> {
  const { data } = await supabase.from('org_members').select('user_id').eq('status', 'active')
  const ids = Array.from(new Set(((data ?? []) as { user_id: string }[]).map((m) => m.user_id)))
  if (ids.length === 0) return []
  const profiles = await profilesByUser(supabase, ids)
  return ids
    .map((userId) => {
      const p = profiles.get(userId)
      return { userId, displayName: p?.display_name || p?.email || userId, email: p?.email ?? '' }
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
}

/**
 * Person→orgs direction (§1, §8b item 11): one person's own login summary
 * (platform-wide, since a login has no org) plus which orgs they belong to.
 * The page must not present the org list as "where they've been active" — it
 * is membership, not activity (§3).
 */
export async function getPersonEngagement(
  supabase: SupabaseClient,
  userId: string,
): Promise<PersonEngagement | null> {
  const { data: profile } = await supabase
    .from('profiles')
    .select('user_id, display_name, email')
    .eq('user_id', userId)
    .maybeSingle()
  if (!profile) return null

  const [{ data: memberships }, rollups, last30] = await Promise.all([
    supabase.from('org_members').select('role, orgs(id, name, slug)').eq('user_id', userId).eq('status', 'active'),
    rollupByUser(supabase, [userId]),
    loginsLast30dByUser(supabase, [userId]),
  ])

  type MembershipRow = { role: string; orgs: { id: string; name: string; slug: string } | { id: string; name: string; slug: string }[] | null }
  const orgs = ((memberships ?? []) as unknown as MembershipRow[]).flatMap((m) => {
    const org = Array.isArray(m.orgs) ? m.orgs[0] : m.orgs
    return org ? [{ id: org.id, name: org.name, slug: org.slug, role: m.role }] : []
  })

  const profiles = new Map([[userId, profile as unknown as ProfileRow]])
  return { ...toRow(userId, profiles, rollups, last30), orgs }
}
