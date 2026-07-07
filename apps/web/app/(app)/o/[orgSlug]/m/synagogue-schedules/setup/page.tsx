import Link from 'next/link'
import { dayTypeSchema, zmanNameSchema } from '@modules/synagogue-schedules'
import { requireOrgModule } from '@/lib/module-gate'
import {
  createLine,
  createOverride,
  createScheduleType,
  createSection,
  deleteLine,
  deleteScheduleType,
  deleteSection,
  publishWeek,
  unpublishWeek,
} from './actions'

const MODULE_KEY = 'synagogue-schedules'
const DAY_TYPES = dayTypeSchema.options
const ZMANIM = zmanNameSchema.options

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'
const btnCls = 'rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700'
const delCls = 'text-xs text-red-500 hover:underline'

function describeRule(rule: unknown): string {
  const r = rule as {
    condition?: { dayTypes?: string[]; season?: string }
    time?: { kind?: string; clock?: string; zman?: string; line?: string; offsetMinutes?: number; aggregate?: string; round?: { direction: string; toMinutes: number } }
    fallbackText?: string
  }
  const parts: string[] = []
  if (r.time?.kind === 'fixed') parts.push(`fixed ${r.time.clock}`)
  if (r.time?.kind === 'zman') {
    let s = r.time.aggregate ? `${r.time.aggregate.replace(/-/g, ' ')} ${r.time.zman}` : `${r.time.zman}`
    const off = r.time.offsetMinutes ?? 0
    if (off !== 0) s += ` ${off > 0 ? '+' : ''}${off}m`
    if (r.time.round) s += `, round ${r.time.round.direction} to ${r.time.round.toMinutes}m`
    parts.push(s)
  }
  if (r.time?.kind === 'line-ref') {
    let s = `= ${r.time.line}`
    const off = r.time.offsetMinutes ?? 0
    if (off !== 0) s += ` ${off > 0 ? '+' : ''}${off}m`
    parts.push(s)
  }
  if (r.time?.kind === 'none') parts.push('no time (free-form)')
  if (r.condition?.dayTypes?.length) parts.push(`on: ${r.condition.dayTypes.join(', ')}`)
  if (r.condition?.season) parts.push(`${r.condition.season} only`)
  if (r.fallbackText) parts.push(`else: "${r.fallbackText}"`)
  return parts.join(' · ')
}

