import Link from 'next/link'
import { moduleRegistry } from '@platform/core'
import { requireOrgAdmin } from '@/lib/platform'
import {
  listPendingAddressInvites,
  PENDING_INVITE_WAITING_ON,
  type OrgMemberProfile,
  type PendingAddressInviteRow,
} from '@/lib/org-members'
import OrgMembersPanel, { type OrgMemberRow } from '@/components/org-members-panel'
import {
  addMember,
  addModuleRole,
  cancelInvite,
  changeRole,
  removeMember,
  removeModuleRoleAction,
  resendInvite,
} from './actions'
import InviteForm from './invite-form'

// Org self-management (docs/03 "Control hierarchy" level 2, founder ask
// 2026-07-12): the org owner/admin layer of the three-level hierarchy —
// add/remove members of their own org, change org roles, and grant/revoke
// module-specific roles for modules already enabled here. Module
// ENABLEMENT itself stays superadmin-only (Owner Console) — deliberately
// not touched by this page or its RLS.
export default async function MembersPage(props: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await props.params
  const { supabase, org } = await requireOrgAdmin(orgSlug)
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const [{ data: members }, { data: profiles }, { data: entitlements }, { data: moduleRoles }] = await Promise.all([
    supabase.from('org_members').select('user_id, role, status').eq('org_id', org.id),
    // Member identities via the admin-scoped definer: a PENDING invitee's
    // profile isn't visible through shares_org_with (active-only), so the broad
    // profiles read would show pending rows as a bare UUID. This returns
    // name/email for every member (active + pending) of an org the caller admins.
    supabase.rpc('org_member_profiles', { check_org_id: org.id }),
    supabase.from('org_modules').select('module_key').eq('org_id', org.id).eq('enabled', true),
    supabase.from('module_roles').select('user_id, module_key, role').eq('org_id', org.id),
  ])

  // Invitations held for an ADDRESS (docs/25). RLS shows them to org admins
  // only. The pruner timestamp is docs/03 hard rule 5's "something renders
  // whether the job has run".
  const [addressInvites, { data: prunerLastRun }] = await Promise.all([
    listPendingAddressInvites(supabase, org.id),
    supabase.rpc('pending_invites_pruner_last_run'),
  ])

  const enabledModules = (entitlements ?? [])
    .map((e) => moduleRegistry.find((m) => m.key === e.module_key))
    .filter((m): m is (typeof moduleRegistry)[number] => Boolean(m))
    .map((m) => ({ key: m.key, name: m.name, roles: m.roles }))

  // The caller's own rank drives which rows/roles they can manage (mirrors
  // org_members_guard_hierarchy). requireOrgAdmin already guaranteed owner
  // or admin; a superadmin who isn't a member still sees this page via that
  // gate, so fall back to owner-level (3) for them.
  const myRole = (members ?? []).find((mem) => mem.user_id === user?.id)?.role
  const callerRank = myRole === 'owner' ? 3 : myRole === 'admin' ? 2 : 3

  // rpc() has no generated row type for a definer, so name the shape once here.
  const memberProfiles = (profiles ?? []) as OrgMemberProfile[]

  const rows: OrgMemberRow[] = (members ?? []).map((mem) => {
    const profile = memberProfiles.find((p) => p.user_id === mem.user_id)
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
      status: (mem.status ?? 'active') as 'pending' | 'active',
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
        changeRoleAction={changeRole.bind(null, orgSlug)}
        removeMemberAction={removeMember.bind(null, orgSlug)}
        addModuleRoleAction={addModuleRole.bind(null, orgSlug)}
        removeModuleRoleAction={removeModuleRoleAction.bind(null, orgSlug)}
        callerRank={callerRank}
        addMemberSlot={
          <>
            <InviteForm
              action={addMember.bind(null, orgSlug)}
              roles={(['member', 'admin', 'owner'] as const).filter((r) => ORG_RANK[r] < callerRank)}
              modules={enabledModules}
            />
            <PendingAddressInvites
              invites={addressInvites}
              nameOf={(userId) => {
                const p = memberProfiles.find((x) => x.user_id === userId)
                return p?.display_name || p?.email || 'A former admin'
              }}
              callerRank={callerRank}
              cancelAction={(id) => cancelInvite.bind(null, orgSlug, id)}
              resendAction={(id) => resendInvite.bind(null, orgSlug, id)}
              prunerLastRun={(prunerLastRun as string | null) ?? null}
            />
          </>
        }
      />
    </div>
  )
}

const ORG_RANK: Record<string, number> = { member: 1, admin: 2, owner: 3 }

function daysLeft(expiresAt: string): number {
  return Math.ceil((new Date(expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000))
}

function PendingAddressInvites(props: {
  invites: PendingAddressInviteRow[]
  nameOf: (userId: string) => string
  callerRank: number
  cancelAction: (id: string) => () => Promise<void>
  resendAction: (id: string) => () => Promise<void>
  prunerLastRun: string | null
}) {
  return (
    <div className="mb-6">
      <h3 className="mb-2 text-sm font-medium text-gray-600">Invitations waiting to be used</h3>
      {props.invites.length === 0 ? (
        <p className="text-sm text-gray-400">None right now.</p>
      ) : (
        <ul className="space-y-2">
          {props.invites.map((inv) => {
            const left = daysLeft(inv.expires_at)
            // Mirrors the database: any org admin may CANCEL (docs/25 §6 answer
            // 3); RESEND re-issues, so it needs the issue rule — the inviter, or
            // someone who outranks the invited role. The database decides either way.
            // A module role or chat invitation is resent by any org admin.
            const canResend = inv.kind !== 'org' || props.callerRank > (ORG_RANK[inv.role] ?? 0)
            const moduleName = moduleRegistry.find((m) => m.key === inv.module_key)?.name ?? inv.module_key
            const what =
              inv.kind === 'org'
                ? `to the organization as ${inv.role}`
                : inv.kind === 'module_role'
                  ? `${moduleName}: ${inv.role}, given when they accept`
                  : `to the conversation “${inv.target_title ?? 'a removed conversation'}”`
            return (
              <li
                key={inv.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-dashed border-gray-300 bg-white p-3"
              >
                <span className="text-sm">
                  <span className="font-medium">{inv.email}</span>
                  <span className="ml-2 text-xs text-gray-500">{what}</span>
                  <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                    {PENDING_INVITE_WAITING_ON[inv.waiting_on ?? ''] ?? 'invited · pending'}
                  </span>
                  <span className="ml-2 text-xs text-gray-400">
                    by {props.nameOf(inv.invited_by)} ·{' '}
                    {left <= 0 ? 'expired' : left === 1 ? 'expires within a day' : `expires in ${left} days`}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  {canResend && (
                    <form action={props.resendAction(inv.id)}>
                      <button className="text-xs text-blue-600 hover:underline">Resend (30 more days)</button>
                    </form>
                  )}
                  <form action={props.cancelAction(inv.id)}>
                    <button className="text-xs text-red-600 hover:underline">Cancel</button>
                  </form>
                </span>
              </li>
            )
          })}
        </ul>
      )}
      <p className="mt-2 max-w-xl text-xs text-gray-400">
        An invitation and the address in it are deleted when it is used, cancelled, or 30 days after it was last sent.
        {props.prunerLastRun
          ? ` Expired invitations were last cleared ${new Date(props.prunerLastRun).toLocaleString()}.`
          : ' Expired invitations have not been cleared yet.'}
      </p>
    </div>
  )
}
