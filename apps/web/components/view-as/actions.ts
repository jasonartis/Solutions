'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { getModule } from '@platform/core'
import { createClient } from '@/lib/supabase/server'
import {
  heldGrants,
  parseGrantKey,
  scopeCovers,
  scopeNodes,
  viewAsCookieName,
} from '@/lib/view-as'

// Mode-2 session lifecycle. There is no "write while acting as" action here and
// there never should be: §8.1 point 2 makes mode 2 READ-ONLY in v1 and until a
// dated decision says otherwise, because any write path would be a forgery
// through staff policies, and two-sided mechanics make forged writes harm THIRD
// parties. No row anywhere may carry an identity column naming someone other
// than the true actor.

export async function startViewAs(orgSlug: string, moduleKey: string, formData: FormData) {
  const grantKey = String(formData.get('grant') ?? '')
  const target = parseGrantKey(grantKey)
  if (!target) throw new Error('Pick someone to view as')

  const manifest = getModule(moduleKey)
  if (!manifest) throw new Error('Unknown module')
  const decl = manifest.viewAs

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')

  const { data: org } = await supabase.from('orgs').select('id').eq('slug', orgSlug).single()
  if (!org) throw new Error('Unknown org')

  // The app-layer gate; the migration's guard trigger is the independent
  // database floor. Both must pass, and neither is derived from the other.
  //
  // ONE grant must satisfy all three conditions — declared edge, strict rank,
  // scope coverage — exactly as the SQL guard requires. Checking them
  // separately with three `.some()` calls would let a caller holding two
  // grants borrow the edge of one and the rank or scope of the other. Not
  // exploitable while the database enforces the same rule, but a laxer app
  // check just means offering a "View as" the insert then refuses.
  const grants = await heldGrants(supabase, org.id, moduleKey, user.id)
  const nodes = await scopeNodes(supabase, org.id, moduleKey)
  const targetRank = decl.positions[target.role]
  if (targetRank === undefined) throw new Error('Unknown position')

  const permitted = grants.some(
    (g) =>
      decl.edges[g.role]?.[target.role]?.mode2 === true &&
      (decl.positions[g.role] ?? 0) > targetRank &&
      scopeCovers(nodes, g.scopeRef, target.scopeRef),
  )
  if (!permitted) {
    throw new Error('No position you hold outranks, covers, and declares an edge to that grant')
  }

  // Creating the log row IS starting the session (§8.1 point 6). actor_user_id,
  // created_at and expires_at are all server-stamped by the guard trigger; the
  // values sent here are placeholders it overwrites.
  const { data: session, error } = await supabase
    .from('view_as_sessions')
    .insert({
      org_id: org.id,
      module_key: moduleKey,
      actor_user_id: user.id,
      target_user_id: target.userId,
      target_role: target.role,
      target_scope_ref: target.scopeRef,
    })
    .select('id')
    .single()
  if (error) throw new Error(`Could not start view-as: ${error.message}`)

  const jar = await cookies()
  jar.set(viewAsCookieName(moduleKey), session.id as string, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 30 * 60,
  })

  redirect(`/o/${orgSlug}/m/${moduleKey}/view-as?tab=${encodeURIComponent(target.role)}&mode=2`)
}

/**
 * Leaving is just dropping the cookie. Sessions end by EXPIRY in the database,
 * never by an UPDATE — which is what keeps `view_as_sessions` genuinely
 * append-only (there is no `ended_at` to write).
 */
export async function endViewAs(orgSlug: string, moduleKey: string, tab: string) {
  const jar = await cookies()
  jar.delete(viewAsCookieName(moduleKey))
  redirect(`/o/${orgSlug}/m/${moduleKey}/view-as?tab=${encodeURIComponent(tab)}&mode=1`)
}
