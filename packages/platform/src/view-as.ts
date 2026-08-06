// View-as (docs/15 §8 + §8.1) — the declaration layer and its completeness check.
//
// THE KEYSTONE (§8.1 point 1): view-as never widens RLS. Everything here is a
// PRESENTATION declaration. The renderer runs the CALLER's ordinary
// RLS-enforced Supabase client; a declaration can only ever narrow what that
// client already returns. There is deliberately no SECURITY DEFINER read path
// in this feature — see docs/15's 2026-07-30 decisions entry, which rejected
// one explicitly.
//
// Two modes (§8.1 points 2-3):
//   mode 1 "see it as if I held that position" — the position's page shape
//          filled with the CALLER's own (possibly empty) data. Nobody else involved.
//   mode 2 "see what Smith sees"               — the position's page shape
//          filled with rows ABOUT Smith that the caller already reads.
//          READ-ONLY, logged append-only, and NOT a re-execution of Smith's
//          own auth.uid()-keyed queries.
//
// The rank-differential completeness check (§8.1 point 11, 2026-07-30) is the
// mapped type `ViewAsEdges` below: for a module's position/rank table, every
// ordered pair with a rank gap MUST carry an explicit entry, and a pair without
// one is a compile error. Equal-rank pairs (GA/student) require no entry.

/** Generic tier ranks — MIRRORS `module_position_rank()` in SQL. */
export type Rank = 0 | 1 | 2 | 3 | 4

/**
 * Which ranks sit strictly BELOW each rank — the type-level form of
 * `rank(A) > rank(B)`. Written out rather than computed because TypeScript has
 * no numeric comparison in the type system and the ladder is only five deep.
 */
type RanksBelow = {
  0: never
  1: 0
  2: 0 | 1
  3: 0 | 1 | 2
  4: 0 | 1 | 2 | 3
}

/** A module's position vocabulary and its ranks. Keys are `module_roles.role` values. */
export type PositionRanks = Record<string, Rank>

/** The positions of `P` that sit strictly below `A`. */
export type PositionsBelow<P extends PositionRanks, A extends keyof P> = {
  [B in keyof P]: P[B] extends RanksBelow[P[A]] ? B : never
}[keyof P]

/**
 * One declared pair. `mode2` without `mode1` is incoherent — you cannot view a
 * specific person's instance of a surface you may not render at all — so the
 * union bans it outright.
 *
 * `note` is required on EVERY entry, on and off alike: the amendment exists so
 * that a human consciously answers each pair, and an unexplained `false` is
 * indistinguishable from an unconsidered one.
 */
export type ViewAsEdge =
  | { mode1: true; mode2: true; note: string }
  | { mode1: true; mode2: false; note: string }
  | { mode1: false; mode2: false; note: string }

/**
 * THE COMPLETENESS CHECK. Keyed by every position that has anything below it;
 * each maps to an entry for every position below it. Missing pair => TS2741.
 * Equal-rank or upward pair => TS2353. Both fail `pnpm typecheck`, which CI runs.
 *
 * NOTE (load-bearing): this type is only as trustworthy as the TS rank table it
 * is keyed on, and the AUTHORITATIVE rank lives in SQL's
 * `module_position_rank(module_key, role)`. A SQL-only rank remap — precisely
 * the "one-line migration with no backfill" the amendment was written to catch
 * — would not fail this type. `viewAsRankParity()` below plus the RLS-suite
 * test that calls it against the live database close that gap; the mapped type
 * alone does NOT deliver the amendment's guarantee.
 */
export type ViewAsEdges<P extends PositionRanks> = {
  [A in keyof P as [PositionsBelow<P, A>] extends [never] ? never : A]: {
    [B in PositionsBelow<P, A>]: ViewAsEdge
  }
}

/** Runtime shape of the above (the type is erased; the resolver needs values). */
export type ViewAsEdgeMap = Record<string, Record<string, ViewAsEdge>>

// ---------------------------------------------------------------------------
// Surface declarations (§8.1 point 9)
// ---------------------------------------------------------------------------

/**
 * A row-predicate narrowing (`.eq()`), so a declaration can be finer than a
 * whole table — e.g. classroom grades are role surface only when
 * `is_final and visible`.
 */
