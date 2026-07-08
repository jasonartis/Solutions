import Link from 'next/link'
import { requireOrgModule } from '@/lib/module-gate'
import { createEvent } from './actions'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'
const btnCls = 'rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700'

// Module 6 (Speed Dating) landing: events list. Organizers create events;
// participants see the events they can register for (RLS scopes both).
export default async function SpeedDatingPage(props: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await props.params
  const { supabase, org } = await requireOrgModule(orgSlug, 'speed-dating')

  const [{ data: canOrganize }, { data: events }] = await Promise.all([
    supabase.rpc('sd_can_organize', { check_org_id: org.id }),
    supabase
      .from('sd_events')
      .select('id, name, state, scheduled_at')
      .eq('org_id', org.id)
      .order('scheduled_at', { ascending: false, nullsFirst: false }),
  ])

  const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <h1 className="mb-6 text-2xl font-semibold">Speed Dating — Events</h1>

      <ul className="mb-8 space-y-2">
        {(events ?? []).map((e) => (
          <li key={e.id} className="flex items-center justify-between rounded border border-gray-200 bg-white px-4 py-3">
            <Link href={`/o/${orgSlug}/m/speed-dating/events/${e.id}`} className="text-blue-600 hover:underline">
              {e.name}
            </Link>
            <span className="text-sm text-gray-500">
              {e.scheduled_at ? `${fmt.format(new Date(e.scheduled_at))} · ` : ''}
              <span className="text-xs uppercase text-gray-400">{e.state}</span>
            </span>
          </li>
        ))}
        {(events ?? []).length === 0 && <li className="text-gray-500">No events yet.</li>}
      </ul>

      {canOrganize && (
        <section className="rounded-lg border border-gray-200 bg-white p-5">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">Create event</h2>
          <form action={createEvent.bind(null, orgSlug)} className="flex flex-wrap items-center gap-2">
            <input name="name" required placeholder="Event name" className={`${inputCls} min-w-56`} />
            <input name="scheduledAt" type="datetime-local" className={inputCls} />
            <button className={btnCls}>Create (draft)</button>
          </form>
        </section>
      )}
    </div>
  )
}
