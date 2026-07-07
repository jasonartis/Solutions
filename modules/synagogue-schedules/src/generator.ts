import { getWeekFacts, renderTitle } from './calendar'
import { conditionMatches, evaluateLine, type DayContext, type EvaluatedLine } from './evaluator'
import type { Condition, LineRule } from './rules'

// Assembles schedule documents for one week from a synagogue's configuration.
// Pure data-in/data-out: DB rows and computed day contexts come in, renderable
// document structures come out. The web UI and the export renderer both
// consume GeneratedDocument.

export type ScheduleTypeConfig = {
  id: string
  name: string
  nameHebrew: string | null
  triggerCondition: Condition
  span: 'week' | 'day'
  sections: SectionConfig[]
}

export type SectionConfig = {
  id: string
  name: string
  nameHebrew: string | null
  visibilityCondition: Condition
  lines: LineConfig[]
}

export type LineConfig = {
  name: string
  nameHebrew: string | null
  rule: LineRule
}

export type OverrideConfig = {
  sectionId: string
  text: string | null
  textHebrew: string | null
}

export type GeneratedLine = EvaluatedLine & {
  /** Per-date results for the document's dates (null time = free-form/text). */
  perDay: { date: string; timeMinutes: number | null }[]
  /** Set when every visible day resolves to the same time — render one value. */
  uniform: boolean
  /** Fallback text shown instead of a time ("Will resume next week"). */
  text: string | null
}

export type GeneratedSection = {
  name: string
  nameHebrew: string | null
  lines: GeneratedLine[]
  overrides: { text: string | null; textHebrew: string | null }[]
}

export type GeneratedDocument = {
  scheduleTypeId: string
  scheduleTypeName: string
  /** scheduleTypeName with template tokens rendered ({parsha}, {shabbatTitle},
   * {hebrewYear}, {mevorchim}, {moladText}, …) — what displays and exports show. */
  title: string
  span: 'week' | 'day'
  /** The dates this document covers ('YYYY-MM-DD'). */
  dates: string[]
  sections: GeneratedSection[]
}

function emptyCondition(c: Condition): boolean {
  return Object.keys(c).length === 0
}

export function generateWeek(
  scheduleTypes: ScheduleTypeConfig[],
  overrides: OverrideConfig[],
  week: DayContext[],
  timeZone: string,
  options: { il?: boolean } = {},
): GeneratedDocument[] {
  const weekHolidays = week.flatMap((d) => d.facts.holidays)
  const documents: GeneratedDocument[] = []

  // Week facts for title templating: computed from any date in the week.
  const anyDate = week[0] ? new Date(`${week[0].facts.date}T12:00:00`) : new Date(0)
  const weekFacts = getWeekFacts(anyDate, options.il ?? false)

  for (const type of scheduleTypes) {
    const matchingDays = week.filter(
      (d) =>
        emptyCondition(type.triggerCondition) ||
        conditionMatches(type.triggerCondition, d.facts, weekHolidays),
    )
    if (matchingDays.length === 0) continue

    // 'week': one document covering all matching days.
    // 'day': one full document per matching day (e.g. Yom Kippur sheet).
    const dateGroups = type.span === 'week' ? [matchingDays] : matchingDays.map((d) => [d])

    for (const days of dateGroups) {
      // Two-pass evaluation: normal lines first, then line-ref lines resolving
      // against them by name+date ("(3) Mincha & Kabbalos Shabbos = (2) + 10").
      const resolvedTimes = new Map<string, Map<string, number>>() // date -> lineName -> minutes

      type SectionWork = {
        section: SectionConfig
        visibleDays: DayContext[]
        sectionOverrides: { text: string | null; textHebrew: string | null }[]
        results: Map<LineConfig, { date: string; timeMinutes: number | null; text: string | null }[]>
      }
      const work: SectionWork[] = []
      for (const section of type.sections) {
        const visibleDays = days.filter(
          (d) =>
            emptyCondition(section.visibilityCondition) ||
            conditionMatches(section.visibilityCondition, d.facts, weekHolidays),
        )
        const sectionOverrides = overrides
          .filter((o) => o.sectionId === section.id)
          .map((o) => ({ text: o.text, textHebrew: o.textHebrew }))
        if (visibleDays.length === 0 && sectionOverrides.length === 0) continue
        work.push({ section, visibleDays, sectionOverrides, results: new Map() })
      }

      for (const pass of [1, 2] as const) {
        for (const w of work) {
          for (const line of w.section.lines) {
            const isRef = line.rule.time.kind === 'line-ref'
            if ((pass === 1) === isRef) continue
            const perDay = w.visibleDays
              .map((d) => ({
                date: d.facts.date,
                evaluated: evaluateLine(line, d, week, timeZone, (name) =>
                  resolvedTimes.get(d.facts.date)?.get(name) ?? null,
                ),
              }))
              .filter((r) => r.evaluated !== null)
              .map((r) => ({
                date: r.date,
                timeMinutes: r.evaluated!.timeMinutes,
                text: r.evaluated!.text,
              }))
            if (perDay.length === 0) continue
            w.results.set(line, perDay)
            for (const p of perDay) {
              if (p.timeMinutes !== null) {
                if (!resolvedTimes.has(p.date)) resolvedTimes.set(p.date, new Map())
                resolvedTimes.get(p.date)!.set(line.name, p.timeMinutes)
              }
            }
          }
        }
      }

      const sections: GeneratedSection[] = []
      for (const w of work) {
        const lines: GeneratedLine[] = []
        for (const line of w.section.lines) {
          const perDay = w.results.get(line)
          if (!perDay) continue
          const text = perDay.find((p) => p.text !== null)?.text ?? null
          const distinct = new Set(perDay.map((p) => p.timeMinutes))
          lines.push({
            name: line.name,
            nameHebrew: line.nameHebrew,
            timeMinutes: distinct.size === 1 ? (perDay[0]!.timeMinutes ?? null) : null,
            text,
            perDay: perDay.map((p) => ({ date: p.date, timeMinutes: p.timeMinutes })),
            uniform: distinct.size === 1,
          })
        }
        if (lines.length > 0 || w.sectionOverrides.length > 0) {
          sections.push({
            name: w.section.name,
            nameHebrew: w.section.nameHebrew,
            lines,
            overrides: w.sectionOverrides,
          })
        }
      }

      if (sections.length > 0) {
        documents.push({
          scheduleTypeId: type.id,
          scheduleTypeName: type.name,
          title: renderTitle(type.name, weekFacts),
          span: type.span,
          dates: days.map((d) => d.facts.date),
          sections,
        })
      }
    }
  }

  return documents
}
