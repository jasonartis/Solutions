// Verify the ACL-hardening migration (20260728010000) against a real database.
//
//   pnpm exec tsx scripts/verify-acl-hardening.ts --preflight   # BEFORE migrate:prod
//   pnpm exec tsx scripts/verify-acl-hardening.ts               # after: assert end state
//   pnpm exec tsx scripts/verify-acl-hardening.ts --probe        # + live anon probe
//   VERIFY_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//     pnpm exec tsx scripts/verify-acl-hardening.ts --probe      # local dry-run
//
// WHY THIS EXISTS, separately from its two neighbours:
//   * scripts/prod-verify-migration.ts parses `create [or replace] function` blocks.
//     An ACL-ONLY migration defines none, so it can only confirm the version row.
//   * scripts/acl-audit.ts REPORTS privilege state (and is the right tool for a
//     before/after diff) but only prints — it never fails.
// This asserts the intended end state and exits non-zero, so it can gate a push.
//
// --preflight is the important one and MUST be run against prod before the push.
// The migration blanket-revokes EXECUTE on every function in `public` and then
// re-grants an ENUMERATED list that was generated from the LOCAL catalog. Any
// function that exists on prod but not in that list would lose `authenticated`
// EXECUTE permanently — and if it is named in an RLS policy, every authenticated
// query on that table fails with "permission denied for function". Checking that
// after the revoke has committed is detection, not prevention.
//
// --probe proves behavior rather than catalog contents: it becomes `anon` and
// actually attempts reads and writes, expecting refusals, inside a transaction that
// is ALWAYS rolled back (a savepoint per attempt so an expected error cannot abort
// the run). There is no commit path.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const MIGRATION_VERSION = '20260728010000'
const MIGRATION_PATH = resolve(
  root,
  'supabase/migrations/20260728010000_acl_hardening.sql',
)

// Allowlists are FULL SIGNATURES, not bare names: a future overload of
// syn_public_week granted to anon must not slip through on a name match.
const ANON_SIGNATURES = new Set([
  'syn_public_weeks(p_org_slug text)',
  'syn_public_week(p_org_slug text, p_week_start date)',
])
const ORACLE_SIGNATURES = new Set([
  'module_scope_covers(ancestor uuid, descendant uuid)',
  'module_scope_strictly_contains(ancestor uuid, descendant uuid)',
])
// Tables whose authenticated grant is deliberately narrower than full CRUD.
const TABLE_EXCEPTIONS: Record<string, string[]> = {
  job_requests: ['SELECT', 'INSERT'],
  vm_moderation_log: ['SELECT', 'INSERT'],
  mm_interests: ['SELECT', 'INSERT', 'DELETE'],
  profiles: ['SELECT', 'INSERT', 'DELETE'],
  syn_zmanim_cache: [],
}
const FULL_CRUD = ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
const PROFILE_UPDATE_COLUMNS = ['display_name', 'settings']
// MAINTAIN is PG17 and prod's `m` bit is real; `revoke all` clears it, but a
// leftover would otherwise be invisible.
const NON_DML = ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']

const doProbe = process.argv.includes('--probe')
const doPreflight = process.argv.includes('--preflight')

function prodTarget() {
  const env = readFileSync(resolve(root, '.env.deploy'), 'utf8')
  const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''
  const ref = get('SUPABASE_PROJECT_REF')
  const pw = get('SUPABASE_DB_PASSWORD')
  if (!ref || !pw) {
    console.error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD in .env.deploy')
    process.exit(1)
  }
  return {
    label: `PROD (${ref})`,
    url: `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`,
  }
}
const target = process.env.VERIFY_DB_URL
  ? { label: 'LOCAL', url: process.env.VERIFY_DB_URL }
  : prodTarget()

const sql = postgres(target.url, {
  ssl: target.url.includes('supabase.com') ? 'require' : false,
  prepare: false,
  max: 1,
  idle_timeout: 5,
})

