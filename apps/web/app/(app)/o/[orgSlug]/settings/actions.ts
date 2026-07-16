'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { parseSynagogueSettingsForm } from '@/lib/synagogue-settings'

// Org-admin module-settings actions (founder item 2, 2026-07-12: "whoever
// fills in the synagogue info should enter it" — module CONFIG is org
// self-serve; module ENABLEMENT stays superadmin-only). The action re-checks
// is_org_admin itself, matching the members/actions.ts convention; RLS
// (org_modules_update_org_admin + the org_modules_pin_enablement trigger) is
// the real ceiling — even a forged request can only ever change `settings`.
async function requireOrgAdminBySlug(orgSlug: string) {
  const supabase = await createClient()
  const { data: org } = await supabase.from('orgs').select('id').eq('slug', orgSlug).single()
  if (!org) throw new Error('Org not found')
  const { data: isAdmin } = await supabase.rpc('is_org_admin', { check_org_id: org.id })
  if (!isAdmin) throw new Error('Not authorized')
  return { supabase, orgId: org.id as string }
}

export async function updateModuleSettings(orgSlug: string, moduleKey: string, formData: FormData) {
  const { supabase, orgId } = await requireOrgAdminBySlug(orgSlug)

  // Per-module form parsing — only synagogue-schedules has editable settings
  // so far; add a case here when another module grows a settings form.
  if (moduleKey !== 'synagogue-schedules') throw new Error('This module has no editable settings')
  const settings = parseSynagogueSettingsForm(formData)

  const { error } = await supabase
    .from('org_modules')
    .update({ settings })
    .eq('org_id', orgId)
    .eq('module_key', moduleKey)
  if (error) throw new Error(error.message)
  revalidatePath(`/o/${orgSlug}/settings`)
}
