// Per-person data browser — server plumbing (docs/13, docs/03 #19).
//
// THE KEYSTONE, restated where it matters most: every query below runs on the
// CALLER's ordinary RLS-enforced client from lib/supabase/server.ts. There is
// no service-role client and no `.rpc()` call anywhere on this path, and there
// may never be one.
//
// That is not a stylistic preference — it is what makes the superadmin gate on
// the console route safe. Because every query here is one the caller could
// already issue against PostgREST as themselves, the gate is a UI gate over
// data they can already reach, not a security boundary. Add one SECURITY
// DEFINER call and it silently becomes a real boundary, with the app layer as
// its only enforcement — which docs/03 #18 says the app layer must never be.
//
// WHAT THIS ANSWERS: "what do I hold about this person?" — every row the VIEWER
// may read that names the subject. NOT "what does this person see", which is
// view-as, curated by a surface declaration and deliberately narrower. The UI
// must never label one as the other (founder requirement, 2026-08-02).
//
// SELECT * IS DELIBERATE, and the one place this departs from view-as's column
// allow-list. Three reasons: the feature exists to be COMPLETE, so an allow-list
// would silently hide exactly the new data it should surface; RLS is row-level,
// so a caller who can read the row can already read all its columns from any
// client, making a UI allow-list comfort rather than protection (docs/03 hard
// rule 6); and the founder's answer defines the scope as "everything the viewer
// may read, bounded by RLS and nothing else". The cost — a new column reaches
// the screen unreviewed — is accepted, and the coverage test still forces a
// decision about any new column that names a PERSON.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  dataBrowserDeclarations,
  platformDataBrowser,
  type DataBrowserDeclaration,
  type PersonLookup,
  type PersonVia,
} from '@platform/core'

/** Rows found in one table, plus what we could not read and why. */
export type BrowsedSection = {
  table: string
  label: string
  /** Discovered from the returned rows — `select *`, so the shape is the row's. */
  columns: string[]
  rows: Record<string, unknown>[]
  note?: string
  /** Surfaced rather than swallowed: an error here is an honest "could not read". */
  error?: string
  /** The row cap was hit, so this is a prefix of the real answer. */
  truncated: boolean
  /** Which module (or 'platform') this table belongs to. */
  source: string
}

export type BrowsedResult = {
  sections: BrowsedSection[]
  /**
   * Tables holding rows about the subject that NO viewer may read. Rendered
   * explicitly, because "no rows" and "rows nobody may read" are different
   * answers and only one of them is true for `sd_notes`.
   */
  unreadable: { table: string; why: string; source: string }[]
  /** Module keys actually queried (the org's enabled modules). */
  sources: string[]
}

const DEFAULT_LIMIT = 100

/**
 * Resolve a `via` path to the child-row ids that name the subject.
 *
 * Deliberately NOT org-filtered: the child query is RLS-bounded already, and
 * the parent query filters `org_id` itself — a child row in another org has an
 * id no in-org parent references, so it can contribute nothing. Adding an org
 * filter here would require every via lookup table to declare its own org
 * column for no gain.
 */
async function resolveViaIds(
  supabase: SupabaseClient,
  lookup: PersonLookup,
  subjectUserId: string,
  limit: number,
): Promise<{ byColumn: Map<string, string[]>; error?: string; truncated: boolean }> {
  const byColumn = new Map<string, string[]>()
  let truncated = false

  for (const via of lookup.via ?? []) {
    const step = await resolveViaStep(supabase, via, subjectUserId, limit)
    if (step.error) return { byColumn, error: step.error, truncated }
    if (step.truncated) truncated = true
    byColumn.set(via.column, step.ids)
  }

  return { byColumn, truncated }
}

/**
 * Resolve ONE hop of a via chain to the ids its parent should filter on,
 * recursing inward first when the chain continues.
 *
 * The chain is walked innermost-last: this hop's own person columns and the
 * ids produced by `then` are OR'd together, so a table can be reached both
 * directly and through a deeper link.
 */