export default async function SetupPage(props: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await props.params
  const { supabase, org } = await requireOrgModule(orgSlug, MODULE_KEY)

  const [{ data: types }, { data: sections }, { data: lines }, { data: publishedWeeks }] = await Promise.all([
    supabase
      .from('syn_schedule_types')
      .select('id, name, span, trigger_condition, sort')
      .eq('org_id', org.id)
      .order('sort'),
    supabase
      .from('syn_sections')
      .select('id, schedule_type_id, name, sort')
      .eq('org_id', org.id)
      .order('sort'),
    supabase
      .from('syn_lines')
      .select('id, section_id, name, rule, sort')
      .eq('org_id', org.id)
      .order('sort'),
    supabase
      .from('syn_published_weeks')
      .select('week_start, published')
      .eq('org_id', org.id)
      .order('week_start', { ascending: false }),
  ])

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <div className="mb-6 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Schedule Setup</h1>
        <Link
          href={`/o/${orgSlug}/m/synagogue-schedules`}
          className="text-sm text-blue-600 hover:underline"
        >
          View schedules →
        </Link>
      </div>

      <div className="space-y-8">
        {(types ?? []).map((type) => {
          const typeSections = (sections ?? []).filter((s) => s.schedule_type_id === type.id)
          const trigger = (type.trigger_condition ?? {}) as { dayTypes?: string[] }
          return (
            <section key={type.id} className="rounded-lg border border-gray-200 bg-white p-5">
              <div className="mb-1 flex items-baseline justify-between">
                <h2 className="text-lg font-semibold">{type.name}</h2>
                <form
                  action={async () => {
                    'use server'
                    await deleteScheduleType(orgSlug, type.id)
                  }}
                >
                  <button className={delCls}>delete schedule</button>
                </form>
              </div>
              <p className="mb-4 text-xs text-gray-400">
                {type.span === 'week' ? 'One document per week' : 'One document per matching day'}
                {trigger.dayTypes?.length ? ` · triggers on: ${trigger.dayTypes.join(', ')}` : ' · every week'}
              </p>

              {typeSections.map((section) => (
                <div key={section.id} className="mb-4 rounded border border-gray-100 p-3">
                  <div className="mb-2 flex items-baseline justify-between">
                    <h3 className="text-sm font-medium uppercase tracking-wide text-gray-600">
                      {section.name}
                    </h3>
                    <form
                      action={async () => {
                        'use server'
                        await deleteSection(orgSlug, section.id)
                      }}
                    >
                      <button className={delCls}>delete section</button>
                    </form>
                  </div>

                  <ul className="mb-3 space-y-1 text-sm">
                    {(lines ?? [])
                      .filter((l) => l.section_id === section.id)
                      .map((line) => (
                        <li key={line.id} className="flex items-center justify-between gap-3">
                          <span>
                            <span className="font-medium">{line.name}</span>{' '}
                            <span className="text-gray-500">— {describeRule(line.rule)}</span>
                          </span>
                          <form
                            action={async () => {
                              'use server'
                              await deleteLine(orgSlug, line.id)
                            }}
                          >
                            <button className={delCls}>remove</button>
                          </form>
                        </li>
                      ))}
                  </ul>

                  <details className="text-sm">
                    <summary className="cursor-pointer text-blue-600">Add line</summary>
                    <form
                      action={createLine.bind(null, org.id, orgSlug, section.id)}
                      className="mt-2 grid gap-2 rounded bg-gray-50 p-3"
                    >
                      <div className="flex flex-wrap gap-2">
                        <input name="name" placeholder="Line name (e.g. Mincha)" required className={inputCls} />
                        <input name="nameHebrew" placeholder="Hebrew (optional)" dir="rtl" className={inputCls} />
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <select name="timeKind" className={inputCls} defaultValue="zman">
                          <option value="zman">Zman-based time</option>
                          <option value="fixed">Fixed clock time</option>
                          <option value="line-ref">After another line (+ offset)</option>
                          <option value="none">No time (free-form)</option>
                        </select>
                        <select name="zman" className={inputCls} defaultValue="sunset">
                          {ZMANIM.map((z) => (
                            <option key={z} value={z}>{z}</option>
                          ))}
                        </select>
                        <input
                          name="zmanCustom"
                          placeholder="or myzmanim name (e.g. Night50fix)"
                          className={`${inputCls} w-56`}
                          title="Any myzmanim field name — overrides the dropdown"
                        />
                        <input
                          name="refLine"
                          placeholder="other line's exact name"
                          className={`${inputCls} w-56`}
                          title="Used when kind = after another line — this line's time = that line's time + offset"
                        />
                        <label className="flex items-center gap-1">
                          offset (min): <input name="offsetMinutes" type="number" defaultValue={0} className={`${inputCls} w-20`} />
                        </label>
                        <input name="clock" type="time" className={inputCls} title="Used when kind = fixed" />
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <select name="aggregate" className={inputCls} defaultValue="">
                          <option value="">this day&apos;s zman</option>
                          <option value="earliest-of-week">earliest of week</option>
                          <option value="latest-of-week">latest of week</option>
                          <option value="day-0">Sunday&apos;s value</option>
                          <option value="day-1">Monday&apos;s value</option>
                          <option value="day-2">Tuesday&apos;s value</option>
                          <option value="day-3">Wednesday&apos;s value</option>
                          <option value="day-4">Thursday&apos;s value</option>
                          <option value="day-5">Friday&apos;s value</option>
                          <option value="day-6">Saturday&apos;s value</option>
                        </select>
                        <label className="flex items-center gap-1">
                          not before: <input name="notBefore" type="time" className={inputCls} />
                        </label>
                        <label className="flex items-center gap-1">
                          not after: <input name="notAfter" type="time" className={inputCls} />
                        </label>
                        <label className="flex items-center gap-1">
                          round to (min): <input name="roundTo" type="number" defaultValue={0} className={`${inputCls} w-16`} />
                        </label>
                        <select name="roundDirection" className={inputCls} defaultValue="down">
                          <option value="down">down</option>
                          <option value="up">up</option>
                          <option value="nearest">nearest</option>
                        </select>
                        <select name="season" className={inputCls} defaultValue="">
                          <option value="">all year</option>
                          <option value="winter">winter only</option>
                          <option value="summer">summer only</option>
                        </select>
                        <input
                          name="fallbackText"
                          placeholder="text when condition doesn't apply (optional)"
                          className={`${inputCls} w-72`}
                          title="Shown instead of a time when the condition does not match (e.g. Will resume next week)"
                        />
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                        <span className="text-gray-500">Show only on:</span>
                        {DAY_TYPES.map((d) => (
                          <label key={d} className="flex items-center gap-1">
                            <input type="checkbox" name="condDayTypes" value={d} /> {d}
                          </label>
                        ))}
                        <span className="text-gray-400">(none checked = every day)</span>
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                        <span className="text-gray-500">Weekdays:</span>
                        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => (
                          <label key={d} className="flex items-center gap-1">
                            <input type="checkbox" name="condDaysOfWeek" value={i} /> {d}
                          </label>
                        ))}
                        <span className="text-gray-400">(none checked = all weekdays)</span>
                      </div>
                      <div>
                        <button className={btnCls}>Add line</button>
                      </div>
                    </form>
                  </details>
                </div>
              ))}

              <form
                action={createSection.bind(null, org.id, orgSlug, type.id)}
                className="flex flex-wrap items-center gap-2"
              >
                <input name="name" placeholder="New section name" required className={inputCls} />
                <input name="nameHebrew" placeholder="Hebrew (optional)" dir="rtl" className={inputCls} />
                <button className={btnCls}>Add section</button>
              </form>
            </section>
          )
        })}
      </div>

      <section className="mt-8 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-3 text-lg font-semibold">New schedule type</h2>
        <form action={createScheduleType.bind(null, org.id, orgSlug)} className="grid gap-2">
          <div className="flex flex-wrap gap-2">
            <input name="name" placeholder="Name (e.g. Weekday Schedule)" required className={inputCls} />
            <input name="nameHebrew" placeholder="Hebrew (optional)" dir="rtl" className={inputCls} />
            <select name="span" className={inputCls} defaultValue="week">
              <option value="week">one document per week</option>
              <option value="day">one document per matching day</option>
            </select>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            <span className="text-gray-500">Triggers on:</span>
            {DAY_TYPES.map((d) => (
              <label key={d} className="flex items-center gap-1">
                <input type="checkbox" name="dayTypes" value={d} /> {d}
              </label>
            ))}
            <span className="text-gray-400">(none checked = every week)</span>
          </div>
          <div>
            <button className={btnCls}>Create schedule type</button>
          </div>
        </form>
      </section>

      <section className="mt-8 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-1 text-lg font-semibold">Published weeks</h2>
        <p className="mb-3 text-xs text-gray-400">
          Weeks visible on the public page (no login): <code>/s/{orgSlug}</code>. Week start is
          the Sunday date.
        </p>
        <ul className="mb-3 flex flex-wrap gap-2 text-sm">
          {(publishedWeeks ?? []).map((w) => (
            <li key={w.week_start} className="flex items-center gap-2 rounded border border-green-200 bg-green-50 px-3 py-1">
              <span>{w.week_start}</span>
              <form
                action={async () => {
                  'use server'
                  await unpublishWeek(orgSlug, org.id, w.week_start)
                }}
              >
                <button className={delCls}>unpublish</button>
              </form>
            </li>
          ))}
          {(publishedWeeks ?? []).length === 0 && (
            <li className="text-gray-400">Nothing published yet</li>
          )}
        </ul>
        <form action={publishWeek.bind(null, org.id, orgSlug)} className="flex items-center gap-2">
          <input name="weekStart" type="date" required className={inputCls} />
          <button className={btnCls}>Publish week</button>
        </form>
      </section>

      <section className="mt-8 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-1 text-lg font-semibold">Weekly message</h2>
        <p className="mb-3 text-xs text-gray-400">
          Free-form line for a specific week (e.g. &quot;Coffee sponsored by John Doe&quot;). Week
          start is the Sunday date.
        </p>
        <form action={createOverride.bind(null, org.id, orgSlug)} className="flex flex-wrap items-center gap-2">
          <select name="sectionId" required className={inputCls}>
            {(sections ?? []).map((s) => {
              const parent = (types ?? []).find((t) => t.id === s.schedule_type_id)
              return (
                <option key={s.id} value={s.id}>
                  {parent?.name} / {s.name}
                </option>
              )
            })}
          </select>
          <input name="weekStart" type="date" required className={inputCls} />
          <input name="text" placeholder="Message" required className={`${inputCls} min-w-64`} />
          <input name="textHebrew" placeholder="Hebrew (optional)" dir="rtl" className={inputCls} />
          <button className={btnCls}>Add</button>
        </form>
      </section>
    </div>
  )
}
