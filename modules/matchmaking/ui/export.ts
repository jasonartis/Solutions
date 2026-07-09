// Matchmaking export manifest — authorship principle (docs/03). A single
// exports their own answers and proposals; match percentages are computed
// values embedding OTHER users' data, so they are nobody's authorship except
// the admin's domain. Matchmakers enter only question proposals in v1.
import type { ExportDb, ExportContext, ModuleExport } from '@platform/core'

async function rows(query: any): Promise<Record<string, unknown>[]> {
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return data ?? []
}

export const matchmakingExport: ModuleExport = {
  moduleKey: 'matchmaking',
  hats: [
    { key: 'admin', label: 'Admin (module domain)' },
    { key: 'matchmaker', label: 'Matchmaker (my proposals)' },
    { key: 'single', label: 'Single (what I entered)' },
  ],
  async myHats(db: ExportDb, ctx: ExportContext) {
    const hats: string[] = []
    const { data: manage } = await db.rpc('mm_can_manage', { check_org_id: ctx.orgId })
    const { data: matchmaker } = await db.rpc('mm_is_matchmaker', { check_org_id: ctx.orgId })
    const { data: single } = await db.rpc('mm_is_single', { check_org_id: ctx.orgId })
    if (manage) hats.push('admin')
    if (matchmaker) hats.push('matchmaker')
    if (single) hats.push('single')
    return hats
  },
  dataSets: [
    {
      key: 'my-answers',
      label: 'My question answers',
      hats: ['single'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('mm_answers')
            .select('position, care, dealbreaker, share_with_match, auto, question:mm_questions(text)')
            .eq('org_id', ctx.orgId)
            .eq('user_id', ctx.userId),
        ),
    },
    {
      key: 'my-question-proposals',
      label: 'Questions I proposed',
      hats: ['single', 'matchmaker'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('mm_questions')
            .select('text, scale_labels, status, created_at')
            .eq('org_id', ctx.orgId)
            .eq('submitted_by', ctx.userId),
        ),
    },
    {
      key: 'questions',
      label: 'All questions & locks',
      hats: ['admin'],
      fetch: (db, ctx) =>
        rows(db.from('mm_questions').select('text, scale_labels, admin_locks, status').eq('org_id', ctx.orgId)),
    },
    {
      key: 'groups-assignments',
      label: 'Groups & matchmaker assignments',
      hats: ['admin'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('mm_matchmaker_assignments')
            .select('matchmaker_id, target_type, target_user_id, target_group_id, created_at')
            .eq('org_id', ctx.orgId),
        ),
    },
    {
      key: 'pair-scores',
      label: 'Pair scores (computed)',
      hats: ['admin'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('mm_pair_scores')
            .select('user_a, user_b, percent, excluded, computed_at')
            .eq('org_id', ctx.orgId),
        ),
    },
  ],
}
