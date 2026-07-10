import Link from 'next/link'
import { requireOrgModule } from '@/lib/module-gate'
import { saveAnswer } from './actions'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'
const btnCls = 'rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700'

type Question = {
  id: string
  text: string
  scale_labels: string[]
  admin_locks: { answer?: number; care?: number; dealbreaker?: boolean }
}
type AnswerRow = {
  question_id: string
  position: number
  care: number
  dealbreaker: boolean
  share_with_match: boolean
  auto: boolean
}

// Module 1 (Make-a-Match) landing — role-adaptive:
//  single      → answer questions + see own top matches
//  matchmaker  → see matches for the singles they're assigned to
//  admin/staff → link to the Manage console (approval queue, recompute)
export default async function MatchmakingPage(props: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await props.params
  const { supabase, org, settings } = await requireOrgModule(orgSlug, 'matchmaking')
  const topX = (settings.topX as number) ?? 5

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const [{ data: canManage }, { data: isMatchmaker }, { data: isSingle }] = await Promise.all([
    supabase.rpc('mm_can_manage', { check_org_id: org.id }),
    supabase.rpc('mm_is_matchmaker', { check_org_id: org.id }),
    supabase.rpc('mm_is_single', { check_org_id: org.id }),
  ])

  // Everyone who shares the org can read display names (shares_org_with policy).
  const { data: profiles } = await supabase.from('profiles').select('user_id, display_name, email')
  const nameOf = (id: string) => {
    const p = (profiles ?? []).find((pr) => pr.user_id === id)
    return p?.display_name || p?.email || id.slice(0, 8)
  }

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <div className="mb-6 flex items-baseline gap-4">
        <h1 className="text-2xl font-semibold">Make-a-Match</h1>
        {canManage && (
          <Link href={`/o/${orgSlug}/m/matchmaking/manage`} className="text-sm text-blue-600 hover:underline">
            Manage
          </Link>
        )}
      </div>

      {isSingle && <SingleView orgSlug={orgSlug} orgId={org.id} userId={user!.id} topX={topX} />}
      {isMatchmaker && !isSingle && <MatchmakerView topX={topX} nameOf={nameOf} orgId={org.id} />}
      {!isSingle && !isMatchmaker && !canManage && (
        <p className="text-gray-500">You don&apos;t have a matchmaking role in this organization yet.</p>
      )}
      {canManage && !isSingle && !isMatchmaker && (
        <p className="text-gray-500">
          You administer this module. Use{' '}
          <Link href={`/o/${orgSlug}/m/matchmaking/manage`} className="text-blue-600 hover:underline">
            Manage
          </Link>{' '}
          to review questions and recompute matches.
        </p>
      )}
    </div>
  )
}

