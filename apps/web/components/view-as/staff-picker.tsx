import { PageHeader } from '@/components/page-header'
import { getModule } from '@platform/core'
import { requireOrgModule } from '@/lib/module-gate'

// STAFF "View as" — the in-module picker (docs/13 "STAFF VIEW AS"; founder answer 4A,
// 2026-11-26: the real screen REPLACES the table-style in-module view, and its
// "as if I held that position" tabs are retired).
//
// Lists the people the caller may view in this module (view_as_staff_targets: the
// same database rule that starts and re-checks every view). Picking one is a plain
// form POST to /view-as/start (a route handler, so the first viewed screen is a full
// page load through the proxy). This page is never itself viewed: the database keeps
// /m/<module>/view-as out of a staff view's scope.

type Props = {
  moduleKey: string
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ error?: string; ended?: string }>
  /** The module home's exact heading, when it is not just the manifest name (nail-salon adds the location). */
  homeHeading?: string
}

// Only these messages are shown as given (they come from view_as_staff_start or the start
// route); anything else in ?error= is replaced, so a crafted link cannot put text here.
const START_ERRORS = ["You can't view this person's screen", 'Choose someone else to view', 'View as is not configured on this server.']

type Target = { user_id: string; display_name: string | null; roles: string[] | null }

export async function StaffViewAsPicker({ moduleKey, params, searchParams, homeHeading }: Props) {
  const { orgSlug } = await params
  const { error, ended } = await searchParams
  const { supabase, org } = await requireOrgModule(orgSlug, moduleKey)
  const manifest = getModule(moduleKey)!
  const base = `/o/${orgSlug}/m/${moduleKey}`

  const { data, error: listError } = await supabase.rpc('view_as_staff_targets', {
    p_org: org.id,
    p_module: moduleKey,
  })
  const targets = (data ?? []) as Target[]

  return (
    <div>
      <PageHeader
        eyebrow={org.name}
        back={{ href: base, label: homeHeading ?? manifest.name }}
        title="View as"
        className="mb-4"
      />
      <p className="mb-4 max-w-2xl text-sm text-gray-600">
        See a person&rsquo;s screen exactly as they see it, limited to the parts of {manifest.name} you oversee.
        It is read-only: nothing can be changed while you are viewing.
      </p>

      {ended && (
        <p className="mb-4 rounded border border-gray-200 bg-white p-3 text-sm text-gray-700" data-testid="view-as-ended">
          Your view ended.
        </p>
      )}
      {error && (
        <p className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {START_ERRORS.includes(error) ? error : 'Could not start the view.'}
        </p>
      )}
      {listError && (
        <p className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          Could not load the people you can view.
        </p>
      )}

      {!listError && targets.length === 0 ? (
        <p className="text-gray-500">There is no one in {manifest.name} whose screen you can view.</p>
      ) : (
        <ul className="divide-y divide-gray-200 rounded border border-gray-200 bg-white" data-testid="view-as-targets">
          {targets.map((t) => (
            <li key={t.user_id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div>
                <span className="font-medium">{t.display_name || 'Unnamed member'}</span>
                {t.roles && t.roles.length > 0 && (
                  <span className="ml-2 text-xs uppercase tracking-wide text-gray-500">{t.roles.join(', ')}</span>
                )}
              </div>
              <form action="/view-as/start" method="post">
                <input type="hidden" name="kind" value="staff" />
                <input type="hidden" name="org" value={org.id} />
                <input type="hidden" name="slug" value={orgSlug} />
                <input type="hidden" name="module" value={moduleKey} />
                <input type="hidden" name="target" value={t.user_id} />
                <button
                  type="submit"
                  className="rounded border border-blue-600 px-3 py-1 text-sm text-blue-700 hover:bg-blue-50"
                >
                  View {t.display_name || 'this person'}&rsquo;s screen
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
