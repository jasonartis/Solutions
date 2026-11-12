import Link from 'next/link'
import { notFound } from 'next/navigation'
import { moduleRegistry } from '@platform/core'
import { createClient } from '@/lib/supabase/server'
import { getProfile } from '@/lib/platform'
import OrgMembersPanel, { SUPERADMIN_RANK, type OrgMemberRow } from '@/components/org-members-panel'
import OrgInviteSection from '@/components/org-invite-section'
import OrgModuleToggles from '@/components/org-module-toggles'
import OrgExpandControls from '@/components/console-org-controls'
import SynagogueLocationFields, { type SynagogueSettings } from '@/components/synagogue-location-fields'
import ConsoleDashboard from '@/components/console-dashboard'
import { getDashboard } from '@/lib/console-dashboard'
import {
  addModuleRole,
  changeRole,
  createOrg,
  removeMember,
  removeModuleRoleAction,
  renameOrg,
  setAddMemberDefault,
  setInviteCaps,
  applyModuleChanges,
  updateSynagogueSettings,
} from './actions'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'

// Console tools WITHOUT a dashboard tile (see the Tools section below).
const CONSOLE_TOOLS = [
  { href: '/console/data-browser', name: 'Data browser', blurb: 'Everything the platform holds about one person' },
  { href: '/console/view-as', name: 'View as anything', blurb: 'What a position or a person can see in any org' },
  { href: '/console/engagement', name: 'Engagement', blurb: 'Who is using the platform, and who has gone quiet' },
  { href: '/console/zmanim', name: 'Zmanim', blurb: 'Is the next year of prayer-time data covered, and where are the gaps' },
  { href: '/console/positions', name: 'Positions', blurb: 'Every position’s rank, and who can appoint or remove whom' },
  { href: '/console/costs', name: 'Costs', blurb: 'What the platform costs to run, by module and size, and what to charge' },
] as const

