'use client'

// A <form> that calls a Server Action and shows a refusal INLINE (docs/03 #22).
// Next's own `<form action={fn}>` resets the form when the action finishes and
// has nowhere to put a returned reason, so a refused submit would silently wipe
// what the person typed. Here the submit is handled by hand: the fields keep
// their values, and `reason` appears under the buttons.

import { useState, useTransition, type ReactNode } from 'react'
import type { ActionResult } from './actions'

export const STALE_DEPLOY_MESSAGE =
  'The site was updated while this page was open. Reload the page to continue — nothing you have drawn here has been lost until you do.'
const NETWORK_MESSAGE = 'Could not reach the server. Check your connection and try again.'

// Calls a Server Action and turns every way it can go wrong into a reason
// string. A thrown error here is NOT a refusal (those come back as
// {ok:false}) — it is the browser failing to reach the action, and the one
// that matters is a stale tab: action ids change on every deploy, so a tab
// opened before one gets "Server Action … was not found" on every send.
export async function runAction<T extends { ok: boolean }>(
  call: () => Promise<T | void>,
): Promise<T | { ok: false; reason: string } | { ok: true }> {
  try {
    const result = await call()
    // A redirecting action resolves with nothing (the router navigates away).
    return result ?? { ok: true }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (/server action/i.test(message) && /not found|could not be found|was not found/i.test(message)) {
      return { ok: false, reason: STALE_DEPLOY_MESSAGE }
    }
    return { ok: false, reason: NETWORK_MESSAGE }
  }
}

export function ActionForm(props: {
  action: (formData: FormData) => Promise<ActionResult | void>
  children: ReactNode
  className?: string
  /** clear the fields after a successful submit (a "create" form) */
  resetOnSuccess?: boolean
  /** rewrite the form data before it is sent (e.g. shrink a picture) */
  prepare?: (formData: FormData) => Promise<FormData>
}) {
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  return (
    <form
      className={props.className}
      onSubmit={(e) => {
        e.preventDefault()
        const form = e.currentTarget
        const formData = new FormData(form)
        setError(null)
        startTransition(async () => {
          const result = await runAction(async () =>
            props.action(props.prepare ? await props.prepare(formData) : formData),
          )
          if (!result.ok) setError((result as { reason: string }).reason)
          else if (props.resetOnSuccess) form.reset()
        })
      }}
    >
      <fieldset disabled={pending} className="contents">
        {props.children}
      </fieldset>
      {error && (
        <p role="alert" className="w-full text-sm text-red-600">
          {error}
        </p>
      )}
    </form>
  )
}
