// Thin route wrapper (docs/03 composition). The view-as page is generic —
// tabs and content both come from the module manifest's declaration — so the
// route's only job is to name which module it is.
import { ViewAsPage } from '@/components/view-as/page'

export default function Page(props: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ tab?: string; mode?: string }>
}) {
  return <ViewAsPage moduleKey="classroom" {...props} />
}
