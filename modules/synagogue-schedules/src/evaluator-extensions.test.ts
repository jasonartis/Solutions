import { describe, expect, it } from 'vitest'
import { getDayFacts } from './calendar'
import { conditionMatches, formatMinutes, lookupZman, resolveTime, type DayContext } from './evaluator'

// Tests for the grammar extensions demanded by the founder's real Pozna
// materials (SPEC.md 2026-07-07): open zman vocabulary + aliases,
// day-anchored zmanim, clamps, specific-weekday conditions.
// The zmanim values below are REAL numbers from the founder's myzmanim pull
// for the week of Sunday 2025-12-07 … Saturday 2025-12-13 (Friday 12/12 and
// Saturday 12/13 columns), New York (US11210), EST (UTC-5).

const TZ = 'America/New_York'

function estInstant(date: string, hms: string): Date {
  return new Date(`${date}T${hms}-05:00`)
}

function day(date: string, zmanim: Record<string, Date>): DayContext {
  return { facts: getDayFacts(new Date(`${date}T12:00:00-05:00`)), zmanim }
}

// Friday 2025-12-12 and Saturday 2025-12-13, verbatim from the founder's pull.
const friday = day('2025-12-12', {
  SunsetDefault: estInstant('2025-12-12', '16:28:00'),
  Candles: estInstant('2025-12-12', '16:10:00'),
  MinchaGra: estInstant('2025-12-12', '12:13:00'),
  PlagGra: estInstant('2025-12-12', '15:30:00'),
})
const saturday = day('2025-12-13', {
  SunsetDefault: estInstant('2025-12-13', '16:29:00'),
  MinchaGra: estInstant('2025-12-13', '12:14:00'),
  NightShabbos: estInstant('2025-12-13', '17:15:00'),
  Night50fix: estInstant('2025-12-13', '17:20:00'),
  Night60fix: estInstant('2025-12-13', '17:30:00'),
})
// Minimal week containing the two real days (positions matter only for
// dayOfWeek anchoring, which uses facts, not array position).
const week: DayContext[] = [friday, saturday]

describe('open zman vocabulary + aliases', () => {
  it('resolves myzmanim field names directly', () => {
    expect(lookupZman(friday.zmanim, 'SunsetDefault')).toBeInstanceOf(Date)
  })
  it('resolves friendly aliases onto myzmanim-keyed maps', () => {
    // rule says 'sunset', source provided 'SunsetDefault'
    const t = resolveTime({ kind: 'zman', zman: 'sunset', offsetMinutes: 0 }, friday, week, TZ)
    expect(t).toBe(16 * 60 + 28)
  })
  it('resolves myzmanim names onto friendly-keyed maps (hebcal fallback)', () => {
    const fallbackDay = day('2025-12-12', { sunset: estInstant('2025-12-12', '16:28:00') })
    const t = resolveTime(
      { kind: 'zman', zman: 'SunsetDefault', offsetMinutes: 0 },
      fallbackDay,
      [fallbackDay],
      TZ,
    )
    expect(t).toBe(16 * 60 + 28)
  })
})

describe("day-anchored zmanim (Pozna: \"Friday's Candles\", \"Saturday's NightShabbos\")", () => {
  it("Hadlakas Neiros = Friday's Candles even when evaluated on Saturday", () => {
    const t = resolveTime(
      { kind: 'zman', zman: 'Candles', aggregate: { dayOfWeek: 5 }, offsetMinutes: 0 },
      saturday,
      week,
      TZ,
    )
    expect(t).toBe(16 * 60 + 10) // 4:10 PM — the real printed value
  })

  it("Maariv Motzei Shabbos (50) = Saturday's Night50fix", () => {
    const t = resolveTime(
      { kind: 'zman', zman: 'Night50fix', aggregate: { dayOfWeek: 6 }, offsetMinutes: 0 },
      friday,
      week,
      TZ,
    )
    expect(t).toBe(17 * 60 + 20) // 5:20 PM
  })
})

describe('clamps (Pozna: Mincha Gedolah = max(Earliest Mincha, 1:30 PM))', () => {
  it('clamps up to notBefore when the zman is earlier', () => {
    // Friday's MinchaGra is 12:13 — before 13:30, so the printed time is 1:30 PM.
    const t = resolveTime(
      { kind: 'zman', zman: 'MinchaGra', offsetMinutes: 0, notBefore: '13:30' },
      friday,
      week,
      TZ,
    )
    expect(t).toBe(13 * 60 + 30)
    expect(formatMinutes(t!)).toBe('1:30 PM')
  })

  it('leaves the zman alone when it is after notBefore', () => {
    const lateDay = day('2025-06-12', { MinchaGra: new Date('2025-06-12T13:45:00-04:00') })
    const t = resolveTime(
      { kind: 'zman', zman: 'MinchaGra', offsetMinutes: 0, notBefore: '13:30' },
      lateDay,
      [lateDay],
      'America/New_York',
    )
    expect(t).toBe(13 * 60 + 45)
  })
})

describe('specific-weekday conditions (Pozna: Shachris Sun–Fri vs Mon–Fri)', () => {
  it('Monday–Friday minyan hides on Sunday', () => {
    const sunday = day('2025-12-07', {})
    expect(conditionMatches({ daysOfWeek: [1, 2, 3, 4, 5] }, sunday.facts, [])).toBe(false)
    expect(conditionMatches({ daysOfWeek: [0, 1, 2, 3, 4, 5] }, sunday.facts, [])).toBe(true)
  })
  it('combines with day types', () => {
    expect(conditionMatches({ daysOfWeek: [5], dayTypes: ['erev-shabbat'] }, friday.facts, [])).toBe(true)
    expect(conditionMatches({ daysOfWeek: [4], dayTypes: ['erev-shabbat'] }, friday.facts, [])).toBe(false)
  })
})

describe('combined real rule: Mincha & Kabbolas Shabbos', () => {
  it("(8 minutes before Friday's Shkia, rounded down to 5) computes from real data", () => {
    const t = resolveTime(
      {
        kind: 'zman',
        zman: 'SunsetDefault',
        aggregate: { dayOfWeek: 5 },
        offsetMinutes: -8,
        round: { direction: 'down', toMinutes: 5 },
      },
      friday,
      week,
      TZ,
    )
    // 16:28 − 8 = 16:20 → floor5 = 16:20 = 4:20 PM
    expect(formatMinutes(t!)).toBe('4:20 PM')
  })
})
