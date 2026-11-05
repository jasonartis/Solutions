import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { kindLabel, statusLabel } from '@/lib/feedback'
import { ReplyForm, StatusButton } from '../forms'

// One ticket, as its author sees it (docs/27). RLS returns the ticket only to
// its author (and the superadmin) and never returns internal notes to the
// author; anything else is a plain 404 — the same for "not yours" and "no such
// ticket". The superadmin answers from /console/feedback, so this page is
// author-only: a superadmin opening someone else's ticket here is sent there.
export default async function FeedbackTicketPage(props: {
  params: Promise<{ ticketId: string }>
  searchParams?: Promise<{ sent?: string }>
}) {
  const { ticketId } = await props.params
  const { sent } = (await props.searchParams) ?? {}
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: ticket } = await supabase
    .from('feedback_tickets')
    .select('id, created_by, kind, title, status, created_at')
    .eq('id', ticketId)
    .maybeSingle()
  if (!ticket) notFound()
  if (ticket.created_by !== user.id) redirect(`/console/feedback/${ticketId}`)

  const { data: messages } = await supabase
    .from('feedback_messages')
    .select('id, author_kind, body, created_at')
    .eq('ticket_id', ticketId)
    .eq('internal', false)
    .order('created_at')

  // Opening the ticket is reading it (clears "New reply").
  await supabase.rpc('feedback_mark_read', { p_ticket_id: ticketId })

  return (
    <div className="max-w-3xl">
      <Link href="/feedback" className="text-sm text-blue-600 hover:underline">
        ← My feedback
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">{ticket.title}</h1>
      <p className="mb-4 text-sm text-gray-600">
        {kindLabel(ticket.kind)} · <span data-testid="ticket-status">{statusLabel(ticket.status)}</span>
      </p>
      {sent && (
        <p className="mb-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-800" role="status">
          Thank you — your feedback was sent. Replies will appear here.
        </p>
      )}

      <ol className="mb-6 space-y-3">
        {(messages ?? []).map((m) => (
          <li
            key={m.id}
            className={`rounded border p-3 text-sm ${m.author_kind === 'staff' ? 'border-blue-200 bg-blue-50' : 'border-gray-200 bg-white'}`}
          >
            <div className="mb-1 text-xs text-gray-500">
              {m.author_kind === 'staff' ? 'The platform team' : 'You'} ·{' '}
              {new Date(m.created_at).toLocaleString('en-US', { timeZone: 'UTC' })} UTC
            </div>
            <p className="whitespace-pre-wrap">{m.body}</p>
          </li>
        ))}
      </ol>

      <h2 className="mb-2 text-sm font-medium">Add a message</h2>
      <ReplyForm ticketId={ticketId} />
      {ticket.status !== 'closed' && (
        <div className="mt-4">
          <StatusButton ticketId={ticketId} status="closed" label="Close this ticket" />
        </div>
      )}
    </div>
  )
}
