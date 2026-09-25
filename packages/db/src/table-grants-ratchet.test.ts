import { describe, expect, it } from 'vitest'
import postgres from 'postgres'

// ---------------------------------------------------------------------------
// THE FORGOTTEN-REVOKE RATCHET (docs/15's 2026-07-29 deferred item 2).
//
// WHY THIS EXISTS. `ALTER DEFAULT PRIVILEGES` is set on BOTH environments for
// role `postgres` in schema `public`, so a table created by a migration is
// auto-granted privileges NOBODY WROTE DOWN — and migrations run as `postgres`,
// so every new table is subject to it. Measured 2026-09-25:
//
//   PROD   new table -> anon/authenticated/service_role get  arwdDxtm  (everything)
//   LOCAL  new table -> anon/authenticated/service_role get  Dxtm
//
// `D` is TRUNCATE, and RLS DOES NOT GATE TRUNCATE — it is the one privilege
// row-level security can never cover (docs/15's headline finding from the ACL
// sweep). So the remedy is docs/03 #27: every migration must
// `revoke all privileges ... from public, anon, authenticated, service_role`
// BEFORE it grants. That rule is load-bearing and, until this file, was
// enforced only by whoever remembered it. It has already been forgotten once,
// in CI, where an ordinary seeded user set his own `is_superadmin` to true.
//
// WHAT MAKES THIS CATCHABLE HERE. The local default grants `Dxtm`, so a table
// created WITHOUT the revoke wears a visible mark. This suite runs in CI
// (ci.yml -> `pnpm --filter @platform/db test`), against a database built from
// the real migrations — so a migration that forgets its revoke fails here,
// before it can reach prod, where the same omission grants far more.
//
// NOT A SUBSTITUTE for stripping the default privileges themselves. This
// detects the omission; it does not remove the trap. That change is prod-side
// and is the founder's call — see docs/15 and the 2026-09-25 journal entry.
//
// The two ratchets below are deliberately ABSOLUTE rather than allow-listed.
// "anon holds nothing" and "authenticated holds no RLS-ungated privilege" are
// invariants this platform has already committed to everywhere; an exception
// would be a design change, not a list edit.
// ---------------------------------------------------------------------------

const dbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

/** The privileges RLS cannot filter. A grant of these is reach, not depth. */
const UNGATED_BY_RLS = ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] as const
const DML = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const

type Row = { relname: string; held: string[] }

/** Every table in `public`, with the privileges `role` actually holds on it. */
async function heldBy(sql: postgres.Sql, role: string, privs: readonly string[]): Promise<Row[]> {
  const cases = privs
    .map((p) => `case when has_table_privilege('${role}', c.oid, '${p}') then '${p}' end`)
    .join(',')
  return (await sql.unsafe(`
    select c.relname, array_remove(array[${cases}], null) as held
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
     order by c.relname`)) as unknown as Row[]
}

