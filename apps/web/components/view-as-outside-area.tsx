import { getModule } from '@platform/core'

// STAFF "View as" (docs/13 "STAFF VIEW AS"; founder 2026-11-23: "a whole page outside the
// viewer's area renders a placeholder in the same page frame"). Shown in place of the page.
//
// Two uses: the (app) layout, for a page of another module of the viewed org (the module
// name only — the viewer is a member of that org, so naming its module leaks nothing); and
// the (app) not-found page, for a page inside an area module whose main row the database
// trimmed (no name: the name IS the trimmed row).
export function OutsideArea({ moduleKey }: { moduleKey?: string }) {
  const name = moduleKey ? (getModule(moduleKey)?.name ?? moduleKey) : null
  return (
    <div data-testid="view-as-outside-area" className="rounded border border-dashed border-gray-300 bg-white p-8 text-center text-gray-500">
      {name ? `‹${name} · outside your area›` : '‹not shown: outside your area, or not on their screen›'}
    </div>
  )
}
