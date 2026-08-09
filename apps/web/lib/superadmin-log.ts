// THE SUPERADMIN LOOKUP LOG — the app half (docs/15 2026-08-06/07 decision 5,
// docs/12 checklist item 9). Database half: supabase/migrations/20260807010000.
//
// WHAT THIS IS FOR: both Owner Console tools record, here, every time the
// platform operator looks at a person or a position. The founder's decision
// (2026-08-06) settled a tension the view-as build had deliberately left open:
// §8.1 point 6 makes a view-as session log a security requirement from v1, and
// the Owner Console surfaces are strictly MORE powerful than the logged
// in-module one. What had blocked it was the AUDIENCE — logging into
// `view_as_sessions` would publish operator activity into every tenant's audit
// view — and a separate, superadmin-read-only table changes the audience, which
// is what dissolved the objection.
//
// BOTH TOOLS, DELIBERATELY. Logging only `/console/view-as` while the
// `select *` per-person data browser stayed silent is the incoherent option:
// the data browser is the strictly more revealing of the two.
//
// ---------------------------------------------------------------------------
// THE INVARIANT THIS FILE MUST NOT BREAK.
// ---------------------------------------------------------------------------
// Every Owner Console query runs on the CALLER'S OWN RLS-enforced client, which
// is what makes the console's UI gate sound rather than a security boundary
// (docs/03 #19): bypassing `requireSuperadmin()` grants nothing, because every
// query is one the caller could already issue against PostgREST directly. That
// property holds only while NO code on the console path calls `.rpc()` or a
// service-role client — and this file is now on that path, so it is in the
// source scan (`scripts/verify-console-view-as.mts` and, because CI does not
// run `scripts/*.mts`, `packages/db/src/rls.test.ts`).
//
// So: this is a PLAIN TABLE INSERT on the caller's client. Not a definer, not a
// service-role write. The log's integrity does not depend on that choice — the
// guard trigger server-stamps the actor and refuses non-superadmins — but the
// console's whole safety argument does.
//
// ---------------------------------------------------------------------------
// A CLAIM THIS BUILD FALSIFIED, corrected rather than quietly deleted.
// ---------------------------------------------------------------------------
// `lib/console-view-as.ts`'s header said the console view-as "writes nothing",
// and used that to explain why docs/03 #18's "the app layer is not a gate" rule
// did not bite there. That sentence is now FALSE: this surface writes exactly
// one row per render. The rule still does not bite, but for a DIFFERENT reason
// that has to be stated rather than inherited — the write is an append-only
// audit row about the caller themselves, server-stamped, and nothing downstream
// reads it back as a capability. Contrast `view_as_sessions`, where a row IS a
// capability (the in-module page resolves a cookie to a row and renders from
// it), which is exactly why that table's write needed a guard trigger enforcing
// rank, scope and a declared edge. Nothing here is replayable as authority.
//
// ---------------------------------------------------------------------------
// WHY A FAILED LOG WRITE DOES NOT BLOCK THE RENDER — a real tradeoff, taken
// deliberately, and the one thing in this file most worth re-examining.
// ---------------------------------------------------------------------------
// The strongest audit posture is "refuse to show data that could not be
// logged". It is rejected here because it turns a log-table hiccup into a total
// console outage, and debuggability is the founder's stated primary requirement
// for this pair of tools — the console is what you open WHEN something is
// already wrong.
//
// What is NOT acceptable is a silent failure, which would leave the operator
// believing an unlogged lookup was logged. So the failure is returned, never
// swallowed, and both pages BADGE it on screen. That is docs/03 #19's rule — a
// lookup that failed must render as "we could not check", never as a confident
// blank — applied to logging rather than to reading.
//
// Note the asymmetry that makes this safe: this function never throws, so it
// cannot take the console down; and it never silently succeeds, so it cannot
// mislead. If the posture should ever flip to fail-closed, flip it here and in
// the two call sites' badge blocks, not in the database.
//
// OVER-LOGGING IS SAFE, UNDER-LOGGING IS NOT. If a render ever executes twice
// (a retry, a framework re-render), this writes two rows. That is the correct
// direction to err for an audit log and needs no de-duplication.
import type { SupabaseClient } from '@supabase/supabase-js'

/** Which Owner Console tool performed the lookup. Mirrors the table's CHECK. */
export type LookupTool = 'view-as' | 'data-browser'

export type SuperadminLookupEntry = {
  tool: LookupTool
  orgId: string
  /**
   * The module whose surface was rendered. NULL for the data browser, which
   * spans every module the org is entitled to in a single lookup and so has no
   * single key — `'all'` would be a lie about a module that does not exist.
   */
  moduleKey?: string | null
  /**
   * Who the lookup was ABOUT. Null in view-as mode 3 ("the whole position
   * surface"), which deliberately applies no person filter.
   *
   * The view-as MODE is derivable from this and needs no column of its own:
   * null → mode 3; equal to the actor → mode 1; anyone else → mode 2.
   */
  subjectUserId?: string | null
  /** The position whose surface was rendered (view-as only). */
  position?: string | null
  /** The scope the render was narrowed to, or null for the whole module. */
  scopeRef?: string | null
}

export type LogOutcome = { logged: true } | { logged: false; error: string }

/**
 * Record one Owner Console lookup. Never throws — see the header.
 *
 * `actor_user_id` and `created_at` are deliberately NOT passed: the guard
 * trigger server-stamps both from `auth.uid()` and `now()`, discarding anything
 * the client sends. Sending them from here would imply the client's value
 * mattered, and the next reader would reasonably assume a forged actor was
 * possible.
 */
export async function logSuperadminLookup(
  supabase: SupabaseClient,
  entry: SuperadminLookupEntry,
): Promise<LogOutcome> {
  const { error } = await supabase.from('superadmin_lookup_log').insert({
    tool: entry.tool,
    org_id: entry.orgId,
    module_key: entry.moduleKey ?? null,
    subject_user_id: entry.subjectUserId ?? null,
    position: entry.position ?? null,
    scope_ref: entry.scopeRef ?? null,
  })
  if (error) return { logged: false, error: error.message }
  return { logged: true }
}
