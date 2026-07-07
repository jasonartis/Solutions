import type { DayFacts } from './calendar'
import { ZMAN_ALIASES, type Condition, type LineRule, type TimeSpec } from './rules'

// Evaluates line rules into displayable wall-clock times.
// All times are "minutes since midnight" in the synagogue's timezone — the
// schedule is a wall-clock artifact, so we convert zmanim (Dates) to wall
// minutes once and do all arithmetic in that space.

export type DayContext = {
  facts: DayFacts
  /** Zmanim for this date, keyed by myzmanim field name and/or friendly alias
   * (myzmanim primary, hebcal fallback). */
  zmanim: Partial<Record<string, Date>>
}

const ALIAS_REVERSED: Record<string, string> = Object.fromEntries(
  Object.entries(ZMAN_ALIASES).map(([friendly, field]) => [field, friendly]),
)

/** Look a zman up by either vocabulary — rule names and source keys may mix
 * friendly aliases and myzmanim field names. */
export function lookupZman(
  zmanim: Partial<Record<string, Date>>,
  name: string,
): Date | undefined {
  return zmanim[name] ?? zmanim[ZMAN_ALIASES[name] ?? ''] ?? zmanim[ALIAS_REVERSED[name] ?? '']
}

export function wallMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  return hour * 60 + minute
}

export function formatMinutes(minutes: number): string {
  const h24 = Math.floor(minutes / 60) % 24
  const m = minutes % 60
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h12}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`
}

export function roundMinutes(
  minutes: number,
  round: { direction: 'down' | 'up' | 'nearest'; toMinutes: number },
): number {
  const q = minutes / round.toMinutes
  const rounded =
    round.direction === 'down' ? Math.floor(q) : round.direction === 'up' ? Math.ceil(q) : Math.round(q)
  return rounded * round.toMinutes
}

export function conditionMatches(
  condition: Condition | undefined,
  facts: DayFacts,
  weekHolidays: string[],
): boolean {
  if (!condition) return true
  if (condition.dayTypes && !condition.dayTypes.some((t) => facts.dayTypes.includes(t))) {
    return false
  }
  if (condition.daysOfWeek && !condition.daysOfWeek.includes(facts.dayOfWeek)) return false
  if (condition.season && condition.season !== facts.season) return false
  if (condition.holidays && !condition.holidays.some((h) => facts.holidays.includes(h))) {
    return false
  }
  if (
    condition.holidaysInWeek &&
    !condition.holidaysInWeek.some((h) => weekHolidays.includes(h))
  ) {
    return false
  }
  if (condition.dateFrom && facts.date < condition.dateFrom) return false
  if (condition.dateTo && facts.date > condition.dateTo) return false
  return true
}

export function resolveTime(
  spec: TimeSpec,
  day: DayContext,
  week: DayContext[],
  timeZone: string,
  /** Resolver for line-ref specs: another line's minutes on this day, or null.
   * Supplied by the generator's second pass. */
  resolveLineRef?: (lineName: string) => number | null,
): number | null {
  if (spec.kind === 'none') return null

  if (spec.kind === 'line-ref') {
    const base = resolveLineRef?.(spec.line) ?? null
    if (base === null) return null
    let result = base + (spec.offsetMinutes ?? 0)
    if (spec.round) result = roundMinutes(result, spec.round)
    return result
  }

  if (spec.kind === 'fixed') {
    const [h, m] = spec.clock.split(':').map(Number)
    return (h ?? 0) * 60 + (m ?? 0)
  }

  // kind === 'zman'
  let base: number | null = null
  if (typeof spec.aggregate === 'object') {
    // Day-anchored: this weekday's value, held for the whole week
    // (Pozna: "8 minutes before Sunday's Plag", "Friday's Candles").
    const wanted = spec.aggregate.dayOfWeek
    const anchorDay = week.find((d) => d.facts.dayOfWeek === wanted)
    const instant = anchorDay ? lookupZman(anchorDay.zmanim, spec.zman) : undefined
    if (!instant) return null
    base = wallMinutes(instant, timeZone)
  } else if (spec.aggregate) {
    const candidates = week
      .map((d) => lookupZman(d.zmanim, spec.zman))
      .filter((d): d is Date => d instanceof Date)
      .map((d) => wallMinutes(d, timeZone))
    if (candidates.length === 0) return null
    base = spec.aggregate === 'earliest-of-week' ? Math.min(...candidates) : Math.max(...candidates)
  } else {
    const instant = lookupZman(day.zmanim, spec.zman)
    if (!instant) return null
    base = wallMinutes(instant, timeZone)
  }

  let result = base + (spec.offsetMinutes ?? 0)
  if (spec.round) result = roundMinutes(result, spec.round)

  const clockToMinutes = (clock: string) => {
    const [h, m] = clock.split(':').map(Number)
    return (h ?? 0) * 60 + (m ?? 0)
  }
  if (spec.notBefore) result = Math.max(result, clockToMinutes(spec.notBefore))
  if (spec.notAfter) result = Math.min(result, clockToMinutes(spec.notAfter))
  return result
}

export type EvaluatedLine = {
  name: string
  nameHebrew: string | null
  /** null = free-form line or a text result */
  timeMinutes: number | null
  /** Set instead of a time when the condition failed but the rule declares
   * fallbackText ("Will resume next week"). */
  text: string | null
}

/** Evaluate one line's rule for one day within its week. Returns null when
 * the line's condition doesn't match and no fallback text is declared. */
export function evaluateLine(
  line: { name: string; nameHebrew: string | null; rule: LineRule },
  day: DayContext,
  week: DayContext[],
  timeZone: string,
  resolveLineRef?: (lineName: string) => number | null,
): EvaluatedLine | null {
  const weekHolidays = week.flatMap((d) => d.facts.holidays)
  if (!conditionMatches(line.rule.condition, day.facts, weekHolidays)) {
    if (line.rule.fallbackText) {
      return {
        name: line.name,
        nameHebrew: line.nameHebrew,
        timeMinutes: null,
        text: line.rule.fallbackText,
      }
    }
    return null
  }
  return {
    name: line.name,
    nameHebrew: line.nameHebrew,
    timeMinutes: resolveTime(line.rule.time, day, week, timeZone, resolveLineRef),
    text: null,
  }
}
