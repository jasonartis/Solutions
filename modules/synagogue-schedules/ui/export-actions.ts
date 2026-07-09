'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

// Enqueue a render of every enabled export profile for one week.
// The worker picks the row up within ~5s (docs/01 job-result contract).
export async function requestExport(orgId: string, orgSlug: string, weekStart: string) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')

  const { error } = await supabase.from('job_requests').insert({
    org_id: orgId,
    requested_by: user.id,
    kind: 'synagogue-schedules.render',
    payload: { weekStart },
  })
  if (error) throw new Error(`Export request failed: ${error.message}`)
  revalidatePath(`/o/${orgSlug}/m/synagogue-schedules`)
}
