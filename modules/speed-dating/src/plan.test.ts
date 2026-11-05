import { describe, expect, it } from 'vitest'
import { buildNextRound } from './rotation'
import { naturalRoundsForSeats, projectedTotalRounds, roundsToMeetEveryone, seatsPerRound } from './plan'

const seats = (sides: (string | null)[]) => sides.map((poolSide, i) => ({ id: `s${i}`, userId: `u${i}`, poolSide }))

describe('naturalRoundsForSeats', () => {
  it('one pool: even N -> N-1, odd N -> N, fewer than 2 -> 0', () => {
    expect(naturalRoundsForSeats(seats(Array(8).fill(null)))).toBe(7)
    expect(naturalRoundsForSeats(seats(Array(7).fill(null)))).toBe(7)
    expect(naturalRoundsForSeats(seats([null]))).toBe(0)
  })
  it('exactly two sides -> the larger side', () => {
    expect(naturalRoundsForSeats(seats(['a', 'a', 'a', 'b', 'b']))).toBe(3)
  })
  it('one side only, or three sides, is treated as one pool (as the rotation does)', () => {
    expect(naturalRoundsForSeats(seats(['a', 'a', 'a', 'a']))).toBe(3)
    expect(naturalRoundsForSeats(seats(['a', 'b', 'c', 'a']))).toBe(3)
  })
  it('roundsToMeetEveryone agrees', () => {
    expect(roundsToMeetEveryone(14)).toBe(13)
    expect(roundsToMeetEveryone(0, { a: 5, b: 8 })).toBe(8)
  })
})

// The number must be what the ENGINE really does, not just what the formula says: play the rotation to
// exhaustion and count the rounds that contained at least one meeting.
describe('matches the real rotation engine', () => {
  const play = (poolSides: (string | null)[]) => {
    const s = seats(poolSides)
    const history: { a: string; b: string }[] = []
    let rounds = 0
    for (;;) {
      const plan = buildNextRound({ seats: s, history, blockedUserPairs: [], allowRepeats: false, roundNumber: rounds })
      if (!plan) break
      rounds++
      for (const p of plan.pairs) if (p.b) history.push({ a: p.a, b: p.b })
      if (rounds > 50) throw new Error('runaway')
    }
    return rounds
  }
  it.each([
    [Array(6).fill(null)],
    [Array(7).fill(null)],
    [['a', 'a', 'a', 'b', 'b', 'b']],
    [['a', 'a', 'a', 'a', 'b', 'b']],
  ])('seats %j', (poolSides) => {
    expect(play(poolSides as (string | null)[])).toBe(naturalRoundsForSeats(seats(poolSides as (string | null)[])))
  })
})

