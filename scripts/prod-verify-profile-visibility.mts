/**
 * PROD VERIFICATION for the email slice (docs/22 §11.7).
 *
 *   pnpm exec tsx scripts/prod-verify-profile-visibility.mts          # production
 *   pnpm exec tsx scripts/prod-verify-profile-visibility.mts --local  # local stack
 *
 * READ-ONLY. Copied from `scripts/prod-verify-superadmin-log.mts`, the
 * table/policy/grant template — `prod-verify-migration.ts` checks FUNCTIONS
 * ONLY, and this slice is half table, half policy, half grant, so that script's
 * "0 failures" would be substantially vacuous here.
 *
 * EVERY NEGATIVE CARRIES A CONTROL. A missing table, a broken catalog read or a
 * typo'd role name would otherwise make this whole file pass by asserting
 * nothing — which is the failure mode docs/03's vacuity rule exists for.
 *
 * TWO CHECKS EXIST BECAUSE ADVERSARIAL REVIEW A ADMITTED IT NEVER RAN THEM ON
 * PROD (docs/22 §13.3): the `supabase_realtime` PUBLICATION and the VIEW list
 * were measured on LOCAL only. Realtime is configured per PROJECT, so prod can
 * genuinely differ — exactly the local-cannot-catch-prod-drift class CLAUDE.md
 * records. Both are asserted here against whichever database is named.
 */
import { readFileSync } from 'node:fs'
import postgres from 'postgres'

const LOCAL = process.argv.includes('--local')

