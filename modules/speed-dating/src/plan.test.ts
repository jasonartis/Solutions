import { describe, expect, it } from 'vitest'
import { buildNextRound } from './rotation'
import { naturalRoundsForSeats, roundsToMeetEveryone } from './plan'

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
