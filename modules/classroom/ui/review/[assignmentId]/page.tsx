import { notFound } from 'next/navigation'
import { requireOrgModule } from '@/lib/module-gate'
import { addReviewComment, submitPeerGrade } from './actions'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'
const btnCls = 'rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700'

// Anonymous peer review: the reviewer sees the submission's files, their own
// prior comments, and a grade box. Reviewer identity never reaches the
// reviewee (cls_comments_for_my_submission strips author_id on their side).
export default async function ReviewPage(props: {
  params: Promise<{ orgSlug: string; assignmentId: string }>
}) {
  const { orgSlug, assignmentId } = await props.params
  const { supabase, org } = await requireOrgModule(orgSlug, 'classroom')

  const { data: assignment } = await supabase
    .from('cls_review_assignments')
    .select('id, submission_id, grade, locked')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!assignment) notFound()

  const [{ data: files }, { data: comments }] = await Promise.all([
    supabase
      .from('cls_submission_files')
      .select('id, file_name, storage_path')
      .eq('submission_id', assignment.submission_id),
    supabase
      .from('cls_review_comments')
      .select('id, body, created_at')
      .eq('submission_id', assignment.submission_id)
      .order('created_at'),
  ])

  const fileLinks: { name: string; url: string }[] = []
  for (const f of files ?? []) {
    const { data } = await supabase.storage.from('cls-submissions').createSignedUrl(f.storage_path, 3600)
    if (data?.signedUrl) fileLinks.push({ name: f.file_name, url: data.signedUrl })
  }

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <h1 className="mb-6 text-2xl font-semibold">Peer review</h1>

      <section className="mb-6 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-3 text-lg font-medium">Submission files</h2>
        {fileLinks.length === 0 ? (
          <p className="text-sm text-gray-400">No files submitted.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {fileLinks.map((f) => (
              <li key={f.name}>
                <a href={f.url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                  {f.name}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-6 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-3 text-lg font-medium">Your comments</h2>
        <ul className="mb-4 space-y-2 text-sm">
          {(comments ?? []).map((c) => (
            <li key={c.id} className="rounded bg-gray-50 p-2">
              {c.body}
            </li>
          ))}
          {(comments ?? []).length === 0 && <li className="text-gray-400">No comments yet.</li>}
        </ul>
        <form
          action={addReviewComment.bind(null, orgSlug, assignmentId, assignment.submission_id)}
          className="flex items-start gap-2"
        >
          <textarea name="body" required placeholder="Add a comment…" className={`${inputCls} min-h-16 flex-1`} />
          <button className={btnCls}>Add</button>
        </form>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-3 text-lg font-medium">Your grade</h2>
        {assignment.locked ? (
          <p className="text-sm text-gray-500">Locked at {assignment.grade ?? '—'}.</p>
        ) : (
          <form action={submitPeerGrade.bind(null, orgSlug, assignmentId)} className="flex items-center gap-2">
            <input name="grade" type="number" step="0.1" defaultValue={assignment.grade ?? ''} className={`${inputCls} w-24`} />
            <button className={btnCls}>{assignment.grade !== null ? 'Update grade' : 'Submit grade'}</button>
          </form>
        )}
      </section>
    </div>
  )
}
