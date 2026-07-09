// Synagogue-schedules export manifest — authorship principle (docs/03). The
// maker exports the configuration they built (schedule rules, overrides,
// export profiles). Viewers enter nothing, so there is no viewer hat.
import type { ExportDb, ExportContext, ModuleExport } from '@platform/core'

async function rows(query: any): Promise<Record<string, unknown>[]> {
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return data ?? []
}

export const synagogueSchedulesExport: ModuleExport = {
  moduleKey: 'synagogue-schedules',
  hats: [{ key: 'maker', label: 'Maker (my schedule configuration)' }],
  async myHats(db: ExportDb, ctx: ExportContext) {
    const { data: maker } = await db.rpc('syn_can_write', { check_org_id: ctx.orgId })
    return maker ? ['maker'] : []
  },
  dataSets: [
    {
      key: 'schedule-rules',
      label: 'Schedule types, sections & line rules',
      hats: ['maker'],
      fetch: async (db, ctx) => {
        const lines = await rows(
          db
            .from('syn_lines')
            .select('name, name_hebrew, rule, sort, section:syn_sections(name, schedule_type:syn_schedule_types(name))')
            .eq('org_id', ctx.orgId),
        )
        return lines
      },
    },
    {
      key: 'weekly-overrides',
      label: 'Weekly messages & overrides',
      hats: ['maker'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('syn_overrides')
            .select('week_start, text, text_hebrew, sort')
            .eq('org_id', ctx.orgId),
        ),
    },
    {
      key: 'export-profiles',
      label: 'Export profiles',
      hats: ['maker'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('syn_export_profiles')
            .select('name, format, width_px, margins_mm, grayscale, enabled')
            .eq('org_id', ctx.orgId),
        ),
    },
  ],
}
