import { describe, expect, it } from 'vitest'
import { getDayFacts } from './calendar'
import type { DayContext } from './evaluator'
import { generateWeek, type ScheduleTypeConfig } from './generator'

const TZ = 'America/New_York'

function day(date: string, sunsetUtc: string): DayContext {
  return {
    facts: getDayFacts(new Date(`${date}T12:00:00-04:00`)),
    zmanim: { sunset: new Date(sunsetUtc) },
  }
}

// Week of Sunday 2026-07-05 .. Saturday 2026-07-11.
const week: DayContext[] = [
  day('2026-07-05', '2026-07-06T00:32:00Z'),
  day('2026-07-06', '2026-07-07T00:31:00Z'),
  day('2026-07-07', '2026-07-08T00:31:00Z'),
  day('2026-07-08', '2026-07-09T00:30:00Z'),
  day('2026-07-09', '2026-07-10T00:29:00Z'),
  day('2026-07-10', '2026-07-11T00:29:00Z'),
  day('2026-07-11', '2026-07-12T00:28:00Z'),
]

const config: ScheduleTypeConfig[] = [
  {
    id: 'wk',
    name: 'Weekday Schedule',
    nameHebrew: null,
    triggerCondition: { dayTypes: ['weekday'] },
    span: 'week',
    sections: [
      {
        id: 'wk-tefillos',
        name: 'Tefillos',
        nameHebrew: null,
        visibilityCondition: {},
        lines: [
          {
            name: 'Mincha',
            nameHebrew: null,
            rule: { time: { kind: 'fixed', clock: '18:00' } },
          },
          {
            name: 'Maariv',
            nameHebrew: null,
            rule: { time: { kind: 'zman', zman: 'sunset', offsetMinutes: -15 } },
          },
        ],
      },
    ],
  },
  {
    id: 'shab',
    name: 'Shabbat Schedule',
    nameHebrew: null,
    triggerCondition: { dayTypes: ['shabbat'] },
    span: 'day',
    sections: [
      {
        id: 'shab-main',
        name: 'Shabbat',
        nameHebrew: null,
        visibilityCondition: {},
        lines: [
          {
            name: 'Candle Lighting',
            nameHebrew: null,
            rule: {
              condition: { dayTypes: ['shabbat'] },
              time: { kind: 'zman', zman: 'sunset', offsetMinutes: -18 },
            },
          },
        ],
      },
    ],
  },
]

describe('generateWeek', () => {
  const docs = generateWeek(config, [{ sectionId: 'wk-tefillos', text: 'Coffee sponsored by John Doe', textHebrew: null }], week, TZ)

  it('produces one weekday document (Sun–Fri) and one Shabbat document (Sat only)', () => {
    expect(docs).toHaveLength(2)
    const weekday = docs.find((d) => d.scheduleTypeId === 'wk')!
    const shabbat = docs.find((d) => d.scheduleTypeId === 'shab')!
    expect(weekday.dates).toHaveLength(6) // Sun-Fri (Sat is not a weekday)
    expect(shabbat.dates).toEqual(['2026-07-11'])
  })

  it('collapses uniform times and expands varying ones', () => {
    const weekday = docs.find((d) => d.scheduleTypeId === 'wk')!
    const section = weekday.sections[0]!
    const mincha = section.lines.find((l) => l.name === 'Mincha')!
    const maariv = section.lines.find((l) => l.name === 'Maariv')!
    expect(mincha.uniform).toBe(true)
    expect(mincha.timeMinutes).toBe(18 * 60)
    expect(maariv.uniform).toBe(false) // sunset drifts across the week
    expect(maariv.perDay).toHaveLength(6)
  })

  it('attaches weekly overrides to their section', () => {
    const weekday = docs.find((d) => d.scheduleTypeId === 'wk')!
    expect(weekday.sections[0]!.overrides[0]!.text).toContain('Coffee sponsored')
  })

  it('computes candle lighting for the Shabbat sheet', () => {
    const shabbat = docs.find((d) => d.scheduleTypeId === 'shab')!
    const candles = shabbat.sections[0]!.lines[0]!
    // Sat sunset 8:28 PM - 18 = 8:10 PM = 1210... note: candle lighting is
    // Friday in reality — this fixture proves the mechanics; the real config
    // puts the line on the erev-shabbat sheet.
    expect(candles.timeMinutes).toBe(20 * 60 + 28 - 18)
  })
})
