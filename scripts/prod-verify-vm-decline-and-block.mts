// PROD verification for 20261007050000_vm_decline_and_block.sql.
//
//   pnpm exec tsx scripts/prod-verify-vm-decline-and-block.mts
//   pnpm exec tsx scripts/prod-verify-vm-decline-and-block.mts --local
//
// Read-only (selects only). No app credentials: the session pooler with
// SUPABASE_DB_PASSWORD from .env.deploy, same as prod-verify-20261007.mts.
//
// WHY NOT prod-verify-migration.ts: it is FUNCTION-ONLY. This migration's
// load-bearing parts are a COLUMN and a trigger BINDING (BEFORE INSERT, UPDATE
// and DELETE), which it cannot see.
//
// STRUCTURAL ONLY ON PROD, stated rather than hidden: prod held 0
// visual-messaging conversations when this shipped, so there is no live seat
// to exercise. The behaviour is proven by packages/db/src/rls.test.ts
// ("decline and block") against local; this proves prod has the same objects.
//
// RUN IT BEFORE AND AFTER migrate:prod — pre-apply it should FAIL the
// migration sections and PASS every CONTROL.
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
const body = async (name: string) =>
  (await sql<{ body: string }[]>`
    select pg_get_functiondef(p.oid) as body from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = ${name}`)[0]?.body ?? ''
// NULL (not an error) when the function does not exist yet, so a pre-apply run reaches the end.
const canExec = async (role: string, sig: string) =>
  (await sql<{ ok: boolean | null }[]>`
    select case when to_regprocedure(${sig}) is null then null
                else has_function_privilege(${role}, ${sig}, 'execute') end as ok`)[0]!.ok === true

try {
  console.log(`\nVerification — 20261007050000 decline and block. Target: ${local ? 'LOCAL' : 'PRODUCTION'}\n`)

  console.log('[0] Controls')
  const cols = await sql<{ column_name: string }[]>`
    select column_name::text from information_schema.columns
    where table_schema = 'public' and table_name = 'vm_conversation_members'`
  check('CONTROL: vm_conversation_members columns are readable', cols.some((c) => c.column_name === 'status'), `${cols.length}`)
  const trg = await sql<{ tgname: string; tgtype: number; tgenabled: string }[]>`
    select tgname::text, tgtype::int, tgenabled::text from pg_trigger
    where tgrelid = 'public.vm_conversation_members'::regclass and not tgisinternal order by tgname`
  check('CONTROL: the pre-existing pin trigger is visible', trg.some((t) => t.tgname === 'vm_members_a_pin'), trg.map((t) => t.tgname).join(','))
  check('CONTROL: authenticated executes vm_accept_conversation_invite', await canExec('authenticated', 'public.vm_accept_conversation_invite(uuid)'))

  console.log('\n[1] The column')
  const col = await sql<{ is_nullable: string; column_default: string | null }[]>`
    select is_nullable::text, column_default::text from information_schema.columns
    where table_schema = 'public' and table_name = 'vm_conversation_members' and column_name = 'self_blocked'`
  check('self_blocked exists, NOT NULL, default false', col[0]?.is_nullable === 'NO' && col[0]?.column_default === 'false', JSON.stringify(col))

  console.log('\n[2] The guard trigger is BOUND, not merely defined')
  const g = trg.find((t) => t.tgname === 'vm_members_d_self_block')
  const want = 1 | 2 | 4 | 8 | 16 // ROW | BEFORE | INSERT | DELETE | UPDATE
  check('vm_members_d_self_block is BEFORE INSERT/UPDATE/DELETE FOR EACH ROW', !!g && (g.tgtype & want) === want, JSON.stringify(g))
  check('vm_members_d_self_block is enabled', !!g && g.tgenabled !== 'D')
  const order = trg.map((t) => t.tgname)
  check(
    'it fires AFTER the pin (sees the re-invite rewrite) and BEFORE the scope trigger',
    order.indexOf('vm_members_a_pin') < order.indexOf('vm_members_d_self_block') &&
      order.indexOf('vm_members_d_self_block') < order.indexOf('vm_members_scope'),
    order.join(','),
  )
  const guard = await body('vm_guard_self_block')
  check('guard escapes cascades (pg_trigger_depth)', guard.includes('pg_trigger_depth() > 1'))
  check('guard refuses a holder deleting a moderation ban', guard.includes('You cannot remove a ban'))
  check('guard silently skips someone else deleting a self-block', guard.includes('return null'))

  console.log('\n[3] vm_pin_member allows pending -> banned for the holder; consent block intact')
  const pin = await body('vm_pin_member')
  check('pending -> banned transition present', pin.includes("(old.status = 'pending' and new.status = 'banned')"))
  check('consent block still present', pin.includes('Only the invited person can accept'))

  console.log('\n[4] ACLs')
  check('authenticated executes vm_decline_and_block_invite', await canExec('authenticated', 'public.vm_decline_and_block_invite(uuid)'))
  check('anon does NOT execute vm_decline_and_block_invite', !(await canExec('anon', 'public.vm_decline_and_block_invite(uuid)')))
  check('authenticated does NOT execute the trigger function', !(await canExec('authenticated', 'public.vm_guard_self_block()')))
  check('anon does NOT execute the trigger function', !(await canExec('anon', 'public.vm_guard_self_block()')))
} finally {
  await sql.end()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
