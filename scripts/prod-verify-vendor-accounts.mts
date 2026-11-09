// Prod verification for 20261113010000_vendor_accounts.sql (docs/28 Part A,
// the superadmin vendor accounts page).
//
//   node node_modules/tsx/dist/cli.mjs scripts/prod-verify-vendor-accounts.mts
//   node node_modules/tsx/dist/cli.mjs scripts/prod-verify-vendor-accounts.mts --local
//
// Run it BEFORE and AFTER `migrate:prod`: before, the structural checks fail
// and the CONTROLS pass; after, everything passes.
//
// [1] STRUCTURE from the catalog (each with a control): four tables, RLS on,
//     every policy gated on is_superadmin(), the REAL table ACL (authenticated
//     only, no DELETE on accounts, opens append-only with a column grant on
//     account_id alone; nothing for anon / service_role), the two functions'
//     bodies md5-matching the migration, EXECUTE for nobody, the three
//     secret-filter triggers BOUND (not merely defined), opened_by ON DELETE
//     SET NULL, and the seed present.
// [2] BEHAVIOUR inside ONE transaction that is ALWAYS ROLLED BACK, so nothing is
//     left behind on prod: an org owner (alice, a demo account) reads nothing
//     and cannot write; the superadmin (control) reads the seed, records an
//     open, cannot backdate or forge one, cannot delete an open; a key typed in
//     notes is refused while ordinary notes save. Ids only — no sign-in.
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

