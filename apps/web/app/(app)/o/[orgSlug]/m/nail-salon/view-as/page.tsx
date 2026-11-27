// Thin route wrapper (docs/03 composition), the classroom one with a different
// module key. STAFF "View as" (docs/13 "STAFF VIEW AS", founder 2026-11-26): the
// person picker for the real screen. The only extra: the back link must read the
// home page's exact heading, which includes the location name.
import { StaffViewAsPicker } from '@/components/view-as/staff-picker'
import { createClient } from '@/lib/supabase/server'

export default async function Page(props: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ error?: string; ended?: string }>
}) {
  const { orgSlug } = await props.params
  const supabase = await createClient()
  const { data: org } = await supabase.from('orgs').select('id').eq('slug', orgSlug).maybeSingle()
  const { data: location } = org
    ? await supabase.from('sal_locations').select('name').eq('org_id', org.id).order('created_at').limit(1).maybeSingle()
    : { data: null }
  return (
    <StaffViewAsPicker
      moduleKey="nail-salon"
      homeHeading={`Nail Salon${location ? ` — ${location.name}` : ''}`}
      {...props}
    />
  )
}
