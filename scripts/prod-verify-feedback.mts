// Prod verification for 20261106010000_feedback_tickets.sql (docs/27, the
// feedback/ticket tool v1).
//
//   node node_modules/tsx/dist/cli.mjs scripts/prod-verify-feedback.mts
//   node node_modules/tsx/dist/cli.mjs scripts/prod-verify-feedback.mts --local
//
// Run it BEFORE and AFTER `migrate:prod`: before, the structural checks fail
// and the CONTROLS pass; after, everything passes.
//
// [1] STRUCTURE from the catalog (each with a control): both tables, RLS on,
//     exactly one SELECT policy each with the intended arms, the REAL table
//     ACL (SELECT only for authenticated; nothing for anon / service_role),
//     the four functions' bodies md5-matching the migration, definer + pinned
//     search_path, EXECUTE for authenticated only.
// [2] BEHAVIOUR as real users, inside ONE transaction that is ALWAYS ROLLED
//     BACK, so nothing is left behind on prod: a demo member opens a ticket;
//     the author reads it; an org ADMIN of the same org does not; a direct
//     INSERT is refused; someone else's id gets "Ticket not found".
//     Uses two existing demo accounts (charlie = member, alice = owner of
//     demo-dating) — their ids only; no sign-in, no password.
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

const text = readFileSync(resolve(root, 'supabase/migrations/20261106010000_feedback_tickets.sql'), 'utf8')
const expected = new Map<string, string>()
const re = /create or replace function public\.(\w+)\([\s\S]*?\nas \$\$([\s\S]*?)\$\$;/g
for (let m = re.exec(text); m; m = re.exec(text)) expected.set(m[1]!, createHash('md5').update(m[2]!).digest('hex'))

try {
  console.log(`[1] structure — ${LOCAL ? 'LOCAL' : `PROD (${ref})`}`)
  const [{ n: allTables }] = await sql<{ n: number }[]>`select count(*)::int as n from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'`
  check('CONTROL: the catalog read works (public has tables)', allTables > 10, `${allTables}`)

  for (const t of ['feedback_tickets', 'feedback_messages']) {
    const [row] = await sql<{ rls: boolean; acl: string | null }[]>`
      select c.relrowsecurity as rls, c.relacl::text as acl from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relname = ${t}`
    check(`${t} exists`, !!row)
    check(`  RLS enabled`, row?.rls === true)
    const acl = row?.acl ?? ''
    check(`  authenticated holds SELECT only`, /authenticated=r\//.test(acl), acl)
    check(`  anon holds nothing`, !/(^|[{,])anon=/.test(acl), acl)
    check(`  service_role holds nothing`, !/service_role=/.test(acl), acl)
    const pols = await sql<{ polname: string; cmd: string; qual: string }[]>`
      select polname, polcmd::text as cmd, pg_get_expr(polqual, polrelid) as qual
      from pg_policy p join pg_class c on c.oid = p.polrelid
      where c.relnamespace = 'public'::regnamespace and c.relname = ${t}`
    check(`  exactly one policy, SELECT`, pols.length === 1 && pols[0]!.cmd === 'r', JSON.stringify(pols.map((p) => p.cmd)))
    check(`  its arms: superadmin, and the author`, /is_superadmin\(\)/.test(pols[0]?.qual ?? '') && /created_by = auth\.uid\(\)/.test(pols[0]?.qual ?? ''), pols[0]?.qual)
  }
  const [mp] = await sql<{ qual: string }[]>`select pg_get_expr(p.polqual, p.polrelid) as qual from pg_policy p join pg_class c on c.oid = p.polrelid where c.relnamespace = 'public'::regnamespace and c.relname = 'feedback_messages'`
  check('  messages: the author never reads an internal note (NOT internal arm)', /NOT internal/.test(mp?.qual ?? ''), mp?.qual)

  const fns = await sql<{ proname: string; prosecdef: boolean; proconfig: string[] | null; acl: string | null; md5: string }[]>`
    select p.proname, p.prosecdef, p.proconfig, p.proacl::text as acl, md5(p.prosrc) as md5
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'feedback\_%'`
  check('CONTROL: migration file parsed (4 bodies)', expected.size === 4, `${expected.size}`)
  for (const name of expected.keys()) {
    const f = fns.find((x) => x.proname === name)
    check(`${name} body md5 matches the migration`, f?.md5 === expected.get(name), `db=${f?.md5 ?? '-'}`)
    check(`  SECURITY DEFINER, search_path pinned`, f?.prosecdef === true && (f?.proconfig ?? []).includes('search_path=public'))
    check(`  EXECUTE: authenticated only`, /authenticated=X/.test(f?.acl ?? '') && !/(anon|service_role)=X/.test(f?.acl ?? '') && !/(^|[{,])=X/.test(f?.acl ?? ''), f?.acl ?? '-')
  }

  console.log('[2] behaviour as real users (one transaction, always rolled back)')
  const ids = await sql<{ email: string; id: string }[]>`
    select email, id::text from auth.users where email in ('charlie@demo.local', 'alice@demo.local')`
  const idOf = (e: string) => ids.find((r) => r.email === e)?.id
  const [org] = await sql<{ id: string }[]>`select id from orgs where slug = 'demo-dating'`
  check('CONTROL: demo accounts and demo-dating exist', !!idOf('charlie@demo.local') && !!idOf('alice@demo.local') && !!org)
  if (fns.length === 4 && org) {
    const out: Record<string, string | number | null> = {}
    await sql
      .begin(async (tx) => {
        const as = async (email: string, key: string, run: () => Promise<postgres.RowList<postgres.Row[]>>) => {
          await tx.unsafe('savepoint s')
          try {
            await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: idOf(email), role: 'authenticated' })}, true)`
            await tx.unsafe('set local role authenticated')
            const r = await run()
            out[key] = r.count
            out[`${key}_val`] = (r[0] as { v?: string } | undefined)?.v ?? null
            await tx.unsafe('release savepoint s')
          } catch (e) {
            await tx.unsafe('rollback to savepoint s')
            out[`${key}_err`] = String((e as Error).message)
          }
          await tx.unsafe('reset role')
        }
        await as('charlie@demo.local', 'open', () =>
          tx`select public.feedback_open('bug', 'prod verify probe', 'rolled back', ${org.id}, null, '{}'::jsonb)::text as v`)
        const id = String(out.open_val)
        await as('charlie@demo.local', 'author', () => tx`select id from feedback_tickets where id = ${id}`)
        await as('alice@demo.local', 'orgOwner', () => tx`select id from feedback_tickets where id = ${id}`)
        await as('alice@demo.local', 'orgOwnerReply', () => tx`select public.feedback_reply(${id}, 'x', false)`)
        await as('charlie@demo.local', 'direct', () => tx`insert into feedback_tickets (created_by, kind, title) values (${idOf('charlie@demo.local')!}, 'bug', 't')`)
        throw new Error('__rollback__')
      })
      .catch((e: unknown) => {
        if ((e as Error).message !== '__rollback__') throw e
      })
    check('a demo member can open a ticket', !out.open_err, String(out.open_err ?? ''))
    check('CONTROL: the author reads it', out.author === 1, JSON.stringify(out))
    check('the OWNER of that org reads nothing (org is context, never authority)', out.orgOwner === 0, JSON.stringify(out))
    check("the org owner replying gets 'Ticket not found'", /Ticket not found/.test(String(out.orgOwnerReply_err ?? '')), String(out.orgOwnerReply_err))
    check('a direct INSERT is refused', /permission denied/.test(String(out.direct_err ?? '')), String(out.direct_err))
    const [left] = await sql<{ n: number }[]>`select count(*)::int as n from feedback_tickets where title = 'prod verify probe'`
    check('nothing left behind (rolled back)', left!.n === 0)
  } else {
    check('behaviour probes (skipped: the functions are not deployed)', false)
  }
} finally {
  await sql.end()
}
console.log(`\n${pass} checks passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
