// SECURITY EVIDENCE DUMP — read-only catalog snapshot of PROD for the security
// review planned in docs/30-security-review.md (2026-11-13).
//
//   pnpm exec tsx scripts/security-evidence-dump.mts <out-dir>
//
// Connects like every prod-verify script (session pooler + SUPABASE_DB_PASSWORD
// from .env.deploy). ISSUES ONLY SELECTS against pg_catalog / information_schema
// and writes one JSON file per topic into <out-dir>. No row data is read from any
// application table — counts only. Function bodies ARE included (they are
// already public in supabase/migrations/); keep the out-dir OUTSIDE the repo
// anyway, because the snapshot names roles and settings nobody needs to publish.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const env = readFileSync(resolve(root, '.env.deploy'), 'utf8')
const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''

const out = process.argv[2]
if (!out) throw new Error('usage: security-evidence-dump.mts <out-dir>')
mkdirSync(out, { recursive: true })

const ref = get('SUPABASE_PROJECT_REF')
const pw = get('SUPABASE_DB_PASSWORD')
if (!ref || !pw) throw new Error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD in .env.deploy')

const sql = postgres(
  `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`,
  { ssl: 'require', max: 1 },
)

const save = (name: string, rows: unknown) => {
  writeFileSync(resolve(out, `${name}.json`), JSON.stringify(rows, null, 1))
  console.log(`  wrote ${name}.json (${Array.isArray(rows) ? rows.length : 1})`)
}

try {
  console.log(`\nSecurity evidence dump — project ${ref} → ${out}\n`)
  save('meta', { project: ref, taken_at: new Date().toISOString(), read_only: true })

  save('roles', await sql`
    select rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolbypassrls, rolconfig
    from pg_roles where rolname not like 'pg_%' order by rolname`)

  save('role_memberships', await sql`
    select r.rolname as member, g.rolname as member_of, m.admin_option
    from pg_auth_members m join pg_roles r on r.oid = m.member join pg_roles g on g.oid = m.roleid
    order by 1, 2`)

  save('db_role_settings', await sql`
    select coalesce(r.rolname, '<all>') as role, d.datname, s.setconfig
    from pg_db_role_setting s left join pg_roles r on r.oid = s.setrole left join pg_database d on d.oid = s.setdatabase`)

  save('default_acl', await sql`
    select r.rolname as owner, n.nspname as schema, d.defaclobjtype as objtype, d.defaclacl::text[] as acl
    from pg_default_acl d join pg_roles r on r.oid = d.defaclrole left join pg_namespace n on n.oid = d.defaclnamespace`)

  save('tables', await sql`
    select n.nspname as schema, c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as rls_forced,
           pg_get_userbyid(c.relowner) as owner, c.relacl::text[] as acl
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r','p') and n.nspname in ('public','storage','auth','cron','vault','extensions')
    order by 1, 2`)

  save('table_grants_api_roles', await sql`
    select table_schema, table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privs
    from information_schema.role_table_grants
    where grantee in ('anon','authenticated','service_role','authenticator','public')
    group by 1,2,3 order by 1,2,3`)

  save('column_grants_api_roles', await sql`
    select table_schema, table_name, column_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privs
    from information_schema.column_privileges
    where grantee in ('anon','authenticated','service_role')
      and table_schema in ('public','storage','auth')
    group by 1,2,3,4 order by 1,2,3,4`)

  save('policies', await sql`
    select n.nspname as schema, c.relname as table, p.polname, p.polpermissive as permissive, p.polcmd as cmd,
           (select array_agg(rolname) from pg_roles where oid = any(p.polroles)) as roles,
           pg_get_expr(p.polqual, p.polrelid) as using_expr,
           pg_get_expr(p.polwithcheck, p.polrelid) as check_expr
    from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
    order by 1, 2, 3`)

  save('functions', await sql`
    select n.nspname as schema, p.proname, pg_get_function_identity_arguments(p.oid) as args,
           pg_get_userbyid(p.proowner) as owner, p.prosecdef as secdef, p.proconfig, p.provolatile,
           p.proacl::text[] as acl, l.lanname as lang, md5(p.prosrc) as body_md5, p.prosrc as body,
           has_function_privilege('anon', p.oid, 'execute') as anon_exec,
           has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec,
           has_function_privilege('service_role', p.oid, 'execute') as service_role_exec
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
    where n.nspname in ('public','storage','auth','extensions')
    order by 1, 2, 3`)

  save('triggers', await sql`
    select n.nspname as schema, c.relname as table, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) as def
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where not t.tgisinternal order by 1, 2, 3`)

  save('views', await sql`
    select schemaname, viewname, viewowner, definition from pg_views
    where schemaname not in ('pg_catalog','information_schema') order by 1, 2`)

  save('publications', await sql`select * from pg_publication_tables order by 1, 2, 3`)

  save('extensions', await sql`select extname, extversion, n.nspname as schema from pg_extension e join pg_namespace n on n.oid = e.extnamespace order by 1`)

  save('storage_buckets', await sql`
    select id, name, public, file_size_limit, allowed_mime_types, created_at from storage.buckets order by name`)

  save('cron_jobs', await sql`
    select jobid, jobname, schedule, command, nodename, username, active from cron.job order by jobid`
    .catch((e: Error) => [{ error: e.message }]))

  save('row_counts_public', await sql`
    select c.relname, c.reltuples::bigint as approx_rows
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' order by 1`)

  save('auth_counts', await sql`
    select (select count(*) from auth.users) as users,
           (select count(*) from auth.users where email_confirmed_at is null) as unconfirmed,
           (select count(*) from auth.users where last_sign_in_at > now() - interval '30 days') as active_30d,
           (select count(*) from auth.identities) as identities,
           (select count(*) from auth.sessions) as sessions,
           (select count(*) from auth.mfa_factors) as mfa_factors,
           (select count(distinct provider) from auth.identities) as providers`)

  save('auth_hooks_and_settings', await sql`
    select name, setting from pg_settings
    where name like 'pgrst.%' or name in ('ssl','password_encryption','log_statement','statement_timeout','lock_timeout','idle_in_transaction_session_timeout')
    order by 1`)

  save('settings_tables', await sql`
    select c.relname, (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false order by 1`)

  console.log('\nDone. Read-only; nothing was changed.\n')
} finally {
  await sql.end()
}
