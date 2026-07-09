import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireOrgModule } from '@/lib/module-gate'
import { approveQuestion, createQuestion, recompute, rejectQuestion } from './actions'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'
const btnCls = 'rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700'

// Admin console: approval queue for proposed questions, question authoring,
// and the manual recompute (stand-in for the matchmaking.rescore worker).
export default async function MatchmakingManagePage(props: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await props.params
  const { supabase, org } = await requireOrgModule(orgSlug, 'matchmaking')

  const { data: canManage } = await supabase.rpc('mm_can_manage', { check_org_id: org.id })
  if (!canManage) notFound()

  const [{ data: questions }, { data: staleCount }, { data: singles }] = await Promise.all([
    supabase
      .from('mm_questions')
      .select('id, text, scale_labels, admin_locks, status, submitted_by')
      .eq('org_id', org.id)
      .order('created_at'),
    supabase.from('mm_pair_scores').select('id', { count: 'exact', head: true }).eq('org_id', org.id).eq('stale', true),
    supabase.from('module_roles').select('user_id').eq('org_id', org.id).eq('module_key', 'matchmaking').eq('role', 'single'),
  ])

  const pending = (questions ?? []).filter((q) => q.status === 'pending')
  const approved = (questions ?? []).filter((q) => q.status === 'approved')
  const singleCount = new Set((singles ?? []).map((s) => s.user_id)).size

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <div className="mb-6 flex items-baseline gap-4">
        <h1 className="text-2xl font-semibold">Make-a-Match — Manage</h1>
        <Link href={`/o/${orgSlug}/m/matchmaking`} className="text-sm text-blue-600 hover:underline">
          ← Match
        </Link>
      </div>

      <section className="mb-8 rounded-lg border border-gray-200 bg-white p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-medium">Matches</h2>
            <p className="text-sm text-gray-500">
              {singleCount} singles. Recompute after answers change (until the rescore worker is deployed).
            </p>
          </div>
          <form action={recompute.bind(null, orgSlug)}>
            <button className={btnCls}>Recompute all matches</button>
          </form>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-lg font-medium">Pending proposals ({pending.length})</h2>
        {pending.length === 0 ? (
          <p className="text-sm text-gray-500">No questions awaiting approval.</p>
        ) : (
          <ul className="space-y-2">
            {pending.map((q) => (
              <li key={q.id} className="flex items-center justify-between rounded border border-gray-200 bg-white px-4 py-2">
                <span className="text-sm">
                  <span className="font-medium">{q.text}</span>{' '}
                  <span className="text-gray-400">[{q.scale_labels.join(' · ')}]</span>
                </span>
                <span className="flex gap-3">
                  <form action={approveQuestion.bind(null, orgSlug, q.id)}>
                    <button className="text-sm text-green-600 hover:underline">Approve</button>
                  </form>
                  <form action={rejectQuestion.bind(null, orgSlug, q.id)}>
                    <button className="text-sm text-red-600 hover:underline">Reject</button>
                  </form>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-lg font-medium">Add a question</h2>
        <form action={createQuestion.bind(null, orgSlug)} className="space-y-3 rounded-lg border border-gray-200 bg-white p-5">
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">Question text</label>
            <input name="text" required placeholder="e.g. I enjoy travel" className={`${inputCls} w-full`} />
          </div>
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">
              Scale labels (2–5, comma-separated)
            </label>
            <input name="labels" required placeholder="Never, Sometimes, Often, Always" className={`${inputCls} w-full`} />
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-1">
              Lock care at
              <input name="lockCare" type="number" min={-10} max={10} placeholder="—" className={`${inputCls} w-20`} />
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" name="lockDealbreaker" />
              Lock as dealbreaker (hard filter)
            </label>
          </div>
          <p className="text-xs text-gray-400">
            Locks turn a question into a forced criterion — e.g. a gender question with care −10 +
            dealbreaker enforces opposite-gender matching.
          </p>
          <button className={btnCls}>Add question</button>
        </form>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Approved questions ({approved.length})</h2>
        <ul className="space-y-1 text-sm text-gray-700">
          {approved.map((q) => {
            const locks = (q.admin_locks ?? {}) as { care?: number; dealbreaker?: boolean; answer?: number }
            const lockNotes = [
              locks.answer !== undefined ? `answer=${locks.answer}` : null,
              locks.care !== undefined ? `care=${locks.care}` : null,
              locks.dealbreaker ? 'dealbreaker' : null,
            ].filter(Boolean)
            return (
              <li key={q.id} className="rounded border border-gray-100 bg-white px-4 py-2">
                <span className="font-medium">{q.text}</span>{' '}
                <span className="text-gray-400">[{q.scale_labels.join(' · ')}]</span>
                {lockNotes.length > 0 && (
                  <span className="ml-2 text-xs uppercase text-amber-600">locked: {lockNotes.join(', ')}</span>
                )}
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}
