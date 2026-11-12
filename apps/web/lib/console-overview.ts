// Owner Console "Platform overview" — the two expandable trees (founder, 2026-11-10;
// first asked for in founder-feedback.md as "an expandable/collapsible tree
// allowing us to see totals and dive into the details").
//
//   Tree 1  By organization:  orgs -> people + modules -> (module in org) -> people
//   Tree 2  By module:        modules -> distinct people -> orgs using it -> people
//
// READ-ONLY. Every query runs on the caller's RLS client and reads only tables
// the Owner Console home already reads (orgs, org_members, org_modules,
// module_roles, profiles), plus the superadmin-only size function
// platform_storage_usage() (migration 20261115010000, 2026-11-12). `buildOverview`
// is a pure function so the counting rules live in one place and can be checked
// without a database.
//
// COUNTING RULES (shown on the page too, so nobody has to guess):
//  - A person counts only if their membership is ACTIVE. Pending invitations are
//    reported separately and are never in a headcount.
//  - A person "has" a module in an org when that org has the module ON and they
//    are an active member of it. `roleHolders` additionally counts those who
//    hold an explicit role in that module (a stricter, smaller number).
//  - In the by-module tree a person who is in the module through several orgs is
//    counted ONCE at the module level; under each org they appear in that org.

import type { SupabaseClient } from '@supabase/supabase-js'
import { BUCKET_MODULE, moduleForBucket, moduleForTable, moduleRegistry } from '@platform/core'

export type OverviewInput = {
  orgs: { id: string; name: string; slug: string }[]
  members: { org_id: string; user_id: string; status: string | null }[]
  entitlements: { org_id: string; module_key: string; enabled: boolean }[]
  moduleRoles: { org_id: string; user_id: string; module_key: string }[]
  names: Map<string, string | null>
  modules: { key: string; name: string }[]
  /** Rows held per `${orgId}|${moduleKey}` (see countRecords); absent = not scanned. */
  records?: Map<string, number>
  /** Estimated bytes (see summarizeStorage); absent = not measured. */
  storage?: StorageSummary
}

export type Person = { userId: string; name: string }

export type ModuleInOrg = {
  moduleKey: string
  moduleName: string
  orgId: string
  orgName: string
  people: Person[] // active members of the org
  roleHolders: number // of those, how many hold a role in this module
  records: number // rows this org holds in this module's person-linked tables
  bytes: Bytes // estimated size of this org's data in this module
}

export type OrgNode = {
  id: string
  name: string
  slug: string
  people: Person[]
  pending: number
  modules: ModuleInOrg[] // only modules that are ON
  records: number // sum over its modules
  // ALL bytes attributed to this org: every module (including ones now switched
  // OFF — turning a module off deletes nothing) plus its rows in shared platform
  // tables (memberships, roles, invitations, activity).
  bytes: Bytes
}

export type ModuleNode = {
  key: string
  name: string
  distinctPeople: number // each person once, however many orgs
  orgs: ModuleInOrg[] // the orgs using it, with their own headcount
  records: number // sum over the orgs using it
  bytes: Bytes // every byte of this module's tables and files, whoever holds it
}

/** What the row-count scan could and could not see — shown on the page. */
export type RecordsScan = {
  included: boolean
  /** Tables that hit the per-table row cap, so their counts are LOWER than real. */
  cappedTables: string[]
  /** Tables the scan could not read at all (policy or error), counted as 0. */
  unreadableTables: string[]
}

export type Overview = {
  orgCount: number
  distinctPeople: number // active in at least one org
  pendingInvites: number
  byOrg: OrgNode[]
  byModule: ModuleNode[]
  recordsScan: RecordsScan
  /** null when the size reading was not requested or failed (see storageError). */
  storage: StorageSummary | null
  storageError?: string
}

// ---------------------------------------------------------------------------
// STORAGE SIZE (migration 20261115010000, platform_storage_usage()).
//
// The database function returns sizes per (table or bucket, org). This part
// only adds them up and decides which MODULE each table or bucket belongs to.
// The bytes are an ESTIMATE for tables (a table's size split between orgs by
// their share of its rows — the reasoning is in the migration's header) and
// exact for uploaded files. The page says so.
// ---------------------------------------------------------------------------

