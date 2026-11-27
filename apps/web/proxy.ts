import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { VIEW_AS_COOKIE, VIEW_AS_HEADER, signRealViewHeader, type RealView } from '@/lib/view-as-real'

// Refreshes the Supabase auth session on every request (Next 16 proxy convention,
// replacing middleware). Route protection itself lives in the (app) layout.
//
// REAL VIEW-AS (docs/13 "THE DESIGN", 2026-11-12; lib/view-as-real.ts). While the
// `sp_view_as` cookie is set, this proxy:
//   * refuses every request that is not GET/HEAD — server actions, route-handler
//     writes, form posts — except POST /view-as/stop, so nothing can be changed
//     while looking at someone's screen;
//   * asks the database, AS THE SUPERADMIN (this client is the superadmin's own
//     cookie session), whether the view is still valid, and logs the page;
//   * forwards a SIGNED header describing the view. Any incoming copy of that
//     header is deleted first, on every request, cookie or not.
const STOP_PATH = '/view-as/stop'
const SEEN_COOKIE = 'sp_seen'

// The database gets the DECODED path (what usePathname shows the guard), so the two cannot
// disagree on percent-encoded paths. Anything undecodable or with a dot segment / backslash /
// NUL after decoding is sent as a path that is in scope nowhere (the superadmin's own view).
function decodedPath(raw: string): string {
  try {
    const d = decodeURIComponent(raw)
    if (d.split('/').some((seg) => seg === '..' || seg === '.') || d.includes(String.fromCharCode(92)) || d.includes(String.fromCharCode(0))) return '/invalid'
    return d
  } catch {
    return '/invalid'
  }
}

// STAFF views (docs/13 "STAFF VIEW AS"): a page of ANOTHER module of the viewed org
// (/o/<org>/m/<module>[/…], module not in the viewer's area) is shown as the placeholder
// "‹<module> · outside your area›" by the (app) layout, in the same frame. The page itself
// renders as the viewer (the database said: not in scope), so nothing of the person's shows.
// The module's own picker (/m/<module>/view-as) is the viewer's page, never a placeholder.
function outsideAreaModule(path: string, orgSlug: string | null, areaModules: string[]): string | null {
  if (!orgSlug) return null
  const m = path.match(/^\/o\/([^/]+)\/m\/([^/]+)(\/.*)?$/)
  if (!m || m[1] !== orgSlug) return null
  if (areaModules.includes(m[2]!)) return null
  return m[2]!
}

