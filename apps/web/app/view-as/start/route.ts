import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { VIEW_AS_COOKIE, realViewConfigured } from '@/lib/view-as-real'

// Start a real view (docs/13 "THE DESIGN"). A plain form POST, not a server
// action, so the person's first screen is a FULL page load through the proxy
// (a server action's redirect would render it inside this same request, before
// the cookie exists, i.e. as the superadmin with no banner).
//
// The database decides who may be viewed (view_as_real_start: superadmin only,
// the whole account, never a superadmin or oneself) and logs it.
// A route handler gets no automatic cross-site check, so the Origin is checked
// here; the cookie is httpOnly and SameSite=Lax.
export async function POST(request: NextRequest) {
  const back = (msg: string) =>
    NextResponse.redirect(new URL(`/console/view-as/real?error=${encodeURIComponent(msg)}`, request.url), 303)

  const origin = request.headers.get('origin')
  let originHost: string | null = null
  try {
    originHost = origin ? new URL(origin).host : null // 'null' or garbage throws: refuse, not 500
  } catch {
    originHost = null
  }
  if (!originHost || originHost !== request.nextUrl.host) {
    return new NextResponse('Cross-site request refused', { status: 403 })
  }
  if (!realViewConfigured()) return back('Real view-as is not configured on this server (SUPABASE_JWT_SECRET is missing).')

  const form = await request.formData()
  const target = String(form.get('target') ?? '')

  // STAFF "View as" (docs/13 "STAFF VIEW AS"): started from a module's own picker.
  // The database decides everything (view_as_staff_start: the area rule, no
  // self-given seats, never a more powerful person); slug and module are used
  // only to build the redirect, so they are checked against a strict shape.
  if (form.get('kind') === 'staff') {
    const org = String(form.get('org') ?? '')
    const slug = String(form.get('slug') ?? '')
    const moduleKey = String(form.get('module') ?? '')
    if (!/^[a-z0-9-]{1,80}$/.test(slug) || !STAFF_MODULES.includes(moduleKey)) {
      return new NextResponse('Bad request', { status: 400 })
    }
    const home = `/o/${slug}/m/${moduleKey}`
    const staffBack = (msg: string) =>
      NextResponse.redirect(new URL(`${home}/view-as?error=${encodeURIComponent(msg)}`, request.url), 303)
    if (!realViewConfigured()) return staffBack('View as is not configured on this server.')
    const supabase = await createClient()
    const { data, error } = await supabase.rpc('view_as_staff_start', { p_org: org, p_target: target })
    // Only the function's own refusals are shown; anything else (a bad id, a network error) is generic.
    if (error || !data) {
      const known = ["You can't view this person's screen", 'Choose someone else to view']
      return staffBack(known.includes(error?.message ?? '') ? error!.message : 'Could not start the view.')
    }
    const res = NextResponse.redirect(new URL(home, request.url), 303)
    res.cookies.set(VIEW_AS_COOKIE, data as string, COOKIE_OPTIONS)
    return res
  }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('view_as_real_start', { p_target: target })
  if (error || !data) return back(error?.message ?? 'Could not start the view')

  const res = NextResponse.redirect(new URL('/dashboard', request.url), 303)
  res.cookies.set(VIEW_AS_COOKIE, data as string, COOKIE_OPTIONS)
  return res
}

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: 30 * 60,
}

// The modules that have staff "View as" edges (module_view_as_edge mode 2). The
// database refuses anything else anyway; this only shapes the redirect.
const STAFF_MODULES = ['classroom', 'nail-salon']
