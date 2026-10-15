// PROD verification for 20261014020000_vm_viewers_may_react.sql.
//
//   pnpm exec tsx scripts/prod-verify-vm-viewer-reactions.mts
//   pnpm exec tsx scripts/prod-verify-vm-viewer-reactions.mts --local
//
// No app credentials: the session pooler with SUPABASE_DB_PASSWORD from
// .env.deploy, same as the other prod-verify-vm-*.mts scripts.
//
// WHY NOT prod-verify-migration.ts: it is FUNCTION-ONLY. The load-bearing change
// here is a POLICY swap, which it cannot see.
//
// WRITES NOTHING THAT SURVIVES. Section [3] replays a viewer's reaction as that
// viewer (`set local role authenticated` + request.jwt.claims) inside a
// transaction that is ALWAYS rolled back — the technique the 2026-10-14
// diagnosis used to replay a failing prod write. It picks ANY active viewer seat
// whose holder is still an org member; if none exists it says VACUOUS rather
// than passing.
//
// RUN IT BEFORE AND AFTER migrate:prod — pre-apply it should FAIL sections
// [1] [2] [3] and PASS every CONTROL.
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

/** Runs fn as `userId` (authenticated) in a transaction that is always rolled back. */
const ROLLBACK = new Error('rollback')
async function asUserRolledBack<T>(userId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T | Error> {
  let out: T | Error = new Error('did not run')
  try {
    await sql.begin(async (tx) => {
      const claims = JSON.stringify({ sub: userId, role: 'authenticated' })
      await tx`select set_config('request.jwt.claims', ${claims}, true)`
      await tx`set local role authenticated`
      try {
        out = await fn(tx)
      } catch (e) {
        out = e as Error
      }
      throw ROLLBACK
    })
  } catch (e) {
    if (e !== ROLLBACK) throw e
  }
  return out
}

try {
  console.log(`\nVerification — 20261014020000 viewers may react. Target: ${local ? 'LOCAL' : 'PRODUCTION'}\n`)

  console.log('[0] Controls')
  const pols = await sql<{ policyname: string; cmd: string; with_check: string | null; qual: string | null }[]>`
    select policyname::text, cmd::text, with_check, qual from pg_policies
    where schemaname = 'public' and tablename = 'vm_reactions' order by policyname`
  check('CONTROL: vm_reactions policies are readable (>= 5)', pols.length >= 5, `${pols.length}`)
  const post = await body('vm_can_post')
  check(
    'CONTROL: vm_can_post still carries its role list (posting is NOT widened)',
    /m\.role in \('participant', 'conversation_moderator', 'admin'\)/.test(post),
    post.slice(0, 80),
  )
  const trg = await sql<{ tgtype: number; tgenabled: string; fn: string }[]>`
    select t.tgtype::int, t.tgenabled::text, p.proname::text as fn from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.vm_reactions'::regclass and t.tgname = 'vm_reactions_scope'`
  const want = 1 | 2 | 4 // ROW | BEFORE | INSERT
  check(
    'CONTROL: vm_reactions_scope (vm_sync_from_layer) is BOUND BEFORE INSERT and enabled — the check sees the layer\'s conversation',
    trg.length === 1 && (trg[0]!.tgtype & want) === want && trg[0]!.tgenabled !== 'D' && trg[0]!.fn === 'vm_sync_from_layer',
    JSON.stringify(trg),
  )

  console.log('\n[1] vm_can_react')
  const react = await body('vm_can_react')
  check('vm_can_react exists', react.length > 0)
  check('is SECURITY DEFINER with search_path pinned', /SECURITY DEFINER/.test(react) && /SET search_path TO 'public'/.test(react))
  check("requires status = 'active'", /m\.status = 'active'/.test(react))
  check('requires not self_blocked', /not m\.self_blocked/.test(react))
  check('requires is_org_member(m.org_id)', /public\.is_org_member\(m\.org_id\)/.test(react))
  check('requires the caller (auth.uid())', /m\.user_id = auth\.uid\(\)/.test(react))
  check('has NO role list (any active seat)', react.length > 0 && !/m\.role/.test(react))
  check('has NO moderator escape arm', react.length > 0 && !/moderate/.test(react))
  check('anon cannot execute', react.length > 0 && !(await canExec('anon', 'public.vm_can_react(uuid)')))
  check('authenticated can execute', await canExec('authenticated', 'public.vm_can_react(uuid)'))
  check('service_role can execute', await canExec('service_role', 'public.vm_can_react(uuid)'))

  console.log('\n[2] The policy')
  const own = pols.find((p) => p.policyname === 'vm_reactions_insert_own')
  check('vm_reactions_insert_own exists', !!own)
  check(
    'it checks vm_can_react(conversation_id) AND user_id = auth.uid()',
    !!own?.with_check && /vm_can_react\(conversation_id\)/.test(own.with_check) && /user_id = auth\.uid\(\)/.test(own.with_check),
    own?.with_check ?? '',
  )
  check('it no longer checks vm_can_post', !!own?.with_check && !/vm_can_post/.test(own.with_check), own?.with_check ?? '')
  const inserts = pols.filter((p) => p.cmd === 'INSERT').map((p) => p.policyname)
  check('exactly two INSERT policies (own + manage)', inserts.length === 2, inserts.join(','))
  const manage = pols.find((p) => p.policyname === 'vm_reactions_insert_manage')
  // 20261015010000 later added `user_id = auth.uid()` to this arm (no
  // forging another person's reaction), so only its manager gate is asserted.
  check('vm_reactions_insert_manage still gates on vm_can_manage(org_id)', /vm_can_manage\(org_id\)/.test(manage?.with_check ?? ''), manage?.with_check ?? '')

  console.log('\n[3] Behaviour — a real viewer reacts, replayed and ROLLED BACK')
  const viewers = await sql<{ user_id: string; conversation_id: string; layer_id: string; kind: string }[]>`
    select m.user_id, m.conversation_id, l.id as layer_id,
           (select k from unnest(array['heart','laugh']) k
             where not exists (select 1 from public.vm_reactions r
                               where r.layer_id = l.id and r.user_id = m.user_id and r.kind = k)
             limit 1) as kind
    from public.vm_conversation_members m
    join public.org_members om on om.org_id = m.org_id and om.user_id = m.user_id and om.status = 'active'
    join public.vm_layers l on l.conversation_id = m.conversation_id
    where m.role = 'viewer' and m.status = 'active' and not m.self_blocked
    order by l.created_at limit 1`
  const v = viewers[0]
  if (!v || !v.kind) {
    console.log('  VACUOUS  no active viewer seat (held by an org member) with a layer to react to — behaviour unproven here')
  } else {
    const canPost = await asUserRolledBack(v.user_id, async (tx) =>
      (await tx<{ ok: boolean }[]>`select public.vm_can_post(${v.conversation_id}::uuid) as ok`)[0]!.ok)
    check('CONTROL: the subject really is a viewer (vm_can_post is false for them)', canPost === false, String(canPost))
    const ins = await asUserRolledBack(v.user_id, async (tx) => {
      await tx`insert into public.vm_reactions (org_id, conversation_id, layer_id, user_id, kind)
               select l.org_id, l.conversation_id, l.id, ${v.user_id}::uuid, ${v.kind}
               from public.vm_layers l where l.id = ${v.layer_id}::uuid`
      return 'inserted'
    })
    check('a viewer\'s reaction insert succeeds (rolled back)', ins === 'inserted', ins instanceof Error ? ins.message : String(ins))
    const after = (await sql<{ n: number }[]>`
      select count(*)::int as n from public.vm_reactions
      where layer_id = ${v.layer_id}::uuid and user_id = ${v.user_id}::uuid and kind = ${v.kind}`)[0]!.n
    check('CONTROL: nothing survived the rollback', after === 0, `${after}`)
  }
} finally {
  await sql.end()
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
