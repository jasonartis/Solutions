// Prod verification for 20261116010000_real_view_as.sql (docs/13 "REAL VIEW-AS"
// → "THE DESIGN", 2026-11-12).
//
//   node node_modules/tsx/dist/cli.mjs scripts/prod-verify-real-view-as.mts
//   node node_modules/tsx/dist/cli.mjs scripts/prod-verify-real-view-as.mts --local
//
// Run it BEFORE and AFTER `migrate:prod`: before, the structure checks fail and
// the CONTROLS pass (including [0], which proves the migration's ALTER ROLE is
// permitted on hosted Supabase, inside a rolled-back transaction); after,
// everything passes.
//
// [0] PRE-FLIGHT: may `postgres` set pgrst.db_pre_request on `authenticator`?
//     (Rolled back. Hosted Supabase's supautils decides this, not the catalog.)
// [1] STRUCTURE: the five functions (bodies md5-match the migration; definer or
//     not as intended; search_path pinned; EXECUTE exactly as intended), the
//     hook set on authenticator, the restrictive policies on storage.objects and
//     sd_notes, the two log tables (RLS on, SELECT-only for authenticated).
// [2] BEHAVIOUR as real users, inside ONE transaction that is ALWAYS ROLLED
//     BACK: a member cannot start a view; the superadmin can, the check scopes
//     the path; with the view_as claim the pre-request hook makes a write fail
//     as read-only, and the same write succeeds without it (the control); a
//     storage insert with the claim is refused.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL = process.argv.includes('--local')

let ref = '(local)'
let sql: ReturnType<typeof postgres>
if (LOCAL) {
  sql = postgres(process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres', { max: 1 })
} else {
  const env = readFileSync(resolve(root, '.env.deploy'), 'utf8')
  const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''
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
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${detail})`}`)
}

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

