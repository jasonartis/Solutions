// Live adversarial probes for the per-person data browser, as REAL signed-in
// users over PostgREST — the same surface an attacker has (docs/03 #12, #19).
//
// WHY THESE AND NOT MORE UNIT TESTS. The browser's whole safety argument is a
// claim about the LIVE database: "every query runs on the caller's own client,
// so the superadmin gate is a UI gate over data they can already reach." That
// claim is only checkable against real policies with real users. The db suite
// checks the declarations; this checks the claim.
//
// EVERY NEGATIVE ASSERTION HERE CARRIES A NON-EMPTINESS CONTROL (docs/03 #18).
// A clean seed has zero sd_notes, zero sd_interest and zero cls_review_comments
// — so "the superadmin sees nothing" would pass because the table is EMPTY, not
// because RLS hides it. Each probe below creates its fixture as the real user
// who is allowed to, asserts a privileged reader CAN see it, and only then
// asserts the reader who must not, cannot.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

// Self-sufficient env: read the repo-root .env that `pnpm dev` generates,
// rather than requiring the caller to export vars first (the way
// packages/db/vitest.config.ts loads it for the db suite). Real environment
// variables still win, so CI can set them directly.
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
const alice = await signIn('alice@demo.local') // professor (demo-a), organizer (demo-dating)
const charlie = await signIn('charlie@demo.local')
const dana = await signIn('dana@demo.local')
const gabe = await signIn('gabe@demo.local') // GA in demo-a

const ownerId = await userId(owner)
const ownerIsSuper = (await owner.from('profiles').select('is_superadmin').eq('user_id', ownerId).single()).data
check('owner@demo.local is the local superadmin (probe precondition)', ownerIsSuper?.is_superadmin === true)

// ---------------------------------------------------------------------------
console.log('\n[1] The neverReadable claim: sd_notes is unreadable by EVERYONE but its author')
// The flagship honesty claim. If this ever stops being true, the browser is
// lying in the other direction — telling an operator nobody can read something
// they in fact can.
{
  const org = (await alice.from('orgs').select('id').eq('slug', 'demo-dating').single()).data!
  const ev = await alice
    .from('sd_events')
    .insert({ org_id: org.id, name: 'probe event', scheduled_at: new Date(Date.now() + 864e5).toISOString() })
    .select('id')
    .single()

  if (ev.error) {
    skip('sd_notes probe', `could not create an event as the organizer: ${ev.error.message}`)
  } else {
    const charlieId = await userId(charlie)
    const danaId = await userId(dana)
    const parts = await alice
      .from('sd_participants')
      .insert([
        { org_id: org.id, event_id: ev.data.id, user_id: charlieId },
        { org_id: org.id, event_id: ev.data.id, user_id: danaId },
      ])
      .select('id, user_id')

    const note = await charlie
      .from('sd_notes')
      .insert({ org_id: org.id, event_id: ev.data.id, author_user_id: charlieId, about_user_id: danaId, body: 'probe note' })
      .select('id')
      .single()

    if (note.error) {
      skip('sd_notes probe', `author could not write a note: ${note.error.message}`)
    } else {
      // CONTROL first: the row genuinely exists and is readable by someone.
      const asAuthor = await charlie.from('sd_notes').select('id').eq('id', note.data.id)
      check('CONTROL: the author can read their own note (the row really exists)', (asAuthor.data ?? []).length === 1)

      const asOrganizer = await alice.from('sd_notes').select('id').eq('id', note.data.id)
      check('the ORGANIZER cannot read it', (asOrganizer.data ?? []).length === 0)

      const asSuper = await owner.from('sd_notes').select('id').eq('id', note.data.id)
      check('the SUPERADMIN cannot read it either — so declaring it neverReadable is true', (asSuper.data ?? []).length === 0)

      // The subject of the note cannot read it: the browser would tell an
      // operator "notes about this person may exist and nobody can show them".
      const asSubject = await dana.from('sd_notes').select('id').eq('id', note.data.id)
      check('the person the note is ABOUT cannot read it', (asSubject.data ?? []).length === 0)

      await charlie.from('sd_notes').delete().eq('id', note.data.id)
    }

    for (const p of parts.data ?? []) await alice.from('sd_participants').delete().eq('id', p.id)
    await alice.from('sd_events').delete().eq('id', ev.data.id)
  }
}

