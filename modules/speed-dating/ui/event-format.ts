// Two-sided event format (2026-07-16): opt-in per event. `sd_events.format`
// is Zod-validated-at-the-write-site jsonb (docs/03 rule #7) — no CHECK
// constraint, so parsing/shape lives here rather than in a migration.
// Absent `sides` = single open pool (unchanged default behavior).
export type SideKey = 'a' | 'b'
export type EventSide = { label: string; capacity: number | null }
export type EventFormat = { sides?: { a: EventSide; b: EventSide } }

export function parseEventFormat(formData: FormData): EventFormat {
  if (formData.get('sidesEnabled') !== 'on') return {}

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

  return {
    sides: {
      a: { label: sideALabel, capacity: parseCapacity(formData.get('sideACapacity'), sideALabel) },
      b: { label: sideBLabel, capacity: parseCapacity(formData.get('sideBCapacity'), sideBLabel) },
    },
  }
}

export function getEventSides(format: unknown): EventFormat['sides'] | undefined {
  const sides = (format as EventFormat | null | undefined)?.sides
  if (!sides) return undefined
  if (!sides.a?.label || !sides.b?.label) return undefined
  return sides
}
