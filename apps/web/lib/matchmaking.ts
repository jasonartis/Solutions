import type { SupabaseClient } from '@supabase/supabase-js'
import { pairScore, type Answer, type Question } from '@modules/matchmaking'

// Recompute-and-persist all pair scores for a matchmaking org, using the pure
// scoring engine. This is the same work the matchmaking.rescore worker will
// eventually do continuously; until the worker is deployed, an admin triggers
// it from the Manage console. It MUST run as a caller who can read every
// single's answers — i.e. an admin (mm_can_manage covers SELECT via the
// staff `for all` policy). It deliberately does NOT use the service-role key:
// the platform invariant keeps that key in the worker only.
export async function recomputeMatches(supabase: SupabaseClient, orgId: string): Promise<number> {
  const [{ data: qRows }, { data: aRows }, { data: singles }] = await Promise.all([
    supabase.from('mm_questions').select('id, text, scale_labels, admin_locks').eq('org_id', orgId).eq('status', 'approved'),
    supabase.from('mm_answers').select('user_id, question_id, position, care, dealbreaker, auto, share_with_match').eq('org_id', orgId),
    supabase.from('module_roles').select('user_id').eq('org_id', orgId).eq('module_key', 'matchmaking').eq('role', 'single'),
  ])

  const questions = new Map<string, Question>()
  for (const q of qRows ?? []) {
    questions.set(q.id, { id: q.id, text: q.text, scaleLabels: q.scale_labels, adminLocks: q.admin_locks ?? {} })
  }

  const byUser = new Map<string, Answer[]>()
  for (const r of aRows ?? []) {
    const list = byUser.get(r.user_id) ?? []
    list.push({
      questionId: r.question_id,
      position: r.position,
      care: r.care,
      dealbreaker: r.dealbreaker,
      auto: r.auto,
      shareWithMatch: r.share_with_match,
    })
    byUser.set(r.user_id, list)
  }

  // Every single participates, even those with only auto-answers (empty list).
  const userIds = [...new Set((singles ?? []).map((s) => s.user_id))].sort()
  const rows: {
    org_id: string
    user_a: string
    user_b: string
    percent: number
    excluded: boolean
    stale: boolean
    computed_at: string
  }[] = []
  const now = new Date().toISOString()
  for (let i = 0; i < userIds.length; i++) {
    for (let j = i + 1; j < userIds.length; j++) {
      const a = userIds[i]! // sorted → a < b, the canonical order the CHECK requires
      const b = userIds[j]!
      const { percent, excluded } = pairScore(byUser.get(a) ?? [], byUser.get(b) ?? [], questions)
      rows.push({ org_id: orgId, user_a: a, user_b: b, percent, excluded, stale: false, computed_at: now })
    }
  }

  if (rows.length > 0) {
    const { error } = await supabase
      .from('mm_pair_scores')
      .upsert(rows, { onConflict: 'org_id,user_a,user_b' })
    if (error) throw new Error(`Recompute failed: ${error.message}`)
  }
  return rows.length
}
