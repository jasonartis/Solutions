// REAL VIEW-AS — the superadmin sees a person's actual screen (docs/13 "REAL
// VIEW-AS" → "THE DESIGN", 2026-11-12; migration 20261116010000).
//
// The pieces, in the order a request meets them:
//   1. proxy.ts — while the `sp_view_as` cookie is set: refuses every non-GET
//      request (except POST /view-as/stop); asks the database, AS THE
//      SUPERADMIN, whether the session is still valid (view_as_real_check); and
//      forwards a SIGNED `x-sp-view-as` header describing it. Any incoming copy
//      of that header is deleted first, so a browser cannot supply one.
//   2. lib/supabase/server.ts createClient() — if the header verifies AND the
//      path is in scope, returns createViewAsClient(): a database client whose
//      token is FOR THE PERSON, lives 5 minutes, carries a `view_as` claim, and
//      never leaves this server process. Every page, layout and helper already
//      gets its client from createClient(), so the SAME components render the
//      person's screen — there is no second layout.
//   3. The database treats the `view_as` claim as read-only (pre-request hook,
//      restrictive storage policies) — see the migration header.
//   4. The (app) layout shows ViewAsBanner on every screen while a view is open.
//
// The signing secret (SUPABASE_JWT_SECRET) can sign a token for ANYONE. It is
// read only here and in proxy.ts, only on the server, and is never given a
// NEXT_PUBLIC_ name. Without it the feature refuses to start (startRealView)
// and the header never verifies, so nothing degrades into a half-working view.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { cookies, headers } from 'next/headers'
import { cache } from 'react'
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js'

export const VIEW_AS_COOKIE = 'sp_view_as'
export const VIEW_AS_HEADER = 'x-sp-view-as'
/** Modules a real view may open (the database enforces the same list). */
export const REAL_VIEW_MODULES = ['classroom'] as const
const TOKEN_SECONDS = 5 * 60

/** What the proxy learned from view_as_real_check, passed to the page in a signed header. */
export type RealView = {
  session: string
  actor: string
  target: string
  targetName: string | null
  orgSlug: string
  orgName: string
  module: string
  /** ISO time the session ends. */
  expiresAt: string
  /** True only inside /o/<orgSlug>/m/<module>: elsewhere the superadmin is themselves. */
  inScope: boolean
}

function secret(): string | null {
  const s = process.env.SUPABASE_JWT_SECRET
  return s && s.length >= 32 ? s : null
}

export function realViewConfigured(): boolean {
  return secret() !== null
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url')
const hmac = (key: string, data: string) => createHmac('sha256', key).update(data).digest('base64url')

// The header is "<base64url JSON>.<HMAC>". The HMAC uses a DIFFERENT input
// prefix from the JWT, so a header value can never be replayed as a token.
export function signRealViewHeader(v: RealView): string | null {
  const key = secret()
  if (!key) return null
  const body = b64(JSON.stringify(v))
  return `${body}.${hmac(key, `sp-view-as-header|${body}`)}`
}

export function verifyRealViewHeader(value: string | null): RealView | null {
  const key = secret()
  if (!key || !value) return null
  const [body, sig] = value.split('.')
  if (!body || !sig) return null
  const want = Buffer.from(hmac(key, `sp-view-as-header|${body}`))
  const got = Buffer.from(sig)
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  try {
    const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as RealView
    if (Date.parse(v.expiresAt) <= Date.now()) return null
    return v
  } catch {
    return null
  }
}

/** The open real view for THIS request (null when none). One header read per request. */
// The header must also name the session in THIS browser's cookie, so a header
// value could never be replayed from elsewhere, even though it never reaches a
// browser (app-code review hardening, 2026-11-12).
export const getRealView = cache(async (): Promise<RealView | null> => {
  const [h, jar] = await Promise.all([headers(), cookies()])
  const view = verifyRealViewHeader(h.get(VIEW_AS_HEADER))
  if (!view || view.session !== jar.get(VIEW_AS_COOKIE)?.value) return null
  return view
})

/** HS256 token for the person being viewed: 5 minutes at most, never past the session. */
function mintToken(v: RealView, key: string): string {
  const now = Math.floor(Date.now() / 1000)
  const sessionEnd = Math.floor(Date.parse(v.expiresAt) / 1000)
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64(
    JSON.stringify({
      sub: v.target,
      role: 'authenticated',
      aud: 'authenticated',
      iat: now,
      exp: Math.min(now + TOKEN_SECONDS, sessionEnd),
      is_anonymous: false,
      // The database's read-only gate keys on this claim (is_view_as_request()).
      view_as: { session: v.session, actor: v.actor },
    }),
  )
  return `${header}.${payload}.${hmac(key, `${header}.${payload}`)}`
}

/**
 * A database client that runs AS the person, read-only. No cookies are read or
 * written, so the superadmin's own session is untouched. Its `auth` allows only
 * the reads pages use (getUser, getSession); every other auth call throws,
 * because GoTrue would accept this token for a password or email change.
 */
export function createViewAsClient(v: RealView): SupabaseClient {
  const key = secret()
  if (!key) throw new Error('Real view-as is not configured on this server')
  const token = mintToken(v, key)
  const client = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  const auth = client.auth
  const guarded = new Proxy(auth, {
    get(target, prop, receiver) {
      // getUser() with no argument would look for a stored session; hand it the token.
      if (prop === 'getUser') return () => target.getUser(token)
      // supabase-js itself calls getSession() before every request; with no stored
      // session it returns null and the Authorization header above is used.
      if (prop === 'getSession') return () => target.getSession()
      // The nested admin and MFA APIs are objects, not functions: block them by name.
      if (prop === 'admin' || prop === 'mfa') {
        throw new Error(`Read-only view: auth.${String(prop)} is not allowed while viewing as someone`)
      }
      const value = Reflect.get(target, prop, receiver)
      if (typeof value === 'function') {
        return () => {
          throw new Error(`Read-only view: auth.${String(prop)} is not allowed while viewing as someone`)
        }
      }
      return value
    },
  })
  Object.defineProperty(client, 'auth', { value: guarded })
  return client
}
