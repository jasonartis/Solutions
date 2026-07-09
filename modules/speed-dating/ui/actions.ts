'use server'

import { revalidatePath } from 'next/cache'
import { DERIVED_SCOPE_PLACEHOLDER } from '@platform/core'
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
    created_by: user?.id ?? null,
  })
  fail(error, 'Create event failed')
  revalidatePath(`/o/${orgSlug}/m/speed-dating`)
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

// ORCHESTRATOR STAND-IN: create the next round and pair every unpaired
// registered participant sequentially (one meeting each). The real rotation
// engine (worker) honors pool sides, blocks, and repeat settings; the guard
// triggers still enforce the hard invariants here (single active round,
// no double-booking within a round).
export async function runPairingRound(orgSlug: string, eventId: string) {
  const supabase = await createClient()

  const [{ data: rounds }, { data: participants }] = await Promise.all([
    supabase.from('sd_rounds').select('id, round_number, state').eq('event_id', eventId),
    supabase
      .from('sd_participants')
      .select('id')
      .eq('event_id', eventId)
      .eq('status', 'registered')
      .eq('seat_type', 'participant')
      .order('created_at'),
  ])

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

  const seats = (participants ?? []).map((p) => p.id)
  const rows = []
  for (let i = 0; i + 1 < seats.length; i += 2) {
    rows.push({
      org_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
      event_id: eventId,
      round_id: round!.id,
      participant_a_id: seats[i]!,
      participant_b_id: seats[i + 1]!,
    })
  }
  if (seats.length % 2 === 1) {
    rows.push({
      org_id: DERIVED_SCOPE_PLACEHOLDER,
      event_id: eventId,
      round_id: round!.id,
      participant_a_id: seats[seats.length - 1]!,
      participant_b_id: null, // bye
    })
  }
  for (const row of rows) {
    const { error } = await supabase.from('sd_pairings').insert(row)
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
