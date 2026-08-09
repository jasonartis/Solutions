import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import {
  pairScore,
  type Answer as MmAnswer,
  type Question as MmQuestion,
} from '../../../modules/matchmaking/src/scoring'

// import.meta.dirname is undefined under tsx — derive it from the module URL.
const here = dirname(fileURLToPath(import.meta.url))

// Local-dev seed (docs/03: seed data is mandatory).
// Creates: a superadmin founder, two demo orgs with one user each, a
// dedicated Platform Self-Test org with the stub module enabled (the M0
// entitlement-chain proof — kept off Demo Org A so it stays clean for real
// walkthrough testing), and one demo org per real module.
//
// Idempotent: safe to re-run. Uses the service-role key — LOCAL/STAGING ONLY.

function loadRootEnv() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return
  try {
    const envFile = readFileSync(resolve(here, '../../../.env'), 'utf8')
    for (const line of envFile.split(/\r?\n/)) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
      if (match && match[1] && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2]!.replace(/^"|"$/g, '')
      }
    }
  } catch {
    // no .env file — rely on process env
  }
}

loadRootEnv()

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceKey) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set. Run `pnpm dev` once first.')
  process.exit(1)
}
if (!/localhost|127\.0\.0\.1/.test(url) && process.env.SEED_ALLOW_REMOTE !== 'yes') {
  console.error(`Refusing to seed non-local Supabase (${url}). Set SEED_ALLOW_REMOTE=yes to override.`)
  process.exit(1)
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

// Local default; PROD walkthrough seeding overrides via DEMO_PASSWORD.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'password123'

// module_roles gained a surrogate PK in 20260723010000, so upsert must name
// the scoped-identity conflict target explicitly (the old implicit target was
// the composite PK). Most seed grants are global (scope_ref null) and rely on
// NULLS-NOT-DISTINCT to stay idempotent across re-seeds; the SCOPED ones —
// classroom students at their class node, and the salon's Uptown manager — key
// on a real node id and are idempotent the ordinary way. Every seed
// module_roles upsert goes through this helper.
const upsertModuleRoles = (rows: object | object[]) =>
  admin.from('module_roles').upsert(rows, { onConflict: 'org_id,user_id,module_key,role,scope_ref' })

async function ensureUser(email: string, password: string, displayName: string) {
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: displayName },
  })
  if (created?.user) return created.user.id
  if (error && !/already/i.test(error.message)) throw error

  // Already exists — look up via profiles (service role bypasses RLS).
  const { data: profile } = await admin
    .from('profiles')
    .select('user_id')
    .eq('email', email)
    .single()
  if (!profile) throw new Error(`User ${email} exists but has no profile row`)
  return profile.user_id as string
}

async function ensureOrg(name: string, slug: string) {
  const { data } = await admin
    .from('orgs')
    .upsert({ name, slug }, { onConflict: 'slug' })
    .select('id')
    .single()
  if (!data) throw new Error(`Failed to upsert org ${slug}`)
  return data.id as string
}

