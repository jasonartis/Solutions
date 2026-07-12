import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireOrgModule } from '@/lib/module-gate'
import {
  blockUser,
  fileReport,
  markInterest,
  registerForEvent,
  revealMatches,
  reviewReport,
  runPairingRound,
  saveNote,
  saveProfileCard,
  setEventState,
  withdrawFromEvent,
} from '../../actions'

const btnCls = 'rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700'
const linkBtn = 'text-xs text-blue-600 hover:underline'

// Event page — role-adaptive. Organizer: lifecycle controls + pairing-round
// stand-in + reveal. Staff (organizer OR host): roster + report triage.
// Participant: register/withdraw, met partners (interest marks, private
// notes, safety reports, personal blocks), revealed matches.
export default async function EventPage(props: {
  params: Promise<{ orgSlug: string; eventId: string }>
}) {
  const { orgSlug, eventId } = await props.params
  const { supabase, org } = await requireOrgModule(orgSlug, 'speed-dating')

  const { data: event } = await supabase
    .from('sd_events')
    .select('id, name, state, scheduled_at, resume_review_enabled')
    .eq('id', eventId)
    .maybeSingle()
  if (!event) notFound()

  const [{ data: canOrganize }, { data: canStaffEvent }, { data: me }] = await Promise.all([
    supabase.rpc('sd_can_organize', { check_org_id: org.id }),
    // Broader than canOrganize: also covers a pure 'host' role — lobby/rooms
    // duty without event-setup rights (sd_can_staff_event in the schema).
    supabase.rpc('sd_can_staff_event', { check_org_id: org.id }),
    supabase.auth.getUser().then(({ data }) => ({ data: data.user })),
  ])

  // RLS scopes each of these to what the caller may see: staff gets the full
  // roster/pairings/reports; a participant gets their own seat + partners +
  // their own notes/reports.
  const [
    { data: participants },
    { data: pairings },
    { data: interests },
    { data: matches },
    { data: profiles },
    { data: rounds },
    { data: reports },
    { data: myNotes },
  ] = await Promise.all([
    supabase.from('sd_participants').select('id, user_id, status, seat_type, checked_in, profile_card').eq('event_id', eventId),
    supabase.from('sd_pairings').select('id, round_id, participant_a_id, participant_b_id').eq('event_id', eventId),
    supabase.from('sd_interest').select('rater_participant_id, target_participant_id, verdict').eq('event_id', eventId),
    supabase.from('sd_matches').select('participant_a_id, participant_b_id, revealed').eq('event_id', eventId),
    supabase.from('profiles').select('user_id, display_name, email'),
    supabase.from('sd_rounds').select('id, state').eq('event_id', eventId),
    supabase
      .from('sd_reports')
      .select('id, reporter_participant_id, reported_participant_id, reason, detail, state, created_at')
      .eq('event_id', eventId)
      .order('created_at', { ascending: false }),
    me
      ? supabase.from('sd_notes').select('about_user_id, body').eq('event_id', eventId).eq('author_user_id', me.id)
      : Promise.resolve({ data: null }),
  ])

  const mySeat = (participants ?? []).find((p) => p.user_id === me?.id)
  const seatName = (participantId: string | null) => {
    if (!participantId) return 'Someone'
    const seat = (participants ?? []).find((p) => p.id === participantId)
    if (!seat) return 'Someone' // seat not visible to this caller (RLS)
    const prof = (profiles ?? []).find((pr) => pr.user_id === seat.user_id)
    return prof?.display_name || prof?.email || 'Someone'
  }
  const noteFor = (userId: string) => (myNotes ?? []).find((n) => n.about_user_id === userId)?.body ?? ''
  const openReportCount = (reports ?? []).filter((r) => r.state === 'open').length
  const profileCardFor = (participantId: string) =>
    (participants ?? []).find((p) => p.id === participantId)?.profile_card ?? ''

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
          <p className="text-xs text-gray-400">
            Rounds run: {(rounds ?? []).length} · Matches: {(matches ?? []).filter((m) => m.revealed).length} revealed / {(matches ?? []).length} total
          </p>
        </section>
      )}

      {/* Staff tier: organizer OR host (lobby/rooms duty, no event-setup
          rights) — roster + safety-report triage. */}
      {canStaffEvent && (
        <section className="mb-8 rounded-lg border border-gray-200 bg-white p-5">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">
            Roster & reports
          </h2>
          <h3 className="mb-1 text-xs uppercase tracking-wide text-gray-400">
            Roster ({(participants ?? []).filter((p) => p.status === 'registered').length} registered)
          </h3>
          <ul className="mb-4 space-y-0.5 text-sm text-gray-700">
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

          <h3 className="mb-1 text-xs uppercase tracking-wide text-gray-400">
            Safety reports ({openReportCount} open)
          </h3>
          <ul className="space-y-2 text-sm">
            {(reports ?? []).map((r) => (
              <li key={r.id} className="rounded border border-gray-200 p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-gray-700">
                    {seatName(r.reporter_participant_id)} reported {seatName(r.reported_participant_id)}
                  </span>
                  <span className="text-gray-500">
                    {r.reason}
                    {r.detail ? ` — ${r.detail}` : ''}
                  </span>
                  <span
                    className={
                      r.state === 'open'
                        ? 'text-amber-600'
                        : r.state === 'actioned'
                          ? 'text-red-600'
                          : 'text-gray-400'
                    }
                  >
                    {r.state}
                  </span>
                </div>
                {r.state !== 'actioned' && r.state !== 'dismissed' && (
                  <div className="mt-1 flex gap-2">
                    <form action={reviewReport.bind(null, orgSlug, eventId, r.id, 'reviewed')}>
                      <button className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50">
                        Mark reviewed
                      </button>
                    </form>
                    <form action={reviewReport.bind(null, orgSlug, eventId, r.id, 'actioned')}>
                      <button className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50">
                        Mark actioned
                      </button>
                    </form>
                    <form action={reviewReport.bind(null, orgSlug, eventId, r.id, 'dismissed')}>
                      <button className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50">
                        Dismiss
                      </button>
                    </form>
                  </div>
                )}
              </li>
            ))}
            {(reports ?? []).length === 0 && <li className="text-gray-400">No reports for this event.</li>}
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
            {event.resume_review_enabled && (
              <form
                action={saveProfileCard.bind(null, orgSlug, eventId, mySeat.id)}
                className="mt-3 flex items-center gap-2 border-t border-gray-100 pt-3"
              >
                <label className="text-xs uppercase tracking-wide text-gray-500">My profile card</label>
                <input
                  name="profileCard"
                  defaultValue={mySeat.profile_card ?? ''}
                  placeholder="A short line about you — shown to people you're paired with"
                  className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
                />
                <button className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50">
                  Save
                </button>
              </form>
            )}
          </section>

          {metSeatIds.size > 0 && (
            <section className="rounded-lg border border-gray-200 bg-white p-5">
              <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">
                People you met
              </h2>
              <ul className="space-y-3">
                {[...metSeatIds].map((seatId) => {
                  const mark = myMarks.get(seatId)
                  const otherUserId = (participants ?? []).find((p) => p.id === seatId)?.user_id
                  const card = event.resume_review_enabled ? profileCardFor(seatId) : ''
                  return (
                    <li key={seatId} className="border-b border-gray-100 pb-3 last:border-0 last:pb-0">
                      <div className="flex items-center justify-between text-sm">
                        <span>
                          {seatName(seatId)}
                          {card && <span className="ml-2 text-xs italic text-gray-500">&quot;{card}&quot;</span>}
                        </span>
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
                      </div>

                      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                        {otherUserId && (
                          <details>
                            <summary className={`cursor-pointer ${linkBtn}`}>Private note</summary>
                            <form
                              action={saveNote.bind(null, orgSlug, eventId, otherUserId)}
                              className="mt-1 flex items-center gap-2"
                            >
                              <textarea
                                name="body"
                                defaultValue={noteFor(otherUserId)}
                                placeholder="Only you can see this…"
                                rows={2}
                                className="w-56 rounded border border-gray-300 px-2 py-1 text-xs"
                              />
                              <button className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50">
                                Save
                              </button>
                            </form>
                          </details>
                        )}

                        <details>
                          <summary className={`cursor-pointer ${linkBtn}`}>Report</summary>
                          <form
                            action={fileReport.bind(null, orgSlug, eventId, mySeat.id, seatId)}
                            className="mt-1 flex flex-col gap-1"
                          >
                            <select name="reason" required className="rounded border border-gray-300 px-2 py-1 text-xs">
                              <option value="">Reason…</option>
                              <option value="inappropriate">Inappropriate behavior</option>
                              <option value="harassment">Harassment</option>
                              <option value="unsafe">Felt unsafe</option>
                              <option value="other">Other</option>
                            </select>
                            <input
                              name="detail"
                              placeholder="Details (optional)"
                              className="rounded border border-gray-300 px-2 py-1 text-xs"
                            />
                            <button className="w-fit rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50">
                              Submit report
                            </button>
                          </form>
                        </details>

                        {otherUserId && (
                          <form action={blockUser.bind(null, orgSlug, otherUserId)}>
                            <button className="text-xs text-red-600 hover:underline">
                              Never pair me with them again
                            </button>
                          </form>
                        )}
                      </div>
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
