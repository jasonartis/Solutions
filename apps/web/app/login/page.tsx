'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SiteFooter } from '@/components/site-footer'

type Mode = 'signin' | 'signup' | 'magic' | 'reset'

export default function LoginPage() {
  const router = useRouter()
  const supabase = createClient()
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  // Collected at SIGNUP so `profiles.display_name` is never null for a new
  // account (docs/22 §11 step 1). handle_new_user() reads it out of
  // raw_user_meta_data, so it must be passed as signUp option data — there is
  // no second write. Everyone on the platform is rendered by this name once
  // `profiles.email` is gone; it is the only identity a co-member ever sees.
  const [displayName, setDisplayName] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  // A neutral "go and check your email" line, shown in place of an error.
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Flips once React has taken over this page. If it never does (an old or
  // restricted browser), the server-rendered notice below stays and fades in.
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  // Set by the 'Delete my account' action on its way here (docs/21 §7.9).
  // Read from location in an effect rather than useSearchParams, which would
  // force a Suspense boundary onto this whole page.
  const [deletionDue, setDeletionDue] = useState<string | null>(null)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    if (q.get('deletion') === 'scheduled') setDeletionDue(q.get('due') ?? '')
    // Set by /auth/confirm when GoTrue confirmed the address but no session
    // could be started here (typically: the link was opened in another browser).
    if (q.get('link') === 'other-browser')
      setNotice(
        'That link was opened in a different browser from the one that asked for it. If you were confirming a new account, it is confirmed: sign in below. If you were resetting your password, ask for a new link from this browser.',
      )
    if (q.get('confirm') === 'failed') setMessage('That link has expired or was already used. Sign in, or request a new link.')
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMessage(null)
    setNotice(null)

    if (mode === 'reset') {
      // GoTrue answers an unknown address exactly like a known one (it never
      // says whether an account exists), so the notice must not either. The
      // link goes through /auth/confirm, which signs the person in and sends
      // them to /account?reset=1, where the new-password form is shown first.
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${location.origin}/auth/confirm?next=${encodeURIComponent('/account?reset=1')}`,
      })
      if (error) setMessage(error.message)
      else
        setNotice(
          'If an account uses this address, we have sent it a link to choose a new password. Open it in this browser.',
        )
      setBusy(false)
      return
    }

    if (mode === 'magic') {
      // A magic link both signs in an existing user and creates a new one, so
      // pass the name when it was given; an existing user's metadata is not
      // overwritten by it, and handle_new_user only reads it on INSERT.
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${location.origin}/auth/confirm`,
          ...(displayName.trim() ? { data: { display_name: displayName.trim() } } : {}),
        },
      })
      // A magic link for a NEW address creates the account, so the re-signup
      // hook answers a blocked one with 422 "User already registered" — shown
      // as the same notice, for the same reason as the signup branch below.
      if (error && error.message !== 'User already registered') setMessage(error.message)
      else setNotice('Check your email for the sign-in link.')
      setBusy(false)
      return
    }

    if (mode === 'signup') {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${location.origin}/auth/confirm`,
          data: { display_name: displayName.trim() },
        },
      })
      // With confirm-email ON (production), a new address gets no session until
      // the emailed link is clicked — and GoTrue answers an ALREADY-registered
      // address the same way (a fake success, no email sent). A re-signup-blocked
      // address gets 422 "User already registered" from the Before User Created
      // hook (docs/21 §7.12.1); GoTrue itself never says that while confirm-email
      // is on, so treating it as the same outcome keeps a removed person's
      // address looking exactly like any other on this screen. The wording is
      // true for all three cases.
      if (!error && data.session) {
        router.push('/dashboard')
        router.refresh()
        return
      }
      if (!error || error.message === 'User already registered') {
        setNotice(
          'Check your email. If this address can be used for a new account, we have sent it a link to confirm it. Already have an account? Sign in instead.',
        )
      } else {
        setMessage(error.message)
      }
      setBusy(false)
      return
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setMessage(error.message)
      setBusy(false)
      return
    }
    router.push('/dashboard')
    router.refresh()
  }

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      <main className="flex flex-1 items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <h1 className="mb-1 text-xl font-semibold">Solutions Platform</h1>
          <p className="mb-6 text-sm text-gray-500">
            {mode === 'signin' && 'Sign in to your account'}
            {mode === 'signup' && 'Create an account'}
            {mode === 'magic' && 'Get a sign-in link by email'}
            {mode === 'reset' && 'Reset your password'}
          </p>

          {deletionDue !== null && (
            <p className="mb-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              Your account is scheduled for deletion{deletionDue ? ` on ${deletionDue}` : ''} and you have been
              signed out everywhere. Changed your mind? Sign in before then and the deletion is cancelled.
            </p>
          )}

          {!ready && (
            <>
              <style>{'@keyframes sp-late{to{opacity:1}}'}</style>
              <p
                role="alert"
                style={{ opacity: 0, animation: 'sp-late 0s 4s forwards' }}
                className="mb-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
              >
                This page hasn&apos;t finished loading. If tapping Sign in only clears the form, your browser is
                probably too old or is blocking scripts. Update your browser or iOS/Android, turn off Private
                Browsing, Lockdown Mode or content blockers for this site, or try another browser or device.
              </p>
            </>
          )}

          <form onSubmit={submit} className="space-y-4">
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Email</span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </label>

            {(mode === 'signup' || mode === 'magic') && (
              <label className="block">
                <span className="mb-1 block text-sm font-medium">
                  Display name{mode === 'magic' && <span className="text-gray-400"> (new accounts)</span>}
                </span>
                <input
                  type="text"
                  required={mode === 'signup'}
                  maxLength={80}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Your display name"
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </label>
            )}

            {(mode === 'signin' || mode === 'signup') && (
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Password</span>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </label>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy
                ? 'Working…'
                : mode === 'signin'
                  ? 'Sign in'
                  : mode === 'signup'
                    ? 'Sign up'
                    : mode === 'reset'
                      ? 'Send reset link'
                      : 'Send link'}
            </button>
            {mode === 'signin' && (
              <button
                type="button"
                onClick={() => setMode('reset')}
                className="text-sm text-blue-600 hover:underline"
              >
                Forgot password?
              </button>
            )}
          </form>

          {notice && (
            <p role="status" className="mt-4 rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
              {notice}
            </p>
          )}
          {message && <p className="mt-4 text-sm text-red-600">{message}</p>}

          <div className="mt-6 flex justify-between text-sm text-blue-600">
            {mode !== 'signin' && (
              <button onClick={() => setMode('signin')} className="hover:underline">
                Sign in
              </button>
            )}
            {mode !== 'signup' && (
              <button onClick={() => setMode('signup')} className="hover:underline">
                Create account
              </button>
            )}
            {mode !== 'magic' && (
              <button onClick={() => setMode('magic')} className="hover:underline">
                Email link
              </button>
            )}
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  )
}
