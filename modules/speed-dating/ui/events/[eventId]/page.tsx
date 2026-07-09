import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireOrgModule } from '@/lib/module-gate'
import {
  markInterest,
  registerForEvent,
  revealMatches,
  runPairingRound,
  setEventState,
  withdrawFromEvent,
} from '../../actions'

const btnCls = 'rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700'
const linkBtn = 'text-xs text-blue-600 hover:underline'

// Event page — role-adaptive. Organizer: lifecycle controls, roster, the
// pairing-round stand-in, reveal. Participant: register/withdraw, met
// partners with interest marking, revealed matches.
export default async function EventPage(props: {
  params: Promise<{ orgSlug: string; eventId: string }>
}) {
  const { orgSlug, eventId } = await props.params
  const { supabase, org } = await requireOrgModule(orgSlug, 'speed-dating')

  const { data: event } = await supabase
    .from('sd_events')
    .select('id, name, state, scheduled_at')
    .eq('id', eventId)
    .maybeSingle()
  if (!event) notFound()

  const [{ data: canOrganize }, { data: me }] = await Promise.all([
    supabase.rpc('sd_can_organize', { check_org_id: org.id }),
    supabase.auth.getUser().then(({ data }) => ({ data: data.user })),
  ])

  // RLS scopes each of these to what the caller may see: an organizer gets the
  // full roster/pairings; a participant gets their own seat + scheduled partners.
  const [{ data: participants }, { data: pairings }, { data: interests }, { data: matches }, { data: profiles }] =
    await Promise.all([
      supabase.from('sd_participants').select('id, user_id, status, seat_type, checked_in').eq('event_id', eventId),
      supabase.from('sd_pairings').select('id, round_id, participant_a_id, participant_b_id').eq('event_id', eventId),
      supabase.from('sd_interest').select('rater_participant_id, target_participant_id, verdict').eq('event_id', eventId),
      supabase.from('sd_matches').select('participant_a_id, participant_b_id, revealed').eq('event_id', eventId),
      supabase.from('profiles').select('user_id, display_name, email'),
    ])

  const mySeat = (participants ?? []).find((p) => p.user_id === me?.id)
  const seatName = (participantId: string) => {
    const seat = (participants ?? []).find((p) => p.id === participantId)
    if (!seat) return 'Someone' // seat not visible to this caller (RLS)
    const prof = (profiles ?? []).find((pr) => pr.user_id === seat.user_id)
    return prof?.display_name || prof?.email || 'Someone'
  }

  // Everyone this caller's seat has met (their pairings; RLS already filters).
  const metSeatIds = new Set<string>()
  if (mySeat) {
    for (const p of pairings ?? []) {
      if (p.participant_a_id === mySeat.id && p.participant_b_id) metSeatIds.add(p.participant_b_id)
      if (p.participant_b_id === mySeat.id) metSeatIds.add(p.participant_a_id)
    }
  }
  const myMarks = new Map(
    (interests ?? [])
      .filter((i) => i.rater_participant_id === mySeat?.id)
      .map((i) => [i.target_participant_id, i.verdict]),
  )

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <div className="mb-2 flex items-baseline gap-4">
        <h1 className="text-2xl font-semibold">{event.name}</h1>
        <Link href={`/o/${orgSlug}/m/speed-dating`} className="text-sm text-blue-600 hover:underline">
          ← Events
        </Link>
      </div>
      <p className="mb-6 text-sm uppercase tracking-wide text-gray-400">{event.state}</p>

      {canOrganize && (
        <section className="mb-8 rounded-lg border border-gray-200 bg-white p-5">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">Organizer console</h2>
          <div className="mb-4 flex flex-wrap gap-3">
            {event.state === 'draft' && (
              <form action={setEventState.bind(null, orgSlug, eventId, 'open')}>
                <button className={btnCls}>Open registration</button>
              </form>
            )}
            {event.state === 'open' && (
              <form action={setEventState.bind(null, orgSlug, eventId, 'running')}>
                <button className={btnCls}>Start event</button>
              </form>
            )}
            {event.state === 'running' && (
              <>
                <form action={runPairingRound.bind(null, orgSlug, eventId)}>
                  {/* Orchestrator stand-in until the worker is deployed. */}
                  <button className={btnCls}>Run next round (pair everyone)</button>
                </form>
                <form action={setEventState.bind(null, orgSlug, eventId, 'complete')}>
                  <button className={btnCls}>Complete event</button>
                </form>
              </>
            )}
            {event.state === 'complete' && (
              <form action={revealMatches.bind(null, orgSlug, eventId)}>
                <button className={btnCls}>Reveal mutual matches</button>
              </form>
            )}
          </div>
          <p className="mb-3 text-xs text-gray-400">
            Matches: {(matches ?? []).filter((m) => m.revealed).length} revealed / {(matches ?? []).length} total
          </p>
          <h3 className="mb-1 text-xs uppercase tracking-wide text-gray-400">
            Roster ({(participants ?? []).filter((p) => p.status === 'registered').length} registered)
          </h3>
          <ul className="space-y-0.5 text-sm text-gray-700">
            {(participants ?? []).map((p) => (
              <li key={p.id}>
                {seatName(p.id)}{' '}
                <span className="text-xs uppercase text-gray-400">
                  {p.status}
                  {p.seat_type !== 'participant' ? ` · ${p.seat_type}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!mySeat && !canOrganize && event.state === 'open' && (
        <form action={registerForEvent.bind(null, orgSlug, eventId)}>
          <button className={btnCls}>Register for this event</button>
        </form>
      )}

      {mySeat && (
        <div className="space-y-6">
          <section className="rounded-lg border border-gray-200 bg-white p-5">
            <div className="flex items-center justify-between">
              <p className="text-sm">
                You are <span className="font-medium">{mySeat.status}</span>.
              </p>
              {mySeat.status === 'registered' && event.state === 'open' && (
                <form action={withdrawFromEvent.bind(null, orgSlug, mySeat.id, eventId)}>
                  <button className="text-sm text-red-600 hover:underline">Withdraw</button>
                </form>
              )}
            </div>
          </section>

          {metSeatIds.size > 0 && (
            <section className="rounded-lg border border-gray-200 bg-white p-5">
              <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">
                People you met
              </h2>
              <ul className="space-y-2">
                {[...metSeatIds].map((seatId) => {
                  const mark = myMarks.get(seatId)
                  return (
                    <li key={seatId} className="flex items-center justify-between text-sm">
                      <span>{seatName(seatId)}</span>
                      <span className="flex gap-2">
                        {(['interested', 'not_interested', 'no_show'] as const).map((v) => (
                          <form key={v} action={markInterest.bind(null, orgSlug, eventId, mySeat.id, seatId, v)}>
                            <button
                              className={
                                mark === v
                                  ? 'rounded bg-blue-600 px-2 py-0.5 text-xs text-white'
                                  : `${linkBtn} rounded border border-gray-200 px-2 py-0.5`
                              }
                            >
                              {v.replace('_', ' ')}
                            </button>
                          </form>
                        ))}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}

          {(matches ?? []).filter((m) => m.revealed).length > 0 && (
            <section className="rounded-lg border border-green-200 bg-green-50 p-5">
              <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-green-700">
                It&apos;s a match!
              </h2>
              <ul className="space-y-1 text-sm">
                {(matches ?? [])
                  .filter((m) => m.revealed)
                  .map((m, i) => {
                    const other = m.participant_a_id === mySeat.id ? m.participant_b_id : m.participant_a_id
                    return <li key={i}>{seatName(other)} is interested too.</li>
                  })}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
