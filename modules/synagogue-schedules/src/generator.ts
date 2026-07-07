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
  /** Per-date results for the document's dates (null time = free-form). */
  perDay: { date: string; timeMinutes: number | null }[]
  /** Set when every visible day resolves to the same time — render one value. */
  uniform: boolean
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
      const sections: GeneratedSection[] = []
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

        const lines: GeneratedLine[] = []
        for (const line of section.lines) {
          const perDay = visibleDays
            .map((d) => ({ date: d.facts.date, evaluated: evaluateLine(line, d, week, timeZone) }))
            .filter((r) => r.evaluated !== null)
            .map((r) => ({ date: r.date, timeMinutes: r.evaluated!.timeMinutes }))
          if (perDay.length === 0) continue

          const distinct = new Set(perDay.map((p) => p.timeMinutes))
          lines.push({
            name: line.name,
            nameHebrew: line.nameHebrew,
            timeMinutes: distinct.size === 1 ? (perDay[0]!.timeMinutes ?? null) : null,
            perDay,
            uniform: distinct.size === 1,
          })
        }

        if (lines.length > 0 || sectionOverrides.length > 0) {
          sections.push({
            name: section.name,
            nameHebrew: section.nameHebrew,
            lines,
            overrides: sectionOverrides,
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
