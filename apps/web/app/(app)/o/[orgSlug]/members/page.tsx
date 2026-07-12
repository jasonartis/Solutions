import Link from 'next/link'
import { moduleRegistry } from '@platform/core'
import { requireOrgAdmin } from '@/lib/platform'
import OrgMembersPanel, { type OrgMemberRow } from '@/components/org-members-panel'
import { addMember, addModuleRole, changeRole, removeMember, removeModuleRoleAction } from './actions'

// Org self-management (docs/03 "Control hierarchy" level 2, founder ask
// 2026-07-12): the org owner/admin layer of the three-level hierarchy —
// add/remove members of their own org, change org roles, and grant/revoke
// module-specific roles for modules already enabled here. Module
// ENABLEMENT itself stays superadmin-only (Owner Console) — deliberately
// not touched by this page or its RLS.
export default async function MembersPage(props: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await props.params
  const { supabase, org } = await requireOrgAdmin(orgSlug)

  const [{ data: members }, { data: profiles }, { data: entitlements }, { data: moduleRoles }] = await Promise.all([
    supabase.from('org_members').select('user_id, role').eq('org_id', org.id),
    supabase.from('profiles').select('user_id, display_name, email'),
    supabase.from('org_modules').select('module_key').eq('org_id', org.id).eq('enabled', true),
    supabase.from('module_roles').select('user_id, module_key, role').eq('org_id', org.id),
  ])

  const enabledModules = (entitlements ?? [])
    .map((e) => moduleRegistry.find((m) => m.key === e.module_key))
    .filter((m): m is (typeof moduleRegistry)[number] => Boolean(m))
    .map((m) => ({ key: m.key, name: m.name, roles: m.roles }))

  const rows: OrgMemberRow[] = (members ?? []).map((mem) => {
    const profile = (profiles ?? []).find((p) => p.user_id === mem.user_id)
    const myModuleRoles = (moduleRoles ?? [])
      .filter((r) => r.user_id === mem.user_id)
      .map((r) => ({
        moduleKey: r.module_key,
        moduleName: moduleRegistry.find((m) => m.key === r.module_key)?.name ?? r.module_key,
        role: r.role,
      }))
    return {
      userId: mem.user_id,
      displayName: profile?.display_name ?? null,
      email: profile?.email ?? null,
      orgRole: mem.role,
      moduleRoles: myModuleRoles,
    }
  })

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <div className="mb-6 flex items-baseline gap-4">
        <h1 className="text-2xl font-semibold">Members</h1>
        <Link href="/dashboard" className="text-sm text-blue-600 hover:underline">
          ← Dashboard
        </Link>
      </div>
      <p className="mb-6 max-w-2xl text-sm text-gray-500">
        Add people to this organization and grant module-specific roles (professor, matchmaker,
        cashier, etc.) for modules already enabled here. Which modules are enabled is set by the
        platform owner, not from this page.
      </p>

      <OrgMembersPanel
        members={rows}
        enabledModules={enabledModules}
        addMemberAction={addMember.bind(null, orgSlug)}
        changeRoleAction={changeRole.bind(null, orgSlug)}
        removeMemberAction={removeMember.bind(null, orgSlug)}
        addModuleRoleAction={addModuleRole.bind(null, orgSlug)}
        removeModuleRoleAction={removeModuleRoleAction.bind(null, orgSlug)}
      />
    </div>
  )
}
