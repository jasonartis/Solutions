// Which MODULE owns a database table or a storage bucket — for the Owner
// Console's size estimate (migration 20261115010000, platform_storage_usage();
// apps/web/lib/console-overview.ts adds the numbers up).
//
// Kept here, not in apps/web, so the db test suite can check it against the
// real catalog: storage-usage-coverage.test.ts fails when a new module table
// prefix or a new storage bucket is not listed, so a module's bytes can never
// silently land under "platform".

// Table prefix -> module key (docs/03: every module table is prefixed). A
// table with none of these prefixes is a shared PLATFORM table.
export const TABLE_PREFIX_MODULE: Record<string, string> = {
  cls_: 'classroom',
  mm_: 'matchmaking',
  syn_: 'synagogue-schedules',
  vm_: 'visual-messaging',
  sal_: 'nail-salon',
  sd_: 'speed-dating',
  smp_: 'sample',
}

// Storage bucket -> module key. Every bucket must be listed (platform buckets
// map to null).
export const BUCKET_MODULE: Record<string, string | null> = {
  'syn-exports': 'synagogue-schedules',
  'cls-submissions': 'classroom',
  'cls-materials': 'classroom',
  'cls-exams': 'classroom',
  'vm-images': 'visual-messaging',
}

export function moduleForTable(table: string): string | null {
  for (const [prefix, key] of Object.entries(TABLE_PREFIX_MODULE)) if (table.startsWith(prefix)) return key
  return null
}

export function moduleForBucket(bucket: string): string | null {
  return BUCKET_MODULE[bucket] ?? null
}
