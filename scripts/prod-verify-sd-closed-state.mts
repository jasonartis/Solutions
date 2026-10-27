// Prod verification for 20261027010000_sd_closed_event_state.sql
// (speed dating: the `closed` event state, the back-to-draft rule, the
// FOR SHARE serialisation, and the "a seat never moves to another event" pin).
//
//   node node_modules/tsx/dist/cli.mjs scripts/prod-verify-sd-closed-state.mts
//   node node_modules/tsx/dist/cli.mjs scripts/prod-verify-sd-closed-state.mts --local
//
// Run it BEFORE and AFTER `migrate:prod`: before, the closed-state checks fail
// and every CONTROL passes; after, everything passes. The generic
// prod-verify-migration.ts would be blind to most of this (a CHECK constraint,
// a policy, trigger bindings).
//
// EVERY ASSERTION CARRIES A CONTROL: a catalog read returning zero rows must
// not read as "the thing is absent". Behaviour is proven by
// packages/db/src/sd-closed-state.test.ts (local) and by the browser prod
// checks; this script proves the deployed STRUCTURE.
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

// Bodies exactly as Postgres stores them in prosrc. The LAST definition wins.
function bodies(file: string): Map<string, string> {
  const text = readFileSync(resolve(root, 'supabase/migrations', file), 'utf8')
  const out = new Map<string, string>()
  const re = /create or replace function public\.(\w+)\([\s\S]*?\nas \$\$([\s\S]*?)\$\$;/g
  for (let m = re.exec(text); m; m = re.exec(text)) out.set(m[1]!, createHash('md5').update(m[2]!).digest('hex'))
  return out
}
const mine = bodies('20261027010000_sd_closed_event_state.sql')
const control = bodies('20261017010000_sd_self_rejoin.sql')

const FUNCTIONS = ['sd_guard_event', 'sd_participants_insert_guard', 'sd_pin_participant']
// What each body must contain on prod (a cheap second reading next to the md5).
const MUST_CONTAIN: [string, RegExp, string][] = [
  ['sd_guard_event', /old\.state = 'closed' and new\.state in \('open', 'running', 'cancelled', 'draft'\)/, 'closed -> open|running|cancelled|draft'],
  ['sd_guard_event', /cannot go back to draft/, 'the back-to-draft refusal'],
  ['sd_participants_insert_guard', /where e\.id = new\.event_id for share/, 'reads the event FOR SHARE'],
  ['sd_participants_insert_guard', /Registration for this event is closed/, 'the closed refusal'],
  ['sd_pin_participant', /new\.event_id is distinct from old\.event_id then\s+raise exception 'A registration cannot be moved/, 'refuses a seat move for every JWT caller'],
  ['sd_pin_participant', /where e\.id = old\.event_id for share/, 'rejoin reads the event FOR SHARE'],
]

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? '  ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`) }
}

console.log(`Prod verification — speed dating closed event state  (project ${ref})\n`)

try {
  // -------------------------------------------------------------------------
  console.log('[1] functions')
  check('CONTROL: the migration file yields a body for each function',
    FUNCTIONS.every((f) => (mine.get(f) ?? '').length === 32), `${mine.size} bodies parsed`)
  const fns = await sql<
    { proname: string; prosecdef: boolean; proconfig: string[] | null; provolatile: string; proacl: string | null; md5: string; prosrc: string }[]
  >`
    select p.proname, p.prosecdef, p.proconfig, p.provolatile, p.proacl::text as proacl,
           md5(p.prosrc) as md5, p.prosrc
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any(${[...FUNCTIONS, 'sd_registration_status']})`
  check('CONTROL: pg_proc returns each function exactly once', fns.length === FUNCTIONS.length + 1, `${fns.length}/${FUNCTIONS.length + 1}`)
  const reg = fns.find((f) => f.proname === 'sd_registration_status')
  check('CONTROL: an UNCHANGED neighbour (sd_registration_status) md5-matches its own migration',
    !!reg && reg.md5 === control.get('sd_registration_status'), `db=${reg?.md5 ?? '-'}`)
  for (const name of FUNCTIONS) {
    const f = fns.find((x) => x.proname === name)
    check(`${name} body md5 matches 20261027010000`, f?.md5 === mine.get(name), `db=${f?.md5 ?? '-'} file=${mine.get(name) ?? '-'}`)
    check(`  SECURITY DEFINER`, f?.prosecdef === true)
    check(`  VOLATILE`, f?.provolatile === 'v')
    check(`  search_path pinned to public`, (f?.proconfig ?? []).includes('search_path=public'))
    const acl = f?.proacl ?? ''
    check(`  no API-role or PUBLIC EXECUTE`, f?.proacl != null && !/(anon|authenticated|service_role)=/.test(acl) && !/(^|[{,])=X/.test(acl), acl || '(null acl)')
  }
  for (const [name, re, what] of MUST_CONTAIN) {
    check(`${name}: ${what}`, re.test(fns.find((x) => x.proname === name)?.prosrc ?? ''))
  }

  // -------------------------------------------------------------------------
  console.log('\n[2] the state CHECK')
  const cons = await sql<{ conname: string; def: string }[]>`
    select con.conname, pg_get_constraintdef(con.oid) as def
    from pg_constraint con where con.conrelid = 'public.sd_events'::regclass and con.contype = 'c'`
  check('CONTROL: sd_events carries CHECK constraints at all', cons.length > 0, `${cons.length}`)
  const stateChecks = cons.filter((c) => c.def.includes("'draft'"))
  check('exactly one state CHECK', stateChecks.length === 1, stateChecks.map((c) => c.conname).join(', '))
  check("it admits 'closed'", stateChecks.length === 1 && stateChecks[0]!.def.includes("'closed'"), stateChecks[0]?.def ?? '-')

  // -------------------------------------------------------------------------
  console.log('\n[3] triggers bound and enabled')
  // [table, trigger, function, required tgtype bits: 1 ROW, 2 BEFORE, 4 INSERT, 16 UPDATE]
  const TRIGGERS: [string, string, string, number][] = [
    ['sd_events', 'sd_events_guard', 'sd_guard_event', 1 | 2 | 16],
    ['sd_participants', 'sd_participants_a_pin', 'sd_pin_participant', 1 | 2 | 16],
    ['sd_participants', 'sd_participants_b_insert_guard', 'sd_participants_insert_guard', 1 | 2 | 4],
  ]
  const trg = await sql<{ rel: string; tgname: string; fn: string; tgtype: number; tgenabled: string }[]>`
    select c.relname as rel, t.tgname, p.proname as fn, t.tgtype::int as tgtype, t.tgenabled::text as tgenabled
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
    where c.relname in ('sd_events', 'sd_participants') and not t.tgisinternal`
  check('CONTROL: the two tables carry user triggers', trg.length >= 3, `${trg.length}`)
  for (const [rel, name, fn, bits] of TRIGGERS) {
    const t = trg.find((x) => x.rel === rel && x.tgname === name)
    check(`${rel}.${name} -> ${fn}, enabled, right events`,
      !!t && t.fn === fn && t.tgenabled === 'O' && (t.tgtype & bits) === bits, t ? `${t.fn} ${t.tgenabled} ${t.tgtype}` : 'missing')
  }

  // -------------------------------------------------------------------------
  console.log('\n[4] sd_events SELECT policy')
  const pols = await sql<{ policyname: string; cmd: string; qual: string | null }[]>`
    select policyname, cmd, qual from pg_policies where schemaname = 'public' and tablename = 'sd_events'`
  check('CONTROL: sd_events has its usual policies (select/insert/update/delete)', pols.length >= 4, `${pols.length}`)
  const sel = pols.filter((p) => p.cmd === 'SELECT' || p.cmd === 'ALL')
  check('exactly one SELECT-covering policy', sel.length === 1, sel.map((p) => p.policyname).join(', '))
  check("participants still see a 'closed' event", (sel[0]?.qual ?? '').includes("'closed'"))
  check('CONTROL: the staff arm is unchanged', (sel[0]?.qual ?? '').includes('sd_can_staff_event_of'))

  // -------------------------------------------------------------------------
  console.log('\n[5] live data')
  const states = await sql<{ state: string; n: number }[]>`select state, count(*)::int as n from public.sd_events group by state order by state`
  console.log(`      events by state: ${states.map((s) => `${s.state}=${s.n}`).join('  ') || '(none)'}`)
  const [bad] = await sql<{ n: number }[]>`
    select count(*)::int as n from public.sd_participants p join public.sd_events e on e.id = p.event_id
    where e.state = 'draft' and p.status in ('registered', 'waitlisted')`
  check('no DRAFT event holds a live seat (the back-to-draft invariant)', bad!.n === 0, `${bad!.n}`)
  const [seats] = await sql<{ n: number }[]>`select count(*)::int as n from public.sd_participants`
  check('CONTROL: the seat table is readable', seats!.n >= 0, `${seats!.n} seats`)

  console.log(`\n${pass} checks passed, ${fail} failed`)
} finally {
  await sql.end()
}
process.exit(fail === 0 ? 0 : 1)
