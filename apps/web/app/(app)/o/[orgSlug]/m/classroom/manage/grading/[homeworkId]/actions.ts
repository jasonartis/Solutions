'use server'

import { revalidatePath } from 'next/cache'
import { DERIVED_SCOPE_PLACEHOLDER } from '@platform/core'
import { assignPeerReviews } from '@modules/classroom'
import { createClient } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'

// Professor/GA actions driving the submission workflow:
// submitted -> ga_grading -> peer_review -> done.
// RLS (cls_can_manage / cls_is_ga) enforces who may write what; these actions
// just sequence the calls in the right order.

function fail(error: { message: string } | null, what: string) {
  if (error) throw new Error(`${what}: ${error.message}`)
}

// cls_grades' unique index is a coalesce(homework_id, exam_id) expression, so
// a plain-column upsert onConflict can't target it — select-then-insert/update
// by hand instead.
async function upsertGrade(
  supabase: SupabaseClient,
  row: {
    classId: string
    homeworkId: string
    studentId: string
    source: 'ga' | 'peer' | 'combination' | 'override'
    score: number
    isFinal?: boolean
    visible?: boolean
  },
) {
  const { data: existing } = await supabase
    .from('cls_grades')
    .select('id')
    .eq('class_id', row.classId)
    .eq('homework_id', row.homeworkId)
    .eq('student_id', row.studentId)
    .eq('source', row.source)
    .maybeSingle()

  if (existing) {
    const { error } = await supabase
      .from('cls_grades')
      .update({
        score: row.score,
        ...(row.isFinal !== undefined ? { is_final: row.isFinal } : {}),
        ...(row.visible !== undefined ? { visible: row.visible } : {}),
      })
      .eq('id', existing.id)
    return error
  }

  const { error } = await supabase.from('cls_grades').insert({
    org_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
    class_id: row.classId,
    homework_id: row.homeworkId,
    student_id: row.studentId,
    source: row.source,
    score: row.score,
    is_final: row.isFinal ?? false,
    visible: row.visible ?? false,
  })
  return error
}

