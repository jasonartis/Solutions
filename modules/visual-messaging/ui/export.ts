// Visual-messaging export manifest — authorship principle (docs/03): members
// export the layers THEY drew and the reactions THEY gave; what others drew
// is theirs. Module admins export the moderation domain they operate.
import type { ExportDb, ExportContext, ModuleExport } from '@platform/core'

async function rows(query: any): Promise<Record<string, unknown>[]> {
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return data ?? []
}

export const visualMessagingExport: ModuleExport = {
  moduleKey: 'visual-messaging',
  hats: [
    { key: 'admin', label: 'Admin (moderation domain)' },
    { key: 'member', label: 'Member (what I drew)' },
  ],
  async myHats(db: ExportDb, ctx: ExportContext) {
    const hats: string[] = []
    const { data: manage } = await db.rpc('vm_can_manage', { check_org_id: ctx.orgId })
    if (manage) hats.push('admin')
    hats.push('member')
    return hats
  },
  dataSets: [
    {
      key: 'my-layers',
      label: 'Layers I drew',
      description: 'your drawings as vector data, with their addresses',
      hats: ['member'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('vm_layers')
            .select('path, content, created_at, conversation:vm_conversations(title)')
            .eq('org_id', ctx.orgId)
            .eq('author_id', ctx.userId),
        ),
    },
    {
      key: 'my-reactions',
      label: 'Reactions I gave',
      hats: ['member'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('vm_reactions')
            .select('kind, created_at, conversation:vm_conversations(title)')
            .eq('org_id', ctx.orgId)
            .eq('user_id', ctx.userId),
        ),
    },
    {
      key: 'moderation-log',
      label: 'Moderation audit log',
      hats: ['admin'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('vm_moderation_log')
            .select('action, detail, actor_user_id, created_at')
            .eq('org_id', ctx.orgId),
        ),
    },
  ],
}
