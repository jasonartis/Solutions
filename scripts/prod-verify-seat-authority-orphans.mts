// PROD measurement for docs/19-seat-authority-audit.md — is the "module roster
// row outlives org membership" class actually LIVE on prod, or only theoretical?
//
//   pnpm exec tsx scripts/prod-verify-seat-authority-orphans.mts
//
// No arguments and NO app credentials: pooler + SUPABASE_DB_PASSWORD from
// .env.deploy, same as scripts/prod-verify-superadmin-log.mts. READ-ONLY —
// every statement below is a SELECT. Does not touch the local DB.
//
// WHAT "ORPHANED" MEANS HERE: a roster row whose holder has no org_members row
// for that row's org_id with status = 'active' (public.is_org_member's exact
// definition, 20260727010000:81-94) — i.e. the org seat was deleted
// (removeOrgMember, apps/web/lib/org-members.ts:89-92) or never got past
// 'pending', while the module-owned roster row survives untouched (nothing FKs
// org_members — docs/19's central finding).
//
// CONTROL, per docs/03's vacuity rule: a zero-orphan result is meaningless
// unless something proves the query CAN see non-zero rows. Every table prints
// its own total alongside the orphan count, and a platform-wide control up
// front proves org_members/the roster tables aren't empty or unreadable.
//
// This is a MEASUREMENT script only. It fixes nothing — remediation is its own
// Opus slice per docs/19's "Remediation shape" section.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const env = readFileSync(resolve(root, '.env.deploy'), 'utf8')
const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''

const ref = get('SUPABASE_PROJECT_REF')
const pw = get('SUPABASE_DB_PASSWORD')
if (!ref || !pw) throw new Error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD in .env.deploy')

const sql = postgres(
  `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`,
  { ssl: 'require', max: 1 },
)

type TableSpec = {
  table: string
  holderCol: string
  orgCol: string
  holderNullable?: boolean
  exposure: string
}