export async function moveToGaGrading(orgSlug: string, homeworkId: string) {
  const supabase = await createClient()
  const { error } = await supabase
    .from('cls_submissions')
    .update({ state: 'ga_grading' })
    .eq('homework_id', homeworkId)
    .eq('state', 'submitted')
  fail(error, 'Move to GA grading failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/manage/grading/${homeworkId}`)
}

export async function submitGaGrade(orgSlug: string, homeworkId: string, formData: FormData) {
  const studentId = String(formData.get('studentId') ?? '')
  const classId = String(formData.get('classId') ?? '')
  const score = Number(formData.get('score'))
  if (!studentId || !classId || Number.isNaN(score)) throw new Error('Score is required')

  const supabase = await createClient()
  const error = await upsertGrade(supabase, { classId, homeworkId, studentId, source: 'ga', score })
  fail(error, 'Save GA grade failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/manage/grading/${homeworkId}`)
}

// Moves ga_grading submissions to peer_review and generates the review
// matrix via the pure assignPeerReviews engine (modules/classroom).
export async function moveToPeerReview(
  orgSlug: string,
  homeworkId: string,
  classId: string,
  formData: FormData,
) {
  const reviewsPerStudent = Number(formData.get('reviewsPerStudent') ?? 3) || 3
  const supabase = await createClient()

  const [{ data: members }, { data: submissions }, { data: priorRaw }] = await Promise.all([
    supabase.from('cls_class_members').select('user_id').eq('class_id', classId).eq('role', 'student'),
    supabase.from('cls_submissions').select('id, student_id').eq('homework_id', homeworkId),
    supabase
      .from('cls_review_assignments')
      .select('reviewer_id, homework_id, submission:cls_submissions(student_id)')
      .eq('class_id', classId)
      .neq('homework_id', homeworkId),
  ])

  const prior = (priorRaw ?? []) as unknown as {
    reviewer_id: string
    homework_id: string
    submission: { student_id: string } | null
  }[]
  const history = prior
    .filter((p) => p.submission)
    .map((p) => ({ reviewerId: p.reviewer_id, revieweeId: p.submission!.student_id }))
  const round = new Set(prior.map((p) => p.homework_id)).size

  const assignments = assignPeerReviews(
    (members ?? []).map((m) => m.user_id),
    (submissions ?? []).map((s) => ({ studentId: s.student_id })),
    reviewsPerStudent,
    history,
    round,
  )
  const submissionByStudent = new Map((submissions ?? []).map((s) => [s.student_id, s.id]))

  const { error: stateErr } = await supabase
    .from('cls_submissions')
    .update({ state: 'peer_review' })
    .eq('homework_id', homeworkId)
    .eq('state', 'ga_grading')
  fail(stateErr, 'Move to peer review failed')

  if (assignments.length > 0) {
    const rows = assignments
      .map((a) => ({
        org_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
        homework_id: homeworkId,
        reviewer_id: a.reviewerId,
        submission_id: submissionByStudent.get(a.submissionStudentId),
      }))
      .filter((r) => r.submission_id)
    const { error: assignErr } = await supabase.from('cls_review_assignments').insert(rows)
    fail(assignErr, 'Create peer review assignments failed')
  }

  revalidatePath(`/o/${orgSlug}/m/classroom/manage/grading/${homeworkId}`)
}

// Averages submitted peer grades into a cls_grades 'peer' row per submission
// and closes the round.
export async function finalizePeerReview(orgSlug: string, homeworkId: string, classId: string) {
  const supabase = await createClient()

  const [{ data: submissions }, { data: assignments }] = await Promise.all([
    supabase.from('cls_submissions').select('id, student_id').eq('homework_id', homeworkId),
    supabase
      .from('cls_review_assignments')
      .select('submission_id, grade')
      .eq('homework_id', homeworkId),
  ])

  const gradesBySubmission = new Map<string, number[]>()
  for (const a of assignments ?? []) {
    if (a.grade === null || a.grade === undefined) continue
    const list = gradesBySubmission.get(a.submission_id) ?? []
    list.push(Number(a.grade))
    gradesBySubmission.set(a.submission_id, list)
  }

  for (const s of submissions ?? []) {
    const grades = gradesBySubmission.get(s.id)
    if (!grades || grades.length === 0) continue
    const avg = grades.reduce((a, b) => a + b, 0) / grades.length
    const error = await upsertGrade(supabase, {
      classId,
      homeworkId,
      studentId: s.student_id,
      source: 'peer',
      score: avg,
    })
    fail(error, 'Save peer average failed')
  }

  const { error: stateErr } = await supabase
    .from('cls_submissions')
    .update({ state: 'done' })
    .eq('homework_id', homeworkId)
    .eq('state', 'peer_review')
  fail(stateErr, 'Close peer review failed')

  revalidatePath(`/o/${orgSlug}/m/classroom/manage/grading/${homeworkId}`)
}

// Exactly one row per (student, homework) may carry is_final — step any
// previous final down before flagging a new one (combination and override
// rows coexist in the table; only the flag is exclusive).
async function unsetPriorFinals(supabase: SupabaseClient, homeworkId: string, studentId: string) {
  const { error } = await supabase
    .from('cls_grades')
    .update({ is_final: false })
    .eq('homework_id', homeworkId)
    .eq('student_id', studentId)
    .eq('is_final', true)
  if (error) throw new Error(`Unset prior finals failed: ${error.message}`)
}

// The spec's "0.2*peer + 0.8*GA"-style gradebook combination: for every
// student with any component grade, final = Σ(score×weight) / Σ(weights of
// the components that exist) — a student graded only by peers (or only by
// the GA) still gets a sensible final instead of a zero for the missing part.
// Writes source='combination' rows flagged final+visible; students with a
// manual 'override' final keep it (override wins, per the spec's column order).
export async function computeCombinationFinals(
  orgSlug: string,
  homeworkId: string,
  classId: string,
  formData: FormData,
) {
  const gaWeight = Number(formData.get('gaWeight'))
  const peerWeight = Number(formData.get('peerWeight'))
  if (Number.isNaN(gaWeight) || Number.isNaN(peerWeight) || gaWeight < 0 || peerWeight < 0 || gaWeight + peerWeight <= 0) {
    throw new Error('Weights must be non-negative and not both zero')
  }

  const supabase = await createClient()
  const [{ data: submissions }, { data: grades }] = await Promise.all([
    supabase.from('cls_submissions').select('student_id').eq('homework_id', homeworkId),
    supabase.from('cls_grades').select('id, student_id, source, score, is_final').eq('homework_id', homeworkId),
  ])

  for (const s of submissions ?? []) {
    const mine = (grades ?? []).filter((g) => g.student_id === s.student_id)
    if (mine.some((g) => g.source === 'override' && g.is_final)) continue // manual override wins

    const parts: { score: number; weight: number }[] = []
    const ga = mine.find((g) => g.source === 'ga')
    const peer = mine.find((g) => g.source === 'peer')
    if (ga?.score !== null && ga?.score !== undefined && gaWeight > 0) parts.push({ score: Number(ga.score), weight: gaWeight })
    if (peer?.score !== null && peer?.score !== undefined && peerWeight > 0) parts.push({ score: Number(peer.score), weight: peerWeight })
    if (parts.length === 0) continue

    const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0)
    const combined = parts.reduce((sum, p) => sum + p.score * p.weight, 0) / totalWeight

    await unsetPriorFinals(supabase, homeworkId, s.student_id)

    const error = await upsertGrade(supabase, {
      classId,
      homeworkId,
      studentId: s.student_id,
      source: 'combination',
      score: Math.round(combined * 10) / 10,
      isFinal: true,
      visible: true,
    })
    fail(error, 'Write combination final failed')
  }

  revalidatePath(`/o/${orgSlug}/m/classroom/manage/grading/${homeworkId}`)
}

export async function publishFinalGrade(orgSlug: string, homeworkId: string, formData: FormData) {
  const studentId = String(formData.get('studentId') ?? '')
  const classId = String(formData.get('classId') ?? '')
  const score = Number(formData.get('finalScore'))
  if (!studentId || !classId || Number.isNaN(score)) throw new Error('Final score is required')

  const supabase = await createClient()
  await unsetPriorFinals(supabase, homeworkId, studentId)
  const error = await upsertGrade(supabase, {
    classId,
    homeworkId,
    studentId,
    source: 'override',
    score,
    isFinal: true,
    visible: true,
  })
  fail(error, 'Publish final grade failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/manage/grading/${homeworkId}`)
}