export type SurfaceFilter = { column: string; eq: string | number | boolean }

/**
 * One table's worth of a position's ROLE surface. The columns are an explicit
 * ALLOW-LIST: `select *` is never used, so a column added by a future migration
 * cannot silently join a view-as surface. Point 9's "anything unclassified
 * defaults to PERSONAL" is implemented structurally by that allow-list — not by
 * a runtime default that could be forgotten.
 */
export type SurfaceTable = {
  table: string
  label: string
  columns: readonly string[]
  /**
   * PostgREST embeds (`alias:table(cols)`), for the one-hop lookups the module
   * pages already use — a publication's material title, say. An embed is
   * RLS-filtered independently and comes back null when the caller may not read
   * it, which is the existing behaviour in modules/classroom/ui/page.tsx.
   */
  embed?: readonly { alias: string; table: string; columns: readonly string[] }[]
  /**
   * Columns bounding when the row is visible to the TARGET, so the renderer can
   * badge a row the caller sees but the target does not yet (a material
   * published with a future `visible_from`). Showing it as "hidden until X" is
   * more useful to a professor than omitting it — and more honest than showing
   * it plain.
   */
  visibilityWindow?: { fromColumn: string; untilColumn: string }
  /**
   * The column naming the person a row is ABOUT. Mode 2 filters on it.
   * `null` = the rows are not per-person (published materials, announcements);
   * such a table renders identically in both modes.
   */
  subjectColumn: string | null
  /**
   * The column holding the module entity a row belongs to, used to intersect
   * the rendering with the target GRANT's scope (§8.1 point 10 — a CS chair
   * viewing professor Smith must not see Smith's Math101 side). `null` = the
   * table is not entity-scoped.
   */
  scopeColumn: string | null
  filter?: readonly SurfaceFilter[]
  orderBy?: { column: string; ascending?: boolean }
  limit?: number
  /**
   * Reproduce a visibility rule the TARGET is subject to but the CALLER is
   * exempt from, so mode 2 does not show more than the target actually sees.
   * Classroom submission retention is the motivating case: the hide is
   * `class.submissions_hidden_from <= now()` unless the row's own
   * `visible_override_until` is still in the future, and professors are exempt
   * — without this a professor debugging "why can't Charlie see his old
   * submission" would see it and conclude nothing is wrong.
   */
  hiddenWhen?: {
    /** Date/timestamp column on the SCOPE ENTITY row holding the cutoff. */
    scopeCutoffColumn: string
    /** Timestamp column on THIS row that re-reveals it while still in the future. */
    overrideUntilColumn?: string
  }
  /** Rendered under the section when the view is knowingly imperfect. */
  caveat?: string
}

/**
 * A table that a position can see but which is NEVER rendered upward:
 * RLS-unreadable to every position holding a mode-2 edge into this one. This is
 * §8.1 point 1's strict sense of "personal layer" — the test suite asserts the
 * unreadability, so the claim cannot rot.
 *
 * WHOLE TABLES ONLY, deliberately (a `columns?` field was removed 2026-08-04
 * after the salon review proved it could never be used). The overlap check below
 * refuses one table appearing in both `role` and an off-surface list, so a
 * column-level exclusion on a table that IS rendered was unrepresentable — and
 * every such decision the salon review made had to be a `caveat` anyway. The
 * honest mechanism for columns is the role surface's `columns` ALLOW-LIST plus a
 * caveat saying what was left off and why; a dead optional field only invited
 * someone to set it and assume it did something.
 */
export type PersonalLayer = {
  table: string
  why: string
}

/**
 * A table kept OFF a surface by product decision even though the viewing
 * position can read it ambiently under its own policies.
 *
 * Deliberately a SEPARATE concept from `personal`. §8.1 point 1 says a
 * personal-layer marking on a table with a permissive staff read policy is a
 * spec violation — so anything the staff position can in fact read must not be
 * called personal. Classroom is exactly this case: it has no `sd_notes`
 * analogue, and a professor reads survey answers and review-comment authorship
 * inside their scope. Keeping the two lists apart means the unreadability test
 * stays meaningful and a real RLS gap can never hide behind an "it's hidden"
 * label.
 */
