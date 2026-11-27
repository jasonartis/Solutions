'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'

// Keeps the banner and header TRUE during a real view (docs/13 "THE DESIGN").
//
// The (app) layout — banner and header — is rendered once and KEPT across
// client-side link clicks; only the page below it is fetched again. So after a
// click from an in-scope page to, say, the console, the page would be the
// viewer's own while the header still named the person (and the reverse).
// The proxy cannot tell those clicks apart from page loads (Next strips its
// router headers before the proxy runs, measured 2026-11-12), so the check
// lives here: when the path crosses the in-scope boundary in either direction,
// or the view reaches its end time, reload the page in full.
//
// The boundary mirrors the database's view_as_real_check exactly:
//   * a whole-account (platform) view covers /dashboard, /account, /feedback (exact or + /…)
//     and anything under /o/;
//   * a STAFF view (docs/13 "STAFF VIEW AS") covers /o/<orgSlug>/m/<area module> (exact or
//     + /…) except that module's own picker, /m/<module>/view-as[/…];
//   * a v1 org-module view covers only /o/<orgSlug>/m/<module> (exact or + /…).
// This only detects a crossing; the database's answer (`inScope`) is what decides what renders.
// `pathname` from usePathname is DECODED; the proxy decodes before asking the database too.
type GuardView = { kind: 'platform' | 'staff'; orgSlug: string | null; module: string | null; areaModules: string[] }

export function pathInScope(pathname: string, view: GuardView): boolean {
  if (view.kind === 'staff') {
    if (!view.orgSlug) return false
    return view.areaModules.some((m) => {
      const prefix = `/o/${view.orgSlug}/m/${m}`
      const inModule = pathname === prefix || pathname.startsWith(`${prefix}/`)
      const picker = pathname === `${prefix}/view-as` || pathname.startsWith(`${prefix}/view-as/`)
      return inModule && !picker
    })
  }
  if (view.orgSlug && view.module) {
    const prefix = `/o/${view.orgSlug}/m/${view.module}`
    return pathname === prefix || pathname.startsWith(`${prefix}/`)
  }
  return (
    ['/dashboard', '/account', '/feedback'].some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
    pathname.startsWith('/o/')
  )
}

/** Staff views: the module of a page of the viewed org that is NOT in the area (same rule as proxy.ts). */
export function outsideAreaOf(pathname: string, view: GuardView): string | null {
  if (view.kind !== 'staff' || !view.orgSlug) return null
  const m = pathname.match(/^\/o\/([^/]+)\/m\/([^/]+)(\/.*)?$/)
  if (!m || m[1] !== view.orgSlug || view.areaModules.includes(m[2]!)) return null
  return m[2]!
}

export function ViewAsGuard({
  inScope,
  outsideArea,
  expiresAt,
  view,
  endedHref,
}: {
  inScope: boolean
  outsideArea: string | null
  expiresAt: string
  view: GuardView
  endedHref: string
}) {
  const pathname = usePathname()
  const { kind, orgSlug, module, areaModules } = view
  const areaKey = areaModules.join(',')

  useEffect(() => {
    const v = { kind, orgSlug, module, areaModules: areaKey ? areaKey.split(',') : [] }
    // A staff view's out-of-area placeholder is drawn by the layout, which a client
    // navigation keeps: crossing into or out of it needs a full load too.
    if (pathInScope(pathname, v) !== inScope || outsideAreaOf(pathname, v) !== outsideArea) window.location.reload()
  }, [pathname, inScope, outsideArea, kind, orgSlug, module, areaKey])

  useEffect(() => {
    const ms = Math.max(0, Date.parse(expiresAt) - new Date().getTime()) + 1000
    // Expiry: land on the page that says the view ended.
    const t = setTimeout(() => window.location.assign(endedHref), ms)
    return () => clearTimeout(t)
  }, [expiresAt, endedHref])

  return null
}
