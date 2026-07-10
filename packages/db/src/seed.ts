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
// Creates: a superadmin founder, two demo orgs with one user each, and the
// stub module enabled for Demo Org A only — the exact fixture the RLS
// isolation test needs.
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
    { org_id: orgA, user_id: aliceId, role: 'admin' },
    { org_id: orgB, user_id: bobId, role: 'admin' },
  ])

  // Stub module: enabled for A only — B's absence is what the RLS test exercises.
  await admin.from('org_modules').upsert({ org_id: orgA, module_key: 'stub', enabled: true })
  await admin.from('module_roles').upsert({
    org_id: orgA,
    user_id: aliceId,
    module_key: 'stub',
    role: 'admin',
  })

  // --- Demo synagogue for module 3 -----------------------------------------
  const shul = await ensureOrg('Demo Synagogue', 'demo-shul')
  await admin.from('org_members').upsert({ org_id: shul, user_id: aliceId, role: 'admin' })
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
  await admin.from('module_roles').upsert({
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
  await admin.from('module_roles').upsert([
    { org_id: orgA, user_id: aliceId, module_key: 'classroom', role: 'professor' },
    { org_id: orgA, user_id: charlieId, module_key: 'classroom', role: 'student' },
    { org_id: orgA, user_id: gabeId, module_key: 'classroom', role: 'ga' },
    { org_id: orgA, user_id: danaId, module_key: 'classroom', role: 'student' },
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
    .select('id')
    .single()
  if (classErr) throw new Error(`Class seed failed: ${classErr.message}`)

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
  const { error: submissionErr } = await admin.from('cls_submissions').insert([
    { org_id: orgA, class_id: klass!.id, homework_id: homework!.id, student_id: charlieId },
    { org_id: orgA, class_id: klass!.id, homework_id: homework!.id, student_id: danaId },
  ])
  if (submissionErr) throw new Error(`Submission seed failed: ${submissionErr.message}`)

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

  const { error: surveyErr } = await admin.from('cls_surveys').insert({
    org_id: orgA,
    class_id: klass!.id,
    question: 'Which lab time do you prefer?',
    results_visible: false,
  })
  if (surveyErr) throw new Error(`Survey seed failed: ${surveyErr.message}`)

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
    { org_id: match, user_id: aliceId, role: 'admin' },
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
  await admin.from('module_roles').upsert([
    { org_id: match, user_id: aliceId, module_key: 'matchmaking', role: 'admin' },
    { org_id: match, user_id: charlieId, module_key: 'matchmaking', role: 'single' },
    { org_id: match, user_id: danaId, module_key: 'matchmaking', role: 'single' },
    { org_id: match, user_id: eveId, module_key: 'matchmaking', role: 'single' },
    { org_id: match, user_id: frankId, module_key: 'matchmaking', role: 'single' },
    { org_id: match, user_id: melId, module_key: 'matchmaking', role: 'matchmaker' },
  ])

  // Idempotent: wipe module data for this org and rebuild.
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

  // --- Demo nail salon for module 5 ----------------------------------------
  // alice = manager, eve = cashier, dana = worker, charlie = customer.
  // One location, two services, a worker profile, a customer, and a booked
  // appointment for today so the day-board has something to show.
  const salon = await ensureOrg('Demo Salon', 'demo-salon')
  await admin.from('org_members').upsert([
    { org_id: salon, user_id: aliceId, role: 'admin' },
    { org_id: salon, user_id: eveId, role: 'member' },
    { org_id: salon, user_id: danaId, role: 'member' },
    { org_id: salon, user_id: charlieId, role: 'member' },
  ])
  await admin.from('org_modules').upsert({ org_id: salon, module_key: 'nail-salon', enabled: true })
  await admin.from('module_roles').upsert([
    { org_id: salon, user_id: aliceId, module_key: 'nail-salon', role: 'manager' },
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

  // --- Demo speed dating for module 6 --------------------------------------
  // alice organizes; charlie/dana/eve/frank are participants. One event with
  // registration open so the e2e flow (register → rounds → interest → reveal)
  // starts from a clean, meaningful state.
  const dating = await ensureOrg('Demo Dating', 'demo-dating')
  await admin.from('org_members').upsert([
    { org_id: dating, user_id: aliceId, role: 'admin' },
    { org_id: dating, user_id: charlieId, role: 'member' },
    { org_id: dating, user_id: danaId, role: 'member' },
    { org_id: dating, user_id: eveId, role: 'member' },
    { org_id: dating, user_id: frankId, role: 'member' },
  ])
  await admin.from('org_modules').upsert({ org_id: dating, module_key: 'speed-dating', enabled: true })
  await admin.from('module_roles').upsert([
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
  await admin.from('module_roles').upsert([
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
    { org_id: visual, user_id: aliceId, role: 'admin' },
    { org_id: visual, user_id: charlieId, role: 'member' },
    { org_id: visual, user_id: danaId, role: 'member' },
  ])
  await admin.from('org_modules').upsert({ org_id: visual, module_key: 'visual-messaging', enabled: true })
  await admin.from('module_roles').upsert([
    { org_id: visual, user_id: aliceId, module_key: 'visual-messaging', role: 'admin' },
    { org_id: visual, user_id: charlieId, module_key: 'visual-messaging', role: 'member' },
    { org_id: visual, user_id: danaId, module_key: 'visual-messaging', role: 'member' },
  ])
  await admin.from('vm_conversations').delete().eq('org_id', visual)

  console.log('Seed complete:')
  console.log('  owner@demo.local / <demo password>  (superadmin)')
  console.log('  alice@demo.local / <demo password>  (admin of Demo Org A + Demo Synagogue + Demo Match + Demo Salon + Demo Dating)')
  console.log('  bob@demo.local   / <demo password>  (admin of Demo Org B, no modules)')
  console.log('  Demo Synagogue (demo-shul): synagogue-schedules enabled, alice is maker')
  console.log('  Demo Match (demo-match): matchmaking enabled — singles charlie/dana/eve/frank, matchmaker mel')
  console.log('  Demo Salon (demo-salon): nail-salon — manager alice, cashier eve, worker dana, customer charlie')
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
