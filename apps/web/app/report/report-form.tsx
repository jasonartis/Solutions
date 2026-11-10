'use client'

import { useActionState, useState } from 'react'
import { Dancing_Script } from 'next/font/google'
import { REPORT_REASONS } from '@/lib/content-reports'
import { submitReport, type ReportField, type ReportResult } from './actions'

// The signature is drawn in a handwriting font, like a typed e-signature in a
// PDF signing tool. What is stored is the typed name (the electronic signature
// the TAKE IT DOWN Act asks for); the font is only how it looks.
const signatureFont = Dancing_Script({ subsets: ['latin'], weight: '600' })

const inputClass = 'w-full rounded border px-3 py-2 text-sm'

export function ReportForm({ contactEmail }: { contactEmail: string | null }) {
  const [state, formAction, pending] = useActionState<ReportResult | null, FormData>(
    async (_prev, fd) => submitReport(fd),
    null,
  )
  const [reason, setReason] = useState('')
  const [signature, setSignature] = useState('')
  const bad = new Set<ReportField>(state?.ok === false && state.reason === 'fields' ? state.fields : [])
  const border = (f: ReportField) => (bad.has(f) ? 'border-red-500' : 'border-gray-300')
  const today = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })

  if (state?.ok) {
    return <p className="rounded border border-green-200 bg-green-50 p-4 text-sm text-green-800">Thank you. We review every report.</p>
  }

  return (
    <form action={formAction} className="flex flex-col gap-5 text-sm" noValidate={false}>
      {/* Honeypot: hidden from people and from screen readers. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>
          Website
          <input type="text" name="website" tabIndex={-1} autoComplete="off" defaultValue="" />
        </label>
      </div>

      <label className="block">
        <span className="mb-1 block font-medium">Where did you see it?</span>
        <input name="where" required maxLength={1000} className={`${inputClass} ${border('where')}`} />
        <span className="mt-1 block text-xs text-gray-500">
          A link, or a description of where it is (for example, the organization&apos;s name).
        </span>
      </label>

      <label className="block">
        <span className="mb-1 block font-medium">Reason</span>
        <select
          name="reason"
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className={`${inputClass} ${border('reason')}`}
        >
          <option value="" disabled>
            Choose a reason
          </option>
          {REPORT_REASONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="mb-1 block font-medium">Anything else we should know? (optional)</span>
        <textarea name="details" rows={4} maxLength={2000} className={`${inputClass} ${border('details')}`} />
      </label>

      <label className="block">
        <span className="mb-1 block font-medium">Your email</span>
        <input name="email" type="email" required maxLength={254} autoComplete="email" className={`${inputClass} ${border('email')}`} />
        <span className="mt-1 block text-xs text-gray-500">We may contact you about this report.</span>
      </label>

      {reason === 'intimate' && (
        <fieldset className="flex flex-col gap-4">
          <div>
            <label htmlFor="signature" className="mb-1 block font-medium">
              Signature
            </label>
            <div className={`rounded-md border bg-sky-50/60 px-4 pt-3 pb-2 ${bad.has('signature') ? 'border-red-500' : 'border-sky-200'}`}>
              <div className="flex items-end gap-2 border-b border-gray-500">
                <span className="pb-1 text-lg text-gray-500" aria-hidden="true">
                  ✕
                </span>
                <input
                  id="signature"
                  name="signature"
                  required
                  maxLength={200}
                  autoComplete="name"
                  value={signature}
                  onChange={(e) => setSignature(e.target.value)}
                  className={`${signatureFont.className} w-full bg-transparent pb-0.5 text-3xl text-sky-950 outline-none`}
                />
              </div>
              <p className="mt-1 text-xs text-gray-500">
                {signature.trim() ? `Signed electronically · ${today}` : 'Type your full name. This is your electronic signature.'}
              </p>
            </div>
          </div>
          <label className={`flex items-start gap-2 ${bad.has('nonconsent') ? 'text-red-700' : ''}`}>
            <input type="checkbox" name="nonconsent" required className="mt-0.5" />
            <span>
              I am the person shown, or I am allowed to act for them, and I believe in good faith that this image was
              shared without consent.
            </span>
          </label>
        </fieldset>
      )}

      <label className={`flex items-start gap-2 ${bad.has('accurate') ? 'text-red-700' : ''}`}>
        <input type="checkbox" name="accurate" required className="mt-0.5" />
        <span>The information I&apos;ve given is accurate</span>
      </label>

      {state?.ok === false && state.reason === 'fields' && (
        <p className="text-red-700">Please check the highlighted fields.</p>
      )}
      {state?.ok === false && state.reason === 'refused' && (
        <p className="text-red-700">
          {contactEmail
            ? `We couldn't send your report. Please try again later, or email ${contactEmail} and tell us where you saw it.`
            : "We couldn't send your report. Please try again later."}
        </p>
      )}

      <div>
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
        >
          Send report
        </button>
      </div>
    </form>
  )
}
