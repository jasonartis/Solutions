import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { VIEW_AS_COOKIE, realViewConfigured } from '@/lib/view-as-real'

// Start a real view (docs/13 "THE DESIGN"). A plain form POST, not a server
// action, so the person's first screen is a FULL page load through the proxy
// (a server action's redirect would render it inside this same request, before
// the cookie exists, i.e. as the superadmin with no banner).
//
// The database decides who may be viewed (view_as_real_start: superadmin only,
// classroom only, an active member, never a superadmin or oneself) and logs it.
// A route handler gets no automatic cross-site check, so the Origin is checked
// here; the cookie is httpOnly and SameSite=Lax.
export async function POST(request: NextRequest) {
  const back = (msg: string) =>
    NextResponse.redirect(new URL(`/console/view-as/real?error=${encodeURIComponent(msg)}`, request.url), 303)

  const origin = request.headers.get('origin')
  if (!origin || new URL(origin).host !== request.nextUrl.host) {
    return new NextResponse('Cross-site request refused', { status: 403 })
  }
  if (!realViewConfigured()) return back('Real view-as is not configured on this server (SUPABASE_JWT_SECRET is missing).')

  const form = await request.formData()
  const target = String(form.get('target') ?? '')
  const org = String(form.get('org') ?? '')
  const slug = String(form.get('slug') ?? '')

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('view_as_real_start', { p_target: target, p_org: org, p_module: 'classroom' })
  if (error || !data) return back(error?.message ?? 'Could not start the view')

  const res = NextResponse.redirect(new URL(`/o/${encodeURIComponent(slug)}/m/classroom`, request.url), 303)
  res.cookies.set(VIEW_AS_COOKIE, data as string, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 30 * 60,
  })
  return res
}
