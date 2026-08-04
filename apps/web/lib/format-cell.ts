/**
 * Render one database cell as text for a generic row table.
 *
 * Extracted from the view-as page when the data browser needed the same
 * formatting: both render arbitrary rows from arbitrary tables, and letting the
 * two drift would mean the same timestamp reading two different ways on two
 * screens that sit next to each other in the Owner Console.
 *
 * Shared by a client component, so this file must stay free of server imports.
 */
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return String(obj.title ?? obj.name ?? JSON.stringify(obj))
  }
  const s = String(value)
  // Timestamps read better short; ids stay as-is so they can be matched up.
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 16).replace('T', ' ')
  return s
}
