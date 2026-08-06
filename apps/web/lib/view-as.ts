// View-as server plumbing (docs/15 §8 + §8.1). Slice 5.
//
// THE KEYSTONE, restated where it matters most: every query below runs on the
// CALLER's ordinary RLS-enforced client from lib/supabase/server.ts. Nothing
// here has, or may ever gain, a service-role client or a SECURITY DEFINER read
// path — §8.1 point 1 makes any gap between a declared edge and the caller's
// own RLS reach a defect in the ladder's RLS design, never something view-as
// bridges. A surface declaration can only ever NARROW what the caller's client
// already returns.

import { cookies } from 'next/headers'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  mayViewAsPerson,
  mayRenderPosition,
  viewAsTabsFor,
  type PositionSurface,
  type SurfaceTable,
  type ViewAsDeclaration,
  type ViewAsTab,
} from '@platform/core'

/** A grant the caller holds in this module. */
export type HeldGrant = { role: string; scopeRef: string | null }

/** A candidate mode-2 target: a (person, position, scope) triple, never a person. */
export type TargetGrant = {
  userId: string
  role: string
  scopeRef: string | null
  displayName: string
  scopeLabel: string
}

export type ScopeNode = { id: string; parentId: string | null; name: string; path: string }

export const VIEW_AS_COOKIE_PREFIX = 'viewas_'

export function viewAsCookieName(moduleKey: string) {
  return `${VIEW_AS_COOKIE_PREFIX}${moduleKey}`
}

// ---------------------------------------------------------------------------
// Reading the ladder
// ---------------------------------------------------------------------------

export async function heldGrants(
  supabase: SupabaseClient,
  orgId: string,
  moduleKey: string,
  userId: string,
): Promise<HeldGrant[]> {
  const { data } = await supabase
    .from('module_roles')
    .select('role, scope_ref')
    .eq('org_id', orgId)
    .eq('module_key', moduleKey)
    .eq('user_id', userId)
  return (data ?? []).map((r) => ({ role: r.role as string, scopeRef: r.scope_ref as string | null }))
}

export async function scopeNodes(
  supabase: SupabaseClient,
  orgId: string,
  moduleKey: string,
): Promise<Map<string, ScopeNode>> {
  const { data } = await supabase
    .from('module_scope_nodes')
    .select('id, parent_id, name, path')
    .eq('org_id', orgId)
    .eq('module_key', moduleKey)
  const map = new Map<string, ScopeNode>()
  for (const n of data ?? []) {
    map.set(n.id as string, {
      id: n.id as string,
      parentId: n.parent_id as string | null,
      name: n.name as string,
      path: n.path as string,
    })
  }
  return map
}

/**
 * Does scope `a` COVER scope `b` (self-or-under)? The TypeScript mirror of
 * SQL's `module_scope_covers`, including its total null semantics: null
 * (global) covers every node; no node covers null; null vs null is coverage.
 * Coverage is a prefix match on the trigger-computed path of node IDS — never
 * on names (docs/15 §4.1 item 7).
 */
export function scopeCovers(
  nodes: Map<string, ScopeNode>,
  a: string | null,
  b: string | null,
): boolean {
  if (a === null) return true
  if (b === null) return false
  const an = nodes.get(a)
  const bn = nodes.get(b)
  // Node existence is checked BEFORE the identity shortcut, mirroring SQL's
  // `exists(select ...)`. Unreachable today — module_scope_nodes_select_member
  // lets any org member read every node in the org, so the map is always
  // complete for a legitimate caller — but coverage should fail closed on its
  // own terms rather than lean on that invariant holding forever.
  if (!an || !bn) return false
  if (a === b) return true
  return bn.path.startsWith(an.path)
}

export function scopeLabel(nodes: Map<string, ScopeNode>, scopeRef: string | null): string {
  if (scopeRef === null) return 'whole module'
  return nodes.get(scopeRef)?.name ?? 'unknown scope'
}

export function tabsFor(decl: ViewAsDeclaration, grants: readonly HeldGrant[]): ViewAsTab[] {
  return viewAsTabsFor(decl, grants.map((g) => g.role))
}

// ---------------------------------------------------------------------------
// Mode-2 targets
// ---------------------------------------------------------------------------

