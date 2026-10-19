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

// A LOOKUP NEVER CONFIRMS A NAME (docs/22 decision 3, §15.2). The founder was
// asked directly whether a mistyped address should prompt "did you mean Sarah
// Cohen?" and answered *"no we should not"* — so `org_find_user_by_email` now
// returns the id ALONE. It no longer returns a name or an address, and this
// signature narrowed with it: the caller gets a user id or nothing.
// SUPERADMIN ONLY since 20261016010000 (it answered "does any account have
// this address?" for every org admin). Only the Owner Console calls it; org
// admins invite by address through issuePendingOrgInvite instead.
export async function resolveEmailToUserId(
  supabase: SupabaseClient,
  orgId: string,
  email: string,
): Promise<{ userId: string } | null> {
  const { data } = await supabase.rpc('org_find_user_by_email', {
    check_org_id: orgId,
    target_email: email.trim().toLowerCase(),
  })
  const row = (data as { user_id: string }[] | null)?.[0]
  if (!row) return null
  return { userId: row.user_id }
}

// Add someone to the org (slice 3, 20260727010000). A plain INSERT: the
// org_members_guard_hierarchy trigger server-stamps invited_by and, for an ORG
// ADMIN, forces status='pending' (they can only ever invite). A SUPERADMIN may
// pass status:'active' to add immediately (the escape hatch); for anyone else
// the trigger overwrites it back to 'pending'. Default (unspecified) is a
// pending invite. A PK conflict (already a member/invite) surfaces as an error
// rather than silently re-adding.
export async function inviteOrgMember(
  supabase: SupabaseClient,
  orgId: string,
  userId: string,
  role: string,
  status?: 'pending' | 'active',
) {
  const row: { org_id: string; user_id: string; role: string; status?: string } = { org_id: orgId, user_id: userId, role }
  if (status) row.status = status
  const { error } = await supabase.from('org_members').insert(row)
  if (error) throw new Error(error.message)
}

// Pending invites held for an ADDRESS (docs/25, 20261016010000). The org
// members page uses these instead of resolveEmailToUserId + inviteOrgMember,
// so an org admin never learns whether an address has an account: the result
// is the same whether it does or not. The person sees the invite once they
// sign in with that exact, confirmed address.
export type IssueInviteResult = 'invited' | 'exists' | 'already_member'

export async function issuePendingOrgInvite(
  supabase: SupabaseClient,
  orgId: string,
  email: string,
  role: string,
  // ONE module role to give once they accept (docs/25 §12, 20261018020000).
  withModule?: { key: string; role: string },
): Promise<IssueInviteResult> {
  const { data, error } = await supabase.rpc('pending_invite_issue_org', {
    check_org_id: orgId,
    target_email: email,
    invited_role: role,
    ...(withModule ? { with_module_key: withModule.key, with_module_role: withModule.role } : {}),
  })
  if (error) throw new Error(error.message)
  return data as IssueInviteResult
}

export type PendingAddressInvite = {
  id: string
  email: string
  role: string
  invited_by: string
  created_at: string
  expires_at: string
}

// Every kind since slice 2 (20261018020000): 'org', a 'module_role' that rode
// on an org invitation, and 'vm_conversation'. Read through the
// pending_invites_list definer, which adds what a held invitation is waiting
// for — for org admins only (docs/25 §6 answer 4).
export type PendingAddressInviteRow = PendingAddressInvite & {
  kind: 'org' | 'module_role' | 'vm_conversation'
  target_id: string
  target_title: string | null
  module_key: string | null
  waiting_on: string | null
}

export async function listPendingAddressInvites(
  supabase: SupabaseClient,
  orgId: string,
): Promise<PendingAddressInviteRow[]> {
  const { data, error } = await supabase.rpc('pending_invites_list', { check_org_id: orgId })
  if (error) throw new Error(error.message)
  return (data ?? []) as PendingAddressInviteRow[]
}

// What a held invitation is waiting for, in words. Shown to ORG ADMINS only:
// they are the ones who can act on it, and these are computed from their own
// org's seats. Anyone else sees "Pending" (a reason would say whether the
// address is in the org).
export const PENDING_INVITE_WAITING_ON: Record<string, string> = {
  org_membership: 'waiting for them to join the organization',
  org_acceptance: 'waiting for them to accept the organization invitation',
  module_role: 'needs the Visual Messaging role',
  module_enabled: 'waiting for that module to be switched on',
  ready: 'ready — appears next time they sign in',
}

export async function cancelPendingInvite(supabase: SupabaseClient, inviteId: string) {
  const { error } = await supabase.rpc('pending_invite_cancel', { invite_id: inviteId })
  if (error) throw new Error(error.message)
}

export async function resendPendingInvite(supabase: SupabaseClient, inviteId: string) {
  const { error } = await supabase.rpc('pending_invite_resend', { invite_id: inviteId })
  if (error) throw new Error(error.message)
}

// Change an EXISTING member's org role — a pure UPDATE of role, so it never
// touches the status column (changing a role must not re-open the accept
// handshake for an already-active member).
export async function changeMemberRole(supabase: SupabaseClient, orgId: string, userId: string, role: string) {
  const { error } = await supabase.from('org_members').update({ role }).eq('org_id', orgId).eq('user_id', userId)
  if (error) throw new Error(error.message)
}

// The caller's own pending org invites, with org name (via the narrow
// org_my_pending_invites definer — the invitee cannot read orgs directly).
export type PendingInvite = {
  org_id: string
  org_name: string
  org_slug: string
  invited_role: string
  invited_at: string
}

export async function getPendingInvites(supabase: SupabaseClient): Promise<PendingInvite[]> {
  const { data, error } = await supabase.rpc('org_my_pending_invites')
  if (error) throw new Error(error.message)
  return (data ?? []) as PendingInvite[]
}

// Rows from the admin-scoped org_member_profiles definer: name/email for every
// member (active AND pending) of an org the caller admins. Needed because
// shares_org_with is active-only, so the broad profiles read can't see a pending
// invitee. Typed here for the same reason as PendingInvite above — the generated
// DB types don't describe definer return shapes, so rpc() data comes back `any`.
export type OrgMemberProfile = {
  user_id: string
  display_name: string | null
  email: string | null
}

export async function acceptOrgInvite(supabase: SupabaseClient, orgId: string) {
  const { error } = await supabase.rpc('org_accept_invite', { check_org_id: orgId })
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
  // module_roles has a surrogate PK since 20260723010000; the scoped-identity
  // conflict target must be named explicitly (the old implicit target was the
  // composite PK). scope_ref defaults null here = a global grant, matching the
  // pre-slice-2 behavior of this helper.
  const { error } = await supabase
    .from('module_roles')
    .upsert({ org_id: orgId, user_id: userId, module_key: moduleKey, role }, { onConflict: 'org_id,user_id,module_key,role,scope_ref' })
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
