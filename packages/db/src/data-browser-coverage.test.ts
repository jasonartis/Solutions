// The data browser's REAL completeness check (docs/13, docs/03 #19).
//
// The view-as completeness check could be a TypeScript mapped type because its
// authority — a module's position vocabulary — is itself written in TypeScript.
// This feature's authority is the DATABASE SCHEMA: "which columns name a
// person" is a fact about the catalog, and no type can know it. So the check
// reads `pg_catalog` and fails when a person-referencing column exists that no
// declaration in `packages/platform/src/data-browser-modules.ts` accounts for.
//
// The consequence is the one that matters: a migration adding a column that
// references a user breaks `pnpm test` until somebody decides whether the
// browser should surface it, omit it, or mark it unreadable. Without this, the
// browser would quietly answer "what do you hold about me?" with a stale
// subset — a wrong answer that looks exactly like a right one.
//
// TWO TIERS, deliberately, because they carry different confidence:
//
//   Tier 1 (FAILS) — every column with a real FK to `auth.users` / `profiles`.
//     Machine-decidable, so a gap here is unambiguous.
//
//   Tier 2 (REPORTS) — every FK pointing at a table that itself carries a
//     person column: the INDIRECT links (`sd_interest` names participants, and
//     a participant names a user). These tables carry no person column at all,
//     so tier 1 cannot see them, and they hold some of the most privacy-loaded
//     rows on the platform. It only reports because the join is a judgement
//     call — `cls_review_comments.submission_id` genuinely reaches a person,
//     `sal_bill_items.bill_id` technically does too and means nothing. Failing
//     on it would force dozens of noise entries and train people to silence it.
//
// Note the structural limit, same as every local-only check (CLAUDE.md): this
// reads the LOCAL database. That is sound here in a way it is not for ACLs —
// the catalog is entirely migration-driven, so local and prod schemas agree by
// construction, whereas prod's `ALTER DEFAULT PRIVILEGES` makes GRANTS diverge.
import { describe, expect, it } from 'vitest'
import postgres from 'postgres'
import {
  dataBrowserCompleteness,
  dataBrowserCoverage,
  dataBrowserViaLinks,
  dataBrowserViaTargets,
  dataBrowserDeclarations,
  platformDataBrowser,
  type DataBrowserDeclaration,
  type PersonVia,
} from '@platform/core'

const dbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

/**
 * Every declaration in one place. Deliberately NOT `moduleRegistry`, which the
 * MODULES env var filters for white-label builds — the database still holds
 * every module's tables, so a filtered registry would silently shrink the check
 * to whatever that deployment happens to include.
 */
const allDeclarations: [string, DataBrowserDeclaration][] = [
  ['platform', platformDataBrowser],
  ...Object.entries(dataBrowserDeclarations),
]

/** Union of what every declaration accounts for, as `table.column`. */
function declaredCoverage(): Set<string> {
  const all = new Set<string>()
  for (const [, decl] of allDeclarations) {
    for (const c of dataBrowserCoverage(decl)) all.add(c)
  }
  return all
}

function declaredViaLinks(): Set<string> {
  const all = new Set<string>()
  for (const [, decl] of allDeclarations) {
    for (const l of dataBrowserViaLinks(decl)) all.add(l)
  }
  return all
}

type CatalogColumn = { table_name: string; column_name: string; refs: string }