/**
 * The grants the caller may view as, for one target position.
 *
 * Three conditions, all required: the declared edge is on (checked by the
 * caller of this function), the caller STRICTLY OUTRANKS the target grant, and
 * the caller's own scope COVERS the target grant's scope. The same rule the
 * migration's guard trigger enforces in the database — deliberately duplicated
 * so a bug in either layer is caught by the other.
 *
 * Self is excluded: viewing your own grant is mode 1, which needs no session.
 */
export async function targetsFor(
  supabase: SupabaseClient,
  decl: ViewAsDeclaration,
  orgId: string,
  moduleKey: string,
  callerId: string,
  callerGrants: readonly HeldGrant[],
  targetPosition: string,
  nodes: Map<string, ScopeNode>,
): Promise<TargetGrant[]> {
  const targetRank = decl.positions[targetPosition]
  if (targetRank === undefined) return []

  const { data } = await supabase
    .from('module_roles')
    .select('user_id, role, scope_ref')
    .eq('org_id', orgId)
    .eq('module_key', moduleKey)
    .eq('role', targetPosition)
  const rows = (data ?? []).filter((r) => (r.user_id as string) !== callerId)
  if (rows.length === 0) return []

  const covering = rows.filter((r) =>
    callerGrants.some(
      (g) =>
        (decl.positions[g.role] ?? 0) > targetRank &&
        scopeCovers(nodes, g.scopeRef, r.scope_ref as string | null),
    ),
  )
  if (covering.length === 0) return []

  const { data: profiles } = await supabase
    .from('profiles')
    .select('user_id, display_name')
    .in('user_id', Array.from(new Set(covering.map((r) => r.user_id as string))))
  const nameOf = new Map((profiles ?? []).map((p) => [p.user_id as string, p.display_name as string | null]))

  return covering.map((r) => ({
    userId: r.user_id as string,
    role: r.role as string,
    scopeRef: r.scope_ref as string | null,
    displayName: nameOf.get(r.user_id as string) || 'Unnamed member',
    scopeLabel: scopeLabel(nodes, r.scope_ref as string | null),
  }))
}

/** Stable key for a grant triple, used in form values and URL params. */
export function grantKey(g: { userId: string; role: string; scopeRef: string | null }) {
  return `${g.userId}|${g.role}|${g.scopeRef ?? ''}`
}

export function parseGrantKey(key: string): { userId: string; role: string; scopeRef: string | null } | null {
  const parts = key.split('|')
  if (parts.length !== 3) return null
  const [userId, role, scope] = parts
  if (!userId || !role) return null
  return { userId, role, scopeRef: scope ? scope : null }
}

// ---------------------------------------------------------------------------
// The active mode-2 session
// ---------------------------------------------------------------------------

export type ActiveSession = {
  id: string
  targetUserId: string
  targetRole: string
  targetScopeRef: string | null
}

/**
 * Resolve the mode-2 session from its HttpOnly cookie, or null.
 *
 * The log row IS the session (see the migration header): there is no way to
 * render a view-as-a-person render without a row in `view_as_sessions`, so §8.1
 * point 6's "every mode-2 session start is logged" is structural rather than a
 * call the app is trusted to remember. A pasted URL with no cookie renders the
 * picker, not a view.
 *
 * Re-resolved on EVERY render, not cached: authority revoked mid-session must
 * take effect immediately, and RLS alone would only empty the rows, leaving a
 * misleading page shape behind.
 */
export async function activeSession(
  supabase: SupabaseClient,
  orgId: string,
  moduleKey: string,
): Promise<ActiveSession | null> {
  const jar = await cookies()
  const id = jar.get(viewAsCookieName(moduleKey))?.value
  if (!id) return null

  // RLS (view_as_sessions_select_actor) already restricts this to the caller's
  // own rows, so a stolen or guessed id resolves to nothing.
  const { data } = await supabase
    .from('view_as_sessions')
    .select('id, org_id, module_key, target_user_id, target_role, target_scope_ref, expires_at, actor_user_id')
    .eq('id', id)
    .maybeSingle()
  if (!data) return null
  if (data.org_id !== orgId || data.module_key !== moduleKey) return null
  if (new Date(data.expires_at as string).getTime() <= Date.now()) return null

  return {
    id: data.id as string,
    targetUserId: data.target_user_id as string,
    targetRole: data.target_role as string,
    targetScopeRef: data.target_scope_ref as string | null,
  }
}

