'use server'

import { revalidatePath } from 'next/cache'
import { DERIVED_SCOPE_PLACEHOLDER } from '@platform/core'
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

async function resolveUserId(supabase: Awaited<ReturnType<typeof createClient>>, email: string) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('user_id')
    .eq('email', email.trim().toLowerCase())
    .maybeSingle()
  if (!profile) throw new Error(`No user with email ${email}`)
  return profile.user_id as string
}

// Groups + matchmaker assignments (RLS: mm_can_manage's staff `for all`
// policy gates every write here — admin-only, matching the page gate). A
// matchmaker's own view relies entirely on these rows existing (RLS scopes
// mm_pair_scores to singles they're assigned to, individually or via group).
export async function createGroup(orgSlug: string, formData: FormData) {
  const name = String(formData.get('name') ?? '').trim()
  if (!name) throw new Error('Group name is required')

  const supabase = await createClient()
  const orgId = await resolveOrgId(supabase, orgSlug)
  const { error } = await supabase.from('mm_groups').insert({ org_id: orgId, name })
  fail(error, 'Create group failed')
  revalidatePath(`/o/${orgSlug}/m/matchmaking/manage`)
}

export async function addGroupMember(orgSlug: string, groupId: string, formData: FormData) {
  const email = String(formData.get('email') ?? '').trim()
  if (!email) throw new Error('Email is required')

  const supabase = await createClient()
  const userId = await resolveUserId(supabase, email)
  const { error } = await supabase.from('mm_group_members').insert({
    org_id: DERIVED_SCOPE_PLACEHOLDER, // derived from the group by mm_sync_from_group
    group_id: groupId,
    user_id: userId,
  })
  fail(error, 'Add to group failed')
  revalidatePath(`/o/${orgSlug}/m/matchmaking/manage`)
}

export async function removeGroupMember(orgSlug: string, memberId: string) {
  const supabase = await createClient()
  const { error } = await supabase.from('mm_group_members').delete().eq('id', memberId)
  fail(error, 'Remove from group failed')
  revalidatePath(`/o/${orgSlug}/m/matchmaking/manage`)
}

export async function assignMatchmaker(orgSlug: string, formData: FormData) {
  const matchmakerEmail = String(formData.get('matchmakerEmail') ?? '').trim()
  const targetType = String(formData.get('targetType') ?? '') as 'individual' | 'group'
  const targetEmail = String(formData.get('targetEmail') ?? '').trim()
  const targetGroupId = String(formData.get('targetGroupId') ?? '').trim()
  if (!matchmakerEmail) throw new Error('Matchmaker email is required')
  if (targetType === 'individual' && !targetEmail) throw new Error('Target single email is required')
  if (targetType === 'group' && !targetGroupId) throw new Error('Target group is required')

  const supabase = await createClient()
  const orgId = await resolveOrgId(supabase, orgSlug)
  const matchmakerId = await resolveUserId(supabase, matchmakerEmail)
  const targetUserId = targetType === 'individual' ? await resolveUserId(supabase, targetEmail) : null

  const { error } = await supabase.from('mm_matchmaker_assignments').insert({
    org_id: orgId, // group-target rows get this overwritten by mm_sync_assignment_org
    matchmaker_id: matchmakerId,
    target_type: targetType,
    target_user_id: targetUserId,
    target_group_id: targetType === 'group' ? targetGroupId : null,
  })
  fail(error, 'Assign matchmaker failed')
  revalidatePath(`/o/${orgSlug}/m/matchmaking/manage`)
}

export async function removeAssignment(orgSlug: string, assignmentId: string) {
  const supabase = await createClient()
  const { error } = await supabase.from('mm_matchmaker_assignments').delete().eq('id', assignmentId)
  fail(error, 'Remove assignment failed')
  revalidatePath(`/o/${orgSlug}/m/matchmaking/manage`)
}
