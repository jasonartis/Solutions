'use server'

import { revalidatePath } from 'next/cache'
import { DERIVED_SCOPE_PLACEHOLDER } from '@platform/core'
import { createClient } from '@/lib/supabase/server'

// Professor/staff actions. RLS (cls_can_manage) is the enforcement layer;
// scope-sync triggers derive org_id from the class, so only class_id is sent.

function fail(error: { message: string } | null, what: string) {
  if (error) throw new Error(`${what}: ${error.message}`)
}

export async function postAnnouncement(orgSlug: string, classId: string, formData: FormData) {
  const body = String(formData.get('body') ?? '').trim()
  if (!body) throw new Error('Announcement text is required')

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { error } = await supabase.from('cls_announcements').insert({
    // org_id is derived by the scope-sync trigger; a placeholder satisfies NOT NULL pre-trigger.
    org_id: DERIVED_SCOPE_PLACEHOLDER,
    class_id: classId,
    author_id: user?.id ?? null,
    body,
  })
  fail(error, 'Post announcement failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/manage`)
  revalidatePath(`/o/${orgSlug}/m/classroom`)
}

export async function createHomework(orgSlug: string, classId: string, formData: FormData) {
  const title = String(formData.get('title') ?? '').trim()
  if (!title) throw new Error('Title is required')
  const dueAt = String(formData.get('dueAt') ?? '').trim()

  const supabase = await createClient()
  const { error } = await supabase.from('cls_homeworks').insert({
    org_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
    class_id: classId,
    title,
    due_at: dueAt ? new Date(dueAt).toISOString() : null,
  })
  fail(error, 'Create homework failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/manage`)
  revalidatePath(`/o/${orgSlug}/m/classroom`)
}

// Structure syntax: "1a:10, 1b:5, 2:20" -> [{label:'1a',points:10}, ...].
// The label:points list defines the grading granularity (spec: exams graded
// by problem/subproblem).
export async function createExam(orgSlug: string, classId: string, formData: FormData) {
  const title = String(formData.get('title') ?? '').trim()
  const structureRaw = String(formData.get('structure') ?? '').trim()
  if (!title) throw new Error('Title is required')

  const structure = structureRaw
    ? structureRaw.split(',').map((part) => {
        const [label, points] = part.split(':').map((s) => s.trim())
        const pts = Number(points)
        if (!label || Number.isNaN(pts) || pts <= 0) {
          throw new Error(`Invalid problem "${part}" — use label:points, e.g. 1a:10`)
        }
        return { label, points: pts }
      })
    : []

  const supabase = await createClient()
  const { error } = await supabase.from('cls_exams').insert({
    org_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
    class_id: classId,
    title,
    structure,
  })
  fail(error, 'Create exam failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/manage`)
}

export async function createSurvey(orgSlug: string, classId: string, formData: FormData) {
  const question = String(formData.get('question') ?? '').trim()
  if (!question) throw new Error('Survey question is required')

  const supabase = await createClient()
  const { error } = await supabase.from('cls_surveys').insert({
    org_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
    class_id: classId,
    question,
  })
  fail(error, 'Create survey failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/manage`)
  revalidatePath(`/o/${orgSlug}/m/classroom`)
}

// Per-class retention (founder decision 2026-07-09): from this date,
// submissions hide from students AND GAs; the professor keeps access and can
// re-reveal single items with an expiration (grading console). Empty = never.
export async function setSubmissionsHiddenFrom(orgSlug: string, classId: string, formData: FormData) {
  const raw = String(formData.get('hiddenFrom') ?? '').trim()
  const supabase = await createClient()
  const { error } = await supabase
    .from('cls_classes')
    .update({ submissions_hidden_from: raw || null })
    .eq('id', classId)
  fail(error, 'Set retention date failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/manage`)
}

export async function setSurveyResultsVisible(orgSlug: string, surveyId: string, visible: boolean) {
  const supabase = await createClient()
  const { error } = await supabase
    .from('cls_surveys')
    .update({ results_visible: visible })
    .eq('id', surveyId)
  fail(error, 'Update survey failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/manage`)
  revalidatePath(`/o/${orgSlug}/m/classroom`)
}
