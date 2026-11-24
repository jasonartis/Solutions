// The back-link convention's ENFORCEMENT (docs/03 convention #37, founder 2026-11-23).
//
// Every page under apps/web/app/(app) and modules/*/ui must render its title and
// back link through <PageHeader> (apps/web/components/page-header.tsx), whose
// `back` prop is required: a page either names its way back or says on purpose
// `back={null}` (a top page). A page that hand-writes an <h1> instead silently
// opts out of the convention — this test fails it.
//
// File reading only (no database). The pure helpers are unit-tested at the bottom.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { headingForPath, resolveBack, safeFromPath, withFrom } from '../../../apps/web/lib/back-link'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')

function pagesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...pagesUnder(p))
    else if (name === 'page.tsx') out.push(p)
  }
  return out
}

const moduleDirs = readdirSync(join(repoRoot, 'modules'))
  .map((m) => join(repoRoot, 'modules', m, 'ui'))
  .filter((d) => {
    try {
      return statSync(d).isDirectory()
    } catch {
      return false
    }
  })

const pages = [join(repoRoot, 'apps/web/app/(app)'), ...moduleDirs]
  .flatMap(pagesUnder)
  .map((p) => relative(repoRoot, p).split('\\').join('/'))
  .sort()

// Pages that genuinely cannot use PageHeader. One line of reason each; keep it short.
const ALLOWLIST: Record<string, string> = {
  'modules/synagogue-schedules/ui/public/page.tsx':
    'public, logged-out printable schedule: no app chrome, no navigation; the org name is the title',
  'apps/web/app/(app)/o/[orgSlug]/m/classroom/view-as/page.tsx':
    'one-line wrapper around ViewAsPage, which uses PageHeader (asserted below)',
  'apps/web/app/(app)/o/[orgSlug]/m/nail-salon/view-as/page.tsx':
    'one-line wrapper around ViewAsPage, which uses PageHeader (asserted below)',
}

// The ONLY pages allowed `back={null}`: the dashboard, the console home, and each module home.
// Adding a page here is a convention decision (docs/03 #37), not a convenience.
const TOP_PAGES = [
  'apps/web/app/(app)/dashboard/page.tsx',
  'apps/web/app/(app)/console/page.tsx',
  'apps/web/app/(app)/o/[orgSlug]/m/stub/page.tsx',
  'modules/classroom/ui/page.tsx',
  'modules/matchmaking/ui/page.tsx',
  'modules/nail-salon/ui/page.tsx',
  'modules/sample/ui/page.tsx',
  'modules/speed-dating/ui/page.tsx',
  'modules/synagogue-schedules/ui/page.tsx',
  'modules/visual-messaging/ui/page.tsx',
]

