// Pure helpers for the org-delete flow (migration 20260928010000).
//
// These live outside `console/actions.ts` because that file is `'use server'`,
// where every export must be an async server action — a synchronous helper
// exported from it fails the build.

export type OrgDeleteImpactRow = {
  table_name: string
  column_name: string
  row_count: number
  /** The DECLARED referential action: CASCADE rows are destroyed, SET NULL rows survive unlinked. */
  on_delete: string
}

// SETUP IS NOT CONTENT. A brand-new org legitimately has rows in these three
// the moment you configure it, so blocking on them would make the delete
// useless for the exact case it exists for — undoing an onboarding mistake.
// Anything else with rows is a real person's real data.
const SETUP_TABLES = new Set(['org_members', 'org_modules', 'module_roles'])

/** Rows that BLOCK deletion: actually destroyed (not merely unlinked), and not setup. */
export function blockingRows(impact: OrgDeleteImpactRow[]): OrgDeleteImpactRow[] {
  return impact.filter((r) => r.on_delete === 'CASCADE' && !SETUP_TABLES.has(r.table_name))
}

/** Rows that survive the delete with their org_id nulled, rather than being destroyed. */
export function unlinkedRows(impact: OrgDeleteImpactRow[]): OrgDeleteImpactRow[] {
  return impact.filter((r) => r.on_delete !== 'CASCADE')
}
