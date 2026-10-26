import { describe, expect, it } from 'vitest'
import { describeDuration, parseTimings, planEvent } from './event-plan'

const t = { roundSeconds: 420, breakSeconds: 30 }

describe('planEvent', () => {
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

describe('describeDuration', () => {
  it('rounds to the nearest half hour above an hour', () => {
    expect(describeDuration(45)).toBe('about 45 minutes')
    expect(describeDuration(62)).toBe('about 1 hour')
    expect(describeDuration(95)).toBe('about 1.5 hours')
  })
})

describe('parseTimings', () => {
  const form = (round: string, brk: string) => {
    const f = new FormData()
    f.set('roundMinutes', round)
    f.set('breakSeconds', brk)
    return f
  }
  it('converts minutes to seconds', () => {
    expect(parseTimings(form('7', '30'))).toEqual({ roundSeconds: 420, breakSeconds: 30 })
    expect(parseTimings(form('3', '0'))).toEqual({ roundSeconds: 180, breakSeconds: 0 })
  })
  it('rejects out-of-range and non-integer values', () => {
    for (const [r, b] of [['0', '30'], ['61', '30'], ['2.5', '30'], ['7', '-1'], ['7', '601'], ['', '30'], ['7', 'x']]) {
      expect('error' in parseTimings(form(r!, b!))).toBe(true)
    }
  })
})
