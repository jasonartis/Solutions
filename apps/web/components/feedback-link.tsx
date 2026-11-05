'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

// "Feedback" in the top bar (docs/27): reachable from every signed-in page and
// carries the page the person is on, so the ticket says where they were. The
// query string is read from window.location (not useSearchParams) so the header
// can render on static pages without a Suspense boundary.
export function FeedbackLink({ unread }: { unread: number }) {
  const pathname = usePathname()
  const [href, setHref] = useState('/feedback/new')

  useEffect(() => {
    if (pathname.startsWith('/feedback')) {
      setHref('/feedback')
      return
    }
    const from = pathname + window.location.search
    setHref(`/feedback/new?from=${encodeURIComponent(from)}`)
  }, [pathname])

  return (
    <Link href={href} className="hover:underline" data-testid="feedback-link">
      Feedback
      {unread > 0 && (
        <span className="ml-1 rounded-full bg-blue-600 px-1.5 text-xs font-medium text-white" title="New replies to your feedback">
          {unread}
        </span>
      )}
    </Link>
  )
}
