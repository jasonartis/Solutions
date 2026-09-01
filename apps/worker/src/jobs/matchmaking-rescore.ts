import type { SupabaseClient } from '@supabase/supabase-js'
import { recomputeMatches } from '../../../../modules/matchmaking/src/index'

// matchmaking.rescore (module 1 spec): when a single saves an answer, the
// mm_mark_pairs_stale trigger flags their pair rows; this tick sweeps orgs
// with stale pairs and recomputes them with the same engine the admin button
// uses. Matches stop showing "(recompute pending)" within a minute wherever
// the worker runs. Service role bypasses RLS — queries scope by org.
export async function runRescoreTick(admin: SupabaseClient): Promise<void> {
  // The error is CHECKED, not discarded (2026-08-29). Without this a denied or
  // failed read left `staleOrgs` null and the tick returned as if there were
  // simply nothing stale — identical, in the log, to a healthy idle tick. That
  // is why "watch the next real job run" could never have verified this job
  // after the ACL sweep: silence was already its success case. Matches
  // classroom-retention.ts, the one pre-existing job that always got this right.
  const { data: staleOrgs, error } = await admin
    .from('mm_pair_scores')
    .select('org_id')
    .eq('stale', true)
    .limit(50)
  if (error) {
    console.error(`[rescore] could not read mm_pair_scores: ${error.message}`)
    return
  }
  if (!staleOrgs || staleOrgs.length === 0) return

  const orgIds = [...new Set(staleOrgs.map((r) => r.org_id))]
  for (const orgId of orgIds) {
    try {
      const pairs = await recomputeMatches(admin, orgId)
      console.log(`[rescore] org ${orgId}: ${pairs} pairs recomputed`)
    } catch (err) {
      console.error(`[rescore] org ${orgId} failed:`, err instanceof Error ? err.message : err)
    }
  }
}
