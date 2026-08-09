// The Owner Console view-as (docs/13's superadmin "view as anything" surface;
// founder decision 2026-08-02, sequenced after the per-person data browser).
//
// WHAT IT IS: a platform-superadmin surface that renders any declared position
// surface in any org, IGNORING the manifest's declared view-as edges — including
// pairs that are off permanently on purpose (speed-dating participant). It lives
// in the Owner Console and is deliberately absent from the in-module tab strips,
// so those stay strictly by-the-rules.
//
// WHAT IT BYPASSES, PRECISELY — four things and no more (it said THREE until
// 2026-08-06; the adversarial review's finding 4 found the fourth, and the
// count is stated because an exhaustive-sounding list that is not exhaustive is
// worse than no list):
//   1. the declared EDGE (`decl.edges[from][to]`), because there is no "from":
//      a superadmin holds no module position at all;
//   2. the strict-rank and scope-coverage conditions, for the same reason;
//   3. the caller-scope INTERSECTION (§8.1 point 10), which for a caller with no
//      grants resolves every scoped target to the empty set — see
//      `RenderAuthority` in lib/view-as.ts;
//   4. `org_modules.enabled` — the ROUTING gate `requireOrgModule` 404s on
//      (lib/module-gate.ts). A disabled module renders here in full, which is
//      the founder's decision (2026-08-06) because disabling is step ONE of
//      deprecation and this is exactly when someone must see what a position
//      could reach. It is badged on screen, since a holder can open none of
//      those tabs. Safe to bypass for a reason worth writing down: ZERO RLS
//      policies reference `org_modules`, so enablement changes routing and
//      never reach.
// It does NOT bypass RLS, and it does not bypass the SURFACE declaration. Every
// query runs on the superadmin's own RLS-enforced client (§8.1 point 1's
// keystone), and only a table some module declared can appear on screen.
//
// AND ONE THING IT DOES NOT BYPASS THAT LOOKS LIKE IT SHOULD: mode 2 is refused
// on a surface with no per-person column, exactly as `viewAsCompleteness()`
// refuses a declared mode-2 edge into one. The reason is a property of the
// SURFACE, not of the edge, so an edge bypass cannot touch it.
//
// A KNOWN GAP, recorded rather than closed (review finding 6, 2026-08-06):
// `blinded` — the "your own RLS may have emptied this" detector in
// lib/view-as.ts — is computed ONCE, for the module's `scopeEntity` table, and
// never per role table. A future migration that drops an `is_org_admin` arm on
// an ordinary role table therefore yields a silent, error-free, UNBADGED empty
// section. The migration in this very build is proof the category already bit
// once; it was caught only because it hit the scope-entity table, which has the
// loud symptom of emptying every scoped section at once. On the Next list.
//
// THE GATE IS A UI GATE, and that is sound here for exactly the reason docs/03
// #19 gives for the data browser: every query this surface issues is one the
// superadmin could already issue against PostgREST as themselves, because the
// modules' own policies short-circuit on `is_org_admin()` which short-circuits
// on `is_superadmin()`. So bypassing `requireSuperadmin()` grants nothing.
// **The invariant that keeps that true: no code on this path may ever call
// `.rpc()` or a service-role client.** One SECURITY DEFINER read and the app
// gate becomes the only thing between a user and data RLS would have refused —
// which is precisely what docs/03 #18 forbids. Note this does NOT contradict #18's
// "the app layer is not a gate": that rule is about STARTING A MODE-2 SESSION,
// a real PostgREST-reachable WRITE.
//
// THAT SENTENCE USED TO END "...and this surface writes nothing." It is FALSE as
// of 2026-08-07 and is corrected here rather than deleted, because the claim was
// load-bearing: it was the reason #18's rule was said not to bite. This surface
// now writes exactly one row per render, to `superadmin_lookup_log`
// (migration 20260807010000, app half lib/superadmin-log.ts).
//
// The rule still does not bite, but the reason is now DIFFERENT and has to be
// argued rather than inherited: the write is an append-only audit row ABOUT THE
// CALLER, server-stamped by a guard trigger that discards any client-supplied
// actor, and NOTHING DOWNSTREAM READS IT BACK AS A CAPABILITY. That last clause
// is the whole distinction from `view_as_sessions`, where a row IS a capability
// — the in-module page resolves a cookie to a row and renders from it — which is
// exactly why that table's insert needed a guard enforcing rank, scope and a
// declared edge. Forging a row here buys an attacker a false line in a log only
// they and a superadmin can read; forging one there would buy a render.
//
// ---------------------------------------------------------------------------
// THE LOGGING QUESTION — RESOLVED 2026-08-07/08. THE LOG IS BUILT AND LIVE.
//
// READ THIS BANNER BEFORE THE SECTION BELOW IT. Everything from here to the end
// of this header is the HISTORICAL RECORD of how the decision was reached — it
// is kept because the reasoning was overturned in stages and each stage is worth
// knowing, but it describes a build that no longer exists. What is true NOW:
// both Owner Console tools write to `superadmin_lookup_log` on every real
// lookup (migration 20260807010000, app half lib/superadmin-log.ts), and the
// on-screen badge says "logged", not "not logged".
//
// The section's original heading was "settled here, deliberately, 2026-08-06",
// which read as a standing answer. It was a description of ONE BUILD, and that
// build shipped, got its follow-on, and was superseded the next day.
// ---------------------------------------------------------------------------
// docs/15 §8.1 point 6 says every mode-2 session start is logged append-only
// "from v1 — reads are the unstamped side, and the session log is a security
// requirement, not the later audit upgrade". docs/13 says this surface is
// "unlogged, by founder decision" (2026-08-02). Those two sentences are in real
// tension: this surface is strictly MORE powerful than the logged one, so
// inheriting "unlogged" from the data browser without argument would be exactly
// the kind of assumption CLAUDE.md flags.
//
// DECISION: UNLOGGED, on three grounds, the third of which is new.
//
//  1. REUSING `view_as_sessions` IS THE WRONG SHAPE, and this is a code fact
//     rather than a preference. Its guard trigger requires ONE grant of the
//     actor's that outranks, covers, AND declares an edge to the target. A
//     superadmin holds no module grants, so every insert raises. Making it work
//     means adding an `is_superadmin()` arm to `view_as_guard_session` — and
//     that guard is the one gate on the platform deliberately built WITHOUT an
//     `is_org_admin` short-circuit, under the founder's own 2026-08-02 rule
//     ("org position does not enable view-as; module position does"), with its
//     migration explicitly saying a new view-as surface should not add a fresh
//     instance of that coupling. Logging in that table would corrode the
//     cleanest gate we have in order to record the operator looking at his own
//     platform.
//  2. THE DISCLOSURE CONSEQUENCE RUNS BACKWARDS. `view_as_sessions` is readable
//     by org admins, so logging there would publish superadmin activity into
//     every tenant's audit view. docs/13 already noticed this and called it the
//     non-obvious consequence of the choice. A separate superadmin-only log
//     avoids that, but a log only its own subject can read is a thin control.
//  3. THE REAL QUESTION IS BIGGER THAN THIS SURFACE, and it is the reframing
//     this build contributes. The Owner Console's other half — the per-person
//     data browser, shipped 2026-08-03 and also unlogged — is STRICTLY MORE
//     REVEALING about a person than this: it is `select *` over every row that
//     names them, uncurated, where this renders a reviewed allow-list. Logging
//     the narrower tool while the broader one stays silent would be incoherent.
//     So the honest question is not "should the console view-as be logged" but
//     "should superadmin per-person lookups be logged at all" — and BOTH Owner
//     Console tools must get the same answer, in one piece of work, with its own
//     table and its own review. That is a real follow-on, not a deferral.
//
// WHAT MAKES THIS DEFENSIBLE RATHER THAN CONVENIENT: the answer is scoped to a
// single owner-operator superadmin, and the conditions that expire it are named
// now — a second superadmin, an external audit, or (docs/13 answer 1's explicit
// plan) expanding this surface beyond the superadmin. That last one is
// structural, not a promise: `RenderAuthority` is a discriminated union, so
// adding any third authority kind forces whoever adds it back through this
// comment. And the page states its status on screen beside "bypasses declared
// edges", so the operator is never misled about which of the two tools they are
// using. (That badge read "not logged" when this paragraph was written and reads
// "logged" as of 2026-08-07 — the sentence is left because the PRINCIPLE is the
// durable part: whatever the answer is, the page must say it.)
//
// ---------------------------------------------------------------------------
// AMENDED THE SAME DAY (2026-08-06) — the founder's counter-proposal, which
// dissolves ground 2 and makes a log the likely answer. Recorded here because it
// changes the conclusion's STATUS, not this build's behaviour.
// ---------------------------------------------------------------------------
// Founder: "logs should be based on hierarchy — a manager can see logs of
// himself and those below, those below should not see the manager's. So we can
// log superadmin activity but only the superadmin can see them." Plus: reading
// your OWN log is not useless, because looking back to debug something you did
// yourself is a real use.
//
// Both points land. Ground 2 above was the load-bearing one — the objection was
// never "logs are bad" but "logging would publish operator activity into every
// tenant's audit view". A SEPARATE, superadmin-read-only table removes that
// objection completely: the blocker was the audience, and this changes the
// audience. And the self-read use case makes the log valuable on day one rather
// than only to a future auditor, which is what my "defer to pre-launch"
// recommendation had rested on. So the expected outcome flips to LOG IT.
//
// DECIDED (founder, 2026-08-06): THE LOG GETS BUILT. **AND IT WAS, 2026-08-07/08
// — migration 20260807010000.** The sentence that stood here said "this build
// still ships UNLOGGED — its on-screen badge is accurate", which was true for
// exactly one day and is now false on both counts: the tools log, and the badge
// says "logged".
//
// One prediction in it was WRONG and is worth correcting rather than quietly
// dropping, because the next follow-on will be estimated the same way: "purely
// ADDITIVE: nothing in this file changes when it lands." Landing it changed this
// file twice — the "writes nothing" claim above became false and had to be
// re-argued, and this whole section needed a superseded banner. **An additive
// DATABASE change is not an additive DOCUMENTATION change**; a header that
// explains why something is absent is exactly what stops being true when it
// arrives.
//
// GROUND 1 IS CORRECTED, not preserved. It claimed reusing `view_as_sessions`
// would corrode the one guard deliberately built with no org-rank shortcut. That
// was overstated: docs/13 already established the superadmin sits OUTSIDE the
// "org position does not enable view-as" rule, because it is a flag on `profiles`
// rather than a seat in `org_members`, and `is_superadmin()` is strictly narrower
// than the `is_org_admin()` the guard refuses — it would grant nothing to org
// owners or admins. A real objection, but a small one.
//
// A SEPARATE TABLE IS STILL RIGHT, for three better reasons (founder asked
// directly whether one was needed once hierarchy reads make the disclosure
// objection moot — it is, and the disclosure objection IS moot):
//   1. DECISIVE — it is not the same event. The log covers BOTH console tools,
//      and the data browser has no session, no target_role, no target_scope_ref
//      and no expiry. What is recorded is "a superadmin looked up a person, with
//      tool X", not "a view-as session started". Shape is roughly
//      (actor, tool, org, module?, subject?, position?, scope_ref?, at) — not
//      `view_as_sessions` with nullable columns bolted on.
//   2. In `view_as_sessions` a row IS A CAPABILITY, not merely a record: the
//      in-module page resolves the cookie to a row and renders. Mixing
//      non-capability rows in means a superadmin row could be replayed through
//      that path. It cannot exist today — CORRECTED 2026-08-06, review finding
//      7: the earlier version of this line said it "fails closed only because
//      `sessionStillAuthorised()` re-checks", which is an overstatement of the
//      DOWNSTREAM defence and understates the real one. The
//      `view_as_guard_session()` BEFORE INSERT trigger (20260731010000) rejects
//      the row outright — first at `is_org_member(new.org_id)`, which the
//      superadmin fails because `is_org_member` deliberately does NOT
//      short-circuit on `is_superadmin`, and again at the `exists` over
//      `module_roles`, which can never match for someone holding no grants. The
//      app-layer re-check is a second line, not the line. Both conclusions
//      stand; do not repeat the wrong mechanism in the follow-on's migration
//      header. For an audit table "cannot be inserted" beats "is rejected
//      downstream" either way.
//   3. Retrofitting hierarchy reads onto `view_as_sessions` is its own migration:
//      `view_as_sessions_select_org_admin` is whole-org today, narrowing it
//      REMOVES reach tenants currently have, and it hits the wrinkle that parked
//      the question in docs/13 — org admin has no rank in the module ladder.
//
// THE PRINCIPLE, which is the reusable part: hierarchy-governed visibility is not
// an argument for one table, it is a rule that should govern EVERY activity log on
// the platform, applied in two places. New table, hierarchy read rule; and
// separately, whether `view_as_sessions`' own org-admin read should be narrowed
// the same way. Same principle, two migrations, two reviews.
//
// THE MECHANISM THAT FOLLOW-ON SHOULD USE, decided in the same exchange: the
// APPOINTMENT rule (strict rank + scope coverage), NOT view-as's per-pair
// declaration. View-as needs declared pairs because seeing through someone's
// eyes is not implied by outranking them — surfaces are disjoint and some pairs
// are banned to protect third parties. A log row is metadata with no surface and
// no third-party secret, so per-pair entries would be ceremony with no decision
// behind them. "If you can remove someone, you can review what they did" is one
// rule, needs no declarations, derives for every module including those with no
// view-as review — and it brings scope narrowing along for free, which answers
// docs/13's parked org-admin-scope question for the module arm.
//
// AND THE TRAP IN IT: a log row names TWO people. Hierarchy answers who may read
// by ACTOR (oversight). Reading by TARGET — "a manager viewed your account" — is
// §8.1 point 6's notify-the-target question, still deliberately open. One table,
// two features; a single policy must not try to be both.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  surfaceIsPersonFilterable,
  type PositionSurface,
  type ViewAsDeclaration,
  type ViewAsEdge,
} from '@platform/core'
import { grantKey, scopeLabel, type ScopeNode } from '@/lib/view-as'

