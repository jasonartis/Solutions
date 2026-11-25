'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'

// Keeps the banner and header TRUE during a real view (docs/13 "THE DESIGN").
//
// The (app) layout — banner and header — is rendered once and KEPT across
// client-side link clicks; only the page below it is fetched again. So after a
// click from an in-scope page to, say, the console, the page would be the
// superadmin's own while the header still named the person (and the reverse).
// The proxy cannot tell those clicks apart from page loads (Next strips its
// router headers before the proxy runs, measured 2026-11-12), so the check
// lives here: when the path crosses the in-scope boundary in either direction,
// or the view reaches its end time, reload the page in full.
//
// The boundary mirrors the database's view_as_real_check exactly: a whole-account view
// (no org/module) covers /dashboard, /account, /feedback (exact or + /…) and anything under
// /o/; a v1 org-module view covers only /o/<orgSlug>/m/<module> (exact or + /…). This only
// detects a crossing; the database's answer (`inScope`) is what decides what renders.
// `pathname` from usePathname is DECODED; the proxy decodes before asking the database too.
export function pathInScope(pathname: string, view: { orgSlug: string | null; module: string | null }): boolean {
  if (view.orgSlug && view.module) {
    const prefix = `/o/${view.orgSlug}/m/${view.module}`
    return pathname === prefix || pathname.startsWith(`${prefix}/`)
  }
  return (
    ['/dashboard', '/account', '/feedback'].some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
    pathname.startsWith('/o/')
  )
}

export function ViewAsGuard({
  inScope,
  expiresAt,
  orgSlug,
  module,
  who,
}: {
  inScope: boolean
  expiresAt: string
  orgSlug: string | null
  module: string | null
  who: string
}) {
  const pathname = usePathname()

  useEffect(() => {
    if (pathInScope(pathname, { orgSlug, module }) !== inScope) window.location.reload()
  }, [pathname, inScope, orgSlug, module])

  useEffect(() => {
    const ms = Math.max(0, Date.parse(expiresAt) - new Date().getTime()) + 1000
    // Expiry: land on the console page that says the view ended (item 6).
    const t = setTimeout(() => window.location.assign(`/console/view-as/real?ended=${encodeURIComponent(who)}`), ms)
    return () => clearTimeout(t)
  }, [expiresAt, who])

  return null
}