/**
 * The full mode-2 authorisation, re-run on every render. Returns null when the
 * session may no longer be used, in which case the page falls back to the picker.
 */
export function sessionStillAuthorised(
  decl: ViewAsDeclaration,
  callerGrants: readonly HeldGrant[],
  nodes: Map<string, ScopeNode>,
  session: ActiveSession,
): boolean {
  const roles = callerGrants.map((g) => g.role)
  if (!mayViewAsPerson(decl, roles, session.targetRole)) return false
  const targetRank = decl.positions[session.targetRole]
  if (targetRank === undefined) return false
  return callerGrants.some(
    (g) =>
      (decl.positions[g.role] ?? 0) > targetRank &&
      scopeCovers(nodes, g.scopeRef, session.targetScopeRef),
  )
}

export function mode1Allowed(decl: ViewAsDeclaration, grants: readonly HeldGrant[], position: string) {
  return mayRenderPosition(decl, grants.map((g) => g.role), position)
}

// ---------------------------------------------------------------------------
// The generic surface renderer's data layer
// ---------------------------------------------------------------------------

export type RenderedRow = {
  values: Record<string, unknown>
  /** Set when a visibilityWindow says the target cannot see this row yet / any more. */
  windowState: 'open' | 'not-yet' | 'expired' | null
}

export type RenderedSection = {
  table: string
  label: string
  columns: readonly string[]
  rows: RenderedRow[]
  caveat?: string
  error?: string
  /**
   * Whether the per-person narrowing actually happened, per section.
   *
   * `applied`         — the table names a person and was filtered to them.
   * `not-per-person`  — the table has no subject column; class-wide for this
   *                     position and identical in every mode, by design.
   * `not-narrowed`    — THE ONE THAT MATTERS. The table DOES name a person and
   *                     was deliberately left unfiltered, so it shows every
   *                     holder's rows. Only reachable from the Owner Console's
   *                     no-person-filter mode. Badged on screen, because
   *                     docs/03 #18's worst failure is a section that shows rows
   *                     the target cannot see: an operator debugging "why can't
   *                     she see this?" sees it and concludes nothing is wrong.
   */
  personFilter: 'applied' | 'not-per-person' | 'not-narrowed'
}

export type RenderedSurface = {
  sections: RenderedSection[]
  /** True when the caller governs only part of the target grant's scope (§8.1 point 10). */
  partial: boolean
  scopeNote: string
  /** Surfaced, never swallowed: the scope resolver could not read the entity table. */
  scopeError?: string
  /**
   * The scope resolver found ZERO entities while the module's scope tree DOES
   * have nodes in reach — so every scoped section renders empty and the page
   * cannot tell you whether that is the truth. See `ScopeResolution.blinded`.
   */
  blinded: boolean
  /** The scopeEntity table, so a blinded/errored render can name what it failed to read. */
  entityTable?: string
}

/**
 * WHICH GATE DID THIS CALLER PASS? A discriminated union rather than an
 * optional flag, so no caller can invoke the renderer without naming its
 * authority — the two paths intersect scope differently and a boolean would let
 * a future call site get the bypass by accident.
 *
 * `module-grants` is the ordinary in-module path: §8.1 point 10's intersection
 * of the target's surface with WHAT THE CALLER GOVERNS, labelled partial in the
 * UI.
 *
 * `platform-superadmin` is the Owner Console (docs/13, 2026-08-02). It is NOT a
 * deletion of point 10: a platform superadmin governs everything, so the
 * intersection is with the universe and the requested scope stands on its own.
 * Spelling that out is the point — a superadmin holds NO module grants at all,
 * so the ordinary path silently resolves a scoped target to the EMPTY set and
 * renders a blank page that looks like a finding.
 *
 * THE KEYSTONE IS UNTOUCHED EITHER WAY (§8.1 point 1). Both paths run the
 * caller's own RLS-enforced client; neither may ever gain `.rpc()` or a
 * service-role client. `platform-superadmin` bypasses declared EDGES and the
 * caller-scope intersection — never RLS. A superadmin sees more here only
 * because `is_org_admin()` short-circuits on `is_superadmin()` in the modules'
 * own policies, which is true of any query they could already issue against
 * PostgREST directly.
 *
 * Adding a third kind is the moment to re-answer the logging question — see the
 * header of apps/web/lib/console-view-as.ts. Today exactly one authority skips
 * the mode-2 session log, and it is the platform operator's own.
 */