/**
 * The PERSON axis, and only the person axis.
 *
 * The founder specified three modes (2026-08-03) and the nail-salon review made
 * the third a hard requirement rather than a convenience. Modelling them as one
 * axis is what keeps them honest: scope is an INDEPENDENT picker available in
 * every mode, so the surface is "position + optional person + optional scope"
 * exactly as docs/15's 2026-08-04 entry asked, not "position + person".
 *
 *   1 — as if I held it   : subject = the superadmin. Mostly empty, and that is
 *                           the truthful answer (§8.1 point 8: mode 1 renders
 *                           the caller's own possibly-empty data).
 *   2 — one named person  : subject = a named holder of that position. Only
 *                           offered where the surface can express it.
 *   3 — the whole position: NO subject filter. The mode the salon review needed
 *                           and refused to fake — one named holder's
 *                           LOCATION-scoped console (the Uptown manager's back
 *                           office), which mode 1 cannot give (it renders the
 *                           caller's own scope) and mode 2 cannot give (a
 *                           location-narrowed position has no per-person column).
 */
export type ConsoleMode = 1 | 2 | 3

export type ConsolePosition = {
  position: string
  rank: number
  label: string
  summary: string
  /** A position with no declared surface renders BLANK — a surface is content, not permission. */
  hasSurface: boolean
  /** Whether mode 2 is even expressible here (shared predicate, not a second opinion). */
  personFilterable: boolean
}

