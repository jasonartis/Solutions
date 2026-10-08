import Link from 'next/link'
import { FORMER_MEMBER_LABEL, loadFormerMembers } from '@platform/core'
import { requireOrgModule } from '@/lib/module-gate'
import { createEvent, unblockUser } from './actions'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'
const btnCls = 'rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700'

// Module 6 (Speed Dating) landing: events list. Organizers create events;
// participants see the events they can register for (RLS scopes both).
export default async function SpeedDatingPage(props: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await props.params
  const { supabase, org } = await requireOrgModule(orgSlug, 'speed-dating')

  const [{ data: canOrganize }, { data: events }, { data: me }] = await Promise.all([
    supabase.rpc('sd_can_organize', { check_org_id: org.id }),
    supabase
      .from('sd_events')
      .select('id, name, state, scheduled_at, created_at')
      .eq('org_id', org.id)
      .order('scheduled_at', { ascending: false, nullsFirst: false }),
    supabase.auth.getUser().then(({ data }) => ({ data: data.user })),
  ])

  // My own registration per event (RLS: a participant reads only their own
  // seat rows; staff read all, so filter to me explicitly). Powers the
  // "Your events" grouping and the per-event badge.
  const { data: mySeats } = me
    ? await supabase.from('sd_participants').select('event_id, status').eq('user_id', me.id)
    : { data: null }
  const seatStatus = new Map((mySeats ?? []).map((m) => [m.event_id as string, m.status as string]))

  // Personal, cross-event block list (spec: "never pair me with them again").
  // Filtered to MY OWN blocks even though RLS also lets the manage tier read
  // everyone's — this section means "my list", not an org-wide admin view.
  const [{ data: myBlocks }, { data: profiles }] = me
    ? await Promise.all([
        supabase
          .from('sd_blocks')
          .select('id, blocked_user_id, reason')
          .eq('org_id', org.id)
          .eq('blocker_user_id', me.id),
        supabase.from('profiles').select('user_id, display_name'),
      ])
    : [{ data: null }, { data: null }]
  // A block survives the blocked person's account deletion (docs/21 §7.10).
  const formerIds = await loadFormerMembers(supabase, (myBlocks ?? []).map((b) => b.blocked_user_id))
  const nameOf = (userId: string) => {
    if (formerIds.has(userId)) return FORMER_MEMBER_LABEL
    const p = (profiles ?? []).find((pr) => pr.user_id === userId)
    return p?.display_name || 'Someone'
  }

  const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <h1 className="mb-6 text-2xl font-semibold">Speed Dating — Events</h1>

      {(() => {
        const all = events ?? []
        const mine = all.filter((e) => seatStatus.has(e.id))
        const rest = all.filter((e) => !seatStatus.has(e.id))
        const openToMe = rest.filter((e) => e.state === 'open')
        const other = rest.filter((e) => e.state !== 'open')
        const badge = (status: string | undefined) => {
          if (!status) return null
          const tone =
            status === 'registered'
              ? 'bg-green-100 text-green-800'
              : status === 'waitlisted'
                ? 'bg-amber-100 text-amber-800'
                : 'bg-gray-100 text-gray-600'
          return <span className={`ml-2 rounded px-1.5 py-0.5 text-xs font-medium ${tone}`}>{status}</span>
        }
        // Event names are NOT unique (same as Eventbrite/Meetup/Google
        // Calendar — events are told apart by date), so every row carries a
        // date: the scheduled time, else when it was created.
        const row = (e: (typeof all)[number]) => (
          <li key={e.id} className="flex items-center justify-between rounded border border-gray-200 bg-white px-4 py-3">
            <span>
              <Link href={`/o/${orgSlug}/m/speed-dating/events/${e.id}`} className="text-blue-600 hover:underline">
                {e.name}
              </Link>
              {badge(seatStatus.get(e.id))}
            </span>
            <span className="text-sm text-gray-500">
              {e.scheduled_at
                ? `${fmt.format(new Date(e.scheduled_at))} · `
                : `created ${fmt.format(new Date(e.created_at))} · `}
              <span className="text-xs uppercase text-gray-400">{e.state}</span>
            </span>
          </li>
        )
        const section = (title: string, list: typeof all) =>
          list.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-gray-500">{title}</h2>
              <ul className="space-y-2">{list.map(row)}</ul>
            </section>
          )
        // Organizers (and anyone with no personal seat) keep one flat list.
        if (mine.length === 0 && !canOrganize) {
          return (
            <div className="mb-8">
              {section('Open for registration', openToMe)}
              {section('Other events', other)}
              {all.length === 0 && <p className="text-gray-500">No events yet.</p>}
            </div>
          )
        }
        if (canOrganize) {
          return (
            <div className="mb-8">
              <ul className="space-y-2">{all.map(row)}</ul>
              {all.length === 0 && <p className="text-gray-500">No events yet.</p>}
            </div>
          )
        }
        return (
          <div className="mb-8">
            {section('Your events', mine)}
            {section('Open for registration', openToMe)}
            {section('Other events', other)}
          </div>
        )
      })()}

      {canOrganize && (
        <section className="mb-8 rounded-lg border border-gray-200 bg-white p-5">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">Create event</h2>
          <form action={createEvent.bind(null, orgSlug)} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <input name="name" required placeholder="Event name" className={`${inputCls} min-w-56`} />
              <input name="scheduledAt" type="datetime-local" className={inputCls} />
              <label className="flex items-center gap-1 text-sm text-gray-600">
                <input type="checkbox" name="resumeReview" />
                Resume-review (participants see profile cards)
              </label>
              <label className="flex items-center gap-1 text-sm text-gray-600">
                <input type="checkbox" name="shareContactOnMatch" />
                Share contact info on mutual match
              </label>
            </div>
            <details className="rounded border border-gray-100 p-2">
              <summary className="cursor-pointer text-sm text-gray-600">
                Two sides (e.g. Men/Women) — optional, sets a capacity + waitlist per side
              </summary>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1 text-sm text-gray-600">
                  <input type="checkbox" name="sidesEnabled" />
                  Enable two sides
                </label>
                <input name="sideALabel" placeholder="Side A label (e.g. Men)" className={`${inputCls} w-40`} />
                <input name="sideACapacity" type="number" min="1" placeholder="Side A capacity (blank = unlimited)" className={`${inputCls} w-56`} />
                <input name="sideBLabel" placeholder="Side B label (e.g. Women)" className={`${inputCls} w-40`} />
                <input name="sideBCapacity" type="number" min="1" placeholder="Side B capacity (blank = unlimited)" className={`${inputCls} w-56`} />
              </div>
            </details>
            <button className={btnCls}>Create (draft)</button>
          </form>
        </section>
      )}

      {/* Personal, cross-event block list — "never pair me with them again".
          Blocking itself happens from an event page (after meeting someone);
          this is just view + remove. */}
      {me && (
        <section className="rounded-lg border border-gray-200 bg-white p-5">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">
            People you&apos;ve blocked
          </h2>
          <ul className="space-y-1 text-sm">
            {(myBlocks ?? []).map((b) => (
              <li key={b.id} className="flex items-center justify-between">
                <span>
                  {nameOf(b.blocked_user_id)}
                  {b.reason && <span className="ml-2 text-xs text-gray-400">— {b.reason}</span>}
                </span>
                <form action={unblockUser.bind(null, orgSlug, b.id)}>
                  <button className="text-xs text-blue-600 hover:underline">Unblock</button>
                </form>
              </li>
            ))}
            {(myBlocks ?? []).length === 0 && (
              <li className="text-gray-400">
                No one blocked. You can block someone from an event&apos;s &quot;People you met&quot; list.
              </li>
            )}
          </ul>
        </section>
      )}
    </div>
  )
}
