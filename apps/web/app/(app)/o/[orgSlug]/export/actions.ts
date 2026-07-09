'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { exportRegistry } from '@/lib/export-registry'

// Export controls: module staff toggle which hats/data sets the levels below
// may export. The definer RPC re-checks module_can_manage internally.
export async function saveExportControls(orgSlug: string, moduleKey: string, formData: FormData) {
  const def = exportRegistry[moduleKey]
  if (!def) throw new Error('Unknown module')

  const supabase = await createClient()
  const { data: org } = await supabase.from('orgs').select('id').eq('slug', orgSlug).single()
  if (!org) throw new Error('Org not found')

  // Checked box = allowed; anything unchecked is disabled.
  const allowedHats = new Set(formData.getAll('allowedHats').map(String))
  const allowedSets = new Set(formData.getAll('allowedSets').map(String))
  const disabledHats = def.hats.map((h) => h.key).filter((k) => !allowedHats.has(k))
  const disabledSets = def.dataSets.map((s) => s.key).filter((k) => !allowedSets.has(k))

  const { error } = await supabase.rpc('set_export_settings', {
    check_org_id: org.id,
    check_module_key: moduleKey,
    disabled_hats: disabledHats,
    disabled_sets: disabledSets,
  })
  if (error) throw new Error(`Save export controls failed: ${error.message}`)
  revalidatePath(`/o/${orgSlug}/export`)
}
