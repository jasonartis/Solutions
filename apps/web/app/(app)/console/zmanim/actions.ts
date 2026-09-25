'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

// Same rhythm as ../actions.ts: RLS already restricts platform_settings writes
// to superadmins (the table's `for all using (is_superadmin())` policy, and
// platform_setting_merge() re-checks it explicitly as a SECURITY DEFINER), but
// this action verifies too so a refusal is a clear error, not a silent no-op.
async function requireSuperadmin() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')
  const { data: isSuperadmin } = await supabase.rpc('is_superadmin')
  if (!isSuperadmin) throw new Error('Not authorized')
  return supabase
}

/** The only write path (docs/23 §2): merges in a single statement so this and
 * the circuit breaker's auto-pause can never clobber each other. */
export async function updateZmanimPrefetchSettings(formData: FormData) {
  const supabase = await requireSuperadmin()

  const horizonDays = Number(formData.get('horizonDays'))
  const budgetPerRun = Number(formData.get('budgetPerRun'))
  const pauseAfterDays = Number(formData.get('pauseAfterDays'))
  if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 400) {
    throw new Error('Horizon must be an integer between 1 and 400 days')
  }
  if (!Number.isInteger(budgetPerRun) || budgetPerRun < 1) {
    throw new Error('Budget per run must be a positive integer')
  }
  if (!Number.isInteger(pauseAfterDays) || pauseAfterDays < 1) {
    throw new Error('Pause-after-days must be a positive integer')
  }

  const patch: Record<string, unknown> = {
    enabled: formData.get('enabled') === 'on',
    horizonDays,
    budgetPerRun,
    pauseAfterDays,
  }
  // Clear a prior auto-pause reason on any human edit — the human just looked
  // at it, so a stale "paused because X" line would misdescribe the new state.
  if (patch.enabled) patch.pausedReason = null

  const { error } = await supabase.rpc('platform_setting_merge', {
    setting_key: 'zmanim.prefetch',
    patch,
  })
  if (error) throw new Error(error.message)

  revalidatePath('/console/zmanim')
}
