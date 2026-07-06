import { notFound } from 'next/navigation'
import { moduleRegistry } from '@platform/core'
import { createClient } from '@/lib/supabase/server'
import { getProfile } from '@/lib/platform'
import { addMember, createOrg, removeMember, toggleModule } from './actions'

export default async function ConsolePage() {
  const profile = await getProfile()
  if (!profile?.is_superadmin) notFound()

  const supabase = await createClient()
  const [{ data: orgs }, { data: members }, { data: entitlements }, { data: profiles }] =
    await Promise.all([
      supabase.from('orgs').select('id, name, slug').order('name'),
      supabase.from('org_members').select('org_id, user_id, role'),
      supabase.from('org_modules').select('org_id, module_key, enabled'),
      supabase.from('profiles').select('user_id, email, display_name'),
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
          return (
            <section key={org.id} className="rounded-lg border border-gray-200 bg-white p-5">
              <div className="mb-4 flex items-baseline justify-between">
                <h2 className="text-lg font-medium">{org.name}</h2>
                <code className="text-xs text-gray-400">/{org.slug}</code>
              </div>

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

              <h3 className="mb-2 text-sm font-medium text-gray-600">
                Members ({orgMembers.length})
              </h3>
              <ul className="mb-4 space-y-1 text-sm">
                {orgMembers.map((m) => {
                  const p = profileById.get(m.user_id)
                  return (
                    <li key={m.user_id} className="flex items-center gap-3">
                      <span>{p?.display_name || p?.email || m.user_id}</span>
                      <span className="text-xs uppercase text-gray-400">{m.role}</span>
                      <form
                        action={async () => {
                          'use server'
                          await removeMember(org.id, m.user_id)
                        }}
                      >
                        <button className="text-xs text-red-500 hover:underline">remove</button>
                      </form>
                    </li>
                  )
                })}
                {orgMembers.length === 0 && <li className="text-gray-400">No members</li>}
              </ul>

              <form action={addMember} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="orgId" value={org.id} />
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Add member by email</span>
                  <input
                    name="email"
                    type="email"
                    required
                    className="rounded border border-gray-300 px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Role</span>
                  <select name="role" className="rounded border border-gray-300 px-3 py-2">
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                    <option value="owner">owner</option>
                  </select>
                </label>
                <button className="rounded bg-gray-800 px-4 py-2 text-sm font-medium text-white hover:bg-gray-900">
                  Add
                </button>
              </form>
            </section>
          )
        })}
      </div>
    </div>
  )
}
