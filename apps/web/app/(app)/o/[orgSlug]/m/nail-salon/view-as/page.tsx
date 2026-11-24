// Thin route wrapper (docs/03 composition), the classroom one with a different
// module key — which is the point: nail-salon's view-as review added a
// declaration and a migration, no new page and no new read path. The only
// extra: the back link must read the home page's exact heading, which
// includes the location name.
import { ViewAsPage } from '@/components/view-as/page'
import { createClient } from '@/lib/supabase/server'

export default async function Page(props: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ tab?: string; mode?: string }>
}) {
  const { orgSlug } = await props.params
  const supabase = await createClient()
  const { data: org } = await supabase.from('orgs').select('id').eq('slug', orgSlug).maybeSingle()
  const { data: location } = org
    ? await supabase.from('sal_locations').select('name').eq('org_id', org.id).order('created_at').limit(1).maybeSingle()
    : { data: null }
  return (
    <ViewAsPage
      moduleKey="nail-salon"
      homeHeading={`Nail Salon${location ? ` — ${location.name}` : ''}`}
      {...props}
    />
  )
}
