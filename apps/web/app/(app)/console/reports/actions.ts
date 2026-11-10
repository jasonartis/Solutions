'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

// The superadmin's report review (module-9 spec §B1). The database function
// content_report_set_status is the gate: anyone who is not the superadmin gets
// 'Report not found'. Refusals come back as {ok, reason} (docs/03 #22).

type Result = { ok: true } | { ok: false; reason: string }

/** Set a report's status. An empty note box keeps the existing note; tick "clear" to erase it. */
export async function setReportStatus(formData: FormData): Promise<Result> {
  const id = String(formData.get('id') ?? '')
  const status = String(formData.get('status') ?? '')
  const noteRaw = String(formData.get('note') ?? '').trim()
  const clear = formData.get('clearNote') === 'on'
  if (noteRaw.length > 4000) return { ok: false, reason: 'The note must be 4000 characters or fewer.' }
  const note = clear ? '' : noteRaw || null

  const supabase = await createClient()
  const { error } = await supabase.rpc('content_report_set_status', { p_id: id, p_status: status, p_note: note })
  if (error) return { ok: false, reason: error.message }
  revalidatePath('/console/reports')
  revalidatePath('/console')
  return { ok: true }
}
