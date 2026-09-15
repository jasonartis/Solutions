// Prod verification for `20260915010000_seat_requires_module_role.sql` — the
// half `prod-verify-migration.ts` cannot see.
//
//   pnpm exec tsx scripts/prod-verify-module-role.mts
//
// WHY THIS FILE EXISTS. `prod-verify-migration.ts` parses `create function`
// blocks only, and this migration is MOSTLY POLICIES — nine of them. A
// function-only run would report "0 failures" while asserting nothing about the
// nine, which is the vacuity trap docs/03 names. Copied from
// `prod-verify-seat-authority.mts`, itself copied from
// `prod-verify-superadmin-log.mts` (the worked template for policy work).
//
// EVERY ASSERTION CARRIES A CONTROL. A catalog query that returns zero rows —
// wrong schema, a permission the connection lacks, a typo in a name — looks
// exactly like "the thing is absent", and would let this script PASS a missing
// policy as a correctly-absent one.
//
// THREE OF THESE CHECKS ARE NEGATIVE ON PURPOSE, which is the unusual part.
// This migration deliberately does NOT do three things, each for a recorded
// reason, and each would be an easy "tidy-up" for a later session to add
// without realising it is answering a founder decision or re-introducing a
// regression. So their ABSENCE is asserted, with a control proving the query
// would have seen them:
//   * speed dating's role conjunct (FOUNDER DECISION: no audience/mentor role)
//   * cls_set_preferred_name's role conjunct (would silently lock out staff)
//   * mm_assignment_covers_me's own-target arm staying ungated
//
// READ-ONLY. It issues nothing but selects against pg_catalog and two
// aggregate counts over application tables.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const env = readFileSync(resolve(root, '.env.deploy'), 'utf8')
const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''

const LOCAL = process.argv.includes('--local')

let ref = '(local)'
let sql: ReturnType<typeof postgres>
if (LOCAL) {
  sql = postgres(process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres', { max: 1 })
} else {
  ref = get('SUPABASE_PROJECT_REF')
  const pw = get('SUPABASE_DB_PASSWORD')
  if (!ref || !pw) throw new Error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD in .env.deploy')
  sql = postgres(
    `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`,
    { ssl: 'require', max: 1 },
  )
}

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++
    console.log(`  ok    ${name}${detail ? '  ' + detail : ''}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`)
  }
}

console.log(`Prod verification — 20260915010000 module-role half  (project ${ref})\n`)

