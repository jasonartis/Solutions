import Link from 'next/link'
import { requireSuperadmin } from '@/lib/platform'
import { cancelAccountDeletion, requestAccountDeletionFor } from '../actions'

// ACCOUNT DELETIONS (docs/21 §7, migration 20261007090000).
//
// Two jobs: start a deletion for someone who asked by email (`/privacy` says
// "on request"), and see every deletion that is pending, cancelled, done — or
// FAILED. A failure is the case that matters most here: the daily job cannot
// delete someone who has become the only admin of an org during their grace
// period, and if nobody looks, that person's request simply never completes.
//
// THE HONESTY BADGE. Nothing on this platform watches pg_cron. If the daily
// job stopped running, every pending deletion would sit past its date and this
// page would look exactly like a quiet week — so it reads the job's own run
// history and says plainly when it has not run.

type Row = {
  user_id: string
  state: 'departed' | 'cancelled' | 'deleted'
  initiated_via: 'self' | 'superadmin'
  requested_by: string | null
  requested_at: string
  due_at: string
  cancelled_at: string | null
  cancel_reason: string | null
  deleted_at: string | null
  last_error: string | null
  last_attempt_at: string | null
}

type Runner = {
  scheduled: boolean
  active?: boolean
  schedule?: string
  last_start?: string | null
  last_status?: string | null
  last_message?: string | null
} | null

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—')

export default async function AccountsPage(props: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { error, notice } = await props.searchParams
  const { supabase } = await requireSuperadmin()

  const [{ data: rows }, { data: runner }] = await Promise.all([
    supabase
      .from('account_deletions')
      .select('user_id, state, initiated_via, requested_by, requested_at, due_at, cancelled_at, cancel_reason, deleted_at, last_error, last_attempt_at')
      .order('requested_at', { ascending: false }),
    supabase.rpc('account_deletion_runner_status'),
  ])
  const list = (rows ?? []) as Row[]
  const ids = [...new Set(list.flatMap((r) => [r.user_id, r.requested_by]).filter((x): x is string => !!x))]
  const [{ data: profiles }, { data: emails }] = await Promise.all([
    supabase.from('profiles').select('user_id, display_name').in('user_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']),
    supabase.rpc('superadmin_user_emails', { target_user_ids: ids }),
  ])
  const nameOf = new Map(((profiles ?? []) as { user_id: string; display_name: string | null }[]).map((p) => [p.user_id, p.display_name]))
  const emailOf = new Map(((emails ?? []) as { user_id: string; email: string | null }[]).map((e) => [e.user_id, e.email]))
  const who = (id: string | null, state?: Row['state']) => {
    if (!id) return '—'
    if (state === 'deleted') return 'Former member'
    return nameOf.get(id) || emailOf.get(id) || id
  }

  const r = runner as Runner
  const lastRun = r?.last_start ? new Date(r.last_start) : null
  // The job runs daily; more than ~2 days without a run means it has stopped.
  const stale = !lastRun || Date.now() - lastRun.getTime() > 50 * 3600 * 1000
  const failed = list.filter((x) => x.state === 'departed' && x.last_error)

  return (
    <div className="max-w-4xl">
      <Link href="/console" className="text-sm text-blue-600 hover:underline">
        ← Owner Console
      </Link>
      <h1 className="mt-2 mb-6 text-2xl font-semibold">Account deletions</h1>

      {error && <p className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {notice && <p className="mb-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-800">{notice}</p>}

      <section
        data-testid="deletion-runner"
        className={`mb-6 rounded border p-3 text-sm ${
          !r?.scheduled || r.active === false || r.last_status === 'failed'
            ? 'border-red-200 bg-red-50 text-red-800'
            : stale
              ? 'border-amber-200 bg-amber-50 text-amber-900'
              : 'border-gray-200 bg-white text-gray-700'
        }`}
      >
        {!r?.scheduled ? (
          <>The daily deletion job is <strong>not scheduled</strong>. Pending deletions will never complete.</>
        ) : r.active === false ? (
          <>The daily deletion job exists but is <strong>switched off</strong>. Pending deletions will not complete.</>
        ) : !lastRun ? (
          <>The daily deletion job is scheduled ({r.schedule}, UTC) but has <strong>never run yet</strong>.</>
        ) : (
          <>
            Daily deletion job last ran {lastRun.toISOString().slice(0, 16).replace('T', ' ')} UTC —{' '}
            <strong>{r.last_status}</strong>
            {r.last_status === 'failed' && r.last_message ? `: ${r.last_message}` : ''}
            {stale && r.last_status !== 'failed' && ' — that is more than two days ago, so it may have stopped.'}
          </>
        )}
      </section>

      {failed.length > 0 && (
        <section className="mb-6 rounded-lg border border-red-200 bg-red-50 p-5">
          <h2 className="mb-2 font-medium text-red-900">Deletions that could not complete</h2>
          <p className="mb-2 text-sm text-red-800">
            These are past their date and the job refused them. They are retried every day, but will keep
            failing until the cause is fixed — usually by appointing another administrator.
          </p>
          <ul className="space-y-1 text-sm text-red-900">
            {failed.map((x) => (
              <li key={x.user_id}>
                {who(x.user_id)} — {x.last_error}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mb-8 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-1 font-medium">Start a deletion for someone who asked by email</h2>
        <p className="mb-3 text-sm text-gray-500">
          They are signed out everywhere and their account is deleted 30 days later. If they sign in before
          then, it is cancelled — the same as if they had pressed the button themselves.
        </p>
        <form action={requestAccountDeletionFor} className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-gray-700">Their email address</span>
            <input name="email" type="email" required autoComplete="off" className="rounded border border-gray-300 px-3 py-2 text-sm" />
          </label>
          <button className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700">
            Start deletion
          </button>
        </form>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-3 font-medium">All requests</h2>
        {list.length === 0 ? (
          <p className="text-sm text-gray-500">Nobody has asked to delete their account.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-gray-500">
              <tr>
                <th className="py-1">Person</th>
                <th>State</th>
                <th>Asked</th>
                <th>Due</th>
                <th>Started by</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((x) => (
                <tr key={x.user_id} className="border-t border-gray-100">
                  <td className="py-1.5">{who(x.user_id, x.state)}</td>
                  <td>
                    {x.state === 'departed' && (x.last_error ? 'pending — failing' : 'pending')}
                    {x.state === 'cancelled' && `cancelled (${x.cancel_reason === 'signed_in' ? 'signed back in' : 'by owner'}) ${day(x.cancelled_at)}`}
                    {x.state === 'deleted' && `deleted ${day(x.deleted_at)}`}
                  </td>
                  <td>{day(x.requested_at)}</td>
                  <td>{x.state === 'departed' ? day(x.due_at) : '—'}</td>
                  <td>{x.initiated_via === 'self' ? 'themselves' : who(x.requested_by)}</td>
                  <td className="text-right">
                    {x.state === 'departed' && (
                      <form action={cancelAccountDeletion.bind(null, x.user_id)}>
                        <button className="text-xs text-blue-600 hover:underline">Cancel</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
