import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
  buildWeek,
  formatMinutes,
  generateWeek,
  lineRuleSchema,
  myzmanimCredsFromEnv,
  type ScheduleTypeConfig,
} from '@modules/synagogue-schedules'
import { createClient } from '@/lib/supabase/server'
import { requestExport } from './export-actions'

const MODULE_KEY = 'synagogue-schedules'

function toDateOnly(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default async function SchedulesPage(props: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ week?: string }>
}) {
  const { orgSlug } = await props.params
  const { week: weekParam } = await props.searchParams
  const supabase = await createClient()

  const { data: org } = await supabase.from('orgs').select('id, name').eq('slug', orgSlug).single()
  if (!org) notFound()

  const { data: entitlement } = await supabase
    .from('org_modules')
    .select('enabled, settings')
    .eq('org_id', org.id)
    .eq('module_key', MODULE_KEY)
    .single()
  if (!entitlement?.enabled) notFound()

  const settings = entitlement.settings as {
    latitude?: number
    longitude?: number
    timezone?: string
    israel?: boolean
    myzmanimLocationId?: string
  }
  const timeZone = settings.timezone ?? 'America/New_York'

  // Which week: ?week=YYYY-MM-DD (any date in the week) or today.
  const anchor = weekParam ? new Date(`${weekParam}T12:00:00`) : new Date()
  const sunday = new Date(anchor)
  sunday.setDate(anchor.getDate() - anchor.getDay())
  sunday.setHours(12, 0, 0, 0)
  const weekStart = toDateOnly(sunday)

  // myzmanim primary, hebcal fallback (spec).
  const weekDays = await buildWeek(weekStart, {
    latitude: settings.latitude,
    longitude: settings.longitude,
    timeZone,
    israel: settings.israel,
    myzmanimLocationId: settings.myzmanimLocationId,
    credentials: myzmanimCredsFromEnv(),
  })

  // Load config (RLS scopes everything to this member's org).
  const [{ data: types }, { data: sections }, { data: lines }, { data: overrides }] =
    await Promise.all([
      supabase
        .from('syn_schedule_types')
        .select('id, name, name_hebrew, trigger_condition, span, sort')
        .eq('org_id', org.id)
        .order('sort'),
      supabase
        .from('syn_sections')
        .select('id, schedule_type_id, name, name_hebrew, visibility_condition, sort')
        .eq('org_id', org.id)
        .order('sort'),
      supabase
        .from('syn_lines')
        .select('id, section_id, name, name_hebrew, rule, sort')
        .eq('org_id', org.id)
        .order('sort'),
      supabase
        .from('syn_overrides')
        .select('section_id, text, text_hebrew')
        .eq('org_id', org.id)
        .eq('week_start', weekStart)
        .order('sort'),
    ])

  const config: ScheduleTypeConfig[] = (types ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    nameHebrew: t.name_hebrew,
    triggerCondition: (t.trigger_condition ?? {}) as ScheduleTypeConfig['triggerCondition'],
    span: t.span as 'week' | 'day',
    sections: (sections ?? [])
      .filter((s) => s.schedule_type_id === t.id)
      .map((s) => ({
        id: s.id,
        name: s.name,
        nameHebrew: s.name_hebrew,
        visibilityCondition: (s.visibility_condition ?? {}) as ScheduleTypeConfig['triggerCondition'],
        lines: (lines ?? [])
          .filter((l) => l.section_id === s.id)
          .flatMap((l) => {
            const parsed = lineRuleSchema.safeParse(l.rule)
            // Invalid rule JSON: skip rather than crash the whole schedule.
            return parsed.success
              ? [{ name: l.name, nameHebrew: l.name_hebrew, rule: parsed.data }]
              : []
          }),
      })),
  }))

  const documents = generateWeek(
    config,
    (overrides ?? []).map((o) => ({
      sectionId: o.section_id,
      text: o.text,
      textHebrew: o.text_hebrew,
    })),
    weekDays,
    timeZone,
  )

  const prevWeek = new Date(sunday)
  prevWeek.setDate(sunday.getDate() - 7)
  const nextWeek = new Date(sunday)
  nextWeek.setDate(sunday.getDate() + 7)
  const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone })
  const weekdayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone })

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-baseline gap-4">
          <h1 className="text-2xl font-semibold">Schedules</h1>
          <Link
            href={`/o/${orgSlug}/m/synagogue-schedules/setup`}
            className="text-sm text-blue-600 hover:underline"
          >
            Setup
          </Link>
          <Link
            href={`/o/${orgSlug}/m/synagogue-schedules/help`}
            className="text-sm text-blue-600 hover:underline"
          >
            Help
          </Link>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link href={`?week=${toDateOnly(prevWeek)}`} className="text-blue-600 hover:underline">
            ← Previous
          </Link>
          <span className="font-medium">Week of {fmt.format(sunday)}</span>
          <Link href={`?week=${toDateOnly(nextWeek)}`} className="text-blue-600 hover:underline">
            Next →
          </Link>
        </div>
      </div>

      {documents.length === 0 && (
        <p className="text-gray-500">
          No schedules generated for this week — configure schedule types, sections, and lines
          first.
        </p>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        {documents.map((doc) => (
          <section
            key={`${doc.scheduleTypeId}-${doc.dates[0]}`}
            className="rounded-lg border border-gray-200 bg-white p-5"
          >
            <h2 className="mb-1 text-lg font-semibold">{doc.title}</h2>
            <p className="mb-4 text-xs text-gray-400">
              {doc.dates.length === 1
                ? fmt.format(new Date(`${doc.dates[0]}T12:00:00`))
                : `${fmt.format(new Date(`${doc.dates[0]}T12:00:00`))} – ${fmt.format(new Date(`${doc.dates[doc.dates.length - 1]}T12:00:00`))}`}
            </p>
            {doc.sections.map((section) => (
              <div key={section.name} className="mb-4">
                <h3 className="mb-2 border-b border-gray-100 pb-1 text-sm font-medium uppercase tracking-wide text-gray-500">
                  {section.name}
                </h3>
                <table className="w-full text-sm">
                  <tbody>
                    {section.lines.map((line) => (
                      <tr key={line.name}>
                        <td className="py-1 pr-4">{line.name}</td>
                        <td className="py-1 text-right font-medium">
                          {line.text ? (
                            <span className="italic text-gray-500">{line.text}</span>
                          ) : line.uniform ? (
                            line.timeMinutes !== null ? (
                              formatMinutes(line.timeMinutes)
                            ) : (
                              ''
                            )
                          ) : (
                            <div className="flex flex-wrap justify-end gap-x-3 text-xs">
                              {line.perDay.map((p) => (
                                <span key={p.date} className="whitespace-nowrap">
                                  <span className="text-gray-400">
                                    {weekdayFmt.format(new Date(`${p.date}T12:00:00`))}{' '}
                                  </span>
                                  {p.timeMinutes !== null ? formatMinutes(p.timeMinutes) : ''}
                                </span>
                              ))}
                            </div>
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

      <ExportPanel orgId={org.id} orgSlug={orgSlug} weekStart={weekStart} />

      <p className="mt-6 text-xs text-gray-400">
        Times computed locally (hebcal) — myzmanim becomes the primary source when the connector
        lands.
      </p>
    </div>
  )
}

// Export section: request a render, show job status and finished files.
async function ExportPanel(props: { orgId: string; orgSlug: string; weekStart: string }) {
  const supabase = await createClient()

  const [{ data: lastJob }, { data: files }] = await Promise.all([
    supabase
      .from('job_requests')
      .select('status, error, created_at')
      .eq('org_id', props.orgId)
      .eq('kind', 'synagogue-schedules.render')
      .contains('payload', { weekStart: props.weekStart })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.storage.from('syn-exports').list(`${props.orgId}/${props.weekStart}`),
  ])

  const fileLinks: { name: string; url: string }[] = []
  for (const f of files ?? []) {
    const { data } = await supabase.storage
      .from('syn-exports')
      .createSignedUrl(`${props.orgId}/${props.weekStart}/${f.name}`, 3600)
    if (data?.signedUrl) fileLinks.push({ name: f.name, url: data.signedUrl })
  }

  return (
    <section className="mt-8 rounded-lg border border-gray-200 bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Exports</h2>
        <form
          action={async () => {
            'use server'
            await requestExport(props.orgId, props.orgSlug, props.weekStart)
          }}
        >
          <button className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
            Export this week
          </button>
        </form>
      </div>

      {lastJob && (
        <p className="mb-3 text-sm text-gray-500">
          Last export request:{' '}
          <span
            className={
              lastJob.status === 'done'
                ? 'text-green-600'
                : lastJob.status === 'error'
                  ? 'text-red-600'
                  : 'text-amber-600'
            }
          >
            {lastJob.status}
          </span>
          {lastJob.error ? ` — ${lastJob.error}` : ''}
          {lastJob.status === 'pending' || lastJob.status === 'running'
            ? ' (refresh in a few seconds)'
            : ''}
        </p>
      )}

      {fileLinks.length === 0 ? (
        <p className="text-sm text-gray-400">No files yet for this week.</p>
      ) : (
        <ul className="flex flex-wrap gap-3 text-sm">
          {fileLinks.map((f) => (
            <li key={f.name}>
              <a
                href={f.url}
                target="_blank"
                rel="noreferrer"
                className="inline-block rounded border border-blue-200 bg-blue-50 px-3 py-1 text-blue-700 hover:bg-blue-100"
              >
                {f.name}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
