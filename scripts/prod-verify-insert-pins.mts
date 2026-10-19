// Prod verification for `20261017030000_insert_pins_other_modules.sql` — the
// BEFORE INSERT guards that close the "pinned on UPDATE, free on INSERT" class
// in classroom, visual messaging, nail salon, matchmaking and job_requests.
//
//   pnpm exec tsx scripts/prod-verify-insert-pins.mts
//   pnpm exec tsx scripts/prod-verify-insert-pins.mts --local
//
// WHY THIS FILE EXISTS. `prod-verify-migration.ts` checks function bodies only;
// every guard here is inert unless its TRIGGER is bound, enabled, BEFORE
// INSERT, and fires in the right position relative to the table's scope
// trigger (a guard that fires before org_id is re-derived would judge a
// client-supplied org). Modelled on `prod-verify-vm-admin-floor.mts`.
//
// EVERY ASSERTION CARRIES A CONTROL: a catalog read that returns nothing must
// never read as "correctly absent".
//
// READ-ONLY: nothing below is anything but a SELECT.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const MIGRATION = resolve(root, 'supabase/migrations/20261017030000_insert_pins_other_modules.sql')

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
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? '  ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`) }
}
const md5 = (s: string) => createHash('md5').update(s).digest('hex')

// table, guard trigger, function, the scope trigger it must follow (or precede), after?
const SPECS: [string, string, string, string | null, boolean][] = [
  ['cls_submissions', 'cls_submissions_zz_insert_guard', 'cls_guard_submission_insert', 'cls_submissions_scope', true],
  ['cls_submission_files', 'cls_submission_files_zz_insert_guard', 'cls_guard_submission_file_insert', 'cls_submission_files_scope', true],
  ['vm_layers', 'vm_layers_zz_insert_guard', 'vm_guard_layer_insert', 'vm_layers_scope', true],
  ['vm_flags', 'vm_flags_zz_insert_guard', 'vm_guard_flag_insert', 'vm_flags_scope', true],
  ['sal_appointments', 'sal_appointments_zz_insert_guard', 'sal_guard_appointment_insert', 'sal_appointments_scope', true],
  ['mm_questions', 'mm_questions_zz_insert_guard', 'mm_guard_question_insert', null, true],
  ['job_requests', 'job_requests_zz_insert_guard', 'job_requests_guard_insert', null, true],
  ['cls_survey_answers', 'cls_survey_answers_a_class_from_survey', 'cls_survey_answer_class_from_survey', 'cls_survey_answers_scope', false],
  ['cls_review_comments', 'cls_review_comments_zz_insert_guard', 'cls_guard_review_comment_insert', 'cls_review_comments_scope', true],
  ['smp_items', 'smp_items_zz_insert_guard', 'smp_guard_item_insert', 'smp_items_scope', true],
  ['vm_reactions', 'vm_reactions_zz_insert_guard', 'vm_guard_reaction_insert', 'vm_reactions_scope', true],
  ['vm_conversations', 'vm_conversations_zz_insert_guard', 'vm_guard_conversation_insert', null, true],
]

// Section 9, the UPDATE-side mirror: table, trigger, function, the trigger it
// must follow (true) or precede (false).
const UPDATE_SPECS: [string, string, string, string | null, boolean][] = [
  ['cls_submissions', 'cls_submissions_pin', 'cls_pin_submission_columns', null, true],
  ['cls_survey_answers', 'cls_survey_answers_0_pin', 'cls_pin_survey_answer', 'cls_survey_answers_a_class_from_survey', false],
  ['vm_layers', 'vm_layers_zz_update_pin', 'vm_pin_layer_created_at', 'vm_layers_scope', true],
  ['vm_flags', 'vm_flags_zz_update_pin', 'vm_pin_flag_created_at', 'vm_flags_a_pin', true],
  ['sal_appointments', 'sal_appointments_zz_update_pin', 'sal_pin_appointment_stamps', 'sal_appointments_pin', true],
  ['cls_review_assignments', 'cls_review_assignments_pin', 'cls_pin_assignment_columns', null, true],
  ['cls_grades', 'cls_grades_pin_author', 'cls_pin_grade_author', null, true],
  ['cls_review_comments', 'cls_review_comments_0_pin', 'cls_pin_review_comment', 'cls_review_comments_scope', false],
]

// Postgres fires same-timing triggers in byte-wise name order.
const cmpC = (a: string, b: string) => (Buffer.compare(Buffer.from(a), Buffer.from(b)))

console.log(`Prod verification — insert pins, other modules  (project ${ref})\n`)

