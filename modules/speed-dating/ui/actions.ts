'use server'

import { revalidatePath } from 'next/cache'
import { DERIVED_SCOPE_PLACEHOLDER } from '@platform/core'
import { buildNextRound } from '@modules/speed-dating'
import { createClient } from '@/lib/supabase/server'

// Speed-dating actions. RLS + the sd_ guard triggers are the enforcement
// layer (organize-write for event control, insert-self/pins for participants,
// the sd_interest privacy chain for marks). The pairing "round" here is an
// organizer-run stand-in for the speeddating.event-orchestrator worker —
// same pattern as matchmaking's manual recompute (documented in CLAUDE.md);
// it pairs sequential unpaired participants once, ignoring pool sides, and
// will be replaced by the real rotation engine when the worker deploys.

function fail(error: { message: string } | null, what: string) {
  if (error) throw new Error(`${what}: ${error.message}`)
}

async function resolveOrgId(supabase: Awaited<ReturnType<typeof createClient>>, orgSlug: string) {
  const { data: org } = await supabase.from('orgs').select('id').eq('slug', orgSlug).single()
  if (!org) throw new Error('Org not found')
  return org.id as string
}

export async function createEvent(orgSlug: string, formData: FormData) {
  const name = String(formData.get('name') ?? '').trim()
  const scheduledAt = String(formData.get('scheduledAt') ?? '').trim()
  const resumeReview = formData.get('resumeReview') === 'on'
  if (!name) throw new Error('Event name is required')

  const supabase = await createClient()
  const orgId = await resolveOrgId(supabase, orgSlug)
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { error } = await supabase.from('sd_events').insert({
    org_id: orgId,
    name,
    scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
    resume_review_enabled: resumeReview,
    created_by: user?.id ?? null,
  })
  fail(error, 'Create event failed')
  revalidatePath(`/o/${orgSlug}/m/speed-dating`)
}

// Resume-review profile card (spec: an opt-in event format where participants
// see each other's short profile instead of going in blind). Self-only write
// (RLS's sd_participants_update_self, pinned to a handful of columns
// including profile_card); readable by staff + anyone paired with you
// (sd_paired_with) once you've actually met.
export async function saveProfileCard(orgSlug: string, eventId: string, participantId: string, formData: FormData) {
  const profileCard = String(formData.get('profileCard') ?? '').trim().slice(0, 1000)
  const supabase = await createClient()
  const { error } = await supabase.from('sd_participants').update({ profile_card: profileCard }).eq('id', participantId)
  fail(error, 'Save profile card failed')
  revalidatePath(`/o/${orgSlug}/m/speed-dating/events/${eventId}`)
}

export async function setEventState(orgSlug: string, eventId: string, state: string) {
  const supabase = await createClient()
  const { error } = await supabase.from('sd_events').update({ state }).eq('id', eventId)
  fail(error, `Move event to ${state} failed`)
  revalidatePath(`/o/${orgSlug}/m/speed-dating`)
  revalidatePath(`/o/${orgSlug}/m/speed-dating/events/${eventId}`)
}

export async function registerForEvent(orgSlug: string, eventId: string) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')

  const { error } = await supabase.from('sd_participants').insert({
    org_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
    event_id: eventId,
    user_id: user.id,
  })
  fail(error, 'Registration failed')
  revalidatePath(`/o/${orgSlug}/m/speed-dating/events/${eventId}`)
}

export async function withdrawFromEvent(orgSlug: string, participantId: string, eventId: string) {
  const supabase = await createClient()
  const { error } = await supabase
    .from('sd_participants')
    .update({ status: 'withdrawn' })
    .eq('id', participantId)
  fail(error, 'Withdraw failed')
  revalidatePath(`/o/${orgSlug}/m/speed-dating/events/${eventId}`)
}

