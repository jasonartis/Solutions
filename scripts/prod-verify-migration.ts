// Verify a migration actually landed on PRODUCTION as intended — read-only.
//
//   pnpm exec tsx scripts/prod-verify-migration.ts supabase/migrations/<file>.sql
//
// Why this exists (CLAUDE.md gotcha + docs/03 convention #1): function EXECUTE
// grants DIVERGE local vs prod. On prod, `ALTER DEFAULT PRIVILEGES FOR ROLE
// postgres` grants EXECUTE directly to anon/authenticated at CREATE time, and a
// bare `revoke ... from public` does NOT remove those. So a definer function can
// look locked down locally and be wide open on prod, and the local RLS suite
// cannot catch it. After every migration that adds or replaces a security
// definer function, the ACLs must be read off PROD's pg_proc.
//
// What it checks, per function the migration defines:
//   1. the deployed body (pg_proc.prosrc) is byte-identical to the body in the
//      migration file — i.e. prod runs the reviewed definition, not an older one
//   2. security definer is set (create or replace does NOT inherit attributes)
//   3. a pinned search_path is present in proconfig
//   4. the real ACL: who can EXECUTE, resolved through PUBLIC and role grants
//      (anon executable is flagged — nothing here is meant for anon)
// Plus: the migration's version is recorded in supabase_migrations.
//
// Read-only: it runs SELECTs against pg_catalog only. Credentials from .env.deploy.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const migrationArg = process.argv[2]
if (!migrationArg) {
  console.error('Usage: pnpm exec tsx scripts/prod-verify-migration.ts <path-to-migration.sql>')
  process.exit(1)
}
const migrationPath = resolve(root, migrationArg)
const sqlText = readFileSync(migrationPath, 'utf8')
const version = /(\d{14})/.exec(migrationPath.replace(/\\/g, '/').split('/').pop() ?? '')?.[1] ?? ''

const env = readFileSync(resolve(root, '.env.deploy'), 'utf8')
const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''
const ref = get('SUPABASE_PROJECT_REF')
const dbPassword = get('SUPABASE_DB_PASSWORD')
if (!ref || !dbPassword) {
  console.error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD in .env.deploy')
  process.exit(1)
}
// VERIFY_DB_URL overrides the target — used to dry-run this script against the
// local stack before pointing it at prod. Unset = prod (the point of the script).
const dbUrl =
  process.env.VERIFY_DB_URL ||
  `postgresql://postgres.${ref}:${encodeURIComponent(dbPassword)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`

