import type { SupabaseClient } from '@supabase/supabase-js'

// The age, in whole hours, of the OLDEST open content report — but only once it is
// more than 24 hours old (the console banner's trigger; same rule as the home
// dashboard's reports tile: status new/reviewing, urgent past 24 h). null = no
// banner: nothing open, nothing old enough, or the read failed or returned nothing
// (RLS shows content_reports to the superadmin only). Absence of the banner is not
// a claim that all is well — the reports tile and queue say what is open.
const DAY_MS = 24 * 3600 * 1000

export async function getOverdueReportHours(supabase: SupabaseClient): Promise<number | null> {
  const { data } = await supabase
    .from('content_reports')
    .select('created_at')
    .in('status', ['new', 'reviewing'])
    .order('created_at', { ascending: true })
    .limit(1)
  const oldest = data?.[0]?.created_at as string | undefined
  if (!oldest) return null
  const ageMs = Date.now() - new Date(oldest).getTime()
  return ageMs > DAY_MS ? Math.floor(ageMs / 3600000) : null
}