const text = readFileSync(resolve(root, 'supabase/migrations/20261113010000_vendor_accounts.sql'), 'utf8')
const expected = new Map<string, string>()
const re = /create or replace function public\.(\w+)\([\s\S]*?\nas \$\$([\s\S]*?)\$\$;/g
for (let m = re.exec(text); m; m = re.exec(text)) expected.set(m[1]!, createHash('md5').update(m[2]!).digest('hex'))

const TABLES = ['vendor_accounts', 'vendor_account_dates', 'vendor_account_credentials', 'vendor_account_opens']
// relacl privilege letters for authenticated, exactly.
const WANT_ACL: Record<string, string> = {
  vendor_accounts: 'arw',
  vendor_account_dates: 'arwd',
  vendor_account_credentials: 'arwd',
  vendor_account_opens: 'r',
}

try {
  console.log(`[1] structure — ${LOCAL ? 'LOCAL' : `PROD (${ref})`}`)
  const [{ n: allTables }] = await sql<{ n: number }[]>`select count(*)::int as n from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'`
  check('CONTROL: the catalog read works (public has tables)', allTables > 10, `${allTables}`)

  for (const t of TABLES) {
    const [row] = await sql<{ rls: boolean; acl: string | null }[]>`
      select c.relrowsecurity as rls, c.relacl::text as acl from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relname = ${t}`
    check(`${t} exists`, !!row)
    check(`  RLS enabled`, row?.rls === true)
    const acl = row?.acl ?? ''
    check(`  authenticated holds exactly ${WANT_ACL[t]}`, new RegExp(`authenticated=${WANT_ACL[t]}/`).test(acl), acl)
    check(`  anon holds nothing`, !/(^|[{,])anon=/.test(acl), acl)
    check(`  service_role holds nothing`, !/service_role=/.test(acl), acl)
    const pols = await sql<{ qual: string | null; chk: string | null }[]>`
      select pg_get_expr(polqual, polrelid) as qual, pg_get_expr(polwithcheck, polrelid) as chk
      from pg_policy p join pg_class c on c.oid = p.polrelid
      where c.relnamespace = 'public'::regnamespace and c.relname = ${t}`
    check(`  has a policy, and every one gates on is_superadmin()`,
      pols.length > 0 && pols.every((p) => /is_superadmin\(\)/.test(`${p.qual ?? ''} ${p.chk ?? ''}`)), JSON.stringify(pols))
  }

  const [cols] = await sql<{ acct: boolean; who: boolean; at: boolean }[]>`
    select has_column_privilege('authenticated', 'public.vendor_account_opens', 'account_id', 'insert') as acct,
           has_column_privilege('authenticated', 'public.vendor_account_opens', 'opened_by', 'insert') as who,
           has_column_privilege('authenticated', 'public.vendor_account_opens', 'opened_at', 'insert') as at
    where to_regclass('public.vendor_account_opens') is not null`
  check('opens: authenticated may insert account_id (control)', cols?.acct === true)
  check('opens: authenticated may NOT supply opened_by or opened_at', cols?.who === false && cols?.at === false, JSON.stringify(cols))

  const [fk] = await sql<{ del: string }[]>`
    select confdeltype::text as del from pg_constraint
    where conrelid = to_regclass('public.vendor_account_opens') and contype = 'f' and confrelid = 'auth.users'::regclass`
  check('opens.opened_by is ON DELETE SET NULL (the history outlives the account)', fk?.del === 'n', fk?.del ?? '-')

  const trig = await sql<{ tbl: string }[]>`
    select c.relname as tbl from pg_trigger g join pg_class c on c.oid = g.tgrelid
    where not g.tgisinternal and g.tgfoid = to_regprocedure('public.vendor_reject_secret_text()')`
  check('the secret filter is BOUND on accounts, dates and credentials',
    ['vendor_accounts', 'vendor_account_dates', 'vendor_account_credentials'].every((t) => trig.some((x) => x.tbl === t)),
    trig.map((x) => x.tbl).join(','))

  const fns = await sql<{ proname: string; acl: string | null; md5: string; config: string[] | null }[]>`
    select p.proname, p.proacl::text as acl, md5(p.prosrc) as md5, p.proconfig as config
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'vendor\_%'`
  check('CONTROL: migration file parsed (2 bodies)', expected.size === 2, `${expected.size}`)
  for (const name of expected.keys()) {
    const f = fns.find((x) => x.proname === name)
    check(`${name} body md5 matches the migration`, !!f && f.md5 === expected.get(name), `db=${f?.md5 ?? '-'}`)
    check(`  search_path pinned`, (f?.config ?? []).includes('search_path=public'))
    check(`  EXECUTE for no API role`, !!f && !/(anon|authenticated|service_role)=X/.test(f.acl ?? '') && !/(^|[{,])=X/.test(f.acl ?? ''), f?.acl ?? '-')
  }

  // A missing table is a parse-time error even behind a WHERE, so ask first.
  const [{ exists }] = await sql<{ exists: boolean }[]>`select to_regclass('public.vendor_accounts') is not null as exists`
  const [seed] = exists
    ? await sql<{ n: number; creds: number }[]>`
        select (select count(*)::int from vendor_accounts) n, (select count(*)::int from vendor_account_credentials) creds`
    : [undefined]
  check('the seed is present (16 accounts, 29 credential names)', seed?.n === 16 && seed?.creds === 29, JSON.stringify(seed))

  console.log('[2] behaviour (one transaction, always rolled back)')
  const [alice] = await sql<{ id: string }[]>`select id::text from auth.users where email = 'alice@demo.local'`
  const [sa] = await sql<{ id: string }[]>`select user_id::text as id from user_private where is_superadmin limit 1`
  check('CONTROL: a demo org owner and a superadmin exist', !!alice && !!sa)
  if (seed && alice && sa) {
    const out: Record<string, string | number | null> = {}
    await sql
      .begin(async (tx) => {
        const as = async (uid: string, key: string, run: () => Promise<postgres.RowList<postgres.Row[]>>) => {
          await tx.unsafe('savepoint s')
          try {
            await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: 'authenticated' })}, true)`
            await tx.unsafe('set local role authenticated')
            const r = await run()
            out[key] = r.count
            await tx.unsafe('release savepoint s')
          } catch (e) {
            await tx.unsafe('rollback to savepoint s')
            out[`${key}_err`] = String((e as Error).message)
          }
          await tx.unsafe('reset role')
        }
        const [acct] = await tx<{ id: string }[]>`select id::text from vendor_accounts where service = 'Sentry'`
        await as(alice.id, 'aliceRead', () => tx`select id from vendor_accounts`)
        await as(alice.id, 'aliceCreds', () => tx`select id from vendor_account_credentials`)
        await as(alice.id, 'aliceInsert', () => tx`insert into vendor_accounts (service) values ('prod verify probe')`)
        await as(alice.id, 'aliceOpen', () => tx`insert into vendor_account_opens (account_id) values (${acct!.id})`)
        await as(sa.id, 'saRead', () => tx`select id from vendor_accounts`)
        await as(sa.id, 'saOpen', () => tx`insert into vendor_account_opens (account_id) values (${acct!.id})`)
        await as(sa.id, 'saBackdate', () => tx`insert into vendor_account_opens (account_id, opened_at) values (${acct!.id}, now() - interval '1 day')`)
        await as(sa.id, 'saDeleteOpen', () => tx`delete from vendor_account_opens`)
        await as(sa.id, 'saDeleteAcct', () => tx`delete from vendor_accounts where id = ${acct!.id}`)
        await as(sa.id, 'saKey', () => tx`update vendor_accounts set notes = ${'backup key 9dd4e461268c8034f5c8564e155c67a6'} where id = ${acct!.id}`)
        await as(sa.id, 'saNote', () => tx`update vendor_accounts set notes = ${'Password: in 1Password; JAAS_PRIVATE_KEY in .env.deploy'} where id = ${acct!.id}`)
        throw new Error('__rollback__')
      })
      .catch((e: unknown) => {
        if ((e as Error).message !== '__rollback__') throw e
      })
    check('an org owner reads no accounts', out.aliceRead === 0, JSON.stringify(out))
    check('an org owner reads no credential names', out.aliceCreds === 0, JSON.stringify(out))
    check('an org owner cannot add an account', /row-level security/.test(String(out.aliceInsert_err ?? '')), String(out.aliceInsert_err))
    check('an org owner cannot record an open', /row-level security/.test(String(out.aliceOpen_err ?? '')), String(out.aliceOpen_err))
    check('CONTROL: the superadmin reads the seed', out.saRead === seed.n, JSON.stringify(out))
    check('CONTROL: the superadmin records an open', out.saOpen === 1, String(out.saOpen_err ?? ''))
    check('an open cannot be backdated', /permission denied/.test(String(out.saBackdate_err ?? '')), String(out.saBackdate_err))
    check('an open cannot be deleted', /permission denied/.test(String(out.saDeleteOpen_err ?? '')), String(out.saDeleteOpen_err))
    check('an account cannot be deleted (closed instead)', /permission denied/.test(String(out.saDeleteAcct_err ?? '')), String(out.saDeleteAcct_err))
    check('a key typed in notes is refused', /never stores passwords or keys/.test(String(out.saKey_err ?? '')), String(out.saKey_err))
    check('CONTROL: ordinary notes save', out.saNote === 1, String(out.saNote_err ?? ''))
    const [left] = await sql<{ n: number }[]>`select count(*)::int as n from vendor_accounts where service = 'prod verify probe'`
    check('nothing left behind (rolled back)', left!.n === 0)
  } else {
    check('behaviour probes (skipped: the tables are not deployed)', false)
  }
} finally {
  await sql.end()
}
console.log(`\n${pass} checks passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
