import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// "Open" on the vendor accounts page (docs/28 Part A): record the click, then
// send the browser to the vendor's sign-in page. The page posts here from a
// form with target="_blank", so the vendor opens in a new tab.
//
// - POST, not GET: a GET would be followed by link prefetchers and could be
//   triggered by any page; the auth cookie is SameSite=Lax, so a cross-site
//   POST arrives signed out and is refused.
// - The address comes from the DATABASE row, never from the request, so this
//   cannot be used to redirect anywhere else.
// - The click is recorded BEFORE redirecting. If it cannot be recorded, the
//   vendor is still opened (the founder needs to get there) but the page will
//   show it as not opened, which is the honest answer.
// - Referrer-Policy: no-referrer, so the vendor does not learn our console URL.
export async function POST(request: NextRequest) {
  const form = await request.formData()
  const accountId = String(form.get('account_id') ?? '')
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) {
    return new NextResponse('Not found', { status: 404 })
  }

  const supabase = await createClient()
  // RLS returns nothing to anyone but the superadmin, so a non-superadmin gets
  // the same 404 as a missing account.
  const { data: account } = await supabase
    .from('vendor_accounts')
    .select('id, sign_in_url')
    .eq('id', accountId)
    .maybeSingle()
  if (!account) return new NextResponse('Not found', { status: 404 })

  await supabase.from('vendor_account_opens').insert({ account_id: account.id })

  const target = account.sign_in_url ?? new URL('/console/vendors', request.url).toString()
  const response = NextResponse.redirect(target, 303)
  response.headers.set('Referrer-Policy', 'no-referrer')
  return response
}
