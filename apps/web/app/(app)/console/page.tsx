import { notFound } from 'next/navigation'
import { moduleRegistry } from '@platform/core'
import { createClient } from '@/lib/supabase/server'
import { getProfile } from '@/lib/platform'
import OrgMembersPanel, { SUPERADMIN_RANK, type OrgMemberRow } from '@/components/org-members-panel'
import SynagogueLocationFields, { type SynagogueSettings } from '@/components/synagogue-location-fields'
import {
  addMember,
  addModuleRole,
  changeRole,
  createOrg,
  removeMember,
  removeModuleRoleAction,
  renameOrg,
  toggleModule,
  updateSynagogueSettings,
} from './actions'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'

export default async function ConsolePage() {
  const profile = await getProfile()
  if (!profile?.is_superadmin) notFound()

  const supabase = await createClient()
  const [{ data: orgs }, { data: members }, { data: entitlements }, { data: profiles }, { data: moduleRoles }] =
    await Promise.all([
      supabase.from('orgs').select('id, name, slug').order('name'),
      supabase.from('org_members').select('org_id, user_id, role'),
      supabase.from('org_modules').select('org_id, module_key, enabled, settings'),
      supabase.from('profiles').select('user_id, email, display_name'),
      supabase.from('module_roles').select('org_id, user_id, module_key, role'),
    ])

  const profileById = new Map((profiles ?? []).map((p) => [p.user_id, p]))

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Owner Console</h1>

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
      </section>

      <div className="space-y-6">
        {(orgs ?? []).map((org) => {
          const orgMembers = (members ?? []).filter((m) => m.org_id === org.id)
          const orgEntitlements = new Map(
            (entitlements ?? [])
              .filter((e) => e.org_id === org.id)
              .map((e) => [e.module_key, e.enabled]),
          )
          const synSettings = (entitlements ?? []).find(
            (e) => e.org_id === org.id && e.module_key === 'synagogue-schedules',
          )?.settings as SynagogueSettings | undefined
          return (
            <section key={org.id} className="rounded-lg border border-gray-200 bg-white p-5">
              <div className="mb-4 flex items-baseline justify-between">
                <h2 className="text-lg font-medium">{org.name}</h2>
                <code className="text-xs text-gray-400">/{org.slug}</code>
              </div>
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
                <button className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50">
                  Save name
                </button>
                <span className="text-xs text-gray-400">(slug /{org.slug} stays fixed — it's used in existing links)</span>
              </form>

              <h3 className="mb-2 text-sm font-medium text-gray-600">Modules</h3>
              <ul className="mb-4 flex flex-wrap gap-2">
                {moduleRegistry.map((mod) => {
                  const enabled = orgEntitlements.get(mod.key) === true
                  return (
                    <li key={mod.key}>
                      <form
                        action={async () => {
                          'use server'
                          await toggleModule(org.id, mod.key, !enabled)
                        }}
                      >
                        <button
                          className={`rounded border px-3 py-1 text-sm ${
                            enabled
                              ? 'border-green-300 bg-green-50 text-green-700'
                              : 'border-gray-300 bg-gray-50 text-gray-500'
                          }`}
                          title={enabled ? 'Click to disable' : 'Click to enable'}
                        >
                          {mod.name}: {enabled ? 'on' : 'off'}
                        </button>
                      </form>
                    </li>
                  )
                })}
              </ul>

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
                    email: p?.email ?? null,
                    orgRole: m.role,
                    moduleRoles: (moduleRoles ?? [])
                      .filter((r) => r.org_id === org.id && r.user_id === m.user_id)
                      .map((r) => ({
                        moduleKey: r.module_key,
                        moduleName: moduleRegistry.find((mod) => mod.key === r.module_key)?.name ?? r.module_key,
                        role: r.role,
                      })),
                  } satisfies OrgMemberRow
                })}
                enabledModules={moduleRegistry
                  .filter((mod) => orgEntitlements.get(mod.key) === true)
                  .map((mod) => ({ key: mod.key, name: mod.name, roles: mod.roles }))}
                addMemberAction={addMember.bind(null, org.id)}
                changeRoleAction={changeRole.bind(null, org.id)}
                removeMemberAction={removeMember.bind(null, org.id)}
                addModuleRoleAction={addModuleRole.bind(null, org.id)}
                removeModuleRoleAction={removeModuleRoleAction.bind(null, org.id)}
                callerRank={SUPERADMIN_RANK}
              />
            </section>
          )
        })}
      </div>
    </div>
  )
}