function env(name: string): string {
  for (const file of ['.env.deploy', '.env.accounts']) {
    try {
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^([A-Z_]+)=(.*)$/)
        if (m && m[1] === name && m[2]) return m[2].replace(/^["']|["']$/g, '')
      }
    } catch {
      /* file may not exist */
    }
  }
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set (looked in .env.deploy, .env.accounts and the environment)`)
  return v
}

const sql = LOCAL
  ? postgres(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres', { max: 1 })
  : postgres(
      `postgresql://postgres.${env('SUPABASE_PROJECT_REF')}:${encodeURIComponent(
        env('SUPABASE_DB_PASSWORD'),
      )}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`,
      { max: 1, ssl: 'require' },
    )

let pass = 0
let fail = 0
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) {
    pass++
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
const section = (s: string) => console.log(`\n${s}`)

/** Functions that may read an address. Must match packages/db/src/profiles-public-columns.test.ts. */
const EMAIL_READERS = [
  'find_module_peer',
  'mm_mutual_matches',
  'org_find_user_by_email',
  'org_member_profiles',
  'sd_match_contacts',
  'superadmin_user_emails',
]
/** Matches the pattern inside a COMMENT only — it reads no such table. */
const COMMENT_MATCHES_ONLY = ['vm_guard_last_conversation_admin']

async function main() {
  console.log(`Email slice verification — ${LOCAL ? 'LOCAL' : 'PRODUCTION'}`)

  const who = await sql`select current_user as u, current_database() as db`
  console.log(`connected as ${who[0]!.u} to ${who[0]!.db}`)

  // -------------------------------------------------------------------------
  section('1. THE COLUMN IS GONE, and what remains is the public identity row')
  // -------------------------------------------------------------------------
  const cols = (
    await sql`select attname from pg_attribute
              where attrelid = 'public.profiles'::regclass and attnum > 0 and not attisdropped
              order by attname`
  ).map((r) => r.attname as string)
  check('profiles.email does not exist', !cols.includes('email'), `columns: ${cols.join(', ')}`)
  check('profiles.settings does not exist', !cols.includes('settings'))
  check('profiles.is_superadmin does not exist', !cols.includes('is_superadmin'))
  check(
    'CONTROL: profiles still has its public columns, so the three absences are real',
    ['user_id', 'display_name', 'created_at', 'updated_at'].every((c) => cols.includes(c)),
    'a dropped/renamed table would make every check above pass by accident',
  )
  check(
    'profiles carries the PUBLIC-BY-DEFINITION comment',
    /PUBLIC IDENTITY ROW/.test(
      ((await sql`select obj_description('public.profiles'::regclass) as c`)[0]!.c as string) ?? '',
    ),
  )
  const emailKey = await sql`select conname from pg_constraint where conname = 'profiles_email_key'`
  check(
    'profiles_email_key is gone with the column (docs/22 §4.6: it could abort an SSO signup)',
    emailKey.length === 0,
  )
  const pkCtl = await sql`select conname from pg_constraint where conrelid = 'public.profiles'::regclass`
  check(
    'CONTROL: profiles still has constraints, so the empty result above is a real absence',
    pkCtl.length > 0,
    `${pkCtl.length} constraint(s)`,
  )

  // -------------------------------------------------------------------------
  section('2. THE GUARANTEE: no api role can read auth.users, by TABLE or by COLUMN')
  // -------------------------------------------------------------------------
  // A grant this repo does not control is doing the work (docs/22 §4.5 item 3),
  // so it is re-measured every run rather than assumed. The COLUMN check is
  // genuinely independent: a column grant can be issued without a table grant.
  for (const role of ['anon', 'authenticated', 'service_role']) {
    const r = await sql`select has_table_privilege(${role}, 'auth.users', 'select') as tbl,
                               has_column_privilege(${role}, 'auth.users', 'email', 'select') as col`
    check(`${role} cannot SELECT auth.users`, r[0]!.tbl === false)
    check(`${role} cannot SELECT auth.users.email`, r[0]!.col === false)
  }
  const su = await sql`select has_table_privilege('postgres', 'auth.users', 'select') as tbl,
                              has_column_privilege('postgres', 'auth.users', 'email', 'select') as col`
  check(
    'CONTROL: postgres CAN read both, so the six falses are a measurement not a broken query',
    su[0]!.tbl === true && su[0]!.col === true,
  )

  // -------------------------------------------------------------------------
  section('3. NO WAY AROUND THE GRANT — publication and views (§13.3: PROD WAS NEVER CHECKED)')
  // -------------------------------------------------------------------------
  const pubTables = await sql`select pubname, schemaname, tablename from pg_publication_tables order by 1, 2, 3`
  check(
    'no table is published to a logical-replication publication',
    pubTables.length === 0,
    pubTables.length ? JSON.stringify(pubTables) : 'supabase_realtime carries 0 tables',
  )
  const pubs = await sql`select pubname from pg_publication`
  check(
    'CONTROL: a publication EXISTS, so the empty table list is a real absence',
    pubs.length > 0,
    pubs.map((p) => p.pubname).join(', '),
  )
  const views = await sql`select schemaname, viewname from pg_views
                          where schemaname not in ('pg_catalog', 'information_schema') order by 1, 2`
  const overProfiles = views.filter((v) => v.schemaname === 'public')
  check(
    'no view in the public schema could re-expose what the grant withholds',
    overProfiles.length === 0,
    views.length ? `non-system views live only in: ${[...new Set(views.map((v) => v.schemaname))].join(', ')}` : '',
  )
  const viewCtl = await sql`select count(*)::int as n from pg_views`
  check(
    'CONTROL: the view catalog is readable, so the filtered zero is real',
    (viewCtl[0]!.n as number) > 0,
    `${viewCtl[0]!.n} views total`,
  )

  // -------------------------------------------------------------------------
  section('4. THE FUNCTION SURFACE IS THE AUDIT (docs/22 §4.5 item 1, §11.6)')
  // -------------------------------------------------------------------------
  // BOTH patterns, because they match DIFFERENT SETS, and `prosrc` matches
  // COMMENTS — both verified 2026-09-16 and both easy to get wrong.
  const matches = await sql`
    select p.proname, p.prosecdef, p.prosrc, p.proconfig, pg_get_userbyid(p.proowner) as owner
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (p.prosrc ~* 'email' or p.prosrc ~* 'auth[.]users')
    order by p.proname`
  const allowed = new Set([...EMAIL_READERS, ...COMMENT_MATCHES_ONLY])
  const unexpected = matches.map((m) => m.proname as string).filter((n) => !allowed.has(n))
  check('no function outside the allow-list touches an address or auth.users', unexpected.length === 0, unexpected.join(', '))
  for (const fn of EMAIL_READERS) {
    const row = matches.find((m) => m.proname === fn)
    check(`${fn} exists`, Boolean(row))
    if (!row) continue
    check(`${fn} is SECURITY DEFINER`, row.prosecdef === true)
    check(`${fn} is owned by postgres`, row.owner === 'postgres', String(row.owner))
    check(
      `${fn} pins search_path`,
      ((row.proconfig as string[] | null) ?? []).some((c) => c.startsWith('search_path=')),
      JSON.stringify(row.proconfig),
    )
  }
  const fnCtl = await sql`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public'`
  check(
    'CONTROL: the match is FILTERED, not everything',
    matches.length > 0 && matches.length < (fnCtl[0]!.n as number) / 2,
    `${matches.length} of ${fnCtl[0]!.n} functions`,
  )

  // Each definer's EXECUTE ACL, stated in full (docs/03 convention #1: prod's
  // ALTER DEFAULT PRIVILEGES grants anon EXECUTE at CREATE and local does not,
  // so this is exactly the check local cannot perform).
  for (const fn of EMAIL_READERS) {
    const r = await sql`select has_function_privilege('anon', p.oid, 'execute') as anon_exec
                        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                        where n.nspname = 'public' and p.proname = ${fn}`
    check(`${fn}: anon holds NO execute`, r.length === 1 && r[0]!.anon_exec === false)
  }

  // -------------------------------------------------------------------------
  section('5. THE PRIVATE COMPANION TABLE (docs/22 §21)')
  // -------------------------------------------------------------------------
  const upCols = (
    await sql`select attname from pg_attribute where attrelid = 'public.user_private'::regclass
              and attnum > 0 and not attisdropped order by attname`
  ).map((r) => r.attname as string)
  check('user_private holds settings and is_superadmin', upCols.includes('settings') && upCols.includes('is_superadmin'), upCols.join(', '))
  const rls = await sql`select relrowsecurity from pg_class where oid = 'public.user_private'::regclass`
  check('user_private has RLS ENABLED', rls[0]!.relrowsecurity === true)

  const pols = await sql`select polname, polcmd, pg_get_expr(polqual, polrelid) as using_expr
                         from pg_policy where polrelid = 'public.user_private'::regclass order by polname`
  check('user_private has policies', pols.length > 0, pols.map((p) => p.polname).join(', '))
  check(
    'NO policy on user_private grants a co-member read (asserted as an ABSENCE)',
    pols.every((p) => !/shares_org_with/.test((p.using_expr as string) ?? '')),
    'that blanket co-member read is the bug this table exists to avoid',
  )
  check(
    'CONTROL: a policy DOES key on auth.uid(), so the absence above is not vacuous',
    pols.some((p) => /auth\.uid\(\)/.test((p.using_expr as string) ?? '')),
  )
  // The real gate on the flag is the GRANT, not the policy: `authenticated` has
  // a column-scoped UPDATE on `settings` alone.
  const upd = await sql`select has_column_privilege('authenticated', 'public.user_private', 'is_superadmin', 'update') as flag,
                               has_column_privilege('authenticated', 'public.user_private', 'settings', 'update') as settings`
  check('authenticated CANNOT update user_private.is_superadmin', upd[0]!.flag === false)
  check('CONTROL: authenticated CAN update user_private.settings, so the grant query works', upd[0]!.settings === true)

  // THE TABLE-LEVEL SET, and it is the half that actually bit. A column grant
  // cannot narrow a table grant, so `update (settings)` above means nothing if
  // `authenticated` also holds table-level UPDATE. That is exactly what
  // happened in CI on 2026-09-17 when this migration granted without revoking
  // first: an ordinary user set his own `is_superadmin` to true. `anon` must
  // hold nothing at all.
  for (const [role, priv] of [
    ['authenticated', 'update'],
    ['authenticated', 'insert'],
    ['authenticated', 'delete'],
    ['anon', 'select'],
    ['anon', 'insert'],
    ['anon', 'update'],
    ['anon', 'delete'],
  ] as const) {
    const r = await sql`select has_table_privilege(${role}, 'public.user_private', ${priv}) as p`
    check(`${role} holds NO table-level ${priv.toUpperCase()} on user_private`, r[0]!.p === false)
  }
  const ctl = await sql`select has_table_privilege('authenticated','public.user_private','select') as a,
                               has_table_privilege('service_role','public.user_private','update') as s`
  check('CONTROL: authenticated DOES hold SELECT and service_role DOES hold UPDATE', ctl[0]!.a === true && ctl[0]!.s === true)

  // -------------------------------------------------------------------------
  section('6. THE FEATURE IS ALIVE, not merely well-shaped')
  // -------------------------------------------------------------------------
  // prod-verify-login-events.mts's lesson: a migration can be structurally
  // perfect and functionally dead. So read a real address through a real
  // definer and require actual data back.
  const users = await sql`select count(*)::int as n from auth.users where deleted_at is null`
  check('CONTROL: the database has users at all', (users[0]!.n as number) > 0, `${users[0]!.n} users`)

  const live = await sql`
    select count(*)::int as n from auth.users u
    where u.deleted_at is null and coalesce(u.is_anonymous, false) = false and u.email is not null`
  check(
    'every live account has a readable address in auth.users (the single source of truth)',
    (live[0]!.n as number) === (users[0]!.n as number),
    `${live[0]!.n} of ${users[0]!.n}`,
  )

  const noName = await sql`select count(*)::int as n from public.profiles
                           where display_name is null or btrim(display_name) = ''`
  check(
    'no profile is left without a display_name — it is the only label a co-member sees now',
    (noName[0]!.n as number) === 0,
    `${noName[0]!.n} nameless`,
  )
  const privRows = await sql`select count(*)::int as n from public.user_private`
  const profRows = await sql`select count(*)::int as n from public.profiles`
  check(
    'every profile has a companion row — the signup trigger writes both',
    privRows[0]!.n === profRows[0]!.n,
    `${privRows[0]!.n} private / ${profRows[0]!.n} profiles`,
  )
  const supers = await sql`select count(*)::int as n from public.user_private where is_superadmin`
  check(
    'the superadmin flag survived the move — at least one account still holds it',
    (supers[0]!.n as number) > 0,
    `${supers[0]!.n} superadmin(s); a silent 0 here would lock the Owner Console out entirely`,
  )

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => sql.end())
