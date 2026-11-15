import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { VIEW_AS_COOKIE } from '@/lib/view-as-real'

// Stop a real view (docs/13 "THE DESIGN"). The ONLY non-GET request the proxy
// lets through while a view is open. The proxy forwards no view-as header on
// this path, so createClient() here is the superadmin's own session: the
// database closes the session (view_as_real_end) and the cookie is cleared even
// if that call fails, so Stop always gets the superadmin out.
export async function POST(request: NextRequest) {
  const session = request.cookies.get(VIEW_AS_COOKIE)?.value
  if (session) {
    const supabase = await createClient()
    await supabase.rpc('view_as_real_end', { p_session: session })
  }
  const res = NextResponse.redirect(new URL('/console/view-as/real', request.url), 303)
  res.cookies.set(VIEW_AS_COOKIE, '', { path: '/', maxAge: 0 })
  return res
}
