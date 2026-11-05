// Prod verification for 20261109010000_sd_host_untick_device_status.sql (module-6 spec,
// 2026-11-05: host un-tick + camera/mic/connection status).
//
//   node node_modules/tsx/dist/cli.mjs scripts/prod-verify-sd-device-status.mts
//   node node_modules/tsx/dist/cli.mjs scripts/prod-verify-sd-device-status.mts --local
//
// Run it BEFORE and AFTER `migrate:prod`: before, the structural checks and the new-rule
// probes fail while the CONTROLS pass; after, everything passes.
//
// [1] STRUCTURE from the catalog (each with a control): sd_device_status exists, RLS on,
//     exactly one SELECT policy with a staff arm and an own-row arm, the REAL table ACL
//     (SELECT only for authenticated; nothing for anon / service_role); the five function
//     bodies md5-match the migration, definer + pinned search_path + VOLATILE; EXECUTE for
//     authenticated on the reporter only; the three triggers BOUND and enabled.
// [2] BEHAVIOUR as real users, inside ONE transaction that is ALWAYS ROLLED BACK, so nothing
//     is left behind on prod. Demo accounts by id only (no sign-in): alice = organizer of
//     demo-dating, charlie / dana = daters, eve = given a HOST grant inside the transaction.
//     A throwaway running event with seats for charlie and dana is created as the owner.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
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
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${detail})`}`)
}

