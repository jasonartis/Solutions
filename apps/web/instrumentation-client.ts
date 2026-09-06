import * as Sentry from '@sentry/browser'

// @sentry/browser, not @sentry/nextjs — the Next.js package unconditionally
// declares @sentry/node as a dependency (bundled as one package for both
// server and client), which is what actually breaks the local build (see
// instrumentation.ts). @sentry/browser has none of that.
//
// Same DSN-gated guard as instrumentation.ts (docs/18 item 1) — the browser
// bundle needs the NEXT_PUBLIC_ prefix to have this value inlined at build
// time.
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0.1,
  })
}

// No onRouterTransitionStart export: that hook is Next.js-specific (only
// @sentry/nextjs provided it, for automatic route-change spans). Next.js
// simply won't call it if it's absent — optional hook, not a required one.