async function resolveViaStep(
  supabase: SupabaseClient,
  via: PersonVia,
  subjectUserId: string,
  limit: number,
): Promise<{ ids: string[]; error?: string; truncated: boolean }> {
  let truncated = false
  const clauses = via.lookupPersonColumns.map((c) => `${c}.eq.${subjectUserId}`)

  if (via.then) {
    const inner = await resolveViaStep(supabase, via.then, subjectUserId, limit)
    if (inner.error) return { ids: [], error: inner.error, truncated }
    if (inner.truncated) truncated = true
    if (inner.ids.length > 0) clauses.push(`${via.then.column}.in.(${inner.ids.join(',')})`)
  }

  // No way for this hop to match, so neither can anything above it. Not an
  // error — just genuinely nothing on this path.
  if (clauses.length === 0) return { ids: [], truncated }

  // CAPPED, like every other query here. Without it a subject with many child
  // rows (a participant in many events, a heavily-flagged author) builds an
  // unbounded `.in(...)` list and can push the parent request past PostgREST's
  // size limits — which, before the error handling below, failed silently as
  // "no rows".
  const { data, error } = await supabase
    .from(via.lookupTable)
    .select(via.lookupIdColumn)
    .or(clauses.join(','))
    .limit(limit)

  // THE ERROR MUST NOT BE SWALLOWED. This is the one place a failure could
  // masquerade as a truthful answer: for a via-ONLY table (sd_interest,
  // sd_matches, sd_pairings, cls_submission_files, …) an empty id set leaves
  // the lookup with no clauses at all, so the section vanishes from the page
  // entirely — indistinguishable from "we hold nothing about this person".
  // That is a third state the design never had a name for: not "no rows" and
  // not "nobody may read it", but "we could not check". Surfaced as an error
  // section instead, exactly like the main query already does.
  if (error) return { ids: [], error: error.message, truncated }

  const ids = ((data ?? []) as unknown as Record<string, unknown>[])
    .map((r) => r[via.lookupIdColumn])
    .filter((v): v is string => typeof v === 'string')
  if (ids.length >= limit) truncated = true
  return { ids, truncated }
}

async function runLookup(
  supabase: SupabaseClient,
  lookup: PersonLookup,
  orgId: string,
  subjectUserId: string,
  source: string,
): Promise<BrowsedSection | null> {
  const limit = lookup.limit ?? DEFAULT_LIMIT
  const via = await resolveViaIds(supabase, lookup, subjectUserId, limit)
  if (via.error) {
    return {
      table: lookup.table,
      label: lookup.label,
      columns: [],
      rows: [],
      note: lookup.note,
      error: `could not resolve which rows relate to this person: ${via.error}`,
      truncated: false,
      source,
    }
  }

  const clauses: string[] = lookup.personColumns.map((c) => `${c}.eq.${subjectUserId}`)
  for (const [column, ids] of via.byColumn) {
    // `in.()` with an empty list is invalid PostgREST, and an empty list can
    // never match anyway — drop the clause rather than emit broken syntax.
    if (ids.length > 0) clauses.push(`${column}.in.(${ids.join(',')})`)
  }

  // Every path to the subject came up empty, so this table cannot hold a
  // matching row. Skipping is not the same as an empty result and the UI does
  // not need to show it — there is genuinely nothing here.
  if (clauses.length === 0) return null

  let query = supabase.from(lookup.table).select('*').or(clauses.join(','))
  if (lookup.orgColumn) query = query.eq(lookup.orgColumn, orgId)
  if (lookup.orderBy) {
    query = query.order(lookup.orderBy.column, { ascending: lookup.orderBy.ascending ?? false })
  }
  query = query.limit(limit)

  const { data, error } = await query
  if (error) {
    return {
      table: lookup.table,
      label: lookup.label,
      columns: [],
      rows: [],
      note: lookup.note,
      error: error.message,
      truncated: false,
      source,
    }
  }

  const rows = (data ?? []) as Record<string, unknown>[]
  // Union of keys across rows rather than just the first: PostgREST returns a
  // consistent shape today, but a union costs nothing and cannot lose a column.
  const columns: string[] = []
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key)
  }

  return {
    table: lookup.table,
    label: lookup.label,
    columns,
    rows,
    note: lookup.note,
    // Truncated if EITHER end of the two-step hit its cap: a capped via lookup
    // means some of the person's child rows never made it into the filter, so
    // the section is a prefix even when the parent query returned few rows.
    truncated: rows.length >= limit || via.truncated,
    source,
  }
}

