import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireOrgModule } from '@/lib/module-gate'
import {
  computeCombinationFinals,
  finalizePeerReview,
  moveToGaGrading,
  moveToPeerReview,
  publishFinalGrade,
  setRevealUntil,
  submitGaGrade,
} from './actions'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'
const btnCls = 'rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700'

// Professor/GA console for one homework's grading workflow:
// submitted -> ga_grading -> peer_review -> done, plus final grade publishing.
export default async function GradingPage(props: {
  params: Promise<{ orgSlug: string; homeworkId: string }>
}) {
  const { orgSlug, homeworkId } = await props.params
  const { supabase, org } = await requireOrgModule(orgSlug, 'classroom')

  const { data: homework } = await supabase
    .from('cls_homeworks')
    .select('id, class_id, title')
    .eq('id', homeworkId)
    .maybeSingle()
  if (!homework) notFound()

  // cls_courses is staff/GA-only — an empty result means this caller isn't
  // staff/GA and shouldn't be able to reach the grading console.
  const { data: staffProbe } = await supabase.from('cls_courses').select('id').eq('org_id', org.id).limit(1)
  if (!staffProbe || staffProbe.length === 0) notFound()

  // Workflow-state transitions (submitted/GA-graded/peer_review) are staff
  // (professor/owner/admin) only per cls_submissions' RLS — GAs may only
  // write their own grade column, so hide buttons that would silently no-op.
  const { data: isProfessor } = await supabase.rpc('cls_can_manage', { check_org_id: org.id })

  const [{ data: submissions }, { data: profiles }, { data: assignments }, { data: grades }] =
    await Promise.all([
      supabase
        .from('cls_submissions')
        .select('id, student_id, state, visible_override_until')
        .eq('homework_id', homeworkId),
      supabase.from('profiles').select('user_id, email, display_name'),
      supabase
        .from('cls_review_assignments')
        .select('id, reviewer_id, submission_id, grade, locked')
        .eq('homework_id', homeworkId),
      supabase
        .from('cls_grades')
        .select('id, student_id, source, score, is_final, visible')
        .eq('homework_id', homeworkId),
    ])

  const nameOf = (userId: string) => {
    const p = (profiles ?? []).find((pr) => pr.user_id === userId)
    return p?.display_name || p?.email || userId
  }
  const gradesByStudent = new Map<string, typeof grades>()
  for (const g of grades ?? []) {
    const list = gradesByStudent.get(g.student_id) ?? []
    list.push(g)
    gradesByStudent.set(g.student_id, list)
  }
  const assignmentsBySubmission = new Map<string, typeof assignments>()
  for (const a of assignments ?? []) {
    const list = assignmentsBySubmission.get(a.submission_id) ?? []
    list.push(a)
    assignmentsBySubmission.set(a.submission_id, list)
  }

  const states = new Set((submissions ?? []).map((s) => s.state))
  const anySubmitted = states.has('submitted')
  const anyGaGrading = states.has('ga_grading')
  const anyPeerReview = states.has('peer_review')

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <div className="mb-6 flex items-baseline gap-4">
        <h1 className="text-2xl font-semibold">Grading — {homework.title}</h1>
        <Link href={`/o/${orgSlug}/m/classroom/manage`} className="text-sm text-blue-600 hover:underline">
          ← Manage
        </Link>
      </div>

      {isProfessor && (
        <div className="mb-6 flex flex-wrap gap-3">
          {anySubmitted && (
            <form action={moveToGaGrading.bind(null, orgSlug, homeworkId)}>
              <button className={btnCls}>Move submitted → GA grading</button>
            </form>
          )}
          {anyGaGrading && (
            <form action={moveToPeerReview.bind(null, orgSlug, homeworkId, homework.class_id)} className="flex items-center gap-2">
              <label className="text-sm text-gray-500">
                Reviews/student{' '}
                <input name="reviewsPerStudent" type="number" min="1" defaultValue={3} className={`${inputCls} w-16`} />
              </label>
              <button className={btnCls}>Move GA-graded → peer review</button>
            </form>
          )}
          {anyPeerReview && (
            <form action={finalizePeerReview.bind(null, orgSlug, homeworkId, homework.class_id)}>
              <button className={btnCls}>Finalize peer review → done</button>
            </form>
          )}
          <form
            action={computeCombinationFinals.bind(null, orgSlug, homeworkId, homework.class_id)}
            className="flex items-center gap-2"
          >
            <label className="text-sm text-gray-500">
              GA ×{' '}
              <input name="gaWeight" type="number" step="0.05" min="0" defaultValue={0.8} className={`${inputCls} w-20`} />
            </label>
            <label className="text-sm text-gray-500">
              Peer ×{' '}
              <input name="peerWeight" type="number" step="0.05" min="0" defaultValue={0.2} className={`${inputCls} w-20`} />
            </label>
            <button className={btnCls}>Compute finals</button>
          </form>
        </div>
      )}

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
            <th className="py-2 pr-3">Student</th>
            <th className="py-2 pr-3">State</th>
            <th className="py-2 pr-3">GA grade</th>
            <th className="py-2 pr-3">Peer reviews</th>
            <th className="py-2 pr-3">Final</th>
          </tr>
        </thead>
        <tbody>
          {(submissions ?? []).map((s) => {
            const studentGrades = gradesByStudent.get(s.student_id) ?? []
            const gaGrade = studentGrades.find((g) => g.source === 'ga')
            const finalGrade = studentGrades.find((g) => g.is_final)
            const reviews = assignmentsBySubmission.get(s.id) ?? []
            return (
              <tr key={s.id} className="border-b border-gray-100">
                <td className="py-2 pr-3">{nameOf(s.student_id)}</td>
                <td className="py-2 pr-3 text-xs text-gray-400">
                  <span className="uppercase">{s.state}</span>
                  {isProfessor && (
                    <form action={setRevealUntil.bind(null, orgSlug, homeworkId, s.id)} className="mt-1 flex items-center gap-1 normal-case">
                      <label className="text-[10px] text-gray-400">
                        reveal until{' '}
                        <input
                          name="revealUntil"
                          type="datetime-local"
                          defaultValue={s.visible_override_until ? s.visible_override_until.slice(0, 16) : ''}
                          className="rounded border border-gray-200 px-1 py-0.5 text-[10px]"
                        />
                      </label>
                      <button className="text-[10px] text-blue-600 hover:underline">Set</button>
                    </form>
                  )}
                </td>
                <td className="py-2 pr-3">
                  {s.state === 'ga_grading' || gaGrade ? (
                    <form action={submitGaGrade.bind(null, orgSlug, homeworkId)} className="flex items-center gap-1">
                      <input type="hidden" name="studentId" value={s.student_id} />
                      <input type="hidden" name="classId" value={homework.class_id} />
                      <input
                        name="score"
                        type="number"
                        step="0.1"
                        defaultValue={gaGrade?.score ?? ''}
                        className={`${inputCls} w-20`}
                      />
                      <button className="text-xs text-blue-600 hover:underline">Save</button>
                    </form>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </td>
                <td className="py-2 pr-3 text-xs text-gray-500">
                  {reviews.length === 0
                    ? '—'
                    : reviews
                        .map((r) => `${nameOf(r.reviewer_id)}: ${r.grade ?? 'pending'}`)
                        .join(', ')}
                </td>
                <td className="py-2 pr-3">
                  {isProfessor ? (
                    <form action={publishFinalGrade.bind(null, orgSlug, homeworkId)} className="flex items-center gap-1">
                      <input type="hidden" name="studentId" value={s.student_id} />
                      <input type="hidden" name="classId" value={homework.class_id} />
                      <input
                        name="finalScore"
                        type="number"
                        step="0.1"
                        defaultValue={finalGrade?.score ?? ''}
                        className={`${inputCls} w-20`}
                      />
                      <button className="text-xs text-blue-600 hover:underline">
                        {finalGrade ? 'Update' : 'Publish'}
                      </button>
                    </form>
                  ) : (
                    (finalGrade?.score ?? '—')
                  )}
                </td>
              </tr>
            )
          })}
          {(submissions ?? []).length === 0 && (
            <tr>
              <td colSpan={5} className="py-4 text-center text-gray-400">
                No submissions yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
