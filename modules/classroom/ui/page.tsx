import Link from 'next/link'
import { requireOrgModule } from '@/lib/module-gate'
import { answerSurvey } from './actions'

// Module 2 (Classroom) landing: the caller's classes with announcements and
// open homework. First slice of the module UI — submissions/materials/grades
// pages follow.
export default async function ClassroomPage(props: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await props.params
  const { supabase, org } = await requireOrgModule(orgSlug, 'classroom')

  // RLS scopes every query: members see their classes, staff see the org's.
  // cls_courses is staff/GA-only — a non-empty result marks the caller as staff.
  const [{ data: memberships }, { data: classes }, { data: staffProbe }] = await Promise.all([
    supabase.from('cls_class_members').select('class_id, role'),
    supabase.from('cls_classes').select('id, name, term').eq('org_id', org.id),
    supabase.from('cls_courses').select('id').eq('org_id', org.id).limit(1),
  ])
  const isStaff = (staffProbe ?? []).length > 0
  const roleByClass = new Map((memberships ?? []).map((m) => [m.class_id, m.role]))
  const visibleClasses = (classes ?? []).filter(
    (c) => roleByClass.has(c.id) || (memberships ?? []).length === 0,
  )

  type Material = { id: string; title: string; kind: string; url: string | null; storage_path: string | null }
  type Publication = { class_id: string; material: Material | null }

  const classIds = visibleClasses.map((c) => c.id)
  const publicationsResult = classIds.length
    ? await supabase
        .from('cls_publications')
        .select('class_id, material:cls_materials(id, title, kind, url, storage_path)')
        .in('class_id', classIds)
    : { data: [] }
  const publications = (publicationsResult.data ?? []) as unknown as Publication[]

  // RLS hides materials outside their visibility window — the nested embed
  // comes back null for those, so filter them out rather than showing a blank row.
  const visibleMaterials = publications.filter(
    (p): p is Publication & { material: Material } => p.material !== null,
  )
  const materialLinks = new Map<string, string>()
  for (const p of visibleMaterials) {
    if (p.material.storage_path) {
      const { data } = await supabase.storage
        .from('cls-materials')
        .createSignedUrl(p.material.storage_path, 3600)
      if (data?.signedUrl) materialLinks.set(p.material.id, data.signedUrl)
    }
  }

  const [{ data: announcements }, { data: homeworks }, { data: myReviews }, { data: myGrades }] =
    await Promise.all([
      classIds.length
        ? supabase
            .from('cls_announcements')
            .select('class_id, body, posted_at')
            .in('class_id', classIds)
            .order('posted_at', { ascending: false })
        : Promise.resolve({ data: [] as { class_id: string; body: string; posted_at: string }[] }),
      classIds.length
        ? supabase
            .from('cls_homeworks')
            .select('id, class_id, title, due_at')
            .in('class_id', classIds)
            .order('due_at')
        : Promise.resolve({ data: [] as { id: string; class_id: string; title: string; due_at: string | null }[] }),
      // Assigned as a peer reviewer (own rows only per RLS) — reviewee identity
      // is never fetched, preserving anonymity end to end.
      supabase
        .from('cls_review_assignments')
        .select('id, class_id, grade, homework:cls_homeworks(title)'),
      // Final + visible grades only (RLS enforces this for non-staff regardless).
      supabase
        .from('cls_grades')
        .select('class_id, score, homework:cls_homeworks(title), exam:cls_exams(title)')
        .eq('is_final', true)
        .eq('visible', true),
    ])

  // Surveys for the caller's classes + the caller's own answers.
  const [{ data: surveys }, { data: myAnswers }] = await Promise.all([
    classIds.length
      ? supabase
          .from('cls_surveys')
          .select('id, class_id, question, results_visible')
          .in('class_id', classIds)
          .order('sort')
      : Promise.resolve({ data: [] as { id: string; class_id: string; question: string; results_visible: boolean }[] }),
    supabase.from('cls_survey_answers').select('survey_id, answer'),
  ])
  const answerBySurvey = new Map((myAnswers ?? []).map((a) => [a.survey_id, a.answer]))

  // Aggregated results (definer function; returns rows only when the survey's
  // results are flipped visible and the caller is a class member/staff).
  const surveyResults = new Map<string, { answer: string; votes: number }[]>()
  for (const s of surveys ?? []) {
    if (!s.results_visible) continue
    const { data: results } = await supabase.rpc('cls_survey_results', { check_survey_id: s.id })
    surveyResults.set(s.id, (results ?? []) as { answer: string; votes: number }[])
  }

  type HomeworkRef = { title: string } | null
  const reviews = (myReviews ?? []) as unknown as {
    id: string
    class_id: string
    grade: number | null
    homework: HomeworkRef
  }[]
  const grades = (myGrades ?? []) as unknown as {
    class_id: string
    score: number | null
    homework: HomeworkRef
    exam: HomeworkRef
  }[]

  const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <div className="mb-6 flex items-baseline gap-4">
        <h1 className="text-2xl font-semibold">Classes</h1>
        {isStaff && (
          <Link
            href={`/o/${orgSlug}/m/classroom/manage`}
            className="text-sm text-blue-600 hover:underline"
          >
            Manage
          </Link>
        )}
      </div>

      {visibleClasses.length === 0 && (
        <p className="text-gray-500">You are not enrolled in any class yet.</p>
      )}

      <div className="space-y-6">
        {visibleClasses.map((klass) => (
          <section key={klass.id} className="rounded-lg border border-gray-200 bg-white p-5">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-lg font-medium">{klass.name}</h2>
              <span className="text-xs uppercase tracking-wide text-gray-400">
                {roleByClass.get(klass.id) ?? 'staff'} · {klass.term}
              </span>
            </div>

            <h3 className="mb-1 text-sm font-medium uppercase tracking-wide text-gray-500">
              Materials
            </h3>
            <ul className="mb-4 space-y-1 text-sm text-gray-700">
              {visibleMaterials
                .filter((p) => p.class_id === klass.id)
                .map((p) => {
                  const link = p.material.url ?? materialLinks.get(p.material.id)
                  return (
                    <li key={p.material.id}>
                      <span className="text-xs uppercase text-gray-400">{p.material.kind}</span>{' '}
                      {link ? (
                        <a href={link} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                          {p.material.title}
                        </a>
                      ) : (
                        p.material.title
                      )}
                    </li>
                  )
                })}
              {visibleMaterials.filter((p) => p.class_id === klass.id).length === 0 && (
                <li className="text-gray-400">Nothing published yet.</li>
              )}
            </ul>

            <h3 className="mb-1 text-sm font-medium uppercase tracking-wide text-gray-500">
              Announcements
            </h3>
            <ul className="mb-4 space-y-1 text-sm text-gray-700">
              {(announcements ?? [])
                .filter((a) => a.class_id === klass.id)
                .slice(0, 3)
                .map((a, i) => (
                  <li key={i}>
                    <span className="text-gray-400">{fmt.format(new Date(a.posted_at))} — </span>
                    {a.body}
                  </li>
                ))}
            </ul>

            <h3 className="mb-1 text-sm font-medium uppercase tracking-wide text-gray-500">
              Homework
            </h3>
            <ul className="space-y-1 text-sm text-gray-700">
              {(homeworks ?? [])
                .filter((h) => h.class_id === klass.id)
                .map((h) => (
                  <li key={h.id} className="flex justify-between">
                    <Link
                      href={`/o/${orgSlug}/m/classroom/homework/${h.id}`}
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

            {reviews.filter((r) => r.class_id === klass.id).length > 0 && (
              <>
                <h3 className="mb-1 mt-4 text-sm font-medium uppercase tracking-wide text-gray-500">
                  Peer reviews assigned to you
                </h3>
                <ul className="space-y-1 text-sm text-gray-700">
                  {reviews
                    .filter((r) => r.class_id === klass.id)
                    .map((r) => (
                      <li key={r.id} className="flex justify-between">
                        <Link
                          href={`/o/${orgSlug}/m/classroom/review/${r.id}`}
                          className="text-blue-600 hover:underline"
                        >
                          {r.homework?.title ?? 'Homework'}
                        </Link>
                        <span className="text-gray-400">{r.grade !== null ? 'graded' : 'pending'}</span>
                      </li>
                    ))}
                </ul>
              </>
            )}

            {grades.filter((g) => g.class_id === klass.id).length > 0 && (
              <>
                <h3 className="mb-1 mt-4 text-sm font-medium uppercase tracking-wide text-gray-500">
                  Your grades
                </h3>
                <ul className="space-y-1 text-sm text-gray-700">
                  {grades
                    .filter((g) => g.class_id === klass.id)
                    .map((g, i) => (
                      <li key={i} className="flex justify-between">
                        <span>{g.homework?.title ?? g.exam?.title ?? 'Assessment'}</span>
                        <span className="font-medium">{g.score}</span>
                      </li>
                    ))}
                </ul>
              </>
            )}

            {(surveys ?? []).filter((s) => s.class_id === klass.id).length > 0 && (
              <>
                <h3 className="mb-1 mt-4 text-sm font-medium uppercase tracking-wide text-gray-500">
                  Surveys
                </h3>
                <div className="space-y-3">
                  {(surveys ?? [])
                    .filter((s) => s.class_id === klass.id)
                    .map((s) => {
                      const results = surveyResults.get(s.id)
                      return (
                        <div key={s.id} className="rounded border border-gray-100 p-3 text-sm">
                          <p className="mb-2 font-medium">{s.question}</p>
                          <form
                            action={answerSurvey.bind(null, orgSlug, s.id, klass.id)}
                            className="flex flex-wrap items-center gap-2"
                          >
                            <input
                              name="answer"
                              required
                              defaultValue={answerBySurvey.get(s.id) ?? ''}
                              placeholder="Your answer…"
                              className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
                            />
                            <button className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700">
                              {answerBySurvey.has(s.id) ? 'Update' : 'Submit'}
                            </button>
                          </form>
                          {results && results.length > 0 && (
                            <ul className="mt-2 space-y-0.5 text-xs text-gray-600">
                              {results.map((r, i) => (
                                <li key={i} className="flex justify-between">
                                  <span>{r.answer}</span>
                                  <span className="text-gray-400">{r.votes}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )
                    })}
                </div>
              </>
            )}
          </section>
        ))}
      </div>
    </div>
  )
}
