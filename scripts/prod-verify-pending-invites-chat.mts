// PROD verification for 20261018020000_pending_invites_chat.sql (docs/25 §12,
// slice 2: chat pre-invite + a module role carried on an org invitation).
//
//   pnpm exec tsx scripts/prod-verify-pending-invites-chat.mts
//   pnpm exec tsx scripts/prod-verify-pending-invites-chat.mts --local
//
// Read-only (selects only). No app credentials: the session pooler with
// SUPABASE_DB_PASSWORD from .env.deploy.
//
// WHY NOT prod-verify-migration.ts: it is FUNCTION-ONLY. This migration's
// load-bearing parts include CONSTRAINTS (three kinds, their shapes, the
// widened unique key), the ABSENCE of any new policy, the ABSENCE of the old
// three-argument issue function, and two EXISTING trigger bodies the applier
// relies on (§[4]) — none of which a function-only check sees.
//
// The behaviour is proven by packages/db/src/pending-invites-chat.test.ts
// against local (teeth proven by deliberate breakage); this proves prod holds
// the same objects. Slice 1's objects: prod-verify-pending-invites.mts.
//
// RUN IT BEFORE AND AFTER migrate:prod — pre-apply it should FAIL §[1]–§[3]
// and PASS every CONTROL and §[4].
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const local = process.argv.includes('--local')

const env = local ? '' : readFileSync(resolve(root, '.env.deploy'), 'utf8')
const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''