// --- parse the migration: every `create [or replace] function public.<name>` and
// its dollar-quoted body, in file order. `isNew` distinguishes a plain `create`
// (a brand-new function, whose ACL this migration is responsible for stating)
// from `create or replace` (which preserves the pre-existing ACL).
type Defined = { name: string; args: string; body: string; isNew: boolean }
const defined: Defined[] = []
const header = /create\s+(or\s+replace\s+)?function\s+public\.(\w+)\s*\(/gi
let m: RegExpExecArray | null
while ((m = header.exec(sqlText))) {
  const isNew = !m[1]
  const name = m[2]
  // arg list: from the open paren to its matching close paren
  let depth = 1
  let i = header.lastIndex
  for (; i < sqlText.length && depth > 0; i++) {
    if (sqlText[i] === '(') depth++
    else if (sqlText[i] === ')') depth--
  }
  const args = sqlText.slice(header.lastIndex, i - 1).replace(/\s+/g, ' ').trim()
  // body: the first dollar-quoted string after the header
  const tag = /as\s+(\$[a-zA-Z_]*\$)/i.exec(sqlText.slice(i))
  if (!tag) continue
  const bodyStart = i + tag.index + tag[0].length
  const bodyEnd = sqlText.indexOf(tag[1], bodyStart)
  if (bodyEnd < 0) continue
  defined.push({ name, args, body: sqlText.slice(bodyStart, bodyEnd), isNew })
}

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex')
const names = [...new Set(defined.map((d) => d.name))]

let failures = 0
let warnings = 0
const fail = (msg: string) => {
  failures++
  console.log(`  FAIL  ${msg}`)
}
const warn = (msg: string) => {
  warnings++
  console.log(`  WARN  ${msg}`)
}
const pass = (msg: string) => console.log(`  ok    ${msg}`)

const sql = postgres(dbUrl, {
  ssl: dbUrl.includes('supabase.com') ? 'require' : false,
  prepare: false,
  max: 1,
  idle_timeout: 5,
})

async function main() {
  console.log(`\nProd verification — ${migrationPath.split(/[\\/]/).pop()}  (project ${ref})`)
  console.log(`Functions defined in this migration: ${defined.length} (${names.length} distinct names)\n`)

  // 1. migration recorded?
  console.log('[1] migration recorded in supabase_migrations.schema_migrations')
  const applied = await sql`
    select version, name from supabase_migrations.schema_migrations where version = ${version}
  `
  if (applied.length) pass(`version ${version} present`)
  else fail(`version ${version} NOT present on prod — migration has not been applied`)

  // 2. per-function: body / definer / search_path / ACL
  console.log('\n[2] deployed functions (body match, security definer, search_path, EXECUTE acl)')
  const rows = await sql<
    {
      oid: number
      proname: string
      args: string
      prosecdef: boolean
      proconfig: string[] | null
      srcmd5: string
      acl: string
      anon_exec: boolean
      auth_exec: boolean
      svc_exec: boolean
      public_exec: boolean
    }[]
  >`
    select p.oid::int as oid,
           p.proname,
           pg_get_function_identity_arguments(p.oid) as args,
           p.prosecdef,
           p.proconfig,
           md5(p.prosrc) as srcmd5,
           coalesce(array_to_string(p.proacl, ' | '), '<null = default: EXECUTE to PUBLIC>') as acl,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
           has_function_privilege('service_role', p.oid, 'EXECUTE') as svc_exec,
           (p.proacl is null or ('=X/' || pg_get_userbyid(p.proowner)) = any(p.proacl::text[])) as public_exec
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any(${names})
     order by p.proname, p.oid
  `

  const mismatched: { name: string; oid: number }[] = []
  for (const d of defined) {
    const label = `${d.name}(${d.args || ''})`
    const candidates = rows.filter((r) => r.proname === d.name)
    if (!candidates.length) {
      fail(`${label} — NOT FOUND on prod`)
      continue
    }
    const want = md5(d.body)
    const hit = candidates.find((r) => r.srcmd5 === want)
    const r = hit ?? (candidates.length === 1 ? candidates[0] : undefined)
    if (!r) {
      fail(`${label} — no overload on prod matches the migration body (${candidates.length} overloads)`)
      continue
    }
    const bits: string[] = []
    if (hit) bits.push('body=match')
    else {
      bits.push('body=MISMATCH')
      mismatched.push({ name: d.name, oid: r.oid })
    }
    bits.push(r.prosecdef ? 'definer' : 'INVOKER')
    const sp = (r.proconfig ?? []).find((c) => c.startsWith('search_path='))
    bits.push(sp ? sp : 'NO-search_path')
    bits.push(
      `exec: anon=${r.anon_exec ? 'YES' : 'no'} authenticated=${r.auth_exec ? 'yes' : 'NO'} service_role=${r.svc_exec ? 'yes' : 'no'}`,
    )

    const line = `${label.padEnd(58)} ${bits.join('  ')}`
    const bad = !hit || !r.prosecdef || !sp || r.anon_exec || !r.auth_exec
    if (bad) {
      // anon-executable / missing definer / body mismatch are hard failures for a
      // function this migration created; for a replaced function an anon grant is
      // pre-existing (create or replace preserves ACL) so it is reported as a warning.
      if (!hit || !r.prosecdef || !sp) fail(line)
      else if (r.anon_exec && d.isNew) fail(line)
      else warn(line)
    } else {
      pass(line)
    }
    if (r.public_exec) {
      if (d.isNew) fail(`${label} — EXECUTE granted to PUBLIC on prod (must be revoked)`)
      else warn(`${label} — EXECUTE granted to PUBLIC on prod (pre-existing; not set by this migration)`)
    }
    console.log(`        acl: ${r.acl}`)
  }

  // 3. show the real diff for any body mismatch, so it is not just a hash claim
  if (mismatched.length) {
    console.log('\n[3] body mismatches — prod definition follows (compare against the migration)')
    for (const mm of mismatched) {
      const [row] = await sql<{ prosrc: string }[]>`select prosrc from pg_proc where oid = ${mm.oid}`
      console.log(`\n--- prod ${mm.name} ---\n${row.prosrc}\n--- end ---`)
    }
  }

  console.log(`\nResult: ${failures} failure(s), ${warnings} warning(s).`)
  await sql.end()
  process.exit(failures ? 1 : 0)
}

main().catch(async (e) => {
  console.error('\nVerification errored:', e?.message ?? e)
  await sql.end({ timeout: 1 }).catch(() => {})
  process.exit(1)
})
