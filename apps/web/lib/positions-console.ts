import type { SupabaseClient } from '@supabase/supabase-js'
import { moduleRegistry } from '@platform/core'

// Data for the Owner Console's "Positions and authority" screen.
//
// THE POINT OF THIS FILE IS THAT NOTHING IN IT IS HARDCODED. Every rank is read
// from SQL's module_position_rank() at request time, one call per (module,
// role), so the page reflects the LADDER THE DATABASE IS ACTUALLY ENFORCING.
// Change a rank in a migration and this screen changes with it, with no edit
// here — which is the whole reason it exists rather than a static doc.
//
// The one thing it deliberately does NOT trust is the TypeScript rank table in
// packages/platform/src/view-as-modules.ts. That table must mirror SQL, and a
// test asserts it does — but a page that read TS would be unable to SHOW a
// drift, since it would be reporting one of the two things it is comparing. So
// both are read and disagreements are surfaced (see `tsRank` / `drifts`).

/** The generic words every module's ladder falls back to. Not module-specific. */
export const GENERIC_LADDER = ['director', 'coordinator', 'lead', 'position'] as const

export type PositionRow = {
  role: string
  /** Live, from SQL. The authority. */
  rank: number
  /** What the TypeScript declaration claims. `null` when it declares nothing. */
  tsRank: number | null
  /** Live count of grants of this exact (module, role), across every org. */
  grants: number
  /** How many of those are pinned to a scope node rather than global. */
  scopedGrants: number
  /** True when this role is NOT in the module's declared vocabulary. */
  undeclared: boolean
}

export type ModulePositions = {
  key: string
  name: string
  positions: PositionRow[]
  /** Scope nodes existing for this module — the entity tree, if it has one. */
  scopeNodes: number
}

export type PositionsSnapshot = {
  modules: ModulePositions[]
  generic: { role: string; rank: number }[]
  /** (module, role) pairs where SQL and TypeScript disagree. Should be empty. */
  drifts: { moduleKey: string; role: string; sqlRank: number; tsRank: number }[]
  readAt: string
}

async function rankOf(supabase: SupabaseClient, moduleKey: string, role: string): Promise<number> {
  const { data, error } = await supabase.rpc('module_position_rank', { module_key: moduleKey, role })
  // A failed read must not silently render as rank 0 — that is the vacuity trap
  // docs/03 warns about, and here it would quietly claim "this position controls
  // nobody". -1 is impossible for the real function, so it shows up as a gap.
  if (error) return -1
  return (data as number | null) ?? -1
}

export async function getPositionsSnapshot(supabase: SupabaseClient): Promise<PositionsSnapshot> {
  // Every grant on the platform. The superadmin's own RLS admits this
  // (module_roles_select_member carries an is_superadmin() arm); no definer and
  // no service-role key, same as every other console screen.
  const { data: grantRows } = await supabase.from('module_roles').select('module_key, role, scope_ref')
  const grants = (grantRows ?? []) as { module_key: string; role: string; scope_ref: string | null }[]

  const { data: nodeRows } = await supabase.from('module_scope_nodes').select('module_key')
  const nodes = (nodeRows ?? []) as { module_key: string }[]

  const modules: ModulePositions[] = []
  const drifts: PositionsSnapshot['drifts'] = []

  for (const mod of moduleRegistry) {
    // The declared vocabulary, PLUS any role string actually granted that the
    // manifest does not list. module_roles.role is free text with no CHECK
    // constraint, so a typo or a hand-written grant really can create a
    // position nobody declared — and it would be invisible on a page that
    // rendered the manifest alone.
    const declared = [...mod.roles]
    const granted = [...new Set(grants.filter((g) => g.module_key === mod.key).map((g) => g.role))]
    const allRoles = [...new Set([...declared, ...granted])].sort()

    const positions = await Promise.all(
      allRoles.map(async (role): Promise<PositionRow> => {
        const rank = await rankOf(supabase, mod.key, role)
        const mine = grants.filter((g) => g.module_key === mod.key && g.role === role)
        const tsRankRaw = (mod.viewAs?.positions as Record<string, number> | undefined)?.[role]
        const tsRank = typeof tsRankRaw === 'number' ? tsRankRaw : null
        if (tsRank !== null && rank >= 0 && tsRank !== rank) {
          drifts.push({ moduleKey: mod.key, role, sqlRank: rank, tsRank })
        }
        return {
          role,
          rank,
          tsRank,
          grants: mine.length,
          scopedGrants: mine.filter((g) => g.scope_ref !== null).length,
          undeclared: !declared.includes(role),
        }
      }),
    )

    positions.sort((a, b) => b.rank - a.rank || a.role.localeCompare(b.role))
    modules.push({
      key: mod.key,
      name: mod.name,
      positions,
      scopeNodes: nodes.filter((n) => n.module_key === mod.key).length,
    })
  }

  // The generic fallback words, read once. They resolve identically in every
  // module (the fallback is module-blind), so showing them per module would be
  // eight copies of one fact — but they ARE grantable, so they are not fiction.
  const generic = await Promise.all(
    GENERIC_LADDER.map(async (role) => ({ role, rank: await rankOf(supabase, moduleRegistry[0]!.key, role) })),
  )

  return { modules, generic, drifts, readAt: new Date().toISOString() }
}

export type ManageVerdict = { ok: boolean; why: string }

/**
 * Can a holder of `a` create, change or remove a seat of `b`?
 *
 * MIRRORS TWO REAL GATES, IN ORDER, and both are required:
 *   1. An RLS WRITE POLICY must admit the statement at all. All three of
 *      module_roles_{insert,update,delete}_module_manager require
 *      module_has_manager_grant(), i.e. rank >= 2. Nothing else admits a
 *      non-admin. So a rank-1 holder is refused before any ladder arithmetic
 *      happens — which is why `matchmaker` (1) cannot touch `single` (0) even
 *      though 1 > 0.
 *   2. module_caller_can_manage_seat() must then allow the specific seat:
 *      strictly outrank it with covering scope, OR the same role at rank 3 into
 *      a STRICTLY narrower scope (the coordinator-chain rule).
 *
 * Deliberately NOT modelled here: org owners/admins, superadmins and the service
 * role, which bypass the ladder entirely (module_roles_guard_hierarchy step 2).
 * The page states that separately rather than smearing it through every cell.
 */
export function canManage(a: PositionRow, b: PositionRow, moduleScopeNodes: number): ManageVerdict {
  if (a.rank < 0 || b.rank < 0) return { ok: false, why: 'rank unavailable' }
  if (a.rank < 2) return { ok: false, why: 'no write policy admits rank < 2' }
  if (a.rank > b.rank) return { ok: true, why: 'outranks, within covering scope' }
  if (a.role === b.role && a.rank === 3) {
    return moduleScopeNodes > 0
      ? { ok: true, why: 'same role at rank 3, only into a strictly narrower scope' }
      : { ok: false, why: 'same-role rule needs a narrower scope; this module has no scope nodes' }
  }
  return { ok: false, why: 'does not outrank' }
}