/** Every position in the module, highest rank first, with what the console can do to it. */
export function consolePositions(decl: ViewAsDeclaration): ConsolePosition[] {
  return Object.entries(decl.positions)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([position, rank]) => {
      const surface: PositionSurface | undefined = decl.surfaces[position]
      return {
        position,
        rank,
        label: surface?.label ?? position,
        summary: surface?.summary ?? '',
        hasSurface: surface !== undefined,
        personFilterable: surface ? surfaceIsPersonFilterable(surface) : false,
      }
    })
}

/** One holder of a position: a (person, position, scope) GRANT TRIPLE (§8.1 point 4). */
export type PositionHolder = {
  userId: string
  role: string
  scopeRef: string | null
  displayName: string
  scopeLabel: string
  key: string
}

/**
 * Everyone holding `position` in this org and module — the bypass picker.
 *
 * This is `targetsFor()` in lib/view-as.ts with its three conditions removed
 * (declared edge, strict rank, scope coverage), which is the whole of what the
 * bypass means. What it does NOT remove is the requirement that the target
 * actually HOLD the grant: §8.1 point 4 makes a view-as target a (person,
 * position, scope) triple, and rendering "Charlie as a manager" for a Charlie who
 * holds no manager grant would be a fiction, not a bypass. When nobody holds the
 * position the honest answer is mode 3, not a fabricated person.
 */