export type RenderAuthority =
  | { kind: 'module-grants'; grants: readonly HeldGrant[] }
  | { kind: 'platform-superadmin' }

type ScopeResolution = {
  /** Entity ids to filter on, or null for "no entity restriction". */
  entityIds: string[] | null
  /** Per-entity cutoff dates for `hiddenWhen`. */
  cutoffs: Map<string, string | null>
  partial: boolean
  note: string
  error?: string
  /**
   * Zero entities resolved, but the module's scope tree HAS nodes in reach.
   *
   * The honest third state between "this scope holds nothing" and "your client
   * cannot read the entity table" (docs/03 #19's rule that a failed lookup must
   * render as "we could not check", never as an empty section). It is a real
   * detector rather than a guess because `module_scope_nodes` and the entity
   * table are read under DIFFERENT policies: a superadmin reads every node
   * (`module_scope_nodes_select_member` carries an `is_superadmin()` arm) but
   * `sal_locations_select_member` is bare `is_org_member(org_id)`, which a
   * superadmin fails — so nodes>0 with entities=0 is exactly the shape of a
   * blinded read. Over-cautious by design: a module whose tree has nodes but no
   * entity rows yet trips it too, and the page words it as a question.
   */
  blinded: boolean
}

/**
 * Resolve the target grant's scope to the module's own entity ids, intersected
 * with what the CALLER governs (§8.1 point 10: "what Smith sees, WITHIN what I
 * govern" — a CS chair viewing professor Smith never sees Smith's Math101 side).
 *
 * RLS would already deliver most of this, since the caller's policies are
 * scope-aware after slice 2. Computing it explicitly anyway does two things RLS
 * cannot: it lets the UI honestly LABEL the view as partial, and it stops a
 * surface table whose policy happens to be coarser than the ladder from
 * quietly widening a tab.
 */