/** db = estimated bytes in database tables; files = bytes of uploaded files. */
export type Bytes = { db: number; files: number }

export type StorageUsageRow = {
  kind: 'database' | 'table' | 'bucket'
  name: string
  org_id: string | null
  item_count: number | null
  bytes: number
}

// Which module owns a table or bucket: TABLE_PREFIX_MODULE / BUCKET_MODULE in
// packages/platform/src/storage-usage.ts (checked against the catalog by the
// db test suite). A table or bucket with no module counts under the platform.

export type StorageSummary = {
  /** The whole database, as the hosting plan counts it (pg_database_size). */
  databaseBytes: number
  /** Sum of every public table, including indexes. */
  tableBytes: number
  /** databaseBytes − tableBytes: auth, storage, scheduling and system data. */
  systemBytes: number
  /** All uploaded files, every bucket. */
  fileBytes: number
  /** Per `${orgId}|${moduleKey}`. */
  byPair: Map<string, Bytes>
  /** Per org, everything attributed to it (modules + shared platform tables). */
  byOrg: Map<string, Bytes>
  /** Per module, whoever holds it. */
  byModule: Map<string, Bytes>
  /** Shared platform tables' rows that do carry an org (memberships, roles, ...), summed over all orgs. */
  platformOrgBytes: number
  /** Not attributable to any org: platform-wide tables, rows with no org, empty tables' pages, files outside an org folder. */
  unattributed: Bytes
  /** Buckets with no module mapping above (shown so the map gets updated). */
  unmappedBuckets: string[]
}

const addBytes = (m: Map<string, Bytes>, k: string, b: Partial<Bytes>) => {
  const cur = m.get(k) ?? { db: 0, files: 0 }
  m.set(k, { db: cur.db + (b.db ?? 0), files: cur.files + (b.files ?? 0) })
}

export function summarizeStorage(rows: StorageUsageRow[]): StorageSummary {
  const s: StorageSummary = {
    databaseBytes: 0,
    tableBytes: 0,
    systemBytes: 0,
    fileBytes: 0,
    byPair: new Map(),
    byOrg: new Map(),
    byModule: new Map(),
    platformOrgBytes: 0,
    unattributed: { db: 0, files: 0 },
    unmappedBuckets: [],
  }
  const unmapped = new Set<string>()
  for (const r of rows) {
    const bytes = Number(r.bytes) || 0
    if (r.kind === 'database') {
      s.databaseBytes = bytes
      continue
    }
    const isTable = r.kind === 'table'
    const part: Partial<Bytes> = isTable ? { db: bytes } : { files: bytes }
    let mod: string | null
    if (isTable) {
      s.tableBytes += bytes
      mod = moduleForTable(r.name)
    } else {
      s.fileBytes += bytes
      mod = moduleForBucket(r.name)
      if (!(r.name in BUCKET_MODULE)) unmapped.add(r.name)
    }
    if (mod) addBytes(s.byModule, mod, part)
    if (r.org_id) {
      addBytes(s.byOrg, r.org_id, part)
      if (mod) addBytes(s.byPair, `${r.org_id}|${mod}`, part)
      else if (isTable) s.platformOrgBytes += bytes
    } else {
      if (isTable) s.unattributed.db += bytes
      else s.unattributed.files += bytes
    }
  }
  s.systemBytes = Math.max(0, s.databaseBytes - s.tableBytes)
  s.unmappedBuckets = [...unmapped].sort()
  return s
}

/** "1.4 MB" — binary units (what Supabase's usage page uses), one decimal. */
export function formatBytes(n: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return i === 0 ? `${Math.round(v)} bytes` : `${v.toFixed(1)} ${units[i]}`
}

/**
 * Database size and file storage for the whole platform — what a plan limit
 * counts. For the console dashboard's Limits tile (database-size and storage
 * rows). Returns null with the reason when the reading fails, so the tile can
 * say "unavailable" rather than show 0.
 */
