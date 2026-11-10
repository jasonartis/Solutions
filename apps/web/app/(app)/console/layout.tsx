import Link from 'next/link'
import type { ReactNode } from 'react'
import { createClient } from '@/lib/supabase/server'
import { getOverdueReportHours } from '@/lib/console-report-banner'

// THE 48-HOUR BANNER (founder, 2026-11-10: "so he never misses a report inside
// 48 hours"). On EVERY Owner Console page, once any open content report is more
// than 24 hours old, a red bar says so and links to the queue (rule and trigger:
// lib/console-report-banner.ts). It is the console's only alert: nothing emails
// or pings anyone.
//
// A layout is not re-rendered when you move between console pages, so the bar
// reflects the moment the console was opened or last reloaded; it clears on the
// next reload once the report is handled.
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const hours = await getOverdueReportHours(await createClient())

  return (
    <>
      {hours !== null && (
        <div
          role="alert"
          data-testid="report-banner"
          className={`mb-4 rounded border p-3 text-sm ${
            hours >= 36 ? 'border-red-500 bg-red-600 font-semibold text-white' : 'border-red-300 bg-red-50 text-red-800'
          }`}
        >
          A content report has been open for {hours} hours — the limit to act on it is 48.{' '}
          <Link href="/console/reports" className="underline">
            Open the reports
          </Link>
        </div>
      )}
      {children}
    </>
  )
}
