// Thin route wrapper (docs/03 composition), the classroom one with a different
// module key — which is the point: nail-salon's view-as review added a
// declaration and a migration, no new page and no new read path.
import { ViewAsPage } from '@/components/view-as/page'

export default function Page(props: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ tab?: string; mode?: string }>
}) {
  return <ViewAsPage moduleKey="nail-salon" {...props} />
}