export type ExcludedFromSurface = {
  table: string
  /**
   * Why it is off the surface. STRICTLY the "viewer can read it, we choose not
   * to render it" case — the test suite asserts it really is readable, so this
   * label can never quietly absorb something the viewer cannot see.
   */
  why: string
  // A `columns?` field lived here until 2026-08-04 and was DEAD ON ARRIVAL: the
  // overlap check refuses one table in both `role` and `excluded`, so it could
  // only ever describe a table that is not rendered at all — for which naming
  // columns is meaningless. Column-level decisions belong in the role table's
  // `columns` allow-list plus a `caveat`. See PersonalLayer above.
}

/**
 * A table this POSITION has no read path to at all — absent from the surface
 * by RLS rather than by choice.
 *
 * A third list rather than a footnote on `excluded`, because the three claims
 * are about three different readers and each is separately falsifiable:
 *   personal              — the VIEWER cannot read it (§8.1 point 1's strict sense)
 *   excluded              — the VIEWER can read it; we decline to render it
 *   unreadableByPosition  — the POSITION ITSELF cannot read it
 * Collapsing any two lets a real RLS gap hide behind the wrong label — the
 * exact failure §8.1 point 1 warns about. Recording the absences is worth it
 * on its own: if a future migration adds a read arm, the entry turns into a
 * conscious surface decision instead of a silent widening.
 */
export type UnreadableByPosition = {
  table: string
  why: string
}

export type PositionSurface = {
  label: string
  /** One line shown under the tab, so the operator knows what they are looking at. */
  summary: string
  role: readonly SurfaceTable[]
  personal: readonly PersonalLayer[]
  excluded: readonly ExcludedFromSurface[]
  unreadableByPosition?: readonly UnreadableByPosition[]
}

/**
 * How to turn a `module_scope_nodes` id into the module's own entity ids, so
 * the renderer can intersect a surface with the target grant's scope. Per
 * module because the entity table differs — the same thin-wrapper shape as the
 * scope-authority engine (docs/03 #16).
 */
export type ScopeEntity = {
  table: string
  idColumn: string
  nodeColumn: string
}

export type ViewAsDeclaration = {
  /** Position -> rank. MUST match `module_position_rank(module_key, role)`. */
  positions: PositionRanks
  /** Rank-differential pairs, exhaustively (the mapped type enforces this). */
  edges: ViewAsEdgeMap
  /** Per-position data surface. Every position in `positions` needs one. */
  surfaces: Record<string, PositionSurface>
  /** Absent for modules with no entity tree (single-global-entity, docs/15 §3.1). */
  scopeEntity?: ScopeEntity
}

/**
 * The ONLY way a module should build its declaration. `edges` is typed
 * `ViewAsEdges<P>`, so the rank-differential completeness check fires here at
 * compile time — a module author cannot skip it by hand-rolling the object.
 */
export function declareViewAs<const P extends PositionRanks>(decl: {
  positions: P
  edges: ViewAsEdges<P>
  /** Required for every position reachable by an ON edge; checked at runtime too. */
  surfaces?: Partial<Record<keyof P & string, PositionSurface>>
  scopeEntity?: ScopeEntity
}): ViewAsDeclaration {
  return {
    positions: decl.positions,
    edges: decl.edges as ViewAsEdgeMap,
    surfaces: (decl.surfaces ?? {}) as Record<string, PositionSurface>,
    scopeEntity: decl.scopeEntity,
  }
}

// ---------------------------------------------------------------------------
// Runtime checks — the backstops behind the mapped type
// ---------------------------------------------------------------------------

export type CompletenessProblem = { moduleKey: string; problem: string }

/**
 * Runtime form of the mapped type. Catches what the compiler cannot: a
 * declaration widened with `as`/`any`, a hand-built manifest, or a module added
 * without the typed helper. Asserted in the test suite.
 */
