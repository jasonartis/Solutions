'use server'

import { revalidatePath } from 'next/cache'
import { getModule } from '@platform/core'
import { createClient } from '@/lib/supabase/server'
import {
  removeModuleRole,
  removeOrgMember,
  resolveEmailToUserId,
  upsertModuleRole,
  upsertOrgMember,
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

export async function addMember(orgSlug: string, formData: FormData) {
  const { supabase, orgId } = await requireOrgAdminBySlug(orgSlug)
  const email = String(formData.get('email') ?? '').trim()
  const role = String(formData.get('role') ?? 'member')
  if (!email) throw new Error('Email is required')

  const found = await resolveEmailToUserId(supabase, orgId, email)
  if (!found) throw new Error(`No user found with email ${email} — they must sign up first`)

  await upsertOrgMember(supabase, orgId, found.userId, role)
  revalidatePath(`/o/${orgSlug}/members`)
}

export async function changeRole(orgSlug: string, formData: FormData) {
  const { supabase, orgId } = await requireOrgAdminBySlug(orgSlug)
  const userId = String(formData.get('userId') ?? '')
  const role = String(formData.get('role') ?? '')
  if (!userId || !role) throw new Error('Member and role are required')

  await upsertOrgMember(supabase, orgId, userId, role)
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