export async function getStorageUsage(
  supabase: SupabaseClient,
): Promise<{ summary: StorageSummary; error?: undefined } | { summary: null; error: string }> {
  const { data, error } = await supabase.rpc('platform_storage_usage')
  if (error) return { summary: null, error: error.message }
  return { summary: summarizeStorage((data ?? []) as StorageUsageRow[]) }
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)

export function buildOverview(input: OverviewInput): Overview {
  const nameOf = (id: string): Person => ({ userId: id, name: input.names.get(id) || 'Unnamed member' })

  const activeByOrg = new Map<string, Set<string>>()
  const pendingByOrg = new Map<string, number>()
  for (const m of input.members) {
    if ((m.status ?? 'active') === 'active') {
      if (!activeByOrg.has(m.org_id)) activeByOrg.set(m.org_id, new Set())
      activeByOrg.get(m.org_id)!.add(m.user_id)
    } else {
      pendingByOrg.set(m.org_id, (pendingByOrg.get(m.org_id) ?? 0) + 1)
    }
  }

  const onModules = new Map<string, Set<string>>() // org -> module keys that are ON
  for (const e of input.entitlements) {
    if (!e.enabled) continue
    if (!onModules.has(e.org_id)) onModules.set(e.org_id, new Set())
    onModules.get(e.org_id)!.add(e.module_key)
  }

  const roleKey = (org: string, mod: string) => `${org}|${mod}`
  const roleHoldersByPair = new Map<string, Set<string>>()
  for (const r of input.moduleRoles) {
    const k = roleKey(r.org_id, r.module_key)
    if (!roleHoldersByPair.has(k)) roleHoldersByPair.set(k, new Set())
    roleHoldersByPair.get(k)!.add(r.user_id)
  }

  const moduleName = new Map(input.modules.map((m) => [m.key, m.name]))
  const orgName = new Map(input.orgs.map((o) => [o.id, o.name]))

  const pair = (orgId: string, moduleKey: string): ModuleInOrg => {
    const active = activeByOrg.get(orgId) ?? new Set<string>()
    const holders = roleHoldersByPair.get(roleKey(orgId, moduleKey)) ?? new Set<string>()
    return {
      moduleKey,
      moduleName: moduleName.get(moduleKey) ?? moduleKey,
      orgId,
      orgName: orgName.get(orgId) ?? orgId,
      people: [...active].map(nameOf).sort(byName),
      // Only people who are still active members count as role holders.
      roleHolders: [...holders].filter((u) => active.has(u)).length,
      records: input.records?.get(roleKey(orgId, moduleKey)) ?? 0,
      bytes: input.storage?.byPair.get(roleKey(orgId, moduleKey)) ?? { db: 0, files: 0 },
    }
  }

  const byOrg: OrgNode[] = input.orgs
    .map((o) => {
      const modules = [...(onModules.get(o.id) ?? [])]
        .map((k) => pair(o.id, k))
        .sort((a, b) => a.moduleName.localeCompare(b.moduleName))
      return {
        id: o.id,
        name: o.name,
        slug: o.slug,
        people: [...(activeByOrg.get(o.id) ?? [])].map(nameOf).sort(byName),
        pending: pendingByOrg.get(o.id) ?? 0,
        modules,
        records: modules.reduce((n, m) => n + m.records, 0),
        bytes: input.storage?.byOrg.get(o.id) ?? { db: 0, files: 0 },
      }
    })
    .sort(byName)

  const byModule: ModuleNode[] = input.modules
    .map((m) => {
      const orgs = input.orgs
        .filter((o) => onModules.get(o.id)?.has(m.key))
        .map((o) => pair(o.id, m.key))
        .sort((a, b) => a.orgName.localeCompare(b.orgName))
      const distinct = new Set(orgs.flatMap((x) => x.people.map((p) => p.userId)))
      return {
        key: m.key,
        name: m.name,
        distinctPeople: distinct.size,
        orgs,
        records: orgs.reduce((n, x) => n + x.records, 0),
        bytes: input.storage?.byModule.get(m.key) ?? { db: 0, files: 0 },
      }
    })
    .sort(byName)

  const everyone = new Set<string>()
  for (const set of activeByOrg.values()) for (const u of set) everyone.add(u)

  return {
    orgCount: input.orgs.length,
    distinctPeople: everyone.size,
    pendingInvites: [...pendingByOrg.values()].reduce((a, b) => a + b, 0),
    byOrg,
    byModule,
    recordsScan: { included: input.records !== undefined, cappedTables: [], unreadableTables: [] },
    storage: input.storage ?? null,
  }
}