async function resolveScope(
  supabase: SupabaseClient,
  decl: ViewAsDeclaration,
  orgId: string,
  nodes: Map<string, ScopeNode>,
  authority: RenderAuthority,
  targetScopeRef: string | null,
  cutoffColumn: string | null,
): Promise<ScopeResolution> {
  const entity = decl.scopeEntity
  if (!entity) {
    return { entityIds: null, cutoffs: new Map(), partial: false, note: '', blinded: false }
  }

  // Nodes under the target grant's scope (global grant => the whole tree).
  const targetNodes = Array.from(nodes.values()).filter((n) => scopeCovers(nodes, targetScopeRef, n.id))
  // ...of which the CALLER governs these. A platform superadmin governs the
  // whole platform, so the intersection is the identity — written as a branch on
  // the authority rather than as "no grants means everything", because for the
  // ordinary path "no grants" means the opposite (nothing).
  const governed =
    authority.kind === 'platform-superadmin'
      ? targetNodes
      : targetNodes.filter((n) => authority.grants.some((g) => scopeCovers(nodes, g.scopeRef, n.id)))
  const partial = governed.length < targetNodes.length

  const columns = [entity.idColumn, entity.nodeColumn, 'name']
  if (cutoffColumn) columns.push(cutoffColumn)

  // "The whole module" under superadmin authority means NO node filter, not "all
  // the nodes I could enumerate". The difference is real: `scope_node_id` is
  // NULLABLE on every scopeEntity table and carries `on delete set null`, so
  // deleting a scope node leaves live entities with a null node — and SQL `in`
  // never matches null, so enumerating nodes would silently drop exactly those
  // rows from an operator who asked to see everything. The ordinary path keeps
  // the enumeration on purpose: for a scoped caller, excluding an entity with no
  // scope node is correct and agrees with RLS (`module_caller_covers_rank`
  // refuses a null node outright).
  const wholeModuleBypass = authority.kind === 'platform-superadmin' && targetScopeRef === null

  let query = supabase.from(entity.table).select(columns.join(', ')).eq('org_id', orgId)
  if (wholeModuleBypass) {
    // no node restriction at all
  } else if (governed.length > 0) query = query.in(entity.nodeColumn, governed.map((n) => n.id))
  else if (targetScopeRef !== null) {
    // A scoped request resolving to no nodes at all. For the ordinary path that
    // is "you govern no part of this grant's scope"; for a superadmin, who
    // governs everything, the only way here is a scope node that does not exist
    // or is unreadable — which is a broken request, not an empty one.
    return {
      entityIds: [],
      cutoffs: new Map(),
      partial: authority.kind === 'module-grants',
      note:
        authority.kind === 'platform-superadmin'
          ? 'that scope node could not be resolved'
          : 'You govern no part of this grant’s scope.',
      blinded: authority.kind === 'platform-superadmin',
    }
  }

  // The error is SURFACED, not swallowed (docs/03 #19). It was dropped here
  // until 2026-08-06, so a scope-entity read that failed outright was
  // indistinguishable from a scope that legitimately holds nothing — and every
  // scoped section below would then render an honest-looking "Nothing here".
  const { data, error } = await query
  if (error) {
    return {
      entityIds: [],
      cutoffs: new Map(),
      partial,
      note: `could not read ${entity.table}`,
      error: error.message,
      blinded: false,
    }
  }

  const rows = (data ?? []) as unknown as Record<string, unknown>[]
  const entityIds = rows.map((r) => String(r[entity.idColumn]))
  const cutoffs = new Map<string, string | null>()
  if (cutoffColumn) {
    for (const r of rows) cutoffs.set(String(r[entity.idColumn]), (r[cutoffColumn] as string | null) ?? null)
  }

  const names = rows.map((r) => String(r['name'] ?? '')).filter(Boolean)
  const note = names.length ? names.join(', ') : 'no entities in reach'
  // No error and no rows, yet the scope tree has nodes here: the two are read
  // under different policies, so this is the shape of a read the caller's RLS
  // silently emptied rather than a scope that is genuinely bare.
  return { entityIds, cutoffs, partial, note, blinded: rows.length === 0 && targetNodes.length > 0 }
}

/**
 * Reproduce `cls_submission_hidden`-style retention: a row is hidden once its
 * entity's cutoff has passed, unless the row's own override is still in the
 * future. The CALLER is exempt from this (a professor always reads the row), so
 * without reproducing it a mode-2 view would be falsely permissive — the
 * professor debugging "why can't Charlie see this?" would see it and conclude
 * nothing was wrong.
 */
// Matches cls_submission_hidden (20260709080000) condition for condition:
// hidden once `now() >= cutoff` AND no override is still in the future
// (`now() > override`). Both branches including boundary inclusivity were
// checked against the SQL and confirmed faithful in the 2026-07-31 review.
// `submissions_hidden_from` is a bare DATE, which Postgres resolves at the
// server's midnight and JS resolves as UTC midnight — these agree because the
// database runs in UTC. (Separately, and pre-dating view-as: the retention
// cutoff never consults `cls_classes.timezone`, so a class in a non-UTC zone
// hides on UTC's day boundary. That is a question for 20260709080000, not for
// this renderer, which only mirrors whatever the policy does.)
function hiddenFromTarget(
  spec: NonNullable<SurfaceTable['hiddenWhen']>,
  row: Record<string, unknown>,
  scopeColumn: string,
  cutoffs: Map<string, string | null>,
): boolean {
  const cutoff = cutoffs.get(String(row[scopeColumn]))
  if (!cutoff) return false
  if (Date.now() < new Date(cutoff).getTime()) return false
  if (spec.overrideUntilColumn) {
    const override = row[spec.overrideUntilColumn] as string | null
    if (override && Date.now() <= new Date(override).getTime()) return false
  }
  return true
}

function windowStateOf(spec: NonNullable<SurfaceTable['visibilityWindow']>, row: Record<string, unknown>) {
  const from = row[spec.fromColumn] as string | null
  const until = row[spec.untilColumn] as string | null
  const now = Date.now()
  if (from && now < new Date(from).getTime()) return 'not-yet' as const
  if (until && now >= new Date(until).getTime()) return 'expired' as const
  return 'open' as const
}