/**
 * Every row the CALLER may read, in this org, that names `subjectUserId`.
 *
 * `moduleKeys` should be the org's ENABLED modules — a university org has no
 * business rendering an empty nail-salon section, and skipping them keeps this
 * to roughly a dozen round trips instead of forty.
 */
export async function browsePerson(
  supabase: SupabaseClient,
  orgId: string,
  subjectUserId: string,
  moduleKeys: readonly string[],
): Promise<BrowsedResult> {
  const declarations: [string, DataBrowserDeclaration][] = [['platform', platformDataBrowser]]
  for (const key of moduleKeys) {
    const decl = dataBrowserDeclarations[key]
    if (decl) declarations.push([key, decl])
  }

  const jobs: Promise<BrowsedSection | null>[] = []
  const unreadable: BrowsedResult['unreadable'] = []
  for (const [source, decl] of declarations) {
    for (const lookup of decl.lookups) {
      jobs.push(runLookup(supabase, lookup, orgId, subjectUserId, source))
    }
    for (const u of decl.neverReadable) {
      unreadable.push({ table: u.table, why: u.why, source })
    }
  }

  const settled = await Promise.all(jobs)
  return {
    sections: settled.filter((s): s is BrowsedSection => s !== null),
    unreadable,
    sources: declarations.map(([source]) => source),
  }
}

/**
 * The modules this org has an entitlement ROW for — enabled or not.
 *
 * DELIBERATELY NOT `.eq('enabled', true)`. An org that never touched a module
 * has no row at all, so this still skips the nail-salon section for a
 * university and keeps the page to about a dozen round trips instead of forty.
 * But a DISABLED module is the opposite case: the org used it, the rows are
 * still in the database, and disabling the entitlement is documented as the
 * FIRST step of deprecation (docs/03: disable → export on request → remove).
 * Filtering on `enabled` therefore hid a module's entire history at exactly the
 * moment someone opened this tool to decide what to export or delete — and hid
 * it silently, which is the failure this feature exists to avoid. Caught by
 * adversarial review, 2026-08-03.
 */
export async function browsableModuleKeys(
  supabase: SupabaseClient,
  orgId: string,
): Promise<string[]> {
  const { data } = await supabase
    .from('org_modules')
    .select('module_key, enabled')
    .eq('org_id', orgId)
  return (data ?? []).map((r) => (r as { module_key: string }).module_key)
}

/**
 * People the caller can look up in this org: the org's members, joined to their
 * profile for a display name.
 *
 * Bounded by RLS like everything else — `org_members_select_member` and
 * `profiles_select_shared_org`/`is_superadmin()` decide who appears. A caller
 * who cannot read an org's membership gets an empty picker, not an error.
 */
export type BrowsableSubject = {
  userId: string
  displayName: string
  email: string
  orgRole: string
  status: string
}

export async function subjectsIn(
  supabase: SupabaseClient,
  orgId: string,
): Promise<BrowsableSubject[]> {
  // TWO QUERIES, NOT AN EMBED. `org_members.user_id` references `auth.users`,
  // not `public.profiles`, so PostgREST cannot infer a `profiles(...)` embed —
  // the whole select fails and the picker comes back EMPTY rather than erroring,
  // which looks exactly like "this org has no members". lib/view-as.ts's
  // targetsFor() takes the same two-step approach for the same reason.
  const { data } = await supabase
    .from('org_members')
    .select('user_id, role, status')
    .eq('org_id', orgId)

  type MemberRow = { user_id: string; role: string; status: string }
  const members = (data ?? []) as unknown as MemberRow[]
  if (members.length === 0) return []

  const { data: profiles } = await supabase
    .from('profiles')
    .select('user_id, display_name, email')
    .in('user_id', Array.from(new Set(members.map((m) => m.user_id))))

  type ProfileRow = { user_id: string; display_name: string | null; email: string | null }
  const byId = new Map(((profiles ?? []) as unknown as ProfileRow[]).map((p) => [p.user_id, p]))

  return members
    .map((m) => {
      const p = byId.get(m.user_id)
      return {
        userId: m.user_id,
        displayName: p?.display_name || p?.email || m.user_id,
        email: p?.email ?? '',
        orgRole: m.role,
        status: m.status,
      }
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
}
