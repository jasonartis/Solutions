// "FORMER MEMBER" — how a deleted account renders (docs/21 §7.5).
//
// A deleted account is a SILHOUETTE: its `auth.users` row is kept so that
// everything a person did that touched someone else (a drawing someone replied
// under, a peer review, a safety note) survives. But the silhouette has no org
// membership left, so `profiles_select_shared_org` no longer shows its profile
// row to anyone, and a page that looks names up in `profiles` finds nothing.
//
// Without this helper that author would render with the page's generic
// fallback — "Someone", or a bare uuid — exactly like a live member whose
// profile the viewer simply cannot see. §7.5 calls that an honesty failure: a
// former member must be visibly a DIFFERENT kind of user.
//
// `former_members()` (20261007090000) answers only for the DELETED state, and
// only to people who shared an org with that person. Someone in the 30-day
// grace period is still a member and renders normally.
//
// Kept free of `@supabase/supabase-js` like the rest of this package; the
// client is structurally typed.

export const FORMER_MEMBER_LABEL = 'Former member'

// Same loose shape as ExportDb (export.ts): the real client's rpc() is a
// heavily overloaded generic that a narrower structural type would not accept.
type RpcClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc: (fn: string, args?: Record<string, unknown>) => any
}

/**
 * Which of these user ids are former members? Pass every id a page is about to
 * render by name. Returns an empty set on error rather than throwing — the cost
 * of a failed lookup is the old generic fallback, not a broken page — but the
 * error is logged, because a silently empty answer is how a label stops
 * appearing without anyone noticing.
 */
export async function loadFormerMembers(client: RpcClient, userIds: (string | null | undefined)[]): Promise<Set<string>> {
  const ids = [...new Set(userIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
  if (ids.length === 0) return new Set()
  const { data, error } = await client.rpc('former_members', { check_user_ids: ids })
  if (error) {
    console.error('former_members lookup failed:', error.message)
    return new Set()
  }
  // A `returns setof uuid` function comes back from PostgREST as a bare array
  // of strings.
  return new Set(((data as string[] | null) ?? []).filter((v) => typeof v === 'string'))
}
