// Small explicit CSV serializer (code-style rule: no dependency for 30 lines).
// Nested objects from PostgREST embeds are flattened one level with dotted
// headers (e.g. "homework.title"); deeper values are JSON-stringified.

type Row = Record<string, unknown>

function flatten(row: Row): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(row)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k2, v2] of Object.entries(value as Row)) {
        out[`${key}.${k2}`] = stringify(v2)
      }
    } else {
      out[key] = stringify(value)
    }
  }
  return out
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function escapeCell(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(rows: Row[]): string {
  if (rows.length === 0) return ''
  const flat = rows.map(flatten)
  // Union of all headers, in first-seen order (rows can be sparse).
  const headers: string[] = []
  for (const r of flat) for (const h of Object.keys(r)) if (!headers.includes(h)) headers.push(h)
  const lines = [headers.map(escapeCell).join(',')]
  for (const r of flat) lines.push(headers.map((h) => escapeCell(r[h] ?? '')).join(','))
  return lines.join('\r\n') + '\r\n'
}
