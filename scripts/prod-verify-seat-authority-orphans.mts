// PROD measurement for docs/19-seat-authority-audit.md — is the "module roster
// row outlives org membership" class actually LIVE on prod, or only theoretical?
//
//   pnpm exec tsx scripts/prod-verify-seat-authority-orphans.mts
//   pnpm exec tsx scripts/prod-verify-seat-authority-orphans.mts --local
//
// No arguments and NO app credentials: pooler + SUPABASE_DB_PASSWORD from
// .env.deploy, same as scripts/prod-verify-superadmin-log.mts. READ-ONLY —
// every statement below is a SELECT.
//
// `--local` runs the identical queries against the LOCAL database instead
// (DATABASE_URL, or the standard supabase-start port). Added 2026-09-15 because
// the role-dimension measurement below BLOCKS the module-role fix and has to be
// runnable before that migration is written, not only after it reaches prod.
//
// TWO DIMENSIONS, and they are different questions:
//
//   [1] ORG dimension (the original, 2026-09-04) — does a roster row's holder
//       still hold ACTIVE org membership? Closed by 20260910040000.
//   [3] ROLE dimension (added 2026-09-15) — does a roster row's holder hold the
//       MODULE ROLE that the proposed conjunct would require? This is docs/19's
//       mandated pre-flight: if any seat's holder lacks that role, adding the
//       conjunct REVOKES LIVE ACCESS rather than closing a hole. It encodes the
//       seat→role mapping explicitly, so the mapping itself is reviewable here
//       instead of being implicit in the migration.
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

const LOCAL = process.argv.includes('--local')

