// Prod verification for 20261114010000_content_reports.sql (module-9 spec
// §B1/§H(c): the public Report content route).
//
//   node node_modules/tsx/dist/cli.mjs scripts/prod-verify-content-reports.mts
//   node node_modules/tsx/dist/cli.mjs scripts/prod-verify-content-reports.mts --local
//
// Run it BEFORE and AFTER `migrate:prod`: before, the structural checks fail
// and the CONTROLS pass; after, everything passes except [3] until the
// server's token is installed (scripts/set-content-report-token.mts).
//
// [1] STRUCTURE (each with a control): three tables, RLS on, one SELECT
//     policy on content_reports (superadmin) and NONE on the intake tables,
//     the REAL table ACLs, four function bodies md5-matching the migration,
//     definer + pinned search_path, and EXECUTE exactly as intended (anon on
//     the two token-gated intake functions only; service_role on none).
// [2] BEHAVIOUR, inside ONE transaction that is ALWAYS ROLLED BACK (a probe
//     token is installed inside it, so prod's real token is never touched):
//     anon submits with the token and is refused without it; anon cannot read;
//     a demo member reads nothing and gets "Report not found"; the superadmin
//     reads the report and closes it; the 6th report from one address is refused.
// [3] DATA: intake is configured on prod (a token hash exists). Without it the
//     route is structurally perfect and refuses every real report.
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

