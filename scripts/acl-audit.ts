// Audit the REAL privilege state of a database — read-only, no DDL, no writes.
//
//   pnpm exec tsx scripts/acl-audit.ts              # prod (default)
//   VERIFY_DB_URL=postgresql://... pnpm exec tsx scripts/acl-audit.ts   # local
//   pnpm exec tsx scripts/acl-audit.ts --json > before.json             # machine-readable
//
// Why this exists: `scripts/prod-verify-migration.ts` verifies functions that a
// migration DEFINES (it parses `create [or replace] function` blocks). An
// ACL-ONLY migration — one that just revokes/grants — defines no functions, so
// that script can only confirm the version row landed. This script is the
// companion: it reports the privilege state itself, so an ACL sweep can be
// diffed before/after on the SAME database, and local-vs-prod divergence
// (CLAUDE.md gotcha / docs/03 convention #1) can be seen directly.
//
// What it reports:
//   [functions] every public function: secdef, pinned search_path, raw proacl,
//               and resolved EXECUTE for PUBLIC / anon / authenticated / service_role
//   [tables]    every public table: RLS enabled + forced, policy count, and
//               resolved SELECT/INSERT/UPDATE/DELETE per API role, plus
//               TRUNCATE/REFERENCES/TRIGGER — which RLS does NOT gate, so a
//               table-level grant of those is a real bypass, not just depth
//   [views]     every public view: owner, security_invoker, per-role privileges
//   [sequences] every public sequence: USAGE/SELECT/UPDATE per API role
//   [summary]   the counts that matter for the hardening sweep
//
// Read-only: SELECTs against pg_catalog / information_schema only.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const asJson = process.argv.includes('--json')

function prodUrl() {
  const env = readFileSync(resolve(root, '.env.deploy'), 'utf8')
  const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''
  const ref = get('SUPABASE_PROJECT_REF')
  const dbPassword = get('SUPABASE_DB_PASSWORD')
  if (!ref || !dbPassword) {
    console.error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD in .env.deploy')
    process.exit(1)
  }
  return {
    label: `PROD (${ref})`,
    url: `postgresql://postgres.${ref}:${encodeURIComponent(dbPassword)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`,
  }
}

const target = process.env.VERIFY_DB_URL
  ? { label: 'LOCAL (VERIFY_DB_URL)', url: process.env.VERIFY_DB_URL }
  : prodUrl()

const sql = postgres(target.url, {
  ssl: target.url.includes('supabase.com') ? 'require' : false,
  prepare: false,
  max: 1,
  idle_timeout: 5,
})

const ROLES = ['anon', 'authenticated', 'service_role'] as const
const yn = (b: boolean) => (b ? 'y' : '-')

type FnRow = {
  proname: string
  args: string
  prosecdef: boolean
  search_path: string | null
  acl: string
  public_exec: boolean
  anon_exec: boolean
  authenticated_exec: boolean
  service_role_exec: boolean
}
type TableRow = {
  relname: string
  rls: boolean
  rls_forced: boolean
  policies: number
  anon_select: boolean
  anon_insert: boolean
  anon_update: boolean
  anon_delete: boolean
  anon_truncate: boolean
  anon_references: boolean
  anon_trigger: boolean
  authenticated_truncate: boolean
  authenticated_select: boolean
  authenticated_insert: boolean
  authenticated_update: boolean
  authenticated_delete: boolean
  service_role_select: boolean
  service_role_insert: boolean
  service_role_update: boolean
  service_role_delete: boolean
}
type ViewRow = {
  relname: string
  owner: string
  security_invoker: boolean
  anon_select: boolean
  authenticated_select: boolean
  service_role_select: boolean
}
type SeqRow = {
  relname: string
  anon_usage: boolean
  anon_select: boolean
  anon_update: boolean
  authenticated_usage: boolean
  authenticated_select: boolean
  authenticated_update: boolean
  service_role_usage: boolean
  service_role_select: boolean
  service_role_update: boolean
}

