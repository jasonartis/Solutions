// Prod verification for the speed-dating pair
//   20261017010000_sd_self_rejoin.sql  (self-rejoin, DB-decided self-registration, self-edit pins)
//   20261017020000_sd_hardening.sql    (mentor pointer, interest, reports, notes, bans,
//                                       authority helpers, pairings, organizer seating)
//
//   pnpm exec tsx scripts/prod-verify-sd-self-rejoin.mts
//   pnpm exec tsx scripts/prod-verify-sd-self-rejoin.mts --local
//
// WHY THIS FILE EXISTS. `prod-verify-migration.ts` checks function bodies, but
// what enforces these migrations is mostly TRIGGERS, which can be deployed and
// correct and simply not BOUND, or bound and DISABLED. Modelled on
// `scripts/prod-verify-vm-admin-floor.mts`.
//
// EVERY ASSERTION CARRIES A CONTROL: a catalog read returning zero rows must
// not read as "the thing is absent".
//
// READ-ONLY: nothing below is anything but a SELECT.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
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

// Every function body the two migrations define, exactly as Postgres stores
// it in prosrc (everything between `as $$` and the closing `$$;`). The LAST
// definition of a name wins, as it does when the files are applied in order.
// 20261027010000 re-creates sd_participants_insert_guard and sd_pin_participant
// (closed state, FOR SHARE, event_id pin), so its bodies win.
const FILES = ['20261017010000_sd_self_rejoin.sql', '20261017020000_sd_hardening.sql', '20261027010000_sd_closed_event_state.sql']
const expected = new Map<string, string>()
for (const f of FILES) {
  const text = readFileSync(resolve(root, 'supabase/migrations', f), 'utf8')
  const re = /create or replace function public\.(\w+)\([\s\S]*?\nas \$\$([\s\S]*?)\$\$;/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    expected.set(m[1]!, createHash('md5').update(m[2]!).digest('hex'))
  }
}

// kind 'internal' = trigger function or helper called only from definer
// triggers: VOLATILE, no API-role EXECUTE. kind 'policy' = called from RLS
// policies: STABLE, EXECUTE for exactly authenticated + service_role.
const FUNCTIONS: Record<string, 'internal' | 'policy'> = {
  sd_registration_status: 'internal',
  sd_participants_insert_guard: 'internal',
  sd_pin_participant: 'internal',
  sd_participants_integrity: 'internal',
  sd_interest_before_write: 'internal',
  sd_reports_guard: 'internal',
  sd_notes_guard: 'internal',
  sd_bans_stamp: 'internal',
  sd_pairings_before_write: 'internal',
  sd_mentors: 'policy',
  sd_paired_with: 'policy',
  sd_can_organize_event: 'policy',
  sd_can_staff_event_of: 'policy',
}

// [table, trigger, function, required tgtype bits]. tgtype bits:
// 1 ROW, 2 BEFORE, 4 INSERT, 8 DELETE, 16 UPDATE.
const TRIGGERS: [string, string, string, number][] = [
  ['sd_participants', 'sd_participants_a_pin', 'sd_pin_participant', 1 | 2 | 16],
  ['sd_participants', 'sd_participants_b_insert_guard', 'sd_participants_insert_guard', 1 | 2 | 4],
  ['sd_participants', 'sd_participants_c_integrity', 'sd_participants_integrity', 1 | 2 | 4 | 16],
  ['sd_interest', 'sd_interest_scope', 'sd_interest_before_write', 1 | 2 | 4 | 16],
  ['sd_reports', 'sd_reports_b_guard', 'sd_reports_guard', 1 | 2 | 4 | 16],
  ['sd_notes', 'sd_notes_b_guard', 'sd_notes_guard', 1 | 2 | 4],
  ['sd_bans', 'sd_bans_a_stamp', 'sd_bans_stamp', 1 | 2 | 4 | 16],
  ['sd_pairings', 'sd_pairings_scope', 'sd_pairings_before_write', 1 | 2 | 4 | 16],
]

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? '  ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`) }
}

console.log(`Prod verification — speed dating self-rejoin + hardening  (project ${ref})\n`)

