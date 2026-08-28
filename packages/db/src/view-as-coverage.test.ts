// View-as SURFACE coverage — closes the gap named in CLAUDE.md's
// "machine-enforce every module table is classified on every surface" item
// and in the block comment above `nailSalonViewAs` in view-as-modules.ts.
//
// `viewAsCompleteness()` (packages/platform/src/view-as.ts) checks a
// declaration's INTERNAL consistency — every rank-differential pair has an
// on/off entry, no table is claimed by two lists, a mode-2 target has a
// per-person column. It never asks whether a module's REAL tables (the
// database, not the declaration) are all accounted for on each surface, and
// it never looks inside `embed`. So a future migration (`sal_tips`, say)
// could ship, pass CI green, and leave every salon surface silently
// incomplete — §8.1 point 9's "unclassified defaults to personal" failing
// open exactly the way the salon block comment warns.
//
// BASELINE-AND-RATCHET, not a backfill (CLAUDE.md's own recommended shape,
// with precedent in data-browser-coverage.test.ts's tier-2 backlog report):
// classroom predates the salon review's table-by-table rigor and is
// genuinely incomplete today. Measured against the real migration
// (20260708010000_classroom.sql) on 2026-08-28: GA classifies 9 of 16 real
// `cls_` tables, Student 13 of 16 (counting tables reachable only through an
// `embed`). Rather than block this check on a classroom re-review, today's
// real gaps are frozen in KNOWN_GAPS below — the test fails only on anything
// NEW. Nail-salon has zero gaps under this same check, which is the control
// that proves the check isn't vacuous for a fully-classified module.
import { describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { moduleRegistry, type PositionSurface } from '@platform/core'

const dbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

/**
 * Classroom's accepted backlog, frozen 2026-08-28. Each is a real
 * `cls_` table not yet classified as role/personal/excluded/
 * unreadableByPosition against the position's actual RLS policy on that
 * surface. Shrink this list (never grow it) as classroom's own review
 * answers each one — an empty list for a module means it is fully
 * classified, the same bar nail-salon already clears.
 */
const KNOWN_GAPS: Record<string, Record<string, string[]>> = {
  classroom: {
    ga: [
      'cls_courses',
      'cls_materials',
      'cls_publications',
      'cls_submission_files',
      'cls_exams',
      'cls_surveys',
      'cls_exam_papers',
    ],
    student: ['cls_submission_files', 'cls_exams', 'cls_surveys'],
  },
}

/** Every table name a surface claims to account for — the three off-lists, plus embeds. */
function coveredTables(surface: PositionSurface): Set<string> {
  const covered = new Set<string>()
  for (const t of surface.role) {
    covered.add(t.table)
    for (const e of t.embed ?? []) covered.add(e.table)
  }
  for (const t of surface.personal) covered.add(t.table)
  for (const t of surface.excluded) covered.add(t.table)
  for (const t of surface.unreadableByPosition ?? []) covered.add(t.table)
  return covered
}

/**
 * The module's own table prefix, read off its declaration rather than
 * hand-maintained in a second map that could drift — every table any surface
 * names must share exactly one.
 */
function modulePrefix(moduleKey: string, surfaces: Record<string, PositionSurface>): string | null {
  const names = new Set<string>()
  for (const surface of Object.values(surfaces)) {
    for (const t of coveredTables(surface)) names.add(t)
  }
  if (names.size === 0) return null
  const prefixes = new Set([...names].map((n) => n.slice(0, n.indexOf('_') + 1)))
  if (prefixes.size !== 1) {
    throw new Error(`${moduleKey}: declared tables span more than one prefix: ${[...names].join(', ')}`)
  }
  return [...prefixes][0]!
}

describe('view-as: every module table is classified on every rendered surface (CLAUDE.md ratchet)', () => {
  it('has no NEW unclassified table beyond the frozen baseline', async () => {
    const sql = postgres(dbUrl, { prepare: false, max: 1 })
    try {
      const modulesWithSurfaces = moduleRegistry.filter((m) => Object.keys(m.viewAs.surfaces).length > 0)
      // Vacuity control: today classroom and nail-salon both declare
      // surfaces. If that ever drops to zero the checks below would pass by
      // having nothing to check, which must not read as "fully covered".
      expect(modulesWithSurfaces.length, 'no module declares a view-as surface — this check would be vacuous')
        .toBeGreaterThan(0)

      const newGaps: string[] = []
      const stale: string[] = []

      for (const mod of modulesWithSurfaces) {
        const prefix = modulePrefix(mod.key, mod.viewAs.surfaces)
        if (!prefix) continue

        const rows = (await sql`
          select c.relname as table_name
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and c.relname like ${prefix + '%'}
        `) as unknown as { table_name: string }[]
        const realTables = rows.map((r) => r.table_name)
        // A second vacuity control, per module: a prefix that matches nothing
        // means the query (or the prefix derivation) is broken, not that the
        // module has no tables.
        expect(realTables.length, `${mod.key}: prefix "${prefix}" matched no real tables in pg_catalog`)
          .toBeGreaterThan(0)

        for (const [position, surface] of Object.entries(mod.viewAs.surfaces)) {
          const covered = coveredTables(surface)
          const accepted = new Set(KNOWN_GAPS[mod.key]?.[position] ?? [])
          const missing = realTables.filter((t) => !covered.has(t))

          for (const t of missing) {
            if (!accepted.has(t)) newGaps.push(`${mod.key}.${position}: ${t}`)
          }
          for (const t of accepted) {
            if (!missing.includes(t)) {
              stale.push(`${mod.key}.${position}: ${t} (no longer missing — remove it from KNOWN_GAPS)`)
            }
          }
        }
      }

      expect(
        newGaps,
        'New unclassified table(s) found. Add each to role/personal/excluded/unreadableByPosition in ' +
          'packages/platform/src/view-as-modules.ts, or — if it is a deliberate, not-yet-reviewed gap — ' +
          `freeze it in KNOWN_GAPS above with a reason:\n  ${newGaps.join('\n  ')}`,
      ).toEqual([])
      expect(
        stale,
        `KNOWN_GAPS is stale — these entries are no longer actually missing, prune them:\n  ${stale.join('\n  ')}`,
      ).toEqual([])
    } finally {
      await sql.end()
    }
  })
})
