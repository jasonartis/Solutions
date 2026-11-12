// Prod verification for 20261115010000_platform_storage_usage.sql (the Owner
// Console's size per organization and module).
//
//   node node_modules/tsx/dist/cli.mjs scripts/prod-verify-storage-usage.mts
//   node node_modules/tsx/dist/cli.mjs scripts/prod-verify-storage-usage.mts --local
//
// Run it BEFORE and AFTER `migrate:prod`: before, the function checks fail and
// the CONTROLS pass; after, everything passes.
//
// [1] STRUCTURE: the function exists, its body md5-matches the migration, it
//     is a definer with search_path '' and lock_timeout pinned, EXECUTE for
//     authenticated only (prod's default privileges would otherwise hand it to
//     anon and service_role too).
// [2] THE PROD DEPENDENCY the correctness review found: the owner must bypass
//     RLS, or storage.objects' policies FILTER and files read as 0 bytes with
//     no error. Asserted directly, and by comparing the function's file count
//     with a direct count.
// [3] BEHAVIOUR as real users, inside ONE transaction that is ALWAYS ROLLED
//     BACK: an ordinary member is refused; the superadmin gets rows whose
//     table bytes add up to the catalog. (Read-only either way: the function
//     writes nothing.)
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

const text = readFileSync(resolve(root, 'supabase/migrations/20261115010000_platform_storage_usage.sql'), 'utf8')
const body = /create or replace function public\.platform_storage_usage\(\)[\s\S]*?\nas \$\$([\s\S]*?)\$\$;/.exec(text)?.[1]
const expectedMd5 = body ? createHash('md5').update(body).digest('hex') : ''

try {
  console.log(`[1] structure — ${LOCAL ? 'LOCAL' : `PROD (${ref})`}`)
  const [{ n: allFns }] = await sql<{ n: number }[]>`select count(*)::int as n from pg_proc where pronamespace = 'public'::regnamespace`
  check('CONTROL: the catalog read works (public has functions)', allFns > 50, `${allFns}`)
  check('CONTROL: the migration file parsed', expectedMd5.length === 32)

  const [f] = await sql<{ secdef: boolean; config: string[] | null; acl: string | null; md5: string; owner: string }[]>`
    select p.prosecdef as secdef, p.proconfig as config, p.proacl::text as acl, md5(p.prosrc) as md5,
           pg_get_userbyid(p.proowner) as owner
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'platform_storage_usage'`
  check('platform_storage_usage exists', !!f)
  check('  body md5 matches the migration', f?.md5 === expectedMd5, `db=${f?.md5 ?? '-'}`)
  check('  SECURITY DEFINER', f?.secdef === true)
  check(`  search_path '' and lock_timeout pinned`, JSON.stringify(f?.config) === JSON.stringify(['search_path=""', 'lock_timeout=2s']), JSON.stringify(f?.config))
  const acl = f?.acl ?? ''
  check('  authenticated may EXECUTE', /authenticated=X\//.test(acl), acl)
  check('  anon may not', !/(^|[{,])anon=/.test(acl), acl)
  check('  service_role may not', !/service_role=/.test(acl), acl)
  check('  PUBLIC may not', !/(^|[{,])=X\//.test(acl), acl)

  console.log('[2] the owner bypasses RLS (else files silently read as 0)')
  const [o] = await sql<{ bypass: boolean; can_read: boolean }[]>`
    select r.rolbypassrls as bypass, has_table_privilege(r.oid, 'storage.objects', 'select') as can_read
    from pg_roles r where r.rolname = ${f?.owner ?? 'postgres'}`
  check(`  owner ${f?.owner ?? '?'} has BYPASSRLS`, o?.bypass === true)
  check('  owner may SELECT storage.objects', o?.can_read === true)
  const [{ n: forced }] = await sql<{ n: number }[]>`select count(*)::int as n from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relforcerowsecurity`
  check('  no public table forces RLS on its owner', forced === 0, `${forced}`)

  console.log('[3] behaviour as real users (rolled back)')
  const [sa] = await sql<{ user_id: string }[]>`select user_id from public.user_private where is_superadmin limit 1`
  const [mem] = await sql<{ user_id: string }[]>`
    select m.user_id from public.org_members m join public.user_private u on u.user_id = m.user_id
    where not u.is_superadmin and m.status = 'active' limit 1`
  check('CONTROL: a superadmin and an ordinary member exist', !!sa && !!mem)

  if (f && sa && mem) {
    await sql
      .begin(async (tx) => {
        const asUser = async (id: string) => {
          await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: id, role: 'authenticated' })}, true)`
          await tx.unsafe('set local role authenticated')
        }
        await tx.unsafe('savepoint a')
        await asUser(mem.user_id)
        let refused = ''
        try {
          await tx`select * from public.platform_storage_usage()`
        } catch (e) {
          refused = String((e as Error).message)
        }
        await tx.unsafe('rollback to savepoint a')
        check('  an ordinary member is refused ("Not allowed")', /Not allowed/.test(refused), refused || 'no error')

        await tx.unsafe('reset role')
        const [cat] = await tx<{ bytes: string; objects: string }[]>`
          select (select sum(pg_total_relation_size(c.oid)) from pg_class c
                  where c.relnamespace = 'public'::regnamespace and c.relkind = 'r')::bigint as bytes,
                 (select count(*) from storage.objects)::bigint as objects`
        await asUser(sa.user_id)
        const rows = await tx<{ kind: string; item_count: string | null; bytes: string }[]>`select * from public.platform_storage_usage()`
        const tables = rows.filter((r) => r.kind === 'table')
        const tableSum = tables.reduce((n, r) => n + Number(r.bytes), 0)
        const fileCount = rows.filter((r) => r.kind === 'bucket').reduce((n, r) => n + Number(r.item_count), 0)
        check('  the superadmin gets a database row', rows.some((r) => r.kind === 'database' && Number(r.bytes) > 0))
        check('  table bytes add up to the catalog (±1 per row)', Math.abs(tableSum - Number(cat!.bytes)) <= tables.length, `${tableSum} vs ${cat!.bytes}`)
        check('  file count equals a direct count of storage.objects', fileCount === Number(cat!.objects), `${fileCount} vs ${cat!.objects}`)
        throw new Error('__rollback__')
      })
      .catch((e: unknown) => {
        if ((e as Error)?.message !== '__rollback__') throw e
      })
  }
} finally {
  await sql.end()
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
