// PROD verification for the three 2026-10-07 migrations:
//   20261007010000_mm_assignment_covers_me_signature.sql
//   20261007020000_vm_conversation_moderator_rename.sql
//   20261007030000_vm_accept_first_seats.sql
//
//   pnpm exec tsx scripts/prod-verify-20261007.mts
//   pnpm exec tsx scripts/prod-verify-20261007.mts --local
//
// Read-only (selects only). No app credentials: the session pooler with
// SUPABASE_DB_PASSWORD from .env.deploy, same as prod-verify-module-roles-census.mts.
//
// WHY NOT prod-verify-migration.ts: it is FUNCTION-ONLY, and these migrations
// are mostly a policy, two CHECK constraints and a trigger BINDING — none of
// which it can see. Its pass would be partly vacuous.
//
// STRUCTURAL ONLY ON PROD, and that is stated rather than hidden: prod holds 0
// visual-messaging conversations, so there is no live seat to exercise. The
// behaviour (pending reads nothing, nobody accepts for you, unban = re-invite)
// is proven by packages/db/src/rls.test.ts against local. This script proves
// prod has the SAME OBJECTS those tests ran against.
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

const fnBodies = async (names: string[]) =>
  sql<{ proname: string; args: string; body: string }[]>`
    select p.proname::text, pg_get_function_identity_arguments(p.oid) as args, pg_get_functiondef(p.oid) as body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any(${names})`
// NULL (not an error) when the function does not exist yet — pre-apply runs
// must reach the end and print a result, not crash on the first missing object.
const canExec = async (role: string, sig: string) =>
  (await sql<{ ok: boolean | null }[]>`
    select case when to_regprocedure(${sig}) is null then null
                else has_function_privilege(${role}, ${sig}, 'execute') end as ok`)[0]!.ok === true

