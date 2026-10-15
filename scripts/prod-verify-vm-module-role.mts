// PROD verification for 20261015010000_vm_seat_needs_module_role.sql.
//
//   pnpm exec tsx scripts/prod-verify-vm-module-role.mts
//   pnpm exec tsx scripts/prod-verify-vm-module-role.mts --local
//
// Read-only (selects only). No app credentials: the session pooler with
// SUPABASE_DB_PASSWORD from .env.deploy, same as the other prod-verify-vm-*.mts.
//
// WHY NOT prod-verify-migration.ts alone: it is FUNCTION-ONLY. This migration
// also swaps five POLICIES and binds two TRIGGERS, which it cannot see.
//
// [M] is a MEASUREMENT, not a pass/fail: who loses access. It computes "holds
// the visual-messaging role" inline (not via the new helper) so it means the
// same thing before and after the apply. Run it BEFORE migrate:prod — every
// non-zero count is a real person who is cut off.
//
// RUN IT BEFORE AND AFTER migrate:prod — pre-apply it should FAIL [1]-[3] and
// PASS every CONTROL.
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
const src = async (name: string) =>
  (await sql<{ s: string }[]>`
    select prosrc as s from pg_proc where pronamespace = 'public'::regnamespace and proname = ${name}`)[0]?.s ?? ''
const canExec = async (role: string, sig: string) =>
  (await sql<{ ok: boolean | null }[]>`
    select case when to_regprocedure(${sig}) is null then null
                else has_function_privilege(${role}, ${sig}, 'execute') end as ok`)[0]!.ok === true
const policy = async (table: string, name: string) =>
  (await sql<{ qual: string | null; with_check: string | null }[]>`
    select qual, with_check from pg_policies where schemaname = 'public' and tablename = ${table} and policyname = ${name}`)[0]

// Inline "holds the visual-messaging role" for user u in org o (same meaning
// before and after the migration).
const HOLDS = (o: string, u: string) => `(
  exists (select 1 from public.org_members om2 where om2.org_id = ${o} and om2.user_id = ${u} and om2.status = 'active'
          and (om2.role in ('owner','admin') or exists (
            select 1 from public.module_roles r where r.org_id = ${o} and r.user_id = ${u}
              and r.module_key = 'visual-messaging' and r.role in ('member','moderator','admin') and r.scope_ref is null)))
  or coalesce((select up.is_superadmin from public.user_private up where up.user_id = ${u}), false))`

