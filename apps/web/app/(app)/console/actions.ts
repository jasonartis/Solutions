'use server'

import { revalidatePath } from 'next/cache'
import { moduleRegistry } from '@platform/core'
import { createClient } from '@/lib/supabase/server'

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

export async function addMember(formData: FormData) {
  const supabase = await requireSuperadmin()
  const orgId = String(formData.get('orgId') ?? '')
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase()
  const role = String(formData.get('role') ?? 'member')
  if (!orgId || !email) throw new Error('Org and email are required')

  const { data: profile } = await supabase
    .from('profiles')
    .select('user_id')
    .eq('email', email)
    .single()
  if (!profile) throw new Error(`No user found with email ${email} — they must sign up first`)

  const { error } = await supabase
    .from('org_members')
    .upsert({ org_id: orgId, user_id: profile.user_id, role })
  if (error) throw new Error(error.message)
  revalidatePath('/console')
}

export async function removeMember(orgId: string, userId: string) {
  const supabase = await requireSuperadmin()
  const { error } = await supabase
    .from('org_members')
    .delete()
    .eq('org_id', orgId)
    .eq('user_id', userId)
  if (error) throw new Error(error.message)
  revalidatePath('/console')
}