describe('table grants: the forgotten-revoke ratchet (docs/03 #27, docs/15)', () => {
  it('RATCHET: anon holds NO privilege on any table in public', async () => {
    const sql = postgres(dbUrl, { prepare: false, max: 1 })
    try {
      const rows = await heldBy(sql, 'anon', [...DML, ...UNGATED_BY_RLS])
      const leaked = rows.filter((r) => r.held.length > 0)

      expect(
        leaked.map((r) => `${r.relname}(${r.held.join('/')})`),
        'anon holds a table privilege.\n' +
          'anon reaches this database through SECURITY DEFINER functions only — it is granted ' +
          'no table, anywhere, by design (the 2026-07-28 ACL sweep).\n' +
          'The overwhelmingly likely cause is a migration that CREATED a table without first ' +
          'running `revoke all privileges on <table> from public, anon, authenticated, ' +
          'service_role` (docs/03 #27). The default privileges granted it automatically.\n' +
          'Fix the migration, do not add an exception here.',
      ).toEqual([])

      // CONTROLS: the query found tables at all, and has_table_privilege is
      // capable of returning TRUE — otherwise every [] above is vacuous.
      expect(rows.length, 'no tables found in public — this ratchet is vacuous').toBeGreaterThan(50)
      const orgsForAuth = (await heldBy(sql, 'authenticated', ['SELECT'])).find(
        (r) => r.relname === 'orgs',
      )
      expect(
        orgsForAuth?.held,
        'CONTROL: authenticated must hold SELECT on orgs — if not, the privilege query is broken ' +
          'and the assertion above proves nothing',
      ).toEqual(['SELECT'])
    } finally {
      await sql.end()
    }
  })

  it('RATCHET: authenticated holds no RLS-ungated privilege on any table in public', async () => {
    const sql = postgres(dbUrl, { prepare: false, max: 1 })
    try {
      const rows = await heldBy(sql, 'authenticated', UNGATED_BY_RLS)
      const leaked = rows.filter((r) => r.held.length > 0)

      expect(
        leaked.map((r) => `${r.relname}(${r.held.join('/')})`),
        'authenticated holds TRUNCATE/REFERENCES/TRIGGER/MAINTAIN on a table.\n' +
          'RLS DOES NOT GATE TRUNCATE — a policy cannot save a table from being emptied, so this ' +
          'is reach that row-level security can never take back. PostgREST emits no TRUNCATE verb ' +
          'today, which makes it unreachable rather than safe: the API surface is the mitigation, ' +
          'not the database.\n' +
          'Same likely cause and same fix as the anon ratchet: the migration that created this ' +
          'table did not revoke before it granted (docs/03 #27).',
      ).toEqual([])

      // CONTROL: authenticated genuinely holds ordinary DML somewhere, so the
      // empty result above is a real measurement of the ungated four and not a
      // role that simply holds nothing at all.
      const withDml = (await heldBy(sql, 'authenticated', DML)).filter((r) => r.held.length > 0)
      expect(
        withDml.length,
        'CONTROL: authenticated holds no DML on any table — the role or the query is broken, ' +
          'so the assertion above is vacuous',
      ).toBeGreaterThan(20)
    } finally {
      await sql.end()
    }
  })

  it('CONTROL: this environment really does auto-grant, so the ratchets have teeth', async () => {
    // The anti-vacuity argument in its strongest form. Both ratchets above pass
    // today; this proves they pass because the discipline is being followed,
    // NOT because a table created without a revoke would have been clean anyway.
    //
    // Everything happens inside a transaction that is ALWAYS rolled back. This
    // matters more than usual here: ci.yml runs this suite and then e2e against
    // the SAME database with no reset between them, so a leaked probe table
    // would surface later as an unrelated failure.
    const sql = postgres(dbUrl, { prepare: false, max: 1 })
    try {
      const defaults = await sql<{ acl: string }[]>`
        select coalesce(array_to_string(d.defaclacl, ' | '), '') as acl
          from pg_default_acl d
          join pg_namespace n on n.oid = d.defaclnamespace
         where n.nspname = 'public' and d.defaclobjtype = 'r'
           and pg_get_userbyid(d.defaclrole) = 'postgres'`
      const defaultsGrantApiRole = defaults.some((d) => /\b(anon|authenticated)=/.test(d.acl))

      let naive: string[] = []
      let disciplined: Record<string, string[]> = {}
      await sql
        .begin(async (tx) => {
          const probe = async (table: string, role: string) => {
            const r = (await tx.unsafe(`
              select array_remove(array[${[...DML, ...UNGATED_BY_RLS]
                .map((p) => `case when has_table_privilege('${role}','${table}','${p}') then '${p}' end`)
                .join(',')}], null) as held`)) as unknown as { held: string[] }[]
            return r[0]!.held
          }

          // A table created the way a careless migration would create it.
          await tx.unsafe(`create table public._acl_ratchet_probe_naive (id int)`)
          naive = await probe('public._acl_ratchet_probe_naive', 'authenticated')

          // And the way docs/03 #27 says to.
          await tx.unsafe(`create table public._acl_ratchet_probe_ok (id int)`)
          await tx.unsafe(
            `revoke all privileges on public._acl_ratchet_probe_ok from public, anon, authenticated, service_role`,
          )
          await tx.unsafe(`grant select on public._acl_ratchet_probe_ok to authenticated`)
          disciplined = {
            anon: await probe('public._acl_ratchet_probe_ok', 'anon'),
            authenticated: await probe('public._acl_ratchet_probe_ok', 'authenticated'),
          }

          throw new Error('__rollback__')
        })
        .catch((e: unknown) => {
          if ((e as Error)?.message !== '__rollback__') throw e
        })

      // The equivalence is the point, and it holds in an environment with no
      // default privileges too — there, both sides are simply false and the
      // ratchets are belt-and-braces rather than load-bearing.
      expect(
        naive.length > 0,
        `pg_default_acl says api roles ${defaultsGrantApiRole ? 'ARE' : 'are NOT'} granted on new ` +
          `tables, but a table created without an explicit revoke picked up [${naive.join('/')}]. ` +
          'These two must agree; if they do not, the ratchets above may be measuring something ' +
          'other than what this control believes.',
      ).toBe(defaultsGrantApiRole)

      // The documented remedy actually produces the documented result.
      expect(disciplined.anon, 'revoke-then-grant left anon holding something').toEqual([])
      expect(
        disciplined.authenticated,
        'revoke-then-grant did not leave authenticated with exactly the one granted privilege',
      ).toEqual(['SELECT'])

      // And the probe really was rolled back.
      const leftovers = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname like '\\_acl\\_ratchet\\_probe\\_%'`
      expect(leftovers[0]!.n, 'a probe table survived the rollback — it would pollute e2e').toBe(0)
    } finally {
      await sql.end()
    }
  })
})
