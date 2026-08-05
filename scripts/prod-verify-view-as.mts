// Prod verification for slice 5 (view-as, 20260731010000).
//
// scripts/prod-verify-migration.ts parses `create function` blocks, so on this
// migration it verifies the two function BODIES and the version row and nothing
// else — not the table, not its ACL, not the policies, not the trigger, and not
// whether the guard actually refuses a banned pair on prod. This closes that
// gap, in the shape the 2026-07-29 founder decision requires: a catalog read
// PLUS a real rolled-back live probe.
//
// READ-ONLY except for one transaction that is explicitly ROLLED BACK.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const env = readFileSync(resolve(root, '.env.deploy'), 'utf8')
const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''
const ref = get('SUPABASE_PROJECT_REF')
const pw = get('SUPABASE_DB_PASSWORD')
const dbUrl =
  process.env.VERIFY_DB_URL ||
  `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`

const sql = postgres(dbUrl, { prepare: false, max: 1 })
let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`) }
}

console.log(`Prod view-as verification (project ${ref})\n`)

console.log('[1] The table exists with RLS on')
{
  const r = await sql`
    select c.relrowsecurity as rls, c.relforcerowsecurity as force
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'view_as_sessions'`
  check('view_as_sessions exists', r.length === 1)
  check('row level security is enabled', r[0]?.rls === true)
}

console.log('\n[2] The ACL is exactly what the migration states (docs/03 #17)')
{
  // The whole point of the explicit `revoke all` was prod's ALTER DEFAULT
  // PRIVILEGES handing new tables the full set to anon/authenticated — the
  // known-open drift item. This is the assertion that proves it did not happen.
  const rows = await sql<{ grantee: string; privs: string[] }[]>`
    select grantee, array_agg(privilege_type order by privilege_type) as privs
    from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'view_as_sessions'
    group by grantee`
  const by = new Map(rows.map((r) => [r.grantee, r.privs]))
  const auth = by.get('authenticated') ?? []
  const anon = by.get('anon') ?? []
  const svc = by.get('service_role') ?? []
  check('authenticated holds exactly SELECT+INSERT', JSON.stringify(auth) === JSON.stringify(['INSERT', 'SELECT']), JSON.stringify(auth))
  check('authenticated holds no UPDATE/DELETE (append-only at the grant layer)', !auth.includes('UPDATE') && !auth.includes('DELETE'))
  check('authenticated holds no whole-table wipe privilege (RLS cannot gate it)', !auth.includes('TRUNCATE'))
  check('anon holds nothing at all', anon.length === 0, JSON.stringify(anon))
  check('service_role holds SELECT only', JSON.stringify(svc) === JSON.stringify(['SELECT']), JSON.stringify(svc))
}

console.log('\n[3] Policies and the guard trigger are deployed')
{
  const pols = await sql<{ policyname: string; cmd: string }[]>`
    select policyname, cmd from pg_policies
    where schemaname = 'public' and tablename = 'view_as_sessions' order by policyname`
  const names = pols.map((p) => p.policyname)
  check('3 policies present', pols.length === 3, JSON.stringify(names))
  check('insert policy pins the actor', names.includes('view_as_sessions_insert_actor'))
  check('actor can read own sessions', names.includes('view_as_sessions_select_actor'))
  check('org admins can audit their org', names.includes('view_as_sessions_select_org_admin'))
  check('no UPDATE or DELETE policy exists', !pols.some((p) => p.cmd === 'UPDATE' || p.cmd === 'DELETE'))

  const trg = await sql<{ tgname: string }[]>`
    select tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'view_as_sessions' and not t.tgisinternal`
  check('the guard trigger is attached', trg.some((t) => t.tgname === 'view_as_sessions_guard'), JSON.stringify(trg.map(t=>t.tgname)))
  check('no append-only trigger (it would block FK set-null; review 2)', !trg.some((t) => t.tgname === 'view_as_sessions_no_update'))
}

console.log('\n[4] The edge mirror answers correctly ON PROD, and fails closed')
{
  const cases: [string, string, string, boolean][] = [
    ['classroom', 'professor', 'ga', true],
    ['classroom', 'professor', 'student', true],
    ['classroom', 'ga', 'student', false],
    ['classroom', 'student', 'professor', false],
    // Nail-salon's surface review (2026-08-04) turned mode 2 on for the two
    // pairs into `worker` and left the other seven off. THESE TWO `true` CASES
    // REQUIRE 20260804010000 TO BE DEPLOYED — if this script fails only here,
    // prod's schema is behind the repo, which is exactly what it should say.
    ['nail-salon', 'admin', 'worker', true],
    ['nail-salon', 'manager', 'worker', true],
    ['nail-salon', 'admin', 'manager', false],
    ['nail-salon', 'manager', 'cashier', false],
    ['nail-salon', 'manager', 'customer', false],
    ['speed-dating', 'organizer', 'participant', false],
    ['speed-dating', 'admin', 'participant', false],
    ['visual-messaging', 'admin', 'member', false],
    ['no-such-module', 'a', 'b', false],
  ]
  for (const [m, a, b, want] of cases) {
    const r = await sql<{ v: boolean }[]>`select public.module_view_as_edge(${m}, ${a}, ${b}) as v`
    check(`edge ${m} ${a}->${b} = ${want}`, r[0]?.v === want, `got ${r[0]?.v}`)
  }
}

console.log('\n[5] Position ranks on prod match the TypeScript declarations')
{
  const expected: [string, string, number][] = [
    ['classroom', 'professor', 2], ['classroom', 'ga', 1], ['classroom', 'student', 1],
    ['nail-salon', 'admin', 3], ['nail-salon', 'manager', 2], ['nail-salon', 'cashier', 1],
    ['nail-salon', 'worker', 1], ['nail-salon', 'customer', 0],
    ['speed-dating', 'admin', 3], ['speed-dating', 'organizer', 2],
    ['speed-dating', 'host', 1], ['speed-dating', 'participant', 0],
  ]
  let bad = 0
  for (const [m, role, want] of expected) {
    const r = await sql<{ v: number }[]>`select public.module_position_rank(${m}, ${role}) as v`
    if (r[0]?.v !== want) { bad++; console.log(`        ${m}/${role}: prod=${r[0]?.v} expected=${want}`) }
  }
  check('all 12 ranked positions match (the parity the TS check depends on)', bad === 0)
}

console.log('\n[6] LIVE PROBE — the guard actually refuses, in a rolled-back transaction')
{
  // Founder decision 2026-07-29: prod verification must include a real
  // rolled-back probe, not just a catalog read.
  //
  // Each expected-to-fail INSERT runs inside its own SAVEPOINT. In Postgres a
  // failed statement poisons the whole transaction, so catching the error in
  // JavaScript is NOT enough — the next statement dies with "current
  // transaction is aborted". A savepoint scopes the damage to one probe.
  // (Learned on this script's first prod run, which crashed exactly that way.)
  const asUser = (tx: postgres.TransactionSql, uid: string) =>
    tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: 'authenticated' })}, true),
              set_config('role', 'authenticated', true)`

  const expectRefused = async (
    tx: postgres.TransactionSql,
    name: string,
    pattern: RegExp,
    run: (sp: postgres.TransactionSql) => Promise<unknown>,
  ) => {
    let msg = ''
    try {
      await tx.savepoint(async (sp) => { await run(sp) })
    } catch (e) {
      msg = (e as Error).message
    }
    check(name, msg !== '', 'the insert SUCCEEDED — it should have been refused')
    if (msg) check('   ...refused for the stated reason', pattern.test(msg), msg)
  }

  try {
    await sql.begin(async (tx) => {
      const student = await tx<{ org_id: string; user_id: string; scope_ref: string | null }[]>`
        select org_id, user_id, scope_ref from public.module_roles
        where module_key = 'classroom' and role = 'student' limit 1`

      if (student.length === 0) {
        console.log('  SKIP  no classroom student grant on prod to probe against')
      } else {
        const t = student[0]!
        await asUser(tx, t.user_id)
        await expectRefused(
          tx,
          'a student cannot open a view-as session',
          /cannot view as yourself|outranks, covers, and declares/,
          (sp) => sp`insert into public.view_as_sessions
              (org_id, module_key, actor_user_id, target_user_id, target_role, target_scope_ref)
            values (${t.org_id}, 'classroom', ${t.user_id}, ${t.user_id}, 'student', ${t.scope_ref})`,
        )
        await tx`select set_config('role', 'postgres', true)`
      }

      const sd = await tx<{ org_id: string; user_id: string; scope_ref: string | null }[]>`
        select org_id, user_id, scope_ref from public.module_roles
        where module_key = 'speed-dating' and role = 'participant' limit 1`
      const org = await tx<{ user_id: string }[]>`
        select user_id from public.module_roles
        where module_key = 'speed-dating' and role in ('organizer','admin') limit 1`

      if (sd.length && org.length) {
        await asUser(tx, org[0]!.user_id)
        await expectRefused(
          tx,
          'a speed-dating organizer cannot view as a participant (permanently banned pair)',
          /declares an edge/,
          (sp) => sp`insert into public.view_as_sessions
              (org_id, module_key, actor_user_id, target_user_id, target_role, target_scope_ref)
            values (${sd[0]!.org_id}, 'speed-dating', ${org[0]!.user_id}, ${sd[0]!.user_id}, 'participant', ${sd[0]!.scope_ref})`,
        )
        await tx`select set_config('role', 'postgres', true)`
      } else {
        console.log('  SKIP  no speed-dating organizer/participant pair on prod to probe')
      }

      throw new Error('__rollback__')
    })
  } catch (e) {
    if (!/__rollback__/.test(String((e as Error).message))) throw e
  }

  const left = await sql<{ n: string }[]>`select count(*)::text as n from public.view_as_sessions`
  check('probe left NO rows behind (transaction rolled back)', left[0]?.n === '0', `count=${left[0]?.n}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
await sql.end()
process.exit(fail === 0 ? 0 : 1)
