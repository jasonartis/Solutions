'use client'

import { useActionState, useEffect, useRef } from 'react'
import type { InviteState } from '@/lib/org-members'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'

// THE ONE INVITE FORM — used by the org's Members page AND the Owner Console's
// org cards (via components/org-invite-section.tsx). Change it here and both
// change; do not fork a copy (founder, 2026-11-10).
//
// Invite by address (docs/25). A client component so the result can be shown
// inline; the action returns {ok, reason} rather than throwing (docs/03 #22).
// The wording is the same whether or not the address has an account.
export default function OrgInviteForm(props: {
  action: (formData: FormData) => Promise<InviteState>
  roles: readonly string[]
  // Modules switched on for this org, with their role vocabulary. An invitation
  // may carry ONE module role (docs/25 §12): it is granted only after the
  // person accepts the organization invitation.
  modules: { key: string; name: string; roles: readonly string[] }[]
  // Platform superadmin only (the Owner Console passes it). Adds the choice to
  // make an EXISTING account an active member at once, skipping the invitation.
  // The action re-checks the caller is the superadmin; the form just offers it.
  allowImmediate?: boolean
  immediateDefault?: boolean
}) {
  // React clears a form's fields after its action runs. That is right after a
  // success, wrong after a refusal: the person would retype the address to
  // try again (e.g. after "that address has no account — untick active
  // immediately"). So remember what was sent and put the address back when the
  // result is a refusal.
  const emailRef = useRef<HTMLInputElement>(null)
  const sentEmail = useRef('')
  const [state, formAction, pending] = useActionState<InviteState, FormData>(async (_prev, formData) => {
    sentEmail.current = String(formData.get('email') ?? '')
    return props.action(formData)
  }, null)
  useEffect(() => {
    if (state?.ok === false && emailRef.current) emailRef.current.value = sentEmail.current
  }, [state])

  return (
    <div className="mb-6">
      <h3 className="mb-2 text-sm font-medium text-gray-600">Invite someone</h3>
      <p className="mb-2 max-w-xl text-xs text-gray-400">
        Enter their email address, even if they haven&apos;t joined the platform yet. Once they sign in with that
        address, they&apos;ll see the invitation on their dashboard and can accept it. We don&apos;t send an email, so
        let them know yourself. Invitations expire after 30 days. A module role you pick is given once they
        accept.
      </p>
      <form action={formAction} className="flex flex-wrap items-center gap-2">
        <input ref={emailRef} name="email" type="email" required placeholder="email@example.com" className={`${inputCls} w-56`} />
        <select name="role" className={inputCls} defaultValue="member">
          {props.roles.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        {props.modules.length > 0 && (
          <select name="moduleRole" className={inputCls} defaultValue="" aria-label="Also give a module role">
            <option value="">no module role</option>
            {props.modules.map((m) => (
              <optgroup key={m.key} label={m.name}>
                {m.roles.map((r) => (
                  <option key={r} value={`${m.key}:${r}`}>
                    {m.name}: {r}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        )}
        {props.allowImmediate && (
          <label className="flex items-center gap-1 text-xs text-gray-600">
            <input type="checkbox" name="immediate" defaultChecked={props.immediateDefault} />
            add active immediately (they must already have an account)
          </label>
        )}
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