async function main() {
  const [{ now, ver }] = await sql<{ now: string; ver: string }[]>`
    select now()::text as now, version() as ver
  `

  const functions = await sql<FnRow[]>`
    select p.proname,
           pg_get_function_identity_arguments(p.oid) as args,
           p.prosecdef,
           (select c from unnest(coalesce(p.proconfig, '{}')) c where c like 'search\\_path=%') as search_path,
           coalesce(array_to_string(p.proacl, ' | '), '<null = default: EXECUTE to PUBLIC>') as acl,
           (p.proacl is null or ('=X/' || pg_get_userbyid(p.proowner)) = any(p.proacl::text[])) as public_exec,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_exec,
           has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_exec
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
     order by p.proname, pg_get_function_identity_arguments(p.oid)
  `

  const tables = await sql<TableRow[]>`
    select c.relname,
           c.relrowsecurity as rls,
           c.relforcerowsecurity as rls_forced,
           (select count(*)::int from pg_policy pol where pol.polrelid = c.oid) as policies,
           has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
           has_table_privilege('anon', c.oid, 'INSERT') as anon_insert,
           has_table_privilege('anon', c.oid, 'UPDATE') as anon_update,
           has_table_privilege('anon', c.oid, 'DELETE') as anon_delete,
           has_table_privilege('anon', c.oid, 'TRUNCATE') as anon_truncate,
           has_table_privilege('anon', c.oid, 'REFERENCES') as anon_references,
           has_table_privilege('anon', c.oid, 'TRIGGER') as anon_trigger,
           has_table_privilege('authenticated', c.oid, 'TRUNCATE') as authenticated_truncate,
           has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_select,
           has_table_privilege('authenticated', c.oid, 'INSERT') as authenticated_insert,
           has_table_privilege('authenticated', c.oid, 'UPDATE') as authenticated_update,
           has_table_privilege('authenticated', c.oid, 'DELETE') as authenticated_delete,
           has_table_privilege('service_role', c.oid, 'SELECT') as service_role_select,
           has_table_privilege('service_role', c.oid, 'INSERT') as service_role_insert,
           has_table_privilege('service_role', c.oid, 'UPDATE') as service_role_update,
           has_table_privilege('service_role', c.oid, 'DELETE') as service_role_delete
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
     order by c.relname
  `

  const views = await sql<ViewRow[]>`
    select c.relname,
           pg_get_userbyid(c.relowner) as owner,
           coalesce((select true from unnest(c.reloptions) o where o = 'security_invoker=true'), false) as security_invoker,
           has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
           has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_select,
           has_table_privilege('service_role', c.oid, 'SELECT') as service_role_select
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'v'
     order by c.relname
  `

  const sequences = await sql<SeqRow[]>`
    select c.relname,
           has_sequence_privilege('anon', c.oid, 'USAGE') as anon_usage,
           has_sequence_privilege('anon', c.oid, 'SELECT') as anon_select,
           has_sequence_privilege('anon', c.oid, 'UPDATE') as anon_update,
           has_sequence_privilege('authenticated', c.oid, 'USAGE') as authenticated_usage,
           has_sequence_privilege('authenticated', c.oid, 'SELECT') as authenticated_select,
           has_sequence_privilege('authenticated', c.oid, 'UPDATE') as authenticated_update,
           has_sequence_privilege('service_role', c.oid, 'USAGE') as service_role_usage,
           has_sequence_privilege('service_role', c.oid, 'SELECT') as service_role_select,
           has_sequence_privilege('service_role', c.oid, 'UPDATE') as service_role_update
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'S'
     order by c.relname
  `

  // Default privileges are the root cause of the local/prod divergence — show them.
  const defaults = await sql<{ role: string; schema: string | null; objtype: string; acl: string }[]>`
    select pg_get_userbyid(d.defaclrole) as role,
           n.nspname as schema,
           case d.defaclobjtype when 'r' then 'table' when 'f' then 'function'
                                when 'S' then 'sequence' when 'T' then 'type'
                                else d.defaclobjtype::text end as objtype,
           array_to_string(d.defaclacl, ' | ') as acl
      from pg_default_acl d
      left join pg_namespace n on n.oid = d.defaclnamespace
     order by role, schema, objtype
  `

  if (asJson) {
    console.log(
      JSON.stringify(
        { target: target.label, at: now, functions, tables, views, sequences, defaults },
        null,
        2,
      ),
    )
    await sql.end()
    return
  }

  console.log(`\nACL AUDIT — ${target.label}`)
  console.log(`at ${now}`)
  console.log(`${ver.split(' ').slice(0, 2).join(' ')}\n`)

  console.log(`[default privileges]  (the source of the local/prod EXECUTE divergence)`)
  if (!defaults.length) console.log('  (none configured)')
  for (const d of defaults) {
    console.log(`  ${d.role} / ${d.schema ?? '(all)'} / ${d.objtype}: ${d.acl}`)
  }

  console.log(`\n[functions] ${functions.length} in schema public`)
  console.log(
    `  ${'name(args)'.padEnd(64)} ${'secdef'.padEnd(7)} ${'srchpath'.padEnd(9)} PUB anon auth svc`,
  )
  for (const f of functions) {
    const label = `${f.proname}(${f.args})`
    console.log(
      `  ${label.padEnd(64)} ${yn(f.prosecdef).padEnd(7)} ${yn(!!f.search_path).padEnd(9)} ` +
        `${yn(f.public_exec).padEnd(3)} ${yn(f.anon_exec).padEnd(4)} ${yn(f.authenticated_exec).padEnd(4)} ${yn(f.service_role_exec)}`,
    )
  }

  console.log(`\n[tables] ${tables.length} in schema public   (privs shown as S/I/U/D)`)
  console.log(
    `  ${'name'.padEnd(40)} ${'RLS'.padEnd(4)} ${'pol'.padEnd(4)} ${'anon'.padEnd(9)} ${'authenticated'.padEnd(14)} service_role`,
  )
  for (const t of tables) {
    const trip = (r: (typeof ROLES)[number]) =>
      `${yn(t[`${r}_select`])}${yn(t[`${r}_insert`])}${yn(t[`${r}_update`])}${yn(t[`${r}_delete`])}`
    const rlsFlag = t.rls ? (t.rls_forced ? 'ON!' : 'on') : 'OFF'
    console.log(
      `  ${t.relname.padEnd(40)} ${rlsFlag.padEnd(4)} ${String(t.policies).padEnd(4)} ` +
        `${trip('anon').padEnd(9)} ${trip('authenticated').padEnd(14)} ${trip('service_role')}`,
    )
  }

  console.log(`\n[views] ${views.length} in schema public`)
  for (const v of views) {
    console.log(
      `  ${v.relname.padEnd(40)} owner=${v.owner.padEnd(12)} security_invoker=${yn(v.security_invoker)} ` +
        `select: anon=${yn(v.anon_select)} auth=${yn(v.authenticated_select)} svc=${yn(v.service_role_select)}`,
    )
  }

  console.log(`\n[sequences] ${sequences.length} in schema public   (privs shown as U/S/U)`)
  for (const s of sequences) {
    const trip = (r: (typeof ROLES)[number]) =>
      `${yn(s[`${r}_usage`])}${yn(s[`${r}_select`])}${yn(s[`${r}_update`])}`
    console.log(
      `  ${s.relname.padEnd(40)} anon=${trip('anon')} auth=${trip('authenticated')} svc=${trip('service_role')}`,
    )
  }

  // --- the numbers this sweep is about
  const fnAnon = functions.filter((f) => f.anon_exec)
  const fnPublic = functions.filter((f) => f.public_exec)
  const fnSecdefNoPath = functions.filter((f) => f.prosecdef && !f.search_path)
  const tblAnonWrite = tables.filter((t) => t.anon_insert || t.anon_update || t.anon_delete)
  const tblAnonTruncate = tables.filter((t) => t.anon_truncate)
  const tblAnonDdl = tables.filter((t) => t.anon_references || t.anon_trigger)
  const tblAuthTruncate = tables.filter((t) => t.authenticated_truncate)
  const tblNoRls = tables.filter((t) => !t.rls)
  const tblRlsNoPolicy = tables.filter((t) => t.rls && t.policies === 0)
  const seqAnon = sequences.filter((s) => s.anon_usage || s.anon_update)

  console.log(`\n[summary] ${target.label}`)
  console.log(`  functions total ................................ ${functions.length}`)
  console.log(`  functions anon-EXECUTABLE ...................... ${fnAnon.length}`)
  console.log(`  functions EXECUTE granted to PUBLIC ............ ${fnPublic.length}`)
  console.log(`  security-definer fns WITHOUT pinned search_path  ${fnSecdefNoPath.length}`)
  console.log(`  tables total ................................... ${tables.length}`)
  console.log(`  tables with anon INSERT/UPDATE/DELETE .......... ${tblAnonWrite.length}`)
  console.log(`  tables with anon TRUNCATE (RLS canNOT stop it) .. ${tblAnonTruncate.length}`)
  console.log(`  tables with anon REFERENCES/TRIGGER ............. ${tblAnonDdl.length}`)
  console.log(`  tables with authenticated TRUNCATE ............. ${tblAuthTruncate.length}`)
  console.log(`  tables with RLS OFF (danger) ................... ${tblNoRls.length}`)
  console.log(`  tables RLS-on but ZERO policies ................ ${tblRlsNoPolicy.length}`)
  console.log(`  sequences with anon USAGE/UPDATE ............... ${seqAnon.length}`)
  if (tblNoRls.length) console.log(`\n  RLS OFF: ${tblNoRls.map((t) => t.relname).join(', ')}`)
  if (tblRlsNoPolicy.length)
    console.log(`  RLS on, no policies: ${tblRlsNoPolicy.map((t) => t.relname).join(', ')}`)
  if (fnAnon.length)
    console.log(`\n  anon-executable fns:\n    ${fnAnon.map((f) => `${f.proname}(${f.args})`).join('\n    ')}`)

  await sql.end()
}

main().catch(async (e) => {
  console.error('\nAudit errored:', e?.message ?? e)
  await sql.end({ timeout: 1 }).catch(() => {})
  process.exit(1)
})
