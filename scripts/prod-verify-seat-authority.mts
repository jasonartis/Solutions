// Prod verification for `20260910040000_seat_requires_org_membership.sql` and
// `20260910030000_vm_self_block.sql` — the half `prod-verify-migration.ts`
// cannot see.
//
// WHY THIS FILE EXISTS. `prod-verify-migration.ts` parses `create function`
// blocks only. `20260910040000` also replaces FIVE inline RLS policies, and
// `20260910030000`'s whole point is a TRIGGER — and a trigger function can be
// deployed, correct, and simply NOT BOUND. For both of those a function-only
// run reports "0 failures" while asserting nothing about them, which is the
// vacuity trap docs/03 names. Copied from `prod-verify-superadmin-log.mts`,
// the worked template for table/policy/trigger work.
//
// EVERY ASSERTION CARRIES A CONTROL. A catalog query that returns zero rows —
// wrong schema, a permission the connection lacks, a typo in a name — looks
// exactly like "the thing is absent", and would let this script PASS a missing
// policy as a correctly-absent one.
//
// READ-ONLY. It issues nothing but selects against pg_catalog.
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
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? '  ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`) }
}

console.log(`Prod verification — seat authority + self-block  (project ${ref})\n`)

try {
  // -------------------------------------------------------------------------
  // [1] The five replaced POLICIES carry the org conjunct.
  //     CONTROL first: prove the catalog read works at all.
  // -------------------------------------------------------------------------
  console.log('[1] the five inline policy arms carry is_org_member')
  const allPolicies = await sql<{ n: string }[]>`select count(*)::text as n from pg_policies where schemaname = 'public'`
  const policyCount = Number(allPolicies[0]!.n)
  check('CONTROL: pg_policies is readable and non-empty', policyCount > 100, `${policyCount} policies in public`)

  const targets = [
    'mm_groups_select_assigned',
    'mm_group_members_select_assigned',
    'sal_appointments_select',
    'sal_appointments_update_worker',
    'sal_worker_time_off_select',
  ]
  const rows = await sql<{ policyname: string; qual: string | null; with_check: string | null }[]>`
    select policyname, qual, with_check from pg_policies
    where schemaname = 'public' and policyname = any(${targets})
  `
  check('all five policies exist on prod', rows.length === 5, `found ${rows.length}/5`)
  for (const t of targets) {
    const r = rows.find((x) => x.policyname === t)
    const text = `${r?.qual ?? ''} ${r?.with_check ?? ''}`
    check(`${t} gates on is_org_member`, !!r && text.includes('is_org_member'))
  }
  // sal_appointments_update_worker is the only one with BOTH arms; a missing
  // with_check would silently let a non-member write the post-image.
  const upd = rows.find((x) => x.policyname === 'sal_appointments_update_worker')
  check(
    'sal_appointments_update_worker has the conjunct in BOTH using and with_check',
    !!upd?.qual?.includes('is_org_member') && !!upd?.with_check?.includes('is_org_member'),
  )

  // -------------------------------------------------------------------------
  // [2] The eight functions are ORG-GATED on prod — with a control proving the
  //     query discriminates (docs/19's own method).
  // -------------------------------------------------------------------------
  console.log('\n[2] the eight predicates are org-gated (with a discriminating control)')
  const fns = [
    'mm_matchmaker_can_see', 'mm_assignment_covers_me', 'sd_owns_participant', 'sd_in_event',
    'sd_paired_with', 'sd_mentors', 'sal_worker_sees_customer', 'cls_reviews_submission',
  ]
  const gated = await sql<{ proname: string; org: boolean }[]>`
    select p.proname, pg_get_functiondef(p.oid) like '%is_org_member%' as org
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any(${[...fns, 'syn_can_write']})
  `
  // CONTROL: syn_can_write is a module predicate that legitimately does NOT
  // read a roster seat, so it must come back FALSE. If everything returns true
  // the query is matching something other than what we think.
  const control = gated.find((g) => g.proname === 'syn_can_write')
  check('CONTROL: the org-gated probe discriminates (syn_can_write is not seat-gated)', control?.org === false)
  for (const f of fns) {
    const g = gated.find((x) => x.proname === f)
    check(`${f} is org-gated on prod`, g?.org === true)
  }

  // -------------------------------------------------------------------------
  // [3] Self-block: the trigger is BOUND and ENABLED, not merely defined.
  //     A deployed trigger FUNCTION with no trigger attached is the silent
  //     failure this whole file exists for.
  // -------------------------------------------------------------------------
  console.log('\n[3] self-block: vm_members_a_pin is bound and enabled')
  const trg = await sql<{ tgname: string; tgenabled: string; relname: string; proname: string }[]>`
    select t.tgname, t.tgenabled, c.relname, p.proname
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_proc  p on p.oid = t.tgfoid
    where not t.tgisinternal and c.relname = 'vm_conversation_members'
  `
  check('CONTROL: vm_conversation_members has user triggers at all', trg.length > 0, `${trg.length} found`)
  const pin = trg.find((t) => t.proname === 'vm_pin_member')
  check('vm_members_a_pin is BOUND to vm_pin_member', !!pin, pin?.tgname ?? 'absent')
  check("trigger is ENABLED (tgenabled = 'O')", pin?.tgenabled === 'O', `tgenabled=${pin?.tgenabled ?? '-'}`)
  // Trigger ORDER is load-bearing: same-event triggers fire alphabetically and
  // the pin must run BEFORE the scope-sync trigger (docs/03 #11).
  const scope = trg.find((t) => t.proname === 'vm_sync_from_conversation')
  check(
    'the pin sorts BEFORE the scope trigger (docs/03 #11)',
    !!pin && !!scope && pin.tgname < scope.tgname,
    `${pin?.tgname} < ${scope?.tgname}`,
  )

  // -------------------------------------------------------------------------
  // [4] The self-block carve-out really is one-directional in the deployed body.
  // -------------------------------------------------------------------------
  console.log('\n[4] self-block is one-directional in the DEPLOYED body')
  const body = await sql<{ def: string }[]>`
    select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'vm_pin_member'
  `
  const def = body[0]?.def ?? ''
  check('CONTROL: vm_pin_member body was readable', def.length > 200, `${def.length} chars`)
  check("permits active -> banned only", def.includes("old.status = 'active' and new.status = 'banned'"))
  check('still pins role (no self-promotion)', def.includes('new.role := old.role'))
  check('still enforces last-admin-standing', def.includes('A conversation must keep at least one admin'))

  console.log(`\n${pass} passed, ${fail} failed`)
} finally {
  await sql.end()
}

process.exit(fail === 0 ? 0 : 1)
