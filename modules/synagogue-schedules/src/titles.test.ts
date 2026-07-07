import { describe, expect, it } from 'vitest'
import { getWeekFacts, renderTitle } from './calendar'

// Acceptance-grade checks against the founder's real printed titles.
// The Pozna weekday sheet for the week of 2026-07-05 is headed:
//   "זמני ימי חול פרשת מטות - מסעי - מברכים תשפ"ו"
// i.e. Shabbat 2026-07-11 = Parshas Matos-Masei, Shabbos Mevorchim (Av), 5786.

describe('getWeekFacts', () => {
  const facts = getWeekFacts(new Date('2026-07-07T12:00:00-04:00'))

  it('finds the parsha for the week of Matos-Masei', () => {
    expect(facts.parshaHe ?? '').toContain('מטות')
    expect(facts.parshaEn ?? '').toMatch(/Mat+ot/)
  })

  it('knows it is Shabbos Mevorchim (Rosh Chodesh Av the following week)', () => {
    expect(facts.isMevorchim).toBe(true)
  })

  it('renders the Hebrew year 5786 as gematria', () => {
    expect(facts.hebrewYear).toContain('תשפ')
  })

  it('produces a molad line for the blessed month', () => {
    expect(facts.moladText).toMatch(/chalakim/)
  })
})

describe('renderTitle', () => {
  const facts = getWeekFacts(new Date('2026-07-07T12:00:00-04:00'))

  it('composes the weekday-sheet header from tokens', () => {
    const title = renderTitle('זמני ימי חול {parsha} - {mevorchim} {hebrewYear}', facts)
    expect(title).toContain('זמני ימי חול')
    expect(title).toContain('מטות')
    expect(title).toContain('מברכים')
    expect(title).toContain('תשפ')
  })

  it('composes the full shabbatTitle like GET_PARASHA_HEB_FULL_PLUS', () => {
    const title = renderTitle('{shabbatTitle}', facts)
    expect(title).toMatch(/^שבת פרשת/)
    expect(title).toContain('מברכים')
    expect(title).toMatch(/תשפ.ו$/)
  })

  it('leaves plain names untouched', () => {
    expect(renderTitle('Weekday Schedule', facts)).toBe('Weekday Schedule')
  })

  it('non-mevorchim week omits the modifier', () => {
    // Week of 2026-06-14 (Shabbat 2026-06-20, mid-Sivan — not mevorchim).
    const plain = getWeekFacts(new Date('2026-06-16T12:00:00-04:00'))
    const title = renderTitle('{shabbatTitle}', plain)
    expect(title).not.toContain('מברכים')
  })
})
