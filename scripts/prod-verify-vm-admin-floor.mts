// Prod verification for `20260922030000_vm_admin_floor_requires_org_membership.sql`
// — the last-admin floor now counts only seats that actually confer adminship
// (docs/19's STILL-OPEN item 2).
//
//   pnpm exec tsx scripts/prod-verify-vm-admin-floor.mts
//   pnpm exec tsx scripts/prod-verify-vm-admin-floor.mts --local
//
// WHY THIS FILE EXISTS. `prod-verify-migration.ts` parses `create function`
// blocks only, and it would pass this migration on body md5s alone while
// asserting nothing about the thing that actually enforces it: two TRIGGERS,
// which can be deployed, correct, and simply NOT BOUND — or bound but DISABLED.
// Copied from `scripts/prod-verify-seat-authority.mts`, which was written for
// exactly that gap.
//
// EVERY ASSERTION CARRIES A CONTROL. A catalog query that returns zero rows —
// wrong schema, a permission the connection lacks, a typo in a name — looks
// identical to "the thing is absent", and would let this script report a
// missing guard as a correctly-absent one.
//
// READ-ONLY: nothing below is anything but a SELECT.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const env = readFileSync(resolve(root, '.env.deploy'), 'utf8')
const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''

const LOCAL = process.argv.includes('--local')

