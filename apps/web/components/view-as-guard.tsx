'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'

// Keeps the banner and header TRUE during a real view (docs/13 "THE DESIGN").
//
// The (app) layout — banner and header — is rendered once and KEPT across
// client-side link clicks; only the page below it is fetched again. So after a
// click from the viewed module to, say, the dashboard, the page would be the
// superadmin's own while the header still named the person (and the reverse).
// The proxy cannot tell those clicks apart from page loads (Next strips its
// router headers before the proxy runs, measured 2026-11-12), so the check
// lives here: when the path crosses in or out of the viewed module, or the view
// reaches its end time, reload the page in full, which re-renders the layout.
export function ViewAsGuard({ scopePrefix, inScope, expiresAt }: { scopePrefix: string; inScope: boolean; expiresAt: string }) {
  const pathname = usePathname()

  useEffect(() => {
    const nowInScope = pathname === scopePrefix || pathname.startsWith(`${scopePrefix}/`)
    if (nowInScope !== inScope) window.location.reload()
  }, [pathname, scopePrefix, inScope])

  useEffect(() => {
    const ms = Math.max(0, Date.parse(expiresAt) - new Date().getTime()) + 1000
    const t = setTimeout(() => window.location.reload(), ms)
    return () => clearTimeout(t)
  }, [expiresAt])

  return null
}
