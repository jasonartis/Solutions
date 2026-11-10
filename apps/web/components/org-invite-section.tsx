import type { SupabaseClient } from '@supabase/supabase-js'
import { moduleRegistry } from '@platform/core'
import {
  listPendingAddressInvites,
  PENDING_INVITE_WAITING_ON,
  type OrgMemberProfile,
  type PendingAddressInviteRow,
} from '@/lib/org-members'
import { addMember, cancelInvite, resendInvite } from '@/app/(app)/o/[orgSlug]/members/actions'
import OrgInviteForm from './org-invite-form'

// THE ONE "INVITE SOMEONE + INVITATIONS WAITING" SECTION (founder, 2026-11-10).
// Rendered by the org's Members page AND by each org card on the Owner Console,
// so a change here — wording, fields, the list, what Cancel/Resend do — reaches
// both. It loads its own data and binds the org's own actions, so a caller only
// says WHICH org and WHO is looking:
//   - org admin page:  callerRank 2 or 3
//   - Owner Console:   callerRank SUPERADMIN_RANK (4) + allowImmediate
// The actions re-check is_org_admin (true for the superadmin) and the database
// is the real ceiling either way (docs/25).

const ORG_RANK: Record<string, number> = { member: 1, admin: 2, owner: 3 }

function daysLeft(expiresAt: string): number {
  return Math.ceil((new Date(expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000))
}

export default async function OrgInviteSection(props: {
  supabase: SupabaseClient
  orgId: string
  orgSlug: string
  callerRank: number
  enabledModules: { key: string; name: string; roles: readonly string[] }[]
  /** Platform superadmin only: also offer "add active immediately". */
  allowImmediate?: boolean
  immediateDefault?: boolean
}) {
  const { supabase, orgId, orgSlug, callerRank } = props

  // Invitations held for an ADDRESS (docs/25). RLS shows them to org admins
  // only (the superadmin counts as one). The pruner timestamp is docs/03 hard
  // rule 5's "something renders whether the job has run". Names come from the
  // admin-scoped definer, which also covers pending people.
  const [invites, { data: prunerLastRun }, { data: profiles }] = await Promise.all([
    listPendingAddressInvites(supabase, orgId),
    supabase.rpc('pending_invites_pruner_last_run'),
    supabase.rpc('org_member_profiles', { check_org_id: orgId }),
  ])
  const memberProfiles = (profiles ?? []) as OrgMemberProfile[]
  const nameOf = (userId: string) => {
    const p = memberProfiles.find((x) => x.user_id === userId)
    return p?.display_name || p?.email || 'A former admin'
  }

  return (
    <>
      <OrgInviteForm
        action={addMember.bind(null, orgSlug)}
        roles={(['member', 'admin', 'owner'] as const).filter((r) => ORG_RANK[r]! < callerRank)}
        modules={props.enabledModules}
        allowImmediate={props.allowImmediate}
        immediateDefault={props.immediateDefault}
      />
      <PendingAddressInvites
        invites={invites}
        nameOf={nameOf}
        callerRank={callerRank}
        cancelAction={(id) => cancelInvite.bind(null, orgSlug, id)}
        resendAction={(id) => resendInvite.bind(null, orgSlug, id)}
        prunerLastRun={(prunerLastRun as string | null) ?? null}
      />
    </>
  )
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
