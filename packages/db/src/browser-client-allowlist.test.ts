// The browser Supabase client's ALLOWLIST (docs/13 whole-account View as, revision 13).
//
// While the superadmin views someone's account, the page is rendered with the PERSON's
// token on the server — but any code that talks to the database from the BROWSER uses the
// superadmin's own cookie session, so it would act as the superadmin. Every such file must
// therefore be known and either guarded by useIsViewing() or irrelevant to a view.
// A new importer fails this test until it is added here on purpose.
//
// File reading only (no database).
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')

const ALLOWED: Record<string, string> = {
  'apps/web/lib/supabase/client.ts': 'the browser client factory itself',
  'apps/web/app/login/page.tsx': 'the sign-in form; outside every view',
  'modules/speed-dating/ui/events/[eventId]/device-reporter.tsx': 'guarded: renders and sends nothing when useIsViewing()',
}

function sourcesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourcesUnder(p))
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

// A client component that builds its own client straight from supabase-js (bypassing
// lib/supabase/client) would act as the superadmin in the browser just the same.
const USE_CLIENT = /^\s*['"]use client['"]/m
const SUPABASE_JS_CREATE = /import\s*\{[^}]*\bcreateClient\b[^}]*\}\s*from\s*['"]@supabase\/supabase-js['"]/

export function importsBrowserClient(src: string): boolean {
  return (
    /@\/lib\/supabase\/client|\/supabase\/client['"]|createBrowserClient/.test(src) ||
    (USE_CLIENT.test(src) && SUPABASE_JS_CREATE.test(src))
  )
}

const files = [join(repoRoot, 'apps/web'), join(repoRoot, 'modules')]
  .flatMap(sourcesUnder)
  .map((p) => relative(repoRoot, p).split(sep).join('/'))
  .sort()

describe('browser Supabase client allowlist', () => {
  it('scanned the sources (control: not vacuous)', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(importsBrowserClient("import { createClient } from '@/lib/supabase/client'")).toBe(true)
    expect(importsBrowserClient("import { createClient } from '@/lib/supabase/server'")).toBe(false)
    // supabase-js createClient: caught in a client component, ignored on the server.
    const direct = "import { createClient } from '@supabase/supabase-js'\nconst c = createClient(u, k)"
    expect(importsBrowserClient("'use client'\n" + direct)).toBe(true)
    expect(importsBrowserClient('"use client";\nimport { type User, createClient } from "@supabase/supabase-js"')).toBe(true)
    expect(importsBrowserClient(direct)).toBe(false)
    expect(importsBrowserClient("'use client'\nimport type { User } from '@supabase/supabase-js'")).toBe(false)
    // control: real server-side supabase-js createClient importers exist, so the
    // pattern is exercised on real files (and they are not flagged: no 'use client').
    const serverSide = files.filter((f) => SUPABASE_JS_CREATE.test(readFileSync(join(repoRoot, f), 'utf8')))
    expect(serverSide.length).toBeGreaterThan(0)
    const hits = files.filter((f) => importsBrowserClient(readFileSync(join(repoRoot, f), 'utf8')))
    // the known importers really are found by the scan
    for (const known of Object.keys(ALLOWED)) expect(hits).toContain(known)
  })

  it('only the allowlisted files use the browser client', () => {
    const offenders = files.filter(
      (f) => !(f in ALLOWED) && importsBrowserClient(readFileSync(join(repoRoot, f), 'utf8')),
    )
    expect(offenders).toEqual([])
  })
})
