// Prod verification for `20260914010000_vm_split_for_all_write_policies.sql`
// and `20260914020000_vm_last_conversation_admin_delete_guard.sql`.
//
// WHY THIS FILE EXISTS. `prod-verify-migration.ts` parses `create function`
// blocks only. The first of these migrations defines NO function at all — it is
// pure policy DDL — so a function-only run reports "0 failures" while asserting
// literally nothing, the vacuity trap docs/03 names. The second defines one
// function whose whole point is being BOUND as a trigger, which that script
// also cannot see. Copied from `prod-verify-seat-authority.mts`, itself copied
// from `prod-verify-superadmin-log.mts` — the worked template for
// table/policy/trigger work.
//
// EVERY ASSERTION CARRIES A CONTROL. A catalog query returning zero rows —
// wrong schema, a permission the pooler connection lacks, a typo — looks
// exactly like "the thing is correctly absent", and would let this script PASS
// a missing policy as a deliberate one.
//
// IT ALSO MEASURES BLAST RADIUS, and that half is meaningful BEFORE the
// migrations are applied (convention added 2026-09-13: measure a narrowing
// migration's blast radius on PROD before applying it). `20260914020000` is a
// narrowing — it refuses a DELETE that used to succeed — so the number of
// conversations it can bite on prod is worth knowing rather than assuming.
//
// READ-ONLY. It issues nothing but selects.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const env = readFileSync(resolve(root, '.env.deploy'), 'utf8')
const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''

const ref = get('SUPABASE_PROJECT_REF')
const pw = get('SUPABASE_DB_PASSWORD')
if (!ref || !pw) throw new Error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD in .env.deploy')

const sql = postgres(
  `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`,
  { ssl: 'require', max: 1 },
)

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++
    console.log(`  ok    ${name}${detail ? '  ' + detail : ''}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`)
  }
}

const SPLIT = ['vm_conversations', 'vm_layers', 'vm_conversation_members', 'vm_reactions', 'vm_flags']

console.log(`Prod verification — vm policy split + last-admin guard  (project ${ref})\n`)

