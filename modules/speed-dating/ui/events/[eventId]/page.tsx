import Link from 'next/link'
import { FORMER_MEMBER_LABEL, loadFormerMembers } from '@platform/core'
import { requireOrgModule } from '@/lib/module-gate'
import {
  blockUser,
  fileReport,
  allowRegisterAgain,
  checkInParticipant,
  checkInSelf,
  markEveryoneArrived,
  deleteEvent,
  markInterest,
  promoteNextWaitlisted,
  registerForEvent,
  rejoinEvent,
  revealMatches,
  reviewReport,
  runPairingRound,
  saveNote,
  saveProfileCard,
  setEventState,
  withdrawFromEvent,
} from '../../actions'
import { getCheckInMode, getEventSides, type SideKey } from '../../event-format'
import { selfCheckInOpen } from '../../event-plan'
import LiveRoundRefresh from './live-round-refresh'
import VideoRoom from './video-room'
import { SubmitButton } from '../../submit-button'

// Exact, because the organizer fixed the number of rounds: the event ends when the LAST planned round
// does, i.e. the current round's end plus one (break + round) per round still to come.
function describeTimeLeft(ms: number): string {
  const minutes = Math.ceil(Math.max(0, ms) / 60000)
  return minutes <= 1 ? 'about 1 min left' : `about ${minutes} min left`
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `${mm}:${String(ss).padStart(2, '0')}`
}

const btnCls = 'rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700'
const linkBtn = 'px-1 py-1.5 text-xs text-blue-600 hover:underline'
const secondaryBtn = 'rounded border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50'

