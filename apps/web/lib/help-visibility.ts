import type { HelpGuide } from '@platform/core'
import { createClient } from '@/lib/supabase/server'

// Which guides a caller may see for one module (docs/03 "each level sees
// their level and below").
//
// module_can_manage() alone is NOT the right check here: it was built for
// export-controls (docs/03 #13, "each level can shut off export for the
// levels below") and is correctly admin-tier-only for that purpose — but
// most modules have several staff-flagged guides for sub-admin operational
// roles (classroom's GA/professor, nail-salon's cashier/manager, speed-
// dating's organizer/host, visual-messaging's moderator) that are NOT module
// admins. Gating every staff guide on admin-tier alone means a real GA,
// cashier, host, etc. 404s on their own guide — masked in every demo seed
// because the demo staff member also happens to be an org admin. Found
// 2026-07-11 while adding speed-dating's host guide.
//
// Fix: a staff guide is visible if the caller can manage the module (top
// admin tier, sees everything) OR their OWN module_roles role for this
// module exactly matches the guide's `role` field (confirmed 1:1 with every
// module's actual role strings — see CLAUDE.md 2026-07-11).
export async function visibleGuides(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  moduleKey: string,
  guides: readonly HelpGuide[],
): Promise<{ guides: HelpGuide[]; canManage: boolean }> {
  const [{ data: canManage }, {
    data: { user },
  }] = await Promise.all([
    supabase.rpc('module_can_manage', { check_org_id: orgId, check_module_key: moduleKey }),
    supabase.auth.getUser(),
  ])

  const { data: myRoleRows } = user
    ? await supabase
        .from('module_roles')
        .select('role')
        .eq('org_id', orgId)
        .eq('module_key', moduleKey)
        .eq('user_id', user.id)
    : { data: null }
  const myRoles = new Set((myRoleRows ?? []).map((r) => r.role))

  return {
    guides: guides.filter((g) => !g.staff || canManage || myRoles.has(g.role)),
    canManage: Boolean(canManage),
  }
}
