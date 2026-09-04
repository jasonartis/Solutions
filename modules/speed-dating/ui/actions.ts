'use server'

import { revalidatePath } from 'next/cache'
import { DERIVED_SCOPE_PLACEHOLDER, recordActivity } from '@platform/core'
import { authorizeVideoJoin, buildNextRound, getVideoProvider, tryCreateVideoRoom } from '@modules/speed-dating'
import { createClient } from '@/lib/supabase/server'
import { getEventSides, getShareContactOnMatch, parseEventFormat, type SideKey } from './event-format'

// Speed-dating actions. RLS + the sd_ guard triggers are the enforcement
// layer (organize-write for event control, insert-self/pins for participants,
// the sd_interest privacy chain for marks). The pairing "round" here is an
// organizer-run MANUAL trigger, run in parallel with (not superseded by) the
// speeddating.event-orchestrator worker job (apps/worker/src/jobs/speed-
// dating-orchestrator.ts, registered in apps/worker/src/index.ts) — CORRECTED
// 2026-08-16, an independent review found this comment stale: the worker
// orchestrator is already built and live, not a future thing this button is a
// placeholder for. The two paths share no code that writes (each has its own
// insert/update sequence) but do share the same pure computation
// (buildNextRound/rotationExhausted from @modules/speed-dating), so a manually
// -run round and a worker-run one produce an equivalent result. This function
// pairs sequential unpaired participants once, ignoring pool sides.

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
  const format = parseEventFormat(formData)

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
    format,
    created_by: user?.id ?? null,
  })
  fail(error, 'Create event failed')
  await recordActivity(supabase, { moduleKey: 'speed-dating', action: 'event.created', orgSlug })
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

// Two-sided events (opt-in, set at event creation — see event-format.ts):
// the participant picks their side; a registration past that side's capacity
// lands as 'waitlisted' instead of 'registered' (both allowed by
// sd_participants_insert_self's WITH CHECK — RLS trusts the app to compute
// the right status, per that policy's own INTEGRATION NOTE). Single-pool
// events (no sides configured) are unaffected: no side param, always
// 'registered', matching the previous behavior exactly.
//
// The registered-count-on-a-side goes through the sd_side_registered_count
// definer RPC (20260716020000): a fresh registrant's own RLS session can
// only see their own participant row, so a direct count would see 0 others
// and the capacity check would never trigger — the RPC returns just the
// number (never the rows/identities), matching sal_worker_has_time_off.
// NOTE: the check-then-insert isn't race-proof (two people racing for the
// last spot could both land 'registered') — acceptable at this scale, the
// same tolerance the platform's other booking flows already have.
export async function registerForEvent(orgSlug: string, eventId: string, formData: FormData) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')

  const { data: event } = await supabase.from('sd_events').select('format').eq('id', eventId).single()
  const sides = getEventSides(event?.format)

  let poolSide: SideKey | null = null
  let status: 'registered' | 'waitlisted' = 'registered'

  if (sides) {
    const chosen = String(formData.get('side') ?? '')
    if (chosen !== 'a' && chosen !== 'b') throw new Error('Choose a side to register for')
    poolSide = chosen
    const capacity = sides[chosen].capacity
    if (capacity !== null) {
      const { data: registeredCount, error: countErr } = await supabase.rpc('sd_side_registered_count', {
        check_event_id: eventId,
        check_side: chosen,
      })
      if (countErr) throw new Error(`Capacity check failed: ${countErr.message}`)
      if ((registeredCount ?? 0) >= capacity) status = 'waitlisted'
    }
  }

  const { error } = await supabase.from('sd_participants').insert({
    org_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
    event_id: eventId,
    user_id: user.id,
    pool_side: poolSide,
    status,
  })
  fail(error, 'Registration failed')
  await recordActivity(supabase, { moduleKey: 'speed-dating', action: 'event.registered', orgSlug })
  revalidatePath(`/o/${orgSlug}/m/speed-dating/events/${eventId}`)
}

export async function withdrawFromEvent(orgSlug: string, participantId: string, eventId: string) {
  const supabase = await createClient()
  const { error } = await supabase
    .from('sd_participants')
    .update({ status: 'withdrawn' })
    .eq('id', participantId)
  fail(error, 'Withdraw failed')
  // Promotion needs staff-level write (RLS: a participant can only update
  // their OWN row — sd_participants_update_self is `user_id = auth.uid()`,
  // so a withdrawing participant cannot write a different waitlisted
  // person's row). Automatic promotion is staff-button/worker-tick driven
  // (promoteNextWaitlisted below), not triggered from here.
  revalidatePath(`/o/${orgSlug}/m/speed-dating/events/${eventId}`)
}

