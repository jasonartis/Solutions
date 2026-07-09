'use server'

import { revalidatePath } from 'next/cache'
import { DERIVED_SCOPE_PLACEHOLDER } from '@platform/core'
import { createClient } from '@/lib/supabase/server'

// Reviewer actions. RLS enforces that only the assigned reviewer may write
// their own grade/comments, and only while the assignment is unlocked.

function fail(error: { message: string } | null, what: string) {
  if (error) throw new Error(`${what}: ${error.message}`)
}

export async function submitPeerGrade(orgSlug: string, assignmentId: string, formData: FormData) {
  const grade = Number(formData.get('grade'))
  if (Number.isNaN(grade)) throw new Error('Grade is required')

  const supabase = await createClient()
  const { error } = await supabase
    .from('cls_review_assignments')
    .update({ grade, grade_submitted_at: new Date().toISOString() })
    .eq('id', assignmentId)
  fail(error, 'Submit grade failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/review/${assignmentId}`)
}

export async function addReviewComment(
  orgSlug: string,
  assignmentId: string,
  submissionId: string,
  formData: FormData,
) {
  const body = String(formData.get('body') ?? '').trim()
  if (!body) throw new Error('Comment is required')

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase.from('cls_review_comments').insert({
    org_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
    class_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
    submission_id: submissionId,
    author_id: user?.id,
    file_path: 'submission',
    body,
  })
  fail(error, 'Add comment failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/review/${assignmentId}`)
}
