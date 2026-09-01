import * as Sentry from '@sentry/nextjs'

// Same DSN-gated guard as instrumentation.ts (docs/18 item 1) — the browser
// bundle needs the NEXT_PUBLIC_ prefix to have this value inlined at build
// time.
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0.1,
  })
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
