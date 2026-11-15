import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createViewAsClient, getRealView } from '@/lib/view-as-real'

// Server-side Supabase client bound to the current user's session cookies.
// Queries through this client run under RLS as that user — this is the
// platform's tenancy enforcement, so never swap it for a service-role client.
//
// REAL VIEW-AS (docs/13, 2026-11-12): when the proxy has marked this request as
// an in-scope real view (a header it signed after asking the database), the
// client runs as the PERSON being viewed, read-only — see lib/view-as-real.ts.
// This is the single switch that lets the same pages render their screen.
export async function createClient() {
  const view = await getRealView()
  if (view?.inScope) return createViewAsClient(view)

  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            )
          } catch {
            // Called from a Server Component — cookie writes are handled by proxy.ts.
          }
        },
      },
    },
  )
}
