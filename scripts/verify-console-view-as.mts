// Live adversarial probes for the Owner Console view-as, as REAL signed-in
// users over PostgREST — the same surface an attacker has (docs/03 #12, #19).
// Sibling of verify-data-browser.mts; run both when either console tool changes.
//
// WHY A SCRIPT AND NOT ONLY UNIT TESTS. This surface's safety argument is a
// claim about the LIVE database: "a superadmin bypassing every declared edge
// still sees only what their own RLS returns, because the modules' policies
// short-circuit is_org_admin -> is_superadmin." That is checkable only against
// real policies with real users. The db suite checks the declarations; this
// checks the claim, and it checks the two premises the design rests on — that
// the superadmin holds NO module grants and belongs to NO org, which is what
// makes the ordinary render path resolve every scoped target to nothing.
//
// EVERY NEGATIVE ASSERTION HERE CARRIES A NON-EMPTINESS CONTROL (docs/03 #18,
// the vacuity rule). The fixtures the 2026-08-06 review demanded are seeded:
// a second salon location (Uptown), a location-scoped manager (grace), a
// DISABLED entitlement (visual-messaging on demo-salon) and CROSS-AUTHORED
// classroom review comments. Without them, probe [4]'s "the student's tab shows
// only their own comments" and probe [5]'s disabled-module claims would pass on
// an empty universe.
//
// NOT COVERED HERE, on purpose: the UI gate itself (a non-superadmin getting a
// bare 404 from /console/view-as) is an HTTP-level fact and lives in the e2e
// suite, and probe [6]'s source scan is mirrored into packages/db/src/rls.test.ts
// because scripts/*.mts are NOT run by CI (docs/03 #19's own lesson — anything
// stated as fact to an operator belongs somewhere CI runs).
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

function fromDotEnv(key: string): string | undefined {
  try {
    const env = readFileSync(resolve(root, '.env'), 'utf8')
    return new RegExp(`^${key}=(.*)$`, 'm').exec(env)?.[1]?.trim()
  } catch {
    return undefined
  }
}

const url = process.env.SUPABASE_URL ?? fromDotEnv('SUPABASE_URL') ?? 'http://127.0.0.1:54321'
const anonKey = process.env.SUPABASE_ANON_KEY ?? fromDotEnv('SUPABASE_ANON_KEY')
if (!anonKey) throw new Error('SUPABASE_ANON_KEY not set and not in .env — run `pnpm dev` once')

async function signIn(email: string) {
  const c = createClient(url, anonKey, { auth: { persistSession: false } })
  const { error } = await c.auth.signInWithPassword({ email, password: 'password123' })
  if (error) throw new Error(`${email}: ${error.message}`)
  return c
}

