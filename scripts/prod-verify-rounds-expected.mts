// Prod verification for 20261107010000_sd_rounds_expected.sql (speed dating: the dater's "round X of N"
// follows who is actually there — module-6 spec 2026-11-05).
//
//   node node_modules/tsx/dist/cli.mjs scripts/prod-verify-rounds-expected.mts
//   node node_modules/tsx/dist/cli.mjs scripts/prod-verify-rounds-expected.mts --local
//
// Run it BEFORE and AFTER `migrate:prod`: before, the column checks fail and the CONTROLS pass; after,
// everything passes.
//
// [1] STRUCTURE from the catalog (each with a control): sd_events.rounds_expected exists, integer, nullable,
//     no default, its CHECK bounds it to 1..99; no column-level ACL (it inherits the table's, unchanged);
//     rounds_planned still there.
// [2] BEHAVIOUR as real users, inside ONE transaction that is ALWAYS ROLLED BACK: the organizer (alice) can
//     write it; a participant (charlie) cannot (0 rows); charlie can READ it on an event he can see; the
//     CHECK refuses 0 and 100. Uses demo accounts' ids only — no sign-in, no password.
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

try {
  console.log(`[1] structure — ${LOCAL ? 'LOCAL' : `PROD (${ref})`}`)
  const cols = await sql<{ attname: string; type: string; notnull: boolean; hasdef: boolean; acl: string | null }[]>`
    select a.attname, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull, a.atthasdef as hasdef, a.attacl::text as acl
    from pg_attribute a where a.attrelid = 'public.sd_events'::regclass and a.attnum > 0 and not a.attisdropped`
  check('CONTROL: the catalog read works (sd_events has columns)', cols.length > 10, `${cols.length}`)
  check('CONTROL: rounds_planned (the organizer cap) is still there', cols.some((c) => c.attname === 'rounds_planned'))
  const col = cols.find((c) => c.attname === 'rounds_expected')
  check('rounds_expected exists', !!col)
  check('  integer, nullable, no default', col?.type === 'integer' && col.notnull === false && col.hasdef === false, JSON.stringify(col))
  check('  no column-level ACL (inherits the table grants, unchanged)', !!col && col.acl === null, col?.acl ?? '')
  const cons = await sql<{ def: string }[]>`
    select pg_get_constraintdef(oid) as def from pg_constraint
    where conrelid = 'public.sd_events'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%rounds_expected%'`
  check('  CHECK bounds it to 1..99', cons.length === 1 && /rounds_expected > 0/.test(cons[0]!.def) && /rounds_expected <= 99/.test(cons[0]!.def), JSON.stringify(cons))

  console.log('[2] behaviour as real users (one transaction, always rolled back)')
  const ids = await sql<{ email: string; id: string }[]>`
    select email, id::text from auth.users where email in ('charlie@demo.local', 'alice@demo.local')`
  const idOf = (e: string) => ids.find((r) => r.email === e)?.id
  // A published event in demo-dating (alice organizes; charlie is a member, so he can see it — the read
  // probe below is itself the proof).
  const [ev] = await sql<{ id: string }[]>`
    select e.id::text from sd_events e join orgs o on o.id = e.org_id
    where o.slug = 'demo-dating' and e.state in ('open', 'closed', 'running', 'complete') order by e.created_at limit 1`
  check('CONTROL: demo accounts and a published demo-dating event exist', !!idOf('charlie@demo.local') && !!idOf('alice@demo.local') && !!ev)
  if (col && ev) {
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
            out[`${key}_val`] = (r[0] as { v?: string | number | null } | undefined)?.v ?? null
            await tx.unsafe('release savepoint s')
          } catch (e) {
            await tx.unsafe('rollback to savepoint s')
            out[`${key}_err`] = String((e as Error).message)
          }
          await tx.unsafe('reset role')
        }
        await as('alice@demo.local', 'organizer', () => tx`update sd_events set rounds_expected = 7 where id = ${ev.id}`)
        await as('charlie@demo.local', 'participant', () => tx`update sd_events set rounds_expected = 2 where id = ${ev.id}`)
        await as('charlie@demo.local', 'read', () => tx`select rounds_expected as v from sd_events where id = ${ev.id}`)
        await as(null, 'zero', () => tx`update sd_events set rounds_expected = 0 where id = ${ev.id}`)
        await as(null, 'hundred', () => tx`update sd_events set rounds_expected = 100 where id = ${ev.id}`)
        throw new Error('__rollback__')
      })
      .catch((e: unknown) => {
        if ((e as Error).message !== '__rollback__') throw e
      })
    check('the organizer can set it', out.organizer === 1, JSON.stringify(out))
    check('a participant cannot (0 rows)', out.participant === 0 && !out.participant_err, JSON.stringify(out))
    check("the participant READS the organizer's value (7) on an event they can see", out.read === 1 && out.read_val === 7, JSON.stringify(out))
    check('the CHECK refuses 0', /check constraint/.test(String(out.zero_err ?? '')), String(out.zero_err))
    check('the CHECK refuses 100', /check constraint/.test(String(out.hundred_err ?? '')), String(out.hundred_err))
    const [after] = await sql<{ v: number | null }[]>`select rounds_expected as v from sd_events where id = ${ev.id}`
    check('nothing left behind (rolled back: not 7)', after?.v !== 7, String(after?.v))
  } else {
    check('behaviour probes (skipped: the column is not deployed)', false)
  }
} finally {
  await sql.end()
}
console.log(`\n${pass} checks passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