// Staff action: promote the longest-waiting person on a side into the seat
// a withdrawal/removal just freed. Re-checks capacity itself (rather than
// trusting the caller that a slot is actually open) so it's safe to call at
// any time, including from a future automatic worker tick using the exact
// same function shape as speed-dating-orchestrator.ts.
export async function promoteNextWaitlisted(orgSlug: string, eventId: string, poolSide: SideKey) {
  const supabase = await createClient()
  const { data: event } = await supabase.from('sd_events').select('format').eq('id', eventId).single()
  const sides = getEventSides(event?.format)
  const capacity = sides?.[poolSide]?.capacity ?? null

  if (capacity !== null) {
    // Same definer RPC as registration — a single source of truth for
    // "how many are registered on this side". (A staff caller could count
    // directly, but routing through the RPC keeps one code path.)
    const { data: registeredCount } = await supabase.rpc('sd_side_registered_count', {
      check_event_id: eventId,
      check_side: poolSide,
    })
    if ((registeredCount ?? 0) >= capacity) return // no room; nothing to do
  }

  const { data: next } = await supabase
    .from('sd_participants')
    .select('id')
    .eq('event_id', eventId)
    .eq('pool_side', poolSide)
    .eq('status', 'waitlisted')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!next) return

  const { error } = await supabase.from('sd_participants').update({ status: 'registered' }).eq('id', next.id)
  fail(error, 'Promote from waitlist failed')
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
      supabase.from('sd_events').select('org_id, allow_repeat_pairings, round_duration_seconds').eq('id', eventId).single(),
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
  // ends_at mirrors the orchestrator's own round creation (speed-dating-
  // orchestrator.ts) — without it, a manually-run round has no expiry for
  // the "Right now" panel's countdown to key off (this manual trigger runs in
  // parallel with the worker, so it should produce an equivalent round).
  const startsAt = new Date()
  const endsAt = new Date(startsAt.getTime() + event.round_duration_seconds * 1000)
  const { data: round, error: roundErr } = await supabase
    .from('sd_rounds')
    .insert({
      org_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
      event_id: eventId,
      round_number: nextNumber,
      state: 'pending',
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
    })
    .select('id')
    .single()
  fail(roundErr, 'Create round failed')

  for (const p of plan.pairs) {
    // Mirrors the orchestrator's own room stamping (speed-dating-
    // orchestrator.ts) — same tolerant-of-unconfigured-video behavior, so a
    // manually-run round produces an equivalent pairing row.
    const room = p.b ? await tryCreateVideoRoom({ eventId, roundId: round!.id }) : null
    const { error } = await supabase.from('sd_pairings').insert({
      org_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
      event_id: eventId,
      round_id: round!.id,
      participant_a_id: p.a,
      participant_b_id: p.b,
      room_ref: room?.roomRef ?? null,
      room_provider: room?.provider ?? null,
    })
    fail(error, 'Create pairing failed')
  }

  const { error: activateErr } = await supabase
    .from('sd_rounds')
    .update({ state: 'active' })
    .eq('id', round!.id)
  fail(activateErr, 'Activate round failed')

  await recordActivity(supabase, { moduleKey: 'speed-dating', action: 'pairing_round.run', orgSlug })
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
  await recordActivity(supabase, { moduleKey: 'speed-dating', action: 'round.interest_marked', orgSlug })
  revalidatePath(`/o/${orgSlug}/m/speed-dating/events/${eventId}`)
}

// Contact-share population (spec: "contact shared per user preferences or
// organizer designation for the event" — there is no per-user preference
// column in v1, per the schema's own header note, so the event's
// shareContactOnMatch toggle IS the whole mechanism). Runs AS THE ORGANIZER,
// after sd_reveal_matches has flipped revealed=true — sd_matches has a real
// client-side "for all" organize-write policy (sd_matches_write_organize,
// gated on sd_can_organize), so this is an ordinary RLS-enforced UPDATE, not
// a definer bypass. Idempotent: only touches matches whose contact_shared is
// still the RPC's empty default, so re-running reveal (e.g. after more
// matches land) never clobbers an already-populated row.
async function populateContactShare(supabase: Awaited<ReturnType<typeof createClient>>, eventId: string) {
  const { data: matches, error: matchesErr } = await supabase
    .from('sd_matches')
    .select('id, participant_a_id, participant_b_id, contact_shared')
    .eq('event_id', eventId)
    .eq('revealed', true)
  fail(matchesErr, 'Read matches for contact-share failed')
  const pending = (matches ?? []).filter((m) => !m.contact_shared || Object.keys(m.contact_shared).length === 0)
  if (pending.length === 0) return

  const seatIds = [...new Set(pending.flatMap((m) => [m.participant_a_id, m.participant_b_id]))]
  const { data: seats, error: seatsErr } = await supabase.from('sd_participants').select('id, user_id').in('id', seatIds)
  fail(seatsErr, 'Read participants for contact-share failed')
  const userOfSeat = new Map((seats ?? []).map((s) => [s.id, s.user_id as string]))

  const userIds = [...new Set([...userOfSeat.values()])]
  const { data: profiles, error: profilesErr } = await supabase
    .from('profiles')
    .select('user_id, display_name, email')
    .in('user_id', userIds)
  fail(profilesErr, 'Read profiles for contact-share failed')
  const profileOfUser = new Map((profiles ?? []).map((p) => [p.user_id, p]))

  const errors: string[] = []
  for (const m of pending) {
    const userA = userOfSeat.get(m.participant_a_id)
    const userB = userOfSeat.get(m.participant_b_id)
    if (!userA || !userB) continue // a seat RLS hid or that vanished — skip, don't guess
    const contactFor = (userId: string) => {
      const p = profileOfUser.get(userId)
      return { displayName: p?.display_name ?? null, email: p?.email ?? null }
    }
    const { error } = await supabase
      .from('sd_matches')
      .update({ contact_shared: { [userA]: contactFor(userA), [userB]: contactFor(userB) } })
      .eq('id', m.id)
    if (error) errors.push(`match ${m.id}: ${error.message}`)
  }
  if (errors.length > 0) throw new Error(`Contact-share population failed for ${errors.length} match(es): ${errors.join('; ')}`)
}

