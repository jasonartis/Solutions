import { notFound } from 'next/navigation'
import { requireOrgModule } from '@/lib/module-gate'
import { createClient } from '@/lib/supabase/server'
import { deleteSubmissionFile, getOrCreateSubmission, uploadSubmissionFile } from './actions'

// Student submission page: upload/list/remove files for one homework while
// the deadline is open (mirrors cls_submission_open in the RLS layer).
export default async function HomeworkPage(props: {
  params: Promise<{ orgSlug: string; homeworkId: string }>
}) {
  const { orgSlug, homeworkId } = await props.params
  const { org } = await requireOrgModule(orgSlug, 'classroom')
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { data: homework } = await supabase
    .from('cls_homeworks')
    .select('id, class_id, title, due_at')
    .eq('id', homeworkId)
    .maybeSingle()
  if (!homework) notFound()

  const { data: membership } = await supabase
    .from('cls_class_members')
    .select('role')
    .eq('class_id', homework.class_id)
    .eq('user_id', user?.id ?? '')
    .maybeSingle()
  const isStaff = membership?.role === 'professor' || membership?.role === 'ga'
  const deadlinePassed = homework.due_at ? new Date(homework.due_at) < new Date() : false

  if (isStaff) {
    return (
      <div>
        <p className="mb-1 text-sm text-gray-400">{org.name}</p>
        <h1 className="mb-4 text-2xl font-semibold">{homework.title}</h1>
        <p className="text-gray-500">
          Staff view — grading and submission review are managed from the Manage console.
        </p>
      </div>
    )
  }

  const submission = deadlinePassed
    ? (
        await supabase
          .from('cls_submissions')
          .select('id, org_id, state')
          .eq('homework_id', homeworkId)
          .eq('student_id', user?.id ?? '')
          .maybeSingle()
      ).data
    : await getOrCreateSubmission(homeworkId, homework.class_id)

  const { data: files } = submission
    ? await supabase
        .from('cls_submission_files')
        .select('id, file_name, storage_path, size_bytes')
        .eq('submission_id', submission.id)
        .order('created_at')
    : { data: [] as { id: string; file_name: string; storage_path: string; size_bytes: number | null }[] }

  const canModify = submission?.state === 'submitted' && !deadlinePassed

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <h1 className="mb-1 text-2xl font-semibold">{homework.title}</h1>
      <p className="mb-6 text-sm text-gray-400">
        {homework.due_at ? `Due ${new Date(homework.due_at).toLocaleString()}` : 'No deadline'}
        {deadlinePassed && ' — deadline passed'}
      </p>

      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-3 text-lg font-medium">Your submission</h2>
        <ul className="mb-4 space-y-1 text-sm">
          {(files ?? []).map((f) => (
            <li key={f.id} className="flex items-center justify-between">
              <span>{f.file_name}</span>
              {canModify && (
                <form action={deleteSubmissionFile.bind(null, orgSlug, homeworkId, f.id, f.storage_path)}>
                  <button className="text-xs text-red-600 hover:underline">Remove</button>
                </form>
              )}
            </li>
          ))}
          {(files ?? []).length === 0 && <li className="text-gray-400">No files uploaded yet.</li>}
        </ul>

        {canModify && submission ? (
          <form
            action={uploadSubmissionFile.bind(
              null,
              orgSlug,
              homeworkId,
              submission.id,
              submission.org_id,
              homework.class_id,
            )}
            className="flex items-center gap-2"
          >
            <input name="file" type="file" required className="text-sm" />
            <button className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700">
              Upload
            </button>
          </form>
        ) : (
          <p className="text-sm text-gray-400">
            {deadlinePassed ? 'The deadline has passed — submission is locked.' : 'Submission is locked.'}
          </p>
        )}
      </section>
    </div>
  )
}
