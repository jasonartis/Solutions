'use server'

import { revalidatePath } from 'next/cache'
import { DERIVED_SCOPE_PLACEHOLDER } from '@platform/core'
import { createClient } from '@/lib/supabase/server'

// Student actions. RLS (cls_submissions_insert_own / cls_submission_open)
// enforces ownership and the deadline window; scope-sync triggers derive
// org_id/class_id from the parent homework/submission.

function fail(error: { message: string } | null, what: string) {
  if (error) throw new Error(`${what}: ${error.message}`)
}

export async function getOrCreateSubmission(homeworkId: string, classId: string) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')

  const { data: existing } = await supabase
    .from('cls_submissions')
    .select('id, org_id, state')
    .eq('homework_id', homeworkId)
    .eq('student_id', user.id)
    .maybeSingle()
  if (existing) return existing

  const { data: created, error } = await supabase
    .from('cls_submissions')
    .insert({
      org_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
      homework_id: homeworkId,
      class_id: classId,
      student_id: user.id,
    })
    .select('id, org_id, state')
    .single()
  fail(error, 'Create submission failed')
  return created
}

export async function uploadSubmissionFile(
  orgSlug: string,
  homeworkId: string,
  submissionId: string,
  orgId: string,
  classId: string,
  formData: FormData,
) {
  const file = formData.get('file') as File | null
  if (!file || file.size === 0) throw new Error('Choose a file')

  const supabase = await createClient()
  const path = `${orgId}/${classId}/${submissionId}/${Date.now()}-${file.name}`
  const { error: upErr } = await supabase.storage.from('cls-submissions').upload(path, file)
  fail(upErr, 'Upload failed')

  const { error } = await supabase.from('cls_submission_files').insert({
    org_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
    class_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
    submission_id: submissionId,
    file_name: file.name,
    storage_path: path,
    size_bytes: file.size,
  })
  fail(error, 'Record uploaded file failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/homework/${homeworkId}`)
}

export async function deleteSubmissionFile(
  orgSlug: string,
  homeworkId: string,
  fileId: string,
  storagePath: string,
) {
  const supabase = await createClient()
  const { error: delErr } = await supabase.storage.from('cls-submissions').remove([storagePath])
  fail(delErr, 'Delete file failed')
  const { error } = await supabase.from('cls_submission_files').delete().eq('id', fileId)
  fail(error, 'Delete file record failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/homework/${homeworkId}`)
}
