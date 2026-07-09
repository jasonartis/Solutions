import Link from 'next/link'
import { getOrgsWithModules } from '@/lib/platform'

export default async function DashboardPage() {
  const orgs = await getOrgsWithModules()

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Dashboard</h1>

      {orgs.length === 0 && (
        <p className="text-gray-500">
          You are not a member of any organization yet. Ask your administrator for access.
        </p>
      )}

      <div className="space-y-6">
        {orgs.map((org) => (
          <section key={org.id} className="rounded-lg border border-gray-200 bg-white p-5">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-lg font-medium">{org.name}</h2>
              <span className="flex items-baseline gap-3">
                <Link href={`/o/${org.slug}/export`} className="text-xs text-blue-600 hover:underline">
                  Export data
                </Link>
                <span className="text-xs uppercase tracking-wide text-gray-400">{org.role}</span>
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
                      className="inline-block rounded border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100"
                    >
                      {mod.name}
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
