import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getProfile } from '@/lib/platform'
import { FEEDBACK_KINDS, FEEDBACK_STATUSES } from '@/lib/feedback'

// The superadmin's feedback queue (docs/27). RLS lets the superadmin read every
// ticket; the notFound() below is presentation, the database is the gate.
export default async function ConsoleFeedbackPage(props: {
  searchParams?: Promise<{ status?: string; kind?: string; all?: string }>
}) {
  const profile = await getProfile()
  if (!profile?.is_superadmin) notFound()
  const { status, kind, all } = (await props.searchParams) ?? {}

  const supabase = await createClient()
  let query = supabase
    .from('feedback_tickets')
    .select('id, created_by, org_id, module_key, kind, title, status, updated_at, last_user_message_at, staff_read_at')
    .order('updated_at', { ascending: false })
    .limit(200)
  if (status && (FEEDBACK_STATUSES as readonly string[]).includes(status)) query = query.eq('status', status)
  else if (!all) query = query.in('status', ['new', 'open'])
  if (kind && FEEDBACK_KINDS.some((k) => k.value === kind)) query = query.eq('kind', kind)
  const { data: tickets, error } = await query

  const userIds = [...new Set((tickets ?? []).map((t) => t.created_by))]
  const orgIds = [...new Set((tickets ?? []).map((t) => t.org_id).filter((x): x is string => !!x))]
  const [{ data: profiles }, { data: orgs }] = await Promise.all([
    userIds.length ? supabase.from('profiles').select('user_id, display_name').in('user_id', userIds) : Promise.resolve({ data: [] }),
    orgIds.length ? supabase.from('orgs').select('id, name').in('id', orgIds) : Promise.resolve({ data: [] }),
  ])
  const nameOf = new Map((profiles ?? []).map((p) => [p.user_id, p.display_name as string | null]))
  const orgOf = new Map((orgs ?? []).map((o) => [o.id, o.name as string]))

  const filterLink = (label: string, params: Record<string, string>) => (
    <Link href={`/console/feedback?${new URLSearchParams(params).toString()}`} className="text-blue-600 hover:underline">
      {label}
    </Link>
  )

  return (
    <div>
      <Link href="/console" className="text-sm text-blue-600 hover:underline">
        ← Owner Console
      </Link>
      <h1 className="mt-2 mb-2 text-2xl font-semibold">Feedback</h1>
      <nav className="mb-4 flex flex-wrap gap-3 text-sm">
        {filterLink('Needs attention (new + open)', {})}
        {FEEDBACK_STATUSES.map((s) => (
          <span key={s}>{filterLink(s, { status: s })}</span>
        ))}
        {filterLink('everything', { all: '1' })}
      </nav>
      {error && <p className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error.message}</p>}
      {(tickets ?? []).length === 0 ? (
        <p className="text-sm text-gray-600">Nothing here.</p>
      ) : (
        <table className="w-full border-collapse bg-white text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-gray-500">
              <th className="py-2 pr-2">Title</th>
              <th className="py-2 pr-2">From</th>
              <th className="py-2 pr-2">Where</th>
              <th className="py-2 pr-2">Kind</th>
              <th className="py-2 pr-2">Status</th>
              <th className="py-2">Updated (UTC)</th>
            </tr>
          </thead>
          <tbody>
            {(tickets ?? []).map((t) => {
              const unread =
                t.last_user_message_at !== null && (t.staff_read_at === null || t.last_user_message_at > t.staff_read_at)
              return (
                <tr key={t.id} className="border-b border-gray-100 align-top">
                  <td className="py-2 pr-2">
                    <Link href={`/console/feedback/${t.id}`} className="text-blue-700 hover:underline">
                      {t.title}
                    </Link>
                    {unread && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">unread</span>}
                  </td>
                  <td className="py-2 pr-2">{nameOf.get(t.created_by) ?? 'Former member'}</td>
                  <td className="py-2 pr-2">
                    {t.org_id ? (orgOf.get(t.org_id) ?? '(org removed)') : 'platform'}
                    {t.module_key ? ` · ${t.module_key}` : ''}
                  </td>
                  <td className="py-2 pr-2">{t.kind}</td>
                  <td className="py-2 pr-2">{t.status}</td>
                  <td className="py-2 text-gray-500">{new Date(t.updated_at).toISOString().slice(0, 16).replace('T', ' ')}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      <p className="mt-2 flex flex-wrap gap-3 text-xs text-gray-500">
        <span>Only one kind:</span>
        {FEEDBACK_KINDS.map((k) => (
          <span key={k.value}>{filterLink(k.value, { kind: k.value, all: '1' })}</span>
        ))}
      </p>
    </div>
  )
}
