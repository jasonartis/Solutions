import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

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
  const founderId = await ensureUser('owner@demo.local', 'password123', 'Founder')
  const aliceId = await ensureUser('alice@demo.local', 'password123', 'Alice A')
  const bobId = await ensureUser('bob@demo.local', 'password123', 'Bob B')

  await admin.from('profiles').update({ is_superadmin: true }).eq('user_id', founderId)

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
  const charlieId = await ensureUser('charlie@demo.local', 'password123', 'Charlie C')
  await admin.from('org_members').upsert({ org_id: orgA, user_id: charlieId, role: 'member' })
  await admin.from('org_modules').upsert({ org_id: orgA, module_key: 'classroom', enabled: true })
  await admin.from('module_roles').upsert([
    { org_id: orgA, user_id: aliceId, module_key: 'classroom', role: 'professor' },
    { org_id: orgA, user_id: charlieId, module_key: 'classroom', role: 'student' },
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
  ])
  if (memberErr) throw new Error(`Class members seed failed: ${memberErr.message}`)

  const nextWeek = new Date()
  nextWeek.setDate(nextWeek.getDate() + 7)
  const { error: hwErr } = await admin.from('cls_homeworks').insert({
    org_id: orgA,
    class_id: klass!.id,
    title: 'Homework 1 — Descriptive statistics',
    due_at: nextWeek.toISOString(),
    sort: 0,
  })
  if (hwErr) throw new Error(`Homework seed failed: ${hwErr.message}`)

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

  console.log('Seed complete:')
  console.log('  owner@demo.local / password123  (superadmin)')
  console.log('  alice@demo.local / password123  (admin of Demo Org A + Demo Synagogue)')
  console.log('  bob@demo.local   / password123  (admin of Demo Org B, no modules)')
  console.log('  Demo Synagogue (demo-shul): synagogue-schedules enabled, alice is maker')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