try {
  // -------------------------------------------------------------------------
  // [1] Every function: deployed body, attributes, ACL.
  // -------------------------------------------------------------------------
  console.log('[1] functions')
  check('CONTROL: the migration files yield one body per expected function',
    Object.keys(FUNCTIONS).every((f) => (expected.get(f) ?? '').length === 32),
    `${expected.size} bodies parsed`)

  const fns = await sql<
    { proname: string; prosecdef: boolean; proconfig: string[] | null; provolatile: string; proacl: string | null; md5: string; prosrc: string }[]
  >`
    select p.proname, p.prosecdef, p.proconfig, p.provolatile, p.proacl::text as proacl,
           md5(p.prosrc) as md5, p.prosrc
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any(${Object.keys(FUNCTIONS)})
  `
  check('CONTROL: pg_proc returns every expected function exactly once',
    fns.length === Object.keys(FUNCTIONS).length, `${fns.length}/${Object.keys(FUNCTIONS).length}`)

  for (const [name, kind] of Object.entries(FUNCTIONS)) {
    const f = fns.find((x) => x.proname === name)
    check(`${name} EXISTS`, !!f)
    check(`  body md5 matches the migration`, f?.md5 === expected.get(name), `db=${f?.md5 ?? '-'} file=${expected.get(name) ?? '-'}`)
    check(`  SECURITY DEFINER`, f?.prosecdef === true)
    check(`  search_path pinned to public`, (f?.proconfig ?? []).includes('search_path=public'), JSON.stringify(f?.proconfig ?? null))
    const acl = f?.proacl ?? ''
    check(`  ACL is not NULL (NULL = PUBLIC EXECUTE)`, f?.proacl != null, f?.proacl ?? '(null acl)')
    check(`  no EXECUTE for anon`, !acl.includes('anon=X/'), acl)
    check(`  no EXECUTE for PUBLIC`, !/(^|[{,])=X\//.test(acl), acl)
    if (kind === 'internal') {
      check(`  VOLATILE (docs/03 #30)`, f?.provolatile === 'v', `provolatile=${f?.provolatile ?? '-'}`)
      check(`  no EXECUTE for authenticated / service_role`,
        !acl.includes('authenticated=X/') && !acl.includes('service_role=X/'), acl)
    } else {
      check(`  STABLE`, f?.provolatile === 's', `provolatile=${f?.provolatile ?? '-'}`)
      check(`  EXECUTE for authenticated and service_role`,
        acl.includes('authenticated=X/') && acl.includes('service_role=X/'), acl)
    }
  }

  // -------------------------------------------------------------------------
  // [2] Body landmarks. Redundant when the md5s match; they say WHICH part is
  //     wrong when one does not. prosrc includes comments, so each landmark
  //     is matched as code.
  // -------------------------------------------------------------------------
  console.log('\n[2] body landmarks')
  const src = (n: string) => fns.find((f) => f.proname === n)?.prosrc ?? ''
  check('CONTROL: sd_pin_participant body is non-empty', src('sd_pin_participant').length > 500)
  check('pin: keeps the no-JWT bypass', /if auth\.uid\(\) is null then\s+return new;/.test(src('sd_pin_participant')))
  check('pin: pins id and created_at', /new\.id := old\.id;/.test(src('sd_pin_participant'))
    && /new\.created_at := old\.created_at;/.test(src('sd_pin_participant')))
  check('pin: a removed seat is frozen (return old)', /if old\.status = 'removed' then[\s\S]*?return old;/.test(src('sd_pin_participant')))
  check('pin: rejoin uses the shared capacity helper',
    /public\.sd_registration_status\(old\.event_id, old\.pool_side, old\.id\)/.test(src('sd_pin_participant')))
  check('insert guard: uses the shared capacity helper',
    /public\.sd_registration_status\(new\.event_id, new\.pool_side, new\.id\)/.test(src('sd_participants_insert_guard')))
  check('insert guard: requires an open event', /ev\.state is distinct from 'open'/.test(src('sd_participants_insert_guard')))
  check('capacity helper: takes the advisory lock', /pg_advisory_xact_lock/.test(src('sd_registration_status')))
  check('sd_mentors: requires same event + consent',
    /t\.event_id = m\.event_id/.test(src('sd_mentors')) && /t\.allows_mentor/.test(src('sd_mentors')))
  check('integrity: reads org_members directly for the seated user',
    /from public\.org_members om\s+where om\.org_id = ev_org and om\.user_id = new\.user_id/.test(src('sd_participants_integrity')))
  check('interest: requires a pairing', /from public\.sd_pairings pr/.test(src('sd_interest_before_write')))
  check('reports: forces state open on a non-organizer insert', /new\.state := 'open';/.test(src('sd_reports_guard')))
  check('organize helper: compares the event org to the argument',
    /e\.org_id = check_org_id/.test(src('sd_can_organize_event')))
  check('pin: consent rule — only the person re-registers a withdrawn seat',
    /raise exception 'Only the person can register again'/.test(src('sd_pin_participant')))
  check("pin: consent rule covers 'removed' too (no two-step bypass)",
    /if old\.status in \('withdrawn', 'removed'\)\s+and new\.status in \('registered', 'waitlisted'\)/.test(src('sd_pin_participant')))
  check('notes: non-staff authors only about someone they were paired with',
    /join public\.sd_pairings pr/.test(src('sd_notes_guard')))
  check('notes: author must hold a seat (or staff) before anything else',
    /where a\.event_id = e\.id and a\.user_id = auth\.uid\(\)/.test(src('sd_notes_guard')))
  check("reports: a foreign reporter seat is refused first",
    /rep\.user_id is distinct from auth\.uid\(\)/.test(src('sd_reports_guard')))
  check('interest: retraction carve-out', /tg_op = 'UPDATE' and new\.verdict <> 'interested'/.test(src('sd_interest_before_write')))
  check('integrity: consents reset on user_id change', /new\.allows_mentor := false;/.test(src('sd_participants_integrity')))
  check('pairings: generic refusal for non-organizers', /Not allowed to write pairings/.test(src('sd_pairings_before_write')))

  // -------------------------------------------------------------------------
  // [3] Triggers bound, enabled, with the right timing.
  // -------------------------------------------------------------------------
  console.log('\n[3] triggers are BOUND and ENABLED')
  const trg = await sql<{ relname: string; tgname: string; tgenabled: string; proname: string; tgtype: number }[]>`
    select c.relname, t.tgname, t.tgenabled, p.proname, t.tgtype
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
    where n.nspname = 'public' and c.relname like 'sd\\_%' and not t.tgisinternal
  `
  check('CONTROL: sd_ triggers are readable', trg.length >= 20, `${trg.length} triggers`)
  for (const [table, name, fn, bits] of TRIGGERS) {
    const t = trg.find((x) => x.relname === table && x.tgname === name)
    check(`${table}.${name} BOUND to ${fn}`, t?.proname === fn, t?.proname ?? '-')
    check(`  ENABLED (tgenabled = 'O')`, t?.tgenabled === 'O', `tgenabled=${t?.tgenabled ?? '-'}`)
    check(`  timing/events`, ((t?.tgtype ?? 0) & bits) === bits, `tgtype=${t?.tgtype}`)
  }
  // Ordering on sd_participants: the guards run before the scope trigger.
  const pNames = trg.filter((x) => x.relname === 'sd_participants').map((x) => x.tgname).sort()
  check('sd_participants guards sort before sd_participants_scope',
    ['sd_participants_a_pin', 'sd_participants_b_insert_guard', 'sd_participants_c_integrity']
      .every((n) => pNames.indexOf(n) >= 0 && pNames.indexOf(n) < pNames.indexOf('sd_participants_scope')),
    pNames.join(', '))

  // -------------------------------------------------------------------------
  // [4] RLS doors these triggers rely on are unchanged.
  // -------------------------------------------------------------------------
  console.log('\n[4] sd_participants self policies are unchanged')
  const pol = await sql<{ polname: string; qual: string | null; chk: string | null }[]>`
    select polname, pg_get_expr(polqual, polrelid) as qual, pg_get_expr(polwithcheck, polrelid) as chk
    from pg_policy where polrelid = 'public.sd_participants'::regclass
  `
  check('CONTROL: sd_participants policies are readable', pol.length >= 4, pol.map((p) => p.polname).join(', '))
  const self = pol.find((p) => p.polname === 'sd_participants_update_self')
  const expectedSelf = '((user_id = auth.uid()) AND is_org_member(org_id))'
  check('update_self USING is owner + org member', self?.qual === expectedSelf, self?.qual ?? '-')
  check('update_self WITH CHECK is owner + org member', self?.chk === expectedSelf, self?.chk ?? '-')
  const ins = pol.find((p) => p.polname === 'sd_participants_insert_self')
  check('insert_self still requires user_id = auth.uid() and sd_is_participant',
    /user_id = auth\.uid\(\)/.test(ins?.chk ?? '') && /sd_is_participant\(org_id\)/.test(ins?.chk ?? ''), ins?.chk ?? '-')

  // -------------------------------------------------------------------------
  // [5] Live data, reported honestly.
  // -------------------------------------------------------------------------
  console.log('\n[5] live data')
  const [l] = await sql<{ seats: number; bad_mentors: number; withdrawn_open: number; reports: number; interest: number }[]>`
    select
      (select count(*)::int from public.sd_participants) as seats,
      (select count(*)::int from public.sd_participants m
         left join public.sd_participants t on t.id = m.mentee_participant_id
         where m.mentee_participant_id is not null
           and (t.id is null or t.event_id <> m.event_id or not t.allows_mentor)) as bad_mentors,
      (select count(*)::int from public.sd_participants p join public.sd_events e on e.id = p.event_id
         where p.status = 'withdrawn' and e.state = 'open') as withdrawn_open,
      (select count(*)::int from public.sd_reports) as reports,
      (select count(*)::int from public.sd_interest) as interest
  `
  console.log(`      seats=${l!.seats}  withdrawn-in-open-events=${l!.withdrawn_open}  reports=${l!.reports}  interest=${l!.interest}`)
  check('no existing mentor seat points outside its event or at a non-consenting mentee', l!.bad_mentors === 0,
    `${l!.bad_mentors} bad`)
  if (l!.seats === 0) {
    console.log('      NO SEATS — behaviour on prod is UNMEASURED; the structural checks above are the whole proof.')
  }

  console.log(`\n${pass} checks passed, ${fail} failed`)
} finally {
  await sql.end()
}
process.exit(fail === 0 ? 0 : 1)
