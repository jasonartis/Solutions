import Link from 'next/link'
import { requireSuperadmin } from '@/lib/platform'
import { getOverview, type ModuleInOrg, type Person } from '@/lib/console-overview'

// PLATFORM OVERVIEW — two expandable trees of headcounts (founder, 2026-11-10).
// Read-only; the counting rules are in lib/console-overview.ts and repeated in
// the note below so the numbers can be read without guessing.

const summaryCls = 'cursor-pointer list-none rounded px-2 py-1.5 hover:bg-gray-50 [&::-webkit-details-marker]:hidden'

function Count({ n, label }: { n: number; label: string }) {
  return (
    <span className="whitespace-nowrap rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
      <span className="font-semibold">{n}</span> {label}
    </span>
  )
}

function People({ people }: { people: Person[] }) {
  if (people.length === 0) return <p className="px-2 py-1 text-xs text-gray-500">No active members.</p>
  return (
    <ul className="grid gap-x-6 px-2 py-1 text-sm text-gray-700 sm:grid-cols-2 lg:grid-cols-3">
      {people.map((p) => (
        <li key={p.userId}>{p.name}</li>
      ))}
    </ul>
  )
}

// One "module in one org" node: its headcount, expandable to who they are.
function PairNode({ p, label }: { p: ModuleInOrg; label: string }) {
  return (
    <details className="ml-4 border-l border-gray-200 pl-3">
      <summary className={summaryCls}>
        <span className="mr-2 text-sm font-medium text-gray-800">{label}</span>
        <Count n={p.people.length} label={p.people.length === 1 ? 'person' : 'people'} />{' '}
        <Count n={p.roleHolders} label="with a role" />
      </summary>
      <People people={p.people} />
    </details>
  )
}

export default async function OverviewPage() {
  const { supabase } = await requireSuperadmin()
  const o = await getOverview(supabase)

  return (
    <div className="max-w-4xl">
      <Link href="/console" className="text-sm text-blue-600 hover:underline">
        ← Owner Console
      </Link>
      <h1 className="mt-2 mb-1 text-2xl font-semibold">Platform overview</h1>
      <p className="mb-4 text-sm text-gray-600">
        <strong>{o.orgCount}</strong> organization{o.orgCount === 1 ? '' : 's'} ·{' '}
        <strong>{o.distinctPeople}</strong> {o.distinctPeople === 1 ? 'person' : 'people'} (each counted once, however
        many orgs) · <strong>{o.pendingInvites}</strong> pending invitation{o.pendingInvites === 1 ? '' : 's'} (not
        counted anywhere below). Click a row to open it.
      </p>

      <section className="mb-8 rounded-lg border border-gray-200 bg-white p-4" data-testid="overview-by-org">
        <h2 className="mb-2 text-sm font-semibold text-gray-700">By organization</h2>
        {o.byOrg.length === 0 && <p className="text-sm text-gray-500">No organizations yet.</p>}
        {o.byOrg.map((org) => (
          <details key={org.id} className="mb-1" data-testid="overview-org">
            <summary className={summaryCls}>
              <span className="mr-2 font-medium text-gray-900">{org.name}</span>
              <Count n={org.people.length} label={org.people.length === 1 ? 'person' : 'people'} />{' '}
              <Count n={org.modules.length} label={org.modules.length === 1 ? 'module' : 'modules'} />
              {org.pending > 0 && <> <Count n={org.pending} label="pending" /></>}
            </summary>
            <div className="ml-4 border-l border-gray-200 pl-3">
              <details>
                <summary className={summaryCls}>
                  <span className="mr-2 text-sm font-medium text-gray-800">Modules</span>
                  <Count n={org.modules.length} label="on" />
                </summary>
                {org.modules.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-gray-500">No modules switched on.</p>
                ) : (
                  org.modules.map((m) => <PairNode key={m.moduleKey} p={m} label={m.moduleName} />)
                )}
              </details>
              <details>
                <summary className={summaryCls}>
                  <span className="mr-2 text-sm font-medium text-gray-800">People</span>
                  <Count n={org.people.length} label="active" />
                </summary>
                <People people={org.people} />
              </details>
            </div>
          </details>
        ))}
      </section>

      <section className="mb-8 rounded-lg border border-gray-200 bg-white p-4" data-testid="overview-by-module">
        <h2 className="mb-1 text-sm font-semibold text-gray-700">By module</h2>
        <p className="mb-2 text-xs text-gray-500">
          The count on each module is distinct people: someone who uses it through two organizations counts once here
          and appears under both organizations below.
        </p>
        {o.byModule.map((mod) => (
          <details key={mod.key} className="mb-1" data-testid="overview-module">
            <summary className={summaryCls}>
              <span className="mr-2 font-medium text-gray-900">{mod.name}</span>
              <Count n={mod.distinctPeople} label={mod.distinctPeople === 1 ? 'person' : 'people'} />{' '}
              <Count n={mod.orgs.length} label={mod.orgs.length === 1 ? 'org' : 'orgs'} />
            </summary>
            {mod.orgs.length === 0 ? (
              <p className="ml-4 px-2 py-1 text-xs text-gray-500">No organization has this module on.</p>
            ) : (
              mod.orgs.map((p) => <PairNode key={p.orgId} p={p} label={p.orgName} />)
            )}
          </details>
        ))}
      </section>

      <p className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
        <strong>How these are counted.</strong> Only active members count; pending invitations are listed separately.
        A person is counted in a module for an organization when that organization has the module on and they are an
        active member of it. &ldquo;With a role&rdquo; is the smaller number who hold an explicit role in that module.
        Names are display names; people who never set one show as &ldquo;Unnamed member&rdquo;.
      </p>
    </div>
  )
}
