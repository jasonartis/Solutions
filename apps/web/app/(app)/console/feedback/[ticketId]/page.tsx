import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getProfile } from '@/lib/platform'
import { FEEDBACK_STATUSES } from '@/lib/feedback'
import { ReplyForm, StatusButton } from '../../../feedback/forms'

// One ticket, as the platform team sees it (docs/27): the whole thread
// including internal notes, the context the person agreed to send, and what
// they did on the platform in the 24 hours before writing — read LIVE from
// activity_events (superadmin-only; never copied into the ticket, so it ages
// out and is handled by account deletion like every other activity row).
export default async function ConsoleFeedbackTicketPage(props: { params: Promise<{ ticketId: string }> }) {
  const profile = await getProfile()
  if (!profile?.is_superadmin) notFound()
  const { ticketId } = await props.params
  const supabase = await createClient()

  const { data: ticket } = await supabase
    .from('feedback_tickets')
    .select('id, created_by, org_id, module_key, kind, title, status, context, created_at')
    .eq('id', ticketId)
    .maybeSingle()
  if (!ticket) notFound()

  const since = new Date(new Date(ticket.created_at).getTime() - 24 * 3600 * 1000).toISOString()
  const [{ data: messages }, { data: author }, { data: org }, { data: emailRows }, { data: trail }, { data: roles }] =
    await Promise.all([
      supabase.from('feedback_messages').select('id, author_id, author_kind, body, internal, created_at').eq('ticket_id', ticketId).order('created_at'),
      supabase.from('profiles').select('display_name').eq('user_id', ticket.created_by).maybeSingle(),
      ticket.org_id ? supabase.from('orgs').select('name, slug').eq('id', ticket.org_id).maybeSingle() : Promise.resolve({ data: null }),
      supabase.rpc('superadmin_user_emails', { target_user_ids: [ticket.created_by] }),
      supabase
        .from('activity_events')
        .select('occurred_at, action, module_key, org_id')
        .eq('user_id', ticket.created_by)
        .gte('occurred_at', since)
        .lte('occurred_at', ticket.created_at)
        .order('occurred_at', { ascending: false })
        .limit(50),
      ticket.org_id
        ? supabase.from('module_roles').select('module_key, role, scope_ref').eq('org_id', ticket.org_id).eq('user_id', ticket.created_by)
        : Promise.resolve({ data: [] }),
    ])
  const email = ((emailRows as { user_id: string; email: string | null }[] | null) ?? [])[0]?.email ?? null

  await supabase.rpc('feedback_mark_read', { p_ticket_id: ticketId })

  return (
    <div>
      <Link href="/console/feedback" className="text-sm text-blue-600 hover:underline">
        ← Feedback
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">{ticket.title}</h1>
      <p className="mb-4 text-sm text-gray-600">
        {ticket.kind} · status <span data-testid="console-ticket-status">{ticket.status}</span> · from{' '}
        {author?.display_name ?? 'Former member'}
        {email ? ` <${email}>` : ''} · {org ? `${org.name}${ticket.module_key ? ` · ${ticket.module_key}` : ''}` : 'platform'}
      </p>

      <div className="grid gap-6 md:grid-cols-[1fr_20rem]">
        <div>
          <ol className="mb-6 space-y-3">
            {(messages ?? []).map((m) => (
              <li
                key={m.id}
                className={`rounded border p-3 text-sm ${
                  m.internal ? 'border-amber-300 bg-amber-50' : m.author_kind === 'staff' ? 'border-blue-200 bg-blue-50' : 'border-gray-200 bg-white'
                }`}
              >
                <div className="mb-1 text-xs text-gray-500">
                  {m.internal ? 'Internal note' : m.author_kind === 'staff' ? 'Platform team' : 'The person'} ·{' '}
                  {new Date(m.created_at).toISOString().slice(0, 16).replace('T', ' ')} UTC
                </div>
                <p className="whitespace-pre-wrap">{m.body}</p>
              </li>
            ))}
          </ol>
          <ReplyForm ticketId={ticketId} staff />
          <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-gray-500">Set status:</span>
            {FEEDBACK_STATUSES.filter((s) => s !== ticket.status).map((s) => (
              <StatusButton key={s} ticketId={ticketId} status={s} label={s} />
            ))}
          </div>
        </div>

        <aside className="space-y-4 text-sm">
          <section className="rounded border border-gray-200 bg-white p-3">
            <h2 className="mb-1 font-medium">Context they sent</h2>
            <p className="mb-2 text-xs text-gray-500">Self-reported by their browser — a lead, not evidence.</p>
            {Object.keys((ticket.context as Record<string, unknown>) ?? {}).length === 0 ? (
              <p className="text-gray-500">None (they unticked page and browser details).</p>
            ) : (
              <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs text-gray-700">
                {JSON.stringify(ticket.context, null, 2)}
              </pre>
            )}
          </section>
          <section className="rounded border border-gray-200 bg-white p-3">
            <h2 className="mb-2 font-medium">Their positions in that org</h2>
            {(roles ?? []).length === 0 ? (
              <p className="text-gray-500">{ticket.org_id ? 'No module positions there.' : 'No org on this ticket.'}</p>
            ) : (
              <ul className="space-y-0.5 text-gray-700">
                {(roles ?? []).map((r, i) => (
                  <li key={i}>
                    {r.module_key}: {r.role}
                    {r.scope_ref ? ' (scoped)' : ''}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="rounded border border-gray-200 bg-white p-3">
            <h2 className="mb-2 font-medium">What they did in the 24 h before</h2>
            {(trail ?? []).length === 0 ? (
              <p className="text-gray-500">No recorded activity in that window.</p>
            ) : (
              <ul className="space-y-0.5 text-xs text-gray-700">
                {(trail ?? []).map((a, i) => (
                  <li key={i}>
                    {new Date(a.occurred_at).toISOString().slice(5, 16).replace('T', ' ')} · {a.module_key} · {a.action}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}
