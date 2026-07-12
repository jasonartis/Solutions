import ModuleRoleForm from './module-role-form'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'
const btnCls = 'rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700'

export type OrgMemberRow = {
  userId: string
  displayName: string | null
  email: string | null
  orgRole: string
  moduleRoles: { moduleKey: string; moduleName: string; role: string }[]
}

// Shared member-management UI (2026-07-12, docs/03 "Control hierarchy" level
// 2) — rendered by BOTH the org self-management page (org owner/admin,
// their own org only) and the superadmin Owner Console (every org). One
// place to change a label/tooltip/field so both surfaces update together,
// per the founder's explicit ask. Plain server-renderable forms wired to
// whatever bound server actions the caller passes in — this component
// doesn't know or care who's authorized to call them; that's each caller's
// own gate (requireOrgAdmin vs requireSuperadmin), with RLS as the real
// ceiling either way.
export default function OrgMembersPanel(props: {
  members: OrgMemberRow[]
  enabledModules: { key: string; name: string; roles: readonly string[] }[]
  addMemberAction: (formData: FormData) => Promise<void>
  changeRoleAction: (formData: FormData) => Promise<void>
  removeMemberAction: (userId: string) => Promise<void>
  addModuleRoleAction: (formData: FormData) => Promise<void>
  removeModuleRoleAction: (userId: string, moduleKey: string, role: string) => Promise<void>
}) {
  const nameOf = (m: OrgMemberRow) => m.displayName || m.email || m.userId

  return (
    <div>
      <ul className="mb-4 space-y-2">
        {props.members.map((m) => (
          <li key={m.userId} className="rounded border border-gray-200 bg-white p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm">
                <span className="font-medium">{nameOf(m)}</span>
                {m.email && <span className="ml-2 text-xs text-gray-400">{m.email}</span>}
              </span>
              <span className="flex items-center gap-2">
                <form action={props.changeRoleAction} className="flex items-center gap-1">
                  <input type="hidden" name="userId" value={m.userId} />
                  <select name="role" defaultValue={m.orgRole} className={`${inputCls} text-xs`}>
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                    <option value="owner">owner</option>
                  </select>
                  <button className="text-xs text-blue-600 hover:underline">Update</button>
                </form>
                <form action={props.removeMemberAction.bind(null, m.userId)}>
                  <button className="px-1 py-1.5 text-xs text-red-600 hover:underline">Remove</button>
                </form>
              </span>
            </div>
            {m.moduleRoles.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-2">
                {m.moduleRoles.map((mr) => (
                  <li
                    key={`${mr.moduleKey}-${mr.role}`}
                    className="flex items-center gap-1 rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-700"
                  >
                    {mr.moduleName}: {mr.role}
                    <form action={props.removeModuleRoleAction.bind(null, m.userId, mr.moduleKey, mr.role)}>
                      <button className="text-blue-400 hover:text-red-600" title="Remove this role" aria-label="Remove this role">
                        ×
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
        {props.members.length === 0 && <li className="text-sm text-gray-400">No members yet.</li>}
      </ul>

      <h3 className="mb-2 text-sm font-medium text-gray-600">Add a member</h3>
      <form action={props.addMemberAction} className="mb-6 flex flex-wrap items-center gap-2">
        <input name="email" type="email" required placeholder="email@example.com" className={`${inputCls} w-56`} />
        <select name="role" className={inputCls} defaultValue="member">
          <option value="member">member</option>
          <option value="admin">admin</option>
          <option value="owner">owner</option>
        </select>
        <button className={btnCls}>Add</button>
      </form>

      {props.enabledModules.length > 0 && (
        <>
          <h3 className="mb-2 text-sm font-medium text-gray-600">Grant a module role</h3>
          <ModuleRoleForm
            action={props.addModuleRoleAction}
            modules={props.enabledModules}
            members={props.members.map((m) => ({ userId: m.userId, label: nameOf(m) }))}
          />
        </>
      )}
    </div>
  )
}
