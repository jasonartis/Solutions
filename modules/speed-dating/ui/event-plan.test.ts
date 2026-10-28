import { describe, expect, it } from 'vitest'
import { describePlan, describeDuration, naturalRounds, parseTimings, planEvent, roundsForLength, totalMinutesFor } from './event-plan'

const t = { roundSeconds: 420, breakSeconds: 30 }

describe('planEvent without a cap', () => {
  it('single pool: even N takes N-1 rounds, odd N takes N', () => {
    expect(planEvent({ people: 14, ...t, allowRepeats: false }).rounds).toBe(13)
    expect(planEvent({ people: 7, ...t, allowRepeats: false }).rounds).toBe(7)
  })
  it('two sides: as many rounds as the larger side', () => {
    expect(planEvent({ people: 0, sides: { a: 7, b: 7 }, ...t, allowRepeats: false }).rounds).toBe(7)
    expect(planEvent({ people: 0, sides: { a: 5, b: 8 }, ...t, allowRepeats: false }).rounds).toBe(8)
  })
  it('total time counts a break between rounds, not after the last', () => {
    // 7 rounds * 420s + 6 * 30s = 3120s = 52 min
    expect(planEvent({ people: 0, sides: { a: 7, b: 7 }, ...t, allowRepeats: false }).totalMinutes).toBe(52)
  })
  it('promises nothing when repeats are allowed, and nothing for an empty side', () => {
    expect(planEvent({ people: 14, ...t, allowRepeats: true }).rounds).toBeNull()
    expect(planEvent({ people: 0, sides: { a: 0, b: 5 }, ...t, allowRepeats: false }).rounds).toBe(0)
    expect(planEvent({ people: 1, ...t, allowRepeats: false }).rounds).toBe(0)
  })
})

describe('planEvent with a round cap (rounds_planned)', () => {
  it('a cap below the natural count makes the length exact', () => {
    // 14 people would take 13 rounds; capped at 6: 6*420 + 5*30 = 2670s = 45 min (44.5 rounds up)
    const plan = planEvent({ people: 14, ...t, allowRepeats: false, maxRounds: 6 })
    expect(plan).toEqual({ rounds: 6, totalMinutes: 45, capped: true })
  })
  it('a cap ABOVE the natural count changes nothing: everyone has met everyone first', () => {
    const plan = planEvent({ people: 6, ...t, allowRepeats: false, maxRounds: 20 })
    expect(plan.rounds).toBe(5)
    expect(plan.capped).toBe(false)
  })
  it('a cap makes a repeat-meetings event plannable', () => {
    expect(planEvent({ people: 14, ...t, allowRepeats: true, maxRounds: 6 })).toEqual({ rounds: 6, totalMinutes: 45, capped: true })
  })
  it('works with two sides', () => {
    expect(planEvent({ people: 0, sides: { a: 10, b: 10 }, ...t, allowRepeats: false, maxRounds: 4 }).rounds).toBe(4)
  })
})

describe('length <-> rounds', () => {
  it('totalMinutesFor and roundsForLength are consistent', () => {
    expect(totalMinutesFor(6, 420, 30)).toBe(45)
    expect(roundsForLength(45, 420, 30)).toBe(6)
    // one minute short of 6 rounds only fits 5
    expect(roundsForLength(43, 420, 30)).toBe(5)
    expect(roundsForLength(3, 420, 30)).toBe(0)
  })
  it('zero break: pure multiples', () => {
    expect(roundsForLength(60, 300, 0)).toBe(12)
  })
  it('naturalRounds matches the rotation engine rule', () => {
    expect(naturalRounds({ people: 14 })).toBe(13)
    expect(naturalRounds({ people: 0, sides: { a: 3, b: 9 } })).toBe(9)
  })
})

describe('describePlan wording', () => {
  it('says "up to" only when the cap does not decide', () => {
    expect(describePlan({ people: 14, ...t, allowRepeats: false })).toMatch(/up to 13 rounds/)
    expect(describePlan({ people: 14, ...t, allowRepeats: false, maxRounds: 6 })).toBe('14 people, 6 rounds, about 45 minutes.')
  })
})

describe('describePlan singular', () => {
  it('says "1 round", not "1 rounds"', () => {
    expect(describePlan({ people: 14, ...t, allowRepeats: false, maxRounds: 1 })).toBe('14 people, 1 round, about 7 minutes.')
  })
})

describe('describeDuration', () => {
  it('rounds to the nearest half hour above an hour', () => {
    expect(describeDuration(45)).toBe('about 45 minutes')
    expect(describeDuration(62)).toBe('about 1 hour')
    expect(describeDuration(95)).toBe('about 1.5 hours')
  })
})

describe('parseTimings', () => {
  const form = (round: string, brk: string, rounds = '6') => {
    const f = new FormData()
    f.set('roundMinutes', round)
    f.set('breakSeconds', brk)
    f.set('maxRounds', rounds)
    return f
  }
  it('converts minutes to seconds and carries the round cap', () => {
    expect(parseTimings(form('7', '30'))).toEqual({ roundSeconds: 420, breakSeconds: 30, maxRounds: 6 })
    expect(parseTimings(form('3', '0', '12'))).toEqual({ roundSeconds: 180, breakSeconds: 0, maxRounds: 12 })
  })
  it('rejects out-of-range and non-integer values, including the round cap', () => {
    for (const [r, b, n] of [['0', '30', '6'], ['61', '30', '6'], ['2.5', '30', '6'], ['7', '-1', '6'], ['7', '601', '6'], ['', '30', '6'], ['7', 'x', '6'], ['7', '30', '0'], ['7', '30', '100'], ['7', '30', ''], ['7', '30', '2.5']]) {
      expect('error' in parseTimings(form(r!, b!, n!))).toBe(true)
    }
  })
})
