'use client'

import { useActionState } from 'react'
import type { InviteState } from './actions'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'

// Invite by address (docs/25). A client component so the result can be shown
// inline; the action returns {ok, reason} rather than throwing (docs/03 #22).
// The wording is the same whether or not the address has an account.
export default function InviteForm(props: {
  action: (formData: FormData) => Promise<InviteState>
  roles: readonly string[]
}) {
  const [state, formAction, pending] = useActionState<InviteState, FormData>(
    async (_prev, formData) => props.action(formData),
    null,
  )

  return (
    <div className="mb-6">
      <h3 className="mb-2 text-sm font-medium text-gray-600">Invite someone</h3>
      <p className="mb-2 max-w-xl text-xs text-gray-400">
        Enter their email address, even if they haven&apos;t joined the platform yet. Once they sign in with that
        address, they&apos;ll see the invitation on their dashboard and can accept it. We don&apos;t send an email, so
        let them know yourself. Invitations expire after 30 days.
      </p>
      <form action={formAction} className="flex flex-wrap items-center gap-2">
        <input name="email" type="email" required placeholder="email@example.com" className={`${inputCls} w-56`} />
        <select name="role" className={inputCls} defaultValue="member">
          {props.roles.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button
          disabled={pending}
          className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Invite'}
        </button>
      </form>
      {state?.ok === true && (
        <p role="status" className="mt-2 text-sm text-green-700">
          {state.message}
        </p>
      )}
      {state?.ok === false && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {state.reason}
        </p>
      )}
    </div>
  )
}
