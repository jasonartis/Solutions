import Link from 'next/link'
import { getOrgsWithModules, getPendingOrgInvites } from '@/lib/platform'
import { createClient } from '@/lib/supabase/server'
import { acceptInvite, declineInvite, leaveOrg } from './actions'
import JoinHelp from './join-help'

// An org card's text links: small on a desktop, a comfortable tap target on a phone.
const orgLink = 'whitespace-nowrap py-1.5 text-sm text-blue-600 hover:underline sm:py-0 sm:text-xs'

export default async function DashboardPage() {
  const supabase = await createClient()
  // Signing back in during the 30-day grace period cancels a deletion
  // (docs/21 §7.9). The database already treats it as cancelled the moment
  // GoTrue records the sign-in; `account_deletion_resume` RECORDS it. Dashboard
  // is where sign-in lands, so this is where the person hears about it.
  //
  // The banner reads the recorded row, NOT the RPC's return value. The login
  // page does router.push('/dashboard') then router.refresh(), so this page
  // renders twice: the first render records the cancel, the second finds
  // nothing left to cancel. Keyed on the RPC, the banner flashed and vanished
  // (caught by e2e, 2026-10-07). Ten minutes is "you just came back".
  const [, { data: auth }] = await Promise.all([supabase.rpc('account_deletion_resume'), supabase.auth.getUser()])
  const [orgs, invites, { data: deletion }] = await Promise.all([
    getOrgsWithModules(),
    getPendingOrgInvites(),
    // Filtered to MY row explicitly: a superadmin's RLS reads every row.
    supabase
      .from('account_deletions')
      .select('state, cancel_reason, cancelled_at')
      .eq('user_id', auth.user?.id ?? '00000000-0000-0000-0000-000000000000')
      .maybeSingle(),
  ])
  const deletionCancelled =
    deletion?.state === 'cancelled' &&
    deletion.cancel_reason === 'signed_in' &&
    !!deletion.cancelled_at &&
    Date.now() - new Date(deletion.cancelled_at).getTime() < 10 * 60 * 1000

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Dashboard</h1>

      {deletionCancelled && (
        <p className="mb-6 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-800">
          Welcome back. Because you signed in, your account deletion has been cancelled.
        </p>
      )}

      {invites.length > 0 && (
        <div className="mb-6 space-y-3">
          {invites.map((inv) => (
            <section
              key={inv.org_id}
              className="rounded-lg border border-dashed border-amber-300 bg-amber-50 p-5"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                <p className="text-sm text-amber-900">
                  You&apos;ve been invited to join <span className="font-semibold">{inv.org_name}</span> as{' '}
                  <span className="font-medium">{inv.invited_role}</span>. It won&apos;t appear below until you
                  accept.
                </p>
                <span className="flex items-center gap-2">
                  <form action={acceptInvite.bind(null, inv.org_id)}>
                    <button className="rounded bg-amber-600 px-3 py-1 text-sm font-medium text-white hover:bg-amber-700">
                      Accept
                    </button>
                  </form>
                  <form action={declineInvite.bind(null, inv.org_id)}>
                    <button className="px-2 py-1 text-sm text-amber-700 hover:underline">Decline</button>
                  </form>
                </span>
              </div>
            </section>
          ))}
        </div>
      )}

      {orgs.length === 0 && invites.length === 0 && <JoinHelp email={auth.user?.email ?? ''} />}

      <div className="space-y-6">
        {orgs.map((org) => (
          <section key={org.id} className="rounded-lg border border-gray-200 bg-white p-4 sm:p-5">
            {/* Phone: the name (and role) on top, the links on their own row below
                with finger-sized targets. From sm up it is the original one-row layout. */}
            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <h2 className="text-lg font-medium">{org.name}</h2>
                <span
                  title="Your organization-level role (separate from any role you hold inside a specific module below)"
                  className={
                    'whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ' +
                    (org.role === 'owner'
                      ? 'bg-purple-100 text-purple-700'
                      : org.role === 'admin'
                        ? 'bg-amber-100 text-amber-700'
                        : 'bg-gray-100 text-gray-600')
                  }
                >
                  org: {org.role}
                </span>
              </div>
              <span className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-gray-100 pt-2 sm:gap-x-3 sm:border-0 sm:pt-0">
                {(org.role === 'owner' || org.role === 'admin') && (
                  <>
                    <Link href={`/o/${org.slug}/members`} className={orgLink}>
                      Members
                    </Link>
                    <Link href={`/o/${org.slug}/settings`} className={orgLink}>
                      Settings
                    </Link>
                  </>
                )}
                <Link href={`/o/${org.slug}/help`} className={orgLink}>
                  Help
                </Link>
                <Link href={`/o/${org.slug}/export`} className={orgLink}>
                  Export data
                </Link>
                {org.role === 'member' && (
                  <form action={leaveOrg.bind(null, org.id)}>
                    <button className="whitespace-nowrap py-1.5 text-sm text-red-600 hover:underline sm:py-0 sm:text-xs">
                      Leave
                    </button>
                  </form>
                )}
              </span>
            </div>
            {org.modules.length === 0 ? (
              <p className="text-sm text-gray-500">No modules enabled for this organization.</p>
            ) : (
              <ul className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-3">
                {org.modules.map((mod) => (
                  <li key={mod.key}>
                    <Link
                      href={`/o/${org.slug}/m/${mod.key}`}
                      className="flex min-h-11 items-center justify-between gap-1.5 rounded border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100 sm:inline-flex sm:min-h-0 sm:justify-start"
                    >
                      {mod.name}
                      {mod.myRole && (
                        <span
                          title="Your role inside this specific module (separate from your organization-level role above)"
                          className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-500"
                        >
                          {mod.myRole}
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  )
}
