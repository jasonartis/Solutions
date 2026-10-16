// PROD verification for 20261016010000_pending_invites_org.sql (docs/25, slice 1).
//
//   pnpm exec tsx scripts/prod-verify-pending-invites.mts
//   pnpm exec tsx scripts/prod-verify-pending-invites.mts --local
//
// Read-only (selects + one GET of prod's auth config). No app credentials: the
// session pooler with SUPABASE_DB_PASSWORD from .env.deploy, and
// SUPABASE_ACCESS_TOKEN for the auth-config read (§[6]).
//
// WHY NOT prod-verify-migration.ts: it is FUNCTION-ONLY, and this migration's
// load-bearing parts are a TABLE's ACL, ONE policy (and the ABSENCE of an
// inviter arm), a cron JOB, and a changed body of an existing function.
//
// §[6] IS THE ONE CHECK LOCAL CANNOT MAKE. A claim proves the person owns the
// address only because prod's GoTrue requires confirmation of a new address
// AND of an email change. Locally both autoconfirm, so --local skips §[6] and
// says so (adversarial review, 2026-10-15).
//
// The behaviour is proven by packages/db/src/pending-invites.test.ts against
// local; this proves prod holds the same objects.
//
// RUN IT BEFORE AND AFTER migrate:prod — pre-apply it should FAIL §[1]–§[5]
// and PASS every CONTROL.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const local = process.argv.includes('--local')

const env = local ? '' : readFileSync(resolve(root, '.env.deploy'), 'utf8')
const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''

