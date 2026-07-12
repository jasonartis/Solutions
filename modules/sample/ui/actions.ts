'use server'

// TEMPLATE (module 0). Server actions live INSIDE the module folder; the app
// only mounts the page. Conventions on display:
//   - DERIVED_SCOPE_PLACEHOLDER for child-table inserts (the scope-sync
//     trigger derives the real org_id server-side — docs/03 #10)
//   - actions run as the signed-in user under RLS; never the service-role key
//     (docs/03 #14)

import { revalidatePath } from 'next/cache'
import { DERIVED_SCOPE_PLACEHOLDER } from '@platform/core'
import { createClient } from '@/lib/supabase/server'

function fail(error: { message: string } | null, what: string) {
  if (error) throw new Error(`${what}: ${error.message}`)
}

// Root-table insert: org_id is resolved server-side from the slug (never
// trusted from the client); the staff RLS write gate does the rest.
export async function createProject(orgSlug: string, formData: FormData) {
  const name = String(formData.get('name') ?? '').trim()
  if (!name) throw new Error('Name is required')

  const supabase = await createClient()
  const { data: org } = await supabase.from('orgs').select('id').eq('slug', orgSlug).single()
  if (!org) throw new Error('Org not found')

  const { error } = await supabase.from('smp_projects').insert({ org_id: org.id, name })
  fail(error, 'Create project failed')
  revalidatePath(`/o/${orgSlug}/m/sample`)
}

// Child-table insert: only the parent FK is sent; the scope-sync trigger
// derives org_id. author_id must be the caller (RLS insert policy).
export async function addItem(orgSlug: string, projectId: string, formData: FormData) {
  const body = String(formData.get('body') ?? '').trim()
  if (!body) throw new Error('Item text is required')

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')

  const { error } = await supabase.from('smp_items').insert({
    org_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
    project_id: projectId,
    author_id: user.id,
    body,
  })
  fail(error, 'Add item failed')
  revalidatePath(`/o/${orgSlug}/m/sample`)
}

export async function toggleItem(orgSlug: string, itemId: string, done: boolean) {
  const supabase = await createClient()
  const { error } = await supabase.from('smp_items').update({ done }).eq('id', itemId)
  fail(error, 'Toggle failed')
  revalidatePath(`/o/${orgSlug}/m/sample`)
}

// Founder feedback (2026-07-11): created a project by mistake (a duplicate
// name) and had no way to remove it. RLS already allows staff to delete
// (smp_projects_write_staff is `for all`) — this was purely a missing
// action + button, not a permissions gap. Deliberately NOT adding a
// name-uniqueness constraint alongside this: duplicate names are a
// legitimate real case (two genuinely different projects can share a
// name), and delete is the right fix for "I made a mistake," not a
// database constraint preventing a valid state.
export async function deleteProject(orgSlug: string, projectId: string) {
  const supabase = await createClient()
  const { error } = await supabase.from('smp_projects').delete().eq('id', projectId)
  fail(error, 'Delete project failed')
  revalidatePath(`/o/${orgSlug}/m/sample`)
}