const TABLES: TableSpec[] = [
  {
    table: 'sd_participants',
    holderCol: 'user_id',
    orgCol: 'org_id',
    exposure: 'live event/round reads, revealed matches + contact details, safety-report insert (docs/19 §2)',
  },
  {
    table: 'mm_matchmaker_assignments',
    holderCol: 'matchmaker_id',
    orgCol: 'org_id',
    exposure: "assigned single's full questionnaire + compatibility scores, or assigned group's full roster (docs/19 §1)",
  },
  {
    table: 'mm_group_members',
    holderCol: 'user_id',
    orgCol: 'org_id',
    exposure: 'group membership row itself readable by matchmakers assigned to that group (docs/19 §1)',
  },
  {
    table: 'sal_worker_profiles',
    holderCol: 'user_id',
    orgCol: 'org_id',
    exposure: "gates sal_customers reads: every served customer's full_name/phone/email/notes (docs/19 §3)",
  },
  {
    table: 'sal_appointments',
    holderCol: 'worker_id',
    orgCol: 'org_id',
    holderNullable: true,
    exposure: 'appointment read + write (state advance, notes) on old appointments (docs/19 §3)',
  },
  {
    table: 'cls_review_assignments',
    holderCol: 'reviewer_id',
    orgCol: 'org_id',
    exposure: "submission + submission files (Storage-downloadable) + review-comment insert on a student's code (docs/19 §4)",
  },
  {
    table: 'cls_class_members',
    holderCol: 'user_id',
    orgCol: 'org_id',
    exposure: 'CLEAN per docs/19 (cured by 20260727010000) — measured anyway as the control case',
  },
  {
    table: 'vm_conversation_members',
    holderCol: 'user_id',
    orgCol: 'org_id',
    exposure: 'FIXED per docs/19/20260904010000 — measured anyway as the control case',
  },
]

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`) }
}

try {
  console.log(`\nSeat-authority orphan measurement — PROD (project ${ref})\n`)

  // -------------------------------------------------------------------------
  console.log('[0] Platform-wide controls (docs/03 vacuity rule)')
  const orgMembers = await sql`select count(*)::int as n, count(*) filter (where status = 'active')::int as active
    from public.org_members`
  check('CONTROL: org_members has rows at all', (orgMembers[0]?.n ?? 0) > 0, `${orgMembers[0]?.n} rows`)
  check('CONTROL: org_members has ACTIVE rows (the baseline orphan-checks compare against)',
    (orgMembers[0]?.active ?? 0) > 0, `${orgMembers[0]?.active} active`)
  console.log(`         org_members: ${orgMembers[0]?.n} total, ${orgMembers[0]?.active} active, ` +
    `${(orgMembers[0]?.n ?? 0) - (orgMembers[0]?.active ?? 0)} pending`)

  // -------------------------------------------------------------------------
  console.log('\n[1] Per-table orphan counts\n')
  const results: { table: string; total: number; orphaned: number; exposure: string }[] = []

  for (const t of TABLES) {
    const nullGuard = t.holderNullable ? sql`and t.${sql(t.holderCol)} is not null` : sql``
    const rows = await sql`
      select
        count(*)::int as total,
        count(*) filter (where not exists (
          select 1 from public.org_members om
          where om.org_id = t.${sql(t.orgCol)}
            and om.user_id = t.${sql(t.holderCol)}
            and om.status = 'active'
        ))::int as orphaned
      from public.${sql(t.table)} t
      where true ${nullGuard}
    `
    const total = rows[0]?.total ?? 0
    const orphaned = rows[0]?.orphaned ?? 0
    results.push({ table: t.table, total, orphaned, exposure: t.exposure })
    console.log(`  ${t.table.padEnd(28)} total=${String(total).padEnd(6)} orphaned=${orphaned}`)
  }

  check('CONTROL: at least one table has real (non-empty) roster rows to check',
    results.some((r) => r.total > 0),
    JSON.stringify(results.map((r) => `${r.table}=${r.total}`)))

  // -------------------------------------------------------------------------
  console.log('\n[2] Detail on any orphaned rows found — what each would expose\n')
  const anyOrphans = results.filter((r) => r.orphaned > 0)
  if (anyOrphans.length === 0) {
    console.log('  None found. Zero orphaned rows across all 8 tables, against the non-zero')
    console.log('  totals and non-zero org_members baseline printed above — the finding is')
    console.log('  currently NOT live on this prod database (see summary for caveats).')
  } else {
    for (const t of TABLES) {
      const r = results.find((x) => x.table === t.table)
      if (!r || r.orphaned === 0) continue
      const nullGuard = t.holderNullable ? sql`and t.${sql(t.holderCol)} is not null` : sql``
      const sample = await sql`
        select t.id, t.${sql(t.orgCol)} as org_id, t.${sql(t.holderCol)} as holder_id,
               o.name as org_name, p.email as holder_email
        from public.${sql(t.table)} t
        join public.orgs o on o.id = t.${sql(t.orgCol)}
        left join public.profiles p on p.user_id = t.${sql(t.holderCol)}
        where not exists (
          select 1 from public.org_members om
          where om.org_id = t.${sql(t.orgCol)}
            and om.user_id = t.${sql(t.holderCol)}
            and om.status = 'active'
        ) ${nullGuard}
        limit 5
      `
      console.log(`  ${t.table} — ${r.orphaned} orphaned row(s). Exposure: ${t.exposure}`)
      for (const row of sample) {
        console.log(`    row ${row.id}  org=${row.org_name}(${row.org_id})  holder=${row.holder_email ?? row.holder_id}`)
      }
    }
  }

  // -------------------------------------------------------------------------
  console.log(`\n${pass} control checks passed, ${fail} failed`)
  console.log('\nSummary (table: total / orphaned):')
  for (const r of results) console.log(`  ${r.table.padEnd(28)} ${r.total} / ${r.orphaned}`)
} finally {
  await sql.end()
}
process.exit(fail === 0 ? 0 : 1)
