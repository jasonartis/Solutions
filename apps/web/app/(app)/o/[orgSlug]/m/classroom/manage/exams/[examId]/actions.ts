'use server'

import { revalidatePath } from 'next/cache'
import { DERIVED_SCOPE_PLACEHOLDER } from '@platform/core'
import { createClient } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'

// Exam grading actions (staff/GA per RLS). Exams are taken on paper: staff
// upload scans, grade by subproblem (the exam's `structure` defines the
// granularity), and the professor publishes the final.

function fail(error: { message: string } | null, what: string) {
  if (error) throw new Error(`${what}: ${error.message}`)
}

export async function uploadExamPaper(
  orgSlug: string,
  examId: string,
  formData: FormData,
) {
  const studentId = String(formData.get('studentId') ?? '')
  const file = formData.get('file') as File | null
  if (!studentId || !file || file.size === 0) throw new Error('Student and file are required')

  const supabase = await createClient()
  const { data: exam } = await supabase
    .from('cls_exams')
    .select('org_id, class_id')
    .eq('id', examId)
    .single()
  if (!exam) throw new Error('Exam not found')

  const path = `${exam.org_id}/${exam.class_id}/${examId}/${studentId}-${Date.now()}-${file.name}`
  const { error: upErr } = await supabase.storage.from('cls-exams').upload(path, file)
  fail(upErr, 'Scan upload failed')

  const { error } = await supabase.from('cls_exam_papers').insert({
    org_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
    class_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
    exam_id: examId,
    student_id: studentId,
    storage_path: path,
  })
  fail(error, 'Record scan failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/manage/exams/${examId}`)
}

// cls_grades' unique index is coalesce(homework_id, exam_id), which a
// plain-column upsert can't target — select-then-insert/update (same shape as
// the homework grading actions' helper, keyed by exam_id instead).
async function upsertExamGrade(
  supabase: SupabaseClient,
  row: {
    classId: string
    examId: string
    studentId: string
    source: 'ga' | 'instructor' | 'override'
    score: number
    detail?: Record<string, unknown>
    isFinal?: boolean
    visible?: boolean
  },
) {
  const { data: existing } = await supabase
    .from('cls_grades')
    .select('id')
    .eq('class_id', row.classId)
    .eq('exam_id', row.examId)
    .eq('student_id', row.studentId)
    .eq('source', row.source)
    .maybeSingle()

  if (existing) {
    const { error } = await supabase
      .from('cls_grades')
      .update({
        score: row.score,
        ...(row.detail !== undefined ? { detail: row.detail } : {}),
        ...(row.isFinal !== undefined ? { is_final: row.isFinal } : {}),
        ...(row.visible !== undefined ? { visible: row.visible } : {}),
      })
      .eq('id', existing.id)
    return error
  }

  const { error } = await supabase.from('cls_grades').insert({
    org_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
    class_id: row.classId,
    exam_id: row.examId,
    student_id: row.studentId,
    source: row.source,
    score: row.score,
    detail: row.detail ?? {},
    is_final: row.isFinal ?? false,
    visible: row.visible ?? false,
  })
  return error
}

// Save per-subproblem scores. Fields arrive as problem_<label>=<points>; the
// total is their sum, capped per problem at the structure's max (defensive —
// the input's max attribute is UI-only).
export async function saveExamScores(
  orgSlug: string,
  examId: string,
  classId: string,
  formData: FormData,
) {
  const studentId = String(formData.get('studentId') ?? '')
  if (!studentId) throw new Error('Student is required')

  const supabase = await createClient()
  const { data: exam } = await supabase.from('cls_exams').select('structure').eq('id', examId).single()
  if (!exam) throw new Error('Exam not found')
  const structure = (exam.structure ?? []) as { label: string; points: number }[]

  const problems: Record<string, number> = {}
  let total = 0
  for (const p of structure) {
    const raw = formData.get(`problem_${p.label}`)
    if (raw === null || String(raw).trim() === '') continue
    const v = Math.min(Number(raw), p.points)
    if (Number.isNaN(v) || v < 0) throw new Error(`Invalid score for ${p.label}`)
    problems[p.label] = v
    total += v
  }

  const error = await upsertExamGrade(supabase, {
    classId,
    examId,
    studentId,
    source: 'ga',
    score: total,
    detail: { problems },
  })
  fail(error, 'Save scores failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/manage/exams/${examId}`)
}

export async function publishExamFinal(
  orgSlug: string,
  examId: string,
  classId: string,
  formData: FormData,
) {
  const studentId = String(formData.get('studentId') ?? '')
  const score = Number(formData.get('finalScore'))
  if (!studentId || Number.isNaN(score)) throw new Error('Final score is required')

  const supabase = await createClient()
  const error = await upsertExamGrade(supabase, {
    classId,
    examId,
    studentId,
    source: 'override',
    score,
    isFinal: true,
    visible: true,
  })
  fail(error, 'Publish final failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/manage/exams/${examId}`)
}
