// Prod verification for supabase/migrations/20261127010000_view_as_staff.sql —
// STAFF "View as" (docs/13 "STAFF VIEW AS"). Copied from
// prod-verify-view-as-whole-account.mts.
//
//   node node_modules/tsx/dist/cli.mjs scripts/prod-verify-view-as-staff.mts --local
//   node node_modules/tsx/dist/cli.mjs scripts/prod-verify-view-as-staff.mts
//
// Run it BEFORE and AFTER `migrate:prod`: before, the structure checks fail, the
// behaviour section prints SKIPPED (view_as_staff_start does not exist yet) and
// the CONTROLS pass; after, everything passes. The evidence is the before/after.
//
// [1] STRUCTURE: every function the migration creates or re-creates (body md5
//     matches the file; definer or not; search_path pinned; EXECUTE exactly as
//     intended, never PUBLIC); view_as_real_sessions.kind + its checks; the
//     granted_by trigger BOUND; every cls_/sal_ table has a restrictive
//     <table>_staff_area policy; the platform-table, feedback and storage
//     policies; the hook still set and never raising.
// [2] BEHAVIOUR as real users, in ONE transaction that is ALWAYS ROLLED BACK,
//     in a throwaway org made inside it: a professor (seat given by someone
//     else) starts a staff view of a student; the view reads class A only (the
//     person reads A and B — control); files of class B are dark; other orgs'
//     rows are dark; a self-given seat and a peer (GA) are refused; the
//     platform branch is false under a staff token; the check scopes the area
//     module only; the view is read-only.
// [3] REPORT (no pass/fail): owners/admins who hold a manager-tier seat with no
//     recorded giver (granted_by NULL) — under founder answer 5 those seats
//     still count, because nobody can tell who gave them.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL = process.argv.includes('--local')
const FILE = 'supabase/migrations/20261127010000_view_as_staff.sql'

let ref = '(local)'
let sql: ReturnType<typeof postgres>
if (LOCAL) {
  sql = postgres(process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres', { max: 1, onnotice: () => {} })
} else {
  const env = readFileSync(resolve(root, '.env.deploy'), 'utf8')
  const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''
  ref = get('SUPABASE_PROJECT_REF')
  const pw = get('SUPABASE_DB_PASSWORD')
  if (!ref || !pw) throw new Error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD in .env.deploy')
  sql = postgres(
    `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`,
    { ssl: 'require', max: 1, onnotice: () => {} },
  )
}

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${detail})`}`)
}
const skipped = (what: string) => console.log(`  SKIPPED  ${what}`)

async function rolledBack(body: (tx: postgres.TransactionSql) => Promise<void>) {
  await sql
    .begin(async (tx) => {
      await body(tx)
      throw new Error('__rollback__')
    })
    .catch((e: unknown) => {
      if ((e as Error)?.message !== '__rollback__') throw e
    })
}

