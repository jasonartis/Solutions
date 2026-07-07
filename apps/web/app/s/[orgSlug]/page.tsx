import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
  buildWeek,
  formatMinutes,
  generateWeek,
  lineRuleSchema,
  myzmanimCredsFromEnv,
  type Condition,
  type ScheduleTypeConfig,
} from '@modules/synagogue-schedules'
import { createClient } from '@/lib/supabase/server'

// PUBLIC page — no login. All data comes through the syn_public_* database
// functions, which only expose weeks the maker has published.

type PublicWeekData = {
  org: { name: string }
  settings: {
    latitude?: number
    longitude?: number
    timezone?: string
    israel?: boolean
    myzmanimLocationId?: string
  }
  types: { id: string; name: string; name_hebrew: string | null; trigger_condition: Condition; span: 'week' | 'day' }[]
  sections: { id: string; schedule_type_id: string; name: string; name_hebrew: string | null; visibility_condition: Condition }[]
  lines: { id: string; section_id: string; name: string; name_hebrew: string | null; rule: unknown }[]
  overrides: { section_id: string; text: string | null; text_hebrew: string | null }[]
}

export default async function PublicSchedulePage(props: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ week?: string }>
}) {
  const { orgSlug } = await props.params
  const { week: weekParam } = await props.searchParams
  const supabase = await createClient()

  const { data: index } = await supabase.rpc('syn_public_weeks', { p_org_slug: orgSlug })
  if (!index) notFound()
  const weeks: string[] = index.weeks ?? []
  const orgName: string = index.org?.name ?? orgSlug

  const selectedWeek = weekParam && weeks.includes(weekParam) ? weekParam : weeks[0]

  let documents = null
  let timeZone = 'America/New_York'
  if (selectedWeek) {
    const { data } = await supabase.rpc('syn_public_week', {
      p_org_slug: orgSlug,
      p_week_start: selectedWeek,
    })
    const week = data as PublicWeekData | null
    if (week) {
      timeZone = week.settings.timezone ?? timeZone
      const days = await buildWeek(selectedWeek, {
        latitude: week.settings.latitude,
        longitude: week.settings.longitude,
        timeZone,
        israel: week.settings.israel,
        myzmanimLocationId: week.settings.myzmanimLocationId,
        credentials: myzmanimCredsFromEnv(),
      })
      const config: ScheduleTypeConfig[] = week.types.map((t) => ({
        id: t.id,
        name: t.name,
        nameHebrew: t.name_hebrew,
        triggerCondition: t.trigger_condition ?? {},
        span: t.span,
        sections: week.sections
          .filter((s) => s.schedule_type_id === t.id)
          .map((s) => ({
            id: s.id,
            name: s.name,
            nameHebrew: s.name_hebrew,
            visibilityCondition: s.visibility_condition ?? {},
            lines: week.lines
              .filter((l) => l.section_id === s.id)
              .flatMap((l) => {
                const parsed = lineRuleSchema.safeParse(l.rule)
                return parsed.success
                  ? [{ name: l.name, nameHebrew: l.name_hebrew, rule: parsed.data }]
                  : []
              }),
          })),
      }))
      documents = generateWeek(
        config,
        week.overrides.map((o) => ({
          sectionId: o.section_id,
          text: o.text,
          textHebrew: o.text_hebrew,
        })),
        days,
        timeZone,
      )
    }
  }

  const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone })
  const weekdayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone })

  return (
    <main className="mx-auto min-h-screen max-w-4xl bg-white p-6">
      <header className="mb-6 border-b-4 border-double border-blue-800 pb-3 text-center">
        <h1 className="text-2xl font-semibold text-blue-800">{orgName}</h1>
        {selectedWeek && (
          <p className="mt-1 text-sm text-gray-500">
            Week of {fmt.format(new Date(`${selectedWeek}T12:00:00`))}
          </p>
        )}
      </header>

      {weeks.length > 1 && (
        <nav className="mb-6 flex flex-wrap justify-center gap-2 text-sm">
          {weeks.map((w) => (
            <Link
              key={w}
              href={`?week=${w}`}
              className={`rounded border px-3 py-1 ${
                w === selectedWeek
                  ? 'border-blue-600 bg-blue-600 text-white'
                  : 'border-gray-300 text-blue-700 hover:bg-blue-50'
              }`}
            >
              {fmt.format(new Date(`${w}T12:00:00`))}
            </Link>
          ))}
        </nav>
      )}

      {!selectedWeek && (
        <p className="text-center text-gray-500">No schedules are published yet.</p>
      )}

      <div className="grid gap-8 md:grid-cols-2">
        {(documents ?? []).map((doc) => (
          <section key={`${doc.scheduleTypeId}-${doc.dates[0]}`}>
            <h2 className="border-b border-gray-300 pb-1 text-lg font-semibold text-blue-800">
              {doc.title}
            </h2>
            {doc.sections.map((section) => (
              <div key={section.name} className="mt-3">
                <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">
                  {section.name}
                </h3>
                <table className="w-full text-sm">
                  <tbody>
                    {section.lines.map((line) => (
                      <tr key={line.name}>
                        <td className="py-1 pr-4">{line.name}</td>
                        <td className="py-1 text-right font-semibold">
                          {line.text ? (
                            <span className="italic font-normal text-gray-500">{line.text}</span>
                          ) : line.uniform ? (
                            line.timeMinutes !== null ? (
                              formatMinutes(line.timeMinutes)
                            ) : (
                              ''
                            )
                          ) : (
                            <span className="flex flex-wrap justify-end gap-x-3 text-xs font-medium">
                              {line.perDay.map((p) => (
                                <span key={p.date} className="whitespace-nowrap">
                                  <span className="font-normal text-gray-400">
                                    {weekdayFmt.format(new Date(`${p.date}T12:00:00`))}{' '}
                                  </span>
                                  {p.timeMinutes !== null ? formatMinutes(p.timeMinutes) : ''}
                                </span>
                              ))}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {section.overrides.map((o, i) => (
                      <tr key={`o-${i}`}>
                        <td colSpan={2} className="py-1 italic text-gray-600">
                          {o.text}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </section>
        ))}
      </div>
    </main>
  )
}
