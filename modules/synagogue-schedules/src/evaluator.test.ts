import { describe, expect, it } from 'vitest'
import { getDayFacts } from './calendar'
import {
  conditionMatches,
  evaluateLine,
  formatMinutes,
  resolveTime,
  roundMinutes,
  wallMinutes,
  type DayContext,
} from './evaluator'

const TZ = 'America/New_York'

// Helper: a UTC instant that is HH:MM wall clock in New York on 2026-07-05 (EDT = UTC-4).
function nyInstant(dateUtc: string): Date {
  return new Date(dateUtc)
}

function day(date: string, sunsetUtc: string, sunriseUtc: string): DayContext {
  return {
    facts: getDayFacts(new Date(`${date}T12:00:00-04:00`)),
    zmanim: {
      sunset: nyInstant(sunsetUtc),
      sunrise: nyInstant(sunriseUtc),
    },
  }
}

// Week of Sunday 2026-07-05 .. Saturday 2026-07-11, sunset drifting earlier
// each day so the earliest-of-week aggregate is distinguishable.
const week: DayContext[] = [
  day('2026-07-05', '2026-07-06T00:32:00Z', '2026-07-05T09:34:00Z'), // sunset 8:32 PM EDT
  day('2026-07-06', '2026-07-07T00:31:00Z', '2026-07-06T09:35:00Z'),
  day('2026-07-07', '2026-07-08T00:31:00Z', '2026-07-07T09:36:00Z'),
  day('2026-07-08', '2026-07-09T00:30:00Z', '2026-07-08T09:36:00Z'),
  day('2026-07-09', '2026-07-10T00:29:00Z', '2026-07-09T09:37:00Z'),
  day('2026-07-10', '2026-07-11T00:29:00Z', '2026-07-10T09:38:00Z'),
  day('2026-07-11', '2026-07-12T00:28:00Z', '2026-07-11T09:39:00Z'), // sunset 8:28 PM EDT
]
const sunday = week[0]!

describe('wall clock conversion', () => {
  it('converts a UTC instant to synagogue wall minutes', () => {
    // 8:32 PM EDT = 20*60+32
    expect(wallMinutes(nyInstant('2026-07-06T00:32:00Z'), TZ)).toBe(20 * 60 + 32)
  })
  it('formats minutes as 12-hour clock', () => {
    expect(formatMinutes(18 * 60)).toBe('6:00 PM')
    expect(formatMinutes(9 * 60 + 5)).toBe('9:05 AM')
  })
})

describe('rounding', () => {
  it('rounds down/up/nearest to 5', () => {
    expect(roundMinutes(1232, { direction: 'down', toMinutes: 5 })).toBe(1230)
    expect(roundMinutes(1232, { direction: 'up', toMinutes: 5 })).toBe(1235)
    expect(roundMinutes(1232, { direction: 'nearest', toMinutes: 5 })).toBe(1230)
  })
})

describe("the founder's three confirmed rule examples", () => {
  it('Maariv = sundown - 15', () => {
    const t = resolveTime(
      { kind: 'zman', zman: 'sunset', offsetMinutes: -15 },
      sunday,
      week,
      TZ,
    )
    expect(t).toBe(20 * 60 + 32 - 15) // 8:17 PM
  })

  it('Mincha1 = fixed 6:00 PM', () => {
    const t = resolveTime({ kind: 'fixed', clock: '18:00' }, sunday, week, TZ)
    expect(t).toBe(18 * 60)
  })

  it('Mincha2 = winters only, sunrise + 1hr — hidden in July', () => {
    const line = evaluateLine(
      {
        name: 'Mincha 2',
        nameHebrew: null,
        rule: {
          condition: { season: 'winter' },
          time: { kind: 'zman', zman: 'sunrise', offsetMinutes: 60 },
        },
      },
      sunday,
      week,
      TZ,
    )
    expect(line).toBeNull() // July = summer
  })
})

describe('week aggregates', () => {
  it('earliest sunset of the week - 20, rounded down to 5', () => {
    const t = resolveTime(
      {
        kind: 'zman',
        zman: 'sunset',
        aggregate: 'earliest-of-week',
        offsetMinutes: -20,
        round: { direction: 'down', toMinutes: 5 },
      },
      sunday,
      week,
      TZ,
    )
    // earliest sunset = Saturday 8:28 PM = 1228; 1228-20 = 1208; floor5 = 1205 = 8:05 PM
    expect(t).toBe(1205)
    expect(formatMinutes(t!)).toBe('8:05 PM')
  })
})

describe('conditions', () => {
  it('day facts identify Sunday as a weekday and Saturday as shabbat', () => {
    expect(sunday.facts.dayTypes).toContain('weekday')
    expect(week[6]!.facts.dayTypes).toContain('shabbat')
  })

  it('dayTypes condition filters correctly', () => {
    const shabbatOnly = { dayTypes: ['shabbat' as const] }
    expect(conditionMatches(shabbatOnly, sunday.facts, [])).toBe(false)
    expect(conditionMatches(shabbatOnly, week[6]!.facts, [])).toBe(true)
  })

  it('free-form line resolves with no time', () => {
    const line = evaluateLine(
      {
        name: "This week's coffee sponsored by John Doe",
        nameHebrew: null,
        rule: { time: { kind: 'none' } },
      },
      sunday,
      week,
      TZ,
    )
    expect(line).not.toBeNull()
    expect(line!.timeMinutes).toBeNull()
  })
})

describe('calendar facts on real holidays', () => {
  it('identifies Yom Kippur 5787 (Sep 21 2026, a Monday)', () => {
    const facts = getDayFacts(new Date('2026-09-21T12:00:00-04:00'))
    expect(facts.holidays.some((h) => /Yom Kippur/i.test(h))).toBe(true)
    expect(facts.dayTypes).toContain('yom-tov')
    expect(facts.dayTypes).toContain('fast-day')
  })
})
