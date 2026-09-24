import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildWeekWithProvenance, parseZmanim, type MyzmanimResponse } from './myzmanim'

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

// ---------------------------------------------------------------------------
// THE READ-THROUGH CACHE (docs/23). The point of the whole slice is that a warm
// week costs ZERO API calls where today it costs seven serial paid ones, so the
// call count is asserted directly rather than inferred from the output.
// ---------------------------------------------------------------------------

const SUNDAY = '2026-09-20'
const WEEK = ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26']

/** A cached response carrying one real time, so parseZmanim yields something. */
const payloadFor = (iso: string): MyzmanimResponse => ({
  Zman: { SunriseDefault: `${iso}T06:47:00`, Candles: '0001-01-01T00:00:00' },
})

const BROOKLYN = { latitude: 40.7128, longitude: -73.9497, timeZone: 'America/New_York' }

afterEach(() => { vi.unstubAllGlobals() })

/** Counts fetches so "no API call" is measured, not assumed. */
function stubFetch() {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (...args: unknown[]) => {
    calls.push(String(args[0]))
    throw new Error('the test made a real API call')
  })
  return calls
}

describe('buildWeekWithProvenance — cache first', () => {
  it('a fully warm week makes ZERO api calls and reports every day as cached', async () => {
    const calls = stubFetch()
    const cache = async () => new Map(WEEK.map((iso) => [iso, payloadFor(iso)]))

    const { days, provenance } = await buildWeekWithProvenance(SUNDAY, {
      ...BROOKLYN,
      myzmanimLocationId: 'US11210',
      credentials: { user: 'u', key: 'k' },
      cache,
    })

    expect(calls, 'the cache was warm but the API was still called').toEqual([])
    expect(days).toHaveLength(7)
    expect(Object.values(provenance)).toEqual(Array(7).fill('cache'))
    expect(days[0]!.zmanim.SunriseDefault).toBeInstanceOf(Date)
  })

  it('reads the whole week in ONE round trip, not one per day', async () => {
    stubFetch()
    const ranges: string[] = []
    const cache = async (loc: string, from: string, to: string) => {
      ranges.push(`${loc}:${from}..${to}`)
      return new Map(WEEK.map((iso) => [iso, payloadFor(iso)]))
    }
    await buildWeekWithProvenance(SUNDAY, {
      ...BROOKLYN, myzmanimLocationId: 'US11210', credentials: { user: 'u', key: 'k' }, cache,
    })
    expect(ranges).toEqual(['US11210:2026-09-20..2026-09-26'])
  })

  it('a PARTIAL cache falls back per-day without re-fetching the days it has', async () => {
    // The gap-fill case: some days cached, the rest must still resolve. The
    // credentials are omitted so the API path is unavailable and uncached days
    // land on hebcal — which is what a maker would see mid-backfill.
    const calls = stubFetch()
    const cache = async () => new Map([['2026-09-20', payloadFor('2026-09-20')]])

    const { provenance } = await buildWeekWithProvenance(SUNDAY, {
      ...BROOKLYN, myzmanimLocationId: 'US11210', credentials: null, cache,
    })

    expect(calls).toEqual([])
    expect(provenance['2026-09-20']).toBe('cache')
    expect(provenance['2026-09-21'], 'an uncached day should have fallen back').toBe('fallback')
  })

  it('a POISONED cache row (all sentinels) does not count as cached', async () => {
    // docs/23 section 5: never cache a failure. If one ever slips in, it must
    // not masquerade as real data — it parses to nothing, so the day falls back
    // rather than rendering year-1 times.
    stubFetch()
    const poisoned: MyzmanimResponse = {
      ErrMsg: 'NotAuthorizedSeeApiDashboardForDetails',
      Zman: { SunriseDefault: '0001-01-01T00:00:00', Candles: '0001-01-01T00:00:00' },
    }
    const cache = async () => new Map(WEEK.map((iso) => [iso, poisoned]))

    const { provenance } = await buildWeekWithProvenance(SUNDAY, {
      ...BROOKLYN, myzmanimLocationId: 'US11210', credentials: null, cache,
    })
    expect(Object.values(provenance)).toEqual(Array(7).fill('fallback'))
  })

  it('a cache that THROWS degrades to the old behaviour instead of breaking the page', async () => {
    stubFetch()
    const cache = async () => { throw new Error('database unavailable') }
    const { days, provenance } = await buildWeekWithProvenance(SUNDAY, {
      ...BROOKLYN, myzmanimLocationId: 'US11210', credentials: null, cache,
    })
    expect(days).toHaveLength(7)
    expect(Object.values(provenance)).toEqual(Array(7).fill('fallback'))
  })

  it('CONTROL: with no cache supplied at all, behaviour is exactly as before', async () => {
    stubFetch()
    const { days, provenance } = await buildWeekWithProvenance(SUNDAY, {
      ...BROOKLYN, myzmanimLocationId: 'US11210', credentials: null,
    })
    expect(days).toHaveLength(7)
    expect(Object.values(provenance)).toEqual(Array(7).fill('fallback'))
  })
})