let ref = '(local)'
let sql: ReturnType<typeof postgres>
if (LOCAL) {
  const localUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
  sql = postgres(localUrl, { max: 1 })
} else {
  ref = get('SUPABASE_PROJECT_REF')
  const pw = get('SUPABASE_DB_PASSWORD')
  if (!ref || !pw) throw new Error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD in .env.deploy')
  sql = postgres(
    `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`,
    { ssl: 'require', max: 1 },
  )
}

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
    console.log(`  currently NOT live on this ${LOCAL ? 'LOCAL' : 'prod'} database (see summary for caveats).`)
  } else {
    for (const t of TABLES) {
      const r = results.find((x) => x.table === t.table)
      if (!r || r.orphaned === 0) continue
      const nullGuard = t.holderNullable ? sql`and t.${sql(t.holderCol)} is not null` : sql``
      const sample = await sql`
        select t.id, t.${sql(t.orgCol)} as org_id, t.${sql(t.holderCol)} as holder_id,
               o.name as org_name, p.display_name as holder_name
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
        console.log(`    row ${row.id}  org=${row.org_name}(${row.org_id})  holder=${row.holder_name ?? row.holder_id}`)
      }
    }
  }

  // -------------------------------------------------------------------------
  // [3] ROLE DIMENSION — docs/19's mandated pre-flight for the module-role fix.
  //
  // For each roster, the role the PROPOSED conjunct would require. "missing"
  // counts rows whose holder does NOT hold it — i.e. rows whose access the
  // conjunct would REVOKE. A non-zero count is not a bug found, it is a
  // decision forced: either those holders should be re-granted the role, or the
  // conjunct is wrong for that seat.
  //
  // SCOPE SEMANTICS MATTER AND DIFFER — this is the whole reason the mapping is
  // spelled out rather than looped over uniformly:
  //   'global'  — has_module_role() requires `scope_ref is null`, so a SCOPED
  //               grant of the same role does NOT satisfy it (verified against
  //               the live catalog 2026-09-15).
  //   'anyscope'— sal_is_worker() checks role only, ignoring scope_ref.
  //   'scoped'  — cls_is_class_member() requires a grant whose scope COVERS the
  //               class's node; calls the real module_scope_covers(), so this
  //               mirrors no logic by hand.
  console.log('\n[3] ROLE dimension — would the proposed module-role conjunct revoke anyone?\n')

  type RoleSpec = {
    table: string
    holderCol: string
    orgCol: string
    holderNullable?: boolean
    moduleKey: string
    role: string
    mode: 'global' | 'anyscope' | 'scoped'
    predicate: string
    note?: string
  }

  const ROLE_SPECS: RoleSpec[] = [
    {
      table: 'mm_matchmaker_assignments',
      holderCol: 'matchmaker_id',
      orgCol: 'org_id',
      moduleKey: 'matchmaking',
      role: 'matchmaker',
      mode: 'global',
      predicate: 'mm_matchmaker_can_see → mm_is_matchmaker',
      note: 'an ADMIN assigned as a matchmaker holds role=admin, not matchmaker — they keep reading via the mm_can_manage FOR ALL arm, so a miss here is not necessarily a loss',
    },
    {
      table: 'mm_group_members',
      holderCol: 'user_id',
      orgCol: 'org_id',
      moduleKey: 'matchmaking',
      role: 'single',
      mode: 'global',
      predicate: 'mm_assignment_covers_me (group arm) → mm_is_single',
    },
    {
      table: 'sd_participants',
      holderCol: 'user_id',
      orgCol: 'org_id',
      moduleKey: 'speed-dating',
      role: 'participant',
      mode: 'global',
      predicate: 'sd_owns_participant / sd_in_event / sd_paired_with → sd_is_participant',
      note: "TRAP (docs/19 clean-room #3): seat_type is participant|audience|mentor and there is NO audience or mentor module role, so this conjunct would revoke those seats outright — see the seat_type breakdown below",
    },
    {
      table: 'sal_appointments',
      holderCol: 'worker_id',
      orgCol: 'org_id',
      holderNullable: true,
      moduleKey: 'nail-salon',
      role: 'worker',
      mode: 'anyscope',
      predicate: 'sal_worker_sees_customer + 2 inline arms → sal_is_worker',
    },
    {
      table: 'sal_worker_profiles',
      holderCol: 'user_id',
      orgCol: 'org_id',
      moduleKey: 'nail-salon',
      role: 'worker',
      mode: 'anyscope',
      predicate: 'sal_worker_time_off_select inline arm → sal_is_worker',
    },
    {
      table: 'cls_review_assignments',
      holderCol: 'reviewer_id',
      orgCol: 'org_id',
      moduleKey: 'classroom',
      role: '(any, scope-covering)',
      mode: 'scoped',
      predicate: 'cls_reviews_submission → cls_is_class_member(class_id)',
    },
  ]

  const roleRows = await sql`select count(*)::int as n from public.module_roles`
  check('CONTROL: module_roles has rows at all (else every "missing" below is vacuous)',
    (roleRows[0]?.n ?? 0) > 0, `${roleRows[0]?.n} rows`)

  let anyPositiveMatch = false
  const roleResults: { table: string; total: number; held: number; missing: number; spec: RoleSpec }[] = []

  for (const s of ROLE_SPECS) {
    const nullGuard = s.holderNullable ? sql`and t.${sql(s.holderCol)} is not null` : sql``
    const heldExpr =
      s.mode === 'scoped'
        ? sql`exists (
            select 1 from public.module_roles g
            join public.cls_classes c on c.id = t.class_id
            where g.org_id = c.org_id
              and g.module_key = 'classroom'
              and g.user_id = t.${sql(s.holderCol)}
              and g.scope_ref is not null
              and public.module_scope_covers(g.scope_ref, c.scope_node_id)
          )`
        : s.mode === 'global'
          ? sql`exists (
              select 1 from public.module_roles g
              where g.org_id = t.${sql(s.orgCol)}
                and g.module_key = ${s.moduleKey}
                and g.role = ${s.role}
                and g.user_id = t.${sql(s.holderCol)}
                and g.scope_ref is null
            )`
          : sql`exists (
              select 1 from public.module_roles g
              where g.org_id = t.${sql(s.orgCol)}
                and g.module_key = ${s.moduleKey}
                and g.role = ${s.role}
                and g.user_id = t.${sql(s.holderCol)}
            )`

    const rows = await sql`
      select count(*)::int as total,
             count(*) filter (where ${heldExpr})::int as held
      from public.${sql(s.table)} t
      where true ${nullGuard}
    `
    const total = rows[0]?.total ?? 0
    const held = rows[0]?.held ?? 0
    const missing = total - held
    if (held > 0) anyPositiveMatch = true
    roleResults.push({ table: s.table, total, held, missing, spec: s })
    const flag = total === 0 ? 'VACUOUS (no rows)' : missing === 0 ? 'clean' : `${missing} WOULD LOSE ACCESS`
    console.log(`  ${s.table.padEnd(28)} total=${String(total).padEnd(4)} holds-role=${String(held).padEnd(4)} ${flag}`)
    console.log(`      ${s.predicate} [${s.mode}]`)
    if (s.note) console.log(`      NOTE: ${s.note}`)
  }

  // THE control that makes a clean sheet mean anything: at least one row must
  // POSITIVELY match its role, or "0 missing" could just be a broken join.
  check('CONTROL: at least one roster row positively HOLDS its mapped role (proves the join works)',
    anyPositiveMatch,
    JSON.stringify(roleResults.map((r) => `${r.table}=${r.held}/${r.total}`)))

  // Speed dating's seat_type split, printed whether or not rows exist — a zero
  // here is the honest answer ("cannot be measured"), not a pass.
  const seatTypes = await sql`
    select seat_type, count(*)::int as n,
           count(*) filter (where exists (
             select 1 from public.module_roles g
             where g.org_id = p.org_id and g.module_key = 'speed-dating'
               and g.role = 'participant' and g.user_id = p.user_id and g.scope_ref is null
           ))::int as holds_participant_role
    from public.sd_participants p group by seat_type order by seat_type`
  console.log('\n  sd_participants by seat_type (the audience/mentor question):')
  if (seatTypes.length === 0) {
    console.log('    NO ROWS AT ALL. The audience/mentor half of the speed-dating mapping is')
    console.log('    UNMEASURABLE here — a clean result above proves nothing about it.')
  } else {
    for (const r of seatTypes) {
      console.log(`    ${String(r.seat_type).padEnd(12)} n=${r.n}  holds 'participant' role=${r.holds_participant_role}`)
    }
  }

  // -------------------------------------------------------------------------
  // [4] FLOOR DIMENSION — the pre-flight docs/19's STILL-OPEN item 2 mandates.
  //
  // Both `vm_pin_member` and `vm_guard_last_conversation_admin` count the
  // last-admin floor as `role='admin' and status='active' and id <> old.id`,
  // with NO is_org_member conjunct. Since 20260910040000 a seat whose holder
  // has left the org confers nothing — yet it still COUNTS toward the floor,
  // so the effective last admin is permitted to leave and orphan the
  // conversation. The guard that exists to prevent orphaning permits it.
  //
  // THIS FIX MAKES A GUARD FIRE **MORE** OFTEN. Every other dimension in this
  // script measures who would LOSE READ ACCESS. This one measures who would
  // lose the ability to LEAVE — same question shape, opposite direction — and
  // it is why the fix gets its own migration instead of riding along.
  //
  // Three populations, genuinely different findings:
  //   (a) ORPHANED ADMIN SEATS — an active admin seat whose holder is not an
  //       active org member. Not itself wrong; it is the raw material for the
  //       other two.
  //   (b) NEWLY-BLOCKED LEAVERS — an active admin seat that MAY leave today
  //       (some other active admin seat exists) but may NOT after the fix (no
  //       other active admin seat whose holder is an active org member). This
  //       is the user-visible behaviour change, counted per seat.
  //   (c) ALREADY-ORPHANED CONVERSATIONS — at least one active admin seat, but
  //       ZERO held by an active org member. Nobody can administer it TODAY;
  //       the fix does not create these, it stops new ones being made.
  //
  // CONTROL per docs/03's vacuity rule: zero here means nothing if there are
  // no admin seats or the membership join is broken, so the totals print and a
  // POSITIVE holder-is-member match is asserted — and a database with no
  // active admin seats at all says so explicitly instead of reporting "0".
  console.log('\n[4] FLOOR dimension — would the last-admin conjunct newly BLOCK anyone from leaving?\n')

  const floor = await sql`
    with admin_seats as (
      select m.id, m.conversation_id, m.org_id, m.user_id,
             exists (
               select 1 from public.org_members om
               where om.org_id = m.org_id
                 and om.user_id = m.user_id
                 and om.status = 'active'
             ) as holder_is_member
      from public.vm_conversation_members m
      where m.role = 'admin' and m.status = 'active'
    ),
    per_conv as (
      select conversation_id,
             count(*)::int as admins,
             count(*) filter (where holder_is_member)::int as effective_admins
      from admin_seats group by conversation_id
    )
    select
      (select count(*)::int from public.vm_conversations)                        as conversations,
      (select count(*)::int from public.vm_conversation_members)                 as seats,
      (select count(*)::int from admin_seats)                                    as admin_seats,
      (select count(*) filter (where holder_is_member)::int from admin_seats)    as held_by_members,
      (select count(*) filter (where not holder_is_member)::int from admin_seats) as orphaned_admin_seats,
      (select count(*)::int from per_conv where admins > 0 and effective_admins = 0)
                                                                                 as already_orphaned_convs,
      (select count(*)::int
         from admin_seats a
         join per_conv c on c.conversation_id = a.conversation_id
        where c.admins - 1 >= 1
          and c.effective_admins - (case when a.holder_is_member then 1 else 0 end) = 0)
                                                                                 as newly_blocked_leavers
  `
  const f = floor[0] ?? {}
  console.log(`  vm_conversations                                   ${f.conversations}`)
  console.log(`  vm_conversation_members (all seats)                ${f.seats}`)
  console.log(`  active ADMIN seats                                 ${f.admin_seats}`)
  console.log(`      held by an ACTIVE org member                   ${f.held_by_members}`)
  console.log(`  (a) ORPHANED admin seats (holder left the org)     ${f.orphaned_admin_seats}`)
  console.log(`  (b) NEWLY-BLOCKED LEAVERS (behaviour change)       ${f.newly_blocked_leavers}`)
  console.log(`  (c) ALREADY-ORPHANED conversations                 ${f.already_orphaned_convs}`)

  if ((f.admin_seats ?? 0) === 0) {
    console.log('\n  NO ACTIVE ADMIN SEATS AT ALL on this database, so every number above is')
    console.log('  VACUOUS. This run proves nothing about the floor — report it as')
    console.log('  "unmeasurable here", never as "zero affected".')
  } else {
    check('CONTROL: at least one active admin seat POSITIVELY resolves to an active org member (proves the join works)',
      (f.held_by_members ?? 0) > 0, `${f.held_by_members}/${f.admin_seats}`)
  }

  if ((f.orphaned_admin_seats ?? 0) > 0) {
    console.log('\n  Detail — every active admin seat in a conversation that has an orphaned one:\n')
    const detail = await sql`
      select c.id as conversation_id, c.title, o.name as org_name,
             m.id as seat_id, m.user_id, p.display_name,
             exists (
               select 1 from public.org_members om
               where om.org_id = m.org_id and om.user_id = m.user_id and om.status = 'active'
             ) as holder_is_member
      from public.vm_conversation_members m
      join public.vm_conversations c on c.id = m.conversation_id
      join public.orgs o on o.id = m.org_id
      left join public.profiles p on p.user_id = m.user_id
      where m.role = 'admin' and m.status = 'active'
        and m.conversation_id in (
          select m2.conversation_id from public.vm_conversation_members m2
          where m2.role = 'admin' and m2.status = 'active'
            and not exists (
              select 1 from public.org_members om
              where om.org_id = m2.org_id and om.user_id = m2.user_id and om.status = 'active'
            )
        )
      order by c.id, m.id
      limit 50
    `
    for (const r of detail) {
      console.log(`    conv ${r.conversation_id} "${r.title}" org=${r.org_name}`)
      console.log(`      seat ${r.seat_id} holder=${r.display_name ?? r.user_id} active-org-member=${r.holder_is_member}`)
    }
  }

  // -------------------------------------------------------------------------
  console.log(`\n${pass} control checks passed, ${fail} failed`)
  console.log('\nSummary — ORG dimension (table: total / orphaned):')
  for (const r of results) console.log(`  ${r.table.padEnd(28)} ${r.total} / ${r.orphaned}`)
  console.log('\nSummary — ROLE dimension (table: total / would-lose-access):')
  for (const r of roleResults) console.log(`  ${r.table.padEnd(28)} ${r.total} / ${r.missing}`)
  console.log('\nSummary — FLOOR dimension (vm last-admin, docs/19 STILL-OPEN item 2):')
  console.log(`  active admin seats             ${f.admin_seats}`)
  console.log(`  orphaned admin seats           ${f.orphaned_admin_seats}`)
  console.log(`  newly-blocked leavers          ${f.newly_blocked_leavers}`)
  console.log(`  already-orphaned conversations ${f.already_orphaned_convs}`)
} finally {
  await sql.end()
}
process.exit(fail === 0 ? 0 : 1)
