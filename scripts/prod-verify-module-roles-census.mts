// PROD verification for 20261002010000_module_roles_census.sql — the census-leak
// policy swap on `public.module_roles`.
//
//   pnpm exec tsx scripts/prod-verify-module-roles-census.mts
//   pnpm exec tsx scripts/prod-verify-module-roles-census.mts --local
//
// No arguments and NO app credentials: it connects through the session pooler with
// `SUPABASE_DB_PASSWORD` from `.env.deploy`. Read-only — nothing but selects.
//
// WHY THIS EXISTS, and it is the documented trap rather than belt-and-braces:
// `scripts/prod-verify-migration.ts` is FUNCTION-ONLY, and this migration defines
// ZERO functions (`grep -c "create function"` = 0). Running it here would print
// "0 failures" while asserting nothing whatsoever about the policy — exactly the
// vacuous pass CLAUDE.md records from `20260806010000`. A green run of a checker
// that checks nothing is worse than no checker. `prod-verify-module-role.mts`
// does not cover it either (zero mentions of either policy name; it belongs to
// `20260915010000`).
//
// RUN IT BEFORE *AND* AFTER `migrate:prod`. The evidence that matters is the
// BEFORE/AFTER, not the final pass — a script that only ever ran post-apply
// cannot distinguish "the migration worked" from "the assertion was always true".
// Pre-apply this should FAIL section [2] and [3] and PASS every CONTROL.
//
// EVERY ASSERTION CARRIES A CONTROL. A catalog query that silently returns zero
// rows — wrong schema, wrong catalog view, a permission the connection lacks —
// looks exactly like "the thing is absent", which would let this script pass a
// MISSING policy off as a correctly-absent one. The negative assertions here (the
// old policy is gone; anon holds nothing) are the ones that need it most.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const local = process.argv.includes('--local')

