import * as Sentry from '@sentry/nextjs'

// Guarded on the DSN so this stays inert until the founder supplies one
// (docs/18 item 1) — no DSN, no init, nothing sent anywhere.
export async function register() {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return

  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0.1,
  })
}

// Unconditional export is safe without init: with no active Sentry client
// this is a no-op, same as the wizard-generated setup.
export const onRequestError = Sentry.captureRequestError