describe('every page uses PageHeader (docs/03 #37)', () => {
  it('found the pages (control: the scan is not vacuous)', () => {
    expect(pages.length).toBeGreaterThan(40)
    expect(pages).toContain('apps/web/app/(app)/dashboard/page.tsx')
    expect(pages).toContain('modules/classroom/ui/manage/page.tsx')
  })

  it('no page hand-writes its h1 or a Back-to link', () => {
    const offenders: string[] = []
    for (const p of pages) {
      if (p in ALLOWLIST) continue
      const src = readFileSync(join(repoRoot, p), 'utf8')
      const thinReexport =
        /^\s*export\s*\{\s*default\s*\}\s*from\s*'@modules\/[^']+'\s*$/m.test(src) && !src.includes('<h1')
      if (thinReexport) continue
      if (!src.includes('<PageHeader')) offenders.push(`${p}: does not use <PageHeader>`)
      if (/<h1[\s>]/.test(src)) offenders.push(`${p}: hand-written <h1> (put the title in PageHeader)`)
      // Navigation links say "← Page name". Actions (Back to draft / layer / their screen) are not navigation.
      const stripped = src.replace(/Back to (draft|layer|their screen)/g, '')
      if (/(>|[{]\s*['"`])\s*(←\s*)?Back to /.test(stripped)) {
        offenders.push(`${p}: a "Back to ..." link (use "← Page name" via PageHeader)`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('only the listed TOP pages pass back={null}', () => {
    const found: string[] = []
    for (const p of pages) {
      const src = readFileSync(join(repoRoot, p), 'utf8')
      if (/back=[{]\s*null\s*[}]/.test(src)) found.push(p)
    }
    expect(found.sort()).toEqual([...TOP_PAGES].sort())
  })

  it('the allowlist has no stale entries, and the view-as wrapper target uses PageHeader', () => {
    for (const p of Object.keys(ALLOWLIST)) expect(pages).toContain(p)
    const viewAs = readFileSync(join(repoRoot, 'apps/web/components/view-as/page.tsx'), 'utf8')
    expect(viewAs).toContain('<PageHeader')
    expect(viewAs).not.toMatch(/<h1[\s>]/)
  })

  it('PageHeader requires `back` (a page must decide)', () => {
    const src = readFileSync(join(repoRoot, 'apps/web/components/page-header.tsx'), 'utf8')
    expect(src).toMatch(/back:\s*BackTarget\s*\|\s*null\s*\n/)
    expect(src).not.toMatch(/back\?:/)
  })
})

describe('back-link helpers', () => {
  it('safeFromPath accepts same-origin relative paths only', () => {
    expect(safeFromPath('/console/engagement')).toBe('/console/engagement')
    expect(safeFromPath('/o/x/m/y?tab=1&a=b')).toBe('/o/x/m/y?tab=1&a=b')
    for (const bad of ['//evil.com', 'https://evil.com', 'javascript:alert(1)', '/\\evil.com', '/a b', '/a\nb', 'evil', '', '/x\\y']) {
      expect(safeFromPath(bad)).toBeNull()
    }
    expect(safeFromPath(undefined)).toBeNull()
    expect(safeFromPath(null)).toBeNull()
    expect(safeFromPath('/' + 'a'.repeat(600))).toBeNull()
    expect(safeFromPath(['/dashboard', '//bad'])).toBe('/dashboard')
  })

  it('safeFromPath rejects non-page routes and unknown prefixes', () => {
    for (const ok of ['/dashboard', '/console', '/feedback/new', '/account', '/o/a/m/b?x=1']) expect(safeFromPath(ok)).toBe(ok)
    for (const bad of ['/auth/callback', '/api/export', '/view-as/x', '/login', '/consolex', '/dashboardx', '/x', '/ok', '/oops']) {
      expect(safeFromPath(bad)).toBeNull()
    }
  })

  it('headingForPath names only routes it knows exactly', () => {
    expect(headingForPath('/dashboard')).toBe('Dashboard')
    expect(headingForPath('/console?x=1')).toBe('Owner Console')
    expect(headingForPath('/o/demo-a/m/classroom')).toBe('Classroom')
    expect(headingForPath('/o/demo-a/m/nail-salon')).toBeNull()
    expect(headingForPath('/o/demo-a/m/classroom/manage')).toBeNull()
    expect(headingForPath(null)).toBeNull()
  })

  it('resolveBack prefers a valid came-from WITH a label, else the parent', () => {
    const parent = { href: '/console', label: 'Owner Console' }
    expect(resolveBack({ ...parent, from: '/console/engagement', fromLabel: 'Engagement' })).toEqual({
      href: '/console/engagement',
      label: 'Engagement',
    })
    expect(resolveBack({ ...parent })).toEqual(parent)
    expect(resolveBack({ ...parent, from: '/console/engagement' })).toEqual(parent) // no label: cannot say where
    expect(resolveBack({ ...parent, from: '//evil.com', fromLabel: 'Engagement' })).toEqual(parent)
    expect(resolveBack({ ...parent, from: '/dashboard', fromLabel: '   ' })).toEqual(parent)
  })

  it('withFrom round-trips through resolveBack', () => {
    const url = withFrom('/console/view-as?org=1', '/console/positions?a=b', 'Positions and authority')
    const qs = new URL(url, 'http://x').searchParams
    expect(qs.get('org')).toBe('1')
    expect(
      resolveBack({ href: '/console', label: 'Owner Console', from: qs.get('from'), fromLabel: qs.get('fromLabel') }),
    ).toEqual({ href: '/console/positions?a=b', label: 'Positions and authority' })
  })
})
