import { z } from 'zod'

// The rule grammar (spec: "line time rule = condition + time").
// Structured data, not code — admins build these in the UI, the evaluator
// interprets them. Every confirmed real-world example must stay expressible:
//   Maariv  = { time: { kind: 'zman', zman: 'sunset', offsetMinutes: -15 } }
//   Mincha1 = { time: { kind: 'fixed', clock: '18:00' } }
//   Mincha2 = { condition: { season: 'winter' },
//               time: { kind: 'zman', zman: 'sunrise', offsetMinutes: 60 } }
//   "earliest sunset of the week − 20, rounded down to 5" =
//             { time: { kind: 'zman', zman: 'sunset', aggregate: 'earliest-of-week',
//                       offsetMinutes: -20, round: { direction: 'down', toMinutes: 5 } } }

// Day-type vocabulary computed by calendar.ts from @hebcal/core.
export const dayTypeSchema = z.enum([
  'weekday',
  'erev-shabbat',
  'shabbat',
  'erev-yom-tov',
  'yom-tov',
  'yom-tov-on-shabbat',
  'chol-hamoed',
  'rosh-chodesh',
  'fast-day',
])
export type DayType = z.infer<typeof dayTypeSchema>

export const conditionSchema = z
  .object({
    /** Line shows only on these day types (any match). Empty/absent = all. */
    dayTypes: z.array(dayTypeSchema).optional(),
    /** Specific weekdays, 0=Sunday…6=Saturday (Pozna: "Shachris Sun–Fri 6:10 / Mon–Fri 6:50"). */
    daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
    /** 'winter' / 'summer' per the halachic year halves (calendar.ts decides). */
    season: z.enum(['winter', 'summer']).optional(),
    /** Only when one of these holidays occurs on the day (hebcal holiday keys). */
    holidays: z.array(z.string()).optional(),
    /** Only when one of these holidays occurs anywhere in the schedule's week. */
    holidaysInWeek: z.array(z.string()).optional(),
    /** Gregorian date range, inclusive, 'YYYY-MM-DD'. */
    dateFrom: z.string().optional(),
    dateTo: z.string().optional(),
  })
  .strict()
export type Condition = z.infer<typeof conditionSchema>

// Curated zman suggestions for UI dropdowns. Rules accept ANY string —
// myzmanim field names (SunsetDefault, MinchaGra, Night50fix, Candles, …)
// are the canonical vocabulary (founder's sheet uses ~90 of them); these
// friendly names are aliases resolved by the evaluator.
export const zmanNameSchema = z.enum([
  'sunrise',
  'sunset',
  'candle-lighting',
  'havdalah',
  'alos',
  'misheyakir',
  'sof-zman-shma',
  'sof-zman-tefilla',
  'chatzos',
  'mincha-gedola',
  'mincha-ketana',
  'plag-hamincha',
  'tzeis',
])
export type ZmanName = z.infer<typeof zmanNameSchema>

/** friendly alias -> myzmanim field name (both directions resolved at lookup) */
export const ZMAN_ALIASES: Record<string, string> = {
  sunrise: 'SunriseDefault',
  sunset: 'SunsetDefault',
  'candle-lighting': 'Candles',
  havdalah: 'Night72fix',
  alos: 'Dawn72',
  misheyakir: 'YakirDefault',
  'sof-zman-shma': 'ShemaGra',
  'sof-zman-tefilla': 'ShachrisGra',
  chatzos: 'Midday',
  'mincha-gedola': 'MinchaGra',
  'mincha-ketana': 'KetanaGra',
  'plag-hamincha': 'PlagGra',
  tzeis: 'NightShabbos',
}

export const roundSchema = z
  .object({
    direction: z.enum(['down', 'up', 'nearest']),
    toMinutes: z.number().int().positive(),
  })
  .strict()

export const timeSpecSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('fixed'),
      /** Wall clock 'HH:MM' in the synagogue's timezone. */
      clock: z.string().regex(/^\d{2}:\d{2}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('zman'),
      /** myzmanim field name or a friendly alias (ZMAN_ALIASES). */
      zman: z.string().min(1),
      /** Take the zman from this day (default), a specific weekday's value held
       * for the whole week (Pozna: "8 min before Sunday's Plag", "Friday's
       * Candles"), or a week aggregate. */
      aggregate: z
        .union([
          z.enum(['earliest-of-week', 'latest-of-week']),
          z.object({ dayOfWeek: z.number().int().min(0).max(6) }).strict(),
        ])
        .optional(),
      offsetMinutes: z.number().int().default(0),
      round: roundSchema.optional(),
      /** Clamp the final time (Pozna: Mincha Gedolah = max(EarliestMincha, 1:30 PM)). */
      notBefore: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      notAfter: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    })
    .strict(),
  z
    .object({
      /** Free-form line with no time (e.g. "Coffee sponsored by John Doe"). */
      kind: z.literal('none'),
    })
    .strict(),
])
export type TimeSpec = z.infer<typeof timeSpecSchema>

export const lineRuleSchema = z
  .object({
    condition: conditionSchema.optional(),
    time: timeSpecSchema,
  })
  .strict()
export type LineRule = z.infer<typeof lineRuleSchema>