try {
  // [1] Function bodies match the migration file, attributes, ACL.
  console.log('[1] guard functions: body md5, SECURITY DEFINER, pinned search_path, no api-role EXECUTE')
  const file = readFileSync(MIGRATION, 'utf8')
  const expected = new Map<string, string>()
  for (const m of file.matchAll(/create (?:or replace )?function public\.(\w+)\(\)[\s\S]*?\bas \$\$([\s\S]*?)\$\$;/g)) {
    expected.set(m[1]!, m[2]!)
  }
  check('CONTROL: the migration file parses to 20 function bodies', expected.size === 20, `${expected.size}`)

  const names = [...SPECS.map((s) => s[2]), ...UPDATE_SPECS.map((s) => s[2])]
  const fns = await sql<{ proname: string; prosecdef: boolean; proconfig: string[] | null; prosrc: string; proacl: string | null }[]>`
    select p.proname, p.prosecdef, p.proconfig, p.prosrc, p.proacl::text as proacl
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any(${names})`
  // CONTROL: a known, older pin function is readable through the same query shape.
  const ctl = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('cls_pin_submission_columns', 'sal_pin_appointment', 'vm_pin_flag')`
  check('CONTROL: pg_proc returns the three pre-existing UPDATE pins', ctl[0]!.n === 3, `${ctl[0]!.n}`)

  for (const name of names) {
    const f = fns.find((x) => x.proname === name)
    check(`${name} EXISTS`, !!f)
    if (!f) continue
    const want = expected.get(name)
    check(`  body md5 matches the migration`, !!want && md5(f.prosrc) === md5(want),
      `deployed ${md5(f.prosrc).slice(0, 8)} vs file ${want ? md5(want).slice(0, 8) : '-'}`)
    check('  SECURITY DEFINER', f.prosecdef)
    check('  search_path pinned to public', (f.proconfig ?? []).includes('search_path=public'), JSON.stringify(f.proconfig))
    for (const role of ['anon', 'authenticated', 'service_role']) {
      check(`  no EXECUTE for ${role}`, !(f.proacl ?? '').includes(`${role}=X/`), f.proacl ?? '(null acl)')
    }
    // PUBLIC is a bare `=X/owner` entry. A NULL acl means DEFAULT privileges,
    // which include PUBLIC EXECUTE — so null is a failure, not a pass.
    check('  no EXECUTE for PUBLIC (acl explicit, no bare =X/)',
      f.proacl !== null && !/(^|[{,])=X\//.test(f.proacl), f.proacl ?? '(null acl = default PUBLIC EXECUTE)')
  }

  // [1b] The classroom pins exempt on the CLASS-level predicate, never org-wide.
  for (const name of ['cls_pin_submission_columns', 'cls_pin_assignment_columns', 'cls_pin_grade_author']) {
    const body = fns.find((x) => x.proname === name)?.prosrc ?? ''
    check(`CONTROL: ${name} body readable`, body.length > 50, `${body.length} chars`)
    check(`${name} exempts on cls_can_manage_class(old.org_id, old.class_id), not cls_can_manage(org)`,
      body.includes('cls_can_manage_class(old.org_id, old.class_id)') && !body.includes('cls_can_manage(old.org_id)'))
  }

  // [2] Triggers are BOUND, ENABLED, BEFORE INSERT FOR EACH ROW, and ordered.
  console.log('\n[2] guard triggers: bound, enabled, BEFORE INSERT per row, ordered against the scope trigger')
  const tables = [...new Set(SPECS.map((s) => s[0]))]
  const trg = await sql<{ relname: string; tgname: string; tgenabled: string; proname: string; tgtype: number }[]>`
    select c.relname, t.tgname, t.tgenabled, p.proname, t.tgtype
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
    where n.nspname = 'public' and c.relname = any(${tables}) and not t.tgisinternal`
  // CONTROL: every table also shows a trigger that existed before this migration.
  const preexisting = ['cls_submissions_pin', 'cls_submission_files_scope', 'vm_layers_scope', 'vm_flags_a_pin',
    'sal_appointments_pin', 'mm_questions_updated_at', 'job_requests_updated_at', 'cls_survey_answers_scope',
    'cls_review_comments_scope', 'smp_items_scope', 'vm_reactions_scope', 'vm_conversations_a_pin']
  const seen = preexisting.filter((n) => trg.some((t) => t.tgname === n))
  check('CONTROL: each table\'s pre-existing trigger is readable', seen.length === preexisting.length,
    `${seen.length}/${preexisting.length}`)

  for (const [tbl, tg, fname, scopeTg, after] of SPECS) {
    const t = trg.find((x) => x.relname === tbl && x.tgname === tg)
    check(`${tbl}.${tg} is BOUND`, !!t)
    if (!t) continue
    check(`  ...to ${fname}`, t.proname === fname, t.proname)
    check("  ...ENABLED (tgenabled = 'O')", t.tgenabled === 'O', `tgenabled=${t.tgenabled}`)
    // tgtype bits: 1 ROW, 2 BEFORE, 4 INSERT, 16 UPDATE.
    check('  ...BEFORE INSERT FOR EACH ROW', (t.tgtype & 0b111) === 0b111, `tgtype=${t.tgtype}`)
    if (scopeTg) {
      const s = trg.find((x) => x.relname === tbl && x.tgname === scopeTg)
      check(`  CONTROL: scope trigger ${scopeTg} present and BEFORE INSERT`, !!s && (s.tgtype & 0b111) === 0b111)
      const order = cmpC(tg, scopeTg)
      check(`  fires ${after ? 'AFTER' : 'BEFORE'} ${scopeTg}`, after ? order > 0 : order < 0)
    }
  }
  console.log('\n[2b] UPDATE-side mirror triggers: bound, enabled, BEFORE UPDATE per row, ordered')
  const updTables = [...new Set(UPDATE_SPECS.map((s) => s[0]))]
  const utrg = await sql<{ relname: string; tgname: string; tgenabled: string; proname: string; tgtype: number }[]>`
    select c.relname, t.tgname, t.tgenabled, p.proname, t.tgtype
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
    where n.nspname = 'public' and c.relname = any(${updTables}) and not t.tgisinternal`
  check('CONTROL: the update-side tables return their triggers', utrg.length >= UPDATE_SPECS.length * 2, `${utrg.length}`)
  for (const [tbl, tg, fname, other, after] of UPDATE_SPECS) {
    const t = utrg.find((x) => x.relname === tbl && x.tgname === tg)
    check(`${tbl}.${tg} is BOUND to ${fname}`, t?.proname === fname, t?.proname ?? '-')
    check("  ...ENABLED (tgenabled = 'O')", t?.tgenabled === 'O', `tgenabled=${t?.tgenabled ?? '-'}`)
    // 1 ROW, 2 BEFORE, 16 UPDATE.
    check('  ...BEFORE UPDATE FOR EACH ROW', !!t && (t.tgtype & 0b10011) === 0b10011, `tgtype=${t?.tgtype}`)
    if (other) {
      check(`  CONTROL: ${other} present`, utrg.some((x) => x.relname === tbl && x.tgname === other))
      const order = cmpC(tg, other)
      check(`  fires ${after ? 'AFTER' : 'BEFORE'} ${other}`, after ? order > 0 : order < 0)
    }
  }

  // The survey derivation must also cover UPDATE (an answer's class cannot be moved).
  const sv = trg.find((x) => x.tgname === 'cls_survey_answers_a_class_from_survey')
  check('cls_survey_answers_a_class_from_survey also fires on UPDATE', !!sv && (sv.tgtype & 16) === 16, `tgtype=${sv?.tgtype}`)

  // [3] Live data, reported honestly. A row created BEFORE this migration may
  // already carry a forged value; this measures whether any does.
  console.log('\n[3] live data — rows that already carry a value the guards would now refuse/coerce')
  const live = await sql<{ k: string; total: number; suspect: number }[]>`
    select 'cls_submissions with an override' as k,
           (select count(*)::int from public.cls_submissions) as total,
           (select count(*)::int from public.cls_submissions where visible_override_until is not null) as suspect
    union all
    select 'cls_submission_files outside their submission folder',
           (select count(*)::int from public.cls_submission_files),
           (select count(*)::int from public.cls_submission_files
             where split_part(storage_path, '/', 3) is distinct from submission_id::text)
    union all
    select 'cls_survey_answers whose class != the survey class',
           (select count(*)::int from public.cls_survey_answers),
           (select count(*)::int from public.cls_survey_answers a join public.cls_surveys s on s.id = a.survey_id
             where a.class_id <> s.class_id)
    union all
    select 'vm_flags not open with no reviewer',
           (select count(*)::int from public.vm_flags),
           (select count(*)::int from public.vm_flags where state <> 'open' and reviewed_by is null)
    union all
    select 'pending mm_questions carrying locks or an approver',
           (select count(*)::int from public.mm_questions),
           (select count(*)::int from public.mm_questions where status = 'pending'
             and (admin_locks <> '{}'::jsonb or approved_by is not null))
    union all
    select 'job_requests of an unknown kind',
           (select count(*)::int from public.job_requests),
           (select count(*)::int from public.job_requests where kind <> 'synagogue-schedules.render')`
  for (const r of live) {
    console.log(`      ${r.k}: ${r.suspect} of ${r.total}${r.total === 0 ? '  (EMPTY — vacuous, not "clean")' : ''}`)
  }
  console.log('      (informational: a non-zero count is a row to READ, not automatically a forgery —')
  console.log('       e.g. a manager may legitimately set an override.)')

  console.log(`\n${pass} checks passed, ${fail} failed`)
} finally {
  await sql.end()
}
process.exit(fail === 0 ? 0 : 1)
