'use client'

import { useActionState, useEffect, useState } from 'react'
import { FEEDBACK_KINDS } from '@/lib/feedback'
import { replyToTicket, sendFeedback, setTicketStatus } from './actions'

type State = { ok: true } | { ok: false; reason: string } | null

const inputCls = 'w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none'
const buttonCls =
  'rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50'

type PageDetails = {
  path: string | null
  notice: string | null
  error: string | null
  orgName: string | null
  moduleKey: string | null
  recordIds: string[]
}

/**
 * The new-ticket form. Browser details are read here (they only exist in the
 * browser) and shown in the "what will be sent" panel BEFORE sending, with one
 * switch that drops every optional detail (docs/27: nothing collected in secret).
 */
export function NewFeedbackForm({ from, details }: { from: string; details: PageDetails | null }) {
  const [state, formAction, pending] = useActionState<State, FormData>(async (_p, fd) => sendFeedback(fd), null)
  const [includeDetails, setIncludeDetails] = useState(true)
  const [browser, setBrowser] = useState<{ userAgent: string; viewport: string; language: string; timeZone: string } | null>(null)

  useEffect(() => {
    setBrowser({
      userAgent: navigator.userAgent,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      language: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
  }, [])

  return (
    <form action={formAction} className="space-y-4 rounded border border-gray-200 bg-white p-4">
      <input type="hidden" name="from" value={from} />
      <input type="hidden" name="browser" value={JSON.stringify(browser ?? {})} />

      <label className="block">
        <span className="mb-1 block text-sm font-medium">What is it about?</span>
        <select name="kind" defaultValue="bug" className={inputCls}>
          {FEEDBACK_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-medium">Short title</span>
        <input name="title" required maxLength={200} className={inputCls} placeholder="e.g. My camera does not show up" />
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-medium">What happened, or what would you like?</span>
        <textarea
          name="body"
          required
          maxLength={5000}
          rows={6}
          className={inputCls}
          placeholder="What you did, what you expected, and what you saw instead."
        />
      </label>

      <fieldset className="rounded border border-gray-200 bg-gray-50 p-3 text-sm" data-testid="feedback-preview">
        <legend className="px-1 font-medium">What will be sent</legend>
        <p className="mb-2 text-gray-700">Your title and message, and that it came from your account.</p>
        <label className="mb-2 flex items-center gap-2">
          <input
            type="checkbox"
            name="includeDetails"
            checked={includeDetails}
            onChange={(e) => setIncludeDetails(e.target.checked)}
          />
          <span>Also include page and browser details (helps us reproduce a problem)</span>
        </label>
        {includeDetails && (
          <ul className="list-disc space-y-0.5 pl-5 text-gray-600">
            <li>Page: {details?.path ?? 'not known'}</li>
            {details?.orgName && <li>Organization: {details.orgName}</li>}
            {details?.moduleKey && <li>Module: {details.moduleKey}</li>}
            {details?.notice && <li>On-screen message code: {details.notice}</li>}
            {details?.error && <li>On-screen error: {details.error}</li>}
            {details && details.recordIds.length > 0 && <li>Record ids in the address: {details.recordIds.join(', ')}</li>}
            <li>Browser: {browser?.userAgent ?? '…'}</li>
            <li>
              Screen size: {browser?.viewport ?? '…'} · language {browser?.language ?? '…'} · time zone{' '}
              {browser?.timeZone ?? '…'}
            </li>
            <li>The app version and the time you send it</li>
          </ul>
        )}
        <p className="mt-2 text-gray-500">
          Only the platform team reads it. Your organization&apos;s admins do not see it. To help understand a problem, the
          team may also look at what you did on the platform shortly before you wrote.
        </p>
      </fieldset>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={buttonCls}>
          {pending ? 'Sending…' : 'Send'}
        </button>
        {state?.ok === false && (
          <span className="text-sm text-red-600" role="alert">
            {state.reason}
          </span>
        )}
      </div>
    </form>
  )
}

/** Add a message to a ticket. `staff` adds the internal-note switch. */
export function ReplyForm({ ticketId, staff = false }: { ticketId: string; staff?: boolean }) {
  const [state, formAction, pending] = useActionState<State, FormData>(
    async (_p, fd) => replyToTicket(ticketId, fd),
    null,
  )
  const [key, setKey] = useState(0)
  useEffect(() => {
    if (state?.ok) setKey((k) => k + 1) // clear the box after a successful send
  }, [state])

  return (
    <form key={key} action={formAction} className="space-y-2">
      <textarea name="body" required maxLength={5000} rows={4} className={inputCls} aria-label="Your message" />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonCls}>
          {pending ? 'Sending…' : staff ? 'Send reply' : 'Send'}
        </button>
        {staff && (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" name="internal" /> Internal note (the person never sees it)
          </label>
        )}
        {state?.ok === false && (
          <span className="text-sm text-red-600" role="alert">
            {state.reason}
          </span>
        )}
      </div>
    </form>
  )
}

/** A one-click status change (the person: Close; staff: any status). */
export function StatusButton({ ticketId, status, label }: { ticketId: string; status: string; label: string }) {
  const [state, formAction, pending] = useActionState<State, FormData>(
    async () => setTicketStatus(ticketId, status),
    null,
  )
  return (
    <form action={formAction} className="inline">
      <button
        type="submit"
        disabled={pending}
        className="rounded border border-gray-300 bg-white px-2 py-1 text-sm hover:bg-gray-50 disabled:opacity-50"
      >
        {label}
      </button>
      {state?.ok === false && <span className="ml-2 text-sm text-red-600">{state.reason}</span>}
    </form>
  )
}
