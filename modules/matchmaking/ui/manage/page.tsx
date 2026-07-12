import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireOrgModule } from '@/lib/module-gate'
import {
  addGroupMember,
  approveQuestion,
  assignMatchmaker,
  createGroup,
  createQuestion,
  recompute,
  rejectQuestion,
  removeAssignment,
  removeGroupMember,
} from './actions'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'
const btnCls = 'rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700'

// Admin console: approval queue for proposed questions, question authoring,
// the manual recompute (stand-in for the matchmaking.rescore worker), and
// group/matchmaker-assignment management (a matchmaker's own view relies
// entirely on these existing — RLS scopes their matches to assigned singles).
export default async function MatchmakingManagePage(props: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await props.params
  const { supabase, org } = await requireOrgModule(orgSlug, 'matchmaking')

  const { data: canManage } = await supabase.rpc('mm_can_manage', { check_org_id: org.id })
  if (!canManage) notFound()

  const [
    { data: questions },
    { data: staleCount },
    { data: singles },
    { data: matchmakerRoles },
    { data: groups },
    { data: groupMembers },
    { data: assignments },
    { data: profiles },
  ] = await Promise.all([
    supabase
      .from('mm_questions')
      .select('id, text, scale_labels, admin_locks, status, submitted_by')
      .eq('org_id', org.id)
      .order('created_at'),
    supabase.from('mm_pair_scores').select('id', { count: 'exact', head: true }).eq('org_id', org.id).eq('stale', true),
    supabase.from('module_roles').select('user_id').eq('org_id', org.id).eq('module_key', 'matchmaking').eq('role', 'single'),
    supabase.from('module_roles').select('user_id').eq('org_id', org.id).eq('module_key', 'matchmaking').eq('role', 'matchmaker'),
    supabase.from('mm_groups').select('id, name').eq('org_id', org.id).order('created_at'),
    supabase.from('mm_group_members').select('id, group_id, user_id').eq('org_id', org.id),
    supabase
      .from('mm_matchmaker_assignments')
      .select('id, matchmaker_id, target_type, target_user_id, target_group_id')
      .eq('org_id', org.id),
    supabase.from('profiles').select('user_id, display_name, email'),
  ])

  const pending = (questions ?? []).filter((q) => q.status === 'pending')
  const approved = (questions ?? []).filter((q) => q.status === 'approved')
  const singleCount = new Set((singles ?? []).map((s) => s.user_id)).size
  const nameOf = (userId: string) => {
    const p = (profiles ?? []).find((pr) => pr.user_id === userId)
    return p?.display_name || p?.email || 'Someone'
  }
  const groupName = (groupId: string) => (groups ?? []).find((g) => g.id === groupId)?.name ?? 'Unknown group'

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

      <section className="mt-8 border-t border-gray-100 pt-6">
        <h2 className="mb-3 text-lg font-medium">Groups</h2>
        <p className="mb-3 text-xs text-gray-400">
          {(matchmakerRoles ?? []).length} matchmaker{(matchmakerRoles ?? []).length === 1 ? '' : 's'} in this org:{' '}
          {(matchmakerRoles ?? []).map((m) => nameOf(m.user_id)).join(', ') || 'none yet'}.
        </p>
        <ul className="mb-4 space-y-2">
          {(groups ?? []).map((g) => {
            const members = (groupMembers ?? []).filter((gm) => gm.group_id === g.id)
            return (
              <li key={g.id} className="rounded border border-gray-200 bg-white p-3">
                <div className="mb-2 font-medium">{g.name}</div>
                <ul className="mb-2 space-y-0.5 text-sm text-gray-700">
                  {members.map((gm) => (
                    <li key={gm.id} className="flex items-center justify-between">
                      <span>{nameOf(gm.user_id)}</span>
                      <form action={removeGroupMember.bind(null, orgSlug, gm.id)}>
                        <button className="text-xs text-red-600 hover:underline">Remove</button>
                      </form>
                    </li>
                  ))}
                  {members.length === 0 && <li className="text-gray-400">No members yet.</li>}
                </ul>
                <form action={addGroupMember.bind(null, orgSlug, g.id)} className="flex items-center gap-2">
                  <input
                    name="email"
                    type="email"
                    required
                    placeholder="single@email"
                    className={`${inputCls} text-xs`}
                  />
                  <button className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50">
                    Add to group
                  </button>
                </form>
              </li>
            )
          })}
          {(groups ?? []).length === 0 && <li className="text-gray-400">No groups yet.</li>}
        </ul>
        <form action={createGroup.bind(null, orgSlug)} className="flex items-center gap-2">
          <input name="name" required placeholder="Group name" className={`${inputCls} w-56`} />
          <button className={btnCls}>Create group</button>
        </form>
      </section>

      <section className="mt-8 border-t border-gray-100 pt-6">
        <h2 className="mb-3 text-lg font-medium">Matchmaker assignments</h2>
        <p className="mb-3 text-xs text-gray-400">
          A matchmaker only sees matches for the singles (individually, or via a group) they're
          assigned to here.
        </p>
        <ul className="mb-4 space-y-1 text-sm text-gray-700">
          {(assignments ?? []).map((a) => (
            <li key={a.id} className="flex items-center justify-between rounded border border-gray-100 bg-white px-3 py-2">
              <span>
                {nameOf(a.matchmaker_id)} →{' '}
                {a.target_type === 'group' ? groupName(a.target_group_id!) : nameOf(a.target_user_id!)}
                <span className="ml-1 text-xs uppercase text-gray-400">({a.target_type})</span>
              </span>
              <form action={removeAssignment.bind(null, orgSlug, a.id)}>
                <button className="text-xs text-red-600 hover:underline">Remove</button>
              </form>
            </li>
          ))}
          {(assignments ?? []).length === 0 && <li className="text-gray-400">No assignments yet.</li>}
        </ul>
        <form action={assignMatchmaker.bind(null, orgSlug)} className="flex flex-wrap items-center gap-2">
          <input
            name="matchmakerEmail"
            type="email"
            required
            placeholder="matchmaker@email"
            className={`${inputCls} w-48`}
          />
          <select name="targetType" required className={inputCls} defaultValue="individual">
            <option value="individual">Individual single</option>
            <option value="group">Group</option>
          </select>
          <input name="targetEmail" type="email" placeholder="single@email (if individual)" className={`${inputCls} w-56`} />
          <select name="targetGroupId" className={inputCls} defaultValue="">
            <option value="">— pick a group (if group) —</option>
            {(groups ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <button className={btnCls}>Assign</button>
        </form>
      </section>
    </div>
  )
}