// The LAST definition of each function in the file wins (a body re-created later).
const expected = (() => {
  const text = readFileSync(resolve(root, FILE), 'utf8')
  const out = new Map<string, string>()
  const re = /create (?:or replace )?function public\.(\w+)\([\s\S]*?\nas \$\$([\s\S]*?)\$\$;/g
  for (let m = re.exec(text); m; m = re.exec(text)) out.set(m[1]!, createHash('md5').update(m[2]!).digest('hex'))
  return out
})()

// name -> [nargs, security definer?, search_path, anon?, authenticated?, service_role?]
const E = 'search_path=""'
const P = 'search_path=public'
const INTENT: Record<string, [number, boolean, string, boolean, boolean, boolean]> = {
  module_roles_stamp_granted_by: [0, true, E, false, false, false],
  view_as_staff_area: [3, false, E, false, false, false],
  view_as_staff_live: [1, true, E, false, false, false],
  view_as_staff_current: [0, true, E, false, false, false],
  view_as_now: [0, true, E, false, false, false],
  view_as_area_has_module: [3, true, E, false, false, false],
  view_as_area_has_node: [4, true, E, false, false, false],
  view_as_staff_node_ok: [3, true, E, false, false, false],
  view_as_platform_live: [0, true, E, false, false, false],
  view_as_platform_ok: [0, true, E, true, true, true],
  view_as_may_read: [2, true, E, true, true, true],
  view_as_may_read_in: [3, true, E, true, true, true],
  view_as_grant_visible: [3, true, E, true, true, true],
  view_as_is_staff_view: [0, true, E, true, true, true],
  view_as_org_ok: [1, true, E, true, true, true],
  view_as_profile_ok: [1, true, E, true, true, true],
  cls_class_node: [1, true, E, false, true, true],
  cls_course_node: [1, true, E, false, true, true],
  sal_location_node: [1, true, E, false, true, true],
  cls_material_in_area: [1, true, E, false, true, true],
  view_as_area_ids: [1, true, E, true, true, true],
  view_as_storage_may_read: [2, true, E, true, true, true],
  cls_can_manage: [1, true, P, false, true, true],
  cls_is_ga: [1, true, P, false, true, true],
  has_module_role: [3, true, P, false, true, true],
  module_has_manager_grant: [2, true, P, false, true, true],
  sal_can_manage: [1, true, P, false, true, true],
  sal_can_operate: [1, true, P, false, true, true],
  sal_is_worker: [1, true, P, false, true, true],
  cls_comments_for_my_submission: [1, true, P, false, true, true],
  cls_survey_results: [1, true, P, false, true, true],
  view_as_staff_targets: [2, true, E, false, true, false],
  view_as_staff_start: [2, true, E, false, true, false],
  view_as_real_check: [3, true, E, false, true, false],
  view_as_real_end: [1, true, E, false, true, false],
}

try {
  console.log(`[1] structure — ${LOCAL ? 'LOCAL' : `PROD (${ref})`}`)
  const [{ n: allFns }] = await sql<{ n: number }[]>`select count(*)::int as n from pg_proc where pronamespace = 'public'::regnamespace`
  check('CONTROL: the catalog read works', allFns > 50, `${allFns}`)
  check(`CONTROL: the migration file parsed (${Object.keys(INTENT).length} bodies)`,
    Object.keys(INTENT).every((k) => expected.has(k)) && expected.size === Object.keys(INTENT).length,
    `${expected.size}: missing ${Object.keys(INTENT).filter((k) => !expected.has(k)).join(',')}`)

  for (const [name, [nargs, secdef, path, anon, auth, svc]] of Object.entries(INTENT)) {
    const [f] = await sql<{ secdef: boolean; config: string[] | null; md5: string; a: boolean; u: boolean; s: boolean; p: boolean }[]>`
      select p.prosecdef as secdef, p.proconfig as config, md5(p.prosrc) as md5,
             has_function_privilege('anon', p.oid, 'execute') as a,
             has_function_privilege('authenticated', p.oid, 'execute') as u,
             has_function_privilege('service_role', p.oid, 'execute') as s,
             coalesce(p.proacl::text, '') ~ '(^|[{,])=X/' as p
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = ${name} and p.pronargs = ${nargs}`
    check(`${name}/${nargs} exists, body matches the file`, f?.md5 === expected.get(name), `db=${f?.md5 ?? '-'}`)
    check(`  definer = ${secdef}, ${path}`, f?.secdef === secdef && JSON.stringify(f?.config) === JSON.stringify([path]), JSON.stringify(f?.config))
    check(`  EXECUTE anon=${anon} authenticated=${auth} service_role=${svc}, never PUBLIC`, !!f && f.a === anon && f.u === auth && f.s === svc && !f.p, f ? `${f.a}/${f.u}/${f.s}/public=${f.p}` : '-')
  }

  const [kind] = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_attribute where attrelid = 'public.view_as_real_sessions'::regclass and attname = 'kind' and attnotnull`
  const [chk] = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_constraint where conrelid = 'public.view_as_real_sessions'::regclass
      and conname in ('view_as_real_sessions_kind_check', 'view_as_real_sessions_staff_shape')`
  check('view_as_real_sessions.kind (not null) and its two checks', kind?.n === 1 && chk?.n === 2, JSON.stringify({ kind, chk }))
  const [trg] = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_trigger where tgrelid = 'public.module_roles'::regclass
      and tgname = 'module_roles_stamp_granted_by' and not tgisinternal and tgenabled <> 'D'`
  check('the granted_by stamp trigger is BOUND and enabled on module_roles', trg?.n === 1)

  const [area] = await sql<{ total: number; missing: string[] | null }[]>`
    select count(*)::int as total,
           array_agg(c.relname) filter (where not exists (
             select 1 from pg_policy p where p.polrelid = c.oid and p.polname = c.relname || '_staff_area' and not p.polpermissive
               and pg_get_expr(p.polqual, p.polrelid) like '%view_as_area_ids%')) as missing
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and (c.relname like 'cls\\_%' or c.relname like 'sal\\_%')`
  check(`every cls_/sal_ table (${area?.total}) has a restrictive _staff_area policy`, (area?.total ?? 0) > 25 && !area?.missing, JSON.stringify(area?.missing))

  const policies: [string, string, string][] = [
    ['public.module_roles', 'module_roles_staff_area', 'view_as_grant_visible'],
    ['public.orgs', 'orgs_staff_area', 'view_as_org_ok'],
    ['public.org_members', 'org_members_staff_area', 'view_as_org_ok'],
    ['public.org_modules', 'org_modules_staff_area', 'view_as_org_ok'],
    ['public.module_scope_nodes', 'module_scope_nodes_staff_area', 'view_as_org_ok'],
    ['public.profiles', 'profiles_staff_area', 'view_as_profile_ok'],
    ['public.feedback_tickets', 'feedback_tickets_no_staff_view', 'view_as_is_staff_view'],
    ['public.feedback_messages', 'feedback_messages_no_staff_view', 'view_as_is_staff_view'],
    ['storage.objects', 'view_as_staff_area_read', 'view_as_storage_may_read'],
  ]
  for (const [rel, name, fn] of policies) {
    const [p] = await sql<{ restrictive: boolean; qual: string }[]>`
      select not polpermissive as restrictive, pg_get_expr(polqual, polrelid) as qual
      from pg_policy where polrelid = ${rel}::regclass and polname = ${name}`
    check(`${rel}: restrictive ${name} using ${fn}`, !!p && p.restrictive && p.qual.includes(fn), JSON.stringify(p))
  }
  const [orgAdmin] = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_policy where polrelid = 'public.view_as_real_sessions'::regclass
      and polname = 'view_as_real_sessions_select_org_admin' and polpermissive`
  check('org admins read their org\'s staff sessions (permissive select policy)', orgAdmin?.n === 1)

  const [setting] = await sql<{ cfg: string[] }[]>`
    select setconfig as cfg from pg_db_role_setting where setrole = 'authenticator'::regrole and setdatabase = 0`
  check('the hook is still set on authenticator', (setting?.cfg ?? []).includes('pgrst.db_pre_request=public.view_as_pre_request'), JSON.stringify(setting?.cfg))
  for (const [roleName, claims] of [['anon', ''], ['authenticated', ''], ['authenticated', 'not json']] as const) {
    let outcome = ''
    await rolledBack(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${claims}, true)`
      await tx.unsafe(`set local role ${roleName}`)
      try {
        await tx`select public.view_as_pre_request()`
        const [r] = await tx<{ ro: string; v: boolean; m: boolean; i: boolean; g: boolean; o: boolean }[]>`
          select current_setting('transaction_read_only') as ro, public.in_view_as() as v,
                 public.view_as_may_read(null, 'x') as m, public.view_as_may_read_in(null, 'x', null) as i,
                 public.view_as_grant_visible(null, 'x', null) as g, public.view_as_org_ok(null) as o`
        outcome = `${r!.ro}/${r!.v}/${r!.m}/${r!.i}/${r!.g}/${r!.o}`
      } catch (e) {
        outcome = `raised: ${(e as Error).message}`
      }
    })
    check(`  the shared rules as ${roleName}, claims ${JSON.stringify(claims)}: no error, read-write, every rule true`, outcome === 'off/false/true/true/true/true', outcome)
  }

  console.log('[2] behaviour as real users (rolled back, in a throwaway org)')
  const [hasStart] = await sql<{ n: number }[]>`select count(*)::int as n from pg_proc where proname = 'view_as_staff_start' and pronamespace = 'public'::regnamespace`
  const people = await sql<{ user_id: string }[]>`
    select au.id as user_id from auth.users au
    join public.user_private u on u.user_id = au.id
    where not u.is_superadmin and au.deleted_at is null and coalesce(au.is_anonymous, false) = false
      and (au.banned_until is null or au.banned_until <= now())
      and not exists (select 1 from public.account_deletions d where d.user_id = au.id and d.state <> 'cancelled')
    order by au.created_at limit 3`
  check('CONTROL: three live, non-superadmin accounts exist', people.length === 3, `${people.length}`)
  if (hasStart?.n !== 1) {
    skipped('every behaviour probe: view_as_staff_start does not exist (the BEFORE run)')
  } else if (people.length < 3) {
    skipped('every behaviour probe: not enough accounts')
  } else {
    const [v, p, g] = people.map((r) => r.user_id) as [string, string, string]
    await rolledBack(async (tx) => {
      const attempt = async (id: string, view: string | undefined, stmt: () => Promise<postgres.RowList<postgres.Row[]>>, keep = false) => {
        await tx.unsafe('savepoint a')
        const claims: Record<string, unknown> = { sub: id, role: 'authenticated' }
        if (view) claims.view_as = { session: view, actor: v }
        await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`
        await tx.unsafe('set local role authenticated')
        if (view) await tx`select public.view_as_pre_request()`
        let err = ''
        let rows: postgres.Row[] = []
        try {
          rows = [...(await stmt())]
        } catch (e) {
          err = String((e as Error).message)
        }
        if (!err && keep) await tx.unsafe('release savepoint a')
        else await tx.unsafe('rollback to savepoint a')
        await tx.unsafe('reset role')
        await tx`select set_config('request.jwt.claims', '', true)`
        return { err, rows }
      }

      const slug = 'staff-verify-' + Date.now()
      const [org] = await tx`insert into public.orgs (name, slug) values ('Staff view verify', ${slug}) returning id`
      const orgId = org!.id as string
      await tx`insert into public.org_modules (org_id, module_key, enabled) values (${orgId}, 'classroom', true)`
      for (const id of [v, p, g]) await tx`insert into public.org_members (org_id, user_id, role, status) values (${orgId}, ${id}, 'member', 'active')`
      const [c] = await tx`insert into public.cls_courses (org_id, name) values (${orgId}, 'Verify') returning id`
      const [ka] = await tx`insert into public.cls_classes (org_id, course_id, name) values (${orgId}, ${c!.id}, 'A') returning id, scope_node_id`
      const [kb] = await tx`insert into public.cls_classes (org_id, course_id, name) values (${orgId}, ${c!.id}, 'B') returning id, scope_node_id`
      for (const k of [ka!, kb!]) {
        await tx`insert into public.module_roles (org_id, user_id, module_key, role, scope_ref) values (${orgId}, ${p}, 'classroom', 'student', ${k.scope_node_id})`
        await tx`insert into public.cls_class_members (org_id, class_id, user_id, role) values (${orgId}, ${k.id}, ${p}, 'student')`
        const [h] = await tx`insert into public.cls_homeworks (org_id, class_id, title) values (${orgId}, ${k.id}, 'hw') returning id`
        const [s] = await tx`insert into public.cls_submissions (org_id, class_id, homework_id, student_id) values (${orgId}, ${k.id}, ${h!.id}, ${p}) returning id`
        await tx`insert into storage.objects (bucket_id, name) values ('cls-submissions', ${`${orgId}/${k.id}/${s!.id}/f.R`})`
      }
      await tx`insert into public.module_roles (org_id, user_id, module_key, role, scope_ref) values (${orgId}, ${g}, 'classroom', 'ga', null)`

      // Refusals first (controls follow).
      await tx`insert into public.module_roles (org_id, user_id, module_key, role, scope_ref, granted_by) values (${orgId}, ${v}, 'classroom', 'professor', ${ka!.scope_node_id}, ${v})`
      const self = await attempt(v, undefined, () => tx`select public.view_as_staff_start(${orgId}::uuid, ${p}::uuid) as id`)
      check('  a seat the viewer gave herself is refused', /can't view/.test(self.err), self.err || 'no error')
      const peer = await attempt(g, undefined, () => tx`select public.view_as_staff_start(${orgId}::uuid, ${p}::uuid) as id`)
      check('  a GA (peer) cannot view a student', /can't view/.test(peer.err), peer.err || 'no error')
      await tx`update public.module_roles set granted_by = null where org_id = ${orgId} and user_id = ${v}`
      const st = await attempt(v, undefined, () => tx`select public.view_as_staff_start(${orgId}::uuid, ${p}::uuid) as id`, true)
      check('  CONTROL: the same seat given by someone else starts a view', !st.err && !!st.rows[0]?.id, st.err)
      const id = st.rows[0]?.id as string

      const classes = async (view?: string) =>
        (await attempt(p, view, () => tx`select id from public.cls_classes where org_id = ${orgId} order by 1`)).rows.map((r) => r.id as string)
      check('  CONTROL: the person reads classes A and B himself', (await classes()).length === 2)
      const viewed = await classes(id)
      check('  the A-scoped staff view reads class A only', viewed.length === 1 && viewed[0] === ka!.id, JSON.stringify(viewed))
      const files = async (view?: string) =>
        (await attempt(p, view, () => tx`select name from storage.objects where name like ${orgId + '/%'}`)).rows.length
      check('  files: the person reads 2, the view reads 1 (class B dark)', (await files()) === 2 && (await files(id)) === 1)
      const other = await attempt(p, id, () => tx`select count(*)::int as n from public.org_members where org_id <> ${orgId}`)
      check('  other orgs\' memberships are dark under the view', !other.err && other.rows[0]?.n === 0, other.err || JSON.stringify(other.rows))
      const plat = await attempt(p, id, () => tx`select public.view_as_platform_ok() as pl, current_setting('transaction_read_only') as ro`)
      check('  a staff token never satisfies the platform branch; read-only', plat.rows[0]?.pl === false && plat.rows[0]?.ro === 'on', plat.err || JSON.stringify(plat.rows))
      const w = await attempt(p, id, () => tx`update public.cls_class_members set role = role where org_id = ${orgId}`)
      check('  a write under the view is refused (read-only transaction)', /read-only/.test(w.err), w.err || 'no error')
      const chk = await attempt(v, undefined, () => tx`select
          (select in_scope from public.view_as_real_check(${id}::uuid, ${'/o/' + slug + '/m/classroom'}, false)) as a,
          (select in_scope from public.view_as_real_check(${id}::uuid, ${'/o/' + slug + '/m/classroom/view-as'}, false)) as b,
          (select in_scope from public.view_as_real_check(${id}::uuid, ${'/o/' + slug}, false)) as c,
          (select kind from public.view_as_real_check(${id}::uuid, ${'/dashboard'}, false)) as k`)
      check('  the check: the area module in scope; its picker, the org home and /dashboard not; kind staff',
        JSON.stringify(chk.rows[0]) === JSON.stringify({ a: true, b: false, c: false, k: 'staff' }), chk.err || JSON.stringify(chk.rows))
    })
  }

  console.log('[3] report — owners/admins holding a manager-tier seat with no recorded giver (these still enable View as)')
  const rows = await sql<{ org: string; role: string; seat: string; n: number }[]>`
    select o.slug as org, m.role, g.module_key || '/' || g.role as seat, count(*)::int as n
    from public.module_roles g
    join public.org_members m on m.org_id = g.org_id and m.user_id = g.user_id and m.role in ('owner', 'admin')
    join public.orgs o on o.id = g.org_id
    where g.granted_by is null and public.module_position_rank(g.module_key, g.role) >= 2
    group by 1, 2, 3 order by 1, 2, 3`
  if (rows.length === 0) console.log('  (none)')
  for (const r of rows) console.log(`  ${r.org}: ${r.role} holds ${r.seat}${r.n > 1 ? ` ×${r.n}` : ''}`)
} finally {
  await sql.end()
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
