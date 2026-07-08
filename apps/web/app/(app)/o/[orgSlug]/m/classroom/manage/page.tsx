import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireOrgModule } from '@/lib/module-gate'
import { createHomework, createSurvey, postAnnouncement, setSurveyResultsVisible } from './actions'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'
const btnCls = 'rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700'

// Professor console: roster, announcements, homework per class.
export default async function ManagePage(props: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await props.params
  const { supabase, org } = await requireOrgModule(orgSlug, 'classroom')

  // Staff check: cls_courses is staff/GA-readable only — an empty result for a
  // student means this page 404s for them (RLS decides, not the UI).
  const { data: courses } = await supabase.from('cls_courses').select('id, name').eq('org_id', org.id)
  if (!courses || courses.length === 0) notFound()

  const [{ data: classes }, { data: members }, { data: homeworks }, { data: profiles }, { data: surveys }] =
    await Promise.all([
      supabase.from('cls_classes').select('id, course_id, name, term').eq('org_id', org.id),
      supabase
        .from('cls_class_members')
        .select('class_id, user_id, role, preferred_first_name, preferred_last_name'),
      supabase.from('cls_homeworks').select('id, class_id, title, due_at').order('due_at'),
      supabase.from('profiles').select('user_id, email, display_name'),
      supabase.from('cls_surveys').select('id, class_id, question, results_visible').order('sort'),
    ])
  const profileById = new Map((profiles ?? []).map((p) => [p.user_id, p]))
  const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <div className="mb-6 flex items-baseline gap-4">
        <h1 className="text-2xl font-semibold">Classroom — Manage</h1>
        <Link href={`/o/${orgSlug}/m/classroom/manage/materials`} className="text-sm text-blue-600 hover:underline">
          Materials
        </Link>
      </div>

      <div className="space-y-8">
        {(classes ?? []).map((klass) => {
          const roster = (members ?? []).filter((m) => m.class_id === klass.id)
          const classHomeworks = (homeworks ?? []).filter((h) => h.class_id === klass.id)
          const classSurveys = (surveys ?? []).filter((s) => s.class_id === klass.id)
          return (
            <section key={klass.id} className="rounded-lg border border-gray-200 bg-white p-5">
              <div className="mb-4 flex items-baseline justify-between">
                <h2 className="text-lg font-medium">{klass.name}</h2>
                <span className="text-xs text-gray-400">{klass.term}</span>
              </div>

              <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-gray-500">
                Post announcement
              </h3>
              <form
                action={postAnnouncement.bind(null, orgSlug, klass.id)}
                className="mb-5 flex flex-wrap items-center gap-2"
              >
                <input name="body" required placeholder="Announcement…" className={`${inputCls} min-w-96 flex-1`} />
                <button className={btnCls}>Post</button>
              </form>

              <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-gray-500">
                Homework ({classHomeworks.length})
              </h3>
              <ul className="mb-3 space-y-1 text-sm text-gray-700">
                {classHomeworks.map((h) => (
                  <li key={h.id} className="flex justify-between">
                    <Link
                      href={`/o/${orgSlug}/m/classroom/manage/grading/${h.id}`}
                      className="text-blue-600 hover:underline"
                    >
                      {h.title}
                    </Link>
                    <span className="text-gray-400">
                      {h.due_at ? `due ${fmt.format(new Date(h.due_at))}` : 'no deadline'}
                    </span>
                  </li>
                ))}
              </ul>
              <form
                action={createHomework.bind(null, orgSlug, klass.id)}
                className="mb-5 flex flex-wrap items-center gap-2"
              >
                <input name="title" required placeholder="New homework title" className={`${inputCls} min-w-64`} />
                <input name="dueAt" type="datetime-local" className={inputCls} />
                <button className={btnCls}>Add homework</button>
              </form>

              <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-gray-500">
                Surveys ({classSurveys.length})
              </h3>
              <ul className="mb-3 space-y-1 text-sm text-gray-700">
                {classSurveys.map((s) => (
                  <li key={s.id} className="flex items-center justify-between">
                    <span>{s.question}</span>
                    <form action={setSurveyResultsVisible.bind(null, orgSlug, s.id, !s.results_visible)}>
                      <button className="text-xs text-blue-600 hover:underline">
                        {s.results_visible ? 'Hide results' : 'Show results to class'}
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
              <form
                action={createSurvey.bind(null, orgSlug, klass.id)}
                className="mb-5 flex flex-wrap items-center gap-2"
              >
                <input name="question" required placeholder="New survey question" className={`${inputCls} min-w-64 flex-1`} />
                <button className={btnCls}>Add survey</button>
              </form>

              <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-gray-500">
                Roster ({roster.length})
              </h3>
              <ul className="space-y-1 text-sm text-gray-700">
                {roster.map((m) => {
                  const p = profileById.get(m.user_id)
                  const preferred = [m.preferred_first_name, m.preferred_last_name]
                    .filter(Boolean)
                    .join(' ')
                  return (
                    <li key={m.user_id} className="flex items-center gap-3">
                      <span>{preferred || p?.display_name || p?.email || m.user_id}</span>
                      <span className="text-xs uppercase text-gray-400">{m.role}</span>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </div>
    </div>
  )
}
