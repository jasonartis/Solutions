import Link from 'next/link'
import type { RealView } from '@/lib/view-as-real'
import { ViewAsGuard } from '@/components/view-as-guard'
import { ViewAsCountdown } from '@/components/view-as-countdown'
import { ReadOnlyNotice } from '@/components/view-as-readonly-notice'
import { getModule } from '@platform/core'

// Shown on EVERY screen while a real view is open (docs/13 "THE DESIGN", Q5), so
// a screenshot of a viewed screen can never be mistaken for the viewer's own.
// It sits OUTSIDE <main>: the no-drift test compares <main> exactly.
//
// Three shapes: a whole-account session (the superadmin: "Viewing <name>'s account"),
// a STAFF session (org staff: only the parts of one org they oversee — docs/13 "STAFF
// VIEW AS"), and a v1 org-module session that may still be open from before.
export function ViewAsBanner({ view }: { view: RealView }) {
  const who = view.targetName || 'this person'
  const staff = view.kind === 'staff'
  const wholeAccount = !staff && (!view.orgSlug || !view.module)
  const firstArea = view.areaModules[0] ?? null
  const home = staff
    ? firstArea ? `/o/${view.orgSlug}/m/${firstArea}` : '/dashboard'
    : wholeAccount
      ? '/dashboard'
      : `/o/${view.orgSlug}/m/${view.module}`
  const picker = staff && firstArea ? `/o/${view.orgSlug}/m/${firstArea}/view-as` : null
  const endedHref = picker
    ? `${picker}?ended=${encodeURIComponent(who)}`
    : `/console/view-as/real?ended=${encodeURIComponent(who)}`
  const areaNames = view.areaModules.map((m) => getModule(m)?.name ?? m).join(', ')

  return (
    <>
      <ViewAsGuard
        inScope={view.inScope}
        outsideArea={view.outsideArea}
        expiresAt={view.expiresAt}
        view={{ kind: view.kind, orgSlug: view.orgSlug, module: view.module, areaModules: view.areaModules }}
        endedHref={endedHref}
      />
      <ReadOnlyNotice />
      <div
        data-testid="view-as-banner"
        className="sticky top-0 z-50 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-300 bg-amber-100 px-4 py-2 text-sm text-amber-950"
      >
        {staff ? (
          view.outsideArea ? (
            <span>
              Viewing <strong>{who}</strong>&rsquo;s screen in <strong>{view.orgName}</strong>: this part is outside the
              parts you oversee. <ViewAsCountdown expiresAt={view.expiresAt} />{' '}
              <Link href={home} className="underline">
                Back to their screen
              </Link>
            </span>
          ) : view.inScope ? (
            <span>
              You are viewing <strong>{who}</strong>&rsquo;s screen in <strong>{view.orgName}</strong> &mdash; only the
              parts you oversee ({areaNames}). Read-only: nothing can be changed. <ViewAsCountdown expiresAt={view.expiresAt} />
            </span>
          ) : (
            <span>
              Viewing <strong>{who}</strong> is paused on this page (it is your own view).{' '}
              <ViewAsCountdown expiresAt={view.expiresAt} />{' '}
              <Link href={home} className="underline">
                Back to their screen
              </Link>
            </span>
          )
        ) : wholeAccount ? (
          view.inScope ? (
            <span>
              Viewing <strong>{who}</strong>&rsquo;s account &mdash; read-only. <ViewAsCountdown expiresAt={view.expiresAt} />
            </span>
          ) : (
            <span>
              Viewing <strong>{who}</strong>&rsquo;s account is paused on this page (it is your own view). <ViewAsCountdown expiresAt={view.expiresAt} />{' '}
              <Link href={home} className="underline">
                Back to their screen
              </Link>
            </span>
          )
        ) : view.inScope ? (
          <span>
            You are viewing <strong>{who}</strong>&rsquo;s screen in <strong>{view.orgName}</strong>. Read-only: nothing
            can be changed. <ViewAsCountdown expiresAt={view.expiresAt} />
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
        <form action="/view-as/stop" method="post" data-view-as-stop className="ml-auto">
          {picker && <input type="hidden" name="back" value={picker} />}
          <button type="submit" className="rounded border border-amber-500 bg-white px-2 py-0.5 text-amber-900 hover:bg-amber-50">
            Stop viewing
          </button>
        </form>
      </div>
    </>
  )
}