const text = readFileSync(resolve(root, 'supabase/migrations/20261109010000_sd_host_untick_device_status.sql'), 'utf8')
const expected = new Map<string, string>()
const re = /create or replace function public\.(\w+)\([\s\S]*?\nas \$\$([\s\S]*?)\$\$;/g
for (let m = re.exec(text); m; m = re.exec(text)) expected.set(m[1]!, createHash('md5').update(m[2]!).digest('hex'))
const NAMES = [
  'sd_pin_participant', 'sd_report_device_status', 'sd_events_clear_device_status',
  'sd_participants_clear_device_status', 'account_silhouette',
]

try {
  console.log(`[1] structure — ${LOCAL ? 'LOCAL' : `PROD (${ref})`}`)
  const [{ n: allTables }] = await sql<{ n: number }[]>`select count(*)::int as n from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'`
  check('CONTROL: the catalog read works (public has tables)', allTables > 10, `${allTables}`)
  const [sp] = await sql<{ acl: string | null }[]>`select relacl::text as acl from pg_class where oid = 'public.sd_participants'::regclass`
  check('CONTROL: sd_participants is readable in the catalog and grants authenticated', /authenticated=/.test(sp?.acl ?? ''), sp?.acl ?? '-')

  const [row] = await sql<{ rls: boolean; acl: string | null }[]>`
    select c.relrowsecurity as rls, c.relacl::text as acl from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relname = 'sd_device_status'`
  check('sd_device_status exists', !!row)
  check('  RLS enabled', row?.rls === true)
  const acl = row?.acl ?? ''
  check('  authenticated holds SELECT only', /authenticated=r\//.test(acl), acl)
  check('  anon holds nothing', !/(^|[{,])anon=/.test(acl), acl)
  check('  service_role holds nothing', !/service_role=/.test(acl), acl)
  check('  PUBLIC holds nothing', !/(^|[{,])=[a-zA-Z]/.test(acl), acl)
  const pols = await sql<{ cmd: string; qual: string }[]>`
    select polcmd::text as cmd, pg_get_expr(polqual, polrelid) as qual
    from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relnamespace = 'public'::regnamespace and c.relname = 'sd_device_status'`
  check('  exactly one policy, SELECT', pols.length === 1 && pols[0]!.cmd === 'r', JSON.stringify(pols.map((p) => p.cmd)))
  const q = pols[0]?.qual ?? ''
  check('  its arms: event staff, and the person (as an active member)',
    /sd_can_staff_event_of\(org_id, event_id\)/.test(q) && /user_id = auth\.uid\(\)/.test(q) && /is_org_member\(org_id\)/.test(q), q)
  check('  NO arm for other daters (no sd_in_event / sd_paired_with)', !/sd_in_event|sd_paired_with|sd_is_participant/.test(q), q)

  const fns = await sql<{ proname: string; prosecdef: boolean; provolatile: string; proconfig: string[] | null; acl: string | null; md5: string }[]>`
    select p.proname, p.prosecdef, p.provolatile, p.proconfig, p.proacl::text as acl, md5(p.prosrc) as md5
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any(${NAMES})`
  check(`CONTROL: migration file parsed (${NAMES.length} bodies)`, NAMES.every((n) => expected.has(n)), [...expected.keys()].join(','))
  for (const name of NAMES) {
    const f = fns.find((x) => x.proname === name)
    check(`${name} body md5 matches the migration`, !!f && f.md5 === expected.get(name), `db=${f?.md5 ?? '-'}`)
    check('  SECURITY DEFINER, VOLATILE, search_path pinned',
      f?.prosecdef === true && f?.provolatile === 'v' && (f?.proconfig ?? []).includes('search_path=public'))
    const a = f?.acl ?? ''
    if (name === 'sd_report_device_status') {
      check('  EXECUTE: authenticated only', /authenticated=X/.test(a) && !/(anon|service_role)=X/.test(a) && !/(^|[{,])=X/.test(a), a || '-')
    } else {
      check('  EXECUTE: no API role', !!f && a !== '' && !/(anon|authenticated|service_role)=X/.test(a) && !/(^|[{,])=X/.test(a), a || '-')
    }
  }
  const trg = await sql<{ tgname: string; rel: string; fn: string; en: string }[]>`
    select t.tgname, t.tgrelid::regclass::text as rel, t.tgfoid::regproc::text as fn, t.tgenabled::text as en
    from pg_trigger t
    where t.tgname in ('sd_participants_a_pin', 'sd_events_zz_clear_device_status', 'sd_participants_zz_clear_device_status')`
  const bound = (n: string, rel: string, fn: string) => trg.some((t) => t.tgname === n && t.rel === rel && t.fn === fn && t.en === 'O')
  check('CONTROL: the existing pin trigger is bound', bound('sd_participants_a_pin', 'sd_participants', 'sd_pin_participant'))
  check('sd_events_zz_clear_device_status bound + enabled', bound('sd_events_zz_clear_device_status', 'sd_events', 'sd_events_clear_device_status'))
  check('sd_participants_zz_clear_device_status bound + enabled', bound('sd_participants_zz_clear_device_status', 'sd_participants', 'sd_participants_clear_device_status'))

  console.log('[2] behaviour as real users (one transaction, always rolled back)')
  const people = await sql<{ email: string; id: string }[]>`
    select email, id::text from auth.users where email in ('alice@demo.local', 'charlie@demo.local', 'dana@demo.local', 'eve@demo.local')`
  const idOf = (e: string) => people.find((r) => r.email === `${e}@demo.local`)?.id
  const [org] = await sql<{ id: string }[]>`select id from orgs where slug = 'demo-dating'`
  check('CONTROL: demo accounts and demo-dating exist', people.length === 4 && !!org)
  const deployed = !!row
  const out: Record<string, unknown> = {}
  if (org && people.length === 4) {
    await sql
      .begin(async (tx) => {
        const as = async (who: string, key: string, run: () => Promise<postgres.RowList<postgres.Row[]>>) => {
          await tx.unsafe('savepoint s')
          try {
            await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: idOf(who), role: 'authenticated' })}, true)`
            await tx.unsafe('set local role authenticated')
            const r = await run()
            out[key] = r.count
            out[`${key}_val`] = r[0] ? Object.values(r[0])[0] : null
            await tx.unsafe('release savepoint s')
          } catch (e) {
            await tx.unsafe('rollback to savepoint s')
            out[`${key}_err`] = String((e as Error).message)
          }
          await tx.unsafe('reset role')
          await tx`select set_config('request.jwt.claims', '', true)`
        }
        const [ev] = await tx<{ id: string }[]>`
          insert into sd_events (org_id, name, state) values (${org.id}, 'prod-verify device probe', 'running') returning id`
        const [c] = await tx<{ id: string }[]>`
          insert into sd_participants (org_id, event_id, user_id, status) values (${org.id}, ${ev!.id}, ${idOf('charlie')!}, 'registered') returning id`
        const [d] = await tx<{ id: string }[]>`
          insert into sd_participants (org_id, event_id, user_id, status) values (${org.id}, ${ev!.id}, ${idOf('dana')!}, 'registered') returning id`
        await tx`update sd_participants set checked_in = true, checked_in_at = now() - interval '5 minutes' where id = ${d!.id}`
        await tx`insert into module_roles (org_id, user_id, module_key, role) values (${org.id}, ${idOf('eve')!}, 'speed-dating', 'host')`

        // Part 1 — check-in on someone else's seat.
        await as('alice', 'orgTickIn', () => tx`update sd_participants set checked_in = true where id = ${c!.id}`)
        await as('eve', 'hostTickIn', () => tx`update sd_participants set checked_in = true where id = ${c!.id}`)
        await as('charlie', 'selfTickIn', () => tx`update sd_participants set checked_in = true where id = ${c!.id}`)
        await as('eve', 'hostUntick', () => tx`update sd_participants set checked_in = false where id = ${d!.id}`)
        const [dAfter] = await tx<{ checked_in: boolean; at: Date | null }[]>`select checked_in, checked_in_at as at from sd_participants where id = ${d!.id}`
        out.danaAfter = dAfter

        // Part 2 — device status.
        if (deployed) {
          await as('charlie', 'report', () => tx`select public.sd_report_device_status(${ev!.id}, 'ok', 'blocked', 'not_in_call')`)
          await as('charlie', 'report2', () => tx`select public.sd_report_device_status(${ev!.id}, 'ok', 'ok', 'not_in_call')`)
          await as('charlie', 'badValue', () => tx`select public.sd_report_device_status(${ev!.id}, 'Logitech C920', 'ok', 'connected')`)
          await as('alice', 'readOrganizer', () => tx`select participant_id from sd_device_status where event_id = ${ev!.id}`)
          await as('eve', 'readHost', () => tx`select participant_id from sd_device_status where event_id = ${ev!.id}`)
          await as('charlie', 'readSelf', () => tx`select participant_id from sd_device_status where event_id = ${ev!.id}`)
          await as('dana', 'readOtherDater', () => tx`select participant_id from sd_device_status where event_id = ${ev!.id}`)
          await as('dana', 'directInsert', () => tx`insert into sd_device_status (participant_id, org_id, event_id, user_id, camera, mic, connection)
            values (${d!.id}, ${org.id}, ${ev!.id}, ${idOf('dana')!}, 'ok', 'ok', 'connected')`)
          await as('alice', 'directUpdate', () => tx`update sd_device_status set camera = 'ok' where event_id = ${ev!.id}`)
          await as('alice', 'complete', () => tx`update sd_events set state = 'complete' where id = ${ev!.id}`)
          const [left] = await tx<{ n: number }[]>`select count(*)::int as n from sd_device_status where event_id = ${ev!.id}`
          out.afterComplete = left!.n
        }
        throw new Error('__rollback__')
      })
      .catch((e: unknown) => {
        if ((e as Error).message !== '__rollback__') throw e
      })

    check('CONTROL: the person ticks themselves in', out.selfTickIn === 1 && !out.selfTickIn_err, JSON.stringify(out.selfTickIn_err ?? ''))
    check('an ORGANIZER cannot tick someone else in', /Only the person can check themselves in/.test(String(out.orgTickIn_err ?? '')), String(out.orgTickIn_err ?? `rows=${out.orgTickIn}`))
    check('a HOST cannot tick someone else in', /Only the person can check themselves in/.test(String(out.hostTickIn_err ?? '')), String(out.hostTickIn_err ?? `rows=${out.hostTickIn}`))
    check('a HOST un-ticks someone: checked_in false, time cleared',
      out.hostUntick === 1 && (out.danaAfter as { checked_in: boolean; at: Date | null }).checked_in === false && (out.danaAfter as { at: Date | null }).at === null,
      JSON.stringify(out.danaAfter))
    if (deployed) {
      check("the person reports: 'saved'", out.report_val === 'saved', JSON.stringify([out.report_val, out.report_err]))
      check("a second report at once: 'throttled'", out.report2_val === 'throttled', JSON.stringify([out.report2_val, out.report2_err]))
      check('a device label is refused', /Invalid device status/.test(String(out.badValue_err ?? '')), String(out.badValue_err))
      check('CONTROL: the organizer reads it', out.readOrganizer === 1, JSON.stringify(out.readOrganizer))
      check('a host reads it', out.readHost === 1, JSON.stringify(out.readHost))
      check('the person reads their own', out.readSelf === 1, JSON.stringify(out.readSelf))
      check('another dater at the same event reads nothing', out.readOtherDater === 0, JSON.stringify(out.readOtherDater))
      check('a direct INSERT is refused', /permission denied/.test(String(out.directInsert_err ?? '')), String(out.directInsert_err))
      check('a direct UPDATE (organizer) is refused', /permission denied/.test(String(out.directUpdate_err ?? '')), String(out.directUpdate_err))
      check('completing the event deletes its rows', !out.complete_err && out.afterComplete === 0, JSON.stringify([out.complete_err, out.afterComplete]))
    } else {
      check('device-status behaviour probes (skipped: the table is not deployed)', false)
    }
    const [leftEv] = await sql<{ n: number }[]>`select count(*)::int as n from sd_events where name = 'prod-verify device probe'`
    check('nothing left behind (rolled back)', leftEv!.n === 0)
  }
} finally {
  await sql.end()
}
console.log(`\n${pass} checks passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
