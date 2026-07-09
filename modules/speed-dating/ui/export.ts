// Speed-dating export manifest — authorship principle (docs/03). A
// participant exports what THEY entered: registrations, interest marks, the
// private notepad, and reports they filed. One-sided interest ABOUT them and
// other people's data are never theirs to export (same privacy chain as the
// live product). Organizers export the event domain they operate.
import type { ExportDb, ExportContext, ModuleExport } from '@platform/core'

async function rows(query: any): Promise<Record<string, unknown>[]> {
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return data ?? []
}

export const speedDatingExport: ModuleExport = {
  moduleKey: 'speed-dating',
  hats: [
    { key: 'organizer', label: 'Organizer (event domain)' },
    { key: 'participant', label: 'Participant (what I entered)' },
  ],
  async myHats(db: ExportDb, ctx: ExportContext) {
    const hats: string[] = []
    const { data: organize } = await db.rpc('sd_can_organize', { check_org_id: ctx.orgId })
    const { data: participant } = await db.rpc('has_module_role', {
      check_org_id: ctx.orgId,
      check_module_key: 'speed-dating',
      check_role: 'participant',
    })
    if (organize) hats.push('organizer')
    if (participant) hats.push('participant')
    return hats
  },
  dataSets: [
    {
      key: 'my-registrations',
      label: 'My event registrations',
      hats: ['participant'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('sd_participants')
            .select('status, checked_in, created_at, event:sd_events(name, scheduled_at)')
            .eq('org_id', ctx.orgId)
            .eq('user_id', ctx.userId),
        ),
    },
    {
      key: 'my-interest-marks',
      label: 'Interest marks I recorded',
      hats: ['participant'],
      fetch: async (db, ctx) => {
        const { data: seats } = await db
          .from('sd_participants')
          .select('id')
          .eq('org_id', ctx.orgId)
          .eq('user_id', ctx.userId)
        const ids = (seats ?? []).map((s: { id: string }) => s.id)
        if (ids.length === 0) return []
        return rows(
          db
            .from('sd_interest')
            .select('verdict, created_at, event:sd_events(name)')
            .in('rater_participant_id', ids),
        )
      },
    },
    {
      key: 'my-notes',
      label: 'My private notes',
      hats: ['participant'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('sd_notes')
            .select('body, created_at, event:sd_events(name)')
            .eq('org_id', ctx.orgId)
            .eq('author_user_id', ctx.userId),
        ),
    },
    {
      key: 'events',
      label: 'Events I run (config & schedule)',
      hats: ['organizer'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('sd_events')
            .select('name, state, scheduled_at, round_duration_seconds, allow_repeat_pairings')
            .eq('org_id', ctx.orgId),
        ),
    },
    {
      key: 'registrations',
      label: 'Event registrations (roster)',
      hats: ['organizer'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('sd_participants')
            .select('user_id, status, seat_type, checked_in, event:sd_events(name)')
            .eq('org_id', ctx.orgId),
        ),
    },
  ],
}
