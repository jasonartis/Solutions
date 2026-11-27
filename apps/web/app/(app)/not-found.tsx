import Link from 'next/link'
import { getRealView } from '@/lib/view-as-real'
import { OutsideArea } from '@/components/view-as-outside-area'

// Rendered (inside the (app) layout) when a page calls notFound().
//
// STAFF "View as" (docs/13 "STAFF VIEW AS"): a page inside the viewer's area whose main
// row the database trimmed — e.g. the person's class in another professor's course —
// finds no row and calls notFound(). Then this shows "‹outside your area›" in the same
// frame, with no name: the name is exactly what was trimmed. Pages never branch on a view;
// this frame-level page is where the placeholder lives.
export default async function NotFound() {
  const view = await getRealView()
  if (view?.kind === 'staff' && view.inScope) return <OutsideArea />
  return (
    <div className="rounded border border-gray-200 bg-white p-8 text-center">
      <h1 className="text-lg font-semibold">404</h1>
      <p className="mt-2 text-sm text-gray-600">This page could not be found.</p>
      <Link href="/dashboard" className="mt-4 inline-block text-sm text-blue-600 hover:underline">
        ← Dashboard
      </Link>
    </div>
  )
}