export async function revealMatches(orgSlug: string, eventId: string) {
  const supabase = await createClient()
  const { error } = await supabase.rpc('sd_reveal_matches', { check_event_id: eventId })
  fail(error, 'Reveal failed')

  const { data: event } = await supabase.from('sd_events').select('format').eq('id', eventId).single()
  if (getShareContactOnMatch(event?.format)) {
    await populateContactShare(supabase, eventId)
  }

  await recordActivity(supabase, { moduleKey: 'speed-dating', action: 'matches.revealed', orgSlug })
  revalidatePath(`/o/${orgSlug}/m/speed-dating/events/${eventId}`)
}

// Per-user, short-lived Jitsi join token — issued on demand, never persisted
// (schema header note). Authorization is the security-sensitive part: see
// authorizeVideoJoin's own header for why it keys on the SPECIFIC PAIRING
// (docs/19 landmine — never sd_in_event()) and why staff/observer seats are
// refused even though RLS lets staff SELECT every pairing for the rooms
// grid ("connection status only, never video feeds", spec).
//
// Returns a discriminated union rather than THROWING for every refusal —
// per Next's own documented split (node_modules/next/dist/docs/01-app/
// 01-getting-started/10-error-handling.md): "avoid using try/catch blocks
// and throw errors [for expected errors]. Instead, model expected errors as
// return values." A thrown Error from a Server Action is treated as an
// UNCAUGHT EXCEPTION and gets its message REDACTED to a generic one in a
// production build (the `digest`-only log this module's first CI run
// surfaced) — every refusal here (not seated, round ended, video not
// configured) is a normal, anticipated state, not a bug, so none of them may
// throw or the caller never actually sees why.
export type VideoJoinResult =
  | { ok: true; token: string; roomRef: string; domain: string; expiresAt: string }
  | { ok: false; reason: string }

export async function getVideoJoinToken(orgSlug: string, eventId: string, pairingId: string): Promise<VideoJoinResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, reason: 'Not signed in' }

  const [{ data: pairing }, { data: mySeatRow }] = await Promise.all([
    supabase
      .from('sd_pairings')
      .select('id, round_id, participant_a_id, participant_b_id, room_ref, room_provider')
      .eq('id', pairingId)
      .eq('event_id', eventId)
      .maybeSingle(),
    supabase.from('sd_participants').select('id, seat_type').eq('event_id', eventId).eq('user_id', user.id).maybeSingle(),
  ])
  if (!pairing) return { ok: false, reason: 'Pairing not found' }

  const { data: round } = await supabase.from('sd_rounds').select('ends_at').eq('id', pairing.round_id).maybeSingle()

  const decision = authorizeVideoJoin({
    pairing: {
      participantAId: pairing.participant_a_id,
      participantBId: pairing.participant_b_id,
      roomRef: pairing.room_ref,
    },
    round: { endsAt: round?.ends_at ?? null },
    mySeat: mySeatRow ? { id: mySeatRow.id, seatType: mySeatRow.seat_type } : null,
    now: new Date(),
  })
  if (!decision.ok) return { ok: false, reason: decision.reason }

  const { data: profile } = await supabase.from('profiles').select('display_name, email').eq('user_id', user.id).maybeSingle()

  let provider: ReturnType<typeof getVideoProvider>
  try {
    provider = getVideoProvider()
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'Video is not configured' }
  }

  const { token, expiresAt } = await provider.issueToken({
    roomRef: pairing.room_ref!,
    userId: user.id,
    displayName: profile?.display_name || profile?.email || 'Guest',
    email: profile?.email,
    // No participant ever holds Jitsi moderator rights — the organizer
    // console is a separate surface, and "no recording, ever" is a product
    // promise a dater can't override from inside the call.
    moderator: false,
  })
  return { ok: true, token, roomRef: pairing.room_ref!, domain: provider.domain, expiresAt: expiresAt.toISOString() }
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
  await recordActivity(supabase, { moduleKey: 'speed-dating', action: 'report.reviewed', orgSlug })
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