let failures = 0
let checks = 0
const ok = (m: string) => {
  checks++
  console.log(`  ok    ${m}`)
}
const bad = (m: string) => {
  checks++
  failures++
  console.log(`  FAIL  ${m}`)
}
const expect = (cond: boolean, m: string) => (cond ? ok(m) : bad(m))

/** Signatures the migration explicitly grants EXECUTE on, parsed from the file. */
function grantedSignatures() {
  const text = readFileSync(MIGRATION_PATH, 'utf8')
  const out = new Set<string>()
  // Only real statements — a `--` comment line must never count as a grant.
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('--')) continue
    const m = /^grant\s+execute\s+on\s+function\s+public\.([a-z0-9_]+)\s*\((.*?)\)\s+to\s/i.exec(line)
    if (m) out.add(`${m[1]}(${m[2].replace(/\s+/g, ' ').trim()})`)
  }
  return out
}

type FnRow = {
  proname: string
  args: string
  is_trigger: boolean
  prosecdef: boolean
  has_path: boolean
  pub: boolean
  anon: boolean
  auth: boolean
  svc: boolean
}

async function loadFunctions() {
  return await sql<FnRow[]>`
    select p.proname,
           pg_get_function_identity_arguments(p.oid) as args,
           ty.typname = 'trigger' as is_trigger,
           p.prosecdef,
           exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search\\_path=%') as has_path,
           -- PUBLIC is grantee oid 0. aclexplode also catches '=X*/owner' (grant
           -- option), which a string match on '=X/owner' would miss.
           coalesce((
             select true from aclexplode(p.proacl) a
              where a.grantee = 0 and a.privilege_type = 'EXECUTE' limit 1
           ), p.proacl is null) as pub,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
           has_function_privilege('service_role', p.oid, 'EXECUTE') as svc
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_type ty on ty.oid = p.prorettype
     where n.nspname = 'public' and p.prokind = 'f'`
}

async function preflight() {
  console.log(`\nPREFLIGHT — ${target.label}   (run this BEFORE migrate:prod)\n`)
  const fns = await loadFunctions()
  const granted = grantedSignatures()
  const nonTrigger = fns.filter((f) => !f.is_trigger)
  const triggers = fns.filter((f) => f.is_trigger)

  console.log(
    `[A] ${target.label} has ${fns.length} functions in public (${nonTrigger.length} non-trigger, ${triggers.length} trigger); migration grants ${granted.size} signatures`,
  )

  // The failure mode that matters: a function on the target that the migration
  // does not re-grant. After the blanket revoke it would be unreachable.
  const orphans = nonTrigger
    .map((f) => `${f.proname}(${f.args})`)
    .filter((s) => !granted.has(s))
  expect(
    orphans.length === 0,
    `every non-trigger function on ${target.label} is re-granted by the migration` +
      (orphans.length
        ? `\n        ORPHANS (would lose authenticated EXECUTE — DO NOT PUSH):\n          ${orphans.join('\n          ')}`
        : ''),
  )

  // The inverse: the migration grants something absent here. On prod that means a
  // `function does not exist` error, which aborts the whole migration.
  const present = new Set(fns.map((f) => `${f.proname}(${f.args})`))
  const phantom = [...granted].filter((s) => !present.has(s))
  expect(
    phantom.length === 0,
    `every signature the migration grants exists on ${target.label}` +
      (phantom.length
        ? `\n        PHANTOMS (grant would ERROR and abort the migration):\n          ${phantom.join('\n          ')}`
        : ''),
  )

  // A trigger function in the grant list would contradict the design.
  const trigGranted = triggers
    .map((f) => `${f.proname}(${f.args})`)
    .filter((s) => granted.has(s))
  expect(trigGranted.length === 0, `no trigger function appears in the grant list`)

  // Same exposure for TABLES, and it is easy to overlook because the function list
  // is the one that looks fragile: the migration blanket-revokes `authenticated` on
  // all tables and then re-grants an ENUMERATED list. A table present here but
  // absent from that list is revoked and never restored — an outage on that table.
  const migText = readFileSync(MIGRATION_PATH, 'utf8')
  const grantedTables = new Set<string>()
  for (const m of migText.matchAll(/\bpublic\.([a-z0-9_]+)/g)) {
    // Only count mentions inside a real (non-comment) grant statement.
    const lineStart = migText.lastIndexOf('\n', m.index ?? 0) + 1
    const line = migText.slice(lineStart, migText.indexOf('\n', m.index ?? 0))
    if (!line.trim().startsWith('--')) grantedTables.add(m[1])
  }
  const tbl = await sql<{ relname: string }[]>`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' order by c.relname`
  // syn_zmanim_cache is deliberately granted nothing, so it is expected to be absent.
  const EXPECTED_NO_GRANT = new Set(['syn_zmanim_cache'])
  const strandedTables = tbl
    .map((t) => t.relname)
    .filter((n) => !grantedTables.has(n) && !EXPECTED_NO_GRANT.has(n))
  expect(
    strandedTables.length === 0,
    `every table on ${target.label} is named in the migration's re-grants` +
      (strandedTables.length
        ? `\n        STRANDED (authenticated would lose all access — DO NOT PUSH):\n          ${strandedTables.join('\n          ')}`
        : ''),
  )

  // Views would be caught by `revoke ... on all tables` but are never re-granted.
  const views = await sql<{ relname: string }[]>`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('v','m') order by c.relname`
  expect(
    views.length === 0,
    `no views/matviews in public (a blanket table revoke would hit them and nothing re-grants them)` +
      (views.length ? ` — found: ${views.map((v) => v.relname).join(', ')}` : ''),
  )

  console.log(
    `\nPreflight: ${checks - failures}/${checks} passed, ${failures} failure(s) — ${target.label}`,
  )
  if (failures) {
    console.log(
      `\n!! DO NOT RUN migrate:prod. Regenerate the grant list against ${target.label} first.`,
    )
  }
  await sql.end()
  process.exit(failures ? 1 : 0)
}

