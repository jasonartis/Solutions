import { describe, expect, it } from 'vitest'
import { buildNextRound, rotationExhausted, type RotationSeat, type SeatPair } from './rotation'

const seat = (id: string, side: string | null = null): RotationSeat => ({
  id,
  userId: 'u-' + id,
  poolSide: side,
})

const meetings = (plan: { pairs: { a: string; b: string | null }[] }) =>
  plan.pairs.filter((p) => p.b !== null).map((p) => (p.a < p.b! ? `${p.a}|${p.b}` : `${p.b}|${p.a}`))

describe('two-sided rotation (the default hetero format)', () => {
  const A = ['a1', 'a2', 'a3'].map((id) => seat(id, 'a'))
  const B = ['b1', 'b2', 'b3'].map((id) => seat(id, 'b'))

  it('covers every cross-pool combination over the rotation, never same-side', () => {
    const seen = new Set<string>()
    const history: SeatPair[] = []
    for (let round = 0; round < 3; round++) {
      const plan = buildNextRound({
        seats: [...A, ...B],
        history,
        blockedUserPairs: [],
        allowRepeats: false,
        roundNumber: round,
      })
      expect(plan).not.toBeNull()
      for (const key of meetings(plan!)) {
        expect(seen.has(key)).toBe(false) // no repeats without permission
        seen.add(key)
        const [x, y] = key.split('|')
        expect(x!.startsWith('a') !== y!.startsWith('a')).toBe(true) // cross-pool only
      }
      for (const p of plan!.pairs) if (p.b) history.push({ a: p.a, b: p.b })
    }
    expect(seen.size).toBe(9) // 3×3 complete coverage
    expect(rotationExhausted({ seats: [...A, ...B], history, blockedUserPairs: [], allowRepeats: false })).toBe(true)
  })

  it('asymmetric pools give the surplus side byes (1v3 dating-show style)', () => {
    const plan = buildNextRound({
      seats: [seat('a1', 'a'), ...B],
      history: [],
      blockedUserPairs: [],
      allowRepeats: false,
      roundNumber: 0,
    })
    expect(plan).not.toBeNull()
    const met = plan!.pairs.filter((p) => p.b !== null)
    const byes = plan!.pairs.filter((p) => p.b === null)
    expect(met.length).toBe(1)
    expect(byes.length).toBe(2)
  })
})

describe('single pool (circle method)', () => {
  const seats = ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => seat(id))

  it('odd count yields exactly one bye per round and full coverage', () => {
    const seen = new Set<string>()
    const history: SeatPair[] = []
    for (let round = 0; round < 5; round++) {
      const plan = buildNextRound({ seats, history, blockedUserPairs: [], allowRepeats: false, roundNumber: round })
      expect(plan).not.toBeNull()
      expect(plan!.pairs.filter((p) => p.b === null).length).toBe(1)
      for (const key of meetings(plan!)) {
        expect(seen.has(key)).toBe(false)
        seen.add(key)
      }
      for (const p of plan!.pairs) if (p.b) history.push({ a: p.a, b: p.b })
    }
    expect(seen.size).toBe(10) // C(5,2)
  })
})

describe('blocks and repeats', () => {
  it('never pairs blocked users, even when that forces byes', () => {
    const seats = [seat('x1'), seat('x2')]
    const plan = buildNextRound({
      seats,
      history: [],
      blockedUserPairs: [{ a: 'u-x1', b: 'u-x2' }],
      allowRepeats: true,
      roundNumber: 0,
    })
    // The only possible meeting is blocked → no legal round exists.
    expect(plan).toBeNull()
  })

  it('repairs a blocked pairing by swapping partners when possible', () => {
    const A = [seat('a1', 'a'), seat('a2', 'a')]
    const B = [seat('b1', 'b'), seat('b2', 'b')]
    // Round 0 would naively pair a1-b1/a2-b2; a1-b1 is blocked.
    const plan = buildNextRound({
      seats: [...A, ...B],
      history: [],
      blockedUserPairs: [{ a: 'u-a1', b: 'u-b1' }],
      allowRepeats: false,
      roundNumber: 0,
    })
    expect(plan).not.toBeNull()
    const keys = meetings(plan!)
    expect(keys).toContain('a1|b2')
    expect(keys).toContain('a2|b1')
  })

  it('returns null when everyone has met (repeats disallowed), a plan when allowed', () => {
    const seats = [seat('y1'), seat('y2')]
    const history = [{ a: 'y1', b: 'y2' }]
    expect(
      buildNextRound({ seats, history, blockedUserPairs: [], allowRepeats: false, roundNumber: 1 }),
    ).toBeNull()
    const again = buildNextRound({ seats, history, blockedUserPairs: [], allowRepeats: true, roundNumber: 1 })
    expect(again).not.toBeNull()
    expect(meetings(again!)).toEqual(['y1|y2'])
  })

  it('is deterministic for identical inputs', () => {
    const seats = ['p1', 'p2', 'p3', 'p4'].map((id) => seat(id))
    const a = buildNextRound({ seats, history: [], blockedUserPairs: [], allowRepeats: false, roundNumber: 2 })
    const b = buildNextRound({ seats, history: [], blockedUserPairs: [], allowRepeats: false, roundNumber: 2 })
    expect(a).toEqual(b)
  })
})