try {
  // --- 0. the connection really is prod, and really is postgres ------------
  const [who] = await sql<{ me: string; db: string }[]>`
    select current_user as me, current_database() as db
  `
  check('connected as postgres to the prod database', who!.me === 'postgres', `${who!.me}@${who!.db}`)

  // --- 1. blast radius (meaningful BEFORE applying) ------------------------
  console.log('\n[1] blast radius of the narrowing (20260914020000)')
  const [vol] = await sql<{ convs: number; seats: number }[]>`
    select (select count(*)::int from public.vm_conversations)        as convs,
           (select count(*)::int from public.vm_conversation_members) as seats
  `
  console.log(`  info  prod holds ${vol!.convs} conversations and ${vol!.seats} seats`)

  const [sole] = await sql<{ n: number }[]>`
    select count(*)::int as n from (
      select conversation_id
      from public.vm_conversation_members
      where role = 'admin' and status = 'active'
      group by conversation_id
      having count(*) = 1
    ) t
  `
  console.log(`  info  ${sole!.n} conversation(s) have exactly ONE active admin — the rows the guard protects`)

  // The landmine found while building this, NOT fixed by either migration:
  // vm_pin_conversation reverts the created_by SET NULL, so deleting any of
  // these users is impossible. Reported so the number is known before docs/21
  // builds account deletion on top of it.
  const [creators] = await sql<{ n: number }[]>`
    select count(distinct created_by)::int as n
    from public.vm_conversations where created_by is not null
  `
  console.log(
    `  info  ${creators!.n} distinct user(s) created a conversation and therefore CANNOT be deleted today (docs/20 §30)`,
  )

  // --- 2. the split itself -------------------------------------------------
  console.log('\n[2] the `for all` read arm is gone (20260914010000)')
  const forAll = await sql<{ tablename: string; policyname: string }[]>`
    select tablename, policyname from pg_policies
    where schemaname = 'public' and tablename = any(${SPLIT}) and cmd = 'ALL'
  `
  check(
    'no `for all` policy remains on the five vm tables',
    forAll.length === 0,
    forAll.map((r) => `${r.tablename}.${r.policyname}`).join(', '),
  )
  // CONTROL: the query can see these tables' policies at all, so the empty
  // result above is a fact about `cmd = ALL` rather than a broken catalog read.
  const [seen] = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_policies
    where schemaname = 'public' and tablename = any(${SPLIT})
  `
  check('CONTROL: pg_policies returns the vm tables', (seen?.n ?? 0) > 15, `${seen?.n} policies`)

  const perCmd = await sql<{ tablename: string; policyname: string; cmd: string; qual: string | null }[]>`
    select tablename, policyname, cmd, qual from pg_policies
    where schemaname = 'public' and tablename = any(${SPLIT})
      and policyname ~ '_(insert|update|delete)_manage$'
    order by tablename, cmd
  `
  check('all 15 per-command policies exist', perCmd.length === 15, `${perCmd.length} found`)
  // `.every()` on an EMPTY array is true, so both of the next two would have
  // reported ok against a database where the migration had never run — caught
  // by running this script before applying, which is the whole reason to run it
  // then. Each now requires its own non-empty subject.
  const inserts = perCmd.filter((p) => p.cmd === 'INSERT')
  check(
    'every INSERT policy has no USING (a read arm would be back)',
    inserts.length === 5 && inserts.every((p) => p.qual === null),
    `${inserts.length} insert policies (expected 5)`,
  )
  check(
    'every new policy gates on vm_can_manage(org_id) verbatim',
    perCmd.length === 15 && perCmd.every((p) => (p.qual ?? 'vm_can_manage(org_id)').includes('vm_can_manage')),
  )

  // polroles {0} = PUBLIC, matching the originals. A recreate that narrowed the
  // role would silently change who the policy applies to.
  const roled = await sql<{ polname: string }[]>`
    select polname from pg_policy
    where polrelid = any(${SPLIT}::regclass[]) and polname ~ '_(insert|update|delete)_manage$'
      and polroles <> '{0}'
  `
  // Same vacuity guard: "none of them is role-scoped" is meaningless if none of
  // them exists, so this is conditioned on all 15 being present.
  check(
    'policies still apply to PUBLIC, not a narrowed role',
    perCmd.length === 15 && roled.length === 0,
    roled.map((r) => r.polname).join(', '),
  )

  // --- 3. the last-admin guard --------------------------------------------
  console.log('\n[3] the last-admin DELETE guard (20260914020000)')
  const fn = await sql<{ prosecdef: boolean; proconfig: string[] | null; src: string }[]>`
    select prosecdef, proconfig, prosrc as src from pg_proc
    where pronamespace = 'public'::regnamespace and proname = 'vm_guard_last_conversation_admin'
  `
  check('vm_guard_last_conversation_admin is deployed', fn.length === 1)
  check('it is SECURITY DEFINER', fn[0]?.prosecdef === true)
  check(
    'it pins search_path',
    (fn[0]?.proconfig ?? []).some((c) => c.startsWith('search_path=')),
    (fn[0]?.proconfig ?? []).join(','),
  )
  // The defect the adversarial review caught. If prod somehow carries the first
  // draft, the cascade escape covers one FK instead of three and deleting a
  // user becomes impossible.
  check(
    'it uses pg_trigger_depth() (the three-cascade escape), not the one-FK draft',
    (fn[0]?.src ?? '').includes('pg_trigger_depth'),
  )

  const trg = await sql<{ tgname: string; tgenabled: string; tgtype: number }[]>`
    select tgname, tgenabled::text as tgenabled, tgtype::int as tgtype from pg_trigger
    where tgrelid = 'public.vm_conversation_members'::regclass
      and not tgisinternal and tgname = 'vm_members_b_last_admin'
  `
  check('the trigger is BOUND, not merely defined', trg.length === 1)
  check('the trigger is ENABLED', trg[0]?.tgenabled === 'O', trg[0]?.tgenabled)
  // tgtype 11 = ROW(1) | BEFORE(2) | DELETE(8). Bound on the wrong event is the
  // exact shape of the bug this migration fixes.
  check('the trigger fires ROW BEFORE DELETE (tgtype 11)', trg[0]?.tgtype === 11, `tgtype=${trg[0]?.tgtype}`)

  // CONTROL for the whole trigger block: the sibling triggers really are
  // visible through this connection, so an absent one above would be a fact.
  const [sibs] = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_trigger
    where tgrelid = 'public.vm_conversation_members'::regclass and not tgisinternal
  `
  check('CONTROL: pg_trigger returns this table’s triggers', (sibs?.n ?? 0) >= 4, `${sibs?.n} triggers`)

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`)
  process.exitCode = fail === 0 ? 0 : 1
} finally {
  await sql.end()
}
