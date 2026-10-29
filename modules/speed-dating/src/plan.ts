// How many rounds the rotation (rotation.ts) needs before everyone has met everyone. Pure, and in
// `src/` (not `ui/`) so the web app AND the worker orchestrator share ONE definition: the organizer's
// cap on rounds (sd_events.rounds_planned) is shrunk to this when the first round starts, so a dater's
// "round 7 of 8" is never promised past the point where the rotation has run out of new people.
//
// Mirrors buildNextRound's partition: exactly two distinct sides = bipartite rotation (as many rounds as
// the LARGER side has people); anything else = one pool, the circle method (N-1 rounds for an even N, N
// for an odd N because someone sits out each round).

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
