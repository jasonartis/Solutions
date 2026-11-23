// Pure helpers for the one back-link convention (docs/03 convention #37). No
// React here so the unit test (packages/db/src/page-header-coverage.test.ts)
// can import it directly. The component is components/page-header.tsx.

/** Where a page's back link goes by default, and (optionally) the "came from" the URL carried. */
export type BackTarget = {
  /** The parent page: where the link goes with no valid "came from". */
  href: string
  /** The parent page's heading, exactly. */
  label: string
  /** `searchParams.from` — the path the visitor came from (validated, never trusted). */
  from?: string | string[] | null
  /** `searchParams.fromLabel` — that page's heading, plain text (rendered escaped). */
  fromLabel?: string | string[] | null
}

/** A same-origin relative path or null: starts with ONE '/', no '//', no backslash, no whitespace/control chars. */
export function safeFromPath(raw: string | string[] | null | undefined): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw
  if (typeof v !== 'string' || v.length === 0 || v.length > 500) return null
  if (!v.startsWith('/') || v.startsWith('//')) return null
  if (v.includes(String.fromCharCode(92))) return null // backslash
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(v)) return null
  return v
}

function cleanLabel(raw: string | string[] | null | undefined): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 && t.length <= 80 ? t : null
}

/** Pick the back link: a valid "came from" WITH a label wins, else the parent. */
export function resolveBack(target: BackTarget): { href: string; label: string } {
  const from = safeFromPath(target.from)
  const label = cleanLabel(target.fromLabel)
  return from && label ? { href: from, label } : { href: target.href, label: target.label }
}

/**
 * Add "came from" to a link: `<Link href={withFrom(url, thisPagePath, 'This page heading')}>`.
 * The destination page passes `searchParams.from/fromLabel` into its PageHeader's `back`.
 */
export function withFrom(href: string, fromPath: string, fromLabel: string): string {
  const sep = href.includes('?') ? '&' : '?'
  return `${href}${sep}from=${encodeURIComponent(fromPath)}&fromLabel=${encodeURIComponent(fromLabel)}`
}