// Manual "run next round" (organizer override / demo path). Uses the REAL
// rotation engine (@modules/speed-dating): pool sides, event history, and the
// allow-repeats setting are honored. CAVEAT: sd_blocks rows are only visible
// to the blocker and the manage tier under RLS — a mere organizer's manual
// round may not see them; the WORKER orchestrator (service role) is the
// authoritative path and always honors blocks. Guard triggers enforce the
// hard invariants regardless (single active round, no double-booking).
export async function runPairingRound(orgSlug: string, eventId: string) {
  const supabase = await createClient()

  const [{ data: event }, { data: rounds }, { data: participants }, { data: pairings }] =
    await Promise.all([
      supabase.from('sd_events').select('org_id, allow_repeat_pairings').eq('id', eventId).single(),
      supabase.from('sd_rounds').select('id, round_number, state').eq('event_id', eventId),
      supabase
        .from('sd_participants')
        .select('id, user_id, pool_side')
        .eq('event_id', eventId)
        .eq('status', 'registered')
        .eq('seat_type', 'participant')
        .order('created_at'),
      supabase
        .from('sd_pairings')
        .select('participant_a_id, participant_b_id')
        .eq('event_id', eventId),
    ])
  if (!event) throw new Error('Event not found')

  const seatUsers = (participants ?? []).map((p) => p.user_id)
  const { data: blocks } = seatUsers.length
    ? await supabase
        .from('sd_blocks')
        .select('blocker_user_id, blocked_user_id')
        .eq('org_id', event.org_id)
        .in('blocker_user_id', seatUsers)
    : { data: [] }

  const plan = buildNextRound({
    seats: (participants ?? []).map((p) => ({ id: p.id, userId: p.user_id, poolSide: p.pool_side })),
    history: (pairings ?? [])
      .filter((p) => p.participant_b_id !== null)
      .map((p) => ({ a: p.participant_a_id, b: p.participant_b_id! })),
    blockedUserPairs: (blocks ?? []).map((b) => ({ a: b.blocker_user_id, b: b.blocked_user_id })),
    allowRepeats: event.allow_repeat_pairings,
    roundNumber: (rounds ?? []).length,
  })
  if (!plan) throw new Error('Rotation complete — everyone has met. Complete the event.')

  // Close any active round first (active -> complete is a legal transition).
  for (const r of rounds ?? []) {
    if (r.state === 'active') {
      const { error } = await supabase.from('sd_rounds').update({ state: 'complete' }).eq('id', r.id)
      fail(error, 'Close previous round failed')
    }
  }

  const nextNumber = Math.max(0, ...(rounds ?? []).map((r) => r.round_number)) + 1
  const { data: round, error: roundErr } = await supabase
    .from('sd_rounds')
    .insert({
      org_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
      event_id: eventId,
      round_number: nextNumber,
      state: 'pending',
      starts_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  fail(roundErr, 'Create round failed')

  for (const p of plan.pairs) {
    const { error } = await supabase.from('sd_pairings').insert({
      org_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
      event_id: eventId,
      round_id: round!.id,
      participant_a_id: p.a,
      participant_b_id: p.b,
    })
    fail(error, 'Create pairing failed')
  }

  const { error: activateErr } = await supabase
    .from('sd_rounds')
    .update({ state: 'active' })
    .eq('id', round!.id)
  fail(activateErr, 'Activate round failed')

  revalidatePath(`/o/${orgSlug}/m/speed-dating/events/${eventId}`)
}

export async function markInterest(
  orgSlug: string,
  eventId: string,
  raterParticipantId: string,
  targetParticipantId: string,
  verdict: 'interested' | 'not_interested' | 'no_show',
) {
  const supabase = await createClient()
  // One mark per (rater, target): update in place on re-mark.
  const { data: existing } = await supabase
    .from('sd_interest')
    .select('id')
    .eq('rater_participant_id', raterParticipantId)
    .eq('target_participant_id', targetParticipantId)
    .maybeSingle()

  const { error } = existing
    ? await supabase.from('sd_interest').update({ verdict }).eq('id', existing.id)
    : await supabase.from('sd_interest').insert({
        org_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
        event_id: eventId,
        rater_participant_id: raterParticipantId,
        target_participant_id: targetParticipantId,
        verdict,
      })
  fail(error, 'Record interest failed')
  revalidatePath(`/o/${orgSlug}/m/speed-dating/events/${eventId}`)
}

export async function revealMatches(orgSlug: string, eventId: string) {
  const supabase = await createClient()
  const { error } = await supabase.rpc('sd_reveal_matches', { check_event_id: eventId })
  fail(error, 'Reveal failed')
  revalidatePath(`/o/${orgSlug}/m/speed-dating/events/${eventId}`)
}

// Private notepad (spec: strictly author-only, never visible to organizers —
// sd_notes_all_own is the only policy on the table). One row per
// (event, author, about); a re-save updates it in place.
export async function saveNote(orgSlug: string, eventId: string, aboutUserId: string, formData: FormData) {
  const body = String(formData.get('body') ?? '').trim()
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')

  const { data: existing } = await supabase
    .from('sd_notes')
    .select('id')
    .eq('event_id', eventId)
    .eq('author_user_id', user.id)
    .eq('about_user_id', aboutUserId)
    .maybeSingle()

  const { error } = existing
    ? await supabase.from('sd_notes').update({ body }).eq('id', existing.id)
    : await supabase.from('sd_notes').insert({
        org_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
        event_id: eventId,
        author_user_id: user.id,
        about_user_id: aboutUserId,
        body,
      })
  fail(error, 'Save note failed')
  revalidatePath(`/o/${orgSlug}/m/speed-dating/events/${eventId}`)
}

// Safety report on an encounter. The reported person never has a read path
// (RLS) — this is reporter + staff_event tier only.
export async function fileReport(
  orgSlug: string,
  eventId: string,
  reporterParticipantId: string,
  reportedParticipantId: string,
  formData: FormData,
) {
  const reason = String(formData.get('reason') ?? '').trim()
  const detail = String(formData.get('detail') ?? '').trim()
  if (!reason) throw new Error('A reason is required')

  const supabase = await createClient()
  const { error } = await supabase.from('sd_reports').insert({
    org_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
    event_id: eventId,
    reporter_participant_id: reporterParticipantId,
    reported_participant_id: reportedParticipantId,
    reason,
    detail: detail || null,
  })
  fail(error, 'Report failed')
  revalidatePath(`/o/${orgSlug}/m/speed-dating/events/${eventId}`)
}

// Host/organizer triage. sd_pin_report stamps reviewed_by/reviewed_at
// server-side on any state change — this only ever touches `state`.
export async function reviewReport(
  orgSlug: string,
  eventId: string,
  reportId: string,
  state: 'reviewed' | 'actioned' | 'dismissed',
) {
  const supabase = await createClient()
  const { error } = await supabase.from('sd_reports').update({ state }).eq('id', reportId)
  fail(error, 'Review report failed')
  revalidatePath(`/o/${orgSlug}/m/speed-dating/events/${eventId}`)
}

// Personal, cross-event block list (spec: "never pair me with them again").
// A root table — org_id is client-supplied (no parent row to derive it from);
// RLS's write policy re-checks org membership. Idempotent: blocking twice is
// a no-op rather than a raw unique-constraint error.
export async function blockUser(orgSlug: string, blockedUserId: string, formData: FormData) {
  const reason = String(formData.get('reason') ?? '').trim()
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')
  const orgId = await resolveOrgId(supabase, orgSlug)

  const { data: existing } = await supabase
    .from('sd_blocks')
    .select('id')
    .eq('org_id', orgId)
    .eq('blocker_user_id', user.id)
    .eq('blocked_user_id', blockedUserId)
    .maybeSingle()
  if (existing) {
    revalidatePath(`/o/${orgSlug}/m/speed-dating`)
    return
  }

  const { error } = await supabase.from('sd_blocks').insert({
    org_id: orgId,
    blocker_user_id: user.id,
    blocked_user_id: blockedUserId,
    reason: reason || null,
  })
  fail(error, 'Block failed')
  revalidatePath(`/o/${orgSlug}/m/speed-dating`)
}

export async function unblockUser(orgSlug: string, blockId: string) {
  const supabase = await createClient()
  const { error } = await supabase.from('sd_blocks').delete().eq('id', blockId)
  fail(error, 'Unblock failed')
  revalidatePath(`/o/${orgSlug}/m/speed-dating`)
}
