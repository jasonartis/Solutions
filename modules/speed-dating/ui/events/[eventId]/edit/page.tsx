import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { requireOrgModule } from '@/lib/module-gate'
import { updateEvent } from '../../../actions'
import { EventSettingsFields } from '../../../event-settings-fields'
import { SubmitButton } from '../../../submit-button'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'
const btnCls = 'rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700'

const NOTICES: Record<string, string> = {
  'edit-name': 'The event needs a name.',
  'edit-timing': 'Round length must be whole minutes (1–60) and the break whole seconds (0–600).',
  'edit-format': 'Both side labels are required, and a side capacity must be a positive whole number.',
  'edit-sides-locked':
    'Nothing was saved: people have already registered on a side, so the sides cannot change. Everything else can — save again with the sides as they were.',
  'edit-refused': 'Nothing was saved — you may not be allowed to change this event.',
}

// Organizer-only edit view for an event that is still a draft or open for
// registration. The action re-checks every rule (state, rounds run, sides vs.
// registrants); this page only decides whether to show the form.
export default async function EditEventPage(props: {
  params: Promise<{ orgSlug: string; eventId: string }>
  searchParams?: Promise<{ notice?: string }>
}) {
  const { orgSlug, eventId } = await props.params
  const notice = (await props.searchParams)?.notice
  const { supabase, org } = await requireOrgModule(orgSlug, 'speed-dating')
  const base = `/o/${orgSlug}/m/speed-dating/events/${eventId}`

  const { data: event } = await supabase
    .from('sd_events')
    .select('id, name, description, state, scheduled_at, resume_review_enabled, round_duration_seconds, break_duration_seconds, allow_repeat_pairings, format')
    .eq('id', eventId)
    .maybeSingle()
  if (!event) notFound()
  const { data: canOrganize } = await supabase.rpc('sd_can_organize', { check_org_id: org.id })
  if (!canOrganize || (event.state !== 'draft' && event.state !== 'open')) redirect(base)

  const { count: registered } = await supabase
    .from('sd_participants')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', eventId)
    .in('status', ['registered', 'waitlisted'])

  // datetime-local wants the viewer's wall-clock time without a zone suffix, but
  // this is a server render, so it would be the SERVER's zone. Only prefill when
  // it is safe to say so: render the stored instant in UTC and label it, so a
  // save never silently shifts the time.
  const scheduledValue = event.scheduled_at ? new Date(event.scheduled_at).toISOString().slice(0, 16) : ''

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <div className="mb-6 flex items-baseline gap-4">
        <h1 className="text-2xl font-semibold">Edit event</h1>
        <Link href={base} className="text-sm text-blue-600 hover:underline">
          ← Back to the event
        </Link>
      </div>
      {notice && NOTICES[notice] && (
        <p className="mb-6 rounded border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">{NOTICES[notice]}</p>
      )}
      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <form action={updateEvent.bind(null, orgSlug, eventId)} className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input name="name" required defaultValue={event.name} placeholder="Event name" className={`${inputCls} min-w-56`} />
            <label className="flex items-center gap-1 text-sm text-gray-600">
              Starts (UTC)
              <input name="scheduledAt" type="datetime-local" defaultValue={scheduledValue} className={inputCls} />
            </label>
          </div>
          <textarea
            name="description"
            defaultValue={event.description ?? ''}
            placeholder="Description (optional)"
            rows={2}
            className={`${inputCls} w-full`}
          />
          <EventSettingsFields
            defaults={{
              resumeReview: event.resume_review_enabled,
              format: event.format,
              roundSeconds: event.round_duration_seconds,
              breakSeconds: event.break_duration_seconds,
              allowRepeats: event.allow_repeat_pairings,
              people: registered && registered >= 2 ? registered : undefined,
            }}
          />
          {(registered ?? 0) > 0 && (
            <p className="text-xs text-gray-500">
              {registered} {registered === 1 ? 'person has' : 'people have'} registered, so the two sides are locked.
              Everything else can change.
            </p>
          )}
          <SubmitButton className={btnCls} pendingLabel="Saving…">
            Save changes
          </SubmitButton>
        </form>
      </section>
    </div>
  )
}
