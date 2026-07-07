import { describe, expect, it } from 'vitest'
import { getDayFacts } from './calendar'
import type { DayContext } from './evaluator'
import { formatMinutes } from './evaluator'
import { generateWeek, type ScheduleTypeConfig } from './generator'

// Line references and conditional fallback text (Pozna Shabbos template):
//   "(3) Mincha & Kabbalos Shabbos" = line "(2)" + 10 minutes
//   Summer shiur shows "Will IY\"H Resume Next Week" in winter.

const TZ = 'America/New_York'

function day(date: string, sunsetUtc: string): DayContext {
  return {
    facts: getDayFacts(new Date(`${date}T12:00:00-05:00`)),
    zmanim: { SunsetDefault: new Date(sunsetUtc) },
  }
}

// Friday 2025-12-12 (EST): sunset 4:28 PM.
const friday = day('2025-12-12', '2025-12-12T21:28:00Z')
const week = [friday]

const config: ScheduleTypeConfig[] = [
  {
    id: 'erev',
    name: 'ערב שבת',
    nameHebrew: null,
    triggerCondition: { dayTypes: ['erev-shabbat'] },
    span: 'day',
    sections: [
      {
        id: 's1',
        name: 'Erev Shabbos',
        nameHebrew: null,
        visibilityCondition: {},
        lines: [
          {
            name: '(2) Mincha & Kabbolas Shabbos',
            nameHebrew: null,
            rule: {
              time: {
                kind: 'zman',
                zman: 'SunsetDefault',
                offsetMinutes: -20,
                round: { direction: 'down', toMinutes: 5 },
              },
            },
          },
          {
            // Deliberately listed AFTER pass-1 dependency to prove two-pass works
            // even though it also appears earlier in section order in real config.
            name: '(3) Mincha & Kabbolas Shabbos',
            nameHebrew: null,
            rule: {
              time: { kind: 'line-ref', line: '(2) Mincha & Kabbolas Shabbos', offsetMinutes: 10 },
            },
          },
          {
            name: 'Summer Shiur',
            nameHebrew: null,
            rule: {
              condition: { season: 'summer' },
              time: { kind: 'fixed', clock: '18:15' },
              fallbackText: 'Will IY"H Resume Next Week',
            },
          },
        ],
      },
    ],
  },
]

describe('line references', () => {
  const docs = generateWeek(config, [], week, TZ)
  const lines = docs[0]!.sections[0]!.lines

  it('(2) computes from the zman: 4:28 − 20 → floor5 = 4:05 PM', () => {
    const l2 = lines.find((l) => l.name.startsWith('(2)'))!
    expect(formatMinutes(l2.timeMinutes!)).toBe('4:05 PM')
  })

  it('(3) = (2) + 10 minutes = 4:15 PM', () => {
    const l3 = lines.find((l) => l.name.startsWith('(3)'))!
    expect(formatMinutes(l3.timeMinutes!)).toBe('4:15 PM')
  })
})

describe('conditional fallback text', () => {
  const docs = generateWeek(config, [], week, TZ)
  const lines = docs[0]!.sections[0]!.lines

  it('out-of-season line shows its fallback text instead of hiding', () => {
    const shiur = lines.find((l) => l.name === 'Summer Shiur')!
    expect(shiur.text).toBe('Will IY"H Resume Next Week')
    expect(shiur.timeMinutes).toBeNull()
  })
})
