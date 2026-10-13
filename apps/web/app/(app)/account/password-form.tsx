'use client'

import { useActionState } from 'react'
import { setPassword } from './actions'

const inputCls = 'w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none'

type State = { ok: true } | { ok: false; reason: string } | null

// `reset` is true when the person arrived from a "Forgot password?" email:
// they are signed in by that link, and this is the step they came for.
export default function PasswordForm({ reset }: { reset: boolean }) {
  const [state, formAction, pending] = useActionState<State, FormData>(
    async (_prev, formData) => setPassword(formData),
    null,
  )

  return (
    <form
      id="password"
      action={formAction}
      className={`mb-8 space-y-3 rounded border bg-white p-4 ${reset ? 'border-blue-400 ring-2 ring-blue-100' : 'border-gray-200'}`}
    >
      <h2 className="text-sm font-medium">{reset ? 'Choose a new password' : 'Change password'}</h2>
      {reset && (
        <p className="text-sm text-gray-600">You are signed in from your reset link. Set a new password to finish.</p>
      )}
      <label className="block">
        <span className="mb-1 block text-sm">New password</span>
        <input name="password" type="password" required minLength={6} autoComplete="new-password" className={inputCls} />
      </label>
      <label className="block">
        <span className="mb-1 block text-sm">Confirm new password</span>
        <input name="confirm" type="password" required minLength={6} autoComplete="new-password" className={inputCls} />
      </label>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save password'}
        </button>
        {state?.ok === true && <span className="text-sm text-green-700">Password changed.</span>}
        {state?.ok === false && <span className="text-sm text-red-600">{state.reason}</span>}
      </div>
    </form>
  )
}
