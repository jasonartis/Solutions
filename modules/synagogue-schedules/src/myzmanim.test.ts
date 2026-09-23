import { describe, expect, it } from 'vitest'
import { parseZmanim } from './myzmanim'

// Guards for the two bugs fixed 2026-09-23. Both were invisible until the live
// API was probed directly, and both are pure-function testable, which is why
// `parseZmanim` was split out of `fetchMyzmanimDay`.
//
// THE FIXTURE IS REAL, not invented: these are the field names and the exact
// sentinel spelling returned by api.myzmanim.com/engine1.json.aspx/getDay on
// 2026-09-23. The live response carried 89 Zman fields, 81 of them the
// sentinel, and the 8 that were not are `Prop*` ratios sent as NUMBERS.

describe('parseZmanim — the missing-value sentinel', () => {
  it('drops the sentinel the API actually sends (no trailing Z)', () => {
    // THE BUG: the old guard compared against '0001-01-01T00:00:00Z'. The API
    // sends it WITHOUT the Z, so the guard never matched and every absent time
    // became a valid year-1 Date that flowed into the schedule as a real time.
    const out = parseZmanim({ Zman: { Candles: '0001-01-01T00:00:00' } })
    expect(out.Candles, 'the sentinel was parsed as a real time').toBeUndefined()
  })

  it('also drops the sentinel as the Apps Script documented it (with Z)', () => {
    // The two spellings disagree and only one can be right, so neither is
    // trusted — the filter is on the YEAR. If this ever regresses to a string
    // compare, one of these two tests fails whichever spelling is chosen.
    const out = parseZmanim({ Zman: { Candles: '0001-01-01T00:00:00Z' } })
    expect(out.Candles).toBeUndefined()
  })

  it('CONTROL: a real time survives — the filter is not simply dropping everything', () => {
    const out = parseZmanim({ Zman: { SunriseDefault: '2026-09-23T06:47:00' } })
    expect(out.SunriseDefault, 'a genuine time was discarded').toBeInstanceOf(Date)
    expect(out.SunriseDefault?.getUTCFullYear()).toBe(2026)
  })

  it('ignores the numeric Prop* ratio fields rather than coercing them to 1970', () => {
    // Measured: PropGra and its siblings come back as the NUMBER 0, not a
    // string. `new Date(0)` would be a valid 1970 Date, so a parser that did
    // not check the type would publish eight bogus times per day.
    const out = parseZmanim({ Zman: { PropGra: 0, PropMA72: 0, SunriseDefault: '2026-09-23T06:47:00' } })
    expect(out.PropGra).toBeUndefined()
    expect(out.PropMA72).toBeUndefined()
    expect(Object.keys(out)).toEqual(['SunriseDefault'])
  })

  it('an all-sentinel response parses to EMPTY, so buildWeek still falls back to hebcal', () => {
    // This is the consequence that matters, not the field count. `buildWeek`
    // only reaches for hebcal when the parsed map is empty, so with the old
    // guard a sentinel-filled response would have suppressed the fallback and
    // rendered a week of year-1 times instead.
    const allSentinel = Object.fromEntries(
      ['Candles', 'SunriseDefault', 'SunsetDefault', 'ShemaGra', 'MinchaGra'].map((f) => [
        f,
        '0001-01-01T00:00:00',
      ]),
    )
    expect(parseZmanim({ Zman: allSentinel })).toEqual({})
  })

  it('tolerates a response with no Zman section at all', () => {
    expect(parseZmanim({})).toEqual({})
    expect(parseZmanim({ ErrMsg: 'NotAuthorizedSeeApiDashboardForDetails' })).toEqual({})
  })
})