const sql = local
  ? postgres(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres', { max: 1 })
  : (() => {
      const ref = get('SUPABASE_PROJECT_REF')
      const pw = get('SUPABASE_DB_PASSWORD')
      if (!ref || !pw) throw new Error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD in .env.deploy')
      return postgres(
        `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`,
        { ssl: 'require', max: 1 },
      )
    })()

let pass = 0
let fail = 0
let warn = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`) }
}
const note = (name: string, detail = '') => { warn++; console.log(`  WARN  ${name} ${detail}`) }

const body = async (sig: string) =>
  (await sql<{ body: string | null }[]>`
    select case when to_regprocedure(${sig}) is null then null
                else pg_get_functiondef(to_regprocedure(${sig})) end as body`)[0]?.body ?? ''
// NULL (not an error) when the function does not exist yet, so a pre-apply run reaches the end.
const canExec = async (role: string, sig: string) =>
  (await sql<{ ok: boolean | null }[]>`
    select case when to_regprocedure(${sig}) is null then null
                else has_function_privilege(${role}, ${sig}, 'execute') end as ok`)[0]!.ok
const tablePriv = async (role: string, priv: string) =>
  (await sql<{ ok: boolean | null }[]>`
    select case when to_regclass('public.pending_invites') is null then null
                else has_table_privilege(${role}, 'public.pending_invites', ${priv}) end as ok`)[0]!.ok

const ISSUE = 'public.pending_invite_issue_org(uuid, text, text)'
const CANCEL = 'public.pending_invite_cancel(uuid)'
const RESEND = 'public.pending_invite_resend(uuid)'
const APPLY = 'public.pending_invite_apply(uuid, uuid)'
const CLAIM = 'public.pending_invites_claim_mine()'
const PRUNE = 'public.pending_invites_prune_expired()'
const LAST_RUN = 'public.pending_invites_pruner_last_run()'
const FIND = 'public.org_find_user_by_email(uuid, text)'

try {
  console.log(`\nVerification — 20261016010000 pending invites (slice 1). Target: ${local ? 'LOCAL' : 'PRODUCTION'}\n`)

  console.log('[0] Controls')
  const [{ n: orgCount }] = await sql<{ n: number }[]>`select count(*)::int as n from public.orgs`
  check('CONTROL: orgs are readable (the catalog read is real)', orgCount > 0, `${orgCount}`)
  check('CONTROL: authenticated executes org_accept_invite', (await canExec('authenticated', 'public.org_accept_invite(uuid)')) === true)
  const cronJobs = await sql<{ jobname: string }[]>`select jobname::text from cron.job`
  check('CONTROL: cron.job is readable (account-deletion job present)', cronJobs.some((j) => j.jobname === 'account-deletions-complete-due'), cronJobs.map((j) => j.jobname).join(','))
  check('CONTROL: authenticated holds SELECT on org_members (a has_table_privilege read works)',
    (await sql<{ ok: boolean }[]>`select has_table_privilege('authenticated', 'public.org_members', 'select') as ok`)[0]!.ok)

  console.log('\n[1] The table and its ACL')
  const rel = await sql<{ rls: boolean; force: boolean }[]>`
    select relrowsecurity as rls, relforcerowsecurity as force from pg_class where oid = to_regclass('public.pending_invites')`
  check('pending_invites exists with RLS enabled', rel[0]?.rls === true, JSON.stringify(rel))
  const cols = await sql<{ column_name: string; is_nullable: string }[]>`
    select column_name::text, is_nullable::text from information_schema.columns
    where table_schema = 'public' and table_name = 'pending_invites' order by ordinal_position`
  check('columns are exactly id,kind,org_id,target_id,email,role,invited_by,created_at,expires_at',
    cols.map((c) => c.column_name).join(',') === 'id,kind,org_id,target_id,email,role,invited_by,created_at,expires_at',
    cols.map((c) => c.column_name).join(','))
  check('authenticated holds SELECT', (await tablePriv('authenticated', 'select')) === true)
  for (const priv of ['insert', 'update', 'delete', 'truncate', 'references', 'trigger']) {
    check(`authenticated does NOT hold ${priv.toUpperCase()}`, (await tablePriv('authenticated', priv)) === false)
  }
  for (const role of ['anon', 'service_role']) {
    for (const priv of ['select', 'insert', 'update', 'delete']) {
      check(`${role} does NOT hold ${priv.toUpperCase()}`, (await tablePriv(role, priv)) === false)
    }
  }
  const cons = await sql<{ def: string }[]>`
    select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = to_regclass('public.pending_invites')`
  check('the org-shape CHECK exists', cons.some((c) => /target_id = org_id/.test(c.def)))
  check('one row per (kind, target, address), NULLS NOT DISTINCT', cons.some((c) => /UNIQUE NULLS NOT DISTINCT \(kind, target_id, email\)/.test(c.def)), cons.map((c) => c.def).join(' | '))
  check('the address CHECK requires lower+trim', cons.some((c) => /lower\(btrim\(email\)\)/.test(c.def)))

  console.log('\n[2] The ONE policy — and the ABSENCE of an inviter arm')
  const pols = await sql<{ polname: string; polcmd: string; qual: string | null }[]>`
    select polname::text, polcmd::text, pg_get_expr(polqual, polrelid) as qual from pg_policy
    where polrelid = to_regclass('public.pending_invites')`
  check('exactly one policy', pols.length === 1, `${pols.length}`)
  check('it is SELECT-only', pols[0]?.polcmd === 'r', JSON.stringify(pols[0]))
  check('it reads is_org_admin(org_id)', /is_org_admin\(org_id\)/.test(pols[0]?.qual ?? ''), pols[0]?.qual ?? '')
  check('NEGATIVE: it has no invited_by arm (a demoted inviter must not keep reading addresses)', !!pols[0] && !/invited_by/.test(pols[0].qual ?? ''), pols[0]?.qual ?? '')

  console.log('\n[3] Functions: definer, pinned search_path, and the full EXECUTE ACL')
  for (const sig of [ISSUE, CANCEL, RESEND, APPLY, CLAIM, PRUNE, LAST_RUN]) {
    const b = await body(sig)
    check(`${sig} exists, SECURITY DEFINER, search_path pinned`, /SECURITY DEFINER/.test(b) && /SET search_path TO 'public'/.test(b))
  }
  for (const sig of [ISSUE, CANCEL, RESEND, CLAIM, LAST_RUN]) {
    check(`authenticated executes ${sig}`, (await canExec('authenticated', sig)) === true)
    check(`anon does NOT execute ${sig}`, (await canExec('anon', sig)) === false)
  }
  for (const sig of [APPLY, PRUNE]) {
    for (const role of ['authenticated', 'anon', 'service_role']) {
      check(`${role} does NOT execute internal ${sig}`, (await canExec(role, sig)) === false)
    }
  }
  const apply = await body(APPLY)
  check('the applier restores the caller identity (both settings restored, also in its exception handler)',
    (apply.match(/set_config\('request\.jwt\.claims', coalesce\(old_claims, ''\), true\)/g) ?? []).length === 2)
  const claim = await body(CLAIM)
  check('the claim requires a CONFIRMED address', /email_confirmed_at is not null/.test(claim))
  check('the claim asserts the identity came back', /caller identity was not restored/.test(claim))
  check('NEGATIVE: the claim never matches by account_email_fingerprint', !!claim && !/account_email_fingerprint/.test(claim))
  const issue = await body(ISSUE)
  check('issue reads the caps from platform_settings with a 100 / 20 fallback',
    /pending_invites\.caps/.test(issue) && /else 100 end/.test(issue) && /else 20 end/.test(issue))

  console.log('\n[4] org_find_user_by_email is SUPERADMIN-ONLY now (docs/25 §4.3)')
  const find = await body(FIND)
  check('its gate is is_superadmin()', /is_superadmin\(\)/.test(find), find.slice(0, 0))
  check('NEGATIVE: it no longer admits is_org_admin', !!find && !/is_org_admin/.test(find))
  check('CONTROL: authenticated still executes it (the Owner Console calls it)', (await canExec('authenticated', FIND)) === true)

  console.log('\n[5] The pruner job (docs/03 hard rule 5)')
  const job = await sql<{ schedule: string; command: string; active: boolean }[]>`
    select schedule::text, command::text, active from cron.job where jobname = 'pending-invites-prune-expired'`
  check('pending-invites-prune-expired is scheduled, hourly, active',
    job[0]?.active === true && job[0]?.schedule === '23 * * * *' && /pending_invites_prune_expired\(\)/.test(job[0]?.command ?? ''),
    JSON.stringify(job))
  const runs = await sql<{ status: string; end_time: Date | null }[]>`
    select d.status::text, d.end_time from cron.job_run_details d join cron.job j on j.jobid = d.jobid
    where j.jobname = 'pending-invites-prune-expired' order by d.end_time desc nulls last limit 5`
  if (runs.length === 0) note('no run recorded YET — expected within the first hour after apply; re-run later')
  else check('the most recent run succeeded', runs[0]!.status === 'succeeded', JSON.stringify(runs[0]))
  if (rel.length) {
    const [{ stale }] = await sql<{ stale: number }[]>`
      select count(*)::int as stale from public.pending_invites where expires_at < now() - interval '2 hours'`
    check('no invitation is more than 2 hours past expiry (the pruner is keeping up)', stale === 0, `${stale}`)
  }

  console.log('\n[6] Prod auth config: does a confirmed address prove ownership?')
  if (local) {
    note('NOT CHECKED on local — local autoconfirms by design (config.toml enable_confirmations = false)')
  } else {
    const token = get('SUPABASE_ACCESS_TOKEN')
    const ref = get('SUPABASE_PROJECT_REF')
    if (!token) {
      note('SUPABASE_ACCESS_TOKEN missing from .env.deploy — §[6] not checked')
    } else {
      const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        note(`auth config read returned ${res.status} — a 401 means regenerate the token (CLAUDE.md); §[6] not checked`)
      } else {
        const cfg = (await res.json()) as Record<string, unknown>
        check('CONTROL: the Before-User-Created hook reads as enabled (the config read is real)', cfg.hook_before_user_created_enabled === true)
        check('a new email address must be confirmed (mailer_autoconfirm = false)', cfg.mailer_autoconfirm === false, `${cfg.mailer_autoconfirm}`)
        check('an email CHANGE must be confirmed (mailer_secure_email_change_enabled = true)', cfg.mailer_secure_email_change_enabled === true, `${cfg.mailer_secure_email_change_enabled}`)
      }
    }
  }

  console.log('\n[7] Data (informational)')
  if (rel.length) {
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.pending_invites`
    console.log(`  INFO  ${n} pending invitation(s) on this database`)
  }
} finally {
  await sql.end()
}

console.log(`\n${pass} passed, ${fail} failed, ${warn} warning(s)\n`)
process.exit(fail ? 1 : 0)
