// Prod verification for 20261110010000_sd_side_lock.sql (speed dating: a seat's side cannot change once the
// event has run a round — module-6 spec 2026-11-05, "closing the review").
//
//   node node_modules/tsx/dist/cli.mjs scripts/prod-verify-sd-side-lock.mts
//   node node_modules/tsx/dist/cli.mjs scripts/prod-verify-sd-side-lock.mts --local
//
// Run it BEFORE and AFTER `migrate:prod`: before, the structure checks and the "after round 1" probes fail
// and the CONTROLS pass; after, everything passes.
//
// [1] STRUCTURE (each with a control): the function body md5-matches the migration, SECURITY DEFINER with a
//     pinned search_path, no API role can EXECUTE it, the trigger is BOUND and enabled.
// [2] BEHAVIOUR inside ONE transaction that is ALWAYS ROLLED BACK: a throwaway event in demo-dating with
//     charlie seated on side a; alice (organizer) moves him before any round (control), then a round is
//     added and alice's move AND the backend's move are refused; another column still updates (control).
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

const text = readFileSync(resolve(root, 'supabase/migrations/20261110010000_sd_side_lock.sql'), 'utf8')
const body = /create or replace function public\.sd_lock_side_after_rounds\(\)[\s\S]*?\nas \$\$([\s\S]*?)\$\$;/.exec(text)?.[1]
const expectedMd5 = body ? createHash('md5').update(body).digest('hex') : null

try {
  console.log(`[1] structure — ${LOCAL ? 'LOCAL' : `PROD (${ref})`}`)
  const [{ n: trig }] = await sql<{ n: number }[]>`select count(*)::int as n from pg_trigger where tgrelid = 'public.sd_participants'::regclass and not tgisinternal`
  check('CONTROL: the catalog read works (sd_participants has triggers)', trig > 0, `${trig}`)
  check('CONTROL: the migration body parsed', expectedMd5 !== null)
  const [fn] = await sql<{ md5: string; prosecdef: boolean; proconfig: string[] | null; acl: string | null }[]>`
    select md5(p.prosrc) as md5, p.prosecdef, p.proconfig, p.proacl::text as acl
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'sd_lock_side_after_rounds'`
  check('sd_lock_side_after_rounds body md5 matches the migration', fn?.md5 === expectedMd5, `db=${fn?.md5 ?? '-'}`)
  check('  SECURITY DEFINER, search_path pinned', fn?.prosecdef === true && (fn?.proconfig ?? []).includes('search_path=public'))
  check('  no API role can EXECUTE it', !!fn && !/(anon|authenticated|service_role)=X/.test(fn.acl ?? '') && !/(^|[{,])=X/.test(fn.acl ?? ''), fn?.acl ?? '-')
  const [t] = await sql<{ enabled: string; fn: string }[]>`
    select t.tgenabled::text as enabled, p.proname as fn from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.sd_participants'::regclass and t.tgname = 'sd_participants_side_lock'`
  check('trigger sd_participants_side_lock is bound to it and enabled', t?.fn === 'sd_lock_side_after_rounds' && t?.enabled === 'O', JSON.stringify(t))

  console.log('[2] behaviour (one transaction, always rolled back)')
  const ids = await sql<{ email: string; id: string }[]>`select email, id::text from auth.users where email in ('charlie@demo.local', 'alice@demo.local')`
  const idOf = (e: string) => ids.find((r) => r.email === e)?.id
  const [org] = await sql<{ id: string }[]>`select id from orgs where slug = 'demo-dating'`
  check('CONTROL: demo accounts and demo-dating exist', !!idOf('charlie@demo.local') && !!idOf('alice@demo.local') && !!org)
  if (org) {
    const out: Record<string, string | number | null> = {}
    await sql
      .begin(async (tx) => {
        const as = async (email: string | null, key: string, run: () => Promise<postgres.RowList<postgres.Row[]>>) => {
          await tx.unsafe('savepoint s')
          try {
            if (email) {
              await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: idOf(email), role: 'authenticated' })}, true)`
              await tx.unsafe('set local role authenticated')
            }
            const r = await run()
            out[key] = r.count
            await tx.unsafe('release savepoint s')
          } catch (e) {
            await tx.unsafe('rollback to savepoint s')
            out[`${key}_err`] = String((e as Error).message)
          }
          await tx.unsafe('reset role')
        }
        const sides = { sides: { a: { label: 'A', capacity: null }, b: { label: 'B', capacity: null } } }
        const [ev] = await tx<{ id: string }[]>`
          insert into sd_events (org_id, name, state, format) values (${org.id}, 'prod verify side lock', 'running', ${tx.json(sides)}) returning id`
        const [seat] = await tx<{ id: string }[]>`
          insert into sd_participants (org_id, event_id, user_id, status, pool_side) values (${org.id}, ${ev!.id}, ${idOf('charlie@demo.local')!}, 'registered', 'a') returning id`
        await as('alice@demo.local', 'beforeRound', () => tx`update sd_participants set pool_side = 'b' where id = ${seat!.id}`)
        await tx`insert into sd_rounds (org_id, event_id, round_number) values (${org.id}, ${ev!.id}, 1)`
        await as('alice@demo.local', 'organizer', () => tx`update sd_participants set pool_side = 'a' where id = ${seat!.id}`)
        await as(null, 'backend', () => tx`update sd_participants set pool_side = 'a' where id = ${seat!.id}`)
        await as('alice@demo.local', 'otherColumn', () => tx`update sd_participants set status = 'removed' where id = ${seat!.id}`)
        throw new Error('__rollback__')
      })
      .catch((e: unknown) => {
        if ((e as Error).message !== '__rollback__') throw e
      })
    check('CONTROL: before any round, the organizer moves the seat', out.beforeRound === 1, JSON.stringify(out))
    check('after round 1, the organizer is refused', /A side cannot be changed once rounds have run/.test(String(out.organizer_err ?? '')), JSON.stringify(out))
    check('after round 1, the backend (no JWT) is refused too', /A side cannot be changed once rounds have run/.test(String(out.backend_err ?? '')), JSON.stringify(out))
    check('CONTROL: another column on the same seat still updates', out.otherColumn === 1, JSON.stringify(out))
    const [left] = await sql<{ n: number }[]>`select count(*)::int as n from sd_events where name = 'prod verify side lock'`
    check('nothing left behind (rolled back)', left!.n === 0)
  }
} finally {
  await sql.end()
}
console.log(`\n${pass} checks passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
