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
//
// Founder feedback (2026-07-16, live-tested on production): the "No user
// with email X" style messages never actually reached this box. Next.js
// redacts a thrown Server Action error's `message` in production builds by
// default (security measure against leaking implementation details) and
// replaces it with a generic "An error occurred in the Server Components
// render..." string — `error.message` below faithfully displays that
// replacement text, which is genuinely all this component ever receives in
// prod. This has silently been the real production behavior since this
// boundary was first built; nobody had verified it until now.
//
// The complete fix is a cross-cutting refactor (every server action across
// every module switching from `throw new Error(...)` to returning a
// structured `{ error: string }` result the caller displays directly,
// Next's documented pattern for user-facing Server Action errors) — too
// large to take on inside this fix. This is the safe, immediate half: a
// generic fallback that's actually helpful instead of alarming, since that
// generic text is what real users will see in production regardless of
// what specifically failed underneath.
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // A message NOT starting with Next's redaction boilerplate made it through
  // uncensored (e.g. local dev, or a future action using the structured
  // pattern) — show it as-is. Otherwise show the generic, reassuring text.
  const isRedacted = !error.message || error.message.includes('Server Components render')
  const displayMessage = isRedacted
    ? "Something didn't go through — often caused by a typo, a value that's already in use, or missing required information. Try again, and double-check what you entered. If it keeps happening, contact your administrator."
    : error.message

  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="mb-3 text-xl font-semibold text-gray-800">Something went wrong</h1>
      <p className="mb-6 rounded border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
        {displayMessage}
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
