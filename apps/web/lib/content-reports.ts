// Content reports (module-9 spec §B1/§H(c); migration 20261114010000).
//
// Shared by the superadmin's /console/reports page and the console dashboard
// tile. Reads go through the caller's ordinary RLS client: only the superadmin
// has a read policy on content_reports, so a non-superadmin simply reads none.

export const REPORT_REASONS: { value: string; label: string }[] = [
  { value: 'without_permission', label: 'Shows me without permission' },
  { value: 'intimate', label: 'Intimate or sexual image' },
  { value: 'minor', label: 'Involves a minor' },
  { value: 'copyright', label: 'Copyright' },
  { value: 'other', label: 'Other' },
]

export const REPORT_STATUSES: { value: string; label: string }[] = [
  { value: 'new', label: 'New' },
  { value: 'reviewing', label: 'Reviewing' },
  { value: 'actioned', label: 'Action taken' },
  { value: 'dismissed', label: 'Dismissed' },
]

export const OPEN_STATUSES = ['new', 'reviewing'] as const

/** The TAKE IT DOWN Act clock: a valid removal request must be acted on within 48 hours. */
export const DEADLINE_HOURS = 48

export function reasonLabel(value: string): string {
  return REPORT_REASONS.find((r) => r.value === value)?.label ?? value
}

export function statusLabel(value: string): string {
  return REPORT_STATUSES.find((s) => s.value === value)?.label ?? value
}

export function hoursSince(iso: string, now = Date.now()): number {
  return (now - new Date(iso).getTime()) / 3600000
}

/** Only an http(s) URL is ever rendered as a link; anything else is shown as plain text. */
export function safeHttpUrl(text: string): string | null {
  const t = text.trim()
  if (!/^https?:\/\/\S+$/i.test(t)) return null
  try {
    const u = new URL(t)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}