export function viewAsCompleteness(
  moduleKey: string,
  decl: ViewAsDeclaration,
): CompletenessProblem[] {
  const problems: CompletenessProblem[] = []
  const positions = Object.keys(decl.positions)
  const say = (problem: string) => problems.push({ moduleKey, problem })

  // A surface is required for every position that is the TARGET of an ON edge —
  // i.e. exactly the positions something can actually render. A module whose
  // pairs are all off (no view-as security review yet) needs no surfaces, and a
  // module whose vocabulary is entirely rank 0 has no pairs at all.
  const renderable = new Set<string>()
  for (const targets of Object.values(decl.edges)) {
    for (const [b, edge] of Object.entries(targets)) {
      if (edge.mode1 || edge.mode2) renderable.add(b)
    }
  }
  for (const p of renderable) {
    if (!decl.surfaces[p]) say(`position "${p}" is renderable but has no declared data surface`)
  }
  for (const p of Object.keys(decl.surfaces)) {
    if (!(p in decl.positions)) say(`surface declared for unknown position "${p}"`)
  }

  for (const a of positions) {
    const below = positions.filter((b) => decl.positions[b]! < decl.positions[a]!)
    const declared = decl.edges[a] ?? {}
    for (const b of below) {
      const edge = declared[b]
      if (!edge) {
        say(`rank-differential pair ${a} -> ${b} has no explicit on/off entry`)
        continue
      }
      if (edge.mode2 && !edge.mode1) say(`pair ${a} -> ${b} enables mode 2 without mode 1`)
      if (!edge.note.trim()) say(`pair ${a} -> ${b} carries no note`)
    }
    for (const b of Object.keys(declared)) {
      if (!below.includes(b)) {
        say(`pair ${a} -> ${b} is declared but is not rank-differential (no entry allowed)`)
      }
    }
  }

  for (const a of Object.keys(decl.edges)) {
    if (!(a in decl.positions)) say(`edges declared for unknown position "${a}"`)
  }

  // A table belongs to exactly one of role / personal / excluded. Overlap would
  // make "is this rendered?" ambiguous and could let a personal marking sit on
  // a table that is also being rendered.
  for (const [p, surface] of Object.entries(decl.surfaces)) {
    const seen = new Map<string, string>()
    const claim = (table: string, list: string) => {
      const prior = seen.get(table)
      if (prior) say(`surface "${p}": table ${table} appears in both ${prior} and ${list}`)
      else seen.set(table, list)
    }
    for (const t of surface.role) claim(t.table, 'role')
    for (const t of surface.personal) claim(t.table, 'personal')
    for (const t of surface.excluded) claim(t.table, 'excluded')
    for (const t of surface.unreadableByPosition ?? []) claim(t.table, 'unreadableByPosition')

    // A scope-intersected or retention-reproducing table needs the entity map.
    for (const t of surface.role) {
      if ((t.scopeColumn || t.hiddenWhen) && !decl.scopeEntity) {
        say(`surface "${p}": table ${t.table} needs scopeEntity but the module declares none`)
      }
      // §8.1 point 10: a mode-2 rendering is the target's surface INTERSECTED
      // with the caller's scope. A role table with no scopeColumn in a module
      // that HAS an entity tree would skip that intersection entirely and show
      // every org-wide row the caller can read — bounded by RLS, so never a
      // keystone violation, but still rows outside the target grant's scope,
      // which point 10 forbids. Unused today; refused so it stays that way.
      if (decl.scopeEntity && !t.scopeColumn) {
        say(
          `surface "${p}": table ${t.table} has no scopeColumn, but ${moduleKey} has an entity ` +
            `tree — scope intersection (§8.1 point 10) would be skipped`,
        )
      }
      if (t.hiddenWhen && !t.scopeColumn) {
        say(`surface "${p}": table ${t.table} declares hiddenWhen but has no scopeColumn`)
      }
      if (t.columns.length === 0) say(`surface "${p}": table ${t.table} declares no columns`)
      if (t.subjectColumn && !t.columns.includes(t.subjectColumn)) {
        say(`surface "${p}": table ${t.table} omits its own subject column from the allow-list`)
      }
    }
  }

  // A mode-2 surface must actually be renderable: every role-surface table of a
  // mode-2 TARGET needs a subject column, or "rows about the target" is undefined.
  for (const [a, targets] of Object.entries(decl.edges)) {
    for (const [b, edge] of Object.entries(targets)) {
      if (!edge.mode2) continue
      const surface = decl.surfaces[b]
      if (!surface) continue
      if (!surfaceIsPersonFilterable(surface)) {
        say(`pair ${a} -> ${b} enables mode 2 but ${b}'s surface has no per-person table`)
      }
    }
  }

  return problems
}

