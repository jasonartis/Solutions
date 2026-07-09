// TEMPLATE (module 0): the export manifest is part of module anatomy
// (docs/03 data-export decision). Two hats mirroring the module's tiers;
// fetches run AS the caller under RLS, each shaping its hat's slice.
import type { ExportDb, ExportContext, ModuleExport } from '@platform/core'

async function rows(query: any): Promise<Record<string, unknown>[]> {
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return data ?? []
}

export const sampleExport: ModuleExport = {
  moduleKey: 'sample',
  hats: [
    { key: 'manager', label: 'Manager (all projects & items)' },
    { key: 'member', label: 'Member (my own items)' },
  ],
  async myHats(db: ExportDb, ctx: ExportContext) {
    const { data: manage } = await db.rpc('smp_can_manage', { check_org_id: ctx.orgId })
    return manage ? ['manager', 'member'] : ['member']
  },
  dataSets: [
    {
      key: 'my-items',
      label: 'My items',
      hats: ['member'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('smp_items')
            .select('body, done, created_at, project:smp_projects(name)')
            .eq('org_id', ctx.orgId)
            .eq('author_id', ctx.userId),
        ),
    },
    {
      key: 'all-projects',
      label: 'All projects & items',
      hats: ['manager'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('smp_items')
            .select('body, done, created_at, author_id, project:smp_projects(name)')
            .eq('org_id', ctx.orgId),
        ),
    },
  ],
}
