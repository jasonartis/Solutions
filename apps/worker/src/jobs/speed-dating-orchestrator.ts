import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildNextRound,
  rotationExhausted,
  type SeatPair,
} from '../../../../modules/speed-dating/src/index'

// speeddating.event-orchestrator (module 6 spec): the server-authoritative
// round clock. Every tick, for each RUNNING event: when the active round's
// clock has expired (round + break), complete it and build the next round
// with the real rotation engine — pool sides, personal blocks (service role
// sees them all), the allow-repeats setting, byes. When the rotation is
// exhausted, the orchestrator stops advancing and leaves completion to the
// organizer (matches the live-console flow). Organizer manual advances and
// the clock coexist: the guard triggers enforce single-active-round.
//
// Service role bypasses RLS — every query scopes by event/org explicitly.
export async function runOrchestratorTick(admin: SupabaseClient): Promise<void> {
  const { data: events } = await admin
    .from('sd_events')
    .select('id, org_id, round_duration_seconds, break_duration_seconds, allow_repeat_pairings')
    .eq('state', 'running')
  if (!events || events.length === 0) return

  const now = Date.now()
  for (const event of events) {
    const { data: rounds } = await admin
      .from('sd_rounds')
      .select('id, round_number, state, ends_at')
      .eq('event_id', event.id)

    const active = (rounds ?? []).find((r) => r.state === 'active')
    if (active) {
      // Clock still running (round + break) → nothing to do for this event.
      const deadline = active.ends_at
        ? new Date(active.ends_at).getTime() + event.break_duration_seconds * 1000
        : null
      if (deadline === null || now < deadline) continue
      const { error } = await admin.from('sd_rounds').update({ state: 'complete' }).eq('id', active.id)
      if (error) {
        console.error(`[orchestrator] close round failed for event ${event.id}: ${error.message}`)
        continue
      }
    } else if ((rounds ?? []).length === 0) {
      // A freshly started event with no rounds yet: start round 1 immediately.
    } else if (!(rounds ?? []).some((r) => r.state === 'complete')) {
      continue // rounds exist but none active/complete (pending being built elsewhere)
    }

    // Gather inputs: checked-in participants only (the lobby gate matters for
    // a live event), full pairing history, org-wide personal blocks.
    const { data: participants } = await admin
      .from('sd_participants')
      .select('id, user_id, pool_side')
      .eq('event_id', event.id)
      .eq('status', 'registered')
      .eq('seat_type', 'participant')
      .eq('checked_in', true)
    if (!participants || participants.length < 2) continue

    const { data: pairings } = await admin
      .from('sd_pairings')
      .select('participant_a_id, participant_b_id')
      .eq('event_id', event.id)
    const history: SeatPair[] = (pairings ?? [])
      .filter((p) => p.participant_b_id !== null)
      .map((p) => ({ a: p.participant_a_id, b: p.participant_b_id! }))

    const userIds = participants.map((p) => p.user_id)
    const { data: blocks } = await admin
      .from('sd_blocks')
      .select('blocker_user_id, blocked_user_id')
      .eq('org_id', event.org_id)
      .in('blocker_user_id', userIds)

    const seats = participants.map((p) => ({ id: p.id, userId: p.user_id, poolSide: p.pool_side }))
    const blockedUserPairs = (blocks ?? []).map((b) => ({ a: b.blocker_user_id, b: b.blocked_user_id }))

    const plan = buildNextRound({
      seats,
      history,
      blockedUserPairs,
      allowRepeats: event.allow_repeat_pairings,
      roundNumber: (rounds ?? []).length,
    })
    if (!plan) {
      if (rotationExhausted({ seats, history, blockedUserPairs, allowRepeats: event.allow_repeat_pairings })) {
        console.log(`[orchestrator] event ${event.id}: rotation complete — awaiting organizer`)
      }
      continue
    }

    const startsAt = new Date()
    const endsAt = new Date(startsAt.getTime() + event.round_duration_seconds * 1000)
    const nextNumber = Math.max(0, ...(rounds ?? []).map((r) => r.round_number)) + 1
    const { data: round, error: roundErr } = await admin
      .from('sd_rounds')
      .insert({
        org_id: event.org_id,
        event_id: event.id,
        round_number: nextNumber,
        state: 'pending',
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
      })
      .select('id')
      .single()
    if (roundErr) {
      // A concurrent manual advance can win the race — the single-active-round
      // guard makes that safe; just skip this tick.
      console.error(`[orchestrator] create round failed for event ${event.id}: ${roundErr.message}`)
      continue
    }

    for (const p of plan.pairs) {
      const { error } = await admin.from('sd_pairings').insert({
        org_id: event.org_id,
        event_id: event.id,
        round_id: round!.id,
        participant_a_id: p.a,
        participant_b_id: p.b,
      })
      if (error) console.error(`[orchestrator] pairing failed: ${error.message}`)
    }

    const { error: activateErr } = await admin
      .from('sd_rounds')
      .update({ state: 'active' })
      .eq('id', round!.id)
    if (activateErr) {
      console.error(`[orchestrator] activate failed for event ${event.id}: ${activateErr.message}`)
      continue
    }
    console.log(
      `[orchestrator] event ${event.id}: round ${nextNumber} live — ${plan.pairs.filter((p) => p.b).length} rooms, ${plan.pairs.filter((p) => !p.b).length} byes, ends ${endsAt.toISOString()}`,
    )
  }
}
