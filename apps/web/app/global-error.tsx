'use client'

import * as Sentry from '@sentry/nextjs'
import NextError from 'next/error'
import { useEffect } from 'react'

// Replaces the root layout when it (or anything above a route's own
// error.tsx) throws, so it needs its own <html>/<body> — same reason
// app/layout.tsx has them. Reports to Sentry only if instrumentation-client
// actually initialized it (docs/18 item 1's DSN guard); harmless no-op
// otherwise.
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <html lang="en">
      <body>
        <NextError statusCode={0} />
      </body>
    </html>
  )
}
