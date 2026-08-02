// Live adversarial probes for view-as, as REAL signed-in users over PostgREST
// (the same surface an attacker has). Not a substitute for the RLS suite —
// these are the cross-layer checks that suite does not cover.
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const anonKey = process.env.SUPABASE_ANON_KEY!

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
// Reported loudly and never counted as a pass — a probe that quietly turns
// into a no-op is worse than one that fails.
function skip(name: string, why: string) {
  skipped++
  console.log(`  SKIP  ${name} — ${why}`)
}

const alice = await signIn('alice@demo.local')

// Handed from probe [5] to probe [6] so the cleanup delete is itself an assertion.
let cleanup: { orgA: string; bobId: string; nodeIds: string[]; courseIds: string[] } | null = null

console.log('\n[1] The manifest edge ban is enforced IN THE DATABASE, not only in the app')
{
  // Alice is the seeded speed-dating ORGANIZER (rank 2) in demo-dating; Charlie
  // is a PARTICIPANT (rank 0). Rank and scope both pass. The pair is banned
  // permanently by the manifest (docs/15 §8.1 point 7). Before the edge mirror
  // existed, this insert succeeded over plain PostgREST.
  const org = (await alice.from('orgs').select('id').eq('slug', 'demo-dating').single()).data!
  const p = (
    await alice
      .from('module_roles')
      .select('user_id, scope_ref')
      .eq('org_id', org.id)
      .eq('module_key', 'speed-dating')
      .eq('role', 'participant')
      .limit(1)
      .single()
  ).data!
  const r = await alice.from('view_as_sessions').insert({
    org_id: org.id,
    module_key: 'speed-dating',
    actor_user_id: p.user_id,
    target_user_id: p.user_id,
    target_role: 'participant',
    target_scope_ref: p.scope_ref,
  })
  check('organizer -> participant session is REFUSED (banned pair)', r.error != null, JSON.stringify(r.error))
  check('   ...and refused for the right reason', /declares an edge/.test(r.error?.message ?? ''), r.error?.message ?? '')
}

console.log('\n[2] The edge mirror is fail-closed for every pair nobody declared')
{
  const cases: [string, string, string, boolean][] = [
    ['classroom', 'professor', 'ga', true],
    ['classroom', 'professor', 'student', true],
    ['classroom', 'ga', 'student', false],
    ['classroom', 'student', 'professor', false],
    ['nail-salon', 'admin', 'manager', false],
    ['nail-salon', 'manager', 'worker', false],
    ['speed-dating', 'organizer', 'participant', false],
    ['visual-messaging', 'admin', 'member', false],
    ['no-such-module', 'a', 'b', false],
  ]
  for (const [m, a, b, want] of cases) {
    const { data } = await alice.rpc('module_view_as_edge', { module_key: m, from_role: a, to_role: b })
    check(`edge ${m} ${a}->${b} = ${want}`, data === want, `got ${data}`)
  }
}

console.log('\n[3] Mode 2 cannot be reached by URL alone — the cookie (= the log row) is required')
{
  // Sign in over HTTP the way the browser does, then request the view-as page
  // with mode=2 but WITHOUT a view-as cookie.
  try {
    const res = await fetch('http://localhost:3000/o/demo-a/m/classroom/view-as?tab=student&mode=2')
    const body = await res.text()
    // No auth and no view-as cookie: assert the page leaks no student rows.
    check('no-cookie mode=2 request leaks no student rows', !body.includes('Statistics 101'), `status ${res.status}`)
  } catch {
    skip('no-cookie mode=2 request leaks no student rows', 'dev server not running on :3000')
  }
}

console.log('\n[4] Starting a session writes exactly one log row, server-stamped')
{
  // Self-contained rather than counting rows some earlier suite happened to
  // leave behind — that version passed because the RLS suite had just run, and
  // on a freshly reset database it would have failed for reasons having
  // nothing to do with view-as.
  const orgA = (await alice.from('orgs').select('id').eq('slug', 'demo-a').single()).data!
  const charlie = (
    await alice
      .from('module_roles')
      .select('user_id, scope_ref')
      .eq('org_id', orgA.id)
      .eq('module_key', 'classroom')
      .eq('role', 'student')
      .limit(1)
      .single()
  ).data!

  const before = (await alice.from('view_as_sessions').select('*', { count: 'exact', head: true })).count ?? 0
  const { data: row, error } = await alice
    .from('view_as_sessions')
    .insert({
      org_id: orgA.id,
      module_key: 'classroom',
      // Deliberately forged: the guard must overwrite it with the real caller.
      actor_user_id: charlie.user_id,
      target_user_id: charlie.user_id,
      target_role: 'student',
      target_scope_ref: charlie.scope_ref,
    })
    .select('id, actor_user_id, created_at, expires_at')
    .single()
  const after = (await alice.from('view_as_sessions').select('*', { count: 'exact', head: true })).count ?? 0

  check('a permitted session is created', error == null, JSON.stringify(error))
  check('...writing exactly one log row', after === before + 1, `${before} -> ${after}`)
  const aliceId = (await alice.auth.getUser()).data.user!.id
  check('...with the actor server-stamped over the forged value', row?.actor_user_id === aliceId)
  check('...and an expiry in the future', new Date(row!.expires_at as string).getTime() > Date.now())
}