let pass = 0
let fail = 0
let skipped = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`) }
}
function skip(name: string, why: string) {
  skipped++
  console.log(`  SKIP  ${name} — ${why}`)
}

async function userId(c: SupabaseClient) {
  return (await c.auth.getUser()).data.user!.id
}

const owner = await signIn('owner@demo.local') // the local superadmin
const alice = await signIn('alice@demo.local') // professor (demo-a), org-wide salon manager
const grace = await signIn('grace@demo.local') // salon manager SCOPED to Uptown (2026-08-06 fixture)
const charlie = await signIn('charlie@demo.local') // student (demo-a), salon customer

const ownerId = await userId(owner)

// ---------------------------------------------------------------------------
console.log('\n[1] The three premises the whole design rests on')
{
  const prof = (await owner.from('profiles').select('is_superadmin').eq('user_id', ownerId).single()).data
  check('owner@demo.local is the local superadmin (probe precondition)', prof?.is_superadmin === true)

  // If either of these ever stops being true, the Owner Console stops being the
  // thing this code documents: `renderSurface`'s scope intersection would start
  // finding real grants to intersect with, and the mode-1 "usually empty, and
  // that is the truthful answer" blurb would silently become wrong.
  const grants = await owner.from('module_roles').select('module_key, role').eq('user_id', ownerId)
  check(
    'the superadmin holds NO module grants anywhere',
    (grants.data ?? []).length === 0,
    JSON.stringify(grants.data),
  )
  const memberships = await owner.from('org_members').select('org_id').eq('user_id', ownerId)
  check(
    'the superadmin is a member of NO org (why is_org_member fails for them)',
    (memberships.data ?? []).length === 0,
    JSON.stringify(memberships.data),
  )
}

// ---------------------------------------------------------------------------
console.log('\n[2] The migration premise: the superadmin can read sal_locations')
// 20260806010000 exists because 20260726010000 split a `for all` policy
// per-command and dropped the inherited read arm, leaving the ONE table in the
// schema where service_role saw rows and the superadmin saw zero WITH NO ERROR
// — which renders every scoped salon section empty and looks like a finding.
{
  const asMember = await alice.from('sal_locations').select('id, name')
  check(
    'CONTROL: a salon member reads locations, so the table is not empty',
    (asMember.data ?? []).length > 0,
    asMember.error?.message ?? '',
  )
  const asSuper = await owner.from('sal_locations').select('id, name')
  check('the superadmin reads sal_locations', (asSuper.data ?? []).length > 0, asSuper.error?.message ?? '')
  check(
    'the superadmin sees the SAME locations a member does (no narrowing, no widening)',
    (asSuper.data ?? []).length === (asMember.data ?? []).length,
  )
  check(
    'the second location fixture is present, so a scope filter can be falsified',
    (asSuper.data ?? []).length >= 2,
    'seed only has one location — a scope-narrowed render cannot be distinguished from an unfiltered one',
  )
}

// ---------------------------------------------------------------------------
console.log('\n[3] The headline case: one named holder\'s SCOPE-narrowed console')
// Mode 3 with a scope. This is the case the salon review refused to fake: mode 1
// renders the caller's own scope and mode 2 needs a per-person column a
// location-narrowed position does not have. What the page does is filter the
// scope entity, so that is what is probed.
{
  const org = (await alice.from('orgs').select('id').eq('slug', 'demo-salon').single()).data
  if (!org) {
    skip('scope-narrowed render', 'demo-salon not seeded')
  } else {
    const locs = (await owner.from('sal_locations').select('id, name').eq('org_id', org.id)).data ?? []
    const uptown = locs.find((l) => /uptown/i.test(String(l.name)))
    if (!uptown || locs.length < 2) {
      skip('scope-narrowed render', 'the Uptown fixture location is missing')
    } else {
      const all = await owner.from('sal_services').select('id').eq('org_id', org.id)
      const scoped = await owner.from('sal_services').select('id').eq('org_id', org.id).eq('location_id', uptown.id)
      check('CONTROL: the whole-module render returns services', (all.data ?? []).length > 0)
      check('CONTROL: the Uptown scope returns services of its own', (scoped.data ?? []).length > 0)
      // The fixture gave the two locations DIFFERENT row counts on purpose, so a
      // scope filter that silently does nothing shows up as a wrong number
      // rather than as an identical one.
      check(
        'narrowing to one location returns FEWER rows than the whole module',
        (scoped.data ?? []).length < (all.data ?? []).length,
        `${(scoped.data ?? []).length} vs ${(all.data ?? []).length} — a filter that does nothing looks exactly like this when the counts match`,
      )

      // And the person this mode exists for really is narrowed by RLS, so "the
      // Uptown manager's back office" is a different thing from alice's.
      //
      // ON `sal_expenses` RATHER THAN `sal_services`, and the difference is a
      // fact worth recording: the service CATALOG is `is_org_member(org_id)`,
      // org-wide on purpose (a customer must read services to book one), while
      // the back-office tables are `sal_can_operate_location`. So the console's
      // scope filter on the catalog section is NARROWER than RLS — allowed,
      // since a surface declaration may only narrow — and comparing catalog row
      // counts between two managers proves nothing about scope. It cost this
      // probe one failing run to notice, which is the point of running it.
      const graceRows = await grace.from('sal_expenses').select('id').eq('org_id', org.id)
      const aliceRows = await alice.from('sal_expenses').select('id').eq('org_id', org.id)
      check(
        'CONTROL: alice (org-wide manager) reads expenses at all',
        (aliceRows.data ?? []).length > 0,
        aliceRows.error?.message ?? '',
      )
      check(
        'grace (Uptown-scoped manager) reads FEWER expenses than alice (org-wide)',
        (graceRows.data ?? []).length < (aliceRows.data ?? []).length,
        `${(graceRows.data ?? []).length} vs ${(aliceRows.data ?? []).length}`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\n[4] Review finding 1: the student surface shows ONE student\'s review comments')
// The surface used to declare cls_review_comments a standalone role table with
// `subjectColumn: null`, so a student's tab rendered EVERY student's peer-review
// comments. It is now an embed under cls_submissions, mirroring
// cls_comments_for_my_submission()'s join. This probe renders the fixed shape.
{
  const org = (await alice.from('orgs').select('id').eq('slug', 'demo-a').single()).data
  const charlieId = await userId(charlie)
  if (!org) {
    skip('review-comment hop filter', 'demo-a not seeded')
  } else {
    // CONTROL 1: comments exist, and they are CROSS-AUTHORED — comments sitting
    // on more than one student's submission. With comments on a single
    // submission a broken filter is indistinguishable from a working one.
    const every = await owner
      .from('cls_review_comments')
      .select('id, submission_id, submission:cls_submissions(student_id)')
      .eq('org_id', org.id)
    const rows = (every.data ?? []) as unknown as { id: string; submission: { student_id: string } | null }[]
    const students = new Set(rows.map((r) => r.submission?.student_id).filter(Boolean))
    check('CONTROL: the superadmin can read review comments at all', rows.length > 0, every.error?.message ?? '')
    check(
      'CONTROL: comments sit on MORE THAN ONE student\'s submission (the fixture that makes this falsifiable)',
      students.size > 1,
      `${students.size} distinct reviewees — with one, an unfiltered render looks identical to a filtered one`,
    )

    // The surface, rendered exactly as apps/web/lib/view-as.ts builds it for
    // mode 2: parent filtered on the subject column, comments embedded.
    const rendered = await owner
      .from('cls_submissions')
      .select('id, student_id, peer_review_comments:cls_review_comments(id, author_id, body)')
      .eq('org_id', org.id)
      .eq('student_id', charlieId)
    const subs = (rendered.data ?? []) as unknown as {
      student_id: string
      peer_review_comments: { id: string }[]
    }[]
    check('CONTROL: the rendered surface returns submissions for this student', subs.length > 0, rendered.error?.message ?? '')
    check(
      'CONTROL: at least one of them carries a peer-review comment',
      subs.some((s) => (s.peer_review_comments ?? []).length > 0),
      'no comment on this student\'s work — the negative below would be vacuous',
    )
    check('every rendered submission belongs to the subject', subs.every((s) => s.student_id === charlieId))

    const shown = new Set(subs.flatMap((s) => (s.peer_review_comments ?? []).map((c) => c.id)))
    const otherStudents = rows.filter((r) => r.submission && r.submission.student_id !== charlieId)
    check(
      'CONTROL: comments on OTHER students\' work exist',
      otherStudents.length > 0,
      'nothing to leak, so the assertion below proves nothing',
    )
    check(
      'NO comment on another student\'s submission is rendered',
      otherStudents.every((r) => !shown.has(r.id)),
      `${otherStudents.filter((r) => shown.has(r.id)).length} leaked`,
    )
  }
}

// ---------------------------------------------------------------------------
console.log('\n[5] Review finding 4: enablement is a ROUTING gate, never a reach gate')
{
  const org = (await alice.from('orgs').select('id').eq('slug', 'demo-salon').single()).data
  if (!org) {
    skip('disabled entitlement', 'demo-salon not seeded')
  } else {
    const ents = await owner.from('org_modules').select('module_key, enabled').eq('org_id', org.id)
    const disabled = (ents.data ?? []).filter((e) => e.enabled === false)
    check(
      'CONTROL: a DISABLED entitlement exists to test against',
      disabled.length > 0,
      'all seed entitlements are enabled — the badge path is unexercised',
    )
    check(
      'the disabled module still has an entitlement ROW, so the console still offers it',
      (ents.data ?? []).some((e) => e.module_key === 'visual-messaging'),
    )
    // The load-bearing half: disabling changed routing, not reach. If any policy
    // ever consults org_modules this flips, and the console's decision to render
    // a disabled module stops being free.
    const vm = await owner.from('vm_conversations').select('id').eq('org_id', org.id).limit(1)
    check(
      'the superadmin\'s read of the disabled module\'s tables still succeeds (no policy consults org_modules)',
      vm.error === null,
      vm.error?.message ?? '',
    )
  }
}

// ---------------------------------------------------------------------------
console.log('\n[6] The invariant that keeps the UI gate safe: no definer / service-role read path')
// A source scan, because this is the one property no runtime probe can catch
// after the fact — by the time an .rpc() call exists, the app-layer gate has
// silently become a security boundary (docs/03 #18, #19). Mirrored in
// packages/db/src/rls.test.ts, which CI actually runs.
{
  const files = [
    'apps/web/lib/console-view-as.ts',
    'apps/web/lib/view-as.ts',
    'apps/web/app/(app)/console/view-as/page.tsx',
    'apps/web/components/view-as/section-table.tsx',
    'apps/web/components/view-as/off-surface.tsx',
    'apps/web/components/view-as/page.tsx',
  ]
  for (const f of files) {
    let src: string
    try {
      src = readFileSync(resolve(root, f), 'utf8')
    } catch {
      skip(`source scan ${f}`, 'file not found')
      continue
    }
    // Strip comments so the rule's own explanation doesn't trip it.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    check(`${f} makes no .rpc() call`, !/\.rpc\s*\(/.test(code))
    check(`${f} never mentions a service-role key`, !/service_role|SERVICE_ROLE/.test(code))
  }

  // The console page's data source must stay the shared plumbing. A second
  // client built here would sidestep every property above.
  const page = readFileSync(resolve(root, 'apps/web/app/(app)/console/view-as/page.tsx'), 'utf8')
  check(
    'the console page creates no Supabase client of its own',
    !/createClient\s*\(/.test(page.replace(/^\s*\/\/.*$/gm, '')),
  )
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`)
if (skipped > 0) console.log('NOTE: a skipped probe asserts NOTHING — re-run against a fresh seed.')
process.exit(fail === 0 ? 0 : 1)