const text = readFileSync(resolve(root, 'supabase/migrations/20261114010000_content_reports.sql'), 'utf8')
const expected = new Map<string, string>()
const re = /create or replace function public\.(\w+)\([\s\S]*?\nas \$\$([\s\S]*?)\$\$;/g
for (let m = re.exec(text); m; m = re.exec(text)) expected.set(m[1]!, createHash('md5').update(m[2]!).digest('hex'))
const ANON_OK = new Set(['content_report_submit', 'content_report_note_refusal'])
const PROBE_TOKEN = `prod-verify-${Date.now()}`

try {
  console.log(`[1] structure — ${LOCAL ? 'LOCAL' : `PROD (${ref})`}`)
  const [{ n: allTables }] = await sql<{ n: number }[]>`select count(*)::int as n from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'`
  check('CONTROL: the catalog read works (public has tables)', allTables > 10, `${allTables}`)

  const want: Record<string, { authSelect: boolean; policy: boolean }> = {
    content_reports: { authSelect: true, policy: true },
    content_report_intake_config: { authSelect: false, policy: false },
    content_report_intake: { authSelect: false, policy: false },
  }
  for (const [t, w] of Object.entries(want)) {
    const [row] = await sql<{ rls: boolean; acl: string | null }[]>`
      select c.relrowsecurity as rls, c.relacl::text as acl from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relname = ${t}`
    check(`${t} exists`, !!row)
    check(`  RLS enabled`, row?.rls === true)
    const acl = row?.acl ?? ''
    if (w.authSelect) check(`  authenticated holds SELECT only`, /authenticated=r\//.test(acl), acl)
    else check(`  authenticated holds nothing`, !!row && !/authenticated=/.test(acl), acl)
    check(`  anon holds nothing`, !!row && !/(^|[{,])anon=/.test(acl), acl)
    check(`  service_role holds nothing`, !!row && !/service_role=/.test(acl), acl)
    const pols = await sql<{ cmd: string; qual: string }[]>`
      select polcmd::text as cmd, pg_get_expr(polqual, polrelid) as qual
      from pg_policy p join pg_class c on c.oid = p.polrelid
      where c.relnamespace = 'public'::regnamespace and c.relname = ${t}`
    if (w.policy) {
      check(`  exactly one policy, SELECT, superadmin only`,
        pols.length === 1 && pols[0]!.cmd === 'r' && /^is_superadmin\(\)$/.test(pols[0]!.qual ?? ''), JSON.stringify(pols))
    } else {
      check(`  NO policy (no API role reads it)`, !!row && pols.length === 0, JSON.stringify(pols))
    }
  }

  const fns = await sql<{ proname: string; prosecdef: boolean; proconfig: string[] | null; acl: string | null; md5: string }[]>`
    select p.proname, p.prosecdef, p.proconfig, p.proacl::text as acl, md5(p.prosrc) as md5
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'content\_report\_%'`
  check('CONTROL: migration file parsed (4 bodies)', expected.size === 4, `${expected.size}`)
  for (const name of expected.keys()) {
    const f = fns.find((x) => x.proname === name)
    const acl = f?.acl ?? ''
    check(`${name} body md5 matches the migration`, f?.md5 === expected.get(name), `db=${f?.md5 ?? '-'}`)
    check(`  SECURITY DEFINER, search_path pinned`, f?.prosecdef === true && (f?.proconfig ?? []).includes('search_path=public'))
    check(`  EXECUTE: authenticated${ANON_OK.has(name) ? ' + anon' : ' only'}; never service_role or PUBLIC`,
      /authenticated=X/.test(acl) && /anon=X/.test(acl) === ANON_OK.has(name) && !/service_role=X/.test(acl) && !/(^|[{,])=X/.test(acl), acl || '-')
  }

  console.log('[2] behaviour (one transaction, always rolled back)')
  const [charlie] = await sql<{ id: string }[]>`select id::text from auth.users where email = 'charlie@demo.local'`
  const [sa] = await sql<{ id: string }[]>`select user_id::text as id from user_private where is_superadmin limit 1`
  check('CONTROL: a demo member and the superadmin exist', !!charlie && !!sa)
  if (fns.length === 4 && charlie && sa) {
    const out: Record<string, string | number | null> = {}
    await sql
      .begin(async (tx) => {
        const as = async (who: 'anon' | string, key: string, run: () => Promise<postgres.RowList<postgres.Row[]>>) => {
          await tx.unsafe('savepoint s')
          try {
            if (who === 'anon') await tx.unsafe('set local role anon')
            else {
              await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: who, role: 'authenticated' })}, true)`
              await tx.unsafe('set local role authenticated')
            }
            const r = await run()
            out[key] = r.count
            out[`${key}_val`] = (r[0] as { v?: string } | undefined)?.v ?? null
            await tx.unsafe('release savepoint s')
          } catch (e) {
            await tx.unsafe('rollback to savepoint s')
            out[`${key}_err`] = String((e as Error).message)
          }
          await tx.unsafe('reset role')
          await tx`select set_config('request.jwt.claims', '', true)`
        }
        await tx`insert into content_report_intake_config (id, token_sha256)
                 values (true, encode(sha256(convert_to(${PROBE_TOKEN}, 'UTF8')), 'hex'))
                 on conflict (id) do update set token_sha256 = excluded.token_sha256`
        const submit = (token: string | null, ip: string, where: string) =>
          tx`select public.content_report_submit(${token}, ${ip}, ${where}, 'other', null, 'probe@example.test', true, null, false)`
        await as('anon', 'submit', () => submit(PROBE_TOKEN, '192.0.2.1', 'prod verify probe'))
        await as('anon', 'noToken', () => submit(null, '192.0.2.1', 'prod verify probe 2'))
        await as('anon', 'anonRead', () => tx`select id from content_reports`)
        await as(charlie.id, 'memberRead', () => tx`select id from content_reports where where_seen = 'prod verify probe'`)
        await as(sa.id, 'saRead', () => tx`select id::text as v from content_reports where where_seen = 'prod verify probe'`)
        const id = String(out.saRead_val)
        await as(charlie.id, 'memberSet', () => tx`select public.content_report_set_status(${id}, 'dismissed', null)`)
        await as(sa.id, 'saSet', () => tx`select status as v from content_reports where id = ${id} and public.content_report_set_status(${id}, 'actioned', 'probe') is null`)
        for (let i = 0; i < 4; i++) await as('anon', `fill${i}`, () => submit(PROBE_TOKEN, '192.0.2.1', `prod verify fill ${i}`))
        await as('anon', 'sixth', () => submit(PROBE_TOKEN, '192.0.2.1', 'prod verify sixth'))
        throw new Error('__rollback__')
      })
      .catch((e: unknown) => {
        if ((e as Error).message !== '__rollback__') throw e
      })
    check('anon submits with the token', !out.submit_err, String(out.submit_err ?? ''))
    check("anon without the token: 'Report intake unavailable'", /Report intake unavailable/.test(String(out.noToken_err ?? '')), String(out.noToken_err))
    check('anon cannot read reports', /permission denied/.test(String(out.anonRead_err ?? '')), String(out.anonRead_err))
    check('CONTROL: the superadmin reads the report', out.saRead === 1, JSON.stringify(out))
    check('a demo member reads nothing', out.memberRead === 0, JSON.stringify(out))
    check("a demo member changing status: 'Report not found'", /Report not found/.test(String(out.memberSet_err ?? '')), String(out.memberSet_err))
    check('the superadmin closes it', !out.saSet_err, String(out.saSet_err ?? ''))
    check('the 6th report from one address is refused', /Too many reports/.test(String(out.sixth_err ?? '')), String(out.sixth_err))
    const [left] = await sql<{ n: number }[]>`select count(*)::int as n from content_reports where where_seen like 'prod verify%'`
    check('nothing left behind (rolled back)', left!.n === 0)
  } else {
    check('behaviour probes (skipped: the functions are not deployed)', false)
  }

  console.log('[3] data')
  const [cfg] = fns.length === 4
    ? await sql<{ n: number }[]>`select count(*)::int as n from content_report_intake_config`
    : [{ n: 0 }]
  check('intake is configured (the server token hash is installed)', cfg!.n === 1, 'run scripts/set-content-report-token.mts')
} finally {
  await sql.end()
}
console.log(`\n${pass} checks passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