const sql = local
  ? postgres(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres', { max: 1 })
  : (() => {
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

const body = async (sig: string) =>
  (await sql<{ body: string | null }[]>`
    select case when to_regprocedure(${sig}) is null then null
                else pg_get_functiondef(to_regprocedure(${sig})) end as body`)[0]?.body ?? ''
const canExec = async (role: string, sig: string) =>
  (await sql<{ ok: boolean | null }[]>`
    select case when to_regprocedure(${sig}) is null then null
                else has_function_privilege(${role}, ${sig}, 'execute') end as ok`)[0]!.ok

const ISSUE_ORG = 'public.pending_invite_issue_org(uuid, text, text, text, text)'
const ISSUE_ORG_OLD = 'public.pending_invite_issue_org(uuid, text, text)'
const ISSUE_VM = 'public.pending_invite_issue_vm(uuid, text)'
const LIST = 'public.pending_invites_list(uuid, uuid)'
const CANCEL = 'public.pending_invite_cancel(uuid)'
const RESEND = 'public.pending_invite_resend(uuid)'
const CLAIM = 'public.pending_invites_claim_mine()'
const SLOT = 'public.pending_invite_slot(uuid, text, text, uuid, text)'
const APPLY_HELD = 'public.pending_invite_apply_held(uuid, uuid)'
const WAITING = 'public.pending_invite_waiting_on(uuid)'
const PRUNE = 'public.pending_invites_prune_expired()'

try {
  console.log(`\nVerification — 20261018020000 pending invites slice 2 (chat). Target: ${local ? 'LOCAL' : 'PRODUCTION'}\n`)

  console.log('[0] Controls')
  const [{ n: orgCount }] = await sql<{ n: number }[]>`select count(*)::int as n from public.orgs`
  check('CONTROL: orgs are readable (the catalog read is real)', orgCount > 0, `${orgCount}`)
  check('CONTROL: slice 1 is applied (pending_invites exists)', (await sql`select to_regclass('public.pending_invites') as r`)[0]!.r !== null)
  check('CONTROL: authenticated executes vm_accept_conversation_invite (a has_function_privilege read works)',
    (await canExec('authenticated', 'public.vm_accept_conversation_invite(uuid)')) === true)

  console.log('\n[1] Table: kinds, shapes, columns, unique key — and still ONE policy')
  const cols = await sql<{ column_name: string }[]>`
    select column_name::text from information_schema.columns
    where table_schema = 'public' and table_name = 'pending_invites'`
  for (const c of ['module_key', 'claimed_by', 'seat_invited_at']) {
    check(`column ${c} exists`, cols.some((x) => x.column_name === c))
  }
  const cons = await sql<{ name: string; def: string }[]>`
    select conname::text as name, pg_get_constraintdef(oid) as def from pg_constraint
    where conrelid = to_regclass('public.pending_invites')`
  const kind = cons.find((c) => c.name === 'pending_invites_kind_check')?.def ?? ''
  check('kind allows org, module_role, vm_conversation', /'org'/.test(kind) && /'module_role'/.test(kind) && /'vm_conversation'/.test(kind), kind)
  check('the vm_conversation shape CHECK exists and allows only participant',
    cons.some((c) => c.name === 'pending_invites_vm_shape' && /participant/.test(c.def) && !/admin/.test(c.def)))
  check('the module_role shape CHECK exists', cons.some((c) => c.name === 'pending_invites_module_role_shape'))
  check('one row per (kind, target, module, address), NULLS NOT DISTINCT',
    cons.some((c) => /UNIQUE NULLS NOT DISTINCT \(kind, target_id, module_key, email\)/.test(c.def)), cons.map((c) => c.def).join(' | '))
  check('claimed_by references auth.users ON DELETE CASCADE',
    cons.some((c) => /FOREIGN KEY \(claimed_by\) REFERENCES auth\.users\(id\) ON DELETE CASCADE/.test(c.def)))
  const pols = await sql<{ polcmd: string; qual: string | null }[]>`
    select polcmd::text, pg_get_expr(polqual, polrelid) as qual from pg_policy where polrelid = to_regclass('public.pending_invites')`
  check('NEGATIVE: still exactly one policy, SELECT, is_org_admin(org_id) — no inviter/conversation-admin arm added',
    pols.length === 1 && pols[0]!.polcmd === 'r' && /is_org_admin\(org_id\)/.test(pols[0]!.qual ?? '') && !/invited_by|vm_/.test(pols[0]!.qual ?? ''),
    JSON.stringify(pols))

  console.log('\n[2] Functions: definer, pinned search_path, and the full EXECUTE ACL')
  for (const sig of [ISSUE_ORG, ISSUE_VM, LIST, CANCEL, RESEND, CLAIM, SLOT, APPLY_HELD, WAITING, PRUNE]) {
    const b = await body(sig)
    check(`${sig} exists, SECURITY DEFINER, search_path pinned`, /SECURITY DEFINER/.test(b) && /SET search_path TO 'public'/.test(b))
  }
  check('NEGATIVE: the old three-argument pending_invite_issue_org is gone', (await body(ISSUE_ORG_OLD)) === '')
  for (const sig of [ISSUE_ORG, ISSUE_VM, LIST, CANCEL, RESEND, CLAIM]) {
    check(`authenticated executes ${sig}`, (await canExec('authenticated', sig)) === true)
    check(`anon does NOT execute ${sig}`, (await canExec('anon', sig)) === false)
  }
  for (const sig of [SLOT, APPLY_HELD, WAITING, PRUNE]) {
    for (const role of ['authenticated', 'anon', 'service_role']) {
      check(`${role} does NOT execute internal ${sig}`, (await canExec(role, sig)) === false)
    }
  }

  console.log('\n[3] The load-bearing lines of each body (each pinned locally by a named test)')
  const held = await body(APPLY_HELD)
  check('apply_held creates the seat PENDING (accept-first)', /inv\.role, 'pending', inv\.invited_by\)/.test(held))
  check('apply_held: ANY existing seat uses the invite up (a self-block wins)', /s\.user_id = invitee\) then\s+return 'dead'/.test(held))
  check("apply_held reads the conversation's CURRENT org under a lock (a moved conversation is dead)",
    /for share/.test(held) && /v_conv_org is distinct from inv\.org_id/.test(held))
  check('apply_held ties a module role to the seat its org invitation created',
    /m\.invited_at is not distinct from inv\.seat_invited_at/.test(held))
  check('apply_held re-checks the inviter (not banned, not left)', /account_has_left\(inv\.invited_by\)/.test(held) && /banned_until > now\(\)/.test(held))
  check('apply_held restores the caller identity (twice: exit and handler)',
    (held.match(/set_config\('request\.jwt\.claims', coalesce\(old_claims, ''\), true\)/g) ?? []).length === 2)
  const claim = await body(CLAIM)
  check('the claim orders org -> module_role -> vm_conversation and calls apply_held',
    /when 'org' then 0 when 'module_role' then 1 else 2/.test(claim) && /pending_invite_apply_held/.test(claim))
  check('the claim still requires a CONFIRMED address and asserts identity came back',
    /email_confirmed_at is not null/.test(claim) && /caller identity was not restored/.test(claim))
  const list = await body(LIST)
  check('the list gives a reason to ORG ADMINS only', /case when me\.org_admin then public\.pending_invite_waiting_on\(p\.id\) end/.test(list))
  const slot = await body(SLOT)
  check('the per-address cap counts DISTINCT inviters', /count\(distinct invited_by\)/.test(slot))
  const vm = await body(ISSUE_VM)
  check('NEGATIVE: issuing a chat invitation never reads auth.users or org_members (no oracle)',
    !!vm && !/auth\.users/.test(vm) && !/org_members/.test(vm))
  check("issuing a chat invitation needs vm_is_conv_admin", /vm_is_conv_admin\(check_conversation_id\)/.test(vm))
  check('the pruner also drops invitations whose conversation is gone', /kind = 'vm_conversation'/.test(await body(PRUNE)))

  console.log('\n[4] What the applier RELIES ON in existing triggers (unchanged by this migration)')
  const invite = await body('public.vm_invite_pending()')
  check('vm_invite_pending only acts when someone is signed in (so the applier keeps invited_by + status)',
    /if auth\.uid\(\) is not null then/.test(invite))
  const mrGuard = await body('public.module_roles_guard_hierarchy()')
  check('module_roles_guard_hierarchy lets the no-signed-in-user path through', /if auth\.uid\(\) is null/.test(mrGuard))
  const bound = await sql<{ tgname: string }[]>`
    select tgname::text from pg_trigger where tgrelid = 'public.vm_conversation_members'::regclass and not tgisinternal and tgenabled <> 'D'`
  check('vm_members_c_invite and vm_members_d_self_block are bound and enabled',
    bound.some((t) => t.tgname === 'vm_members_c_invite') && bound.some((t) => t.tgname === 'vm_members_d_self_block'),
    bound.map((t) => t.tgname).join(','))

  console.log('\n[5] Data (informational)')
  const byKind = await sql<{ kind: string; n: number }[]>`
    select kind, count(*)::int as n from public.pending_invites group by kind order by kind`
  console.log(`  INFO  ${byKind.length ? byKind.map((k) => `${k.kind}=${k.n}`).join(', ') : 'no pending invitations'} on this database`)
} finally {
  await sql.end()
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exitCode = fail ? 1 : 0