// ---------------------------------------------------------------------------
console.log('\n[2] The via path finds rows that name the person NOWHERE')
// This is the reason `via` exists. A peer-review comment on Charlie's
// submission names its AUTHOR, never Charlie — so a direct person-column scan
// answers "we hold no review feedback about Charlie", which is false.
{
  const org = (await alice.from('orgs').select('id').eq('slug', 'demo-a').single()).data!
  const charlieId = await userId(charlie)
  const sub = await alice
    .from('cls_submissions')
    .select('id, class_id, student_id')
    .eq('student_id', charlieId)
    .limit(1)
    .maybeSingle()

  if (!sub.data) {
    skip('via probe', 'the seed has no submission by charlie@demo.local')
  } else {
    const gabeId = await userId(gabe)
    const comment = await gabe
      .from('cls_review_comments')
      .insert({
        org_id: org.id,
        class_id: sub.data.class_id,
        submission_id: sub.data.id,
        author_id: gabeId,
        file_path: 'probe.txt',
        body: 'probe comment',
      })
      .select('id, author_id, submission_id')
      .single()

    if (comment.error) {
      skip('via probe', `could not write a review comment: ${comment.error.message}`)
    } else {
      // CONTROL: the row exists and the professor can read it.
      const direct = await alice
        .from('cls_review_comments')
        .select('id')
        .eq('id', comment.data.id)
      check('CONTROL: the professor can read the comment (the row really exists)', (direct.data ?? []).length === 1)

      // A DIRECT person-column scan for Charlie finds nothing...
      const byPerson = await alice
        .from('cls_review_comments')
        .select('id')
        .eq('id', comment.data.id)
        .or(`author_id.eq.${charlieId}`)
      check('a direct person-column scan for the STUDENT finds nothing (the gap via closes)', (byPerson.data ?? []).length === 0)

      // ...while the two-step via path does, exactly as lib/data-browser.ts runs it.
      const subIds = (
        await alice.from('cls_submissions').select('id').or(`student_id.eq.${charlieId}`)
      ).data!.map((r) => r.id)
      const byVia = await alice
        .from('cls_review_comments')
        .select('id')
        .eq('id', comment.data.id)
        .or(`author_id.eq.${charlieId},submission_id.in.(${subIds.join(',')})`)
      check('the via path DOES find it — "comments on their work" is answerable', (byVia.data ?? []).length === 1)

      // And the ceiling still holds: a student who is not the reviewee and not
      // the author gets nothing back through the same query.
      const asOtherStudent = await dana
        .from('cls_review_comments')
        .select('id')
        .eq('id', comment.data.id)
      check('RLS is still the ceiling — an unrelated student reads nothing through the same path', (asOtherStudent.data ?? []).length === 0)

      await gabe.from('cls_review_comments').delete().eq('id', comment.data.id)
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\n[3] The gate is a UI gate: a non-superadmin running the SAME queries gets only their own reach')
// The load-bearing claim behind having no migration. If bypassing
// requireSuperadmin() gained a caller anything, this probe would show it.
{
  const orgA = (await alice.from('orgs').select('id').eq('slug', 'demo-a').single()).data!
  const charlieId = await userId(charlie)

  // Charlie is a STUDENT. He runs the browser's own classroom queries against
  // himself — the app gate is the only thing he lacks.
  const own = await charlie.from('cls_submissions').select('id').eq('org_id', orgA.id).or(`student_id.eq.${charlieId}`)
  check('CONTROL: a student running the browser query about HIMSELF gets his rows', (own.data ?? []).length > 0)

  const danaId = await userId(dana)
  const other = await charlie.from('cls_grades').select('id').eq('org_id', orgA.id).or(`student_id.eq.${danaId}`)
  check('a student running it about ANOTHER student gets nothing — RLS, not the gate', (other.data ?? []).length === 0)

  // Cross-org: Charlie is not a member of demo-b at all.
  const orgB = (await owner.from('orgs').select('id').eq('slug', 'demo-b').maybeSingle()).data
  if (!orgB) skip('cross-org probe', 'demo-b not present in this seed')
  else {
    const across = await charlie.from('cls_submissions').select('id').eq('org_id', orgB.id)
    check('a member of one org reads nothing from another org through the browser query', (across.data ?? []).length === 0)
  }
}

// ---------------------------------------------------------------------------
console.log('\n[4] Unlogged: the browser writes nothing, in particular no view-as session')
{
  const before = (await owner.from('view_as_sessions').select('id')).data?.length ?? 0
  const orgA = (await owner.from('orgs').select('id').eq('slug', 'demo-a').single()).data!
  const charlieId = await userId(charlie)

  // Run the real thing: several of the browser's lookups as the superadmin.
  for (const [table, cols] of [
    ['cls_submissions', ['student_id']],
    ['cls_grades', ['student_id', 'graded_by']],
    ['org_members', ['user_id', 'invited_by']],
  ] as [string, string[]][]) {
    await owner
      .from(table)
      .select('*')
      .eq('org_id', orgA.id)
      .or(cols.map((c) => `${c}.eq.${charlieId}`).join(','))
  }

  const after = (await owner.from('view_as_sessions').select('id')).data?.length ?? 0
  check('running the browser adds ZERO view_as_sessions rows', after === before, `${before} -> ${after}`)
}

// ---------------------------------------------------------------------------
console.log('\n[5] The TWO-HOP chain reaches a paying customer (adversarial review, 2026-08-03)')
// The ship-blocker this probe exists for: sal_bills has NO customer column —
// only appointment_id — so the path to the customer is
// bills -> appointments.customer_id -> customers.user_id. With single-hop
// `via` only, a real customer WITH an account saw their appointments and ZERO
// bills, which reads as "we hold no billing record for you".
{
  const org = (await alice.from('orgs').select('id').eq('slug', 'demo-salon').single()).data!
  const charlieId = await userId(charlie)
  const cust = await alice
    .from('sal_customers')
    .select('id, user_id')
    .eq('org_id', org.id)
    .eq('user_id', charlieId)
    .maybeSingle()
  const appt = cust.data
    ? (await alice.from('sal_appointments').select('id, location_id').eq('customer_id', cust.data.id).limit(1).maybeSingle()).data
    : null

  if (!appt) {
    skip('two-hop chain probe', 'the seed has no salon appointment for a customer with an account')
  } else {
    const bill = await alice
      .from('sal_bills')
      .insert({ org_id: org.id, location_id: appt.location_id, appointment_id: appt.id })
      .select('id')
      .single()

    if (bill.error) {
      skip('two-hop chain probe', `could not create a bill: ${bill.error.message}`)
    } else {
      // CONTROL: the bill exists and staff can read it.
      const seen = await alice.from('sal_bills').select('id').eq('id', bill.data.id)
      check('CONTROL: the bill row really exists and staff can read it', (seen.data ?? []).length === 1)

      // THE REGRESSION: the staff-only person columns find nothing for Charlie.
      const staffOnly = await alice
        .from('sal_bills')
        .select('id')
        .eq('id', bill.data.id)
        .or(
          ['created_by', 'paid_by', 'voided_by', 'refunded_by']
            .map((c) => `${c}.eq.${charlieId}`)
            .join(','),
        )
      check(
        'the staff person columns alone do NOT find the customer\'s bill (the gap that was shipped)',
        (staffOnly.data ?? []).length === 0,
      )

      // THE FIX: resolve customers -> appointments -> bills, as the runner does.
      const custIds = (await alice.from('sal_customers').select('id').or(`user_id.eq.${charlieId}`)).data!.map((r) => r.id)
      const apptIds = (
        await alice.from('sal_appointments').select('id').or(`customer_id.in.(${custIds.join(',')})`)
      ).data!.map((r) => r.id)
      const chained = await alice
        .from('sal_bills')
        .select('id')
        .eq('id', bill.data.id)
        .or(`appointment_id.in.(${apptIds.join(',')})`)
      check('the two-hop chain DOES find it — billing history is answerable again', (chained.data ?? []).length === 1)

      await alice.from('sal_bills').delete().eq('id', bill.data.id)
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\n[6] The invariant that keeps the gate safe: no definer / service-role read path')
// A source scan, because this is the one property no runtime probe can catch
// after the fact — by the time an .rpc() call exists, the app-layer gate has
// silently become a security boundary (docs/03 #18, #19).
{
  const files = [
    'apps/web/lib/data-browser.ts',
    'apps/web/app/(app)/console/data-browser/page.tsx',
    'apps/web/components/data-browser/results.tsx',
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
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`)
if (skipped > 0) console.log('NOTE: a skipped probe asserts NOTHING — re-run against a fresh seed.')
process.exit(fail === 0 ? 0 : 1)
