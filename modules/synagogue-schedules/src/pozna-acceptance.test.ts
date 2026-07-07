import { describe, expect, it } from 'vitest'
import { getDayFacts } from './calendar'
import type { DayContext } from './evaluator'
import { formatMinutes } from './evaluator'
import { generateWeek, type GeneratedDocument } from './generator'
import { poznaShabbosConfig } from './pozna.fixture'

// Pozna acceptance: the shul's real Shabbos schedule (pozna.fixture.ts) run
// against the founder's REAL myzmanim pull for the week of Sunday 2025-12-07 …
// Saturday 2025-12-13 (US11210, EST). Every expected value below is the number
// the shul actually printed / the template formula actually yields.

const TZ = 'America/New_York'

function estInstant(date: string, hms: string): Date {
  return new Date(`${date}T${hms}-05:00`)
}

function day(date: string, zmanim: Record<string, Date>): DayContext {
  return { facts: getDayFacts(new Date(`${date}T12:00:00-05:00`)), zmanim }
}

// Sunday–Thursday carry no zmanim (the Shabbos schedule never reads them);
// Friday 12/12 and Saturday 12/13 are verbatim from the founder's dump.
const week: DayContext[] = [
  day('2025-12-07', {}),
  day('2025-12-08', {}),
  day('2025-12-09', {}),
  day('2025-12-10', {}),
  day('2025-12-11', {}),
  day('2025-12-12', {
    Candles: estInstant('2025-12-12', '16:10:00'),
    SunsetDefault: estInstant('2025-12-12', '16:28:00'),
    MinchaGra: estInstant('2025-12-12', '12:13:00'),
    NightShabbos: estInstant('2025-12-12', '17:15:00'),
    ShemaMA72: estInstant('2025-12-12', '08:46:00'),
    ShemaGra: estInstant('2025-12-12', '09:30:00'),
    Night50fix: estInstant('2025-12-12', '17:19:00'),
    Night60fix: estInstant('2025-12-12', '17:29:00'),
  }),
  day('2025-12-13', {
    SunsetDefault: estInstant('2025-12-13', '16:29:00'),
    MinchaGra: estInstant('2025-12-13', '12:14:00'),
    NightShabbos: estInstant('2025-12-13', '17:15:00'),
    ShemaMA72: estInstant('2025-12-13', '08:46:00'),
    ShemaGra: estInstant('2025-12-13', '09:30:00'),
    Night50fix: estInstant('2025-12-13', '17:20:00'),
    Night60fix: estInstant('2025-12-13', '17:30:00'),
  }),
]

function lineTime(doc: GeneratedDocument, name: string): string {
  const line = doc.sections[0]!.lines.find((l) => l.name === name)
  expect(line, `line "${name}" should exist`).toBeDefined()
  expect(line!.timeMinutes, `line "${name}" should have a time`).not.toBeNull()
  return formatMinutes(line!.timeMinutes!)
}

describe('Pozna acceptance: real Shabbos schedule, week of 2025-12-07', () => {
  const docs = generateWeek(poznaShabbosConfig, [], week, TZ)
  const erev = docs.find((d) => d.scheduleTypeId === 'pozna-erev')
  const shabbos = docs.find((d) => d.scheduleTypeId === 'pozna-shabbos')

  it('produces the Erev Shabbos document for Friday only', () => {
    expect(erev).toBeDefined()
    expect(erev!.dates).toEqual(['2025-12-12'])
  })

  it('(1) Mincha Gedolah clamps to 1:30 PM (Earliest Mincha 12:13 < 1:30)', () => {
    expect(lineTime(erev!, '(1) Mincha Gedolah')).toBe('1:30 PM')
  })

  it("Hadlakas Neiros = Friday's Candles = 4:10 PM", () => {
    expect(lineTime(erev!, 'Hadlakas Neiros')).toBe('4:10 PM')
  })

  it('(2) Mincha & Kabbolas Shabbos = Hadlakas Neiros = 4:10 PM', () => {
    expect(lineTime(erev!, '(2) Mincha & Kabbolas Shabbos')).toBe('4:10 PM')
  })

  it('(3) Mincha & Kabbolas Shabbos = Hadlakas Neiros + 10 = 4:20 PM', () => {
    expect(lineTime(erev!, '(3) Mincha & Kabbolas Shabbos')).toBe('4:20 PM')
  })

  it("קריאת שמע = Friday's NightShabbos = 5:15 PM", () => {
    expect(lineTime(erev!, 'קריאת שמע (ג׳ כוכבים)')).toBe('5:15 PM')
  })

  it('produces the Shabbos document for Saturday only', () => {
    expect(shabbos).toBeDefined()
    expect(shabbos!.dates).toEqual(['2025-12-13'])
  })

  it('סזק"ש מג"א = 8:46 AM', () => {
    expect(lineTime(shabbos!, 'סזק"ש מג"א')).toBe('8:46 AM')
  })

  it('סזק"ש גר"א = 9:30 AM', () => {
    expect(lineTime(shabbos!, 'סזק"ש גר"א')).toBe('9:30 AM')
  })

  it('(1) Mincha Gedolah clamps to 1:30 PM (Earliest Mincha 12:14 < 1:30)', () => {
    expect(lineTime(shabbos!, '(1) Mincha Gedolah')).toBe('1:30 PM')
  })

  it("(2) Mincha & Shalosh Seudos = Friday's Candles + 5 = 4:15 PM", () => {
    expect(lineTime(shabbos!, '(2) Mincha & Shalosh Seudos')).toBe('4:15 PM')
  })

  it("(1) Maariv Motzei Shabbos (50) = Saturday's Night50fix = 5:20 PM", () => {
    expect(lineTime(shabbos!, '(1) Maariv Motzei Shabbos (50)')).toBe('5:20 PM')
  })

  it("(2) Maariv Motzei Shabbos (60) = Saturday's Night60fix = 5:30 PM", () => {
    expect(lineTime(shabbos!, '(2) Maariv Motzei Shabbos (60)')).toBe('5:30 PM')
  })
})
