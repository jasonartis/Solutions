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

// Named times the zmanim source provides per (location, date).
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
      zman: zmanNameSchema,
      /** Take the zman from a single day (default) or aggregate across the week. */
      aggregate: z.enum(['earliest-of-week', 'latest-of-week']).optional(),
      offsetMinutes: z.number().int().default(0),
      round: roundSchema.optional(),
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
