// Module 6 rotation engine — pure logic, no DB (the assignPeerReviews rhythm).
// Spec (docs/modules/module-6): format is configuration — default hetero
// two-sided pools but arbitrary; byes get "you're back in next round";
// personal blocks are NEVER paired (cross-event, hard); the organizer's
// allow-repeat setting decides whether two people can meet twice.
// Deterministic: variety across rounds comes from roundNumber, not randomness.

export type RotationSeat = {
  /** sd_participants.id */
  id: string
  /** auth user behind the seat — blocks are user-level and cross-event */
  userId: string
  /** pool side label ('a'/'b'/...); null = single shared pool */
  poolSide: string | null
}

export type SeatPair = { a: string; b: string }
export type UserPair = { a: string; b: string }

export type RoundPlan = {
  /** b === null is a bye */
  pairs: { a: string; b: string | null }[]
}

function pairKey(x: string, y: string): string {
  return x < y ? `${x}|${y}` : `${y}|${x}`
}

/**
 * Build the next round's pairings, or null when no round with at least one
 * legal meeting exists (everyone has met everyone / everything left is
 * blocked) — the organizer then completes the event.
 *
 * Two-sided formats rotate side B against side A (classic rotation); a single
 * pool uses the circle method. Conflicts (blocked pairs, disallowed repeats)
 * are repaired by deterministic partner swaps; irreparable pairs become byes.
 */
export function buildNextRound(opts: {
  seats: RotationSeat[]
  /** seat-id pairs that already met (this event's pairing history) */
  history: SeatPair[]
  /** user-id pairs that must never meet (sd_blocks, both directions) */
  blockedUserPairs: UserPair[]
  allowRepeats: boolean
  roundNumber: number
}): RoundPlan | null {
  const seats = [...opts.seats].sort((x, y) => (x.id < y.id ? -1 : 1))
  if (seats.length < 2) return null

  const userOf = new Map(seats.map((s) => [s.id, s.userId]))
  const met = new Set(opts.history.map((p) => pairKey(p.a, p.b)))
  const blocked = new Set(opts.blockedUserPairs.map((p) => pairKey(p.a, p.b)))

  const legal = (seatA: string, seatB: string): boolean => {
    if (blocked.has(pairKey(userOf.get(seatA)!, userOf.get(seatB)!))) return false
    if (!opts.allowRepeats && met.has(pairKey(seatA, seatB))) return false
    return true
  }

  // Partition into sides. Exactly two distinct sides = bipartite rotation;
  // anything else (one side, no sides, 3+ sides) = one shared pool.
  const sides = new Map<string, RotationSeat[]>()
  for (const s of seats) {
    const k = s.poolSide ?? ''
    sides.set(k, [...(sides.get(k) ?? []), s])
  }

  let left: (string | null)[]
  let right: (string | null)[]
  if (sides.size === 2) {
    const sideKeys = [...sides.keys()].sort()
    const A = sides.get(sideKeys[0]!)!.map((s) => s.id)
    const B = sides.get(sideKeys[1]!)!.map((s) => s.id)
    // Pad the smaller side with byes so rotation is a clean permutation.
    const width = Math.max(A.length, B.length)
    left = [...A, ...Array(width - A.length).fill(null)]
    right = [...B, ...Array(width - B.length).fill(null)]
    // Rotate the right side by roundNumber.
    const r = opts.roundNumber % width
    right = [...right.slice(r), ...right.slice(0, r)]
  } else {
    // Circle method: fix seat 0, rotate the rest by roundNumber.
    const ids: (string | null)[] = seats.map((s) => s.id)
    if (ids.length % 2 === 1) ids.push(null)
    const fixed = ids[0]!
    const rest = ids.slice(1)
    const r = opts.roundNumber % rest.length
    const rotated = [...rest.slice(r), ...rest.slice(0, r)]
    const all = [fixed, ...rotated]
    const half = all.length / 2
    left = all.slice(0, half)
    right = all.slice(half).reverse()
  }

  // Assemble raw pairs, then repair conflicts with deterministic swaps: try
  // exchanging right-hand partners between two conflicted/clean pairs when
  // both results are legal.
  type Slot = { a: string | null; b: string | null }
  const slots: Slot[] = left.map((a, i) => ({ a, b: right[i] ?? null }))

  const isConflict = (s: Slot) => s.a !== null && s.b !== null && !legal(s.a, s.b)
  for (let i = 0; i < slots.length; i++) {
    if (!isConflict(slots[i]!)) continue
    for (let j = 0; j < slots.length; j++) {
      if (i === j) continue
      const si = slots[i]!, sj = slots[j]!
      const iOk = si.a === null || sj.b === null || legal(si.a, sj.b!)
      const jOk = sj.a === null || si.b === null || legal(sj.a, si.b!)
      // Also the swapped-in partner must not recreate a conflict on j.
      if (iOk && jOk) {
        const tmp = si.b
        si.b = sj.b
        sj.b = tmp
        if (!isConflict(si) && !isConflict(sj)) break
        // undo if the swap didn't actually resolve
        sj.b = si.b
        si.b = tmp
      }
    }
  }

  // Irreparable conflicts become byes for both sides.
  const pairs: { a: string; b: string | null }[] = []
  for (const s of slots) {
    if (s.a === null && s.b === null) continue
    if (s.a !== null && s.b !== null) {
      if (legal(s.a, s.b)) pairs.push({ a: s.a, b: s.b })
      else {
        pairs.push({ a: s.a, b: null })
        pairs.push({ a: s.b, b: null })
      }
    } else {
      pairs.push({ a: (s.a ?? s.b)!, b: null })
    }
  }

  const hasMeeting = pairs.some((p) => p.b !== null)
  if (!hasMeeting) return null

  // Stable output order (deterministic for tests and for the DB writer).
  pairs.sort((x, y) => (x.a < y.a ? -1 : 1))
  return { pairs }
}

/**
 * True when no future round could contain a legal meeting — every cross-pool
 * (or all-pool) combination is exhausted or blocked. Used by the orchestrator
 * to auto-complete an event's rotation phase.
 */
export function rotationExhausted(opts: {
  seats: RotationSeat[]
  history: SeatPair[]
  blockedUserPairs: UserPair[]
  allowRepeats: boolean
}): boolean {
  if (opts.allowRepeats) return false
  const seats = opts.seats
  const userOf = new Map(seats.map((s) => [s.id, s.userId]))
  const met = new Set(opts.history.map((p) => pairKey(p.a, p.b)))
  const blocked = new Set(opts.blockedUserPairs.map((p) => pairKey(p.a, p.b)))
  const sides = new Set(seats.map((s) => s.poolSide ?? ''))
  const bipartite = sides.size === 2

  for (let i = 0; i < seats.length; i++) {
    for (let j = i + 1; j < seats.length; j++) {
      const a = seats[i]!, b = seats[j]!
      if (bipartite && (a.poolSide ?? '') === (b.poolSide ?? '')) continue
      if (blocked.has(pairKey(a.userId, b.userId))) continue
      if (met.has(pairKey(a.id, b.id))) continue
      return false
    }
  }
  return true
}
