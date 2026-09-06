import {
  ServerRuntimeClient,
  createStackParser,
  createTransport,
  initAndBind,
  nodeStackLineParser,
  captureException,
} from '@sentry/core'
import type { BaseTransportOptions, Transport } from '@sentry/core'

// Minimal replacement for @sentry/nextjs's Node auto-instrumentation, which
// this app cannot use: `@sentry/node` declares `import-in-the-middle` as a
// dependency (Next's default serverExternalPackages list), and Next.js/
// Turbopack needs a real filesystem symlink/junction to wire that up — which
// fails outright on this machine's exFAT drive (CLAUDE.md's exFAT bullet).
// `@sentry/core` alone has none of that (verified: its only dependency is
// `@sentry/conventions`), so building the client directly on it — the same
// officially-exported building blocks Sentry's own edge/workers SDKs use —
// avoids the dependency entirely rather than working around it.
//
// Traded away vs @sentry/nextjs: automatic instrumentation of third-party
// libraries (auto-traced DB/HTTP calls) and automatic breadcrumbs. Kept:
// real error capture and delivery to Sentry, on the exact same DSN.
function makeFetchTransport(options: BaseTransportOptions): Transport {
  return createTransport(options, async (request) => {
    const response = await fetch(options.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope', ...options.headers },
      // Envelope bodies are string | Uint8Array; undici's fetch accepts both
      // at runtime, but its BodyInit type is stricter about Uint8Array's
      // generic parameter than the envelope type is — cast, not a real risk.
      body: request.body as BodyInit,
    })
    return {
      statusCode: response.status,
      headers: {
        'x-sentry-rate-limits': response.headers.get('x-sentry-rate-limits'),
        'retry-after': response.headers.get('retry-after'),
      },
    }
  })
}

// Guarded on the DSN so this stays inert until the founder supplies one
// (docs/18 item 1) — no DSN, no init, nothing sent anywhere.
export async function register() {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return

  initAndBind(ServerRuntimeClient, {
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0.1,
    integrations: [],
    stackParser: createStackParser(nodeStackLineParser()),
    transport: makeFetchTransport,
  })
}

// Replaces @sentry/nextjs's `captureRequestError` helper — same idea (report
// the error plus request context), hand-written since we no longer depend on
// the package that provided it.
export function onRequestError(
  error: unknown,
  errorRequest: Readonly<{ path: string; method: string; headers: NodeJS.Dict<string | string[]> }>,
  errorContext: Readonly<{ routerKind: string; routePath: string; routeType: string }>,
) {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return

  captureException(error, {
    contexts: {
      request: { url: errorRequest.path, method: errorRequest.method },
      next: errorContext,
    },
  })
}
