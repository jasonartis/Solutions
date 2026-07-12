'use client'

// Founder feedback (2026-07-11): entering an invalid email in the
// matchmaker-assignment form (a thrown server-action Error, e.g. "No user
// with email X") surfaced as an ugly generic "This page couldn't load" —
// because there was NO error boundary anywhere in the app, so every
// module's server-action errors (not just this one) fell back to Next.js's
// default unstyled error UI. This is the one boundary that covers all of
// them at once: every authenticated page under (app) — dashboard, every
// module, every manage console — gets a plain-language message and a way
// to recover instead of a dead end.
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="mb-3 text-xl font-semibold text-gray-800">Something went wrong</h1>
      <p className="mb-6 rounded border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
        {error.message || 'An unexpected error occurred.'}
      </p>
      <div className="flex justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Try again
        </button>
        <a
          href="/dashboard"
          className="rounded border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Back to Dashboard
        </a>
      </div>
    </div>
  )
}