console.log('\n[5] Scope intersection: a COURSE-scoped professor cannot view a student in another course')
{
  const orgA = (await alice.from('orgs').select('id').eq('slug', 'demo-a').single()).data!
  const uidOf = async (email: string) =>
    ((await alice.rpc('org_find_user_by_email', { check_org_id: orgA.id, target_email: email })).data as
      | { user_id: string }[]
      | null)![0]!.user_id
  const bobId = await uidOf('bob@demo.local')
  const charlieId = await uidOf('charlie@demo.local')

  // Two isolated courses; bob is professor of the first only.
  const mkCourse = async (name: string) =>
    (await alice.from('cls_courses').insert({ org_id: orgA.id, name }).select('id, scope_node_id').single()).data!
  const c1 = await mkCourse('VA-Probe-A')
  const c2 = await mkCourse('VA-Probe-B')
  const mkClass = async (courseId: string, name: string) =>
    (await alice.from('cls_classes').insert({ org_id: orgA.id, course_id: courseId, name }).select('id, scope_node_id').single()).data!
  const k2 = await mkClass(c2.id as string, 'VA-Probe-B-Fall')

  // Slice 3: an add is a PENDING invite until the invitee accepts, and a
  // pending member satisfies no membership predicate. Without accepting, both
  // assertions below would pass for the mundane reason that Bob is not yet a
  // member — the negative one vacuously. Accept first so the scope check is
  // the only thing being tested.
  await alice.from('org_members').upsert({ org_id: orgA.id, user_id: bobId, role: 'member' })
  const bobPre = await signIn('bob@demo.local')
  await bobPre.rpc('org_accept_invite', { check_org_id: orgA.id })
  await alice.from('module_roles').insert([
    { org_id: orgA.id, user_id: bobId, module_key: 'classroom', role: 'professor', scope_ref: c1.scope_node_id },
    { org_id: orgA.id, user_id: charlieId, module_key: 'classroom', role: 'student', scope_ref: k2.scope_node_id },
  ])

  const bob = await signIn('bob@demo.local')
  const r = await bob.from('view_as_sessions').insert({
    org_id: orgA.id,
    module_key: 'classroom',
    actor_user_id: bobId,
    target_user_id: charlieId,
    target_role: 'student',
    target_scope_ref: k2.scope_node_id,
  })
  check('course-A professor cannot open a session on a course-B student', r.error != null, JSON.stringify(r.error))

  // ...but can on a student inside their own course.
  const k1 = await mkClass(c1.id as string, 'VA-Probe-A-Fall')
  await alice.from('module_roles').insert({
    org_id: orgA.id, user_id: charlieId, module_key: 'classroom', role: 'student', scope_ref: k1.scope_node_id,
  })
  const ok = await bob.from('view_as_sessions').insert({
    org_id: orgA.id,
    module_key: 'classroom',
    actor_user_id: bobId,
    target_user_id: charlieId,
    target_role: 'student',
    target_scope_ref: k1.scope_node_id,
  })
  check('...but CAN on a student inside their own course', ok.error == null, JSON.stringify(ok.error))

  cleanup = { orgA: orgA.id, bobId, nodeIds: [c1.scope_node_id as string, c2.scope_node_id as string], courseIds: [c1.id as string, c2.id as string] }
}

console.log('\n[6] The audit log outlives what it describes — AND does not block deleting it')
{
  // The subtle one. `on delete set null` is Postgres doing a real UPDATE on
  // this table, so an append-only BEFORE UPDATE trigger would abort the parent
  // DELETE — making any scope node or user ever named in a session permanently
  // undeletable. The second adversarial review found exactly that and it is
  // why enforcement is grants-only. Both halves are asserted here: the delete
  // must SUCCEED, and the log row must SURVIVE it with a nulled reference.
  const before = (await alice.from('view_as_sessions').select('*', { count: 'exact', head: true })).count ?? 0

  await alice.from('cls_courses').delete().in('id', cleanup!.courseIds)
  const del = await alice.from('module_scope_nodes').delete().in('id', cleanup!.nodeIds)
  check('deleting a scope node named by a session SUCCEEDS', del.error == null, JSON.stringify(del.error))

  const { data: gone } = await alice.from('module_scope_nodes').select('id').in('id', cleanup!.nodeIds)
  check('...the node really is gone (the delete was not a silent no-op)', (gone ?? []).length === 0)

  const after = (await alice.from('view_as_sessions').select('*', { count: 'exact', head: true })).count ?? 0
  check('...and every session row survived it', after === before, `${before} -> ${after}`)

  await alice.from('org_members').delete().eq('org_id', cleanup!.orgA).eq('user_id', cleanup!.bobId)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
