import Link from 'next/link'
import { requireOrgAdmin } from '@/lib/platform'
import SynagogueLocationFields, { type SynagogueSettings } from '@/components/synagogue-location-fields'
import { updateModuleSettings } from './actions'

// Org self-serve module settings (founder item 2, 2026-07-12): the org's own
// owner/admin edits module CONFIG here (e.g. the synagogue's location) —
// "whoever fills in the synagogue info should enter it." Which modules are
// ENABLED stays a platform-owner decision (superadmin Owner Console); the
// org_modules_pin_enablement trigger enforces that even below the UI.
export default async function OrgSettingsPage(props: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await props.params
  const { supabase, org } = await requireOrgAdmin(orgSlug)

  const { data: entitlements } = await supabase
    .from('org_modules')
    .select('module_key, settings')
    .eq('org_id', org.id)
    .eq('enabled', true)

  const synagogue = (entitlements ?? []).find((e) => e.module_key === 'synagogue-schedules')
  const hasEditableSettings = Boolean(synagogue)

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <div className="mb-6 flex items-baseline gap-4">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <Link href="/dashboard" className="text-sm text-blue-600 hover:underline">
          ← Dashboard
        </Link>
      </div>
      <p className="mb-6 max-w-2xl text-sm text-gray-500">
        Configure the modules enabled for this organization. Which modules are enabled is set by
        the platform owner, not from this page.
      </p>

      {!hasEditableSettings && (
        <p className="text-sm text-gray-400">None of this organization&apos;s modules have editable settings yet.</p>
      )}

      {synagogue && (
        <section className="rounded-lg border border-gray-200 bg-white p-5">
          <h2 className="mb-1 text-lg font-medium">Synagogue Schedules — location</h2>
          <p className="mb-4 max-w-2xl text-sm text-gray-500">
            Where this synagogue is: used to compute zmanim for every schedule. The myzmanim
            location ID (e.g. a US zip code like US11210) selects the same location on
            myzmanim.com.
          </p>
          <form
            action={updateModuleSettings.bind(null, orgSlug, 'synagogue-schedules')}
            className="flex flex-wrap items-end gap-2"
          >
            <SynagogueLocationFields settings={synagogue.settings as SynagogueSettings | undefined} />
            <button className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700">
              Save location
            </button>
          </form>
        </section>
      )}
    </div>
  )
}
