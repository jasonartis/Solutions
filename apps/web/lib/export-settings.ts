import type { ExportDb } from '@platform/core'

// Export controls (docs/03): module staff may disable hats/data sets for the
// levels below them. Stored in org_modules.settings.export by the
// set_export_settings definer RPC; read here by page + API. Module staff
// themselves are never blocked by these switches.
export type ExportSettings = {
  disabledHats: string[]
  disabledSets: string[]
}

export async function readExportSettings(
  db: ExportDb,
  orgId: string,
  moduleKey: string,
): Promise<ExportSettings> {
  const { data } = await db
    .from('org_modules')
    .select('settings')
    .eq('org_id', orgId)
    .eq('module_key', moduleKey)
    .single()
  const raw = ((data?.settings ?? {}) as { export?: Partial<ExportSettings> }).export ?? {}
  return {
    disabledHats: Array.isArray(raw.disabledHats) ? raw.disabledHats : [],
    disabledSets: Array.isArray(raw.disabledSets) ? raw.disabledSets : [],
  }
}
