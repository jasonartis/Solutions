// Thin route wrapper (docs/03 composition). STAFF "View as" (docs/13 "STAFF VIEW AS",
// founder 2026-11-26): the person picker for the real screen, which replaced the
// table-style in-module view. The module key is the only thing this route decides.
import { StaffViewAsPicker } from '@/components/view-as/staff-picker'

export default function Page(props: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ error?: string; ended?: string }>
}) {
  return <StaffViewAsPicker moduleKey="classroom" {...props} />
}
