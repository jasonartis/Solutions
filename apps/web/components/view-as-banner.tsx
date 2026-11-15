import Link from 'next/link'
import type { RealView } from '@/lib/view-as-real'
import { ViewAsGuard } from '@/components/view-as-guard'

// Shown on EVERY screen while a real view is open (docs/13 "THE DESIGN", Q5), so
// a screenshot of a viewed screen can never be mistaken for the superadmin's own.
// It sits OUTSIDE <main>: the no-drift test compares <main> exactly.
export function ViewAsBanner({ view }: { view: RealView }) {
  const who = view.targetName || 'this person'
  const ends = new Date(view.expiresAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const home = `/o/${view.orgSlug}/m/${view.module}`
  return (
    <>
    <ViewAsGuard scopePrefix={home} inScope={view.inScope} expiresAt={view.expiresAt} />
    <div
      data-testid="view-as-banner"
      className="sticky top-0 z-50 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-300 bg-amber-100 px-4 py-2 text-sm text-amber-950"
    >
      {view.inScope ? (
        <span>
          You are viewing <strong>{who}</strong>&rsquo;s screen in <strong>{view.orgName}</strong>. Read-only: nothing
          can be changed. Ends {ends}.
        </span>
      ) : (
        <span>
          Viewing <strong>{who}</strong> is paused on this page (it covers only their {view.module} pages in{' '}
          <strong>{view.orgName}</strong>). This page is your own view.{' '}
          <Link href={home} className="underline">
            Back to their screen
          </Link>
        </span>
      )}
      <form action="/view-as/stop" method="post" className="ml-auto">
        <button type="submit" className="rounded border border-amber-500 bg-white px-2 py-0.5 text-amber-900 hover:bg-amber-50">
          Stop viewing
        </button>
      </form>
    </div>
    </>
  )
}
