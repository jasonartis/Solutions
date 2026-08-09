// PROD verification for 20260807010000_superadmin_lookup_log.sql — the half
// `scripts/prod-verify-migration.ts` structurally CANNOT check.
//
//   pnpm exec tsx scripts/prod-verify-superadmin-log.mts
//
// No arguments and NO app credentials: it connects through the session pooler
// with `SUPABASE_DB_PASSWORD` from `.env.deploy`, so unlike
// `verify-console-view-as.mts` it needs no superadmin login. Read-only.
//
// **COPY THIS FILE AS THE TEMPLATE** for any future migration that creates a
// TABLE, POLICY, GRANT, TRIGGER or CONSTRAINT rather than a function — that is
// the whole class `prod-verify-migration.ts` is blind to.
//
// WHY THIS EXISTS. That script parses `create function` blocks, so on this
// migration it verifies one trigger function and NOTHING ELSE — not the table,
// not its ACL, not the policies, not the CHECK constraints, not the trigger
// binding. CLAUDE.md records the same trap biting on `20260806010000`, a
// policy-only migration whose "0 failures" was completely vacuous. A green run
// of a checker that checks nothing is worse than no checker.
//
// EVERY ASSERTION CARRIES A CONTROL. A catalog query that silently returns zero
// rows — wrong schema, wrong catalog view, a permission the connection lacks —
// looks exactly like "the thing is absent" and would let this script PASS a
// missing policy as a correctly-absent one. So each block first proves the
// catalog read works at all by counting something known to be non-empty.
//
// READ-ONLY. It issues nothing but selects against pg_catalog.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const env = readFileSync(resolve(root, '.env.deploy'), 'utf8')
const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''

const ref = get('SUPABASE_PROJECT_REF')
const pw = get('SUPABASE_DB_PASSWORD')
if (!ref || !pw) throw new Error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD in .env.deploy')

