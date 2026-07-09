import type { SupabaseClient } from '@supabase/supabase-js'

// classroom.retention-sweep (module 2 spec: "Enforced by the retention.sweep
// cron job"). 'hide' needs no sweep — RLS already hides expired publications
// from students while retaining them for the professor. 'purge' is the
// true-delete: once the visibility window has closed, the publication row is
// deleted, and the underlying file is removed from storage when no other
// publication still references the material.
//
// DESIGN CHOICE (documented in the module SPEC): purging deletes the CLASS's
// copy (the publication) and, when unreferenced, the file content — but keeps
// the material's library row in the course, so the professor still sees what
// existed and can re-upload/re-publish. Submission retention (the spec's
// "submissions hide 2 weeks after semester end") needs per-class end dates
// that don't exist in the schema yet — parked as an open founder question.
//
// Service-role client: bypasses RLS, so every query scopes explicitly and the
// deletes are precisely bounded.
export async function runRetentionSweep(admin: SupabaseClient): Promise<{ purged: number; filesDeleted: number }> {
  const nowIso = new Date().toISOString()
  const { data: expired, error } = await admin
    .from('cls_publications')
    .select('id, material_id')
    .eq('retention', 'purge')
    .not('visible_until', 'is', null)
    .lt('visible_until', nowIso)
  if (error) throw new Error(`Sweep select failed: ${error.message}`)
  if (!expired || expired.length === 0) return { purged: 0, filesDeleted: 0 }

  let filesDeleted = 0
  for (const pub of expired) {
    const { error: delErr } = await admin.from('cls_publications').delete().eq('id', pub.id)
    if (delErr) throw new Error(`Sweep delete failed: ${delErr.message}`)

    // If nothing else publishes this material, its file content goes too.
    const { data: remaining } = await admin
      .from('cls_publications')
      .select('id')
      .eq('material_id', pub.material_id)
      .limit(1)
    if ((remaining ?? []).length > 0) continue

    const { data: material } = await admin
      .from('cls_materials')
      .select('storage_path')
      .eq('id', pub.material_id)
      .single()
    if (material?.storage_path) {
      const { error: rmErr } = await admin.storage.from('cls-materials').remove([material.storage_path])
      if (!rmErr) {
        filesDeleted++
        await admin.from('cls_materials').update({ storage_path: null }).eq('id', pub.material_id)
      }
    }
  }

  console.log(`[retention-sweep] purged ${expired.length} publications, deleted ${filesDeleted} files`)
  return { purged: expired.length, filesDeleted }
}
