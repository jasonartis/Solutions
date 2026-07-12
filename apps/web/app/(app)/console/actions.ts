'use server'

import { revalidatePath } from 'next/cache'
import { getModule, moduleRegistry } from '@platform/core'
import { createClient } from '@/lib/supabase/server'
import {
  removeModuleRole,
  removeOrgMember,
  resolveEmailToUserId,
  upsertModuleRole,
  upsertOrgMember,
} from '@/lib/org-members'

// Owner-console server actions. RLS already restricts writes on these tables
// to superadmins, but each action also verifies explicitly so failures are
// clear errors rather than silently-empty writes.
async function requireSuperadmin() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')

  const { data: profile } = await supabase
    .from('profiles')
    .select('is_superadmin')
    .eq('user_id', user.id)
    .single()
  if (!profile?.is_superadmin) throw new Error('Not authorized')
  return supabase
}

export async function createOrg(formData: FormData) {
  const supabase = await requireSuperadmin()
  const name = String(formData.get('name') ?? '').trim()
  const slug = String(formData.get('slug') ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
  if (!name || !slug) throw new Error('Name and slug are required')

  const { error } = await supabase.from('orgs').insert({ name, slug })
  if (error) throw new Error(error.message)
  revalidatePath('/console')
}

export async function toggleModule(orgId: string, moduleKey: string, enable: boolean) {
  if (!moduleRegistry.some((m) => m.key === moduleKey)) throw new Error('Unknown module')
  const supabase = await requireSuperadmin()

  const { error } = await supabase
    .from('org_modules')
    .upsert({ org_id: orgId, module_key: moduleKey, enabled: enable })
  if (error) throw new Error(error.message)
  revalidatePath('/console')
}

export async function addMember(orgId: string, formData: FormData) {
  const supabase = await requireSuperadmin()
  const email = String(formData.get('email') ?? '').trim()
  const role = String(formData.get('role') ?? 'member')
  if (!orgId || !email) throw new Error('Org and email are required')

  const found = await resolveEmailToUserId(supabase, orgId, email)
  if (!found) throw new Error(`No user found with email ${email} — they must sign up first`)

  await upsertOrgMember(supabase, orgId, found.userId, role)
  revalidatePath('/console')
}

export async function changeRole(orgId: string, formData: FormData) {
  const supabase = await requireSuperadmin()
  const userId = String(formData.get('userId') ?? '')
  const role = String(formData.get('role') ?? '')
  if (!orgId || !userId || !role) throw new Error('Org, member, and role are required')

  await upsertOrgMember(supabase, orgId, userId, role)
  revalidatePath('/console')
}

export async function removeMember(orgId: string, userId: string) {
  const supabase = await requireSuperadmin()
  await removeOrgMember(supabase, orgId, userId)
  revalidatePath('/console')
}

export async function addModuleRole(orgId: string, formData: FormData) {
  const supabase = await requireSuperadmin()
  const userId = String(formData.get('userId') ?? '')
  const moduleKey = String(formData.get('moduleKey') ?? '')
  const role = String(formData.get('role') ?? '')
  if (!userId || !moduleKey || !role) throw new Error('Member, module, and role are required')

  const manifest = getModule(moduleKey)
  if (!manifest || !manifest.roles.includes(role)) throw new Error('Unknown module role')

  await upsertModuleRole(supabase, orgId, userId, moduleKey, role)
  revalidatePath('/console')
}

export async function removeModuleRoleAction(orgId: string, userId: string, moduleKey: string, role: string) {
  const supabase = await requireSuperadmin()
  await removeModuleRole(supabase, orgId, userId, moduleKey, role)
  revalidatePath('/console')
}
