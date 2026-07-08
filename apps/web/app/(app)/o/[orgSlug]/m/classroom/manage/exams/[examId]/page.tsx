import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireOrgModule } from '@/lib/module-gate'
import { publishExamFinal, saveExamScores, uploadExamPaper } from './actions'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'
const btnCls = 'rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700'

// Exam grading console (staff/GA): per student — uploaded scans, per-subproblem
// score entry (granularity = the exam's structure), and final publishing.
export default async function ExamGradingPage(props: {
  params: Promise<{ orgSlug: string; examId: string }>
}) {
  const { orgSlug, examId } = await props.params
  const { supabase, org } = await requireOrgModule(orgSlug, 'classroom')

  const { data: exam } = await supabase
    .from('cls_exams')
    .select('id, class_id, title, structure')
    .eq('id', examId)
    .maybeSingle()
  if (!exam) notFound()

  // Staff/GA gate via RLS (students can read cls_exams rows of their class,
  // so probe the staff-only course table like the other manage pages).
  const { data: staffProbe } = await supabase.from('cls_courses').select('id').eq('org_id', org.id).limit(1)
  if (!staffProbe || staffProbe.length === 0) notFound()

  const { data: isProfessor } = await supabase.rpc('cls_can_manage', { check_org_id: org.id })

  const structure = ((exam.structure ?? []) as { label: string; points: number }[]).filter(
    (p) => p && typeof p.label === 'string' && typeof p.points === 'number',
  )
  const maxTotal = structure.reduce((s, p) => s + p.points, 0)

  const [{ data: members }, { data: papers }, { data: grades }, { data: profiles }] =
    await Promise.all([
      supabase
        .from('cls_class_members')
        .select('user_id, role, preferred_first_name, preferred_last_name')
        .eq('class_id', exam.class_id)
        .eq('role', 'student'),
      supabase.from('cls_exam_papers').select('id, student_id, storage_path').eq('exam_id', examId),
      supabase.from('cls_grades').select('student_id, source, score, detail, is_final').eq('exam_id', examId),
      supabase.from('profiles').select('user_id, email, display_name'),
    ])

  const nameOf = (userId: string) => {
    const m = (members ?? []).find((x) => x.user_id === userId)
    const preferred = [m?.preferred_first_name, m?.preferred_last_name].filter(Boolean).join(' ')
    if (preferred) return preferred
    const p = (profiles ?? []).find((pr) => pr.user_id === userId)
    return p?.display_name || p?.email || userId
  }

  const scanLinks = new Map<string, { name: string; url: string }[]>()
  for (const paper of papers ?? []) {
    const { data } = await supabase.storage.from('cls-exams').createSignedUrl(paper.storage_path, 3600)
    if (data?.signedUrl) {
      const list = scanLinks.get(paper.student_id) ?? []
      list.push({ name: paper.storage_path.split('/').pop() ?? 'scan', url: data.signedUrl })
      scanLinks.set(paper.student_id, list)
    }
  }

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <div className="mb-2 flex items-baseline gap-4">
        <h1 className="text-2xl font-semibold">Exam — {exam.title}</h1>
        <Link href={`/o/${orgSlug}/m/classroom/manage`} className="text-sm text-blue-600 hover:underline">
          ← Manage
        </Link>
      </div>
      <p className="mb-6 text-sm text-gray-400">
        {structure.length > 0
          ? `Problems: ${structure.map((p) => `${p.label} (${p.points})`).join(' · ')} — max ${maxTotal}`
          : 'No problem structure defined for this exam.'}
      </p>

      <div className="space-y-6">
        {(members ?? []).map((m) => {
          const studentGrades = (grades ?? []).filter((g) => g.student_id === m.user_id)
          const gaGrade = studentGrades.find((g) => g.source === 'ga')
          const finalGrade = studentGrades.find((g) => g.is_final)
          const detail = ((gaGrade?.detail ?? {}) as { problems?: Record<string, number> }).problems ?? {}
          const scans = scanLinks.get(m.user_id) ?? []
          return (
            <section key={m.user_id} className="rounded-lg border border-gray-200 bg-white p-5">
              <div className="mb-3 flex items-baseline justify-between">
                <h2 className="text-lg font-medium">{nameOf(m.user_id)}</h2>
                <span className="text-sm text-gray-500">
                  {gaGrade ? `graded: ${gaGrade.score}/${maxTotal}` : 'ungraded'}
                  {finalGrade ? ` · final: ${finalGrade.score}` : ''}
                </span>
              </div>

              <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
                {scans.map((s, i) => (
                  <a key={i} href={s.url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                    {s.name}
                  </a>
                ))}
                <form action={uploadExamPaper.bind(null, orgSlug, examId)} className="flex items-center gap-2">
                  <input type="hidden" name="studentId" value={m.user_id} />
                  <input name="file" type="file" required className="text-sm" />
                  <button className="text-xs text-blue-600 hover:underline">Upload scan</button>
                </form>
              </div>

              {structure.length > 0 && (
                <form
                  action={saveExamScores.bind(null, orgSlug, examId, exam.class_id)}
                  className="mb-3 flex flex-wrap items-end gap-3"
                >
                  <input type="hidden" name="studentId" value={m.user_id} />
                  {structure.map((p) => (
                    <label key={p.label} className="text-xs text-gray-500">
                      {p.label} /{p.points}
                      <input
                        name={`problem_${p.label}`}
                        type="number"
                        step="0.5"
                        min="0"
                        max={p.points}
                        defaultValue={detail[p.label] ?? ''}
                        className={`${inputCls} block w-20`}
                      />
                    </label>
                  ))}
                  <button className={btnCls}>Save scores</button>
                </form>
              )}

              {isProfessor && (
                <form
                  action={publishExamFinal.bind(null, orgSlug, examId, exam.class_id)}
                  className="flex items-center gap-2"
                >
                  <input type="hidden" name="studentId" value={m.user_id} />
                  <input
                    name="finalScore"
                    type="number"
                    step="0.5"
                    defaultValue={finalGrade?.score ?? gaGrade?.score ?? ''}
                    className={`${inputCls} w-24`}
                  />
                  <button className="text-sm text-blue-600 hover:underline">
                    {finalGrade ? 'Update final' : 'Publish final'}
                  </button>
                </form>
              )}
            </section>
          )
        })}
        {(members ?? []).length === 0 && <p className="text-gray-400">No students in this class.</p>}
      </div>
    </div>
  )
}
