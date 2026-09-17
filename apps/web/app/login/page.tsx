'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SiteFooter } from '@/components/site-footer'

type Mode = 'signin' | 'signup' | 'magic'

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
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMessage(null)

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
      setMessage(error ? error.message : 'Check your email for the sign-in link.')
      setBusy(false)
      return
    }

    const { error } =
      mode === 'signin'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({
            email,
            password,
            options: { data: { display_name: displayName.trim() } },
          })

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
          </p>

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

            {mode !== 'signin' && (
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
                  placeholder="How others in your organization see you"
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </label>
            )}

            {mode !== 'magic' && (
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
                    : 'Send link'}
            </button>
          </form>

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
