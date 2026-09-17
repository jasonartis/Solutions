'use server'

import { revalidatePath } from 'next/cache'
import { DERIVED_SCOPE_PLACEHOLDER, recordActivity } from '@platform/core'
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
  await recordActivity(supabase, { moduleKey: 'matchmaking', action: 'question.created', orgId })
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
  await recordActivity(supabase, { moduleKey: 'matchmaking', action: 'question.approved', orgSlug })
  revalidatePath(`/o/${orgSlug}/m/matchmaking/manage`)
}

export async function rejectQuestion(orgSlug: string, questionId: string) {
  const supabase = await createClient()
  const { error } = await supabase.from('mm_questions').update({ status: 'rejected' }).eq('id', questionId)
  fail(error, 'Reject failed')
  await recordActivity(supabase, { moduleKey: 'matchmaking', action: 'question.rejected', orgSlug })
  revalidatePath(`/o/${orgSlug}/m/matchmaking/manage`)
}

export async function recompute(orgSlug: string) {
  const supabase = await createClient()
  const orgId = await resolveOrgId(supabase, orgSlug)
  await recomputeMatches(supabase, orgId)
  await recordActivity(supabase, { moduleKey: 'matchmaking', action: 'scores.recomputed', orgId })
  revalidatePath(`/o/${orgSlug}/m/matchmaking/manage`)
  revalidatePath(`/o/${orgSlug}/m/matchmaking`)
}

// Resolve an address to a user id, BOUNDED TO THIS ORG by the database
// (docs/22 §3 R5). This replaces a `.eq('email', …)` read of `profiles` plus a
// separate org-membership check in application code.
//
// The old lookup resolved anyone sharing ANY org with the caller
// (profiles_select_shared_org), not just this one — so a matchmaker/group-member
// seat minted from it would hand a non-member of THIS org full access via the
// bare-row mm_matchmaker_can_see / mm_groups_select_assigned /
// mm_group_members_select_assigned predicates (docs/19 §1). `find_module_peer`
// carries that bound itself: it returns an id only for an ACTIVE member of the
// named org. Same replacement as modules/classroom/ui/manage/actions.ts and
// modules/visual-messaging/ui/actions.ts.
// The id-based half of the same bound `find_module_peer` enforces for an
// address: a user id that arrives from a form is client-supplied, so it is
// verified as an ACTIVE member of THIS org before any seat is minted from it —
// the same reason the email lookup was never itself a bound (docs/19 §1).
async function requireActiveOrgMember(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  userId: string,
) {
  const { data: member } = await supabase
    .from('org_members')
    .select('user_id')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle()
  if (!member) {
    throw new Error('That person is not an active member of this organization.')
  }
}

async function resolveOrgMemberUserId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  email: string,
) {
  const { data: peerId } = await supabase.rpc('find_module_peer', {
    check_org_id: orgId,
    target_email: email,
  })
  if (!peerId) {
    throw new Error(
      `No user found with email ${email} in this organization — add them as an org member first (and they must have accepted the invite)`,
    )
  }
  return peerId as string
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
  await recordActivity(supabase, { moduleKey: 'matchmaking', action: 'group.created', orgId })
  revalidatePath(`/o/${orgSlug}/m/matchmaking/manage`)
}

export async function addGroupMember(orgSlug: string, groupId: string, formData: FormData) {
  const email = String(formData.get('email') ?? '').trim()
  if (!email) throw new Error('Email is required')

  const supabase = await createClient()
  const { data: group } = await supabase.from('mm_groups').select('org_id').eq('id', groupId).single()
  if (!group) throw new Error('Group not found')

  const userId = await resolveOrgMemberUserId(supabase, group.org_id, email)
  const { error } = await supabase.from('mm_group_members').insert({
    org_id: DERIVED_SCOPE_PLACEHOLDER, // derived from the group by mm_sync_from_group
    group_id: groupId,
    user_id: userId,
  })
  fail(error, 'Add to group failed')
  await recordActivity(supabase, { moduleKey: 'matchmaking', action: 'group.member_added', orgSlug })
  revalidatePath(`/o/${orgSlug}/m/matchmaking/manage`)
}

export async function removeGroupMember(orgSlug: string, memberId: string) {
  const supabase = await createClient()
  const { error } = await supabase.from('mm_group_members').delete().eq('id', memberId)
  fail(error, 'Remove from group failed')
  await recordActivity(supabase, { moduleKey: 'matchmaking', action: 'group.member_removed', orgSlug })
  revalidatePath(`/o/${orgSlug}/m/matchmaking/manage`)
}

export async function assignMatchmaker(orgSlug: string, formData: FormData) {
  // The form now submits USER IDS, not email addresses (docs/22 §7.2): the
  // picker picks a person out of this org's own matchmakers/singles, so there
  // is nothing to resolve. Both ids are still verified as ACTIVE members of
  // THIS org below — a <select> is a client-side control and confers no
  // authority, and mm_matchmaker_assignments' RLS is the real gate either way.
  const matchmakerId = String(formData.get('matchmakerId') ?? '').trim()
  const targetType = String(formData.get('targetType') ?? '') as 'individual' | 'group'
  const submittedTargetUserId = String(formData.get('targetUserId') ?? '').trim()
  const targetGroupId = String(formData.get('targetGroupId') ?? '').trim()
  if (!matchmakerId) throw new Error('A matchmaker is required')
  if (targetType === 'individual' && !submittedTargetUserId) throw new Error('A target single is required')
  if (targetType === 'group' && !targetGroupId) throw new Error('Target group is required')

  const supabase = await createClient()
  const orgId = await resolveOrgId(supabase, orgSlug)
  await requireActiveOrgMember(supabase, orgId, matchmakerId)
  const targetUserId = targetType === 'individual' ? submittedTargetUserId : null
  if (targetUserId) await requireActiveOrgMember(supabase, orgId, targetUserId)

  const { error } = await supabase.from('mm_matchmaker_assignments').insert({
    org_id: orgId, // group-target rows get this overwritten by mm_sync_assignment_org
    matchmaker_id: matchmakerId,
    target_type: targetType,
    target_user_id: targetUserId,
    target_group_id: targetType === 'group' ? targetGroupId : null,
  })
  fail(error, 'Assign matchmaker failed')
  await recordActivity(supabase, { moduleKey: 'matchmaking', action: 'matchmaker.assigned', orgId })
  revalidatePath(`/o/${orgSlug}/m/matchmaking/manage`)
}

export async function removeAssignment(orgSlug: string, assignmentId: string) {
  const supabase = await createClient()
  const { error } = await supabase.from('mm_matchmaker_assignments').delete().eq('id', assignmentId)
  fail(error, 'Remove assignment failed')
  await recordActivity(supabase, { moduleKey: 'matchmaking', action: 'matchmaker.unassigned', orgSlug })
  revalidatePath(`/o/${orgSlug}/m/matchmaking/manage`)
}
