// How many rounds the rotation (rotation.ts) needs before everyone has met everyone. Pure, and in
// `src/` (not `ui/`) so the web app AND the worker orchestrator share ONE definition.
//
// Mirrors buildNextRound's partition: exactly two distinct sides = bipartite rotation (as many rounds as
// the LARGER side has people); anything else = one pool, the circle method (N-1 rounds for an even N, N
// for an odd N because someone sits out each round).

import { buildNextRound, type RotationSeat, type SeatPair } from './rotation'

export function roundsToMeetEveryone(people: number, sides?: { a: number; b: number }): number {
  if (sides) return sides.a > 0 && sides.b > 0 ? Math.max(sides.a, sides.b) : 0
  if (people < 2) return 0
  return people % 2 === 0 ? people - 1 : people
}

export function naturalRoundsForSeats(seats: { poolSide: string | null | undefined }[]): number {
  const bySide = new Map<string, number>()
  for (const s of seats) bySide.set(s.poolSide ?? '', (bySide.get(s.poolSide ?? '') ?? 0) + 1)
  if (bySide.size === 2) {
    const [a, b] = [...bySide.values()]
    return roundsToMeetEveryone(0, { a: a!, b: b! })
  }
  return roundsToMeetEveryone(seats.length)
}

// THE "N" IN A DATER'S "ROUND X OF N" (founder 2026-11-05: "always accurate, based on who is there,
// late-comers included"). Called right after a round is built. It replays the REAL rotation engine over
// the whole event — round by round with the people who were in each round, then forward with the people
// present now until nobody new is left to meet — so the answer is what the engine actually does (if nobody
// else arrives), not a formula. Recomputed at every round start: a late arrival raises it, a no-show never
// inflates it. Stored in sd_events.rounds_expected for daters to read.
//
// BLOCKS NEVER REACH THIS NUMBER, not even indirectly (adversarial review 2026-11-05). A block changes the
// real pairing history (swaps, byes), so replaying from the REAL history would let a block move N — "7 of 7"
// becoming "8" with nobody arriving tells a dater that two present people blocked each other. So the replay
// rebuilds its own block-free history from WHO WAS IN each round (every present seat gets a pairing row,
// bye or not, and that does not depend on blocks). N therefore depends only on arrivals and departures.
// The price: where present people have blocked each other, the real event can run a little shorter or
// longer than N — exactly what the event's real length already shows — and the callers correct N then.
// Returns null when there is no end to project (repeat meetings with no organizer cap).
export function projectedTotalRounds(opts: {
  /** for each round so far, oldest first and INCLUDING the one just built: the seats that were in it */
  roundsSoFar: RotationSeat[][]
  /** the seats pairable right now (checked in, where the event uses check-in) */
  present: RotationSeat[]
  allowRepeats: boolean
  /** the organizer's cap (sd_events.rounds_planned); null = none */
  cap: number | null
}): number | null {
  if (opts.allowRepeats) return opts.cap
  const limit = opts.cap ?? MAX_PROJECTED_ROUNDS
  const history: SeatPair[] = []
  const play = (seats: RotationSeat[], roundNumber: number): boolean => {
    // The real engine numbers the round it builds by the rounds that exist before it.
    const plan = buildNextRound({ seats, history, blockedUserPairs: [], allowRepeats: false, roundNumber })
    if (!plan) return false
    for (const p of plan.pairs) if (p.b) history.push({ a: p.a, b: p.b })
    return true
  }
  opts.roundsSoFar.forEach((seats, i) => play(seats, i))
  let total = opts.roundsSoFar.length
  while (total < limit && play(opts.present, total)) total++
  return total
}

/**
 * The seats that were in each round, oldest first, from the event's pairing rows (byes included) — the
 * input projectedTotalRounds needs. `poolSideOf` maps a seat id to its side (null = one pool).
 */
export function seatsPerRound(
  rounds: { id: string; round_number: number }[],
  pairings: { round_id: string; participant_a_id: string; participant_b_id: string | null }[],
  poolSideOf: (seatId: string) => string | null,
): RotationSeat[][] {
  return [...rounds]
    .sort((x, y) => x.round_number - y.round_number)
    .map((r) => {
      const ids = new Set<string>()
      for (const p of pairings) {
        if (p.round_id !== r.id) continue
        ids.add(p.participant_a_id)
        if (p.participant_b_id) ids.add(p.participant_b_id)
      }
      // userId only matters for blocks, which this replay never uses.
      return [...ids].map((id) => ({ id, userId: id, poolSide: poolSideOf(id) }))
    })
}

// Matches the event form's MAX_ROUNDS and the column's check.
const MAX_PROJECTED_ROUNDS = 99
