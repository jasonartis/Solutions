'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { acceptOrgInvite, removeOrgMember } from '@/lib/org-members'

// Slice 3 (user model): the invited user's own accept/decline of an org invite,
// from their dashboard. Both run AS THE CALLER (never service-role) so RLS +
// the org_members guards are the real ceiling:
//   * accept  -> org_accept_invite() (definer): verifies the caller owns a live
//     pending invite, revalidates the inviter is still authorized, flips their
//     own seat to active. No admin can do this on the invitee's behalf.
//   * decline -> a plain self-DELETE of the pending row; the delete_self policy
//     opens it and the hierarchy guard's decline/leave carve-out permits it.

export async function acceptInvite(orgId: string) {
  const supabase = await createClient()
  await acceptOrgInvite(supabase, orgId)
  revalidatePath('/dashboard')
}

export async function declineInvite(orgId: string) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')
  await removeOrgMember(supabase, orgId, user.id)
  revalidatePath('/dashboard')
}

// A plain member leaving an org they belong to (§6 self-leave). Same self-DELETE
// as decline; the hierarchy guard's carve-out permits it for a member seat but
// still blocks an active owner/admin from self-removing (they must ask a
// co-admin), and the last-admin floor is enforced independently.
export async function leaveOrg(orgId: string) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')
  await removeOrgMember(supabase, orgId, user.id)
  revalidatePath('/dashboard')
}
