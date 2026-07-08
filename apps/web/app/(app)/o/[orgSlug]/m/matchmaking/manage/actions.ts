'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { recomputeMatches } from '@/lib/matchmaking'

// Admin actions. RLS (mm_can_manage → the staff `for all` policy) gates every
// write; these just shape the input. org_id is resolved from the slug here
// rather than trusted from the client.

function fail(error: { message: string } | null, what: string) {
  if (error) throw new Error(`${what}: ${error.message}`)
}

async function resolveOrgId(supabase: Awaited<ReturnType<typeof createClient>>, orgSlug: string) {
  const { data: org } = await supabase.from('orgs').select('id').eq('slug', orgSlug).single()
  if (!org) throw new Error('Org not found')
  return org.id as string
}

export async function createQuestion(orgSlug: string, formData: FormData) {
  const text = String(formData.get('text') ?? '').trim()
  const labels = String(formData.get('labels') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!text) throw new Error('Question text is required')
  if (labels.length < 2 || labels.length > 5) throw new Error('Provide 2–5 scale labels')

  const locks: { care?: number; dealbreaker?: boolean; answer?: number } = {}
  const careLock = formData.get('lockCare')
  if (careLock !== null && String(careLock).trim() !== '') {
    const c = Number(careLock)
    if (Number.isNaN(c) || c < -10 || c > 10) throw new Error('Care lock must be −10..10')
    locks.care = c
  }
  if (formData.get('lockDealbreaker') === 'on') locks.dealbreaker = true

  const supabase = await createClient()
  const orgId = await resolveOrgId(supabase, orgSlug)
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { error } = await supabase.from('mm_questions').insert({
    org_id: orgId,
    text,
    scale_labels: labels,
    admin_locks: locks,
    status: 'approved', // admin-authored questions are live immediately
    submitted_by: user?.id ?? null,
    approved_by: user?.id ?? null,
    approved_at: new Date().toISOString(),
  })
  fail(error, 'Create question failed')
  revalidatePath(`/o/${orgSlug}/m/matchmaking/manage`)
}

export async function approveQuestion(orgSlug: string, questionId: string) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase
    .from('mm_questions')
    .update({ status: 'approved', approved_by: user?.id ?? null, approved_at: new Date().toISOString() })
    .eq('id', questionId)
  fail(error, 'Approve failed')
  revalidatePath(`/o/${orgSlug}/m/matchmaking/manage`)
}

export async function rejectQuestion(orgSlug: string, questionId: string) {
  const supabase = await createClient()
  const { error } = await supabase.from('mm_questions').update({ status: 'rejected' }).eq('id', questionId)
  fail(error, 'Reject failed')
  revalidatePath(`/o/${orgSlug}/m/matchmaking/manage`)
}

export async function recompute(orgSlug: string) {
  const supabase = await createClient()
  const orgId = await resolveOrgId(supabase, orgSlug)
  await recomputeMatches(supabase, orgId)
  revalidatePath(`/o/${orgSlug}/m/matchmaking/manage`)
  revalidatePath(`/o/${orgSlug}/m/matchmaking`)
}
