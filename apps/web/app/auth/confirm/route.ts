import { redirect } from 'next/navigation'
import { type NextRequest } from 'next/server'
import { type EmailOtpType } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

// Completes magic-link / email-confirmation sign-in.
//
// Two link shapes arrive here:
// - `?code=...` — what Supabase's DEFAULT email templates produce (production
//   uses them; measured 2026-10-13 via the Management API). GoTrue has already
//   verified the link at its own /verify endpoint before redirecting, so after
//   a failed code exchange a SIGNUP address is still confirmed (a password
//   reset, though, needs a new link). The usual cause is the link being opened
//   in a different browser from the one that asked for it (the PKCE verifier
//   lives in that browser's cookie).
// - `?token_hash=...&type=...` — what a custom template pointing straight here
//   would produce. Kept so either template style works.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null
  // Same-site paths only: an absolute or protocol-relative `next` would make
  // this route an open redirect behind a genuine-looking platform link.
  const rawNext = searchParams.get('next') ?? ''
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') && !rawNext.startsWith('/\\') ? rawNext : '/dashboard'

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) redirect(next)
    // Signup confirmation or password reset — the route cannot tell which, so
    // the login page's wording covers both.
    redirect('/login?link=other-browser')
  }

  if (tokenHash && type) {
    const supabase = await createClient()
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
    if (!error) redirect(next)
  }

  // GoTrue redirects with ?error=... when the link was expired or already used.
  redirect(searchParams.get('error') ? '/login?confirm=failed' : '/login')
}
