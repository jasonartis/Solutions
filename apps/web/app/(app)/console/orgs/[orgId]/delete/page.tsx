import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireSuperadmin } from '@/lib/platform'
import { blockingRows, unlinkedRows } from '@/lib/org-delete'
import { deleteOrg, getOrgDeleteImpact } from '../../../actions'

// The delete-an-org confirmation screen (migration 20260928010000, docs/18 item 8).
//
// WHY A PAGE AND NOT A BUTTON ON THE CONSOLE. Two reasons, one practical and
// one about care. Practically, the impact query counts rows across ~68 tables
// for ONE org — doing that for every org on the console list would be dozens of
// queries per render. And a destructive action deserves its own screen showing
// what it would do, rather than a confirm dialog next to a rename box.
//
// IT REFUSES rather than warning when the org holds real data. Deleting an org
// cascades across 67 tables with no rehearsed way back (backups are a nightly
// whole-database dump; extracting one tenant from it has never been done). The
// rule is WhatsApp's — you cannot delete a group until it is empty — not
// Slack's "type your password and it is gone".

export default async function DeleteOrgPage(props: {
  params: Promise<{ orgId: string }>
  searchParams: Promise<{ error?: string }>
}) {
  const { orgId } = await props.params
  const { error } = await props.searchParams
  const { supabase } = await requireSuperadmin()

  const { data: org } = await supabase
    .from('orgs')
    .select('id, name, slug')
    .eq('id', orgId)
    .maybeSingle()
  if (!org) notFound()

  const impact = await getOrgDeleteImpact(orgId)
  const blocking = blockingRows(impact)
  const unlinked = unlinkedRows(impact)
  const setup = impact.filter((r) => !blocking.includes(r) && !unlinked.includes(r))

  return (
    <div className="max-w-3xl">
      <Link href="/console" className="text-sm text-blue-600 hover:underline">
        ← Owner Console
      </Link>
      <h1 className="mt-2 mb-1 text-2xl font-semibold">Delete {org.name}</h1>
      <p className="mb-6 text-sm text-gray-400">
        <code>/{org.slug}</code>
      </p>

      {error && (
        <p className="mb-6 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>
      )}

      {blocking.length > 0 ? (
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-5">
          <h2 className="mb-2 font-medium text-amber-900">This organization can&apos;t be deleted here</h2>
          <p className="mb-3 text-sm text-amber-800">
            It holds data that people have actually put into it. Deleting it would destroy the
            following permanently, and there is no tested way to get one organization&apos;s data
            back out of a backup:
          </p>
          <ul className="mb-3 space-y-1 text-sm text-amber-900">
            {blocking.map((r) => (
              <li key={r.table_name}>
                <span className="font-mono text-xs">{r.table_name}</span> — {r.row_count}{' '}
                {r.row_count === 1 ? 'row' : 'rows'}
              </li>
            ))}
          </ul>
          <p className="text-sm text-amber-800">
            This screen exists for undoing a setup mistake, not for offboarding a client. If you
            genuinely need to remove an organization that has been used, that should be done
            deliberately with a backup taken first — ask for help rather than forcing it.
          </p>
        </section>
      ) : (
        <section className="rounded-lg border border-gray-200 bg-white p-5">
          <h2 className="mb-3 font-medium">What will be deleted</h2>
          {setup.length === 0 ? (
            <p className="mb-4 text-sm text-gray-500">
              Nothing but the organization record itself — it has no members, modules or data.
            </p>
          ) : (
            <ul className="mb-4 space-y-1 text-sm text-gray-700">
              {setup.map((r) => (
                <li key={r.table_name}>
                  <span className="font-mono text-xs">{r.table_name}</span> — {r.row_count}{' '}
                  {r.row_count === 1 ? 'row' : 'rows'}
                </li>
              ))}
            </ul>
          )}

          {unlinked.length > 0 && (
            <p className="mb-4 text-sm text-gray-500">
              Kept, but no longer linked to any organization:{' '}
              {unlinked.map((r) => `${r.table_name} (${r.row_count})`).join(', ')}.
            </p>
          )}

          {/* Stated because the inventory above cannot see it, and a list that
              looks complete is worse than one that admits a gap. */}
          <p className="mb-4 rounded border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
            <strong>Not included above:</strong> uploaded files (submitted homework, exported
            schedules, shared images) live in file storage rather than in the database. They are
            not deleted by this and would be left behind.
          </p>

          <form action={deleteOrg.bind(null, org.id)} className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1 block text-gray-700">
                Type <code className="font-mono text-xs">{org.slug}</code> to confirm
              </span>
              <input
                name="confirmSlug"
                autoComplete="off"
                required
                className="rounded border border-gray-300 px-3 py-2 font-mono text-sm"
              />
            </label>
            <button className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700">
              Delete permanently
            </button>
          </form>
          <p className="mt-3 text-xs text-gray-400">This cannot be undone.</p>
        </section>
      )}
    </div>
  )
}