async function main() {
  const founderId = await ensureUser('owner@demo.local', DEMO_PASSWORD, 'Founder')
  const aliceId = await ensureUser('alice@demo.local', DEMO_PASSWORD, 'Alice A')
  const bobId = await ensureUser('bob@demo.local', DEMO_PASSWORD, 'Bob B')

  // SAFEGUARD (docs/12): the demo owner is only a superadmin LOCALLY. On a
  // remote seed the real founder account is the only superadmin — a demo
  // password must never guard platform-wide power in production.
  if (/localhost|127.0.0.1/.test(String(url))) {
    await admin.from('profiles').update({ is_superadmin: true }).eq('user_id', founderId)
  } else {
    await admin.from('profiles').update({ is_superadmin: false }).eq('user_id', founderId)
  }

  const orgA = await ensureOrg('Demo Org A', 'demo-a')
  const orgB = await ensureOrg('Demo Org B', 'demo-b')

  await admin.from('org_members').upsert([
    { org_id: orgA, user_id: aliceId, role: 'owner' },
    { org_id: orgB, user_id: bobId, role: 'admin' },
  ])

  // The M0-era "Demo Module" (stub) used to be enabled on Demo Org A purely
  // to prove the entitlement chain works end-to-end (auth -> org membership
  // -> entitlement -> module page). Founder feedback (2026-07-11): it's
  // pure clutter on a founder-facing demo org now that six real modules
  // exist, and it has no walkthrough since it does nothing real. Moved to
  // its own dedicated org so Demo Org A stays clean for actual walkthrough
  // testing, without weakening the original M0 acceptance proof.
  const platformSelfTest = await ensureOrg('Platform Self-Test', 'platform-self-test')
  await admin.from('org_members').upsert({ org_id: platformSelfTest, user_id: aliceId, role: 'owner' })
  await admin.from('org_modules').upsert({ org_id: platformSelfTest, module_key: 'stub', enabled: true })
  await upsertModuleRoles({
    org_id: platformSelfTest,
    user_id: aliceId,
    module_key: 'stub',
    role: 'admin',
  })

  // A second, dedicated fixture user for org-self-management RLS/e2e
  // (2026-07-12) — kept separate from alice/bob/etc. so this feature's tests
  // can add/remove/promote/demote freely without colliding with any other
  // test's assumptions about who belongs to which org.
  const selfTestMemberId = await ensureUser('orgtest@demo.local', DEMO_PASSWORD, 'Org Test Member')
  await admin.from('org_members').upsert({ org_id: platformSelfTest, user_id: selfTestMemberId, role: 'member' })

  // --- Demo synagogue for module 3 -----------------------------------------
  const shul = await ensureOrg('Demo Synagogue', 'demo-shul')
  await admin.from('org_members').upsert({ org_id: shul, user_id: aliceId, role: 'owner' })
  await admin.from('org_modules').upsert({
    org_id: shul,
    module_key: 'synagogue-schedules',
    enabled: true,
    settings: {
      latitude: 40.7128,
      longitude: -74.006,
      timezone: 'America/New_York',
      israel: false,
      // Brooklyn 11210 — same location the founder's sheet pulls (US11210).
      myzmanimLocationId: 'US11210',
    },
  })
  await upsertModuleRoles({
    org_id: shul,
    user_id: aliceId,
    module_key: 'synagogue-schedules',
    role: 'maker',
  })

  // Idempotent demo config: wipe and reinsert (cascades to sections/lines).
  await admin.from('syn_schedule_types').delete().eq('org_id', shul)

  const { data: weekday } = await admin
    .from('syn_schedule_types')
    .insert({
      org_id: shul,
      name: 'Weekday Schedule',
      trigger_condition: { dayTypes: ['weekday'] },
      span: 'week',
      sort: 0,
    })
    .select('id')
    .single()
  const { data: shabbat } = await admin
    .from('syn_schedule_types')
    .insert({
      org_id: shul,
      name: 'Shabbat Schedule — {shabbatTitle}',
      trigger_condition: { dayTypes: ['shabbat', 'erev-shabbat'] },
      span: 'week',
      sort: 1,
    })
    .select('id')
    .single()

  const { data: wkSection } = await admin
    .from('syn_sections')
    .insert({ org_id: shul, schedule_type_id: weekday!.id, name: 'Tefillos', sort: 0 })
    .select('id')
    .single()
  const { data: wkNotices } = await admin
    .from('syn_sections')
    .insert({ org_id: shul, schedule_type_id: weekday!.id, name: 'Announcements', sort: 1 })
    .select('id')
    .single()
  const { data: shSection } = await admin
    .from('syn_sections')
    .insert({ org_id: shul, schedule_type_id: shabbat!.id, name: 'Shabbos', sort: 0 })
    .select('id')
    .single()

  await admin.from('syn_lines').insert([
    // The founder's three confirmed real rules:
    {
      org_id: shul,
      section_id: wkSection!.id,
      name: 'Shacharis',
      rule: { time: { kind: 'fixed', clock: '07:00' } },
      sort: 0,
    },
    {
      org_id: shul,
      section_id: wkSection!.id,
      name: 'Mincha',
      rule: { time: { kind: 'fixed', clock: '18:00' } },
      sort: 1,
    },
    {
      org_id: shul,
      section_id: wkSection!.id,
      name: 'Mincha (winter)',
      rule: {
        condition: { season: 'winter' },
        time: { kind: 'zman', zman: 'sunrise', offsetMinutes: 60 },
      },
      sort: 2,
    },
    {
      org_id: shul,
      section_id: wkSection!.id,
      name: 'Maariv',
      rule: { time: { kind: 'zman', zman: 'sunset', offsetMinutes: -15 } },
      sort: 3,
    },
    {
      org_id: shul,
      section_id: shSection!.id,
      name: 'Candle Lighting',
      rule: {
        condition: { dayTypes: ['erev-shabbat'] },
        time: { kind: 'zman', zman: 'sunset', offsetMinutes: -18 },
      },
      sort: 0,
    },
    {
      org_id: shul,
      section_id: shSection!.id,
      name: 'Mincha & Kabbolas Shabbos',
      rule: {
        condition: { dayTypes: ['erev-shabbat'] },
        time: {
          kind: 'zman',
          zman: 'sunset',
          offsetMinutes: -20,
          round: { direction: 'down', toMinutes: 5 },
        },
      },
      sort: 1,
    },
  ])

  // Default export profiles (docs/modules/module-3): same layout, different
  // render settings per destination.
  await admin.from('syn_export_profiles').delete().eq('org_id', shul)
  const { error: profilesError } = await admin.from('syn_export_profiles').insert([
    { org_id: shul, name: 'Print', format: 'pdf', margins_mm: 15, grayscale: true, sort: 0 },
    { org_id: shul, name: 'Lobby Screen', format: 'jpg', width_px: 1600, grayscale: false, sort: 1 },
    { org_id: shul, name: 'WhatsApp', format: 'jpg', width_px: 800, grayscale: false, sort: 2 },
  ])
  if (profilesError) throw new Error(`Export profiles seed failed: ${profilesError.message}`)

  // A weekly free-form override for the current week (Sunday start).
  const now = new Date()
  const sunday = new Date(now)
  sunday.setDate(now.getDate() - now.getDay())
  const weekStart = sunday.toISOString().slice(0, 10)
  await admin
    .from('syn_overrides')
    .delete()
    .eq('org_id', shul)
  await admin.from('syn_overrides').insert({
    org_id: shul,
    section_id: wkNotices!.id,
    week_start: weekStart,
    text: "This week's coffee sponsored by John Doe",
    sort: 0,
  })

  // Publish the current week so the public page (/s/demo-shul) shows it.
  await admin
    .from('syn_published_weeks')
    .upsert({ org_id: shul, week_start: weekStart, published: true })

  // --- Demo classroom for module 2 -----------------------------------------
  const charlieId = await ensureUser('charlie@demo.local', DEMO_PASSWORD, 'Charlie C')
  // GA for the classroom walkthrough (module role only — not a class member,
  // so roster counts stay stable for the e2e).
  const gabeId = await ensureUser('gabe@demo.local', DEMO_PASSWORD, 'Gabe G')
  const danaId = await ensureUser('dana@demo.local', DEMO_PASSWORD, 'Dana D')
  await admin
    .from('org_members')
    .upsert([
      { org_id: orgA, user_id: charlieId, role: 'member' },
      { org_id: orgA, user_id: danaId, role: 'member' },
      { org_id: orgA, user_id: gabeId, role: 'member' },
    ])
  await admin.from('org_modules').upsert({ org_id: orgA, module_key: 'classroom', enabled: true, settings: {} })
  // Slice 2b: professor + GA are GLOBAL grants (org-wide staff, cover every
  // course). Students are SCOPED grants at their class node — created below,
  // after the class (and its scope node) exist. A global 'student' grant is
  // meaningless in the scoped model (would read as enrolled in every class).
  await upsertModuleRoles([
    { org_id: orgA, user_id: aliceId, module_key: 'classroom', role: 'professor' },
    { org_id: orgA, user_id: gabeId, module_key: 'classroom', role: 'ga' },
  ])

  await admin.from('cls_courses').delete().eq('org_id', orgA)
  const { data: course, error: courseErr } = await admin
    .from('cls_courses')
    .insert({ org_id: orgA, name: 'Statistics 101', description: 'Intro statistics with R' })
    .select('id')
    .single()
  if (courseErr) throw new Error(`Course seed failed: ${courseErr.message}`)

  const { data: klass, error: classErr } = await admin
    .from('cls_classes')
    .insert({ org_id: orgA, course_id: course!.id, name: 'Statistics 101 — Fall', term: 'Fall 2026' })
    .select('id, scope_node_id')
    .single()
  if (classErr) throw new Error(`Class seed failed: ${classErr.message}`)

  // Scoped student enrollment (slice 2b): charlie + dana are students of THIS
  // class — a student grant pinned to the class's scope node. This is the
  // enrollment authority; the roster rows below are the name/badge store.
  await upsertModuleRoles([
    { org_id: orgA, user_id: charlieId, module_key: 'classroom', role: 'student', scope_ref: klass!.scope_node_id },
    { org_id: orgA, user_id: danaId, module_key: 'classroom', role: 'student', scope_ref: klass!.scope_node_id },
  ])

  const { error: memberErr } = await admin.from('cls_class_members').insert([
    { org_id: orgA, class_id: klass!.id, user_id: aliceId, role: 'professor' },
    { org_id: orgA, class_id: klass!.id, user_id: charlieId, role: 'student' },
    { org_id: orgA, class_id: klass!.id, user_id: danaId, role: 'student' },
  ])
  if (memberErr) throw new Error(`Class members seed failed: ${memberErr.message}`)

  const nextWeek = new Date()
  nextWeek.setDate(nextWeek.getDate() + 7)
  const { data: homework, error: hwErr } = await admin
    .from('cls_homeworks')
    .insert({
      org_id: orgA,
      class_id: klass!.id,
      title: 'Homework 1 — Descriptive statistics',
      due_at: nextWeek.toISOString(),
      sort: 0,
    })
    .select('id')
    .single()
  if (hwErr) throw new Error(`Homework seed failed: ${hwErr.message}`)

  // Both students already submitted, so grading/peer-review workflow e2e
  // coverage has real rows to move through the states without needing the
  // upload UI (that flow is covered separately by the submission-upload test).
  const { data: submissions, error: submissionErr } = await admin
    .from('cls_submissions')
    .insert([
      { org_id: orgA, class_id: klass!.id, homework_id: homework!.id, student_id: charlieId },
      { org_id: orgA, class_id: klass!.id, homework_id: homework!.id, student_id: danaId },
    ])
    .select('id, student_id')
  if (submissionErr) throw new Error(`Submission seed failed: ${submissionErr.message}`)
  const charlieSub = submissions!.find((s) => s.student_id === charlieId)!
  const danaSub = submissions!.find((s) => s.student_id === danaId)!

  // --- A SECOND, ALREADY-FINISHED HOMEWORK (2026-08-07) ---------------------
  // The peer-review fixtures live on their OWN homework, and that separation is
  // load-bearing rather than tidiness. They were first hung on Homework 1 — the
  // very homework the grading-workflow e2e drives from `submitted` all the way
  // to `done`. The collision did not fail that test, it made it VACUOUS: the
  // test clicks "Move GA-graded → peer review" and then asserts the roster shows
  // "Dana D: pending", which the SEEDED assignments already satisfied, so the
  // assertion passed whether or not the action worked. It surfaced two steps
  // later as a missing Finalize button, because the homework had never actually
  // left `ga_grading`. A fixture that makes another test's assertion true for
  // the wrong reason is the vacuity rule pointed at the seed (docs/03).
  //
  // So: Homework 0 is finished and carries every peer-review row; Homework 1
  // stays pristine for the workflow test to drive.
  const lastWeek = new Date()
  lastWeek.setDate(lastWeek.getDate() - 7)
  const { data: hw0, error: hw0Err } = await admin
    .from('cls_homeworks')
    .insert({
      org_id: orgA,
      class_id: klass!.id,
      title: 'Homework 0 — Warm-up (graded)',
      due_at: lastWeek.toISOString(),
      sort: -1,
    })
    .select('id')
    .single()
  if (hw0Err) throw new Error(`Homework 0 seed failed: ${hw0Err.message}`)

  const { data: subs0, error: subs0Err } = await admin
    .from('cls_submissions')
    .insert([
      { org_id: orgA, class_id: klass!.id, homework_id: hw0!.id, student_id: charlieId },
      { org_id: orgA, class_id: klass!.id, homework_id: hw0!.id, student_id: danaId },
    ])
    .select('id, student_id')
  if (subs0Err) throw new Error(`Homework 0 submission seed failed: ${subs0Err.message}`)
  const charlieSub0 = subs0!.find((s) => s.student_id === charlieId)!
  const danaSub0 = subs0!.find((s) => s.student_id === danaId)!

  // --- Peer review with REAL rows, added 2026-08-06 -------------------------
  // cls_review_assignments, cls_review_comments and cls_grades were all ZERO-row
  // on a clean seed, which made the student and GA view-as surfaces render
  // largely blank — indistinguishable from the surface being broken, and
  // unfalsifiable either way (the vacuity rule, docs\03 Test discipline).
  //
  // CROSS-AUTHORED ON PURPOSE: charlie reviews dana's submission and dana
  // reviews charlie's. That is what makes the peer-review comment leak
  // detectable at all — with comments on only ONE submission, a surface that
  // forgets to filter by submission owner looks identical to one that filters
  // correctly. Rendering charlie's student surface must show the comment on
  // CHARLIE's submission and never the one on dana's.
  const { error: reviewErr } = await admin.from('cls_review_assignments').insert([
    { org_id: orgA, class_id: klass!.id, homework_id: hw0!.id, reviewer_id: charlieId, submission_id: danaSub0.id },
    { org_id: orgA, class_id: klass!.id, homework_id: hw0!.id, reviewer_id: danaId, submission_id: charlieSub0.id },
  ])
  if (reviewErr) throw new Error(`Review assignment seed failed: ${reviewErr.message}`)

  const { error: commentErr } = await admin.from('cls_review_comments').insert([
    {
      org_id: orgA,
      class_id: klass!.id,
      submission_id: charlieSub0.id,
      author_id: danaId,
      file_path: 'analysis.R',
      line_start: 12,
      body: 'Your median is computed before the NA filter — the two disagree.',
    },
    {
      org_id: orgA,
      class_id: klass!.id,
      submission_id: danaSub0.id,
      author_id: charlieId,
      file_path: 'report.Rmd',
      line_start: 4,
      body: 'Nice summary table, but the units are missing on the y-axis.',
    },
  ])
  if (commentErr) throw new Error(`Review comment seed failed: ${commentErr.message}`)

  // A peer grade and an instructor grade on the SAME homework, because the
  // 2026-08-02 founder decision splits them: a student sees the COMMENTS on
  // their own work but never the peer GRADES. One row of each is what makes
  // that distinction testable rather than asserted.
  const { error: gradeErr } = await admin.from('cls_grades').insert([
    { org_id: orgA, class_id: klass!.id, homework_id: hw0!.id, student_id: charlieId, source: 'peer', score: 82, graded_by: danaId, is_final: false, visible: false },
    { org_id: orgA, class_id: klass!.id, homework_id: hw0!.id, student_id: charlieId, source: 'instructor', score: 88, graded_by: aliceId, is_final: true, visible: true },
  ])
  if (gradeErr) throw new Error(`Grade seed failed: ${gradeErr.message}`)

  const { error: annErr } = await admin.from('cls_announcements').insert({
    org_id: orgA,
    class_id: klass!.id,
    author_id: aliceId,
    body: 'Welcome to Statistics 101! First lecture posted under Materials.',
  })
  if (annErr) throw new Error(`Announcement seed failed: ${annErr.message}`)

  const { data: material, error: materialErr } = await admin
    .from('cls_materials')
    .insert({
      org_id: orgA,
      course_id: course!.id,
      kind: 'document',
      title: 'Syllabus',
      url: 'https://example.com/syllabus.pdf',
    })
    .select('id')
    .single()
  if (materialErr) throw new Error(`Material seed failed: ${materialErr.message}`)

  const { error: pubErr } = await admin.from('cls_publications').insert({
    org_id: orgA,
    class_id: klass!.id,
    material_id: material!.id,
    visible_from: null,
    visible_until: null,
  })
  if (pubErr) throw new Error(`Publication seed failed: ${pubErr.message}`)

  const { data: survey, error: surveyErr } = await admin
    .from('cls_surveys')
    .insert({
      org_id: orgA,
      class_id: klass!.id,
      question: 'Which lab time do you prefer?',
      results_visible: false,
    })
    .select('id')
    .single()
  if (surveyErr) throw new Error(`Survey seed failed: ${surveyErr.message}`)

  // A SECOND survey, already answered, for the same reason Homework 0 exists
  // (2026-08-07). `cls_survey_answers` was zero-row before 2026-08-06, so the
  // survey surface's whole point — a student sees their own answer and not their
  // classmate's until the professor publishes — was unobservable. The answers
  // were first seeded onto the survey ABOVE, which is the one the e2e has a
  // student answer for the first time: charlie arrived already answered, so the
  // form offered "Update" where the test clicked "Submit". Same vacuity-in-the-
  // seed shape as Homework 0 — a fixture must not pre-satisfy another test's
  // starting condition. The survey above stays UNANSWERED; this one carries the
  // rows.
  const { data: answeredSurvey, error: survey2Err } = await admin
    .from('cls_surveys')
    .insert({
      org_id: orgA,
      class_id: klass!.id,
      question: 'How was the warm-up homework?',
      results_visible: false,
    })
    .select('id')
    .single()
  if (survey2Err) throw new Error(`Second survey seed failed: ${survey2Err.message}`)

  const { error: answerErr } = await admin.from('cls_survey_answers').insert([
    { org_id: orgA, class_id: klass!.id, survey_id: answeredSurvey!.id, user_id: charlieId, answer: 'Tuesday 14:00' },
    { org_id: orgA, class_id: klass!.id, survey_id: answeredSurvey!.id, user_id: danaId, answer: 'Thursday 10:00' },
  ])
  if (answerErr) throw new Error(`Survey answer seed failed: ${answerErr.message}`)

  // --- A seeded exam + scan, added 2026-08-09 --------------------------------
  // cls_exam_papers was ZERO-row on a clean seed, so the student/GA exam-scans
  // surface (view-as's "Their exam scans" embed and the data browser's "Exam
  // scans" row — packages/platform/src/view-as-modules.ts /
  // data-browser-modules.ts) rendered empty on every surface. Empty is
  // indistinguishable from broken (the vacuity rule, docs/03): the keystone
  // test only asserts the read doesn't error, never that a real row shows up.
  //
  // NAMED AND SCOPED TO AVOID THE EXAM E2E'S OWN FIXTURE (2026-08-07 lesson —
  // a seed must not pre-satisfy another test's starting condition). The e2e
  // "professor creates an exam" test creates its OWN exam titled "Midterm" in
  // this same class (Statistics 101 — Fall) and asserts a page-level link by
  // that exact name, so this fixture uses a different title ("Quiz 1 — Warm-
  // up") to stay unambiguous. It grades no one and publishes no final, so it
  // cannot pre-satisfy that test's grading/publish assertions either.
  const { data: quiz, error: quizErr } = await admin
    .from('cls_exams')
    .insert({
      org_id: orgA,
      class_id: klass!.id,
      title: 'Quiz 1 — Warm-up',
      structure: [{ label: '1', points: 10 }],
    })
    .select('id')
    .single()
  if (quizErr) throw new Error(`Exam seed failed: ${quizErr.message}`)

  // org_id/class_id are re-derived from exam_id by the cls_exam_papers_scope
  // trigger regardless of what's passed here; no storage object actually
  // exists at this path (the grading page's createSignedUrl call degrades to
  // "no link shown" for a missing object, it does not error).
  const { error: paperErr } = await admin.from('cls_exam_papers').insert({
    org_id: orgA,
    class_id: klass!.id,
    exam_id: quiz!.id,
    student_id: charlieId,
    storage_path: `${orgA}/${klass!.id}/${quiz!.id}/charlie-quiz1.pdf`,
  })
  if (paperErr) throw new Error(`Exam paper seed failed: ${paperErr.message}`)

  // --- Demo matchmaking for module 1 ---------------------------------------
  // A separate org so the matchmaking role vocabulary (single/matchmaker/admin)
  // doesn't collide with orgA's classroom roles. alice administers; four
  // singles with contrasting answers produce a clear match ranking; one
  // matchmaker is assigned to two of them. Pair scores are precomputed here
  // with the real scoring engine (no worker runs during seed).
  const match = await ensureOrg('Demo Match', 'demo-match')
  const eveId = await ensureUser('eve@demo.local', DEMO_PASSWORD, 'Eve E')
  const frankId = await ensureUser('frank@demo.local', DEMO_PASSWORD, 'Frank F')
  const melId = await ensureUser('mel@demo.local', DEMO_PASSWORD, 'Mel M')

  await admin.from('org_members').upsert([
    { org_id: match, user_id: aliceId, role: 'owner' },
    { org_id: match, user_id: charlieId, role: 'member' },
    { org_id: match, user_id: danaId, role: 'member' },
    { org_id: match, user_id: eveId, role: 'member' },
    { org_id: match, user_id: frankId, role: 'member' },
    { org_id: match, user_id: melId, role: 'member' },
  ])
  await admin.from('org_modules').upsert({
    org_id: match,
    module_key: 'matchmaking',
    enabled: true,
    settings: { topX: 5 },
  })
  await upsertModuleRoles([
    { org_id: match, user_id: aliceId, module_key: 'matchmaking', role: 'admin' },
    { org_id: match, user_id: charlieId, module_key: 'matchmaking', role: 'single' },
    { org_id: match, user_id: danaId, module_key: 'matchmaking', role: 'single' },
    { org_id: match, user_id: eveId, module_key: 'matchmaking', role: 'single' },
    { org_id: match, user_id: frankId, module_key: 'matchmaking', role: 'single' },
    { org_id: match, user_id: melId, module_key: 'matchmaking', role: 'matchmaker' },
  ])

  // Idempotent: wipe module data for this org and rebuild.
  await admin.from('mm_interests').delete().eq('org_id', match)
  await admin.from('mm_pair_scores').delete().eq('org_id', match)
  await admin.from('mm_answers').delete().eq('org_id', match)
  await admin.from('mm_questions').delete().eq('org_id', match)

  // Gender question is a hard filter: admin-locked care −10 (want opposite) +
  // dealbreaker, so only male↔female pairs survive. Exercise/kids are open.
  const questionSpecs = [
    { text: 'I am', labels: ['Male', 'Female'], locks: { care: -10, dealbreaker: true } },
    { text: 'I exercise', labels: ['Never', 'Sometimes', 'Often', 'Daily'], locks: {} },
    { text: 'I want children', labels: ['No', 'Maybe', 'Yes'], locks: {} },
  ]
  const questionIds: string[] = []
  for (const spec of questionSpecs) {
    const { data: q, error: qErr } = await admin
      .from('mm_questions')
      .insert({
        org_id: match,
        text: spec.text,
        scale_labels: spec.labels,
        admin_locks: spec.locks,
        status: 'approved',
        submitted_by: aliceId,
        approved_by: aliceId,
        approved_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (qErr) throw new Error(`Matchmaking question seed failed: ${qErr.message}`)
    questionIds.push(q!.id)
  }
  const [genderQ, exerciseQ, kidsQ] = questionIds as [string, string, string]

  // [gender, exercise(care), kids(care)] per single. Positions are 0-indexed
  // into the label arrays above. The gender lock forces care/dealbreaker, so
  // only position matters there.
  const singleAnswers: Record<string, { gender: number; exercise: [number, number]; kids: [number, number] }> = {
    [charlieId]: { gender: 0, exercise: [3, 8], kids: [2, 9] }, // Male, Daily, wants kids
    [danaId]: { gender: 1, exercise: [2, 6], kids: [2, 10] }, // Female, Often, wants kids
    [eveId]: { gender: 1, exercise: [0, 3], kids: [0, 8] }, // Female, Never, no kids
    [frankId]: { gender: 0, exercise: [3, 5], kids: [1, 4] }, // Male, Daily, maybe kids
  }
  for (const [userId, a] of Object.entries(singleAnswers)) {
    const rows = [
      { org_id: match, question_id: genderQ, user_id: userId, position: a.gender, care: 0, auto: false },
      { org_id: match, question_id: exerciseQ, user_id: userId, position: a.exercise[0], care: a.exercise[1], auto: false },
      { org_id: match, question_id: kidsQ, user_id: userId, position: a.kids[0], care: a.kids[1], auto: false },
    ]
    const { error: aErr } = await admin.from('mm_answers').insert(rows)
    if (aErr) throw new Error(`Matchmaking answer seed failed: ${aErr.message}`)
  }

  // Matchmaker Mel serves Charlie and Dana individually.
  await admin.from('mm_matchmaker_assignments').insert([
    { org_id: match, matchmaker_id: melId, target_type: 'individual', target_user_id: charlieId },
    { org_id: match, matchmaker_id: melId, target_type: 'individual', target_user_id: danaId },
  ])

  // Precompute pair scores with the real engine (the worker would normally do
  // this; none runs during seed). Read back the materialized answers so locked
  // fields (gender care/dealbreaker) reflect what the trigger actually wrote.
  await seedMatchmakingScores(match, questionIds)

  // Demo interest: Charlie↔Dana are MUTUAL (each sees "It's a match!" with the
  // other's contact; Mel sees the pair to facilitate). Eve→Charlie is
  // one-sided — Charlie sees nothing about it, the privacy invariant.
  await admin.from('mm_interests').insert([
    { org_id: match, user_id: charlieId, target_user_id: danaId },
    { org_id: match, user_id: danaId, target_user_id: charlieId },
    { org_id: match, user_id: eveId, target_user_id: charlieId },
  ])

  // --- Demo nail salon for module 5 ----------------------------------------
  // alice = manager (ORG-WIDE), frank = admin, eve = cashier, dana = worker,
  // charlie = customer, grace = manager SCOPED TO UPTOWN.
  // TWO locations (Downtown + Uptown). Downtown carries the full demo — services,
  // a worker profile, a customer, a booked appointment for today, and the paid
  // back-office visit. Uptown is deliberately SPARSE: see its block below.
  const salon = await ensureOrg('Demo Salon', 'demo-salon')
  const graceId = await ensureUser('grace@demo.local', DEMO_PASSWORD, 'Grace G')
  await admin.from('org_members').upsert([
    { org_id: salon, user_id: aliceId, role: 'owner' },
    { org_id: salon, user_id: frankId, role: 'member' },
    { org_id: salon, user_id: eveId, role: 'member' },
    { org_id: salon, user_id: danaId, role: 'member' },
    { org_id: salon, user_id: charlieId, role: 'member' },
    { org_id: salon, user_id: graceId, role: 'member' },
  ])
  await admin.from('org_modules').upsert({ org_id: salon, module_key: 'nail-salon', enabled: true })
  // A DISABLED entitlement, on purpose (2026-08-06). `enabled` has exactly one
  // app write path (superadmin `toggleModule`) and NO RLS policy anywhere reads
  // it — it is a routing gate, not a data gate — so before this row every seed
  // module was enabled and nothing exercised the disabled path at all. The Owner
  // Console deliberately RENDERS disabled modules (badged), because disabling is
  // step ONE of docs\03's deprecation sequence and the moment you most need to
  // see what a position could read is when deciding what to export before
  // deleting. This row is what makes that badge testable.
  await admin.from('org_modules').upsert({ org_id: salon, module_key: 'visual-messaging', enabled: false })
  // FRANK IS THE SALON ADMIN, and it has to be someone OTHER than alice
  // (added 2026-08-04, founder-approved). The nail-salon view-as review gave
  // admin an edge into `manager`, so the Manager tab only exists for a caller
  // holding `admin` — and alice holds `manager`, whose own tabs are Cashier and
  // Worker. Granting alice both would have made her Manager tab appear and
  // silently inverted the e2e assertion that it does NOT (a manager cannot view
  // as a manager: equal rank, no pair). Frank also keeps the ladder honest: he
  // is a plain org MEMBER, so his reads go through the module grant rather than
  // short-circuiting on is_org_admin() the way the owner's do.
  await upsertModuleRoles([
    { org_id: salon, user_id: aliceId, module_key: 'nail-salon', role: 'manager' },
    { org_id: salon, user_id: frankId, module_key: 'nail-salon', role: 'admin' },
    { org_id: salon, user_id: eveId, module_key: 'nail-salon', role: 'cashier' },
    { org_id: salon, user_id: danaId, module_key: 'nail-salon', role: 'worker' },
    { org_id: salon, user_id: charlieId, module_key: 'nail-salon', role: 'customer' },
  ])

  // Idempotent rebuild (locations cascade to services/appointments/etc).
  await admin.from('sal_locations').delete().eq('org_id', salon)
  const { data: loc, error: locErr } = await admin
    .from('sal_locations')
    .insert({ org_id: salon, name: 'Downtown', timezone: 'America/New_York' })
    .select('id')
    .single()
  if (locErr) throw new Error(`Salon location seed failed: ${locErr.message}`)

  // --- Uptown: the SECOND location, added 2026-08-06 ------------------------
  // Until this existed the salon had exactly ONE scope node, which made the
  // whole scope-narrowing axis untestable: "all locations" and "this one
  // location" rendered identically, so a test asserting either passed while
  // proving nothing (the vacuity rule, docs\03 Test discipline). It is the
  // headline case for the Owner Console's third view-as mode — "the Uptown
  // manager's back office" — which is exactly the view that was impossible
  // before that mode existed (docs\15, 2026-08-04).
  //
  // Uptown is deliberately SPARSE and shares NO rows with Downtown. It gets only
  // the four tables no e2e flow walks (service / promotion / expense / shopping
  // list) and deliberately NO appointment, bill, worker profile or customer —
  // the day-board, booking-enforcement and booked-to-paid lifecycle tests all
  // assume exactly one of each, and giving Uptown its own would break them for
  // reasons having nothing to do with what this fixture is for. Sparse is also
  // the point: Downtown-vs-Uptown row counts DIFFER, so a scope filter that
  // silently does nothing now shows up as a wrong number rather than an
  // identical one.
  const { data: uptown, error: upErr } = await admin
    .from('sal_locations')
    .insert({ org_id: salon, name: 'Uptown', timezone: 'America/New_York' })
    .select('id, scope_node_id')
    .single()
  if (upErr) throw new Error(`Salon Uptown location seed failed: ${upErr.message}`)

  // GRACE IS SCOPED, and that is the entire reason she exists rather than
  // reusing alice. alice is an ORG-WIDE manager, so rendering her surface can
  // never demonstrate scope narrowing — she covers every location by
  // construction. Grace holds the same POSITION at one node, so "same position,
  // different reach" becomes observable. Her grant has to live here rather than
  // with the other salon grants above because it needs Uptown's scope node,
  // which the sal_locations_node trigger only mints on insert.
  await upsertModuleRoles([
    { org_id: salon, user_id: graceId, module_key: 'nail-salon', role: 'manager', scope_ref: uptown!.scope_node_id },
  ])

  const { error: upSvcErr } = await admin
    .from('sal_services')
    .insert({ org_id: salon, location_id: uptown!.id, name: 'Gel Manicure', price: 55, approx_duration_minutes: 45, sort: 0 })
  if (upSvcErr) throw new Error(`Salon Uptown service seed failed: ${upSvcErr.message}`)

  const { error: upPromoErr } = await admin.from('sal_promotions').insert({
    org_id: salon,
    location_id: uptown!.id,
    name: 'Uptown opening — 10% off',
    kind: 'visit_count',
    threshold: 1,
    discount_type: 'percent',
    discount_value: 10,
  })
  if (upPromoErr) throw new Error(`Salon Uptown promotion seed failed: ${upPromoErr.message}`)

  const { error: upExpErr } = await admin.from('sal_expenses').insert({
    org_id: salon,
    location_id: uptown!.id,
    category: 'rent',
    description: 'Uptown deposit',
    amount: 900,
  })
  if (upExpErr) throw new Error(`Salon Uptown expense seed failed: ${upExpErr.message}`)

  const { error: upShopErr } = await admin.from('sal_shopping_list').insert({
    org_id: salon,
    location_id: uptown!.id,
    item: 'Gel lamps',
    quantity: 3,
    estimated_cost: 120,
  })
  if (upShopErr) throw new Error(`Salon Uptown shopping-list seed failed: ${upShopErr.message}`)

  const { data: svcRows, error: svcErr } = await admin
    .from('sal_services')
    .insert([
      { org_id: salon, location_id: loc!.id, name: 'Manicure', price: 40, approx_duration_minutes: 30, sort: 0 },
      { org_id: salon, location_id: loc!.id, name: 'Pedicure', price: 60, approx_duration_minutes: 45, sort: 1 },
    ])
    .select('id, name')
  if (svcErr) throw new Error(`Salon service seed failed: ${svcErr.message}`)
  const manicure = svcRows!.find((s) => s.name === 'Manicure')!

  const { error: wpErr } = await admin
    .from('sal_worker_profiles')
    .insert({ org_id: salon, location_id: loc!.id, user_id: danaId, display_name: 'Dana D' })
  if (wpErr) throw new Error(`Salon worker profile seed failed: ${wpErr.message}`)

  const { data: cust, error: custErr } = await admin
    .from('sal_customers')
    .insert({ org_id: salon, location_id: loc!.id, user_id: charlieId, full_name: 'Charlie C', phone: '555-0101' })
    .select('id')
    .single()
  if (custErr) throw new Error(`Salon customer seed failed: ${custErr.message}`)

  // A booked appointment at noon today (drives the day board on first load).
  const today = new Date()
  const apptStart = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0, 0)
  const apptEnd = new Date(apptStart.getTime() + 30 * 60000)
  const { error: apptErr } = await admin.from('sal_appointments').insert({
    org_id: salon,
    location_id: loc!.id,
    customer_id: cust!.id,
    service_id: manicure.id,
    worker_id: danaId,
    scheduled_start: apptStart.toISOString(),
    scheduled_end: apptEnd.toISOString(),
    state: 'booked',
  })
  if (apptErr) throw new Error(`Salon appointment seed failed: ${apptErr.message}`)

  // Worker availability demo (2026-07-16): dana's weekly_schedule stays
  // unrestricted ({} — the seed doesn't know what weekday it's running on,
  // and an unset schedule means "no restriction" by design) but she has one
  // real, absolute time-off block 3 days out so the e2e booking-enforcement
  // test has something concrete to hit.
  const { data: danaProfile } = await admin
    .from('sal_worker_profiles')
    .select('id')
    .eq('location_id', loc!.id)
    .eq('user_id', danaId)
    .single()
  await admin.from('sal_worker_time_off').delete().eq('worker_profile_id', danaProfile!.id)
  const timeOffDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 3)
  const timeOffStart = new Date(timeOffDay.getFullYear(), timeOffDay.getMonth(), timeOffDay.getDate(), 9, 0, 0)
  const timeOffEnd = new Date(timeOffDay.getFullYear(), timeOffDay.getMonth(), timeOffDay.getDate(), 17, 0, 0)
  const { error: timeOffErr } = await admin.from('sal_worker_time_off').insert({
    org_id: salon,
    location_id: loc!.id,
    worker_profile_id: danaProfile!.id,
    starts_at: timeOffStart.toISOString(),
    ends_at: timeOffEnd.toISOString(),
    reason: 'Vacation',
  })
  if (timeOffErr) throw new Error(`Salon worker time-off seed failed: ${timeOffErr.message}`)

  // --- Back office: one finished, paid visit + the bookkeeping rows ---------
  // Added 2026-08-04 (founder-approved) because the view-as surface review
  // exposed a demo gap, not a code gap: a clean seed had ZERO rows in
  // sal_bills / sal_bill_items / sal_earnings_ledger / sal_promotions /
  // sal_expenses / sal_shopping_list, so 6 of the Manager tab's 11 sections read
  // "Nothing here." and an operator could not tell a correct empty section from
  // a broken one. Six tables' worth of "cannot read" assertions in the RLS suite
  // also had to build their own fixtures for the same reason.
  //
  // DATED YESTERDAY on purpose: the day board queries TODAY only, so this visit
  // never appears there and the "booked → paid" lifecycle e2e still finds
  // exactly the one booked appointment it walks.
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 10, 0, 0)
  const { data: pastAppt, error: pastApptErr } = await admin
    .from('sal_appointments')
    .insert({
      org_id: salon,
      location_id: loc!.id,
      customer_id: cust!.id,
      service_id: manicure.id,
      worker_id: danaId,
      scheduled_start: yesterday.toISOString(),
      scheduled_end: new Date(yesterday.getTime() + 30 * 60000).toISOString(),
      state: 'paid',
    })
    .select('id')
    .single()
  if (pastApptErr) throw new Error(`Salon past appointment seed failed: ${pastApptErr.message}`)

  // Inserted OPEN then UPDATED to paid, deliberately: sal_feed_earnings is an
  // AFTER UPDATE trigger keyed on the state transition, so a bill inserted
  // directly as 'paid' would leave the earnings ledger empty — which is the very
  // section this seed exists to fill.
  const { data: bill, error: billErr } = await admin
    .from('sal_bills')
    .insert({ org_id: salon, location_id: loc!.id, appointment_id: pastAppt!.id, subtotal: 40, total: 40 })
    .select('id')
    .single()
  if (billErr) throw new Error(`Salon bill seed failed: ${billErr.message}`)
  const { error: itemErr } = await admin.from('sal_bill_items').insert({
    org_id: salon,
    location_id: loc!.id,
    bill_id: bill!.id,
    service_id: manicure.id,
    description: 'Manicure',
    quantity: 1,
    unit_price: 40,
    line_total: 40,
  })
  if (itemErr) throw new Error(`Salon bill item seed failed: ${itemErr.message}`)
  const { error: paidErr } = await admin
    .from('sal_bills')
    .update({ state: 'paid', payment_method: 'card' })
    .eq('id', bill!.id)
  if (paidErr) throw new Error(`Salon bill payment seed failed: ${paidErr.message}`)

  const { error: promoErr } = await admin.from('sal_promotions').insert({
    org_id: salon,
    location_id: loc!.id,
    name: 'Every 5th visit — 15% off',
    kind: 'visit_count',
    threshold: 5,
    discount_type: 'percent',
    discount_value: 15,
  })
  if (promoErr) throw new Error(`Salon promotion seed failed: ${promoErr.message}`)

  const { error: expErr } = await admin.from('sal_expenses').insert({
    org_id: salon,
    location_id: loc!.id,
    category: 'supplies',
    description: 'Nail files (bulk)',
    amount: 18.5,
  })
  if (expErr) throw new Error(`Salon expense seed failed: ${expErr.message}`)

  const { error: shopErr } = await admin.from('sal_shopping_list').insert({
    org_id: salon,
    location_id: loc!.id,
    item: 'Cotton pads',
    quantity: 2,
    estimated_cost: 6,
  })
  if (shopErr) throw new Error(`Salon shopping-list seed failed: ${shopErr.message}`)

  // --- Demo speed dating for module 6 --------------------------------------
  // alice organizes; charlie/dana/eve/frank are participants. One event with
  // registration open so the e2e flow (register → rounds → interest → reveal)
  // starts from a clean, meaningful state.
  const dating = await ensureOrg('Demo Dating', 'demo-dating')
  await admin.from('org_members').upsert([
    { org_id: dating, user_id: aliceId, role: 'owner' },
    { org_id: dating, user_id: charlieId, role: 'member' },
    { org_id: dating, user_id: danaId, role: 'member' },
    { org_id: dating, user_id: eveId, role: 'member' },
    { org_id: dating, user_id: frankId, role: 'member' },
  ])
  await admin.from('org_modules').upsert({ org_id: dating, module_key: 'speed-dating', enabled: true })
  await upsertModuleRoles([
    { org_id: dating, user_id: aliceId, module_key: 'speed-dating', role: 'organizer' },
    { org_id: dating, user_id: charlieId, module_key: 'speed-dating', role: 'participant' },
    { org_id: dating, user_id: danaId, module_key: 'speed-dating', role: 'participant' },
    { org_id: dating, user_id: eveId, module_key: 'speed-dating', role: 'participant' },
    { org_id: dating, user_id: frankId, module_key: 'speed-dating', role: 'participant' },
  ])

  await admin.from('sd_events').delete().eq('org_id', dating)
  const nextFriday = new Date()
  nextFriday.setDate(nextFriday.getDate() + ((5 - nextFriday.getDay() + 7) % 7 || 7))
  nextFriday.setHours(19, 0, 0, 0)
  const { error: eventErr } = await admin.from('sd_events').insert({
    org_id: dating,
    name: 'Friday Night Mixer',
    scheduled_at: nextFriday.toISOString(),
    state: 'open',
    created_by: aliceId,
  })
  if (eventErr) throw new Error(`Speed-dating event seed failed: ${eventErr.message}`)

  // --- Sample module (module 0 — the living template) -----------------------
  // Enabled for orgA so the template's e2e can prove the copy-me path works:
  // alice manages, charlie is a member, one seeded project.
  await admin.from('org_modules').upsert({ org_id: orgA, module_key: 'sample', enabled: true })
  await upsertModuleRoles([
    { org_id: orgA, user_id: aliceId, module_key: 'sample', role: 'manager' },
    { org_id: orgA, user_id: charlieId, module_key: 'sample', role: 'member' },
  ])
  await admin.from('smp_projects').delete().eq('org_id', orgA)
  const { error: smpErr } = await admin
    .from('smp_projects')
    .insert({ org_id: orgA, name: 'Template Project' })
  if (smpErr) throw new Error(`Sample project seed failed: ${smpErr.message}`)

  // --- Demo visual messaging for module 4 ----------------------------------
  // alice admin; charlie + dana members. Conversations are created through
  // the UI (the e2e uploads a real image), so no content is seeded.
  const visual = await ensureOrg('Demo Visual', 'demo-visual')
  await admin.from('org_members').upsert([
    { org_id: visual, user_id: aliceId, role: 'owner' },
    { org_id: visual, user_id: charlieId, role: 'member' },
    { org_id: visual, user_id: danaId, role: 'member' },
  ])
  await admin.from('org_modules').upsert({ org_id: visual, module_key: 'visual-messaging', enabled: true })
  await upsertModuleRoles([
    { org_id: visual, user_id: aliceId, module_key: 'visual-messaging', role: 'admin' },
    { org_id: visual, user_id: charlieId, module_key: 'visual-messaging', role: 'member' },
    { org_id: visual, user_id: danaId, module_key: 'visual-messaging', role: 'member' },
  ])
  await admin.from('vm_conversations').delete().eq('org_id', visual)

  // Slice 3 (20260727010000): org membership is invite-accept, so a fresh
  // org_members row defaults to status='pending'. Everyone seeded above is a
  // real, accepted member (the demo must work without an accept step), so flip
  // them all to 'active' in one pass here — this covers every insert above and
  // any added later, and runs as service-role so the hierarchy/last-admin
  // guards are bypassed. (Invite-accept itself is exercised by the RLS suite,
  // not the seed.)
  //
  // SCOPED TO THE DEMO ORGS, not global — docs/12 guard 5 claims "the seed's
  // deletes are keyed to the demo orgs' ids; it cannot touch a real client
  // org's rows", and an unscoped update here would have silently force-accepted
  // ANY pending invite in ANY org (a real client's included) on every remote
  // reseed. Found harmless only by luck on the 2026-08-07 prod reseed — every
  // row on prod already happened to be 'active' — but the gap was real. The
  // demo orgs' own ids are all in scope by this point in the function.
  const demoOrgIds = [orgA, orgB, platformSelfTest, shul, match, salon, dating, visual]
  await admin
    .from('org_members')
    .update({ status: 'active', accepted_at: new Date().toISOString() })
    .neq('status', 'active')
    .in('org_id', demoOrgIds)

  console.log('Seed complete:')
  console.log('  owner@demo.local / <demo password>  (superadmin)')
  console.log('  alice@demo.local / <demo password>  (admin of Demo Org A + Demo Synagogue + Demo Match + Demo Salon + Demo Visual + Demo Dating + Platform Self-Test)')
  console.log('  bob@demo.local   / <demo password>  (admin of Demo Org B, no modules)')
  console.log('  Platform Self-Test (platform-self-test): stub module only — the M0 entitlement-chain proof, not a real walkthrough')
  console.log('  Demo Synagogue (demo-shul): synagogue-schedules enabled, alice is maker')
  console.log('  Demo Match (demo-match): matchmaking enabled — singles charlie/dana/eve/frank, matchmaker mel')
  console.log(
    '  Demo Salon (demo-salon): nail-salon — admin frank, manager alice, cashier eve, worker dana, customer charlie',
  )
  console.log('  Demo Visual (demo-visual): visual-messaging — admin alice, members charlie/dana')
  console.log('  Demo Dating (demo-dating): speed-dating — organizer alice, participants charlie/dana/eve/frank')
}

