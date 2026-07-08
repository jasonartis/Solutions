'use server'

import { revalidatePath } from 'next/cache'
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
    org_id: '00000000-0000-0000-0000-000000000000',
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
    org_id: '00000000-0000-0000-0000-000000000000', // derived by trigger
    class_id: classId,
    title,
    due_at: dueAt ? new Date(dueAt).toISOString() : null,
  })
  fail(error, 'Create homework failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/manage`)
  revalidatePath(`/o/${orgSlug}/m/classroom`)
}

export async function createSurvey(orgSlug: string, classId: string, formData: FormData) {
  const question = String(formData.get('question') ?? '').trim()
  if (!question) throw new Error('Survey question is required')

  const supabase = await createClient()
  const { error } = await supabase.from('cls_surveys').insert({
    org_id: '00000000-0000-0000-0000-000000000000', // derived by trigger
    class_id: classId,
    question,
  })
  fail(error, 'Create survey failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/manage`)
  revalidatePath(`/o/${orgSlug}/m/classroom`)
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
