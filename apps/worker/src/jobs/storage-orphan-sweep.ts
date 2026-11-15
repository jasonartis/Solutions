import postgres from 'postgres'
import type { SupabaseClient } from '@supabase/supabase-js'

// platform.storage-orphan-sweep — removes uploaded files whose owning record is
// gone (found 2026-11-15: a vm-images file of a deleted conversation was still in
// storage four months later; org deletion leaves EVERY file of the org, as
// 20260928010000_org_delete.sql's header admits).
//
// Nothing in Postgres can do this on delete: storage.objects has no FK to any
// public table, and removing the bytes needs the Storage API (deleting the row
// alone would leave the file in the object store). So this job finds orphans
// over the direct owner connection (storage.objects is not exposed through
// PostgREST) and removes them through the service-role Storage API.
//
// AN ORPHAN IS DECIDED BY THE FOLDER THAT NAMES THE OWNING RECORD, never by
// "no row points at this path": a parent that still exists keeps its files even
// if a reference row was lost, because deleting a student's work is not
// reversible (backups hold storage rows, not files). Per bucket:
//
//   every bucket     <org_id>/...                      the org is gone
//   vm-images        <org>/<conversation_id>/...       the conversation is gone
//   cls-submissions  <org>/<class>/<submission_id>/... the submission is gone
//   cls-exams        <org>/<class>/<exam_id>/...       the exam is gone
//   cls-materials    <org>/<course_id>/...             the course is gone
//
// Only the buckets listed in ORG_BUCKETS are swept (each is known to start with
// the org id); a bucket added later is left alone until it is listed here.
// A file whose id folder is not a uuid is NEVER deleted (reported only), and a
// file younger than MIN_AGE is skipped so an upload whose row is written a
// moment later is not raced.
export const MIN_AGE_HOURS = 24
export const ORG_BUCKETS = ['vm-images', 'cls-submissions', 'cls-exams', 'cls-materials', 'syn-exports']

export type StorageOrphan = { bucket: string; name: string; bytes: number; reason: string }

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

export async function findStorageOrphans(
  sql: postgres.Sql,
  minAgeHours = MIN_AGE_HOURS,
): Promise<{ orphans: StorageOrphan[]; unrecognised: number }> {
  const rows = await sql<{ bucket: string; name: string; bytes: string; reason: string | null; unrecognised: boolean }[]>`
    with o as (
      select o.bucket_id as bucket, o.name, coalesce((o.metadata ->> 'size')::bigint, 0) as bytes,
             (storage.foldername(o.name))[1] as f1,
             (storage.foldername(o.name))[2] as f2,
             (storage.foldername(o.name))[3] as f3
      from storage.objects o
      where o.created_at < now() - make_interval(hours => ${minAgeHours})
        and o.bucket_id = any(${ORG_BUCKETS})
    ),
    shaped as (
      select o.*,
        -- The folder that must name a live record, per bucket.
        case o.bucket
          when 'vm-images' then o.f2
          when 'cls-submissions' then o.f3
          when 'cls-exams' then o.f3
          when 'cls-materials' then o.f2
        end as parent,
        coalesce(o.f1, '') !~ ${UUID}
          or (o.bucket in ('vm-images', 'cls-materials') and coalesce(o.f2, '') !~ ${UUID})
          or (o.bucket in ('cls-submissions', 'cls-exams') and coalesce(o.f3, '') !~ ${UUID}) as unrecognised
      from o
    )
    select s.bucket, s.name, s.bytes::text, s.unrecognised,
      case
        when s.unrecognised then null
        when not exists (select 1 from public.orgs g where g.id = s.f1::uuid) then 'org deleted'
        when s.bucket = 'vm-images'
          and not exists (select 1 from public.vm_conversations c where c.id = s.parent::uuid) then 'conversation deleted'
        when s.bucket = 'cls-submissions'
          and not exists (select 1 from public.cls_submissions x where x.id = s.parent::uuid) then 'submission deleted'
        when s.bucket = 'cls-exams'
          and not exists (select 1 from public.cls_exams x where x.id = s.parent::uuid) then 'exam deleted'
        when s.bucket = 'cls-materials'
          and not exists (select 1 from public.cls_courses x where x.id = s.parent::uuid) then 'course deleted'
      end as reason
    from shaped s`
  return {
    orphans: rows
      .filter((r) => r.reason !== null)
      .map((r) => ({ bucket: r.bucket, name: r.name, bytes: Number(r.bytes), reason: r.reason as string })),
    unrecognised: rows.filter((r) => r.unrecognised).length,
  }
}

/** Finds orphans and, when `apply`, removes them through the Storage API. */
export async function runStorageOrphanSweep(
  connectionString: string,
  admin: SupabaseClient | null,
  { apply }: { apply: boolean },
): Promise<{ orphans: StorageOrphan[]; removed: number; unrecognised: number }> {
  const sql = postgres(connectionString, { max: 1 })
  let found: Awaited<ReturnType<typeof findStorageOrphans>>
  try {
    found = await findStorageOrphans(sql)
  } finally {
    await sql.end()
  }

  let removed = 0
  if (apply && found.orphans.length > 0) {
    if (!admin) throw new Error('storage-orphan-sweep: removing files needs the service-role client')
    const byBucket = new Map<string, string[]>()
    for (const o of found.orphans) byBucket.set(o.bucket, [...(byBucket.get(o.bucket) ?? []), o.name])
    for (const [bucket, names] of byBucket) {
      // The Storage API takes up to 1000 paths per call; 100 keeps each request small.
      for (let i = 0; i < names.length; i += 100) {
        const { data, error } = await admin.storage.from(bucket).remove(names.slice(i, i + 100))
        if (error) throw new Error(`storage-orphan-sweep: remove in ${bucket} failed: ${error.message}`)
        removed += data?.length ?? 0
      }
    }
  }
  console.log(
    `[storage-orphan-sweep] ${found.orphans.length} orphaned files${apply ? `, ${removed} removed` : ' (dry run)'}` +
      (found.unrecognised ? `; ${found.unrecognised} with unrecognised paths left alone` : ''),
  )
  return { ...found, removed }
}