try {
  // -------------------------------------------------------------------------
  console.log('[0] CONTROLS — prove the catalog reads work before trusting any result')
  const polCount = await sql<{ n: string }[]>`select count(*)::text as n from pg_policies where schemaname = 'public'`
  check('pg_policies is readable and non-empty', Number(polCount[0]!.n) > 100, `${polCount[0]!.n} policies`)

  const fnCount = await sql<{ n: string }[]>`
    select count(*)::text as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'`
  check('pg_proc is readable and non-empty', Number(fnCount[0]!.n) > 50, `${fnCount[0]!.n} functions`)

  const whoami = await sql<{ u: string }[]>`select current_user as u`
  check('connection authenticates as a real role', !!whoami[0]?.u, whoami[0]?.u)

  // -------------------------------------------------------------------------
  console.log('\n[1] the FOUR predicates gained their role conjunct')
  const FN_ROLE: [string, string][] = [
    ['mm_matchmaker_can_see', 'mm_is_matchmaker'],
    ['mm_assignment_covers_me', 'mm_is_single'],
    ['sal_worker_sees_customer', 'sal_is_worker'],
    ['cls_reviews_submission', 'cls_is_class_member'],
  ]
  const bodies = await sql<{ proname: string; def: string; secdef: boolean; provolatile: string; cfg: string | null }[]>`
    select p.proname::text as proname, pg_get_functiondef(p.oid) as def,
           p.prosecdef as secdef, p.provolatile::text as provolatile,
           array_to_string(p.proconfig, ',') as cfg
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('mm_matchmaker_can_see', 'mm_assignment_covers_me', 'sal_worker_sees_customer',
                        'cls_reviews_submission', 'cls_set_preferred_name')`
  check('CONTROL: all five touched functions exist on this database', bodies.length === 5, `${bodies.length}/5`)

  for (const [fn, role] of FN_ROLE) {
    const row = bodies.find((b) => b.proname === fn)
    check(`${fn} conjoins ${role}`, !!row && row.def.includes(role))
    // Properties a `create or replace` does NOT inherit — losing one silently
    // is the classic failure of this kind of migration.
    check(`${fn} is still SECURITY DEFINER`, !!row?.secdef)
    check(`${fn} is still STABLE`, row?.provolatile === 's', row?.provolatile)
    check(`${fn} still pins search_path`, !!row?.cfg?.includes('search_path=public'))
  }

  // Every role predicate must itself still require active org membership,
  // which is what makes the org conjunct redundant-but-harmless rather than
  // the role conjunct being a WEAKENING.
  const helpers = await sql<{ proname: string; def: string }[]>`
    select p.proname::text as proname, pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('mm_is_matchmaker', 'mm_is_single', 'sal_is_worker', 'cls_is_class_member',
                        'has_module_role')`
  check('CONTROL: the five role helpers exist', helpers.length === 5, `${helpers.length}/5`)
  for (const h of ['sal_is_worker', 'cls_is_class_member', 'has_module_role']) {
    const row = helpers.find((x) => x.proname === h)
    check(`${h} still requires is_org_member (so the role conjunct SUBSUMES the org one)`,
      !!row && row.def.includes('is_org_member'))
  }
  for (const h of ['mm_is_matchmaker', 'mm_is_single']) {
    const row = helpers.find((x) => x.proname === h)
    check(`${h} resolves through has_module_role (which carries is_org_member)`,
      !!row && row.def.includes('has_module_role'))
  }

  // -------------------------------------------------------------------------
  console.log('\n[2] the NINE policies carry their conjunct (and UPDATEs carry it on BOTH sides)')
  const POL: { name: string; needs: string[]; bothSides?: boolean }[] = [
    { name: 'mm_assignments_select', needs: ['mm_is_matchmaker', 'is_org_member'] },
    { name: 'mm_groups_select_assigned', needs: ['mm_is_matchmaker'] },
    { name: 'mm_group_members_select_assigned', needs: ['mm_is_matchmaker'] },
    { name: 'sal_appointments_select', needs: ['sal_is_worker'] },
    { name: 'sal_appointments_update_worker', needs: ['sal_is_worker'], bothSides: true },
    { name: 'sal_worker_time_off_select', needs: ['sal_is_worker'] },
    { name: 'cls_review_assignments_select', needs: ['cls_is_class_member'] },
    { name: 'cls_review_assignments_update_reviewer', needs: ['cls_is_class_member'], bothSides: true },
    { name: 'sd_participants_update_self', needs: ['is_org_member'], bothSides: true },
  ]
  const pols = await sql<{ policyname: string; cmd: string; qual: string | null; with_check: string | null; permissive: string; roles: string[] }[]>`
    select policyname::text as policyname, cmd::text as cmd, qual, with_check,
           permissive::text as permissive, roles
    from pg_policies
    where schemaname = 'public' and policyname = any(${POL.map((p) => p.name)})`
  check('CONTROL: all nine policies exist on this database', pols.length === POL.length, `${pols.length}/${POL.length}`)

  for (const spec of POL) {
    const row = pols.find((p) => p.policyname === spec.name)
    if (!row) {
      check(`${spec.name} present`, false, 'MISSING')
      continue
    }
    for (const need of spec.needs) {
      check(`${spec.name} USING carries ${need}`, (row.qual ?? '').includes(need))
      if (spec.bothSides) {
        check(`${spec.name} WITH CHECK carries ${need}`, (row.with_check ?? '').includes(need))
      }
    }
    check(`${spec.name} is still PERMISSIVE`, row.permissive.toLowerCase().startsWith('permissive'), row.permissive)
    check(`${spec.name} still applies to PUBLIC (no narrowing \`to\` clause introduced)`,
      row.roles.length === 1 && row.roles[0] === 'public', JSON.stringify(row.roles))
  }

  // The asymmetric state lists on the salon write are the feature, not an
  // oversight — a rewrite that "tidied" them to match would change behaviour.
  const salUpd = pols.find((p) => p.policyname === 'sal_appointments_update_worker')
  check('sal_appointments_update_worker USING still excludes complete/no_show',
    !!salUpd && !(salUpd.qual ?? '').includes('no_show'))
  check('sal_appointments_update_worker WITH CHECK still permits complete/no_show',
    !!salUpd && (salUpd.with_check ?? '').includes('no_show'))

  // -------------------------------------------------------------------------
  console.log('\n[3] THREE DELIBERATE ABSENCES — asserted as negatives, each with a control')

  // (a) Speed dating's role conjunct is a FOUNDER DECISION, not an oversight.
  const sdFns = await sql<{ proname: string; def: string }[]>`
    select p.proname::text as proname, pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('sd_owns_participant', 'sd_in_event', 'sd_paired_with', 'sd_mentors')`
  check('CONTROL: the four speed-dating predicates exist (so their absence of a role check is real)',
    sdFns.length === 4, `${sdFns.length}/4`)
  check('CONTROL: they DO carry the org conjunct from 20260910040000 (proves the query reads bodies)',
    sdFns.length === 4 && sdFns.every((f) => f.def.includes('is_org_member')))
  const sdRoleGated = sdFns.filter((f) => f.def.includes('sd_is_participant')).map((f) => f.proname)
  check('speed dating still has NO role conjunct — it is an OPEN FOUNDER DECISION (docs/19 2026-09-15). '
    + 'If this fails, someone added it: there is no audience/mentor module role, so requiring '
    + "'participant' revokes those seats outright",
    sdRoleGated.length === 0, sdRoleGated.join(',') || 'none')

  // (b) cls_set_preferred_name is ORG-gated only, on purpose.
  const pref = bodies.find((b) => b.proname === 'cls_set_preferred_name')
  check('cls_set_preferred_name carries is_org_member', !!pref && pref.def.includes('is_org_member'))
  check('cls_set_preferred_name does NOT carry cls_is_class_member — staff hold GLOBAL grants and that '
    + 'predicate requires scope_ref is not null, so the role version silently locks a professor out of '
    + 'renaming HERSELF (caught by two independent reviews)',
    !!pref && !pref.def.includes('cls_is_class_member'))
  check('cls_set_preferred_name is still NOT stable (it writes)', pref?.provolatile === 'v', pref?.provolatile)

  // (c) mm_assignment_covers_me's own-target arm stays ungated.
  const cov = bodies.find((b) => b.proname === 'mm_assignment_covers_me')
  check("mm_assignment_covers_me's own-target arm is still ungated (docs/19 §6 deliberate exception)",
    !!cov && /select\s+check_target_user_id\s*=\s*auth\.uid\(\)/i.test(cov.def))

  // -------------------------------------------------------------------------
  console.log("\n[4] matchmaking's FOR ALL staff policies were NOT split or narrowed")
  // The parallel Public Square session's FOR ALL sweep found these are the
  // matchmaking admin's ONLY read path — mm_matchmaker_can_see has no
  // mm_can_manage disjunct. Splitting them would revoke an admin's read of
  // what they administer. Asserted so a later sweep cannot do it silently.
  const forAll = await sql<{ policyname: string; cmd: string; qual: string | null }[]>`
    select policyname::text as policyname, cmd::text as cmd, qual
    from pg_policies
    where schemaname = 'public' and tablename like 'mm\\_%' and cmd = 'ALL'`
  check('CONTROL: matchmaking still has FOR ALL staff policies at all', forAll.length > 0, `${forAll.length} found`)
  check('every matchmaking FOR ALL policy still gates on mm_can_manage',
    forAll.length > 0 && forAll.every((p) => (p.qual ?? '').includes('mm_can_manage')),
    forAll.map((p) => p.policyname).join(','))

  // -------------------------------------------------------------------------
  console.log('\n[5] ACLs — policy expressions are permission-checked as the querying role (docs/03 #17)')
  // docs/03 #1: prod has ALTER DEFAULT PRIVILEGES that local lacks, so an
  // anon grant can exist on prod and NOT locally. This is the check that can
  // only be done here.
  const acls = await sql<{ proname: string; acl: string | null }[]>`
    select p.proname::text as proname, array_to_string(p.proacl, ' ') as acl
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('mm_is_matchmaker', 'mm_is_single', 'sal_is_worker', 'cls_is_class_member', 'is_org_member')`
  check('CONTROL: ACLs are readable for all five helpers', acls.length === 5, `${acls.length}/5`)
  for (const a of acls) {
    check(`${a.proname}: authenticated holds EXECUTE (else every policy naming it ERRORS)`,
      (a.acl ?? '').includes('authenticated=X'))
    check(`${a.proname}: anon holds NOTHING`, !(a.acl ?? '').includes('anon='))
  }

  // -------------------------------------------------------------------------
  console.log('\n[6] DATA: did applying this revoke anyone real?')
  // A migration can be structurally perfect and still have broken a live user.
  // This is the same measurement that gated the migration, re-run against the
  // post-apply database: a seat whose holder lacks the now-required role.
  const revoked = await sql<{ table_name: string; total: string; missing: string }[]>`
    select 'mm_matchmaker_assignments' as table_name, count(*)::text as total,
           count(*) filter (where not exists (
             select 1 from public.module_roles g
             where g.org_id = t.org_id and g.module_key = 'matchmaking' and g.role = 'matchmaker'
               and g.user_id = t.matchmaker_id and g.scope_ref is null))::text as missing
      from public.mm_matchmaker_assignments t
    union all
    select 'sal_appointments', count(*)::text,
           count(*) filter (where not exists (
             select 1 from public.module_roles g
             where g.org_id = t.org_id and g.module_key = 'nail-salon' and g.role = 'worker'
               and g.user_id = t.worker_id))::text
      from public.sal_appointments t where t.worker_id is not null
    union all
    select 'cls_review_assignments', count(*)::text,
           count(*) filter (where not exists (
             select 1 from public.module_roles g
             join public.cls_classes c on c.id = t.class_id
             where g.org_id = c.org_id and g.module_key = 'classroom' and g.user_id = t.reviewer_id
               and g.scope_ref is not null
               and public.module_scope_covers(g.scope_ref, c.scope_node_id)))::text
      from public.cls_review_assignments t`
  let anyRows = false
  let anyHeld = false
  for (const r of revoked) {
    const total = Number(r.total)
    const missing = Number(r.missing)
    if (total > 0) anyRows = true
    if (total - missing > 0) anyHeld = true
    check(`${r.table_name}: no seat lost access (${total} rows, ${missing} without the role)`, missing === 0)
  }
  check('CONTROL: at least one roster has rows at all', anyRows, JSON.stringify(revoked.map((r) => `${r.table_name}=${r.total}`)))
  check('CONTROL: at least one seat POSITIVELY holds its role (a broken join would read as 0 missing)', anyHeld)

  // -------------------------------------------------------------------------
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail === 0) {
    console.log('\n20260915010000 is correctly deployed: nine policies and five functions verified,')
    console.log('three deliberate absences still absent, no live seat revoked.')
  }
} finally {
  await sql.end()
}
process.exit(fail === 0 ? 0 : 1)