export async function holdersOf(
  supabase: SupabaseClient,
  orgId: string,
  moduleKey: string,
  position: string,
  nodes: Map<string, ScopeNode>,
): Promise<PositionHolder[]> {
  const { data } = await supabase
    .from('module_roles')
    .select('user_id, role, scope_ref')
    .eq('org_id', orgId)
    .eq('module_key', moduleKey)
    .eq('role', position)
  const rows = (data ?? []) as unknown as { user_id: string; role: string; scope_ref: string | null }[]
  if (rows.length === 0) return []

  // TWO QUERIES, NOT AN EMBED — `module_roles.user_id` references `auth.users`,
  // not `public.profiles`, so PostgREST cannot infer the embed and the whole
  // select would fail, leaving an EMPTY picker that reads as "nobody holds this".
  // Same reason as targetsFor() and subjectsIn().
  const { data: profiles } = await supabase
    .from('profiles')
    .select('user_id, display_name')
    .in('user_id', Array.from(new Set(rows.map((r) => r.user_id))))
  const nameOf = new Map(
    ((profiles ?? []) as unknown as { user_id: string; display_name: string | null }[]).map((p) => [
      p.user_id,
      p.display_name,
    ]),
  )

  return rows
    .map((r) => ({
      userId: r.user_id,
      role: r.role,
      scopeRef: r.scope_ref,
      displayName: nameOf.get(r.user_id) || 'Unnamed member',
      scopeLabel: scopeLabel(nodes, r.scope_ref),
      key: grantKey({ userId: r.user_id, role: r.role, scopeRef: r.scope_ref }),
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.scopeLabel.localeCompare(b.scopeLabel))
}

/**
 * What the console will actually render, or why it will not.
 *
 * The refusals are the interesting half. A god-mode surface that renders
 * something plausible for every request would be worse than one that says "this
 * cannot be answered and here is the mode that can" — under-showing is a
 * usability cost, over-showing is a correctness bug (docs/03 #18).
 */
export type ConsolePlan =
  | { ok: false; refusal: string; hint?: string }
  | {
      ok: true
      /** Rows ABOUT this person, or null for the no-person-filter mode. */
      subjectUserId: string | null
      /** The entity scope to render, or null for the whole module. */
      scopeRef: string | null
      /** Set in mode 2: the grant triple being rendered. */
      holder?: PositionHolder
      /** True when the operator moved off the holder's own grant scope (docs/13 answer 3). */
      scopeOverridden: boolean
    }

export function planConsoleRender(args: {
  decl: ViewAsDeclaration
  position: string
  mode: ConsoleMode
  superadminId: string
  /** The picked holder, already looked up from `holdersOf` (mode 2 only). */
  holder: PositionHolder | null
  /** Whether a person was asked for at all, so "none picked" and "no longer a holder" differ. */
  personWasRequested?: boolean
  /**
   * The scope select's value: a node id, `'all'` for the whole module, or null
   * when the operator has not chosen — in which case mode 2 inherits the
   * holder's own grant scope, honouring the grant triple by default while
   * still allowing a move between scopes.
   */
  scopeChoice: string | null
  nodes: Map<string, ScopeNode>
}): ConsolePlan {
  const { decl, position, mode, superadminId, holder, scopeChoice, nodes, personWasRequested } = args

  if (!(position in decl.positions)) {
    return { ok: false, refusal: `“${position}” is not a position in this module.` }
  }
  const surface = decl.surfaces[position]
  if (!surface) {
    // Code fact, not a limitation to hide: the bypass can only render a position
    // that has a declared SURFACE, because a surface is the content definition
    // and not a permission. Five positions have one today.
    return {
      ok: false,
      refusal: `“${position}” has no declared data surface, so there is nothing for this tool to render — a surface is the content definition, not a permission, and bypassing the edge does not conjure one.`,
      hint: 'Writing that surface is a §8.1 point 9 security review for the module, not a change to this page.',
    }
  }

  // Scope resolves the same way in every mode. `'all'` is explicit rather than
  // implied by an empty string so that "whole module" is a choice on the record.
  let scopeRef: string | null = null
  let scopeOverridden = false
  if (scopeChoice && scopeChoice !== 'all') {
    if (!nodes.has(scopeChoice)) {
      return { ok: false, refusal: 'That scope no longer exists in this module.' }
    }
    scopeRef = scopeChoice
  }

  if (mode === 1) {
    return { ok: true, subjectUserId: superadminId, scopeRef, scopeOverridden: false }
  }

  if (mode === 3) {
    return { ok: true, subjectUserId: null, scopeRef, scopeOverridden: false }
  }

  // Mode 2. The same refusal `viewAsCompleteness()` makes about a declared
  // mode-2 edge, made here for an undeclared one — because the reason is a
  // property of the SURFACE, not of the edge, so bypassing the edge does not
  // touch it. Filtering an authorship stamp would UNDER-show the tab; rendering
  // unfiltered would be mode 3 wearing mode 2's label.
  if (!surfaceIsPersonFilterable(surface)) {
    return {
      ok: false,
      refusal: `Nothing on the ${surface.label.toLowerCase()} surface is about a person, so “what does one named holder see?” has no answer to give — this position's reach is a function of WHAT SCOPE it covers, not WHO holds it.`,
      hint: 'Use “the whole position surface” with a scope instead. That is the mode this case exists for.',
    }
  }
  if (!holder) {
    // Two different situations, said apart. "You picked someone who no longer
    // holds this" reads as a bug when reported as "pick someone", and a revoked
    // grant is exactly the kind of thing an operator opens this tool to find.
    return {
      ok: false,
      refusal: personWasRequested
        ? 'That person does not hold this position in this org and module — the grant may have been removed since the link was made.'
        : 'Pick which holder of this position to render.',
      hint: 'A view-as target is a (person, position, scope) grant, never a bare person (§8.1 point 4). If nobody holds it, use “the whole position surface”.',
    }
  }

  // No explicit scope choice: inherit the grant's own, which is what makes this
  // the HOLDER's view rather than the position's. An explicit choice overrides
  // it and is labelled, since the render is then no longer that grant's scope.
  if (!scopeChoice) {
    scopeRef = holder.scopeRef
  } else {
    // Any explicit choice that is not the grant's own scope is an override —
    // including one INSIDE it (a chain admin narrowing a global manager to one
    // store) and one OUTSIDE it (a scope the grant does not cover at all).
    // Moving outside is deliberately allowed, because debuggability is the
    // founder's stated primary requirement for this pair of tools; it simply
    // stops being "what they see", which is what the label exists to say. Both
    // directions are the same flag: a `scopeCovers` test here would only ever
    // re-set a flag the inequality has already set.
    scopeOverridden = scopeRef !== holder.scopeRef
  }

  return { ok: true, subjectUserId: holder.userId, scopeRef, holder, scopeOverridden }
}

// ---------------------------------------------------------------------------
// The declarations reference (docs/13: "read-only view of positions, ranks, the
// pair grid + notes, and each position's declared surface — highest-value
// follow-on. Build this first.")
//
// Folded in here rather than given its own page because this is exactly where it
// is useful: the operator is picking a position to bypass an edge into, and the
// grid is what tells them which rule they are stepping over and why it was
// written that way. Zero queries — it is all manifest data.
// ---------------------------------------------------------------------------

export type DeclaredPair = {
  from: string
  fromRank: number
  to: string
  toRank: number
  mode1: boolean
  mode2: boolean
  note: string
}

/** Every declared rank-differential pair, highest viewer rank first. */
export function declaredPairs(decl: ViewAsDeclaration): DeclaredPair[] {
  const rows: DeclaredPair[] = []
  for (const [from, targets] of Object.entries(decl.edges)) {
    for (const [to, edge] of Object.entries(targets as Record<string, ViewAsEdge>)) {
      rows.push({
        from,
        fromRank: decl.positions[from] ?? -1,
        to,
        toRank: decl.positions[to] ?? -1,
        mode1: edge.mode1,
        mode2: edge.mode2,
        note: edge.note,
      })
    }
  }
  return rows.sort(
    (a, b) => b.fromRank - a.fromRank || a.from.localeCompare(b.from) || b.toRank - a.toRank || a.to.localeCompare(b.to),
  )
}