/**
 * Render one position's declared surface.
 *
 * `subjectUserId` is who the per-person rows are ABOUT: the target in mode 2,
 * and the CALLER in mode 1 (§8.1 point 8 — mode 1 shows the position's page
 * shape filled with the caller's own, possibly empty, data and creates
 * nothing). For the in-module page, passing null would not be mode 1: it would
 * just be the caller's ambient staff view wearing a lower position's label, so
 * that page never passes it. Tables declared `subjectColumn: null` are
 * class-wide for that position and are unfiltered in both modes by design.
 *
 * NULL IS NOW MEANINGFUL, and only from the Owner Console: it is the
 * no-person-filter mode (founder, 2026-08-03), which answers "one named
 * holder's SCOPE-narrowed console" — the need the nail-salon review identified
 * and refused to fake, since a location-narrowed position has no per-person
 * column to key on. It renders MORE than any single holder sees, so every
 * affected section is tagged `not-narrowed` and badged rather than passed off as
 * a person view.
 */
export async function renderSurface(
  supabase: SupabaseClient,
  decl: ViewAsDeclaration,
  surface: PositionSurface,
  orgId: string,
  nodes: Map<string, ScopeNode>,
  authority: RenderAuthority,
  targetScopeRef: string | null,
  subjectUserId: string | null,
): Promise<RenderedSurface> {
  const cutoffColumn =
    surface.role.find((t) => t.hiddenWhen)?.hiddenWhen?.scopeCutoffColumn ?? null
  const scope = await resolveScope(
    supabase,
    decl,
    orgId,
    nodes,
    authority,
    targetScopeRef,
    cutoffColumn,
  )

  const sections: RenderedSection[] = []
  for (const spec of surface.role) {
    const personFilter: RenderedSection['personFilter'] = !spec.subjectColumn
      ? 'not-per-person'
      : subjectUserId
        ? 'applied'
        : 'not-narrowed'
    // Column ALLOW-LIST, never `select *` — a column added by a future
    // migration must not be able to join a view-as surface by accident.
    const embeds = (spec.embed ?? []).map((e) => `${e.alias}:${e.table}(${e.columns.join(',')})`)
    const select = [...spec.columns, ...embeds].join(', ')

    let query = supabase.from(spec.table).select(select).eq('org_id', orgId)
    if (spec.scopeColumn && scope.entityIds !== null) {
      if (scope.entityIds.length === 0) {
        // Empty because scope resolution produced nothing. Whether that is the
        // truth is `scope.blinded`/`scope.error`'s question, reported once for
        // the whole surface rather than repeated on every section.
        sections.push({
          table: spec.table,
          label: spec.label,
          columns: spec.columns,
          rows: [],
          caveat: spec.caveat,
          personFilter,
        })
        continue
      }
      query = query.in(spec.scopeColumn, scope.entityIds)
    }
    if (subjectUserId && spec.subjectColumn) query = query.eq(spec.subjectColumn, subjectUserId)
    for (const f of spec.filter ?? []) query = query.eq(f.column, f.eq)
    if (spec.orderBy) query = query.order(spec.orderBy.column, { ascending: spec.orderBy.ascending ?? true })
    query = query.limit(spec.limit ?? 200)

    const { data, error } = await query
    if (error) {
      sections.push({
        table: spec.table,
        label: spec.label,
        columns: spec.columns,
        rows: [],
        caveat: spec.caveat,
        error: error.message,
        personFilter,
      })
      continue
    }

    let rows = (data ?? []) as unknown as Record<string, unknown>[]
    if (spec.hiddenWhen && spec.scopeColumn) {
      rows = rows.filter((r) => !hiddenFromTarget(spec.hiddenWhen!, r, spec.scopeColumn!, scope.cutoffs))
    }

    sections.push({
      table: spec.table,
      label: spec.label,
      columns: spec.columns,
      caveat: spec.caveat,
      personFilter,
      rows: rows.map((r) => ({
        values: r,
        windowState: spec.visibilityWindow ? windowStateOf(spec.visibilityWindow, r) : null,
      })),
    })
  }

  return {
    sections,
    partial: scope.partial,
    scopeNote: scope.note,
    scopeError: scope.error,
    blinded: scope.blinded,
    entityTable: decl.scopeEntity?.table,
  }
}
