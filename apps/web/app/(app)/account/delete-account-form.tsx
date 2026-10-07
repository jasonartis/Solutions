'use client'

import { useActionState } from 'react'
import { requestAccountDeletion } from './actions'

type State = { ok: false; reason: string } | null

// "Delete my account" (docs/21 §7.9). A client component so a refusal can be
// shown: the action returns {ok, reason} rather than throwing (docs/03 #22).
// On success the action redirects to /login, so there is no success state here.
export default function DeleteAccountForm({ email, blockers }: { email: string; blockers: string[] }) {
  const [state, formAction, pending] = useActionState<State, FormData>(
    async (_prev, formData) => (await requestAccountDeletion(formData)) ?? null,
    null,
  )

  const soleAdminOrgs = blockers.filter((b) => b.startsWith('sole_admin:')).map((b) => b.slice('sole_admin:'.length))
  const soleDirector = blockers.filter((b) => b.startsWith('sole_director:')).map((b) => b.slice('sole_director:'.length))
  const isSuperadmin = blockers.includes('superadmin')

  return (
    <section className="mt-8 rounded border border-red-200 bg-white p-4">
      <h2 className="mb-1 text-sm font-medium text-red-800">Delete my account</h2>
      <p className="mb-3 text-sm text-gray-600">
        You will be signed out everywhere. Your account is deleted <strong>30 days</strong> later. If you sign
        in again before then, the deletion is cancelled and everything is as you left it.
      </p>
      <p className="mb-3 text-sm text-gray-600">
        After 30 days your name, email address and sign-in are removed for good, and you leave every
        organization. Things you did that other people rely on — a reply in a conversation, a review of
        someone&apos;s work, a safety report — stay where they are, shown as from a &ldquo;Former member&rdquo;.
      </p>

      {blockers.length > 0 ? (
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="mb-1 font-medium">Your account can&apos;t be deleted yet.</p>
          {soleAdminOrgs.length > 0 && (
            <p>
              You are the only administrator of {soleAdminOrgs.join(', ')}. Make someone else an
              administrator first, so the organization is not left without one.
            </p>
          )}
          {soleDirector.length > 0 && (
            <p>
              You are the only Director of {soleDirector.join(', ')}. Ask an administrator to appoint
              another Director first.
            </p>
          )}
          {isSuperadmin && <p>This is a platform owner account. Remove owner access first.</p>}
        </div>
      ) : (
        <form action={formAction} className="space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block text-gray-700">
              Type your email address, <span className="font-mono text-xs">{email}</span>, to confirm
            </span>
            <input
              name="confirmEmail"
              type="email"
              autoComplete="off"
              required
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none"
            />
          </label>
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={pending}
              className="rounded bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {pending ? 'Working…' : 'Delete my account'}
            </button>
            {state?.ok === false && <span className="text-sm text-red-600">{state.reason}</span>}
          </div>
        </form>
      )}
    </section>
  )
}
