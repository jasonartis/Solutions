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
import { parseSynagogueSettingsForm } from '@/lib/synagogue-settings'

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

// Founder feedback (2026-07-16): no way anywhere to rename an org — surfaced
// while explaining that the "Solutions" org is really Pozna's real client
// (slug `pozne`), just misleadingly named. Slug is deliberately NOT editable
// here — it's baked into the public schedule URL (/s/pozne) and anything
// else already linking to it; renaming that would break existing links.
export async function renameOrg(orgId: string, formData: FormData) {
  const supabase = await requireSuperadmin()
  const name = String(formData.get('name') ?? '').trim()
  if (!name) throw new Error('Name is required')

  const { error } = await supabase.from('orgs').update({ name }).eq('id', orgId)
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

// Founder feedback (2026-07-12): synagogue-schedules' location settings
// (address/timezone/myzmanim id) were seed-only, no UI anywhere to view or
// edit them. No migration needed — org_modules.settings is already a jsonb
// column the superadmin write policy fully covers (the same path
// toggleModule already uses); this is purely a missing form.
export async function updateSynagogueSettings(orgId: string, formData: FormData) {
  const supabase = await requireSuperadmin()
  const settings = parseSynagogueSettingsForm(formData)

  const { error } = await supabase
    .from('org_modules')
    .update({ settings })
    .eq('org_id', orgId)
    .eq('module_key', 'synagogue-schedules')
  if (error) throw new Error(error.message)
  revalidatePath('/console')
}
