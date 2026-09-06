// Smoke test for the minimal Sentry client built 2026-09-06 to replace
// @sentry/nextjs (docs/18 item 1, docs/history/platform-journal.md's
// 2026-09-06 entry). Confirms the custom transport built on @sentry/core
// actually delivers an event to a real Sentry project — not just that the
// code compiles and runs.
//
//   pnpm exec tsx scripts/verify-sentry-transport.mts
//
// Reads NEXT_PUBLIC_SENTRY_DSN from the environment, or falls back to
// apps/web/.env.local. Fires ONE deliberate test error through the exact
// same register()/captureException() path apps/web/instrumentation.ts uses,
// then flushes (Node exits immediately otherwise, before the async fetch
// completes). Check your Sentry project's Issues list afterward for
// "Sentry transport smoke test <timestamp>".
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureException, flush } from '@sentry/core'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function loadDsn(): string {
  if (process.env.NEXT_PUBLIC_SENTRY_DSN) return process.env.NEXT_PUBLIC_SENTRY_DSN
  for (const rel of ['apps/web/.env.local', '.env.deploy']) {
    const path = resolve(root, rel)
    if (!existsSync(path)) continue
    const match = /^NEXT_PUBLIC_SENTRY_DSN=(.*)$/m.exec(readFileSync(path, 'utf8'))
    if (match?.[1]?.trim()) return match[1].trim()
  }
  throw new Error('No NEXT_PUBLIC_SENTRY_DSN in the environment, apps/web/.env.local, or .env.deploy')
}

async function main() {
  process.env.NEXT_PUBLIC_SENTRY_DSN = loadDsn()

  const { register } = await import('../apps/web/instrumentation.ts')
  await register()

  const message = `Sentry transport smoke test ${new Date().toISOString()}`
  const eventId = captureException(new Error(message))
  console.log('Fired:', message)
  console.log('captureException returned event id:', eventId)

  const flushed = await flush(5000)
  console.log('flush() completed within timeout:', flushed)
  console.log("\nCheck your Sentry project's Issues list for this event now.")
}

main().catch((err) => {
  console.error('Smoke test failed:', err)
  process.exit(1)
})