const text = readFileSync(resolve(root, 'supabase/migrations/20261116010000_real_view_as.sql'), 'utf8')
const expected = new Map<string, string>()
const re = /create or replace function public\.(\w+)\([\s\S]*?\nas \$\$([\s\S]*?)\$\$;/g
for (let m = re.exec(text); m; m = re.exec(text)) expected.set(m[1]!, createHash('md5').update(m[2]!).digest('hex'))

// name -> [security definer?, anon?, authenticated?, service_role?]
const INTENT: Record<string, [boolean, boolean, boolean, boolean]> = {
  is_view_as_request: [false, true, true, true],
  view_as_pre_request: [false, true, true, true],
  view_as_real_start: [true, false, true, false],
  view_as_real_check: [true, false, true, false],
  view_as_real_end: [true, false, true, false],
}

try {
  console.log(`[0] pre-flight — ${LOCAL ? 'LOCAL' : `PROD (${ref})`}`)
  let alterOk = ''
  await rolledBack(async (tx) => {
    try {
      await tx.unsafe(`alter role authenticator set pgrst.db_pre_request = 'public.view_as_pre_request'`)
      alterOk = 'ok'
    } catch (e) {
      alterOk = String((e as Error).message)
    }
  })
  check('postgres may set pgrst.db_pre_request on authenticator (rolled back)', alterOk === 'ok', alterOk)

  console.log('[1] structure')
  const [{ n: allFns }] = await sql<{ n: number }[]>`select count(*)::int as n from pg_proc where pronamespace = 'public'::regnamespace`
  check('CONTROL: the catalog read works', allFns > 50, `${allFns}`)
  check('CONTROL: the migration file parsed (5 bodies)', expected.size === 5, `${expected.size}`)
  for (const [name, [secdef, anon, auth, svc]] of Object.entries(INTENT)) {
    const [f] = await sql<{ secdef: boolean; config: string[] | null; md5: string; a: boolean; u: boolean; s: boolean; p: boolean }[]>`
      select p.prosecdef as secdef, p.proconfig as config, md5(p.prosrc) as md5,
             has_function_privilege('anon', p.oid, 'execute') as a,
             has_function_privilege('authenticated', p.oid, 'execute') as u,
             has_function_privilege('service_role', p.oid, 'execute') as s,
             coalesce(p.proacl::text, '') ~ '(^|[{,])=X/' as p
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = ${name}`
    check(`${name} exists, body matches the migration`, f?.md5 === expected.get(name), `db=${f?.md5 ?? '-'}`)
    check(`  definer = ${secdef}, search_path pinned`, f?.secdef === secdef && JSON.stringify(f?.config) === '["search_path=\\"\\""]', JSON.stringify(f?.config))
    check(`  EXECUTE anon=${anon} authenticated=${auth} service_role=${svc}, never PUBLIC`, !!f && f.a === anon && f.u === auth && f.s === svc && !f.p, f ? `${f.a}/${f.u}/${f.s}/public=${f.p}` : '-')
  }
  const [role] = await sql<{ cfg: string[] }[]>`select rolconfig as cfg from pg_roles where rolname = 'authenticator'`
  check('the hook is set on authenticator', (role?.cfg ?? []).includes('pgrst.db_pre_request=public.view_as_pre_request'), JSON.stringify(role?.cfg))
  const [setting] = await sql<{ cfg: string[] }[]>`
    select setconfig as cfg from pg_db_role_setting where setrole = 'authenticator'::regrole and setdatabase = 0`
  check('  ... and in pg_db_role_setting (what PostgREST reloads)', (setting?.cfg ?? []).includes('pgrst.db_pre_request=public.view_as_pre_request'), JSON.stringify(setting?.cfg))

  // Fable review finding 3: EVERY API request now runs the hook, so it must never
  // raise and must leave ordinary requests read-write. Called as anon and as
  // authenticated with empty claims, and with claims that are not JSON.
  if (expected.size === 5) {
    for (const [roleName, claims] of [['anon', ''], ['authenticated', ''], ['authenticated', 'not json']] as const) {
      let outcome = ''
      await rolledBack(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${claims}, true)`
        await tx.unsafe(`set local role ${roleName}`)
        try {
          await tx`select public.view_as_pre_request()`
          const [r] = await tx<{ ro: string }[]>`select current_setting('transaction_read_only') as ro`
          outcome = r!.ro
        } catch (e) {
          outcome = `raised: ${(e as Error).message}`
        }
      })
      check(`  the hook as ${roleName} with claims ${JSON.stringify(claims)}: no error, stays read-write`, outcome === 'off', outcome)
    }
  }
  const [{ n: blocked }] = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname ~ '^(mm|syn|vm|sal|sd|smp)_'
      and not exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = c.relname || '_no_view_as' and not p.polpermissive)`
  check('every non-allowed module table carries its restrictive _no_view_as policy', blocked === 0, `${blocked} without`)

  const pols = await sql<{ polname: string; rel: string; permissive: boolean; cmd: string }[]>`
    select polname, polrelid::regclass::text as rel, polpermissive as permissive, polcmd::text as cmd
    from pg_policy where polname in ('view_as_no_insert', 'view_as_no_update', 'view_as_no_delete', 'sd_notes_no_view_as')`
  for (const [name, rel, cmd] of [
    ['view_as_no_insert', 'storage.objects', 'a'],
    ['view_as_no_update', 'storage.objects', 'w'],
    ['view_as_no_delete', 'storage.objects', 'd'],
    ['sd_notes_no_view_as', 'sd_notes', '*'],
  ] as const) {
    const p = pols.find((x) => x.polname === name)
    check(`policy ${name} on ${rel}: RESTRICTIVE, command ${cmd}`, !!p && p.rel.endsWith(rel) && !p.permissive && p.cmd === cmd, JSON.stringify(p))
  }

  for (const t of ['view_as_real_sessions', 'view_as_real_page_views']) {
    const [row] = await sql<{ rls: boolean; acl: string | null }[]>`
      select relrowsecurity as rls, relacl::text as acl from pg_class where relnamespace = 'public'::regnamespace and relname = ${t}`
    const acl = row?.acl ?? ''
    check(`${t}: exists, RLS on`, row?.rls === true)
    check(`  authenticated SELECT only; anon and service_role nothing`, /authenticated=r\//.test(acl) && !/(^|[{,])anon=/.test(acl) && !/service_role=/.test(acl), acl)
  }

  console.log('[2] behaviour as real users (rolled back)')
  const [sa] = await sql<{ user_id: string }[]>`select user_id from public.user_private where is_superadmin limit 1`
  const [target] = await sql<{ user_id: string; org_id: string; slug: string }[]>`
    select m.user_id, m.org_id, o.slug from public.org_members m
    join public.orgs o on o.id = m.org_id
    join public.org_modules om on om.org_id = m.org_id and om.module_key = 'classroom' and om.enabled
    join public.user_private u on u.user_id = m.user_id
    where coalesce(m.status, 'active') = 'active' and not u.is_superadmin limit 1`
  check('CONTROL: a superadmin and a classroom member exist', !!sa && !!target)
  if (sa && target && expected.size === 5 && pols.length === 4) {
    await rolledBack(async (tx) => {
      const asUser = async (id: string, viewAs = false) => {
        const claims: Record<string, unknown> = { sub: id, role: 'authenticated' }
        if (viewAs) claims.view_as = { session: 'verify', actor: sa.user_id }
        await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`
        await tx.unsafe('set local role authenticated')
      }
      const attempt = async (id: string, viewAs: boolean, stmt: () => Promise<unknown>) => {
        await tx.unsafe('savepoint a')
        await asUser(id, viewAs)
        let err = ''
        try {
          await stmt()
        } catch (e) {
          err = String((e as Error).message)
        }
        await tx.unsafe('rollback to savepoint a')
        await tx.unsafe('reset role')
        return err
      }
      const memberStart = await attempt(target.user_id, false, () =>
        tx`select public.view_as_real_start(${sa.user_id}, ${target.org_id}, 'classroom')`)
      check('  a member cannot start a view', /Not allowed/.test(memberStart), memberStart || 'no error')

      await tx.unsafe('savepoint b')
      await asUser(sa.user_id)
      const [{ id }] = await tx`select public.view_as_real_start(${target.user_id}, ${target.org_id}, 'classroom') as id`
      const [inside] = await tx`select * from public.view_as_real_check(${id}, ${`/o/${target.slug}/m/classroom`}, true)`
      const [outside] = await tx`select * from public.view_as_real_check(${id}, '/console', true)`
      check('  the superadmin starts a view; the check scopes the path', inside?.in_scope === true && outside?.in_scope === false)
      await tx.unsafe('rollback to savepoint b')
      await tx.unsafe('reset role')

      const blocked = await attempt(target.user_id, true, async () => {
        await tx`select public.view_as_pre_request()`
        await tx`select public.feedback_open('bug', 'verify title', 'verify body', null, null, '{}'::jsonb)`
      })
      check('  WITH the view_as claim, a write inside a definer fails as read-only', /read-only transaction/.test(blocked), blocked || 'no error')
      const allowed = await attempt(target.user_id, false, async () => {
        await tx`select public.view_as_pre_request()`
        await tx`select public.feedback_open('bug', 'verify title', 'verify body', null, null, '{}'::jsonb)`
      })
      check('  CONTROL: the same write WITHOUT the claim succeeds (then rolled back)', allowed === '', allowed)
      const put = await attempt(target.user_id, true, () =>
        tx`insert into storage.objects (bucket_id, name, owner) values ('vm-images', 'verify/x.png', ${target.user_id})`)
      check('  WITH the claim, a storage insert is refused', /row-level security/.test(put), put || 'no error')
    })
  }
} finally {
  await sql.end()
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