let ref = '(local)'
let sql: ReturnType<typeof postgres>
if (LOCAL) {
  sql = postgres(process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres', { max: 1 })
} else {
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
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? '  ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`) }
}

console.log(`Prod verification — vm last-admin floor  (project ${ref})\n`)

try {
  // -------------------------------------------------------------------------
  // [1] The helper exists, with the right attributes.
  //     It is the single definition of "a seat that holds the floor"; if it is
  //     missing or non-definer the whole migration is inert or broken.
  // -------------------------------------------------------------------------
  console.log('[1] the helper vm_seat_holds_admin_floor')
  const fns = await sql<
    { proname: string; prosecdef: boolean; proconfig: string[] | null; provolatile: string; proacl: string | null }[]
  >`
    select p.proname, p.prosecdef, p.proconfig, p.provolatile, p.proacl::text as proacl
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('vm_seat_holds_admin_floor', 'vm_pin_member', 'vm_guard_last_conversation_admin')
  `
  // CONTROL: a catalog read that returns nothing must not read as "absent".
  check('CONTROL: pg_proc is readable and returns the three functions', fns.length === 3,
    `found ${fns.length}: ${fns.map((f) => f.proname).join(', ')}`)

  const helper = fns.find((f) => f.proname === 'vm_seat_holds_admin_floor')
  check('vm_seat_holds_admin_floor EXISTS', !!helper)
  check('  it is SECURITY DEFINER', helper?.prosecdef === true)
  check('  its search_path is pinned to public',
    (helper?.proconfig ?? []).includes('search_path=public'), JSON.stringify(helper?.proconfig ?? null))
  check('  it is STABLE (not volatile)', helper?.provolatile === 's', `provolatile=${helper?.provolatile ?? '-'}`)
  // docs/03 #1: a function is granted EXECUTE to PUBLIC at CREATE, and on PROD
  // the default privileges also grant anon/authenticated directly. Only the two
  // definer triggers call this, so no api role may hold EXECUTE.
  for (const role of ['anon', 'authenticated', 'service_role']) {
    check(`  no EXECUTE for ${role}`, !(helper?.proacl ?? '').includes(`${role}=X/`), helper?.proacl ?? '(null acl)')
  }
  // PUBLIC appears as a BARE `=X/owner` entry — no role name before the `=`.
  // Testing for the substring '=X/' alone matches `postgres=X/postgres` and
  // fails against a perfectly locked-down function; anchor it to a delimiter.
  check('  no EXECUTE for PUBLIC', !/(^|[{,])=X\//.test(helper?.proacl ?? ''), helper?.proacl ?? '(null acl)')

  // -------------------------------------------------------------------------
  // [2] Both trigger function BODIES actually call the helper — twice each.
  //     Twice is the point: step (3) "is this seat a floor-holder" and step (4)
  //     "is there another" must use the SAME definition, or they drift apart,
  //     which is the defect this migration exists to fix.
  // -------------------------------------------------------------------------
  console.log('\n[2] both guards call the helper, in BOTH places')
  const bodies = await sql<{ proname: string; prosrc: string }[]>`
    select p.proname, p.prosrc
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('vm_pin_member', 'vm_guard_last_conversation_admin')
  `
  for (const name of ['vm_pin_member', 'vm_guard_last_conversation_admin']) {
    const body = bodies.find((b) => b.proname === name)?.prosrc ?? ''
    check(`CONTROL: ${name} has a non-empty body`, body.length > 100, `${body.length} chars`)
    // `prosrc` INCLUDES COMMENTS (a recorded gotcha in this repo), and both
    // bodies mention the helper by name in a comment. Match a real CALL —
    // schema-qualified, with its opening paren — or the count comes out one
    // too high and this check fails against correct code.
    const calls = (body.match(/public\.vm_seat_holds_admin_floor\s*\(/g) ?? []).length
    check(`${name} calls the helper TWICE (steps 3 and 4)`, calls === 2, `${calls} call(s)`)
    // The raw predicate must be GONE, or a stale copy is still deciding.
    const stale = /role\s*=\s*'admin'\s*\n?\s*and\s+status\s*=\s*'active'/.test(body)
    check(`${name} no longer counts raw role='admin' seats`, !stale,
      stale ? 'the pre-migration floor predicate is still present' : '')
    // The escapes the migration promises not to touch.
    check(`${name} keeps its pg_trigger_depth cascade escape`, body.includes('pg_trigger_depth() > 1'))
    check(`${name} keeps its vm_can_manage manager escape`, body.includes('vm_can_manage(old.org_id)'))
  }
  // Both guards must stay VOLATILE. A `stable` trigger function stops seeing
  // rows the same statement has already deleted, so one multi-row DELETE would
  // silently orphan a conversation — no error anywhere. Named by the
  // adversarial review of this migration; asserted here because it is invisible
  // in the function body itself.
  for (const name of ['vm_pin_member', 'vm_guard_last_conversation_admin']) {
    const f = fns.find((x) => x.proname === name)
    check(`${name} is VOLATILE (a STABLE guard cannot see in-statement deletes)`,
      f?.provolatile === 'v', `provolatile=${f?.provolatile ?? '-'}`)
  }

  // Self-block is the platform's only user-level block and lives in the pin.
  const pinBody = bodies.find((b) => b.proname === 'vm_pin_member')?.prosrc ?? ''
  check("vm_pin_member still carries the self-block carve-out (active -> banned)",
    /old\.status\s*=\s*'active'\s+and\s+new\.status\s*=\s*'banned'/.test(pinBody))
  check('vm_pin_member still pins role unconditionally (no self-promotion)',
    /new\.role\s*:=\s*old\.role/.test(pinBody))

  // -------------------------------------------------------------------------
  // [3] The triggers are BOUND and ENABLED — the half a function-only check
  //     cannot see, and the reason this file exists.
  // -------------------------------------------------------------------------
  console.log('\n[3] both triggers are BOUND and ENABLED on vm_conversation_members')
  const trg = await sql<{ tgname: string; tgenabled: string; proname: string; tgtype: number }[]>`
    select t.tgname, t.tgenabled, p.proname, t.tgtype
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
    where n.nspname = 'public' and c.relname = 'vm_conversation_members' and not t.tgisinternal
    order by t.tgname
  `
  check('CONTROL: the table has its triggers readable at all', trg.length >= 3,
    trg.map((t) => t.tgname).join(', '))

  const pin = trg.find((t) => t.tgname === 'vm_members_a_pin')
  check('vm_members_a_pin is BOUND', !!pin)
  check('  ...to vm_pin_member', pin?.proname === 'vm_pin_member', pin?.proname ?? '-')
  check("  ...and ENABLED (tgenabled = 'O')", pin?.tgenabled === 'O', `tgenabled=${pin?.tgenabled ?? '-'}`)

  const guard = trg.find((t) => t.tgname === 'vm_members_b_last_admin')
  check('vm_members_b_last_admin is BOUND', !!guard)
  check('  ...to vm_guard_last_conversation_admin',
    guard?.proname === 'vm_guard_last_conversation_admin', guard?.proname ?? '-')
  check("  ...and ENABLED (tgenabled = 'O')", guard?.tgenabled === 'O', `tgenabled=${guard?.tgenabled ?? '-'}`)

  // tgtype bits: 1 ROW, 2 BEFORE, 4 INSERT, 8 DELETE, 16 UPDATE.
  check('the pin fires BEFORE UPDATE, per row', ((pin?.tgtype ?? 0) & 0b10011) === 0b10011, `tgtype=${pin?.tgtype}`)
  check('the guard fires BEFORE DELETE, per row', ((guard?.tgtype ?? 0) & 0b1011) === 0b1011, `tgtype=${guard?.tgtype}`)

  // -------------------------------------------------------------------------
  // [4] LIVE DATA: is any conversation actually affected?
  //     A structural pass says the guard is installed, never that it is doing
  //     the right thing to real rows. Reported honestly: zero conversations
  //     means UNMEASURABLE, not "clean".
  // -------------------------------------------------------------------------
  console.log('\n[4] live data — orphaned admin seats and would-be-blocked leavers')
  const live = await sql<
    { conversations: number; admin_seats: number; held: number; orphaned: number; stranded: number }[]
  >`
    with admin_seats as (
      select m.id, m.conversation_id,
             exists (
               select 1 from public.org_members om
               where om.org_id = m.org_id and om.user_id = m.user_id and om.status = 'active'
             ) as holder_is_member
      from public.vm_conversation_members m
      where m.role = 'admin' and m.status = 'active'
    )
    select
      (select count(*)::int from public.vm_conversations)                       as conversations,
      (select count(*)::int from admin_seats)                                   as admin_seats,
      (select count(*) filter (where holder_is_member)::int from admin_seats)   as held,
      (select count(*) filter (where not holder_is_member)::int from admin_seats) as orphaned,
      (select count(*)::int from (
         select conversation_id from admin_seats
         group by conversation_id
         having count(*) filter (where holder_is_member) = 0
       ) s)                                                                     as stranded
  `
  const l = live[0]!
  console.log(`      conversations=${l.conversations}  active admin seats=${l.admin_seats}` +
    `  held-by-members=${l.held}  orphaned=${l.orphaned}  stranded conversations=${l.stranded}`)
  if (l.admin_seats === 0) {
    console.log('      NO ACTIVE ADMIN SEATS — this section is VACUOUS and proves nothing')
    console.log('      about live behaviour. Do NOT report it as "zero affected".')
  } else {
    check('CONTROL: at least one admin seat resolves to an active org member (the join works)', l.held > 0,
      `${l.held}/${l.admin_seats}`)
    check('no conversation is STRANDED (admin seats but none effective)', l.stranded === 0,
      `${l.stranded} stranded`)
  }

  console.log(`\n${pass} checks passed, ${fail} failed`)
} finally {
  await sql.end()
}
process.exit(fail === 0 ? 0 : 1)
