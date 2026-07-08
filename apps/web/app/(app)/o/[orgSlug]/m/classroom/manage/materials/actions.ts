'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

// Professor/staff actions. RLS (cls_can_manage) enforces write access; the
// scope-sync trigger derives org_id from course_id/class_id.

function fail(error: { message: string } | null, what: string) {
  if (error) throw new Error(`${what}: ${error.message}`)
}

function toTimestamp(value: FormDataEntryValue | null): string | null {
  const s = String(value ?? '').trim()
  return s ? new Date(s).toISOString() : null
}

export async function createMaterial(orgSlug: string, courseId: string, formData: FormData) {
  const title = String(formData.get('title') ?? '').trim()
  if (!title) throw new Error('Title is required')
  const kind = String(formData.get('kind') ?? 'document')
  const url = String(formData.get('url') ?? '').trim() || null
  const file = formData.get('file') as File | null

  const supabase = await createClient()

  const { data: material, error } = await supabase
    .from('cls_materials')
    .insert({
      org_id: '00000000-0000-0000-0000-000000000000', // derived by trigger
      course_id: courseId,
      kind,
      title,
      url,
    })
    .select('id, org_id')
    .single()
  fail(error, 'Create material failed')

  if (file && file.size > 0 && material) {
    const path = `${material.org_id}/${courseId}/${material.id}-${file.name}`
    const { error: upErr } = await supabase.storage.from('cls-materials').upload(path, file)
    fail(upErr, 'Material upload failed')
    const { error: pathErr } = await supabase
      .from('cls_materials')
      .update({ storage_path: path })
      .eq('id', material.id)
    fail(pathErr, 'Save material path failed')
  }

  revalidatePath(`/o/${orgSlug}/m/classroom/manage/materials`)
}

export async function deleteMaterial(orgSlug: string, materialId: string, storagePath: string | null) {
  const supabase = await createClient()
  if (storagePath) {
    await supabase.storage.from('cls-materials').remove([storagePath])
  }
  const { error } = await supabase.from('cls_materials').delete().eq('id', materialId)
  fail(error, 'Delete material failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/manage/materials`)
}

export async function publishMaterial(
  orgSlug: string,
  materialId: string,
  classId: string,
  formData: FormData,
) {
  const supabase = await createClient()
  const { error } = await supabase.from('cls_publications').upsert(
    {
      org_id: '00000000-0000-0000-0000-000000000000', // derived by trigger
      class_id: classId,
      material_id: materialId,
      visible_from: toTimestamp(formData.get('visibleFrom')),
      visible_until: toTimestamp(formData.get('visibleUntil')),
    },
    { onConflict: 'class_id,material_id' },
  )
  fail(error, 'Publish material failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/manage/materials`)
  revalidatePath(`/o/${orgSlug}/m/classroom`)
}

export async function unpublishMaterial(orgSlug: string, publicationId: string) {
  const supabase = await createClient()
  const { error } = await supabase.from('cls_publications').delete().eq('id', publicationId)
  fail(error, 'Unpublish failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/manage/materials`)
  revalidatePath(`/o/${orgSlug}/m/classroom`)
}
