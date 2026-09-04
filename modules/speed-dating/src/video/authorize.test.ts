import { describe, expect, it } from 'vitest'
import { authorizeVideoJoin } from './authorize'

const pairing = { participantAId: 'seat-a', participantBId: 'seat-b', roomRef: 'sd-room1' }
const round = { endsAt: new Date(Date.now() + 60_000).toISOString() } // ends in 1 min

describe('video-join authorization (pure)', () => {
  it('allows a seated participant while the round is live', () => {
    const decision = authorizeVideoJoin({
      pairing,
      round,
      mySeat: { id: 'seat-a', seatType: 'participant' },
      now: new Date(),
    })
    expect(decision).toEqual({ ok: true })
  })

  it('allows the OTHER seat in the same pairing too', () => {
    const decision = authorizeVideoJoin({
      pairing,
      round,
      mySeat: { id: 'seat-b', seatType: 'participant' },
      now: new Date(),
    })
    expect(decision.ok).toBe(true)
  })

  it('refuses someone with no seat at all', () => {
    const decision = authorizeVideoJoin({ pairing, round, mySeat: null, now: new Date() })
    expect(decision.ok).toBe(false)
  })

  it('refuses a seat that is not one of THIS pairing\'s two seats, even if they are in the event', () => {
    const decision = authorizeVideoJoin({
      pairing,
      round,
      mySeat: { id: 'seat-c-someone-else', seatType: 'participant' },
      now: new Date(),
    })
    expect(decision).toEqual({ ok: false, reason: 'You are not seated in this pairing' })
  })

  // The landmine this test pins: authorization must never fall back to "is
  // in the event" for a seat that simply isn't part of this specific
  // pairing — sd_in_event() would pass an ejected-but-still-in-event seat.
  it('refuses staff/observer seat types even when their id matches a slot (should never happen, still refused)', () => {
    const decision = authorizeVideoJoin({
      pairing,
      round,
      mySeat: { id: 'seat-a', seatType: 'audience' },
      now: new Date(),
    })
    expect(decision).toEqual({ ok: false, reason: 'Only participants join the video room' })
  })

  it('refuses a bye (no second seat, no room)', () => {
    const decision = authorizeVideoJoin({
      pairing: { participantAId: 'seat-a', participantBId: null, roomRef: null },
      round,
      mySeat: { id: 'seat-a', seatType: 'participant' },
      now: new Date(),
    })
    expect(decision).toEqual({ ok: false, reason: 'This is a bye round — there is no video room' })
  })

  it('refuses when the room has not been stamped yet (video not configured / orchestrator has not run)', () => {
    const decision = authorizeVideoJoin({
      pairing: { ...pairing, roomRef: null },
      round,
      mySeat: { id: 'seat-a', seatType: 'participant' },
      now: new Date(),
    })
    expect(decision).toEqual({ ok: false, reason: 'The room is not ready yet' })
  })

  it('refuses once the round has ended — video off before the break starts', () => {
    const decision = authorizeVideoJoin({
      pairing,
      round: { endsAt: new Date(Date.now() - 1000).toISOString() },
      mySeat: { id: 'seat-a', seatType: 'participant' },
      now: new Date(),
    })
    expect(decision).toEqual({ ok: false, reason: 'This round has ended' })
  })

  it('allows a round with no ends_at (a manually-run round created before the field existed) to degrade rather than refuse', () => {
    const decision = authorizeVideoJoin({
      pairing,
      round: { endsAt: null },
      mySeat: { id: 'seat-a', seatType: 'participant' },
      now: new Date(),
    })
    expect(decision.ok).toBe(true)
  })
})
