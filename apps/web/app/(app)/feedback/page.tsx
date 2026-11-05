import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { kindLabel, statusLabel } from '@/lib/feedback'

// My feedback (docs/27): every ticket this person has sent, across every org
// and module, in one place. RLS returns only their own (the superadmin reads
// everyone's in /console/feedback, so this page filters to created_by = me
// to stay "mine" for them too).
export default async function MyFeedbackPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: tickets, error } = await supabase
    .from('feedback_tickets')
    .select('id, kind, title, status, created_at, updated_at, last_staff_message_at, user_read_at')
    .eq('created_by', user.id)
    .order('updated_at', { ascending: false })

  return (
    <div className="max-w-3xl">
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold">My feedback</h1>
        <Link
          href="/feedback/new"
          className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Send feedback
        </Link>
      </div>
      {error && <p className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error.message}</p>}
      {(tickets ?? []).length === 0 ? (
        <p className="text-sm text-gray-600">You have not sent any feedback yet.</p>
      ) : (
        <ul className="divide-y divide-gray-200 rounded border border-gray-200 bg-white">
          {(tickets ?? []).map((t) => {
            const unread =
              t.last_staff_message_at !== null && (t.user_read_at === null || t.last_staff_message_at > t.user_read_at)
            return (
              <li key={t.id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
                <div>
                  <Link href={`/feedback/${t.id}`} className="font-medium text-blue-700 hover:underline">
                    {t.title}
                  </Link>
                  {unread && (
                    <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-800" data-testid="unread">
                      New reply
                    </span>
                  )}
                  <div className="text-xs text-gray-500">{kindLabel(t.kind)}</div>
                </div>
                <div className="text-right text-sm text-gray-600">
                  <div>{statusLabel(t.status)}</div>
                  <div className="text-xs text-gray-400">{new Date(t.updated_at).toLocaleString('en-US', { timeZone: 'UTC' })} UTC</div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
