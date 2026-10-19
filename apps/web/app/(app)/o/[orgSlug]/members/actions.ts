'use server'

import { revalidatePath } from 'next/cache'
import { getModule } from '@platform/core'
import { createClient } from '@/lib/supabase/server'
import {
  cancelPendingInvite,
  changeMemberRole,
  issuePendingOrgInvite,
  removeModuleRole,
  removeOrgMember,
  resendPendingInvite,
  upsertModuleRole,
} from '@/lib/org-members'

// Org self-management actions (docs/03 "Control hierarchy" level 2). Each
// action re-derives the org and re-checks is_org_admin() itself — the page's
// own gate (requireOrgAdmin) isn't trusted alone, matching the existing
// convention in apps/web/app/(app)/console/actions.ts ("RLS already
// restricts writes... but each action also verifies explicitly so failures
// are clear errors rather than silently-empty writes"). RLS is still the
// real ceiling either way.
async function requireOrgAdminBySlug(orgSlug: string) {
  const supabase = await createClient()
  const { data: org } = await supabase.from('orgs').select('id').eq('slug', orgSlug).single()
  if (!org) throw new Error('Org not found')
  const { data: isAdmin } = await supabase.rpc('is_org_admin', { check_org_id: org.id })
  if (!isAdmin) throw new Error('Not authorized')
  return { supabase, orgId: org.id as string }
}

export type InviteState = { ok: true; message: string } | { ok: false; reason: string } | null

// Invite by ADDRESS (docs/25, 20261016010000). The answer is the same whether
// or not anyone has an account with that address — the person sees the
// invite once they sign in with it. Returns {ok, reason} instead of throwing
// (docs/03 #22: a thrown Server Action message is redacted in production),
// and never puts the address into a thrown error, which would reach the logs.
export async function addMember(orgSlug: string, formData: FormData): Promise<InviteState> {
  const email = String(formData.get('email') ?? '').trim()
  const role = String(formData.get('role') ?? 'member')
  if (!email) return { ok: false, reason: 'Enter an email address.' }

  // Optional module role, "<moduleKey>:<role>" (docs/25 §12). SQL has no role
  // vocabulary, so it is checked against the module manifest here — the same
  // check addModuleRole applies to a direct grant.
  const moduleRole = String(formData.get('moduleRole') ?? '')
  let withModule: { key: string; role: string } | undefined
  if (moduleRole) {
    const [key, mrole] = moduleRole.split(':')
    const manifest = key ? getModule(key) : undefined
    if (!manifest || !mrole || !manifest.roles.includes(mrole)) return { ok: false, reason: 'Unknown module role' }
    withModule = { key: key!, role: mrole }
  }

  try {
    const { supabase, orgId } = await requireOrgAdminBySlug(orgSlug)
    const result = await issuePendingOrgInvite(supabase, orgId, email, role, withModule)
    revalidatePath(`/o/${orgSlug}/members`)
    if (result === 'already_member') {
      return { ok: true, message: 'That person is already a member, or already has an invitation to accept.' }
    }
    if (result === 'exists') {
      return { ok: true, message: 'There is already an invitation for this address. You can see it in the list below.' }
    }
    return {
      ok: true,
      message:
        'Invitation saved. Let them know to sign in or sign up with this address — they will see it then. It expires in 30 days.',
    }
  } catch (e) {
    const msg = (e as Error).message
    const known = ['Enter a valid email address', 'Not authorized', 'Unknown role', 'Unknown module role']
    const shown = known.includes(msg) || msg.startsWith('You have reached your limit of ')
    return { ok: false, reason: shown ? msg : 'Something went wrong. Please try again.' }
  }
}

export async function cancelInvite(orgSlug: string, inviteId: string) {
  const { supabase } = await requireOrgAdminBySlug(orgSlug)
  await cancelPendingInvite(supabase, inviteId)
  revalidatePath(`/o/${orgSlug}/members`)
}

export async function resendInvite(orgSlug: string, inviteId: string) {
  const { supabase } = await requireOrgAdminBySlug(orgSlug)
  await resendPendingInvite(supabase, inviteId)
  revalidatePath(`/o/${orgSlug}/members`)
}

export async function changeRole(orgSlug: string, formData: FormData) {
  const { supabase, orgId } = await requireOrgAdminBySlug(orgSlug)
  const userId = String(formData.get('userId') ?? '')
  const role = String(formData.get('role') ?? '')
  if (!userId || !role) throw new Error('Member and role are required')

  await changeMemberRole(supabase, orgId, userId, role)
  revalidatePath(`/o/${orgSlug}/members`)
}

export async function removeMember(orgSlug: string, userId: string) {
  const { supabase, orgId } = await requireOrgAdminBySlug(orgSlug)
  await removeOrgMember(supabase, orgId, userId)
  revalidatePath(`/o/${orgSlug}/members`)
}

export async function addModuleRole(orgSlug: string, formData: FormData) {
  const { supabase, orgId } = await requireOrgAdminBySlug(orgSlug)
  const userId = String(formData.get('userId') ?? '')
  const moduleKey = String(formData.get('moduleKey') ?? '')
  const role = String(formData.get('role') ?? '')
  if (!userId || !moduleKey || !role) throw new Error('Member, module, and role are required')

  const manifest = getModule(moduleKey)
  if (!manifest || !manifest.roles.includes(role)) throw new Error('Unknown module role')

  await upsertModuleRole(supabase, orgId, userId, moduleKey, role)
  revalidatePath(`/o/${orgSlug}/members`)
}

export async function removeModuleRoleAction(orgSlug: string, userId: string, moduleKey: string, role: string) {
  const { supabase, orgId } = await requireOrgAdminBySlug(orgSlug)
  await removeModuleRole(supabase, orgId, userId, moduleKey, role)
  revalidatePath(`/o/${orgSlug}/members`)
}