try {
  console.log(`\nVerification — 20261015010000 vm seats need the module role. Target: ${local ? 'LOCAL' : 'PRODUCTION'}\n`)

  console.log('[0] Controls')
  const [counts] = await sql<{ convs: number; seats: number; active: number; grants: number }[]>`
    select (select count(*)::int from public.vm_conversations) as convs,
           (select count(*)::int from public.vm_conversation_members) as seats,
           (select count(*)::int from public.vm_conversation_members where status = 'active') as active,
           (select count(*)::int from public.module_roles where module_key = 'visual-messaging') as grants`
  console.log(`        data: ${counts!.convs} conversations, ${counts!.seats} seats (${counts!.active} active), ${counts!.grants} vm grants`)
  check('CONTROL: vm tables and module_roles are readable', counts!.grants >= 0 && counts!.seats >= 0)
  check('CONTROL: vm_is_module_member exists and authenticated executes it', await canExec('authenticated', 'public.vm_is_module_member(uuid)'))

  console.log('\n[M] Measurement — who loses access (the same count before and after)')
  const lose = await sql.unsafe<{ email: string; slug: string; title: string; role: string }[]>(`
    select u.email::text, o.slug::text, c.title::text, m.role::text
    from public.vm_conversation_members m
    join public.org_members om on om.org_id = m.org_id and om.user_id = m.user_id and om.status = 'active'
    join auth.users u on u.id = m.user_id
    join public.orgs o on o.id = m.org_id
    join public.vm_conversations c on c.id = m.conversation_id
    where m.status = 'active' and not ${HOLDS('m.org_id', 'm.user_id')}
    order by 1, 2, 3`)
  if (counts!.active === 0) console.log('  VACUOUS  no active seats at all')
  // CONTROL against a vacuous zero: the inline predicate must say YES for the
  // seats it keeps, so "0 lose access" is a real count, not a broken predicate.
  const [{ keeps }] = await sql.unsafe<{ keeps: number }[]>(`
    select count(*)::int as keeps from public.vm_conversation_members m
    where m.status = 'active' and ${HOLDS('m.org_id', 'm.user_id')}`)
  check(`CONTROL: the role predicate recognises the seats it keeps (${keeps} of ${counts!.active} active)`, counts!.active === 0 || keeps > 0)
  console.log(`  ${lose.length} active seat(s) held by an org member WITHOUT the vm role -> lose access`)
  for (const r of lose) console.log(`        ${r.email}  ${r.slug}  "${r.title}"  (${r.role})`)
  const creators = await sql.unsafe<{ email: string; title: string }[]>(`
    select u.email::text, c.title::text from public.vm_conversations c join auth.users u on u.id = c.created_by
    where not ${HOLDS('c.org_id', 'c.created_by')} order by 1, 2`)
  console.log(`  ${creators.length} conversation(s) whose CREATOR lacks the vm role -> creator arm stops reading it`)
  for (const r of creators) console.log(`        ${r.email}  "${r.title}"`)
  const stranded = await sql.unsafe<{ title: string }[]>(`
    select c.title::text from public.vm_conversations c
    where exists (select 1 from public.vm_conversation_members m where m.conversation_id = c.id and m.role = 'admin' and m.status = 'active')
      and not exists (select 1 from public.vm_conversation_members m
                      join public.org_members om on om.org_id = m.org_id and om.user_id = m.user_id and om.status = 'active'
                      where m.conversation_id = c.id and m.role = 'admin' and m.status = 'active'
                        and ${HOLDS('m.org_id', 'm.user_id')})`)
  console.log(`  ${stranded.length} conversation(s) left with NO admin seat that holds the floor (still managed by org managers)`)
  for (const r of stranded) console.log(`        "${r.title}"`)

  // Measured 2026-10-15 against the OLD vm_pin_conversation: a raw SQL delete of
  // a creator's auth.users row aborted on the FK, but GoTrue's
  // auth.admin.deleteUser reported success and left created_by pointing at the
  // deleted account (cause of the difference not established). Any such
  // dangling row already on prod is counted here.
  const [{ dangling }] = await sql<{ dangling: number }[]>`
    select count(*)::int as dangling from public.vm_conversations c
    where c.created_by is not null and not exists (select 1 from auth.users u where u.id = c.created_by)`
  check(`no conversation's created_by points at a deleted account (of ${counts!.convs})`, dangling === 0, `${dangling} dangling`)

  console.log('\n[1] One definition of the role, used twice')
  const helper = await src('vm_user_is_module_member')
  check('vm_user_is_module_member exists', helper.length > 0)
  check('anon cannot execute it', helper.length > 0 && !(await canExec('anon', 'public.vm_user_is_module_member(uuid,uuid)')))
  check('authenticated cannot execute it (no role-census oracle)', helper.length > 0 && !(await canExec('authenticated', 'public.vm_user_is_module_member(uuid,uuid)')))
  check('vm_is_module_member is a wrapper over it', /vm_user_is_module_member\(check_org_id, auth\.uid\(\)\)/.test(await src('vm_is_module_member')))
  check('the admin floor uses it for the third party', /vm_user_is_module_member\(m\.org_id, m\.user_id\)/.test(await src('vm_seat_holds_admin_floor')))

  console.log('\n[2] The five seat predicates keep org membership AND add the role')
  for (const f of ['vm_can_post', 'vm_can_react', 'vm_is_conv_member', 'vm_can_moderate', 'vm_is_conv_admin']) {
    const s = await src(f)
    check(`${f}: is_org_member AND vm_is_module_member on the seat`, /is_org_member\(m\.org_id\)/.test(s) && /vm_is_module_member\(m\.org_id\)/.test(s))
  }
  const sel = await policy('vm_conversations', 'vm_conversations_select')
  check('vm_conversations_select creator arm needs the role', /created_by = auth\.uid\(\)\) AND vm_is_module_member\(org_id\)/.test(sel?.qual ?? ''), sel?.qual ?? '')
  const mi = await policy('vm_conversation_members', 'vm_members_insert')
  check('vm_members_insert re-seat arm needs the role', /vm_is_module_member\(org_id\)/.test(mi?.with_check ?? ''), mi?.with_check ?? '')

  console.log('\n[3] Nobody credits a row to someone else')
  for (const [t, n, col] of [
    ['vm_reactions', 'vm_reactions_insert_manage', 'user_id'],
    ['vm_layers', 'vm_layers_insert_manage', 'author_id'],
    ['vm_conversations', 'vm_conversations_insert_manage', 'created_by'],
    ['vm_flags', 'vm_flags_insert_manage', 'reporter_user_id'],
  ] as const) {
    const p = await policy(t, n)
    check(`${n}: ${col} = auth.uid() AND vm_can_manage`, new RegExp(`${col} = auth\\.uid\\(\\)`).test(p?.with_check ?? '') && /vm_can_manage/.test(p?.with_check ?? ''), p?.with_check ?? '')
  }
  const trg = await sql<{ rel: string; tgname: string; tgtype: number; tgenabled: string }[]>`
    select tgrelid::regclass::text as rel, tgname::text, tgtype::int, tgenabled::text from pg_trigger
    where not tgisinternal and tgrelid in ('public.vm_layers'::regclass, 'public.vm_reactions'::regclass)
    order by 1, 2`
  const bound = (rel: string, name: string) => {
    const t = trg.find((x) => x.rel === rel && x.tgname === name)
    return !!t && (t.tgtype & (1 | 2 | 16)) === (1 | 2 | 16) && t.tgenabled !== 'D' // ROW|BEFORE|UPDATE
  }
  check('vm_layers_a_pin_credit is BOUND before update, enabled', bound('vm_layers', 'vm_layers_a_pin_credit'))
  check('vm_reactions_a_pin is BOUND before update, enabled', bound('vm_reactions', 'vm_reactions_a_pin'))
  const layerOrder = trg.filter((t) => t.rel === 'vm_layers').map((t) => t.tgname)
  check('the layer pin sorts before vm_layers_scope', layerOrder.indexOf('vm_layers_a_pin_credit') > -1 && layerOrder.indexOf('vm_layers_a_pin_credit') < layerOrder.indexOf('vm_layers_scope'), layerOrder.join(','))
  const lp = await src('vm_layers_pin_credit')
  check('the layer pin stamps tombstoned_by from auth.uid() and lets depth > 1 through', /tombstoned_by := auth\.uid\(\)/.test(lp) && /pg_trigger_depth\(\) > 1/.test(lp))
  const fp = await src('vm_pin_flag')
  const rep = fp.indexOf('new.reporter_user_id := old.reporter_user_id')
  check('vm_pin_flag pins the reporter BEFORE the manager escape', rep > -1 && rep < fp.indexOf('vm_can_manage'))
  check('vm_pin_flag keeps the review stamp when state is unchanged, stamps now() when it changes', /new\.reviewed_by := old\.reviewed_by/.test(fp) && /new\.reviewed_at := now\(\)/.test(fp) && !/coalesce\(new\.reviewed_at/.test(fp))
  const pin = await src('vm_pin_conversation')
  const createdPin = pin.indexOf('new.created_by := old.created_by')
  const escape = pin.indexOf('vm_can_manage')
  check('vm_pin_conversation pins created_by BEFORE the manager escape', createdPin > -1 && escape > -1 && createdPin < escape)
  check('vm_pin_conversation lets the FK SET NULL through (depth > 1)', /pg_trigger_depth\(\) > 1/.test(pin))
} finally {
  await sql.end()
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
