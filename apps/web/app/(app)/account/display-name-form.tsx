'use client'

import { useActionState } from 'react'
import { setDisplayName } from './actions'

const inputCls = 'w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none'

type State = { ok: true } | { ok: false; reason: string } | null

// A client component so the action's REFUSAL can actually be shown. The action
// returns `{ok, reason}` rather than throwing (docs/03 #22): a message thrown
// from a Server Action is REDACTED in production, so a thrown validation error
// would reach the user as an opaque digest.
export default function DisplayNameForm({ initial }: { initial: string }) {
  const [state, formAction, pending] = useActionState<State, FormData>(
    async (_prev, formData) => setDisplayName(formData),
    null,
  )

  return (
    <form action={formAction} className="mb-8 space-y-3 rounded border border-gray-200 bg-white p-4">
      <label className="block">
        <span className="mb-1 block text-sm font-medium">Display name</span>
        <input
          name="displayName"
          type="text"
          required
          maxLength={80}
          defaultValue={initial}
          placeholder="How others in your organization see you"
          className={inputCls}
        />
      </label>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
        {state?.ok === true && <span className="text-sm text-green-700">Saved.</span>}
        {state?.ok === false && <span className="text-sm text-red-600">{state.reason}</span>}
      </div>
    </form>
  )
}