// ROW COUNTS (founder, 2026-11-10: "row counts enough to start"; real BYTES per
// org are a separate, later job and need a migration — see the journal).
//
// WHAT IS COUNTED: every table a module declares in its data-browser
// declaration that has an org column. That list is the set of tables that name a
// PERSON, so tables holding no person reference are not included — read this as
// "records about people", a floor on what an org stores, not its total size.
// It also counts only what the superadmin's RLS lets this client read.
//
// HOW: one read per table of just its org column, tallied here (PostgREST cannot
// GROUP BY). Fine at today's size; each table is capped so a large one cannot
// stall the page, and a capped table is REPORTED, never silently undercounted.
const RECORD_ROW_CAP = 5000

async function countRecords(supabase: SupabaseClient): Promise<{ records: Map<string, number>; scan: RecordsScan }> {
  const records = new Map<string, number>()
  const scan: RecordsScan = { included: true, cappedTables: [], unreadableTables: [] }

  // One entry per (module, table): a table declared twice must not count twice.
  const jobs: { moduleKey: string; table: string; orgColumn: string }[] = []
  for (const m of moduleRegistry) {
    const seen = new Set<string>()
    for (const l of m.dataBrowser.lookups) {
      if (!l.orgColumn || seen.has(l.table)) continue
      seen.add(l.table)
      jobs.push({ moduleKey: m.key, table: l.table, orgColumn: l.orgColumn })
    }
  }

  await Promise.all(
    jobs.map(async (j) => {
      const { data, error } = await supabase.from(j.table).select(j.orgColumn).limit(RECORD_ROW_CAP)
      if (error) {
        scan.unreadableTables.push(j.table)
        return
      }
      const rows = (data ?? []) as unknown as Record<string, string | null>[]
      if (rows.length >= RECORD_ROW_CAP) scan.cappedTables.push(j.table)
      for (const r of rows) {
        const org = r[j.orgColumn]
        if (!org) continue
        const key = `${org}|${j.moduleKey}`
        records.set(key, (records.get(key) ?? 0) + 1)
      }
    }),
  )
  scan.cappedTables.sort()
  scan.unreadableTables.sort()
  return { records, scan }
}

export async function getOverview(
  supabase: SupabaseClient,
  opts: { records?: boolean } = {},
): Promise<Overview> {
  const [orgs, members, entitlements, moduleRoles, profiles] = await Promise.all([
    supabase.from('orgs').select('id, name, slug'),
    supabase.from('org_members').select('org_id, user_id, status'),
    supabase.from('org_modules').select('org_id, module_key, enabled'),
    supabase.from('module_roles').select('org_id, user_id, module_key'),
    supabase.from('profiles').select('user_id, display_name'),
  ])
  // A failed read must not look like an empty platform (the vacuity rule).
  const failed = [orgs, members, entitlements, moduleRoles, profiles].find((r) => r.error)
  if (failed?.error) throw new Error(`overview read failed: ${failed.error.message}`)

  const counted = opts.records === false ? null : await countRecords(supabase)
  // Sizes come with the records scan (same page, same cost class); a failed
  // reading is shown on the page, never as 0 bytes.
  const sized = opts.records === false ? null : await getStorageUsage(supabase)

  const overview = buildOverview({
    orgs: orgs.data ?? [],
    members: members.data ?? [],
    entitlements: entitlements.data ?? [],
    moduleRoles: moduleRoles.data ?? [],
    names: new Map((profiles.data ?? []).map((p) => [p.user_id as string, p.display_name as string | null])),
    modules: moduleRegistry.map((m) => ({ key: m.key, name: m.name })),
    records: counted?.records,
    storage: sized?.summary ?? undefined,
  })
  if (counted) overview.recordsScan = counted.scan
  if (sized?.error) overview.storageError = sized.error
  return overview
}