const sql = postgres(
  `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`,
  { ssl: 'require', max: 1 },
)

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`) }
}

const TABLE = 'superadmin_lookup_log'

try {
  console.log(`\nProd verification — ${TABLE} (project ${ref})\n`)

  // -------------------------------------------------------------------------
  console.log('[1] The table exists')
  const tables = await sql`
    select c.relname, c.relrowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'`
  check('CONTROL: the catalog read returns public tables at all', tables.length > 20, `${tables.length} tables`)
  const t = tables.find((r) => r.relname === TABLE)
  check(`${TABLE} exists on prod`, t !== undefined)
  check('RLS is ENABLED on it', t?.relrowsecurity === true)

  // -------------------------------------------------------------------------
  console.log('\n[2] The ACL — append-only is enforced HERE, not by a trigger')
  // The whole append-only claim rests on this: no UPDATE/DELETE/TRUNCATE to any
  // api role. TRUNCATE especially — it is the one privilege RLS provably does
  // not gate. Prod is where this matters, because `ALTER DEFAULT PRIVILEGES FOR
  // ROLE postgres` auto-grants the full set on every new table and the revoke
  // must have beaten it. view_as_sessions shipped without naming service_role
  // and needed 20260802010000 to fix it on prod (docs/03 #17).
  const grants = await sql`
    select grantee, privilege_type
    from information_schema.role_table_grants
    where table_schema = 'public' and table_name = ${TABLE}`
  check('CONTROL: the grants read returns rows', grants.length > 0, `${grants.length} grant rows`)

  const privsOf = (role: string) =>
    grants.filter((g) => g.grantee === role).map((g) => g.privilege_type).sort()
  const setEq = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

  check('authenticated holds exactly INSERT + SELECT', setEq(privsOf('authenticated'), ['INSERT', 'SELECT']),
    JSON.stringify(privsOf('authenticated')))
  check('service_role holds exactly SELECT', setEq(privsOf('service_role'), ['SELECT']),
    JSON.stringify(privsOf('service_role')))
  check('anon holds NOTHING', privsOf('anon').length === 0, JSON.stringify(privsOf('anon')))
  for (const role of ['authenticated', 'service_role', 'anon']) {
    const bad = privsOf(role).filter((p) => ['UPDATE', 'DELETE', 'TRUNCATE'].includes(p))
    check(`${role} holds no UPDATE / DELETE / whole-table-wipe privilege`, bad.length === 0, JSON.stringify(bad))
  }

  // -------------------------------------------------------------------------
  console.log('\n[3] The policies — and the ONE that must NOT exist')
  const policies = await sql`
    select policyname, cmd, qual, with_check
    from pg_policies where schemaname = 'public' and tablename = ${TABLE}`
  const allPolicies = await sql`select count(*)::int as n from pg_policies where schemaname = 'public'`
  check('CONTROL: pg_policies returns the schema\'s policies at all',
    (allPolicies[0]?.n ?? 0) > 100, `${allPolicies[0]?.n} policies in public`)

  check('exactly TWO policies on the table', policies.length === 2,
    JSON.stringify(policies.map((p) => p.policyname)))

  const ins = policies.find((p) => p.policyname === `${TABLE}_insert_actor`)
  check('the INSERT policy exists and pins the actor to auth.uid() AND superadmin',
    ins?.cmd === 'INSERT' &&
    /actor_user_id\s*=\s*auth\.uid\(\)/.test(String(ins?.with_check)) &&
    /is_superadmin\(\)/.test(String(ins?.with_check)),
    String(ins?.with_check))

  const sel = policies.find((p) => p.policyname === `${TABLE}_select_superadmin`)
  check('the SELECT policy exists and is superadmin-only', sel?.cmd === 'SELECT' &&
    /is_superadmin\(\)/.test(String(sel?.qual)), String(sel?.qual))

  // THE NEGATIVE THAT MATTERS MOST, and its control is the count above.
  // A module-rank arm here would INVERT the hierarchy: module_position_rank
  // returns 0 for unmapped pairs and never null, so a superadmin actor would
  // read as rank 0 and every rank-1 holder on the platform would outrank the
  // platform operator. Its ABSENCE is the security decision in that migration.
  const anyRankArm = policies.some((p) =>
    /module_position_rank|module_roles|module_scope_covers/.test(`${p.qual} ${p.with_check}`))
  check('NO policy references a module rank / scope arm (the rank-0 inversion)', !anyRankArm)

  // No UPDATE or DELETE policy, and no `for all` (whose USING silently covers
  // SELECT — the defect 20260806010000 was written to repair on sal_locations).
  check('no UPDATE/DELETE/ALL policy exists', !policies.some((p) => ['UPDATE', 'DELETE', 'ALL'].includes(String(p.cmd))),
    JSON.stringify(policies.map((p) => `${p.policyname}:${p.cmd}`)))

  // -------------------------------------------------------------------------
  console.log('\n[4] The guard trigger is actually BOUND (not merely defined)')
  // prod-verify-migration.ts proves the FUNCTION exists. A function nothing
  // fires is not a guard, so the binding is checked separately.
  const triggers = await sql`
    select t.tgname, t.tgenabled
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = ${TABLE} and not t.tgisinternal`
  check('the guard trigger is bound to the table', triggers.some((r) => r.tgname === `${TABLE}_guard`),
    JSON.stringify(triggers.map((r) => r.tgname)))
  check('and it is ENABLED', triggers.every((r) => r.tgenabled === 'O'),
    JSON.stringify(triggers.map((r) => `${r.tgname}=${r.tgenabled}`)))

  // -------------------------------------------------------------------------
  console.log('\n[5] The shape CHECK — and the FK actions it must not fight')
  const cons = await sql`
    select con.conname, pg_get_constraintdef(con.oid) as def
    from pg_constraint con join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = ${TABLE}`
  check('CONTROL: the constraint read returns rows', cons.length > 0, `${cons.length}`)
  check('the row-shape CHECK is present', cons.some((r) => r.conname === `${TABLE}_shape`))

  // THE FK-ACTION SAFETY PROPERTY. Every FK must be `on delete set null`, and
  // no CHECK may forbid the null such an action writes — otherwise the log stops
  // things being deletable (the 2026-07-31 trigger lesson, in CHECK form).
  const fks = cons.filter((r) => String(r.def).startsWith('FOREIGN KEY'))
  check('CONTROL: the table has foreign keys to check', fks.length >= 4, `${fks.length} FKs`)
  check('EVERY foreign key is ON DELETE SET NULL (the log outlives what it describes)',
    fks.every((r) => /ON DELETE SET NULL/i.test(String(r.def))),
    JSON.stringify(fks.filter((r) => !/ON DELETE SET NULL/i.test(String(r.def))).map((r) => r.conname)))
  const shape = cons.find((r) => r.conname === `${TABLE}_shape`)
  check('the shape CHECK does NOT require subject_user_id NOT NULL (would make people undeletable)',
    !/subject_user_id\s+IS\s+NOT\s+NULL/i.test(String(shape?.def)), String(shape?.def))

  console.log(`\n${pass} passed, ${fail} failed`)
} finally {
  await sql.end()
}
process.exit(fail === 0 ? 0 : 1)