const sql = local
  ? postgres(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres', { max: 1 })
  : (() => {
      const env = readFileSync(resolve(root, '.env.deploy'), 'utf8')
      const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''
      const ref = get('SUPABASE_PROJECT_REF')
      const pw = get('SUPABASE_DB_PASSWORD')
      if (!ref || !pw) throw new Error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD in .env.deploy')
      return postgres(
        `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`,
        { ssl: 'require', max: 1 },
      )
    })()

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`) }
}

const NEW_POLICY = 'module_roles_select_self_or_manager'
const OLD_POLICY = 'module_roles_select_member'

try {
  console.log(`\nProd verification — module_roles census leak (20261002010000)`)
  console.log(`Target: ${local ? 'LOCAL' : 'PRODUCTION'}\n`)

  // -------------------------------------------------------------------------
  console.log('[1] The catalog read works at all')
  const allPolicies = await sql<{ polname: string }[]>`
    select p.polname from pg_policy p`
  check('CONTROL: pg_policy returns policies at all', allPolicies.length > 50, `${allPolicies.length} policies`)

  const pols = await sql<{ polname: string; cmd: string; qual: string | null; withcheck: string | null }[]>`
    select p.polname,
           case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE'
                         when 'd' then 'DELETE' when '*' then 'ALL' end as cmd,
           pg_get_expr(p.polqual, p.polrelid)      as qual,
           pg_get_expr(p.polwithcheck, p.polrelid) as withcheck
    from pg_policy p
    where p.polrelid = 'public.module_roles'::regclass
    order by cmd, p.polname`
  check('CONTROL: module_roles carries policies', pols.length >= 5, `${pols.length} policies`)
  for (const p of pols) console.log(`        ${p.cmd.padEnd(7)} ${p.polname}`)

  // -------------------------------------------------------------------------
  console.log('\n[2] The NEW policy, asserted on its real expression')
  const neu = pols.find((p) => p.polname === NEW_POLICY)
  check(`${NEW_POLICY} exists`, neu !== undefined)
  check('it is SELECT-only (not `for all`)', neu?.cmd === 'SELECT', `cmd=${neu?.cmd}`)
  const q = (neu?.qual ?? '').replace(/\s+/g, ' ')
  // Each arm asserted SEPARATELY, so a partial policy cannot pass as a whole one.
  check('arm: self  (user_id = auth.uid())', /user_id = auth\.uid\(\)/.test(q), q)
  check('arm: is_org_member conjoined to self', /is_org_member/.test(q), q)
  check('arm: is_org_admin  (docs/24 §1.6 — org admins hold no module_roles row)', /is_org_admin/.test(q), q)
  check('arm: module_has_manager_grant (per-row module_key)', /module_has_manager_grant/.test(q), q)
  check('arm: is_superadmin (Owner Console reads through its own RLS)', /is_superadmin/.test(q), q)
  if (neu) console.log(`        USING ${q}`)

  // -------------------------------------------------------------------------
  console.log('\n[3] The OLD blanket policy is GONE — a negative, so it needs its control')
  // Pre-apply this FAILS and that is the point: it is the half that proves the
  // migration actually ran rather than that the new policy merely exists.
  const old = pols.find((p) => p.polname === OLD_POLICY)
  check(`${OLD_POLICY} is absent`, old === undefined, old ? `still present: ${old.qual}` : '')
  check(
    'CONTROL: the absence is real — this same read DID return other module_roles policies',
    pols.length >= 5,
    `${pols.length} found`,
  )
  const selectPolicies = pols.filter((p) => p.cmd === 'SELECT')
  check('exactly ONE SELECT-only policy remains', selectPolicies.length === 1,
    selectPolicies.map((p) => p.polname).join(', '))

  // -------------------------------------------------------------------------
  console.log('\n[4] The two `for all` write policies SURVIVE (their USING governs SELECT too)')
  // docs/20 §8.1. These were deliberately left alone: both admit exactly the
  // readers the new SELECT policy admits, so the effective read set is a union of
  // three same-intent doors. If one vanished, the tests above would still pass
  // while real admins lost the table — so they are asserted explicitly.
  const forAll = pols.filter((p) => p.cmd === 'ALL').map((p) => p.polname).sort()
  check('module_roles_write_org_admin present', forAll.includes('module_roles_write_org_admin'), forAll.join(', '))
  check('module_roles_write_superadmin present', forAll.includes('module_roles_write_superadmin'), forAll.join(', '))

  // -------------------------------------------------------------------------
  console.log('\n[5] Table ACL — RLS cannot gate a privilege the role should not hold')
  const acl = await sql<{ grantee: string; privilege_type: string }[]>`
    select grantee, privilege_type from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'module_roles'`
  check('CONTROL: the ACL read returns grants at all', acl.length > 0, `${acl.length} grants`)
  const anon = acl.filter((a) => a.grantee === 'anon')
  check('anon holds NOTHING on module_roles', anon.length === 0, anon.map((a) => a.privilege_type).join(', '))
  const authed = acl.filter((a) => a.grantee === 'authenticated').map((a) => a.privilege_type)
  check('authenticated still holds SELECT (the policy, not the grant, is the gate)',
    authed.includes('SELECT'), authed.join(', '))
  check('authenticated holds no TRUNCATE', !authed.includes('TRUNCATE'), authed.join(', '))
  check('RLS is ENABLED on module_roles',
    (await sql<{ relrowsecurity: boolean }[]>`
      select relrowsecurity from pg_class where oid = 'public.module_roles'::regclass`)[0]?.relrowsecurity === true)

  // -------------------------------------------------------------------------
  console.log('\n[6] BEHAVIOURAL — who actually reads what, per real active member')
  // The structural checks above can all pass while the policy means something
  // other than intended. This evaluates the live predicate per (member, row)
  // without impersonating anyone: it reproduces the four arms in SQL against
  // real prod rows. Read-only.
  const rows = await sql<{
    slug: string; org_role: string; own_grants: number; is_manager: boolean
    reads_today: number; reads_after: number
  }[]>`
    with members as (
      select om.org_id, om.user_id, om.role as org_role, o.slug
      from org_members om join orgs o on o.id = om.org_id
      where om.status = 'active'
    )
    select m.slug, m.org_role,
           (select count(*)::int from module_roles g where g.org_id = m.org_id and g.user_id = m.user_id) as own_grants,
           exists (select 1 from module_roles g
                   where g.org_id = m.org_id and g.user_id = m.user_id
                     and public.module_position_rank(g.module_key, g.role) >= 2) as is_manager,
           (select count(*)::int from module_roles r where r.org_id = m.org_id) as reads_today,
           (select count(*)::int from module_roles r
             where r.org_id = m.org_id
               and ( r.user_id = m.user_id
                     or m.org_role in ('owner','admin')
                     or exists (select 1 from module_roles g
                                where g.org_id = m.org_id and g.user_id = m.user_id
                                  and g.module_key = r.module_key
                                  and public.module_position_rank(r.module_key, g.role) >= 2) )) as reads_after
    from members m order by m.slug, m.org_role`
  check('CONTROL: there are real active members to measure', rows.length > 0, `${rows.length} members`)
  check('CONTROL: there are real grants to be narrowed',
    rows.some((r) => r.reads_today > 0), 'every org has zero grants — this section is VACUOUS')

  const admins = rows.filter((r) => r.org_role === 'owner' || r.org_role === 'admin')
  check('every org owner/admin reads the WHOLE org, unchanged',
    admins.every((r) => r.reads_after === r.reads_today),
    admins.filter((r) => r.reads_after !== r.reads_today).map((r) => r.slug).join(', '))

  const plain = rows.filter((r) => r.org_role !== 'owner' && r.org_role !== 'admin')
  check('no ordinary member reads MORE than before (the change only ever narrows)',
    plain.every((r) => r.reads_after <= r.reads_today))
  check('every ordinary member still reads at least their OWN grants',
    plain.every((r) => r.reads_after >= r.own_grants),
    plain.filter((r) => r.reads_after < r.own_grants).map((r) => r.slug).join(', '))

  const narrowed = plain.filter((r) => r.reads_after < r.reads_today)
  console.log(`\n        ${narrowed.length} of ${rows.length} active members read fewer rows; ` +
              `${rows.length - narrowed.length} unchanged.`)
  for (const r of rows) {
    const tag = r.reads_after === r.reads_today ? 'unchanged' : `NARROWED -${r.reads_today - r.reads_after}`
    const mgr = r.is_manager ? ' [rank>=2 manager]' : ''
    console.log(`        ${r.slug.padEnd(20)} ${String(r.org_role).padEnd(6)} own=${r.own_grants}  ` +
                `${r.reads_today} -> ${r.reads_after}  ${tag}${mgr}`)
  }
  // THE LEAK ITSELF, named. CAREFUL: "reads more than their own" is NOT the leak.
  // A rank->=2 module manager is an ordinary org member who legitimately reads
  // every grant in the module they manage — that is the whole point of the
  // module_has_manager_grant arm, and an earlier draft of this check wrongly
  // flagged exactly those three people (a classroom professor and two salon
  // managers) as leaks. The leak is a member who holds NO manager grant and can
  // still see somebody else's row.
  const nonManagers = plain.filter((r) => !r.is_manager)
  check('CONTROL: there ARE non-manager members to measure (else the next check is vacuous)',
    nonManagers.length > 0, `${nonManagers.length} of ${plain.length} plain members`)
  const stillLeaking = nonManagers.filter((r) => r.reads_after > r.own_grants)
  check('NO member without a rank->=2 grant can enumerate grants that are not their own',
    stillLeaking.length === 0,
    stillLeaking.map((r) => `${r.slug}(${r.reads_after}>${r.own_grants})`).join(', '))

  // And the other direction, so the arm cannot silently stop working: a manager
  // must STILL read more than their own rows wherever their module has others.
  const managers = plain.filter((r) => r.is_manager)
  check('CONTROL: there ARE non-admin rank->=2 managers on this database',
    managers.length > 0, `${managers.length}`)
  check('every non-admin manager still reads beyond their own grants',
    managers.every((r) => r.reads_after > r.own_grants),
    managers.filter((r) => r.reads_after <= r.own_grants).map((r) => r.slug).join(', '))

  // -------------------------------------------------------------------------
  console.log(`\nResult: ${pass}/${pass + fail} checks passed, ${fail} failure(s) — ` +
              `${local ? 'LOCAL' : 'PRODUCTION'}`)
  if (fail > 0) {
    console.log('\nIf this is a PRE-APPLY run, sections [2] and [3] failing is EXPECTED and is')
    console.log('the before-picture. Re-run after `pnpm migrate:prod` — every control should')
    console.log('be green in both runs, which is what makes the difference evidence.')
  }
  process.exitCode = fail > 0 ? 1 : 0
} finally {
  await sql.end()
}