async function main() {
  if (doPreflight) return preflight()

  console.log(`\nACL hardening verification — ${target.label}`)
  console.log(`migration ${MIGRATION_VERSION}${doProbe ? '  (+ live anon probe)' : ''}\n`)

  console.log('[0] migration recorded')
  const applied = await sql`
    select version from supabase_migrations.schema_migrations where version = ${MIGRATION_VERSION}`
  expect(applied.length === 1, `version ${MIGRATION_VERSION} present in schema_migrations`)

  // ---- 1. functions ------------------------------------------------------
  console.log('\n[1] function EXECUTE privileges')
  const fns = await loadFunctions()
  const sigOf = (f: FnRow) => `${f.proname}(${f.args})`

  const anonExec = fns.filter((f) => f.anon).map(sigOf).sort()
  expect(
    anonExec.length === ANON_SIGNATURES.size && anonExec.every((s) => ANON_SIGNATURES.has(s)),
    `exactly the 2 allowlisted signatures are anon-executable (found: ${anonExec.join(', ') || 'none'})`,
  )
  const pubExec = fns.filter((f) => f.pub).map(sigOf)
  expect(
    pubExec.length === 0,
    `no function grants EXECUTE to PUBLIC` + (pubExec.length ? ` — ${pubExec.join(', ')}` : ''),
  )

  const triggers = fns.filter((f) => f.is_trigger)
  const openTriggers = triggers.filter((f) => f.anon || f.auth || f.svc)
  expect(
    openTriggers.length === 0,
    `all ${triggers.length} trigger functions have no api-role EXECUTE` +
      (openTriggers.length ? ` — leaked: ${openTriggers.map(sigOf).join(', ')}` : ''),
  )

  const oracles = fns.filter((f) => ORACLE_SIGNATURES.has(sigOf(f)))
  expect(oracles.length === ORACLE_SIGNATURES.size, `both ancestry oracles present`)
  const oracleLeak = oracles.filter((f) => f.auth || f.anon)
  expect(
    oracleLeak.length === 0 && oracles.every((f) => f.svc),
    `oracles are service_role-only (authenticated must NOT hold them — preserves 20260722010000)` +
      (oracleLeak.length ? ` — leaked: ${oracleLeak.map(sigOf).join(', ')}` : ''),
  )

  const members = fns.filter(
    (f) => !f.is_trigger && !ANON_SIGNATURES.has(sigOf(f)) && !ORACLE_SIGNATURES.has(sigOf(f)),
  )
  const missing = members.filter((f) => !f.auth || !f.svc)
  expect(
    missing.length === 0,
    `all ${members.length} other non-trigger functions keep authenticated+service_role EXECUTE` +
      (missing.length ? ` — missing: ${missing.map(sigOf).join(', ')}` : ''),
  )
  // The allowlisted public functions are exempt from the rule above, so assert
  // their service_role grant separately or its loss would be invisible forever.
  const anonFns = fns.filter((f) => ANON_SIGNATURES.has(sigOf(f)))
  expect(
    anonFns.every((f) => f.auth && f.svc),
    `the 2 public functions also keep authenticated+service_role (no silent narrowing)`,
  )

  const unpinned = fns.filter((f) => f.prosecdef && !f.has_path)
  expect(unpinned.length === 0, `every security-definer function still pins search_path`)

  // ---- 2. tables ---------------------------------------------------------
  console.log('\n[2] table privileges')
  const ALL_PRIVS = [...FULL_CRUD, ...NON_DML]
  const privArray = (role: string) =>
    ALL_PRIVS.map(
      (p) => `case when has_table_privilege('${role}', c.oid, '${p}') then '${p}' end`,
    ).join(',\n             ')
  const tables = (await sql.unsafe(`
    select c.relname,
           c.relrowsecurity as rls,
           array_remove(array[
             ${privArray('anon')}
           ], null) as anon,
           array_remove(array[
             ${privArray('authenticated')}
           ], null) as auth,
           array_remove(array[
             ${privArray('service_role')}
           ], null) as svc
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
     order by c.relname`)) as unknown as {
    relname: string
    rls: boolean
    anon: string[]
    auth: string[]
    svc: string[]
  }[]

  const anonHolds = tables.filter((t) => t.anon.length > 0)
  expect(
    anonHolds.length === 0,
    `anon holds NO privilege on any of the ${tables.length} public tables` +
      (anonHolds.length
        ? ` — leaked: ${anonHolds.map((t) => `${t.relname}(${t.anon.join('/')})`).join(', ')}`
        : ''),
  )

  const authExtras = tables.filter((t) => t.auth.some((p) => NON_DML.includes(p)))
  expect(
    authExtras.length === 0,
    `authenticated holds no ${NON_DML.join('/')} anywhere (RLS cannot gate the first of those)` +
      (authExtras.length
        ? ` — leaked: ${authExtras.map((t) => `${t.relname}(${t.auth.filter((p) => NON_DML.includes(p)).join('/')})`).join(', ')}`
        : ''),
  )

  const wrongDml: string[] = []
  for (const t of tables) {
    const want = (TABLE_EXCEPTIONS[t.relname] ?? FULL_CRUD).slice().sort()
    const got = t.auth.filter((p) => FULL_CRUD.includes(p)).sort()
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      wrongDml.push(`${t.relname}: want [${want.join(',')}] got [${got.join(',')}]`)
    }
  }
  expect(
    wrongDml.length === 0,
    `authenticated DML matches migration intent on all ${tables.length} tables` +
      (wrongDml.length ? ` — ${wrongDml.join('; ')}` : ''),
  )

  // service_role is deliberately left untouched by this migration — assert it did
  // not shrink, so a future sweep that breaks the worker cannot pass this gate.
  // NOTE the expectation is "at least its intended DML", not an exact match: on prod
  // the default privileges grant service_role more than the migrations state, and
  // that surplus is pre-existing and out of scope here. Only a LOSS is a defect.
  // mm_interests grants SELECT/INSERT/DELETE to BOTH roles — no UPDATE by design
  // (20260712040000:29), so full CRUD is the wrong bar for it.
  const SVC_EXCEPTIONS: Record<string, string[]> = { mm_interests: ['SELECT', 'INSERT', 'DELETE'] }
  const svcLost = tables.filter((t) => {
    const want = SVC_EXCEPTIONS[t.relname] ?? FULL_CRUD
    return !want.every((p) => t.svc.includes(p))
  })
  expect(
    svcLost.length === 0,
    `service_role retains at least its intended DML on all ${tables.length} tables (the worker depends on it)` +
      (svcLost.length
        ? ` — missing on: ${svcLost.map((t) => `${t.relname}[${t.svc.join('/')}]`).join(', ')}`
        : ''),
  )

  const rlsOff = tables.filter((t) => !t.rls)
  expect(rlsOff.length === 0, `RLS still enabled on all ${tables.length} tables`)

  // ---- 3. column grants survived ----------------------------------------
  console.log('\n[3] column-level grants (a table-level revoke wipes these)')
  for (const col of PROFILE_UPDATE_COLUMNS) {
    const [r] = await sql<{ x: boolean }[]>`
      select has_column_privilege('authenticated','public.profiles',${col},'UPDATE') as x`
    expect(r.x, `authenticated can UPDATE profiles.${col}`)
  }
  const [tableUpd] = await sql<{ x: boolean }[]>`
    select has_table_privilege('authenticated','public.profiles','UPDATE') as x`
  expect(!tableUpd.x, `authenticated has NO table-wide UPDATE on profiles (column-scoped only)`)

  // ---- 4. live anon probe (optional) -------------------------------------
  if (doProbe) {
    console.log('\n[4] live probe as anon — every statement inside a rolled-back transaction')
    const PROBE_TABLES = [
      'profiles', 'orgs', 'org_members', 'module_roles', 'cls_classes',
      'sal_appointments', 'sd_events', 'vm_conversations', 'syn_published_weeks', 'job_requests',
    ]
    await sql
      .begin(async (tx) => {
        await tx.unsafe(`set local role anon`)
        const who = await tx.unsafe(`select current_user as u`)
        console.log(`  acting as: ${(who[0] as any).u}`)

        const attempt = async (label: string, stmt: string, wantFail: boolean) => {
          await tx.unsafe(`savepoint sp`)
          try {
            await tx.unsafe(stmt)
            await tx.unsafe(`release savepoint sp`)
            if (wantFail) bad(`${label} — SUCCEEDED but should have been refused`)
            else ok(`${label} — allowed, as intended`)
          } catch (e: any) {
            await tx.unsafe(`rollback to savepoint sp`)
            const msg = String(e.message ?? '')
            const denied =
              e.code === '42501' &&
              /permission denied for (table|relation|function|view)/i.test(msg) &&
              !/row-level security/i.test(msg)
            if (wantFail) expect(denied, `${label} — refused (${e.code}: ${msg.slice(0, 58)})`)
            else bad(`${label} — should have worked but failed: ${msg}`)
          }
        }

        for (const t of PROBE_TABLES) {
          await attempt(`select on ${t}`, `select 1 from public.${t} limit 1`, true)
          await attempt(`delete on ${t}`, `delete from public.${t} where false`, true)
        }
        await attempt(`rpc syn_public_weeks`, `select public.syn_public_weeks('demo-shul')`, false)
        await attempt(
          `rpc is_org_member`,
          `select public.is_org_member('00000000-0000-4000-8000-00000000beef')`,
          true,
        )
        throw new Error('__rollback__')
      })
      .catch((e) => {
        if (e.message !== '__rollback__') throw e
      })
    console.log('  (transaction rolled back — nothing was committed)')
  }

  console.log(
    `\nResult: ${checks - failures}/${checks} checks passed, ${failures} failure(s) — ${target.label}`,
  )
  await sql.end()
  process.exit(failures ? 1 : 0)
}

main().catch(async (e) => {
  console.error('\nVerification errored:', e?.message ?? e)
  await sql.end({ timeout: 1 }).catch(() => {})
  process.exit(1)
})