/**
 * Can "the rows ABOUT one named person" be expressed on this surface at all?
 *
 * True only if at least one role table names a person. §8.1 point 3 defines
 * mode 2 as rows ABOUT the target, so a surface with no per-person column
 * cannot express it: filtering on an authorship stamp (`created_by`, `paid_by`)
 * UNDER-shows the tab by hiding rows the target genuinely reads, and rendering
 * unfiltered is honest but is not mode 2. That is the nail-salon review's
 * central finding (2026-08-04, docs/03 #18) — manager and cashier are
 * location-narrowed, so no row is about either as a person.
 *
 * ONE definition, TWO consumers, deliberately. `viewAsCompleteness()` below
 * refuses a declared mode-2 edge into such a surface; the Owner Console
 * (apps/web/lib/console-view-as.ts) refuses to OFFER its person mode there.
 * They must not be able to disagree: the Owner Console exists to bypass
 * declared EDGES, and if it silently bypassed this too it would render every
 * holder's rows under one person's name — the falsely-permissive failure
 * docs/03 #18 says a surface must never have.
 */
export function surfaceIsPersonFilterable(surface: PositionSurface): boolean {
  return surface.role.some((t) => t.subjectColumn !== null)
}

/** (position, rank) pairs to check against SQL's `module_position_rank`. */
export function viewAsRankParity(decl: ViewAsDeclaration): { role: string; rank: Rank }[] {
  return Object.entries(decl.positions).map(([role, rank]) => ({ role, rank }))
}

// ---------------------------------------------------------------------------
// Resolver — used by the server to decide what a caller may open
// ---------------------------------------------------------------------------

/** A grant as the picker sees it. */
export type GrantRef = {
  userId: string
  role: string
  scopeRef: string | null
}

export type ViewAsTab = {
  position: string
  label: string
  summary: string
  /** Mode 1 is available (the caller may render this position's page shape). */
  mode1: boolean
  /** Mode 2 is available (the caller may pick a specific person). */
  mode2: boolean
}

/**
 * The tabs a caller may see, given the positions they hold in this module.
 *
 * EDGES DO NOT COMPOSE (§8.1 point 4): a tab appears only if the caller
 * DIRECTLY holds a position with a declared edge to it. Reachability through an
 * intermediary's edges is never computed.
 */
export function viewAsTabsFor(
  decl: ViewAsDeclaration,
  callerPositions: readonly string[],
): ViewAsTab[] {
  const held = new Set(callerPositions.filter((p) => p in decl.positions))
  const byTarget = new Map<string, { mode1: boolean; mode2: boolean }>()

  for (const a of held) {
    for (const [b, edge] of Object.entries(decl.edges[a] ?? {})) {
      if (!edge.mode1 && !edge.mode2) continue
      const prev = byTarget.get(b) ?? { mode1: false, mode2: false }
      byTarget.set(b, { mode1: prev.mode1 || edge.mode1, mode2: prev.mode2 || edge.mode2 })
    }
  }

  const order = Object.keys(decl.positions).sort(
    (x, y) => decl.positions[y]! - decl.positions[x]!,
  )
  return order
    .filter((b) => byTarget.has(b))
    .map((b) => ({
      position: b,
      label: decl.surfaces[b]?.label ?? b,
      summary: decl.surfaces[b]?.summary ?? '',
      mode1: byTarget.get(b)!.mode1,
      mode2: byTarget.get(b)!.mode2,
    }))
}

/** Does any position the caller holds carry a mode-2 edge into `target`? */
export function mayViewAsPerson(
  decl: ViewAsDeclaration,
  callerPositions: readonly string[],
  target: string,
): boolean {
  return callerPositions.some((a) => decl.edges[a]?.[target]?.mode2 === true)
}

/** Does any position the caller holds carry a mode-1 edge into `target`? */
export function mayRenderPosition(
  decl: ViewAsDeclaration,
  callerPositions: readonly string[],
  target: string,
): boolean {
  return callerPositions.some((a) => decl.edges[a]?.[target]?.mode1 === true)
}