describe('data browser: every person-referencing column is declared (docs/03 #19)', () => {
  it('declares nothing malformed', () => {
    const problems = allDeclarations.flatMap(([scope, decl]) => dataBrowserCompleteness(scope, decl))
    expect(problems, JSON.stringify(problems, null, 2)).toEqual([])
  })

  it('TIER 1: every FK column referencing auth.users / profiles is accounted for', async () => {
    const sql = postgres(dbUrl, { prepare: false, max: 1 })
    try {
      // pg_catalog, not information_schema: `constraint_column_usage` does not
      // expose constraints whose referenced table lives in the `auth` schema,
      // so the information_schema version of this query silently returns ZERO
      // rows and the check passes vacuously. Found the hard way while writing
      // this — worth the comment, because the wrong query looks right.
      const rows = (await sql`
        select t.relname   as table_name,
               a.attname   as column_name,
               rn.nspname || '.' || rt.relname as refs
        from pg_constraint c
        join pg_class t         on t.oid = c.conrelid
        join pg_namespace tn    on tn.oid = t.relnamespace
        join pg_class rt        on rt.oid = c.confrelid
        join pg_namespace rn    on rn.oid = rt.relnamespace
        cross join lateral unnest(c.conkey) as k(attnum)
        join pg_attribute a     on a.attrelid = t.oid and a.attnum = k.attnum
        where c.contype = 'f'
          and tn.nspname = 'public'
          and (   (rn.nspname = 'auth'   and rt.relname = 'users')
               or (rn.nspname = 'public' and rt.relname = 'profiles'))
        order by 1, 2
      `) as unknown as CatalogColumn[]

      // A control: if this query ever returns nothing the assertion below would
      // pass while checking nothing at all — the vacuous-probe failure mode
      // docs/03 #18 calls out. The platform has dozens of these columns.
      expect(rows.length, 'catalog query found no person columns — the check would be vacuous')
        .toBeGreaterThan(40)

      const covered = declaredCoverage()
      const undeclared = rows
        .map((r) => `${r.table_name}.${r.column_name}`)
        .filter((key) => !covered.has(key))

      expect(
        undeclared,
        `These columns reference a person but no data-browser declaration accounts for them.\n` +
          `Add each to a lookup's personColumns, or to omitted / neverReadable with a reason,\n` +
          `in packages/platform/src/data-browser-modules.ts:\n  ${undeclared.join('\n  ')}`,
      ).toEqual([])
    } finally {
      await sql.end()
    }
  })

  it('declares no column the database does not have', async () => {
    // The other direction: a declaration naming a dropped or misspelled column
    // would silently never match, making a section permanently empty and
    // looking exactly like "we hold nothing about this person".
    const sql = postgres(dbUrl, { prepare: false, max: 1 })
    try {
      const rows = (await sql`
        select c.relname as table_name, a.attname as column_name
        from pg_class c
        join pg_namespace n     on n.oid = c.relnamespace
        join pg_attribute a     on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        where n.nspname = 'public' and c.relkind = 'r'
      `) as unknown as { table_name: string; column_name: string }[]

      const real = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`))
      const realTables = new Set(rows.map((r) => r.table_name))
      const missing: string[] = []

      for (const [scope, decl] of allDeclarations) {
        for (const l of decl.lookups) {
          if (!realTables.has(l.table)) {
            missing.push(`${scope}: table ${l.table} does not exist`)
            continue
          }
          for (const col of [
            ...l.personColumns,
            ...(l.orderBy ? [l.orderBy.column] : []),
            ...(l.orgColumn ? [l.orgColumn] : []),
            ...(l.via ?? []).map((v) => v.column),
          ]) {
            if (!real.has(`${l.table}.${col}`)) missing.push(`${scope}: ${l.table}.${col} does not exist`)
          }
          // Recursive: a chained hop's columns are just as capable of being
          // wrong, and a wrong deep hop fails exactly as silently as a wrong
          // shallow one.
          const checkVia = (v: PersonVia) => {
            if (!realTables.has(v.lookupTable)) {
              missing.push(`${scope}: via lookup table ${v.lookupTable} does not exist`)
              return
            }
            for (const col of [v.lookupIdColumn, ...v.lookupPersonColumns]) {
              if (!real.has(`${v.lookupTable}.${col}`)) {
                missing.push(`${scope}: ${v.lookupTable}.${col} does not exist`)
              }
            }
            if (v.then) {
              if (!real.has(`${v.lookupTable}.${v.then.column}`)) {
                missing.push(`${scope}: ${v.lookupTable}.${v.then.column} does not exist`)
              }
              checkVia(v.then)
            }
          }
          for (const v of l.via ?? []) checkVia(v)
        }
        for (const t of [...decl.omitted, ...decl.neverReadable]) {
          if (!realTables.has(t.table)) missing.push(`${scope}: table ${t.table} does not exist`)
        }
      }

      expect(missing, missing.join('\n')).toEqual([])
    } finally {
      await sql.end()
    }
  })

  it('TIER 2: reports indirect person links so a new one gets triaged, never silently missed', async () => {
    const sql = postgres(dbUrl, { prepare: false, max: 1 })
    try {
      // Every FK whose TARGET table carries a person column. These reach a
      // person one hop away; the referencing table itself may name nobody.
      //
      // SELF-REFERENCES ARE INCLUDED, and must be. The first draft excluded
      // them as parent_id-style noise, and this test immediately failed on
      // `sd_participants.mentee_participant_id` — a self-referential FK that is
      // a genuine person link (it names another participant, who names a user).
      // Excluding self-references would have made exactly that kind of link
      // invisible to the triage list.
      const rows = (await sql`
        with person_tables as (
          select distinct t.relname as table_name
          from pg_constraint c
          join pg_class t      on t.oid = c.conrelid
          join pg_namespace tn on tn.oid = t.relnamespace
          join pg_class rt     on rt.oid = c.confrelid
          join pg_namespace rn on rn.oid = rt.relnamespace
          where c.contype = 'f' and tn.nspname = 'public'
            and (   (rn.nspname = 'auth'   and rt.relname = 'users')
                 or (rn.nspname = 'public' and rt.relname = 'profiles'))
        )
        select t.relname as table_name, a.attname as column_name, rt.relname as refs
        from pg_constraint c
        join pg_class t      on t.oid = c.conrelid
        join pg_namespace tn on tn.oid = t.relnamespace
        join pg_class rt     on rt.oid = c.confrelid
        join pg_namespace rn on rn.oid = rt.relnamespace
        cross join lateral unnest(c.conkey) as k(attnum)
        join pg_attribute a  on a.attrelid = t.oid and a.attnum = k.attnum
        where c.contype = 'f' and tn.nspname = 'public' and rn.nspname = 'public'
          and rt.relname in (select table_name from person_tables)
        order by 1, 2
      `) as unknown as CatalogColumn[]

      const declared = declaredViaLinks()
      const untriaged = rows
        .map((r) => ({ key: `${r.table_name}.${r.column_name}`, refs: r.refs }))
        .filter((r) => !declared.has(r.key))

      // Reported, not failed — see the header. Kept visible so the list is a
      // standing triage prompt rather than an invisible gap.
      if (untriaged.length > 0) {
        console.log(
          `\n[data browser] ${untriaged.length} indirect person link(s) not declared as \`via\`.\n` +
            `Each reaches a person one hop away. Most are meaningless (a bill item reaches a\n` +
            `person through its bill); declare the ones that are not:\n` +
            untriaged.map((r) => `  ${r.key} -> ${r.refs}`).join('\n') +
            '\n',
        )
      }
      // The declared ones must still be real links, or a `via` is pointing at
      // a relationship the schema does not have.
      const realLinks = new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, r.refs]))
      const phantom = [...declared].filter((k) => !realLinks.has(k))
      expect(phantom, `declared via links with no matching FK: ${phantom.join(', ')}`).toEqual([])

      // AND it must point where the declaration SAYS it points. Checking only
      // that the column is "some FK to some person-bearing table" leaves a real
      // hole: `sal_bills` and `sal_customers` both have an `id`, so a hop with
      // the wrong lookupTable passes every other check and then returns zero
      // rows forever — indistinguishable from "we hold nothing about this
      // person", which is the one answer this feature must never give falsely.
      const wrongTarget: string[] = []
      for (const [, decl] of allDeclarations) {
        for (const [link, declaredTarget] of dataBrowserViaTargets(decl)) {
          const actual = realLinks.get(link)
          if (actual && actual !== declaredTarget) {
            wrongTarget.push(`${link} declares -> ${declaredTarget} but the FK points -> ${actual}`)
          }
        }
      }
      expect(wrongTarget, wrongTarget.join('\n')).toEqual([])
    } finally {
      await sql.end()
    }
  })
})