// projectedTotalRounds — the dater's "round X of N" (founder 2026-11-05). The properties that matter:
// (1) at every round start, N equals the number of rounds the REAL engine then runs if nobody else arrives —
// including after a late arrival changes who is there; (2) N NEVER depends on blocks (privacy).
describe('projectedTotalRounds', () => {
  type Seat = { id: string; userId: string; poolSide: string | null }
  // Runs the real engine; `arrivals(k)` = seats present when round k+1 is built. After each round is built,
  // records the projection exactly as the callers compute it. Returns the projections and the rounds run.
  const run = (arrivals: (round: number) => Seat[], cap: number | null, blocked: { a: string; b: string }[] = []) => {
    const history: { a: string; b: string }[] = []
    const roundsSoFar: Seat[][] = []
    const projections: number[] = []
    let rounds = 0
    for (;;) {
      if (cap !== null && rounds >= cap) break
      const present = arrivals(rounds)
      const plan = buildNextRound({ seats: present, history, blockedUserPairs: blocked, allowRepeats: false, roundNumber: rounds })
      if (!plan) break
      rounds++
      for (const p of plan.pairs) if (p.b) history.push({ a: p.a, b: p.b })
      roundsSoFar.push(present)
      projections.push(projectedTotalRounds({ roundsSoFar, present, allowRepeats: false, cap })!)
      if (rounds > 60) throw new Error('runaway')
    }
    return { projections, rounds, history }
  }

  it('everyone present from the start: N is the real total at every round', () => {
    for (const n of [2, 3, 4, 5, 6, 7, 8]) {
      const s = seats(Array(n).fill(null))
      const { projections, rounds } = run(() => s, 8)
      expect(rounds).toBeGreaterThan(0)
      for (const p of projections) expect(p).toBe(rounds)
    }
  })

  it('6 registered, 4 come (the no-show case): "of 3", never "of 5"', () => {
    const four = seats(Array(4).fill(null))
    const { projections, rounds } = run(() => four, 8)
    expect(rounds).toBe(3)
    expect(projections).toEqual([3, 3, 3])
  })

  it('a late arrival raises N from the next round on, and the new N is then exact', () => {
    for (const lateAt of [1, 2]) {
      const all = seats(Array(5).fill(null))
      const early = all.slice(0, 4)
      const { projections, rounds } = run((r) => (r < lateAt ? early : all), 8)
      // Before the arrival the projection is about the people there (3 for four people) …
      for (let i = 0; i < lateAt; i++) expect(projections[i]).toBe(3)
      // … and from the round they join, it is exactly what then runs.
      for (let i = lateAt; i < projections.length; i++) expect(projections[i]).toBe(rounds)
      expect(rounds).toBeGreaterThan(3)
    }
  })

  it('two sides with a late arrival on the smaller side', () => {
    const all = seats(['a', 'a', 'a', 'b', 'b', 'b'])
    const early = all.filter((s) => s.id !== 's5')
    const { projections, rounds } = run((r) => (r < 1 ? early : all), 8)
    for (let i = 1; i < projections.length; i++) expect(projections[i]).toBe(rounds)
  })

  it('someone leaving mid-event lowers N from the next round on, and it is then exact', () => {
    const all = seats(Array(6).fill(null))
    const { projections, rounds } = run((r) => (r < 2 ? all : all.slice(0, 5)), 8)
    for (let i = 2; i < projections.length; i++) expect(projections[i]).toBe(rounds)
  })

  it('never above the organizer cap', () => {
    const s = seats(Array(8).fill(null)) // natural 7
    const { projections, rounds } = run(() => s, 4)
    expect(rounds).toBe(4)
    expect(projections).toEqual([4, 4, 4, 4])
  })

  it('never below the rounds already run (an event whose cap was shrunk under the old rule)', () => {
    const s = seats(Array(2).fill(null))
    expect(projectedTotalRounds({ roundsSoFar: [s, s, s], present: s, allowRepeats: false, cap: 2 })).toBe(3)
  })

  it('repeat meetings: no natural end, so N is the cap (or none)', () => {
    const s = seats(Array(4).fill(null))
    expect(projectedTotalRounds({ roundsSoFar: [s], present: s, allowRepeats: true, cap: 6 })).toBe(6)
    expect(projectedTotalRounds({ roundsSoFar: [s], present: s, allowRepeats: true, cap: null })).toBeNull()
  })

  // PRIVACY (adversarial review 2026-11-05): the reviewer's measured cases, where replaying the REAL history
  // let a block move N (7 people: 7 -> 8; 4x4: 4 -> 6). With the same people in the same rounds, N must be
  // IDENTICAL round by round whether or not anybody blocked anybody.
  it.each([
    [Array(7).fill(null), 'u1', 'u6'],
    [Array(7).fill(null), 'u0', 'u2'],
    [Array(6).fill(null), 'u2', 'u3'],
    [['a', 'a', 'a', 'a', 'b', 'b', 'b', 'b'], 'u1', 'u5'],
    [['a', 'a', 'a', 'b', 'b', 'b'], 'u0', 'u3'],
  ])('a block never moves N: %j, %s blocks %s', (poolSides, x, y) => {
    const s = seats(poolSides as (string | null)[])
    const blocked = run(() => s, 8, [{ a: x, b: y }])
    const clean = run(() => s, 8)
    // Compare over the rounds both ran: N at round k is the same number either way.
    const k = Math.min(blocked.projections.length, clean.projections.length)
    expect(k).toBeGreaterThan(0)
    expect(blocked.projections.slice(0, k)).toEqual(clean.projections.slice(0, k))
    // CONTROL: the block really changed who met whom (otherwise the comparison proves nothing).
    expect(JSON.stringify(blocked.history)).not.toEqual(JSON.stringify(clean.history))
  })
})

// MUTATION CHECK for the privacy test above: the FIRST design replayed forward from the REAL history (shaped
// by blocks). This re-creates it and shows it DOES move N for the reviewer's 7-person case — so the test above
// is capable of catching the flaw, rather than passing because blocks never matter here.
it('mutation check: projecting from the REAL (block-shaped) history does move N', () => {
  const s = seats(Array(7).fill(null))
  const projectFromRealHistory = (blocked: { a: string; b: string }[]) => {
    const history: { a: string; b: string }[] = []
    const out: number[] = []
    for (let rounds = 0; rounds < 8; ) {
      const plan = buildNextRound({ seats: s, history, blockedUserPairs: blocked, allowRepeats: false, roundNumber: rounds })
      if (!plan) break
      rounds++
      for (const p of plan.pairs) if (p.b) history.push({ a: p.a, b: p.b })
      const h = [...history]
      let total = rounds
      while (total < 8) {
        const next = buildNextRound({ seats: s, history: h, blockedUserPairs: [], allowRepeats: false, roundNumber: total })
        if (!next) break
        for (const p of next.pairs) if (p.b) h.push({ a: p.a, b: p.b })
        total++
      }
      out.push(total)
    }
    return out
  }
  expect(projectFromRealHistory([{ a: 'u1', b: 'u6' }])).not.toEqual(projectFromRealHistory([]))
})

describe('seatsPerRound', () => {
  it('collects each round\'s seats from its pairing rows, byes included, oldest round first', () => {
    const rounds = [{ id: 'r2', round_number: 2 }, { id: 'r1', round_number: 1 }]
    const pairings = [
      { round_id: 'r1', participant_a_id: 's0', participant_b_id: 's1' },
      { round_id: 'r1', participant_a_id: 's2', participant_b_id: null },
      { round_id: 'r2', participant_a_id: 's1', participant_b_id: 's2' },
    ]
    const out = seatsPerRound(rounds, pairings, (id) => (id === 's2' ? 'b' : 'a'))
    expect(out.map((r) => r.map((s) => s.id).sort())).toEqual([['s0', 's1', 's2'], ['s1', 's2']])
    expect(out[0]!.find((s) => s.id === 's2')!.poolSide).toBe('b')
  })
})
