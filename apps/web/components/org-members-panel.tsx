import type { ReactNode } from 'react'
import type { ActionResult } from '@/lib/org-members'
import ModuleRoleForm from './module-role-form'
import { RemoveMemberButton, RoleChangeForm } from './org-member-controls'


// Org role ranks mirror org_role_rank() in the DB (migration 20260717010000).
// superadmin = 4 is the caller-rank the console passes; it isn't an org role.
const ORG_ROLES = ['member', 'admin', 'owner'] as const
const ORG_ROLE_RANK: Record<string, number> = { member: 1, admin: 2, owner: 3 }
export const SUPERADMIN_RANK = 4

export type OrgMemberRow = {
  userId: string
  displayName: string | null
  email: string | null
  orgRole: string
  // Slice 3: 'pending' until the invited user accepts, else 'active'.
  status: 'pending' | 'active'
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
  /** Used in the Remove confirmation: "Remove Alice from <orgName>?" */
  orgName: string
  changeRoleAction: (formData: FormData) => Promise<ActionResult>
  removeMemberAction: (userId: string) => Promise<ActionResult>
  addModuleRoleAction: (formData: FormData) => Promise<void>
  removeModuleRoleAction: (userId: string, moduleKey: string, role: string) => Promise<void>
  // The caller's own rank in this org (owner=3, admin=2; the superadmin
  // console passes SUPERADMIN_RANK=4). Drives which rows are manageable and
  // which target roles are offerable — you can only manage a seat you
  // strictly outrank, and only assign roles below your own. This mirrors the
  // org_members_guard_hierarchy trigger (20260717010000) so the UI never
  // shows a control that would only error.
  callerRank: number
  // The "invite someone" area (docs/25: invites by ADDRESS, whether or not the
  // person has an account yet). Both callers pass components/org-invite-section
  // — there is deliberately no second, built-in add form here to drift from it.
  addMemberSlot: ReactNode
}) {
  const nameOf = (m: OrgMemberRow) => m.displayName || m.email || m.userId
  // Roles the caller may assign: strictly below their own rank.
  const assignableRoles = ORG_ROLES.filter((r) => ORG_ROLE_RANK[r] < props.callerRank)

  return (
    <div>
      {/* Founder decision (2026-07-17): a real rank ladder now. */}
      <p className="mb-3 max-w-xl text-xs text-gray-500">
        Organization roles form a ladder: <span className="font-medium">Owner</span> &gt;{' '}
        <span className="font-medium">Admin</span> &gt; <span className="font-medium">Member</span>. Each
        level manages the levels below it — an owner manages admins and members, an admin manages
        members. You can&apos;t change your own role or anyone at or above your level (only a higher
        level, or the platform owner, can). An org can never be left with zero owner/admin.
      </p>
      <ul className="mb-4 space-y-2">
        {props.members.map((m) => {
          // You may manage this row only if you strictly outrank it. Your own
          // row (equal rank) is never manageable — self-demote/remove is
          // blocked (org_members_guard_hierarchy). The assignable-roles list
          // is already capped below your rank, so a manageable row's current
          // role is always in it.
          const canManage = props.callerRank > (ORG_ROLE_RANK[m.orgRole] ?? 0)
          return (
          <li key={m.userId} className="rounded border border-gray-200 bg-white p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm">
                <span className="font-medium">{nameOf(m)}</span>
                {m.email && <span className="ml-2 text-xs text-gray-400">{m.email}</span>}
                {m.status === 'pending' && (
                  <span
                    title="Invited but not yet accepted — they aren't a member and can't see anything in this org until they accept."
                    className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700"
                  >
                    invited · pending
                  </span>
                )}
              </span>
              <span className="flex items-center gap-2">
                {canManage ? (
                  <>
                    <RoleChangeForm
                      userId={m.userId}
                      savedRole={m.orgRole}
                      roles={assignableRoles}
                      action={props.changeRoleAction}
                    />
                    <RemoveMemberButton
                      userId={m.userId}
                      personName={nameOf(m)}
                      orgName={props.orgName}
                      isPending={m.status === 'pending'}
                      action={props.removeMemberAction}
                    />
                  </>
                ) : (
                  <span className="text-xs uppercase text-gray-400">{m.orgRole}</span>
                )}
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
          )
        })}
        {props.members.length === 0 && <li className="text-sm text-gray-400">No members yet.</li>}
      </ul>

      {props.addMemberSlot}

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
