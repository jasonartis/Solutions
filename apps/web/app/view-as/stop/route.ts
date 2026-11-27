import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { VIEW_AS_COOKIE } from '@/lib/view-as-real'

// Stop a real view (docs/13 "THE DESIGN"). The ONLY non-GET request the proxy
// lets through while a view is open. The proxy forwards no view-as header on
// this path, so createClient() here is the viewer's own session: the database
// closes the session (view_as_real_end — the session's own actor, superadmin
// or staff) and the cookie is cleared even if that call fails, so Stop always
// gets the viewer out.
//
// Where to land: the banner's form sends `back` — the module picker for a staff
// view (docs/13 "STAFF VIEW AS"), the console otherwise. Only a same-site path
// of a known shape is accepted.
export async function POST(request: NextRequest) {
  const session = request.cookies.get(VIEW_AS_COOKIE)?.value
  if (session) {
    const supabase = await createClient()
    await supabase.rpc('view_as_real_end', { p_session: session })
  }
  let back = '/console/view-as/real'
  try {
    const form = await request.formData()
    const b = String(form.get('back') ?? '')
    if (/^\/o\/[a-z0-9-]{1,80}\/m\/[a-z0-9-]{1,40}\/view-as$/.test(b)) back = b
  } catch {
    // No form body: the console.
  }
  const res = NextResponse.redirect(new URL(back, request.url), 303)
  res.cookies.set(VIEW_AS_COOKIE, '', { path: '/', maxAge: 0 })
  return res
}
