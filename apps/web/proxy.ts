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

  if (viewSession && !isStop) {
    let view: RealView | null = null
    if (user) {
      // Pages are NOT logged (founder decision 2026-11-15: no per-page log, no
      // notification — he checks clients' screens constantly as part of finding
      // bugs). The session row itself remains: it is the switch this check reads.
      const { data } = await supabase.rpc('view_as_real_check', {
        p_session: viewSession,
        p_path: path,
        p_log: false,
      })
      const row = (data as Record<string, unknown>[] | null)?.[0]
      if (row) {
        view = {
          session: viewSession,
          actor: user.id,
          target: row.target_user_id as string,
          targetName: (row.target_name as string | null) ?? null,
          orgSlug: row.org_slug as string,
          orgName: row.org_name as string,
          module: row.module_key as string,
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
    }
  }

  return build()
}

// Image files skip the proxy, EXCEPT under /o/: an org page whose last path
// segment merely ends in ".png" is still a page, and must get the read-only
// checks above (app-code review, 2026-11-12).
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|(?!o/).*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
