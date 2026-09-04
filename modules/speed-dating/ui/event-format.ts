// Event format (organizer-designated config): `sd_events.format` is
// Zod-validated-at-the-write-site jsonb (docs/03 rule #7) — no CHECK
// constraint, so parsing/shape lives here rather than in a migration.
//
// Two-sided (2026-07-16): opt-in per event. Absent `sides` = single open
// pool (unchanged default behavior).
//
// shareContactOnMatch (contact-share population on reveal): the spec's
// "contact shared per user preferences or organizer designation for the
// event" — there is no per-user preference column in v1 (schema header
// note), so this organizer toggle IS the whole mechanism. Off by default;
// when on, revealMatches (ui/actions.ts) populates sd_matches.contact_shared
// with each side's display name + email, keyed by user id.
export type SideKey = 'a' | 'b'
export type EventSide = { label: string; capacity: number | null }
export type EventFormat = { sides?: { a: EventSide; b: EventSide }; shareContactOnMatch?: boolean }

export function parseEventFormat(formData: FormData): EventFormat {
  const format: EventFormat = {}

  if (formData.get('shareContactOnMatch') === 'on') {
    format.shareContactOnMatch = true
  }

  if (formData.get('sidesEnabled') === 'on') {
    const sideALabel = String(formData.get('sideALabel') ?? '').trim()
    const sideBLabel = String(formData.get('sideBLabel') ?? '').trim()
    if (!sideALabel || !sideBLabel) throw new Error('Both side labels are required when using two sides')

    const parseCapacity = (raw: FormDataEntryValue | null, label: string): number | null => {
      const text = String(raw ?? '').trim()
      if (!text) return null // unset = unlimited, matches the platform's existing convention
      const n = Number(text)
      if (!Number.isInteger(n) || n <= 0) throw new Error(`${label} capacity must be a positive whole number`)
      return n
    }

    format.sides = {
      a: { label: sideALabel, capacity: parseCapacity(formData.get('sideACapacity'), sideALabel) },
      b: { label: sideBLabel, capacity: parseCapacity(formData.get('sideBCapacity'), sideBLabel) },
    }
  }

  return format
}

export function getEventSides(format: unknown): EventFormat['sides'] | undefined {
  const sides = (format as EventFormat | null | undefined)?.sides
  if (!sides) return undefined
  if (!sides.a?.label || !sides.b?.label) return undefined
  return sides
}

export function getShareContactOnMatch(format: unknown): boolean {
  return Boolean((format as EventFormat | null | undefined)?.shareContactOnMatch)
}
