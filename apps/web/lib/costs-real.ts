import type { SupabaseClient } from '@supabase/supabase-js'

// Real numbers for the Owner Console cost page's "Use my real numbers" button.
// READ-ONLY counts through the superadmin's own session (RLS applies): no rows leave
// this function, only totals. Nothing is written anywhere.

export interface RealNumbers {
  registered: number
  /** Signed in at least once in the last 30 days (login_rollup.last_login_at). */
  active30: number
  orgs: number
  /**
   * Per module key: active members of orgs that have the module switched on, as a share of
   * all active members. An UPPER BOUND on use (being able to use a module is not using it),
   * so the page labels it that way.
   */
  moduleReach: Record<string, number>
  measuredAt: string
}

export async function getRealNumbers(supabase: SupabaseClient): Promise<RealNumbers> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const [profiles, active, orgs, members, entitlements] = await Promise.all([
    supabase.from('profiles').select('user_id', { count: 'exact', head: true }),
    supabase.from('login_rollup').select('user_id', { count: 'exact', head: true }).gte('last_login_at', since),
    supabase.from('orgs').select('id', { count: 'exact', head: true }),
    supabase.from('org_members').select('org_id, user_id').eq('status', 'active'),
    supabase.from('org_modules').select('org_id, module_key').eq('enabled', true),
  ])

  const membersByOrg = new Map<string, Set<string>>()
  const allMembers = new Set<string>()
  for (const r of (members.data ?? []) as { org_id: string; user_id: string }[]) {
    allMembers.add(r.user_id)
    if (!membersByOrg.has(r.org_id)) membersByOrg.set(r.org_id, new Set())
    membersByOrg.get(r.org_id)!.add(r.user_id)
  }
  const reachByModule = new Map<string, Set<string>>()
  for (const e of (entitlements.data ?? []) as { org_id: string; module_key: string }[]) {
    const set = reachByModule.get(e.module_key) ?? new Set<string>()
    for (const u of membersByOrg.get(e.org_id) ?? []) set.add(u)
    reachByModule.set(e.module_key, set)
  }
  const moduleReach: Record<string, number> = {}
  for (const [k, set] of reachByModule) moduleReach[k] = allMembers.size > 0 ? set.size / allMembers.size : 0

  return {
    registered: profiles.count ?? 0,
    active30: active.count ?? 0,
    orgs: orgs.count ?? 0,
    moduleReach,
    measuredAt: new Date().toISOString(),
  }
}