export default async function ConsolePage(props: {
  searchParams?: Promise<{ error?: string; expand?: string }>
}) {
  // Expected refusals (a duplicate address, say) arrive here as a query param
  // rather than a thrown error: docs/03 #22 — a server action that THROWS for
  // an expected refusal has its message redacted, so the user sees nothing.
  const { error: actionError, expand } = (await props.searchParams) ?? {}
  // "Expand all" is a link (?expand=all), not client state: the org cards are
  // native <details>, closed by default, and clicking one opens just that one.
  const expandAll = expand === 'all'
  const profile = await getProfile()
  if (!profile?.is_superadmin) notFound()
  // The superadmin's saved default for "add member": immediately-active vs a
  // pending invite (per-profile, slice 3). Pre-checks the per-add toggle below.
  const addActiveDefault = (profile.settings as { superadminDefaultAddActive?: boolean } | null)?.superadminDefaultAddActive === true

  const supabase = await createClient()
  const [{ data: orgs }, { data: members }, { data: entitlements }, { data: profiles }, { data: moduleRoles }] =
    await Promise.all([
      supabase.from('orgs').select('id, name, slug').order('name'),
      supabase.from('org_members').select('org_id, user_id, role, status'),
      supabase.from('org_modules').select('org_id, module_key, enabled, settings'),
      supabase.from('profiles').select('user_id, display_name'),
      supabase.from('module_roles').select('org_id, user_id, module_key, role'),
    ])

  // Addresses no longer live in `profiles` (docs/22 §3 R3). This console is the
  // one surface that legitimately shows another user's, so it asks the
  // superadmin-gated definer for exactly the people it is about to render —
  // never for a directory.
  const { data: emailRows } = await supabase.rpc('superadmin_user_emails', {
    target_user_ids: (profiles ?? []).map((p) => p.user_id),
  })
  const emailById = new Map(
    ((emailRows as { user_id: string; email: string | null }[] | null) ?? []).map((r) => [r.user_id, r.email]),
  )

  const profileById = new Map((profiles ?? []).map((p) => [p.user_id, p]))

  // The database's own fallbacks (100 / 20) when no row has been saved yet.
  const { data: capsRow } = await supabase.from('platform_settings').select('value').eq('key', 'pending_invites.caps').maybeSingle()
  const capsValue = (capsRow?.value ?? {}) as { maxPerInviter?: number; maxPerAddress?: number }
  const inviteCaps = { maxPerInviter: capsValue.maxPerInviter ?? 100, maxPerAddress: capsValue.maxPerAddress ?? 20 }

  const dashboard = await getDashboard(supabase)

  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold">Owner Console</h1>

      {actionError && (
        <p className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {actionError}
        </p>
      )}

      {/* What needs the founder, at a glance (module-9 spec §H). Read-only. */}
      <ConsoleDashboard dashboard={dashboard} />

      {/* Tools that have no tile above. Pages that DO have a tile (Platform overview,
          Content reports, Feedback, Account deletions, Vendor accounts) are opened from
          their tile, which links to the same address, so they are not repeated here.
          Small cards, not status tiles: plain white with a name and one line, so they
          read as "places to go" next to the coloured "things that need you" above. */}
      <nav aria-label="Tools" className="mb-8">
        <h2 className="mb-2 text-lg font-medium">Tools</h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CONSOLE_TOOLS.map((t) => (
            <li key={t.href}>
              <Link
                href={t.href}
                className="block h-full rounded-lg border border-gray-200 bg-white p-3 hover:border-blue-300 hover:bg-blue-50"
              >
                <span className="block text-sm font-medium text-blue-700">{t.name}</span>
                <span className="mt-0.5 block text-xs text-gray-500">{t.blurb}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <section className="mb-8 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-3 text-lg font-medium">Create organization</h2>
        <form action={createOrg} className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block font-medium">Name</span>
            <input name="name" required className="rounded border border-gray-300 px-3 py-2" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Slug</span>
            <input name="slug" required className="rounded border border-gray-300 px-3 py-2" />
          </label>
          <button className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
            Create
          </button>
        </form>

        {/* Superadmin preference: whether "add active immediately" starts ticked on the invite form (slice 3). */}
        <form action={setAddMemberDefault} className="mt-4 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-4">
          <label className="flex items-center gap-1.5 text-xs text-gray-600">
            <input type="checkbox" name="defaultActive" defaultChecked={addActiveDefault} />
            Start “Invite someone” with <span className="font-medium">add active immediately</span> ticked (unticked = send an invitation)
          </label>
          <button className="rounded border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:bg-gray-50">
            Save default
          </button>
        </form>

        {/* Pending-invite limits (docs/25 §6 answer 2). */}
        <form action={setInviteCaps} className="mt-4 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-4 text-xs text-gray-600">
          <span className="font-medium">Invitation limits:</span>
          <label className="flex items-center gap-1">
            at most
            <input name="maxPerInviter" type="number" min={1} defaultValue={inviteCaps.maxPerInviter} className={`${inputCls} w-20`} />
            open per person inviting
          </label>
          <label className="flex items-center gap-1">
            and
            <input name="maxPerAddress" type="number" min={1} defaultValue={inviteCaps.maxPerAddress} className={`${inputCls} w-20`} />
            open for any one email address
          </label>
          <button className="rounded border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:bg-gray-50">
            Save limits
          </button>
        </form>
      </section>

      <div className="mb-3 flex flex-wrap items-baseline gap-3 text-sm">
        <h2 className="text-lg font-medium">Organizations</h2>
        <span className="text-gray-500">{(orgs ?? []).length} · click one to open it</span>
        <OrgExpandControls />
      </div>

      <div className="space-y-3">
        {(orgs ?? []).map((org) => {
          const orgMembers = (members ?? []).filter((m) => m.org_id === org.id)
          const orgEntitlements = new Map(
            (entitlements ?? [])
              .filter((e) => e.org_id === org.id)
              .map((e) => [e.module_key, e.enabled]),
          )
          const enabledMods = moduleRegistry
            .filter((mod) => orgEntitlements.get(mod.key) === true)
            .map((mod) => ({ key: mod.key, name: mod.name, roles: mod.roles }))
          const synSettings = (entitlements ?? []).find(
            (e) => e.org_id === org.id && e.module_key === 'synagogue-schedules',
          )?.settings as SynagogueSettings | undefined
          return (
            <section key={org.id} className="rounded-lg border border-gray-200 bg-white" data-testid="console-org">
              <details open={expandAll} className="group">
                <summary className="flex cursor-pointer list-none flex-wrap items-baseline justify-between gap-2 p-5 hover:bg-gray-50 [&::-webkit-details-marker]:hidden">
                  <span className="flex items-baseline gap-2">
                    <span aria-hidden className="inline-block text-gray-400 transition-transform group-open:rotate-90">▸</span>
                    <h2 className="text-lg font-medium">{org.name}</h2>
                  </span>
                  <span className="text-xs text-gray-500">
                    {orgMembers.filter((m) => (m.status ?? 'active') === 'active').length} members · {enabledMods.length}{' '}
                    {enabledMods.length === 1 ? 'module' : 'modules'} on · <code className="text-gray-400">/{org.slug}</code>
                  </span>
                </summary>
              <div className="px-5 pb-5">
              <form action={renameOrg.bind(null, org.id)} className="mb-4 flex flex-wrap items-center gap-2">
                <label className="text-xs text-gray-500">
                  Rename
                  <input
                    name="name"
                    defaultValue={org.name}
                    required
                    className={`${inputCls} ml-2 w-56`}
                  />
                </label>
                {/* Editable since 2026-09-28, reversing the 2026-07-16 decision
                    that it must not be — see the note on renameOrg. Warned
                    rather than forbidden: a broken link is reversible by
                    setting the address back, whereas leaving a typo
                    unfixable forever is not. */}
                <label className="text-xs text-gray-500">
                  Address
                  <input
                    name="slug"
                    defaultValue={org.slug}
                    className={`${inputCls} ml-2 w-44 font-mono`}
                    title="Changing this breaks any existing link to /o/<address> and the public page /s/<address>"
                  />
                </label>
                <button className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50">
                  Save
                </button>
                <span className="text-xs text-gray-400">
                  changing the address breaks existing links to{' '}
                  <code>/s/{org.slug}</code>
                </span>
                <Link
                  href={`/console/orgs/${org.id}/delete`}
                  className="ml-auto text-xs text-red-600 hover:underline"
                >
                  Delete organization
                </Link>
                <span className="text-xs text-gray-400">(slug /{org.slug} stays fixed — it's used in existing links)</span>
              </form>

              <h3 className="mb-1 text-sm font-medium text-gray-600">Modules</h3>
              <p className="mb-2 text-xs text-gray-400">
                Click a module to stage turning it on or off (it turns amber and nothing happens yet), then press
                Update modules. Green is on, grey is off.
              </p>
              <div className="mb-4">
                <OrgModuleToggles
                  orgName={org.name}
                  modules={moduleRegistry.map((mod) => ({
                    key: mod.key,
                    name: mod.name,
                    enabled: orgEntitlements.get(mod.key) === true,
                  }))}
                  action={applyModuleChanges.bind(null, org.id)}
                />
              </div>

              {orgEntitlements.get('synagogue-schedules') === true && (
                <>
                  <h3 className="mb-2 text-sm font-medium text-gray-600">Synagogue location</h3>
                  <form
                    action={updateSynagogueSettings.bind(null, org.id)}
                    className="mb-4 flex flex-wrap items-end gap-2"
                  >
                    <SynagogueLocationFields settings={synSettings} />
                    <button className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700">
                      Save location
                    </button>
                  </form>
                </>
              )}

              <h3 className="mb-2 text-sm font-medium text-gray-600">
                Members ({orgMembers.length})
              </h3>
              <OrgMembersPanel
                members={orgMembers.map((m) => {
                  const p = profileById.get(m.user_id)
                  return {
                    userId: m.user_id,
                    displayName: p?.display_name ?? null,
                    email: emailById.get(m.user_id) ?? null,
                    orgRole: m.role,
                    status: (m.status ?? 'active') as 'pending' | 'active',
                    moduleRoles: (moduleRoles ?? [])
                      .filter((r) => r.org_id === org.id && r.user_id === m.user_id)
                      .map((r) => ({
                        moduleKey: r.module_key,
                        moduleName: moduleRegistry.find((mod) => mod.key === r.module_key)?.name ?? r.module_key,
                        role: r.role,
                      })),
                  } satisfies OrgMemberRow
                })}
                orgName={org.name}
                enabledModules={enabledMods}
                changeRoleAction={changeRole.bind(null, org.id)}
                removeMemberAction={removeMember.bind(null, org.id)}
                addModuleRoleAction={addModuleRole.bind(null, org.id)}
                removeModuleRoleAction={removeModuleRoleAction.bind(null, org.id)}
                callerRank={SUPERADMIN_RANK}
                // The SAME invite section the org's Members page renders
                // (components/org-invite-section.tsx) — change it there and both
                // change. The superadmin also gets "add active immediately".
                addMemberSlot={
                  <OrgInviteSection
                    supabase={supabase}
                    orgId={org.id}
                    orgSlug={org.slug}
                    callerRank={SUPERADMIN_RANK}
                    enabledModules={enabledMods}
                    allowImmediate
                    immediateDefault={addActiveDefault}
                  />
                }
              />
              </div>
              </details>
            </section>
          )
        })}
      </div>
    </div>
  )
}