// Recompute-and-persist all pair scores for a matchmaking org, mirroring what
// the matchmaking.rescore worker will eventually do. Shared shape with the
// in-app recompute server action; kept here so the demo has matches on seed.
async function seedMatchmakingScores(orgId: string, questionIds: string[]) {
  const { data: qRows } = await admin
    .from('mm_questions')
    .select('id, text, scale_labels, admin_locks')
    .in('id', questionIds)
  const questions = new Map<string, MmQuestion>()
  for (const q of qRows ?? []) {
    questions.set(q.id, {
      id: q.id,
      text: q.text,
      scaleLabels: q.scale_labels,
      adminLocks: q.admin_locks ?? {},
    })
  }

  const { data: aRows } = await admin
    .from('mm_answers')
    .select('user_id, question_id, position, care, dealbreaker, auto, share_with_match')
    .eq('org_id', orgId)
  const byUser = new Map<string, MmAnswer[]>()
  for (const r of aRows ?? []) {
    const list = byUser.get(r.user_id) ?? []
    list.push({
      questionId: r.question_id,
      position: r.position,
      care: r.care,
      dealbreaker: r.dealbreaker,
      auto: r.auto,
      shareWithMatch: r.share_with_match,
    })
    byUser.set(r.user_id, list)
  }

  const userIds = [...byUser.keys()].sort()
  const rows: {
    org_id: string
    user_a: string
    user_b: string
    percent: number
    excluded: boolean
    stale: boolean
    computed_at: string
  }[] = []
  for (let i = 0; i < userIds.length; i++) {
    for (let j = i + 1; j < userIds.length; j++) {
      const a = userIds[i]!
      const b = userIds[j]! // a < b already (sorted) — canonical order
      const { percent, excluded } = pairScore(byUser.get(a)!, byUser.get(b)!, questions)
      rows.push({
        org_id: orgId,
        user_a: a,
        user_b: b,
        percent,
        excluded,
        stale: false,
        computed_at: new Date().toISOString(),
      })
    }
  }
  if (rows.length > 0) {
    const { error } = await admin.from('mm_pair_scores').insert(rows)
    if (error) throw new Error(`Matchmaking pair-score seed failed: ${error.message}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
