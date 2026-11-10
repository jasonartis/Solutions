'use client'

import { useRef, useState, useTransition } from 'react'
import type { ActionResult } from '@/lib/org-members'

// The two per-member controls in the shared member list (components/
// org-members-panel.tsx, rendered by the org's Members page AND the Owner
// Console). Founder, 2026-11-10: a role change must LOOK unsaved until Update is
// pressed, and Remove must ask first. Change them here and both pages change.

const selectBase = 'rounded border px-2 py-1 text-xs'

// A role dropdown that shows whether its value is SAVED.
//   green  = this is the member's saved role (what the database holds)
//   amber  = you changed it and have NOT pressed Update — nothing has happened yet
// Update applies it; Undo puts the dropdown back. Picking a value alone never
// changes anyone's role.
export function RoleChangeForm(props: {
  userId: string
  /** The member's saved role, as the page loaded it. */
  savedRole: string
  roles: readonly string[]
  action: (formData: FormData) => Promise<ActionResult>
}) {
  const [value, setValue] = useState(props.savedRole)
  const [saved, setSaved] = useState(props.savedRole)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  // After a save the page re-renders with the new saved role; follow it. (State
  // adjusted during render, React's pattern for "reset when a prop changes".)
  // The dropdown follows a refreshed saved role ONLY if you have not picked
  // something else since: the refresh after your own Update lands a moment later,
  // and it must not overwrite a newer pick you have already made.
  const [seenRole, setSeenRole] = useState(props.savedRole)
  if (props.savedRole !== seenRole) {
    setSeenRole(props.savedRole)
    if (value === saved) setValue(props.savedRole)
    setSaved(props.savedRole)
  }

  const dirty = value !== saved

  function submit() {
    const formData = new FormData()
    formData.set('userId', props.userId)
    formData.set('role', value)
    start(async () => {
      const result = await props.action(formData)
      if (result.ok) {
        setSaved(value)
        setError(null)
      } else {
        setError(result.reason)
      }
    })
  }

  return (
    <div>
      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault()
          if (dirty) submit()
        }}
      >
        <select
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setError(null)
          }}
          aria-label="Organization role"
          data-state={dirty ? 'unsaved' : 'saved'}
          className={`${selectBase} ${
            dirty ? 'border-amber-400 bg-amber-50 text-amber-900 ring-2 ring-amber-200' : 'border-green-300 bg-green-50 text-green-800'
          }`}
        >
          {props.roles.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button
          disabled={!dirty || pending}
          className={`rounded px-2 py-1 text-xs font-medium ${
            dirty ? 'bg-amber-500 text-white hover:bg-amber-600' : 'text-gray-400'
          } disabled:opacity-60`}
        >
          {pending ? 'Saving…' : 'Update'}
        </button>
        {dirty && (
          <button
            type="button"
            onClick={() => {
              setValue(saved)
              setError(null)
            }}
            className="text-xs text-gray-600 hover:underline"
          >
            Undo
          </button>
        )}
      </form>
      {dirty && (
        <p className="mt-0.5 text-[11px] text-amber-700">Not saved yet — they are still {saved}. Press Update to change it.</p>
      )}
      {error && (
        <p role="alert" className="mt-0.5 max-w-xs text-[11px] text-red-600">
          {error}
        </p>
      )}
    </div>
  )
}

// Remove, behind a confirmation popup. The refusal reason (e.g. "an organization
// must keep at least one owner or admin") is shown IN the popup, so a refused
// removal never lands on the generic error page.
export function RemoveMemberButton(props: {
  userId: string
  personName: string
  orgName: string
  /** An invitation not yet accepted: the wording is about withdrawing it. */
  isPending: boolean
  action: (userId: string) => Promise<ActionResult>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  function confirmRemove() {
    start(async () => {
      const result = await props.action(props.userId)
      if (result.ok) dialog.current?.close()
      else setError(result.reason)
    })
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError(null)
          dialog.current?.showModal()
        }}
        className="px-1 py-1.5 text-xs text-red-600 hover:underline"
      >
        Remove
      </button>
      <dialog ref={dialog} className="w-full max-w-md rounded-lg p-0 shadow-xl backdrop:bg-black/40">
        <div className="p-5">
          <h4 className="text-base font-semibold text-gray-900">
            {props.isPending
              ? `Withdraw ${props.personName}'s invitation to ${props.orgName}?`
              : `Remove ${props.personName} from ${props.orgName}?`}
          </h4>
          <p className="mt-2 text-sm text-gray-600">
            {props.isPending
              ? 'They have not accepted yet. They will no longer see the invitation, and you would have to invite them again.'
              : 'They will lose access to this organization and everything in it. To bring them back you would have to invite them again.'}
          </p>
          {error && (
            <p role="alert" className="mt-3 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
              {error}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={confirmRemove}
              className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
            >
              {pending ? 'Removing…' : props.isPending ? 'Yes, withdraw' : 'Yes, remove'}
            </button>
          </div>
        </div>
      </dialog>
    </>
  )
}
