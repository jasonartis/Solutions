import Link from 'next/link'
import { getOrgsWithModules, getPendingOrgInvites } from '@/lib/platform'
import { acceptInvite, declineInvite, leaveOrg } from './actions'

export default async function DashboardPage() {
  const [orgs, invites] = await Promise.all([getOrgsWithModules(), getPendingOrgInvites()])

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Dashboard</h1>

      {invites.length > 0 && (
        <div className="mb-6 space-y-3">
          {invites.map((inv) => (
            <section
              key={inv.org_id}
              className="rounded-lg border border-dashed border-amber-300 bg-amber-50 p-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
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

      {orgs.length === 0 && invites.length === 0 && (
        <p className="text-gray-500">
          You are not a member of any organization yet. Ask your administrator for access.
        </p>
      )}

      <div className="space-y-6">
        {orgs.map((org) => (
          <section key={org.id} className="rounded-lg border border-gray-200 bg-white p-5">
            <div className="mb-3 flex items-baseline justify-between">
              <div className="flex items-baseline gap-2">
                <h2 className="text-lg font-medium">{org.name}</h2>
                <span
                  title="Your organization-level role (separate from any role you hold inside a specific module below)"
                  className={
                    'rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ' +
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
              <span className="flex items-baseline gap-3">
                {(org.role === 'owner' || org.role === 'admin') && (
                  <>
                    <Link href={`/o/${org.slug}/members`} className="text-xs text-blue-600 hover:underline">
                      Members
                    </Link>
                    <Link href={`/o/${org.slug}/settings`} className="text-xs text-blue-600 hover:underline">
                      Settings
                    </Link>
                  </>
                )}
                <Link href={`/o/${org.slug}/help`} className="text-xs text-blue-600 hover:underline">
                  Help
                </Link>
                <Link href={`/o/${org.slug}/export`} className="text-xs text-blue-600 hover:underline">
                  Export data
                </Link>
                {org.role === 'member' && (
                  <form action={leaveOrg.bind(null, org.id)}>
                    <button className="text-xs text-red-600 hover:underline">Leave</button>
                  </form>
                )}
              </span>
            </div>
            {org.modules.length === 0 ? (
              <p className="text-sm text-gray-500">No modules enabled for this organization.</p>
            ) : (
              <ul className="flex flex-wrap gap-3">
                {org.modules.map((mod) => (
                  <li key={mod.key}>
                    <Link
                      href={`/o/${org.slug}/m/${mod.key}`}
                      className="inline-flex items-center gap-1.5 rounded border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100"
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
