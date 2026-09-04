// Room-join authorization — pure logic, no DB (the rotation.ts rhythm).
//
// LANDMINE (docs/19-seat-authority-audit.md): never key this on sd_in_event().
// It has no `status` filter, so an attendee a host has EJECTED still passes
// it, and the function is inside a pending platform-wide security
// remediation (§5 there flags adding the filter as a FOUNDER decision, not
// something to ride along with unrelated work). Authorize on the SPECIFIC
// PAIRING instead, exactly as instructed: the caller's own seat must be one
// of the two seats in THIS pairing, in a round that has not yet ended.
//
// Staff must NEVER receive a join token: the spec's organizer console shows
// "connection status only, never video feeds" (Organizer live console
// section) — so staff/observer seats are refused here even though RLS lets
// staff SELECT every pairing row for the rooms grid. Audience/mentor
// observer seats (spec: consent-gated live-view / private-feedback) are a
// distinct, not-yet-built feature — deliberately excluded here, not silently
// dropped: seat_type must be exactly 'participant'.

export type PairingForAuth = {
  participantAId: string
  participantBId: string | null
  roomRef: string | null
}
export type RoundForAuth = { endsAt: string | null }
export type SeatForAuth = { id: string; seatType: string } | null

export type AuthDecision = { ok: true } | { ok: false; reason: string }

export function authorizeVideoJoin(opts: {
  pairing: PairingForAuth
  round: RoundForAuth
  mySeat: SeatForAuth
  now: Date
}): AuthDecision {
  const { pairing, round, mySeat, now } = opts

  if (!mySeat) return { ok: false, reason: 'You are not registered for this event' }
  if (mySeat.seatType !== 'participant') {
    return { ok: false, reason: 'Only participants join the video room' }
  }
  if (pairing.participantBId === null) {
    return { ok: false, reason: 'This is a bye round — there is no video room' }
  }
  if (mySeat.id !== pairing.participantAId && mySeat.id !== pairing.participantBId) {
    return { ok: false, reason: 'You are not seated in this pairing' }
  }
  if (!pairing.roomRef) {
    return { ok: false, reason: 'The room is not ready yet' }
  }
  // Video off at round end (spec: "Round ends → video off → break timer →
  // private notepad") — the break belongs to the notepad, not the call.
  if (round.endsAt && now.getTime() > new Date(round.endsAt).getTime()) {
    return { ok: false, reason: 'This round has ended' }
  }

  return { ok: true }
}
