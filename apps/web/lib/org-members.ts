import type { SupabaseClient } from '@supabase/supabase-js'

// Shared org-membership operations (2026-07-12, docs/03 "Control hierarchy"
// level 2). Used by BOTH the org self-management page (org owner/admin,
// scoped to their own org) and the superadmin Owner Console (all orgs) —
// one place to change the actual read/write shape so the two callers can
// never drift. Each caller does its OWN authorization check (requireOrgAdmin
// vs requireSuperadmin) before calling these; RLS is the real ceiling either
// way (org_members_write_org_admin / _write_superadmin, both additive).
//
// All functions run AS THE CALLER (the passed-in client) — never the
// service-role key (docs/03 #14) — so a bug here fails closed under RLS
// rather than silently bypassing tenancy.

export async function resolveEmailToUserId(
  supabase: SupabaseClient,
  orgId: string,
  email: string,
): Promise<{ userId: string; displayName: string | null } | null> {
  const { data } = await supabase.rpc('org_find_user_by_email', {
    check_org_id: orgId,
    target_email: email.trim().toLowerCase(),
  })
  const row = data?.[0]
  if (!row) return null
  return { userId: row.user_id as string, displayName: row.display_name as string | null }
}

export async function upsertOrgMember(supabase: SupabaseClient, orgId: string, userId: string, role: string) {
  const { error } = await supabase.from('org_members').upsert({ org_id: orgId, user_id: userId, role })
  if (error) throw new Error(error.message)
}

export async function removeOrgMember(supabase: SupabaseClient, orgId: string, userId: string) {
  const { error } = await supabase.from('org_members').delete().eq('org_id', orgId).eq('user_id', userId)
  if (error) throw new Error(error.message)
}

export async function upsertModuleRole(
  supabase: SupabaseClient,
  orgId: string,
  userId: string,
  moduleKey: string,
  role: string,
) {
  const { error } = await supabase.from('module_roles').upsert({ org_id: orgId, user_id: userId, module_key: moduleKey, role })
  if (error) throw new Error(error.message)
}

export async function removeModuleRole(
  supabase: SupabaseClient,
  orgId: string,
  userId: string,
  moduleKey: string,
  role: string,
) {
  const { error } = await supabase
    .from('module_roles')
    .delete()
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .eq('module_key', moduleKey)
    .eq('role', role)
  if (error) throw new Error(error.message)
}
