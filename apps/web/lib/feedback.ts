// Feedback and tickets v1 (docs/27, 20261106010000). Shared by the person's
// screens (/feedback) and the superadmin queue (/console/feedback).
//
// The database is the gate: tickets are readable only by their author and the
// superadmin, and every write goes through the feedback_* functions. Nothing
// here decides access.

export const FEEDBACK_KINDS = [
  { value: 'bug', label: 'Something is broken' },
  { value: 'suggestion', label: 'A suggestion or request' },
  { value: 'question', label: 'A question' },
  { value: 'other', label: 'Something else' },
] as const

export const FEEDBACK_STATUSES = ['new', 'open', 'waiting_on_user', 'resolved', 'closed'] as const

// What the PERSON reads. Staff see the raw value in the console.
export function statusLabel(status: string): string {
  switch (status) {
    case 'new':
      return 'Sent'
    case 'open':
      return 'Being looked at'
    case 'waiting_on_user':
      return 'Answered — waiting for you'
    case 'resolved':
      return 'Resolved'
    case 'closed':
      return 'Closed'
    default:
      return status
  }
}

export function kindLabel(kind: string): string {
  return FEEDBACK_KINDS.find((k) => k.value === kind)?.label ?? kind
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * What can be read from the address of the page the person came from:
 * the org slug, the module, any record ids in the path, and a `?notice=` code
 * (the platform's on-screen messages travel that way). Only a SAME-SITE path is
 * accepted; anything else is dropped rather than stored.
 */
export function parseFromPath(from: string | undefined | null) {
  if (!from || !from.startsWith('/') || from.startsWith('//')) return null
  let parsed: URL
  try {
    parsed = new URL(from, 'http://local')
  } catch {
    return null
  }
  const segments = parsed.pathname.split('/').filter(Boolean)
  const orgSlug = segments[0] === 'o' ? (segments[1] ?? null) : null
  const moduleKey = segments[0] === 'o' && segments[2] === 'm' ? (segments[3] ?? null) : null
  return {
    path: parsed.pathname.slice(0, 300),
    notice: parsed.searchParams.get('notice')?.slice(0, 100) ?? null,
    error: parsed.searchParams.get('error')?.slice(0, 300) ?? null,
    orgSlug,
    moduleKey: moduleKey && /^[a-z0-9-]{1,40}$/.test(moduleKey) ? moduleKey : null,
    recordIds: segments.filter((s) => UUID.test(s)).slice(0, 5),
  }
}