// Event page — role-adaptive. Organizer: lifecycle controls + pairing-round
// stand-in + reveal. Staff (organizer OR host): roster + report triage.
// Participant: register/withdraw, met partners (interest marks, private
// notes, safety reports, personal blocks), revealed matches.
export default async function EventPage(props: {
  params: Promise<{ orgSlug: string; eventId: string }>
  searchParams?: Promise<{ notice?: string }>
}) {
  const { orgSlug, eventId } = await props.params
  const notice = (await props.searchParams)?.notice
  const { supabase, org } = await requireOrgModule(orgSlug, 'speed-dating')

  const { data: event } = await supabase
    .from('sd_events')
    .select('id, org_id, name, state, scheduled_at, resume_review_enabled, round_duration_seconds, break_duration_seconds, allow_repeat_pairings, rounds_planned, lobby_opens_at, format')
    .eq('id', eventId)
    .maybeSingle()
  if (!event) {
    // RLS hides a DRAFT (and a deleted event) from anyone without a seat, so a dater who had the page open
    // when the organizer moved the event back to draft used to get a bare 404. One friendly panel with the
    // SAME text for "back to draft", "deleted" and "never existed" — so the page is not an oracle for which
    // it is. (Fix requested by the closed-state session, solutions-platform-b3, 2026-10-29.)
    return (
      <div>
        <p className="mb-1 text-sm text-gray-400">{org.name}</p>
        <section className="rounded-lg border border-gray-200 bg-white p-5" data-testid="event-unavailable">
          <h1 className="mb-2 text-lg font-semibold">This event isn&apos;t available right now</h1>
          <p className="text-sm text-gray-600">
            The organizer may have moved it back to draft or removed it. Check the events list for what is open.
          </p>
          <Link href={`/o/${orgSlug}/m/speed-dating`} className="mt-3 inline-block text-sm text-blue-600 hover:underline">
            ← Back to events
          </Link>
        </section>
      </div>
    )
  }
  const sides = getEventSides(event.format)
  const checkInMode = getCheckInMode(event.format)

  const [{ data: canOrganize }, { data: canStaffEvent }, { data: canManage }, { data: me }] = await Promise.all([
    supabase.rpc('sd_can_organize', { check_org_id: org.id }),
    // Broader than canOrganize: also covers a pure 'host' role — lobby/rooms
    // duty without event-setup rights (sd_can_staff_event in the schema).
    supabase.rpc('sd_can_staff_event', { check_org_id: org.id }),
    // sd_blocks is readable by the blocker and the manage tier only (RLS), so the
    // excluded-pairs count below is shown only to a caller who can really see it.
    supabase.rpc('sd_can_manage', { check_org_id: org.id }),
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
    supabase.from('sd_participants').select('id, user_id, status, seat_type, checked_in, profile_card, pool_side').eq('event_id', eventId),
    supabase.from('sd_pairings').select('id, round_id, participant_a_id, participant_b_id').eq('event_id', eventId),
    supabase.from('sd_interest').select('rater_participant_id, target_participant_id, verdict').eq('event_id', eventId),
    supabase
      .from('sd_matches')
      .select('id, participant_a_id, participant_b_id, revealed, contact_shared')
      .eq('event_id', eventId),
    supabase.from('profiles').select('user_id, display_name'),
    supabase.from('sd_rounds').select('id, round_number, state, ends_at').eq('event_id', eventId),
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
  // Check-in (founder 2026-10-28): where an event uses it, only ARRIVED people are paired. What staff see.
  const registeredSeats = (participants ?? []).filter((p) => p.status === 'registered' && p.seat_type === 'participant')
  const arrivedCount = registeredSeats.filter((p) => p.checked_in).length

  // How many pairings personal blocks are keeping out of this event. A NUMBER
  // ONLY — never who blocked whom (founder-approved 2026-10-21). Counts unordered
  // pairs of registered participants where either has blocked the other; with two
  // sides only cross-side pairs could ever have met, so only those count.
  let blockedPairCount: number | null = null
  if (canOrganize && canManage) {
    const seated = (participants ?? []).filter((p) => p.status === 'registered' && p.seat_type === 'participant')
    const seatedUsers = seated.map((p) => p.user_id)
    const { data: blockRows } = seatedUsers.length
      ? await supabase
          .from('sd_blocks')
          .select('blocker_user_id, blocked_user_id')
          .eq('org_id', event.org_id)
          .in('blocker_user_id', seatedUsers)
      : { data: [] }
    const sideOf = new Map(seated.map((p) => [p.user_id, p.pool_side ?? '']))
    const bipartite = new Set(seated.map((p) => p.pool_side ?? '')).size === 2
    const pairKeys = new Set<string>()
    for (const b of blockRows ?? []) {
      if (!sideOf.has(b.blocked_user_id)) continue
      if (bipartite && sideOf.get(b.blocker_user_id) === sideOf.get(b.blocked_user_id)) continue
      pairKeys.add([b.blocker_user_id, b.blocked_user_id].sort().join('|'))
    }
    blockedPairCount = pairKeys.size
  }
  const canDeleteEvent =
    !!canOrganize &&
    (rounds ?? []).length === 0 &&
    !(participants ?? []).some((p) => p.status === 'registered' || p.status === 'waitlisted')
  // Same rule the database enforces (sd_guard_event): back to draft only while
  // nobody holds a live seat and no round has run. The guard is the gate; this
  // only decides whether to offer the button.
  const canReturnToDraft = canDeleteEvent && (event.state === 'open' || event.state === 'closed')
  // docs/21 §7.5/§7.7: a deleted account renders as a former member, and a
  // revealed match whose counterparty has left (grace period or deleted) moves
  // to an archive with that reason. sd_my_departed_matches applies §7.8's
  // rule — it only ever returns MUTUAL, revealed matches, so a person this
  // viewer declined (or who declined them) is never reported as having left.
  // sd_my_departed_interests (20261009010000) adds the people this viewer said
  // YES to with no match — whether the other said no or never decided, which
  // it reports identically — once their deletion has COMPLETED and the event
  // is complete. Only a count is shown: the silhouette has no name.
  const [formerIds, { data: departedMatchRows }, { data: departedInterestRows }] = await Promise.all([
    loadFormerMembers(supabase, (participants ?? []).map((p) => p.user_id)),
    mySeat
      ? supabase.rpc('sd_my_departed_matches', { check_event_id: eventId })
      : Promise.resolve({ data: [] as string[] }),
    mySeat
      ? supabase.rpc('sd_my_departed_interests', { check_event_id: eventId })
      : Promise.resolve({ data: [] as string[] }),
  ])
  const departedMatchIds = new Set(((departedMatchRows as string[] | null) ?? []))
  const departedInterestCount = ((departedInterestRows as string[] | null) ?? []).length
  const seatName = (participantId: string | null) => {
    if (!participantId) return 'Someone'
    const seat = (participants ?? []).find((p) => p.id === participantId)
    if (!seat) return 'Someone' // seat not visible to this caller (RLS)
    if (formerIds.has(seat.user_id)) return FORMER_MEMBER_LABEL
    const prof = (profiles ?? []).find((pr) => pr.user_id === seat.user_id)
    return prof?.display_name || 'Someone'
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

  // Live round: the state machine guarantees at most one 'active' round per
  // event (the orchestrator's single-active-round guard). 'break' is in the
  // schema's CHECK but never actually written — the orchestrator keeps a
  // round 'active' through its break too, so the round-vs-break distinction
  // is computed here from ends_at + break_duration_seconds, not from state.
  const activeRound = (rounds ?? []).find((r) => r.state === 'active') ?? null
  const myCurrentPairing = activeRound
    ? (pairings ?? []).find(
        (p) =>
          p.round_id === activeRound.id &&
          (p.participant_a_id === mySeat?.id || p.participant_b_id === mySeat?.id),
      ) ?? null
    : null
  const myCurrentPartnerId = myCurrentPairing
    ? myCurrentPairing.participant_a_id === mySeat?.id
      ? myCurrentPairing.participant_b_id
      : myCurrentPairing.participant_a_id
    : undefined
  const now = new Date()
  const roundEndsAt = activeRound?.ends_at ? new Date(activeRound.ends_at) : null
  const breakEndsAt = roundEndsAt ? new Date(roundEndsAt.getTime() + event.break_duration_seconds * 1000) : null
  const onBreak = Boolean(roundEndsAt && now >= roundEndsAt)
  const lobbyOpen = event.lobby_opens_at ? now >= new Date(event.lobby_opens_at) : null
  // The last planned round: after it there is no "next round", only the organizer wrapping up.
  const isLastRound = event.rounds_planned !== null && activeRound !== null && activeRound.round_number >= event.rounds_planned
  const allRoundsRun = event.rounds_planned !== null && (rounds ?? []).length >= event.rounds_planned
  // Self check-in is only offered inside the lobby window (see selfCheckInOpen).
  const selfCheckInIsOpen = selfCheckInOpen({ state: event.state, scheduledAt: event.scheduled_at, lobbyOpensAt: event.lobby_opens_at })

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <div className="mb-2 flex items-baseline gap-4">
        <h1 className="text-2xl font-semibold">{event.name}</h1>
        <Link href={`/o/${orgSlug}/m/speed-dating`} className="text-sm text-blue-600 hover:underline">
          ← Events
        </Link>
      </div>
      <p className="mb-6 text-sm uppercase tracking-wide text-gray-400">
        {event.state === 'closed' ? 'registration closed' : event.state}
      </p>

      {notice === 'draft-refused' && (
        <p className="mb-6 rounded border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          The event was not moved back to draft: someone is registered or waiting (or a round has run). Close
          registration instead, or cancel the event.
        </p>
      )}
      {notice === 'state-refused' && (
        <p className="mb-6 rounded border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          That change was not made — the event may have moved on since this page loaded. Reload and try again.
        </p>
      )}

      {notice === 'rejoin-refused' && (
        <p className="mb-6 rounded border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          You could not be registered for this event — registration may be closed, or you are not eligible.
          Ask the organizer if you think this is a mistake.
        </p>
      )}
      {notice === 'checkin-needed' && (
        <p className="mb-6 rounded border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          No round was started: this event uses check-in and fewer than two people are checked in. Mark people as arrived
          in the roster below (or ask them to check in), then run the round.
        </p>
      )}
      {notice === 'checkin-not-open' && (
        <p className="mb-6 rounded border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          Check-in is not open yet. It opens about 15 minutes before the event starts, or when the organizer starts it.
        </p>
      )}
      {notice === 'checkin-refused' && (
        <p className="mb-6 rounded border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          That check-in could not be saved — only a registered person can be checked in, and only they or an organizer can do it.
        </p>
      )}
      {notice === 'edit-saved' && (
        <p className="mb-6 rounded border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-900">Event updated.</p>
      )}
      {notice === 'edit-locked' && (
        <p className="mb-6 rounded border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          This event can no longer be edited — it has started or ended.
        </p>
      )}
      {notice === 'register-closed' && (
        <p className="mb-6 rounded border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          Registration for this event is not open.
        </p>
      )}
      {notice === 'register-side' && (
        <p className="mb-6 rounded border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          Choose a side to register for, then try again.
        </p>
      )}

      {notice === 'rounds-cap-reached' && (
        <p className="mb-6 rounded border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          No new round was started: all {event.rounds_planned} planned rounds have run. Complete the event to continue.
        </p>
      )}
      {notice === 'rotation-complete' && (
        <p className="mb-6 rounded border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          No new round was started: everyone registered has already met everyone else. Complete the event
          (or register more people) to continue.
        </p>
      )}

      {(event.state === 'open' || event.state === 'closed') && lobbyOpen && (
        <p className="mb-6 rounded border border-blue-100 bg-blue-50 px-4 py-2 text-sm text-blue-700">
          The lobby is open{event.scheduled_at ? ` — the event starts at ${new Date(event.scheduled_at).toLocaleString()}` : ''}.
        </p>
      )}

      {canOrganize && (
        <section className="mb-8 rounded-lg border border-gray-200 bg-white p-5">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">Organizer console</h2>
          <div className="mb-4 flex flex-wrap gap-3">
            {(event.state === 'draft' || event.state === 'open' || event.state === 'closed') && (
              <Link href={`/o/${orgSlug}/m/speed-dating/events/${eventId}/edit`} className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50">
                Edit details
              </Link>
            )}
            {event.state === 'draft' && (
              <form action={setEventState.bind(null, orgSlug, eventId, 'open')}>
                <button className={btnCls}>Open registration</button>
              </form>
            )}
            {event.state === 'open' && (
              <form action={setEventState.bind(null, orgSlug, eventId, 'closed')}>
                <SubmitButton className={secondaryBtn} pendingLabel="Closing…">
                  Close registration
                </SubmitButton>
              </form>
            )}
            {event.state === 'closed' && (
              <form action={setEventState.bind(null, orgSlug, eventId, 'open')}>
                <SubmitButton className={secondaryBtn} pendingLabel="Reopening…">
                  Reopen registration
                </SubmitButton>
              </form>
            )}
            {canReturnToDraft && (
              <form action={setEventState.bind(null, orgSlug, eventId, 'draft')}>
                <SubmitButton className={secondaryBtn} pendingLabel="Moving…">
                  Back to draft
                </SubmitButton>
              </form>
            )}
            {(event.state === 'open' || event.state === 'closed') && (
              <form action={setEventState.bind(null, orgSlug, eventId, 'running')}>
                <button className={btnCls}>Start event</button>
              </form>
            )}
            {event.state === 'running' && (
              <>
                <form action={runPairingRound.bind(null, orgSlug, eventId)}>
                  {/* Orchestrator stand-in until the worker is deployed. */}
                  <SubmitButton className={btnCls} pendingLabel="Pairing…">
                    Run next round (pair everyone)
                  </SubmitButton>
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
            {['draft', 'open', 'closed', 'running'].includes(event.state) && (
              <form action={setEventState.bind(null, orgSlug, eventId, 'cancelled')}>
                <button className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50">
                  Cancel event
                </button>
              </form>
            )}
            {/* Delete is irreversible, so it is only OFFERED when nothing of
                consequence exists (no live registrations, no rounds); the
                action re-checks. Otherwise: cancel, which keeps the record. */}
            {canDeleteEvent && (
              <form action={deleteEvent.bind(null, orgSlug, eventId)}>
                <button className="rounded border border-red-300 px-3 py-1 text-sm text-red-700 hover:bg-red-50">
                  Delete event
                </button>
              </form>
            )}
          </div>
          {!canDeleteEvent && (
            <p className="mb-2 text-xs text-gray-400">
              Delete is only available for an event with no registrations and no rounds — cancel it instead.
            </p>
          )}
          {(event.state === 'open' || event.state === 'closed') && !canReturnToDraft && (
            <p className="mb-2 text-xs text-gray-400">
              Back to draft is only available while nobody is registered or waiting — close registration instead.
            </p>
          )}
          {event.state === 'closed' && (
            <p className="mb-2 text-xs text-gray-400">
              Registration is closed: nobody new can sign up, and people can still withdraw. Nobody is notified.
            </p>
          )}
          {event.state === 'running' && allRoundsRun && (
            <p className="mb-2 rounded border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-900" data-testid="all-rounds-run">
              All {event.rounds_planned} planned {event.rounds_planned === 1 ? 'round has' : 'rounds have'} run. When the last one is over,
              press <span className="font-medium">Complete event</span>, then <span className="font-medium">Reveal mutual matches</span>.
            </p>
          )}
          {checkInMode && (event.state === 'open' || event.state === 'closed' || event.state === 'running') && (
            <p className="mb-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="checkin-summary">
              Check-in is ON ({checkInMode === 'staff' ? 'you mark people as arrived' : 'people check themselves in'}): only people marked
              arrived are paired. {arrivedCount} of {registeredSeats.length} registered {arrivedCount === 1 ? 'is' : 'are'} checked in.
            </p>
          )}
          <p className="mb-2 text-xs text-gray-500">
            Rounds of {Math.round(event.round_duration_seconds / 60)} min with {event.break_duration_seconds}s breaks
            {event.rounds_planned !== null ? ` · ${event.rounds_planned} ${event.rounds_planned === 1 ? 'round' : 'rounds'} planned` : ''}
            {event.allow_repeat_pairings ? ' · people may meet more than once' : ''}.
            {blockedPairCount !== null && (
              <>
                {' '}
                {blockedPairCount === 0
                  ? 'No pairings are being skipped because of personal blocks.'
                  : `${blockedPairCount} ${blockedPairCount === 1 ? 'pairing is' : 'pairings are'} being skipped because of personal blocks — that is why someone may sit out a round.`}
              </>
            )}
          </p>
          <p className="text-xs text-gray-400">
            Rounds run: {(rounds ?? []).length} · Matches: {(matches ?? []).filter((m) => m.revealed).length} revealed / {(matches ?? []).length} total
            {activeRound && roundEndsAt && (
              <>
                {' '}
                · Round {activeRound.round_number} {onBreak && breakEndsAt ? `on break, next in ${formatCountdown(breakEndsAt.getTime() - now.getTime())}` : `ends in ${formatCountdown(roundEndsAt.getTime() - now.getTime())}`}
              </>
            )}
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
            Roster ({(participants ?? []).filter((p) => p.status === 'registered').length} registered{checkInMode ? `, ${arrivedCount} arrived` : ''})
          </h3>
          {canOrganize && checkInMode && registeredSeats.some((p) => !p.checked_in) && (
            <form action={markEveryoneArrived.bind(null, orgSlug, eventId)} className="mb-2">
              <SubmitButton className={linkBtn} pendingLabel="Marking…">
                Mark everyone arrived
              </SubmitButton>
            </form>
          )}
          <ul className="mb-4 space-y-0.5 text-sm text-gray-700">
            {(participants ?? []).map((p) => (
              <li key={p.id}>
                {seatName(p.id)}{' '}
                <span className="text-xs uppercase text-gray-400">
                  {p.status}
                  {p.seat_type !== 'participant' ? ` · ${p.seat_type}` : ''}
                  {sides && p.pool_side ? ` · ${sides[p.pool_side as SideKey]?.label ?? p.pool_side}` : ''}
                </span>
                {checkInMode && p.status === 'registered' && p.seat_type === 'participant' && (
                  <>
                    <span
                      className={`ml-2 rounded px-1.5 py-0.5 text-xs font-medium ${p.checked_in ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}
                    >
                      {p.checked_in ? 'arrived' : 'not arrived'}
                    </span>
                    {canOrganize && (
                      <form action={checkInParticipant.bind(null, orgSlug, eventId, p.id, !p.checked_in)} className="ml-2 inline">
                        <button className={linkBtn}>{p.checked_in ? 'Undo arrival' : 'Mark arrived'}</button>
                      </form>
                    )}
                  </>
                )}
                {/* Consent: an organizer never re-seats someone. A removal can be
                    CLEARED so the person may register again; they must do it. */}
                {canOrganize && p.status === 'removed' && (
                  <form action={allowRegisterAgain.bind(null, orgSlug, p.id, eventId)} className="ml-2 inline">
                    <button className={linkBtn}>Allow to register again</button>
                  </form>
                )}
              </li>
            ))}
          </ul>

          {sides && (
            <>
              <h3 className="mb-1 text-xs uppercase tracking-wide text-gray-400">Waitlist by side</h3>
              <ul className="mb-4 space-y-1 text-sm">
                {(['a', 'b'] as const).map((key) => {
                  const side = sides[key]
                  const registeredCount = (participants ?? []).filter((p) => p.pool_side === key && p.status === 'registered').length
                  const waitlistedCount = (participants ?? []).filter((p) => p.pool_side === key && p.status === 'waitlisted').length
                  return (
                    <li key={key} className="flex items-center justify-between">
                      <span>
                        {side.label}: {registeredCount}
                        {side.capacity !== null ? ` / ${side.capacity}` : ''} registered
                        {waitlistedCount > 0 ? `, ${waitlistedCount} waitlisted` : ''}
                      </span>
                      {/* Promotion needs organizer tier specifically — the pin
                          trigger only lets a plain host REMOVE someone else's
                          seat, not change their status to 'registered'. */}
                      {canOrganize && waitlistedCount > 0 && (
                        <form action={promoteNextWaitlisted.bind(null, orgSlug, eventId, key)}>
                          <button className={linkBtn}>Promote next waitlisted</button>
                        </form>
                      )}
                    </li>
                  )
                })}
              </ul>
            </>
          )}

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
        <form action={registerForEvent.bind(null, orgSlug, eventId)} className="flex flex-wrap items-center gap-2">
          {sides && (
            <label className="text-sm text-gray-600">
              I&apos;m registering as:{' '}
              <select name="side" required defaultValue="" className="rounded border border-gray-300 px-2 py-1 text-sm">
                <option value="" disabled>Choose…</option>
                <option value="a">{sides.a.label}</option>
                <option value="b">{sides.b.label}</option>
              </select>
            </label>
          )}
          <SubmitButton className={btnCls} pendingLabel="Registering…">
            Register for this event
          </SubmitButton>
        </form>
      )}
      {!mySeat && !canOrganize && event.state === 'closed' && (
        <p className="rounded border border-gray-200 bg-gray-50 px-4 py-2 text-sm text-gray-700">
          Registration is closed for this event.
        </p>
      )}

      {mySeat && (
        <div className="space-y-6">
          {/* Being registered is NOT being in the rounds: where check-in is used, an un-checked-in person is
              skipped. Loud on purpose — the failure is someone waiting for a round that will never include them. */}
          {checkInMode && mySeat.status === 'registered' && !mySeat.checked_in &&
            (event.state === 'open' || event.state === 'closed' || event.state === 'running') && (
              <section role="alert" data-testid="not-checked-in" className="rounded-lg border-2 border-amber-400 bg-amber-50 p-5">
                <p className="text-base font-semibold text-amber-900">You are NOT checked in yet.</p>
                <p className="mt-1 text-sm text-amber-900">
                  {event.state !== 'running' && 'That is normal before the event starts — but '}
                  {event.state === 'running' ? 'O' : 'o'}nly people who are checked in are paired in the rounds. If you do not
                  check in, you will sit the event out{event.state === 'running' ? ' — right now you are not in any round' : ''}.
                </p>
                {checkInMode === 'self' ? (
                  selfCheckInIsOpen ? (
                    <form action={checkInSelf.bind(null, orgSlug, eventId, mySeat.id)} className="mt-3">
                      <SubmitButton className={btnCls} pendingLabel="Checking in…">
                        I&apos;m here — check me in
                      </SubmitButton>
                    </form>
                  ) : (
                    <p className="mt-2 text-sm font-medium text-amber-900">
                      Check-in opens about 15 minutes before the event starts (or when the organizer starts it). When it opens,
                      come back to this page and tap &quot;I&apos;m here&quot;.
                    </p>
                  )
                ) : (
                  <p className="mt-2 text-sm font-medium text-amber-900">
                    When you are ready, tell the organizer you are here so they can check you in.
                  </p>
                )}
              </section>
            )}
          {checkInMode && mySeat.status === 'registered' && mySeat.checked_in && (event.state === 'open' || event.state === 'closed' || event.state === 'running') && (
            <p data-testid="checked-in" className="rounded border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-900">
              You are checked in. You will be paired from the next round on.
            </p>
          )}
          <section className="rounded-lg border border-gray-200 bg-white p-5">
            <div className="flex items-center justify-between">
              <p className="text-sm">
                You are <span className="font-medium">{mySeat.status}</span>.
                {mySeat.status === 'withdrawn' &&
                  (event.state === 'open'
                    ? ' You withdrew from this event. You can register again below.'
                    : ' You withdrew from this event, and registration is now closed.')}
                {mySeat.status === 'removed' && ' The organizer removed you from this event. Ask them if you think that is a mistake.'}
              </p>
              {mySeat.status === 'withdrawn' && event.state === 'open' && (
                <form action={rejoinEvent.bind(null, orgSlug, mySeat.id, eventId)}>
                  <button className={btnCls}>Register again</button>
                </form>
              )}
              {(mySeat.status === 'registered' || mySeat.status === 'waitlisted') &&
                (event.state === 'open' || event.state === 'closed') && (
                <form action={withdrawFromEvent.bind(null, orgSlug, mySeat.id, eventId)}>
                  <button className="text-sm text-red-600 hover:underline">Withdraw</button>
                </form>
              )}
            </div>
            {event.resume_review_enabled && (
              <form
                action={saveProfileCard.bind(null, orgSlug, eventId, mySeat.id)}
                className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3"
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

          {event.state === 'running' && (
            <section className="rounded-lg border border-indigo-200 bg-indigo-50 p-5">
              <LiveRoundRefresh />
              <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-indigo-700">
                Right now
              </h2>
              {!activeRound && (
                <p className="text-sm text-indigo-900">
                  {allRoundsRun
                    ? 'All the rounds are done. The organizer will finish the event and reveal your matches.'
                    : 'Waiting for the next round to start…'}
                </p>
              )}
              {activeRound && !myCurrentPairing && (
                <p className="text-sm text-indigo-900">
                  {checkInMode && !mySeat.checked_in ? (
                    <>
                      You&apos;re <span className="font-semibold">not checked in</span>, so you are not in any round.{' '}
                      {checkInMode === 'self' ? 'Check in above' : 'Ask the organizer to check you in'} and you&apos;ll join the next round.
                    </>
                  ) : (
                    <>You&apos;re not in this round. You&apos;ll join the next one.</>
                  )}
                </p>
              )}
              {activeRound && myCurrentPairing && myCurrentPartnerId === null && (
                <p className="text-sm text-indigo-900">
                  Round {activeRound.round_number} — you have a bye this round. Grab water; you&apos;re back in next round.
                </p>
              )}
              {activeRound && myCurrentPairing && myCurrentPartnerId && (
                <p className="text-sm text-indigo-900">
                  {onBreak ? (
                    <>
                      Round {activeRound.round_number} complete — you were with {seatName(myCurrentPartnerId)}.{' '}
                      {isLastRound
                        ? 'That was the last round — the organizer will finish the event and reveal your matches.'
                        : 'Take a break.'}
                    </>
                  ) : (
                    <>
                      Round {activeRound.round_number} — you&apos;re with{' '}
                      <span className="font-medium">{seatName(myCurrentPartnerId)}</span>.
                    </>
                  )}
                  {/* A round created before ends_at was tracked has no timer to
                      show — degrade to just the pairing rather than nothing. */}
                  {!onBreak && roundEndsAt && (
                    <>
                      {' '}
                      Ends in <span className="font-medium">{formatCountdown(roundEndsAt.getTime() - now.getTime())}</span>.
                    </>
                  )}
                  {onBreak && breakEndsAt && !isLastRound && (
                    <>
                      {' '}
                      Next round starts in <span className="font-medium">{formatCountdown(breakEndsAt.getTime() - now.getTime())}</span>.
                    </>
                  )}
                  {event.rounds_planned !== null && (
                    <span className="ml-2 text-gray-500" data-testid="round-of-planned">
                      (round {activeRound.round_number} of {event.rounds_planned}
                      {roundEndsAt ? ` · ${describeTimeLeft(roundEndsAt.getTime() + (event.rounds_planned - activeRound.round_number) * (event.round_duration_seconds + event.break_duration_seconds) * 1000 - now.getTime())}` : ''})
                    </span>
                  )}
                </p>
              )}
              {/* Resume-review (item 2, remaining work — 2026-09-04): the
                  card belongs WHILE paired, not only after the encounter in
                  "People you met" below. The spec's "up next: her card"
                  before a round starts isn't representable yet — the
                  rotation engine builds one round at a time (no future
                  pairing exists to preview during a break) — so this shows
                  the card for the CURRENT partner only, the one moment the
                  schema can actually support today. */}
              {event.resume_review_enabled && !onBreak && myCurrentPartnerId && profileCardFor(myCurrentPartnerId) && (
                <p className="mt-2 border-t border-indigo-100 pt-2 text-sm italic text-indigo-800">
                  &quot;{profileCardFor(myCurrentPartnerId)}&quot;
                </p>
              )}
              {/* Video (item 1, remaining work — 2026-09-04): only the two
                  seats actually in THIS pairing, only while it's live, only
                  for a real participant seat — never staff/observer, never a
                  bye. authorizeVideoJoin (src/video/authorize.ts) re-checks
                  all of this server-side; this render gate is UX, not the
                  security boundary. Keyed on the pairing so the next round's
                  fresh pairing mounts a new instance instead of reusing a
                  stale connection. */}
              {!onBreak && myCurrentPairing && myCurrentPartnerId && mySeat.seat_type === 'participant' && (
                <VideoRoom
                  key={myCurrentPairing.id}
                  orgSlug={orgSlug}
                  eventId={eventId}
                  pairingId={myCurrentPairing.id}
                  partnerName={seatName(myCurrentPartnerId)}
                  roundEndsAt={roundEndsAt ? roundEndsAt.toISOString() : null}
                />
              )}
            </section>
          )}

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
                              className="mt-1 flex flex-wrap items-center gap-2"
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

          {((matches ?? []).filter((m) => m.revealed && departedMatchIds.has(m.id)).length > 0 ||
            departedInterestCount > 0) && (
            <section data-testid="match-archive" className="rounded-lg border border-gray-200 bg-gray-50 p-5">
              <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-gray-600">Archive</h2>
              <p className="mb-3 text-xs text-gray-500">
                Matches that can&apos;t go any further, and why.
              </p>
              <ul className="space-y-1 text-sm text-gray-600">
                {(matches ?? [])
                  .filter((m) => m.revealed && departedMatchIds.has(m.id))
                  .map((m) => {
                    const other = m.participant_a_id === mySeat.id ? m.participant_b_id : m.participant_a_id
                    const name = seatName(other)
                    return (
                      <li key={m.id}>
                        {name === 'Someone' ? 'Your match' : name} — this person left the platform.
                      </li>
                    )
                  })}
                {departedInterestCount > 0 && (
                  <li data-testid="departed-interests">
                    {departedInterestCount === 1
                      ? '1 person you said yes to has since left the platform.'
                      : `${departedInterestCount} people you said yes to have since left the platform.`}
                  </li>
                )}
              </ul>
            </section>
          )}

          {(matches ?? []).filter((m) => m.revealed && !departedMatchIds.has(m.id)).length > 0 && (
            <section className="rounded-lg border border-green-200 bg-green-50 p-5">
              <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-green-700">
                It&apos;s a match!
              </h2>
              <ul className="space-y-1 text-sm">
                {(matches ?? [])
                  .filter((m) => m.revealed && !departedMatchIds.has(m.id))
                  .map((m, i) => {
                    const other = m.participant_a_id === mySeat.id ? m.participant_b_id : m.participant_a_id
                    const otherUserId = (participants ?? []).find((p) => p.id === other)?.user_id
                    // Populated only when the organizer enabled "share
                    // contact on match" for this event (event-format.ts) —
                    // empty otherwise, matching the schema's own default.
                    const contact = otherUserId
                      ? ((m.contact_shared as Record<string, { displayName: string | null; email: string | null }> | null)?.[
                          otherUserId
                        ] ?? null)
                      : null
                    return (
                      <li key={i}>
                        {seatName(other)} is interested too.
                        {contact?.email && <span className="ml-2 text-xs text-gray-500">— {contact.email}</span>}
                      </li>
                    )
                  })}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
