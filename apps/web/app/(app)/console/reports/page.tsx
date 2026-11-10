import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getProfile } from '@/lib/platform'
import { DEADLINE_HOURS, hoursSince, OPEN_STATUSES, reasonLabel, safeHttpUrl, statusLabel } from '@/lib/content-reports'
import { ReportStatusForm } from './forms'

// The superadmin's content-report queue (module-9 spec §B1/§H). Open reports
// oldest first, each with its age against the 48-hour limit. RLS lets only the
// superadmin read content_reports; the notFound() is presentation.
//
// Everything a reporter typed is rendered as plain React text (escaped). The
// "where" field becomes a link only when it is a plain http(s) URL, and then
// opens with rel="noopener noreferrer nofollow".
export default async function ConsoleReportsPage(props: { searchParams?: Promise<{ closed?: string }> }) {
  const profile = await getProfile()
  if (!profile?.is_superadmin) notFound()
  const { closed } = (await props.searchParams) ?? {}
  const showClosed = closed === '1'

  const supabase = await createClient()
  let query = supabase
    .from('content_reports')
    .select(
      'id, where_seen, reason, details, reporter_email, signature_name, attested_nonconsent, status, staff_note, reviewed_at, closed_at, first_closed_at, created_at',
    )
    .limit(300)
  query = showClosed
    ? query.in('status', ['actioned', 'dismissed']).order('closed_at', { ascending: false })
    : query.in('status', [...OPEN_STATUSES]).order('created_at', { ascending: true })
  const [{ data: reports, error }, { data: intake }] = await Promise.all([
    query,
    supabase.rpc('content_report_intake_status'),
  ])
  const status = (intake as { configured: boolean; accepted_24h: number; refused_24h: number; daily_cap: number }[] | null)?.[0]
  const now = Date.now()

  return (
    <div>
      <Link href="/console" className="text-sm text-blue-600 hover:underline">
        ← Owner Console
      </Link>
      <h1 className="mt-2 mb-2 text-2xl font-semibold">Content reports</h1>
      <p className="mb-3 text-sm text-gray-600">
        Sent from the public Report content page. A valid report of an intimate image shared without consent must be
        acted on within {DEADLINE_HOURS} hours.
      </p>
      <nav className="mb-4 flex gap-3 text-sm">
        <Link href="/console/reports" className={showClosed ? 'text-blue-600 hover:underline' : 'font-medium'}>
          Open
        </Link>
        <Link href="/console/reports?closed=1" className={showClosed ? 'font-medium' : 'text-blue-600 hover:underline'}>
          Closed
        </Link>
      </nav>
      {status && (
        <p className={`mb-4 text-sm ${status.configured ? 'text-gray-600' : 'rounded border border-red-200 bg-red-50 p-3 text-red-700'}`}>
          {status.configured
            ? `Last 24 hours: ${status.accepted_24h} received, ${status.refused_24h} refused (daily limit ${status.daily_cap}).`
            : 'Report intake is NOT configured: the public page refuses every report. Run scripts/set-content-report-token.mts.'}
        </p>
      )}
      {error && <p className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error.message}</p>}
      {(reports ?? []).length === 0 ? (
        <p className="text-sm text-gray-600">Nothing here.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {(reports ?? []).map((r) => {
            const age = hoursSince(r.created_at, now)
            const open = (OPEN_STATUSES as readonly string[]).includes(r.status)
            const tone = !open ? 'text-gray-500' : age >= 36 ? 'text-red-700 font-semibold' : age >= 24 ? 'text-red-600' : 'text-gray-700'
            const href = safeHttpUrl(r.where_seen)
            return (
              <li key={r.id} className="rounded-lg border border-gray-200 bg-white p-4">
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span className="font-medium">{reasonLabel(r.reason)}</span>
                  <span className={tone}>
                    {statusLabel(r.status)} · received {new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ')} UTC
                    {open && ` · ${Math.floor(age)} h of ${DEADLINE_HOURS}`}
                  </span>
                </div>
                <dl className="mb-3 grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-gray-500">Where</dt>
                  <dd className="break-words whitespace-pre-wrap">
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-blue-700 hover:underline">
                        {r.where_seen}
                      </a>
                    ) : (
                      r.where_seen
                    )}
                  </dd>
                  <dt className="text-gray-500">Details</dt>
                  <dd className="break-words whitespace-pre-wrap">{r.details ?? '—'}</dd>
                  <dt className="text-gray-500">Reporter</dt>
                  <dd className="break-all">{r.reporter_email}</dd>
                  {r.signature_name && (
                    <>
                      <dt className="text-gray-500">Signed</dt>
                      <dd className="break-words">
                        {r.signature_name}
                        {r.attested_nonconsent && (
                          <span className="block text-xs text-gray-500">
                            Stated in good faith that the image was shared without consent (TAKE IT DOWN Act notice)
                          </span>
                        )}
                      </dd>
                    </>
                  )}
                  {r.staff_note && (
                    <>
                      <dt className="text-gray-500">Your note</dt>
                      <dd className="break-words whitespace-pre-wrap">{r.staff_note}</dd>
                    </>
                  )}
                  {r.first_closed_at && (
                    <>
                      <dt className="text-gray-500">First closed</dt>
                      <dd>
                        {new Date(r.first_closed_at).toISOString().slice(0, 16).replace('T', ' ')} UTC (
                        {Math.floor(hoursSince(r.created_at, new Date(r.first_closed_at).getTime()))} h after it arrived)
                      </dd>
                    </>
                  )}
                </dl>
                <ReportStatusForm id={r.id} status={r.status} />
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