async function SingleView(props: { orgSlug: string; orgId: string; userId: string; topX: number }) {
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()

  // Approved questions this single can see.
  const { data: questions } = await supabase
    .from('mm_questions')
    .select('id, text, scale_labels, admin_locks')
    .eq('org_id', props.orgId)
    .eq('status', 'approved')
    .order('created_at')

  // Lazily materialize an answer row per question (idempotent RPC), then read
  // them all back. A missing row is the not-yet-seen state (see schema notes).
  for (const q of questions ?? []) {
    await supabase.rpc('mm_ensure_answer', { check_question_id: q.id })
  }
  const { data: answers } = await supabase
    .from('mm_answers')
    .select('question_id, position, care, dealbreaker, share_with_match, auto')
    .eq('user_id', props.userId)
  const answerByQ = new Map((answers ?? []).map((a) => [a.question_id, a as AnswerRow]))

  // Own matches: RLS already hides excluded pairs and rows I'm not in.
  const { data: scores } = await supabase
    .from('mm_pair_scores')
    .select('user_a, user_b, percent, stale')
    .or(`user_a.eq.${props.userId},user_b.eq.${props.userId}`)
    .order('percent', { ascending: false })
    .limit(props.topX)
  const { data: profiles } = await supabase.from('profiles').select('user_id, display_name, email')
  const nameOf = (id: string) => {
    const p = (profiles ?? []).find((pr) => pr.user_id === id)
    return p?.display_name || p?.email || id.slice(0, 8)
  }

  // What each match chose to share with me (the mm_shared_answers definer
  // function reveals ONLY share-flagged answers, ONLY between real matches).
  type SharedAnswer = { question_text: string; scale_labels: string[]; answer_position: number }
  const sharedByUser = new Map<string, SharedAnswer[]>()
  for (const s of scores ?? []) {
    const other = s.user_a === props.userId ? s.user_b : s.user_a
    const { data: shared } = await supabase.rpc('mm_shared_answers', { check_other_user: other })
    if (shared && shared.length > 0) sharedByUser.set(other, shared as SharedAnswer[])
  }

  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-3 text-lg font-medium">Your matches</h2>
        {(scores ?? []).length === 0 ? (
          <p className="text-sm text-gray-500">
            No matches computed yet — answer questions below, then an admin recomputes.
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {(scores ?? []).map((s, i) => {
              const other = s.user_a === props.userId ? s.user_b : s.user_a
              const shared = sharedByUser.get(other)
              return (
                <li key={i} className="rounded border border-gray-100 bg-white px-3 py-2">
                  <div className="flex items-center justify-between">
                    <span>{nameOf(other)}</span>
                    <span className="flex items-center gap-2">
                      <span className="font-semibold">{s.percent}%</span>
                      {s.stale && <span className="text-xs text-amber-600">(recompute pending)</span>}
                    </span>
                  </div>
                  {shared && (
                    <ul className="mt-1 space-y-0.5 text-xs text-gray-500">
                      {shared.map((a, j) => (
                        <li key={j}>
                          {a.question_text}: <span className="text-gray-700">{a.scale_labels[a.answer_position] ?? '—'}</span>
                          <span className="ml-1 text-gray-300">(shared with you)</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Your answers</h2>
        <div className="space-y-4">
          {(questions ?? []).map((q) => (
            <QuestionForm
              key={q.id}
              orgSlug={props.orgSlug}
              question={q as Question}
              answer={answerByQ.get(q.id)}
            />
          ))}
        </div>
      </section>
    </div>
  )
}

function QuestionForm(props: { orgSlug: string; question: Question; answer?: AnswerRow }) {
  const { question, answer } = props
  const locks = question.admin_locks ?? {}
  const pos = answer?.position ?? Math.floor((question.scale_labels.length - 1) / 2)
  const care = answer?.care ?? 0
  const isAuto = answer?.auto ?? true

  return (
    <form
      action={saveAnswer.bind(null, props.orgSlug, question.id)}
      className="rounded-lg border border-gray-200 bg-white p-4"
    >
      <div className="mb-2 flex items-baseline justify-between">
        <span className="font-medium">{question.text}</span>
        {isAuto && <span className="text-xs text-gray-400">not yet answered (default)</span>}
      </div>

      <div className="mb-3">
        <div className="mb-1 text-xs uppercase tracking-wide text-gray-500">Your answer</div>
        <div className="flex flex-wrap gap-3 text-sm">
          {question.scale_labels.map((label, idx) => (
            <label key={idx} className="flex items-center gap-1">
              <input
                type="radio"
                name="position"
                value={idx}
                defaultChecked={pos === idx}
                disabled={locks.answer !== undefined}
              />
              {label}
            </label>
          ))}
        </div>
        {locks.answer !== undefined && (
          <p className="mt-1 text-xs text-gray-400">Locked by admin.</p>
        )}
      </div>

      <div className="mb-3">
        <div className="mb-1 text-xs uppercase tracking-wide text-gray-500">
          How much you care that a match matches you (−10 opposite · 0 don&apos;t care · +10 same)
        </div>
        <input
          type="range"
          name="care"
          min={-10}
          max={10}
          defaultValue={care}
          disabled={locks.care !== undefined}
          className="w-full"
        />
        {locks.care !== undefined && <p className="mt-1 text-xs text-gray-400">Locked by admin.</p>}
      </div>

      <div className="mb-3 flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            name="dealbreaker"
            defaultChecked={answer?.dealbreaker ?? false}
            disabled={locks.dealbreaker !== undefined}
          />
          Dealbreaker (hard filter)
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" name="share" defaultChecked={answer?.share_with_match ?? false} />
          Share this answer with a potential match
        </label>
      </div>

      <button className={btnCls}>Save</button>
    </form>
  )
}

async function MatchmakerView(props: {
  topX: number
  nameOf: (id: string) => string
  orgId: string
}) {
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()

  // RLS shows a matchmaker only the pairs involving singles they're assigned to.
  const { data: scores } = await supabase
    .from('mm_pair_scores')
    .select('user_a, user_b, percent')
    .eq('org_id', props.orgId)
    .order('percent', { ascending: false })

  return (
    <section>
      <h2 className="mb-3 text-lg font-medium">Matches for your assigned singles</h2>
      {(scores ?? []).length === 0 ? (
        <p className="text-sm text-gray-500">No matches to show yet.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {(scores ?? []).map((s, i) => (
            <li key={i} className="flex items-center justify-between rounded border border-gray-100 bg-white px-3 py-2">
              <span>
                {props.nameOf(s.user_a)} &harr; {props.nameOf(s.user_b)}
              </span>
              <span className="font-semibold">{s.percent}%</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