export async function proxy(request: NextRequest) {
  const viewSession = request.cookies.get(VIEW_AS_COOKIE)?.value
  const path = request.nextUrl.pathname
  const isStop = path === STOP_PATH

  if (viewSession && request.method !== 'GET' && request.method !== 'HEAD' && !(isStop && request.method === 'POST')) {
    return new NextResponse('Read-only: you are viewing someone else’s screen. Stop viewing first.', { status: 403 })
  }
  // NOTE: client-side (RSC) navigations and prefetches look exactly like page
  // loads here — Next strips its router headers and `_rsc` before the proxy runs
  // (server/web/adapter.js, measured 2026-11-12). They get the same checks and the
  // same header, and are logged like page loads (so the page log over-counts).
  // Keeping the shared layout's banner and header true across link clicks is
  // components/view-as-guard.tsx's job.

  // The headers forwarded to the page: never a browser-supplied view-as header.
  const forwarded = new Headers(request.headers)
  forwarded.delete(VIEW_AS_HEADER)
  const pendingCookies: { name: string; value: string; options?: Parameters<NextResponse['cookies']['set']>[2] }[] = []
  const build = () => {
    const res = NextResponse.next({ request: { headers: forwarded } })
    for (const c of pendingCookies) res.cookies.set(c.name, c.value, c.options)
    return res
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          // Forward the refreshed session to the page, and send it to the browser.
          forwarded.set('cookie', request.headers.get('cookie') ?? '')
          cookiesToSet.forEach((c) => pendingCookies.push(c))
        },
      },
    },
  )

  // Touching auth here refreshes an expired session cookie before pages render.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // PUBLIC MARKETING PAGE (docs/35). The page itself sets no cookies. This marker is set only
  // for someone who is actually signed in (so it never reaches a marketing-page visitor), and
  // says only "this browser has had an account session" — no identity, no value but "1".
  // Signed-out GET / with the marker → the app's normal redirect to /login; without it (never
  // signed in, or unsure — new browser, cleared cookies) → the marketing page, URL unchanged.
  if (user && request.cookies.get(SEEN_COOKIE)?.value !== '1') {
    pendingCookies.push({
      name: SEEN_COOKIE,
      value: '1',
      options: { path: '/', maxAge: 60 * 60 * 24 * 365 * 2, sameSite: 'lax', httpOnly: true, secure: process.env.NODE_ENV === 'production' },
    })
  }
  if (!user && path === '/' && (request.method === 'GET' || request.method === 'HEAD') && request.cookies.get(SEEN_COOKIE)?.value !== '1') {
    const res = NextResponse.rewrite(new URL('/site', request.url), { request: { headers: forwarded } })
    for (const c of pendingCookies) res.cookies.set(c.name, c.value, c.options)
    return res
  }

  if (viewSession && !isStop) {
    let view: RealView | null = null
    if (user) {
      // Pages are NOT logged (founder decision 2026-11-15: no per-page log, no
      // notification — he checks clients' screens constantly as part of finding
      // bugs). The session row itself remains: it is the switch this check reads.
      const { data } = await supabase.rpc('view_as_real_check', {
        p_session: viewSession,
        p_path: decodedPath(path),
        p_log: false,
      })
      const row = (data as Record<string, unknown>[] | null)?.[0]
      if (row) {
        const kind = row.kind === 'staff' ? 'staff' : 'platform'
        const areaModules = kind === 'staff' && Array.isArray(row.area_modules) ? (row.area_modules as string[]) : []
        const orgSlug = (row.org_slug as string | null) ?? null
        view = {
          kind,
          areaModules,
          outsideArea: kind === 'staff' && row.in_scope !== true ? outsideAreaModule(decodedPath(path), orgSlug, areaModules) : null,
          session: viewSession,
          actor: user.id,
          target: row.target_user_id as string,
          targetName: (row.target_name as string | null) ?? null,
          orgSlug: (row.org_slug as string | null) ?? null,
          orgName: (row.org_name as string | null) ?? null,
          module: (row.module_key as string | null) ?? null,
          expiresAt: row.expires_at as string,
          inScope: row.in_scope === true,
        }
      }
    }
    const signed = view ? signRealViewHeader(view) : null
    if (signed) {
      forwarded.set(VIEW_AS_HEADER, signed)
    } else {
      // Ended, expired, no longer allowed, or not configured: drop the view.
      pendingCookies.push({ name: VIEW_AS_COOKIE, value: '', options: { path: '/', maxAge: 0 } })
      // ...and take it out of the request the PAGE sees too, or the page would still
      // find the cookie ("A view is open") while no banner is shown.
      request.cookies.delete(VIEW_AS_COOKIE)
      forwarded.set(
        'cookie',
        (forwarded.get('cookie') ?? '')
          .split(/;\s*/)
          .filter((c) => c && !c.startsWith(`${VIEW_AS_COOKIE}=`))
          .join('; '),
      )
    }
  }

  return build()
}

// Image files skip the proxy, EXCEPT under every path a view can be in scope for
// (/o/, /dashboard, /account, /feedback): a page whose last path segment merely
// ends in ".png" is still a page there, and must get the read-only checks above
// (app-code review 2026-11-12; whole-account revision 3).
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|site-fonts/|(?!o/|dashboard|account|feedback).*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
