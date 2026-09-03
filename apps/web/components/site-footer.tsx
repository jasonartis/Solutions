import Link from 'next/link'

// Go-live checklist item 3: the privacy/terms page needs to actually be
// reachable, not just exist at a hidden URL. Kept minimal on purpose — this
// is the whole footer for now.
export function SiteFooter() {
  return (
    <footer className="border-t border-gray-200 px-4 py-4 text-center text-xs text-gray-500 sm:px-6">
      <Link href="/privacy" className="hover:underline">
        Privacy &amp; Terms
      </Link>
    </footer>
  )
}