try {
  console.log(`\nVerification — 2026-10-07 migrations. Target: ${local ? 'LOCAL' : 'PRODUCTION'}\n`)

  console.log('[0] Controls: the catalog reads work at all')
  const nPol = (await sql<{ n: number }[]>`select count(*)::int as n from pg_policy`)[0]!.n
  check('CONTROL: pg_policy returns policies', nPol > 50, `${nPol}`)
  const nFn = (await sql<{ n: number }[]>`
    select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`)[0]!.n
  check('CONTROL: public functions are visible', nFn > 50, `${nFn}`)
  const applied = await sql<{ version: string }[]>`
    select version from supabase_migrations.schema_migrations where version like '20261007%' order by version`
  check(
    'all three versions recorded in schema_migrations',
    applied.length === 3,
    applied.map((r) => r.version).join(','),
  )

  // -------------------------------------------------------------------------
  console.log('\n[1] 20261007010000 — mm_assignment_covers_me takes no matchmaker')
  const mm = await fnBodies(['mm_assignment_covers_me'])
  check('exactly one overload', mm.length === 1, `${mm.length}`)
  check('its arguments are (group, user)', mm[0]?.args === 'check_target_group_id uuid, check_target_user_id uuid', mm[0]?.args)
  check('own-target arm still ungated (docs/19 §6 pin)', (mm[0]?.body ?? '').includes('check_target_user_id = auth.uid()'))
  check('group arm still role-gated', (mm[0]?.body ?? '').includes('mm_is_single'))
  const pol = await sql<{ qual: string }[]>`
    select pg_get_expr(polqual, polrelid) as qual from pg_policy
    where polrelid = 'public.mm_matchmaker_assignments'::regclass and polname = 'mm_assignments_select'`
  check('CONTROL: mm_assignments_select exists', pol.length === 1)
  check(
    'policy calls the 2-arg form',
    (pol[0]?.qual ?? '').includes('mm_assignment_covers_me(target_group_id, target_user_id)'),
    pol[0]?.qual,
  )
  if (mm.length === 1) {
    const sig = 'public.mm_assignment_covers_me(uuid, uuid)'
    check('anon cannot execute', !(await canExec('anon', sig)))
    check('authenticated can execute (RLS evaluates it as the caller)', await canExec('authenticated', sig))
  }

  // -------------------------------------------------------------------------
  console.log('\n[2] 20261007020000 — seat word is conversation_moderator')
  const cons = await sql<{ conname: string; def: string }[]>`
    select conname::text, pg_get_constraintdef(oid) as def from pg_constraint
    where conrelid = 'public.vm_conversation_members'::regclass and contype = 'c'`
  check('CONTROL: vm_conversation_members has CHECK constraints', cons.length >= 2, `${cons.length}`)
  const roleChk = cons.find((c) => c.conname === 'vm_conversation_members_role_check')?.def ?? ''
  check('role CHECK allows conversation_moderator', roleChk.includes("'conversation_moderator'"), roleChk)
  check("role CHECK no longer allows 'moderator'", !roleChk.includes("'moderator'"), roleChk)
  const vmFns = await fnBodies(['vm_can_post', 'vm_can_moderate'])
  check('CONTROL: both functions present', vmFns.length === 2)
  for (const f of vmFns) {
    check(`${f.proname} names conversation_moderator`, f.body.includes("'conversation_moderator'"))
    check(`${f.proname} no longer names 'moderator'`, !f.body.includes("'moderator'"))
  }
  const stale = (await sql<{ n: number }[]>`
    select count(*)::int as n from public.vm_conversation_members where role = 'moderator'`)[0]!.n
  check("no seat still holds 'moderator'", stale === 0, `${stale}`)

  // -------------------------------------------------------------------------
  console.log('\n[3] 20261007030000 — accept-first seats')
  const statusChk = cons.find((c) => c.conname === 'vm_conversation_members_status_check')?.def ?? ''
  check("status CHECK allows 'pending'", statusChk.includes("'pending'"), statusChk)
  const trg = await sql<{ tgname: string; enabled: string; fn: string }[]>`
    select t.tgname::text, t.tgenabled::text as enabled, p.proname::text as fn
    from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.vm_conversation_members'::regclass and not t.tgisinternal`
  check('CONTROL: the table has its triggers', trg.length >= 4, trg.map((t) => t.tgname).join(','))
  const inv = trg.find((t) => t.tgname === 'vm_members_c_invite')
  check('vm_members_c_invite is BOUND to vm_invite_pending', inv?.fn === 'vm_invite_pending')
  check('vm_members_c_invite is ENABLED', !!inv && inv.enabled !== 'D', inv?.enabled)
  const pin = trg.find((t) => t.tgname === 'vm_members_a_pin')
  check('vm_members_a_pin still bound and enabled', pin?.fn === 'vm_pin_member' && pin.enabled !== 'D')

  const pinBody = (await fnBodies(['vm_pin_member']))[0]?.body ?? ''
  check('pin: nobody else accepts', pinBody.includes('Only the invited person can accept'))
  check('pin: seat cannot move person', pinBody.includes('cannot be moved to another person'))
  check('pin: seat cannot move conversation', pinBody.includes('cannot be moved to another conversation'))
  check('pin: unban becomes a re-invite', pinBody.includes("new.status := 'pending'"))
  check(
    'pin: consent block runs BEFORE the manager escape',
    pinBody.indexOf('Only the invited person') > -1 &&
      pinBody.indexOf('Only the invited person') < pinBody.indexOf('vm_can_manage(old.org_id)'),
  )
  check('pin: self-block survives', pinBody.includes("old.status = 'active' and new.status = 'banned'"))
  check('pin: admin floor survives', pinBody.includes('A conversation must keep at least one admin'))

  const preds = await fnBodies([
    'vm_is_conv_member', 'vm_is_conv_admin', 'vm_can_post', 'vm_can_moderate', 'vm_seat_holds_admin_floor',
  ])
  check('CONTROL: all five access predicates present', preds.length === 5, `${preds.length}`)
  for (const p of preds) check(`${p.proname} requires status = 'active'`, p.body.includes("status = 'active'"))

  for (const sig of ['public.vm_accept_conversation_invite(uuid)', 'public.vm_my_pending_invites(uuid)']) {
    const exists = (await sql<{ ok: boolean }[]>`select to_regprocedure(${sig}) is not null as ok`)[0]!.ok
    check(`${sig} exists`, exists)
    if (exists) {
      check(`${sig}: anon cannot execute`, !(await canExec('anon', sig)))
      check(`${sig}: authenticated can execute`, await canExec('authenticated', sig))
    }
  }
  const trgFnExists = (await sql<{ ok: boolean }[]>`select to_regprocedure('public.vm_invite_pending()') is not null as ok`)[0]!.ok
  check('vm_invite_pending exists', trgFnExists)
  if (trgFnExists) check('vm_invite_pending: authenticated holds no EXECUTE', !(await canExec('authenticated', 'public.vm_invite_pending()')))

  const convs = (await sql<{ n: number }[]>`select count(*)::int as n from public.vm_conversations`)[0]!.n
  console.log(`\n  note  ${convs} visual-messaging conversation(s) on this database — ` +
    (convs === 0 ? 'behaviour is VACUOUS here; it is proven by the local RLS suite.' : 'structure checked; behaviour proven by the local RLS suite.'))
} finally {
  await sql.end()
}

console.log(`\nResult: ${pass} passed, ${fail} failed — ${local ? 'LOCAL' : 'PRODUCTION'}`)
process.exit(fail === 0 ? 0 : 1)
