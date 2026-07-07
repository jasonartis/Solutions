import { HDate, HebrewCalendar, Location, Molad, Zmanim, flags, gematriya } from '@hebcal/core'
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

// Facts about the week's Shabbat, for title templating (replaces the
// founder's GET_PARASHA_HEB_FULL_PLUS Apps Script). Modifier list from the
// Pozna layout spec: Mevorchim, Chanukah, Rosh Chodesh, special Shabbatot
// (Shira, Arbah Parshiyos, HaGadol, Chazon, Nachamu, Shuva, Chol Hamoed).
export type WeekFacts = {
  /** e.g. 'פרשת מטות־מסעי' */
  parshaHe: string | null
  /** e.g. 'Parashat Matot-Masei' */
  parshaEn: string | null
  /** Hebrew year in gematria, e.g. 'תשפ"ו' */
  hebrewYear: string
  isMevorchim: boolean
  isRoshChodesh: boolean
  isChanukah: boolean
  /** Hebrew names of special Shabbatot falling on this Shabbat (שבת שירה, שבת הגדול…). */
  specialShabbatot: string[]
  /** Molad of the month being blessed (only when isMevorchim), e.g.
   * 'Tuesday, 7:30 PM and 17 chalakim'. */
  moladText: string | null
}

export function getWeekFacts(dateInWeek: Date, il = false): WeekFacts {
  // Normalize to the week's Saturday.
  const sat = new Date(dateInWeek)
  sat.setDate(sat.getDate() + ((6 - sat.getDay() + 7) % 7))
  const hd = new HDate(sat)

  const events = HebrewCalendar.calendar({
    start: hd,
    end: hd,
    il,
    sedrot: true,
    shabbatMevarchim: true,
    omer: false,
    candlelighting: false,
  })

  let parshaHe: string | null = null
  let parshaEn: string | null = null
  let isMevorchim = false
  const specialShabbatot: string[] = []
  for (const e of events) {
    const fl = e.getFlags()
    if ((fl & flags.PARSHA_HASHAVUA) !== 0) {
      parshaEn = e.render('en')
      parshaHe = e.render('he').replace(/[֑-ׇ]/g, '') // strip nikud
    }
    if ((fl & flags.SHABBAT_MEVARCHIM) !== 0) isMevorchim = true
    if ((fl & flags.SPECIAL_SHABBAT) !== 0) {
      specialShabbatot.push(e.render('he').replace(/[֑-ׇ]/g, ''))
    }
  }

  const satFacts = getDayFacts(sat, il)

  let moladText: string | null = null
  if (isMevorchim) {
    try {
      // The month being blessed = the month after this Shabbat's month.
      const nextMonthDate = new HDate(1, hd.getMonth(), hd.getFullYear()).add(1, 'month')
      const molad = new Molad(nextMonthDate.getFullYear(), nextMonthDate.getMonth())
      const dowNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
      const h24 = molad.getHour()
      const h12 = h24 % 12 === 0 ? 12 : h24 % 12
      const ampm = h24 < 12 ? 'AM' : 'PM'
      moladText = `${dowNames[molad.getDow()]}, ${h12}:${String(molad.getMinutes()).padStart(2, '0')} ${ampm} and ${molad.getChalakim()} chalakim`
    } catch {
      moladText = null
    }
  }

  return {
    parshaHe,
    parshaEn,
    hebrewYear: gematriya(hd.getFullYear() % 1000),
    isMevorchim,
    isRoshChodesh: satFacts.dayTypes.includes('rosh-chodesh'),
    isChanukah: satFacts.holidays.some((h) => /chanukah/i.test(h)),
    specialShabbatot,
    moladText,
  }
}

/** Render a schedule-type name that may contain template tokens.
 * Tokens: {parsha} {parshaEn} {hebrewYear} {special} {moladText}
 * and {shabbatTitle} — the full composed title exactly like the founder's
 * Apps Script: "שבת פרשת <parsha>[ - שבת <modifiers>] <year>". */
export function renderTitle(template: string, f: WeekFacts): string {
  const modifiers: string[] = []
  if (f.isChanukah) modifiers.push('חנוכה')
  if (f.isRoshChodesh) modifiers.push('ראש חודש')
  if (f.isMevorchim) modifiers.push('מברכים')
  for (const s of f.specialShabbatot) modifiers.push(s.replace(/^שבת\s+/, ''))

  let shabbatTitle = f.parshaHe ? `שבת ${f.parshaHe}` : 'שבת'
  if (modifiers.length > 0) shabbatTitle += ` - שבת ${modifiers.join(' ו')}`
  shabbatTitle += ` ${f.hebrewYear}`

  return template
    .replaceAll('{shabbatTitle}', shabbatTitle)
    .replaceAll('{parsha}', f.parshaHe ?? '')
    .replaceAll('{parshaEn}', f.parshaEn ?? '')
    .replaceAll('{hebrewYear}', f.hebrewYear)
    .replaceAll('{special}', f.specialShabbatot.join(' '))
    .replaceAll('{moladText}', f.moladText ?? '')
    .replaceAll('{mevorchim}', f.isMevorchim ? 'מברכים' : '')
    .replace(/\s{2,}/g, ' ')
    .trim()
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
