import { HDate, HebrewCalendar, Location, Zmanim, flags } from '@hebcal/core'
import type { DayType, ZmanName } from './rules'

// Calendar facts for one Gregorian date — everything the condition system
// (rules.ts) can ask about. Computed locally via @hebcal/core; no API calls.
export type DayFacts = {
  date: string // 'YYYY-MM-DD'
  dayOfWeek: number // 0=Sunday … 6=Saturday
  hebrewDate: string // e.g. '15 Nisan 5786'
  dayTypes: DayType[]
  /** hebcal event descriptions occurring on this day, e.g. 'Yom Kippur'. */
  holidays: string[]
  /** 'winter' between the equinox-ish halves used in shul scheduling: we use
   * Dec solstice-adjacent convention — winter = after Sukkot-side clock change
   * proxy: simple rule = months Nov–Mar. Admin-facing docs call this out; can
   * be refined per synagogue if a client needs a different definition. */
  season: 'winter' | 'summer'
}

function toDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function getDayFacts(date: Date, il = false): DayFacts {
  const hd = new HDate(date)
  const events = HebrewCalendar.calendar({
    start: hd,
    end: hd,
    il,
    sedrot: false,
    omer: false,
    candlelighting: false,
  })

  const holidays = events.map((e) => e.getDesc())
  const dow = date.getDay()

  const isShabbat = dow === 6
  const isYomTov = events.some((e) => (e.getFlags() & flags.CHAG) !== 0)
  const isCholHamoed = events.some((e) => (e.getFlags() & flags.CHOL_HAMOED) !== 0)
  const isRoshChodesh = events.some((e) => (e.getFlags() & flags.ROSH_CHODESH) !== 0)
  const isFast = events.some(
    (e) => (e.getFlags() & (flags.MAJOR_FAST | flags.MINOR_FAST)) !== 0,
  )
  const isErevYomTov = events.some((e) => (e.getFlags() & flags.EREV) !== 0)

  const dayTypes: DayType[] = []
  if (isYomTov && isShabbat) dayTypes.push('yom-tov-on-shabbat')
  if (isYomTov) dayTypes.push('yom-tov')
  if (isShabbat) dayTypes.push('shabbat')
  if (!isShabbat && !isYomTov) dayTypes.push('weekday')
  if (dow === 5) dayTypes.push('erev-shabbat')
  if (isErevYomTov) dayTypes.push('erev-yom-tov')
  if (isCholHamoed) dayTypes.push('chol-hamoed')
  if (isRoshChodesh) dayTypes.push('rosh-chodesh')
  if (isFast) dayTypes.push('fast-day')

  const month = date.getMonth() + 1
  const season: 'winter' | 'summer' = month >= 11 || month <= 3 ? 'winter' : 'summer'

  return {
    date: toDateString(date),
    dayOfWeek: dow,
    hebrewDate: hd.render('en'),
    dayTypes,
    holidays,
    season,
  }
}

// hebcal-computed zmanim — the FALLBACK source (myzmanim via the connector is
// primary, per spec). Same ZmanName vocabulary so the evaluator doesn't care
// which source filled the map.
export function getZmanimFallback(
  date: Date,
  latitude: number,
  longitude: number,
  timezone: string,
): Partial<Record<ZmanName, Date>> {
  const loc = new Location(latitude, longitude, false, timezone)
  const z = new Zmanim(loc, date, false)
  return {
    sunrise: z.sunrise(),
    sunset: z.sunset(),
    alos: z.alotHaShachar(),
    misheyakir: z.misheyakir(),
    'sof-zman-shma': z.sofZmanShma(),
    'sof-zman-tefilla': z.sofZmanTfilla(),
    chatzos: z.chatzot(),
    'mincha-gedola': z.minchaGedola(),
    'mincha-ketana': z.minchaKetana(),
    'plag-hamincha': z.plagHaMincha(),
    tzeis: z.tzeit(),
  }
}
