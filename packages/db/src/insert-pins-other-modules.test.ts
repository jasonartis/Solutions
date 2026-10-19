import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'

// ---------------------------------------------------------------------------
// INSERT PINS, OTHER MODULES (20261017030000).
//
// Columns protected on UPDATE by a `*_pin_*` trigger were client-controlled on
// INSERT. Each case is exercised as a real signed-in caller (`set local role
// authenticated` + `request.jwt.claims`), so RLS, auth.uid() and every trigger
// see exactly what an API request would. Every probe carries a CONTROL: the
// staff/trusted path still keeps the same values, and the plain caller's row
// really landed — so a passing coercion is never an empty table.
//
// Throwaway accounts; every probe runs in a transaction that is ALWAYS rolled
// back; accounts hard-deleted afterwards. CI runs e2e on this database next
// with no reset between, so nothing may leak.
// ---------------------------------------------------------------------------

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const ownerDbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const sql = postgres(ownerDbUrl, { prepare: false, max: 1 })
const admin = () => createClient(url, serviceKey, { auth: { persistSession: false } })

// s = the plain user under test, d = another plain user (the victim),
// a = org admin (staff on every module), m = synagogue schedule maker.
const who = ['s', 'd', 'a', 'm'] as const
type Who = (typeof who)[number]
const ids: Record<Who, string> = { s: '', d: '', a: '', m: '' }

beforeAll(async () => {
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for this suite')
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  for (const k of who) {
    const { data, error } = await admin().auth.admin.createUser({
      email: `inspin-${k}-${tag}@demo.local`, password: 'password123', email_confirm: true,
    })
    if (error) throw new Error(`createUser ${k}: ${error.message}`)
    ids[k] = data.user!.id
  }
})

afterAll(async () => {
  try {
    for (const id of Object.values(ids).filter(Boolean)) {
      const { error } = await admin().auth.admin.deleteUser(id)
      expect(error, 'could not hard-delete a probe account').toBeNull()
    }
  } finally {
    await sql.end()
  }
})

type Tx = postgres.TransactionSql

async function rolledBack<T>(body: (tx: Tx) => Promise<T>): Promise<T> {
  let result!: T
  await sql
    .begin(async (tx) => {
      result = await body(tx)
      throw new Error('__rollback__')
    })
    .catch((e: unknown) => {
      if ((e as Error)?.message !== '__rollback__') throw e
    })
  return result
}

type Outcome = { error: string | null; rows: number }

/** Run `stmt` AS a signed-in user under a savepoint; back to owner/no-JWT afterwards. */
async function as(tx: Tx, user: Who, stmt: () => Promise<postgres.RowList<postgres.Row[]>>): Promise<Outcome> {
  await tx.unsafe('savepoint sp')
  let out: Outcome
  try {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: ids[user], role: 'authenticated' })}, true)`
    await tx.unsafe('set local role authenticated')
    const r = await stmt()
    await tx.unsafe('release savepoint sp')
    out = { error: null, rows: r.count }
  } catch (e: unknown) {
    await tx.unsafe('rollback to savepoint sp')
    out = { error: String((e as Error).message), rows: 0 }
  }
  await tx.unsafe('reset role')
  await tx`select set_config('request.jwt.claims', '', true)`
  return out
}

const OLD = '2000-01-01T00:00:00Z'
const FAR = '2099-01-01T00:00:00Z'
const year = (d: Date | null) => (d ? d.getUTCFullYear() : null)

/** Org where s, d, m are active members and a is an admin. */
async function makeOrg(tx: Tx): Promise<string> {
  const [o] = await tx<{ id: string }[]>`
    insert into orgs (name, slug) values ('Insert pins probe', ${`inspin-${Math.random().toString(36).slice(2, 10)}`})
    returning id`
  const org = o!.id
  for (const k of ['s', 'd', 'm'] as const) {
    await tx`insert into org_members (org_id, user_id, role, status, accepted_at)
             values (${org}, ${ids[k]}, 'member', 'active', now())`
  }
  await tx`insert into org_members (org_id, user_id, role, status, accepted_at)
           values (${org}, ${ids.a}, 'admin', 'active', now())`
  return org
}

/** A course with two classes; s and d are students of class 1 only. Homework in class 1. */
async function makeClassroom(tx: Tx, org: string) {
  const [course] = await tx<{ id: string }[]>`insert into cls_courses (org_id, name) values (${org}, 'Probe course') returning id`
  const mk = async (name: string) =>
    (await tx<{ id: string; scope_node_id: string }[]>`
      insert into cls_classes (org_id, course_id, name) values (${org}, ${course!.id}, ${name})
      returning id, scope_node_id`)[0]!
  const c1 = await mk('Probe class 1')
  const c2 = await mk('Probe class 2')
  for (const k of ['s', 'd'] as const) {
    await tx`insert into module_roles (org_id, user_id, module_key, role, scope_ref)
             values (${org}, ${ids[k]}, 'classroom', 'student', ${c1.scope_node_id})`
  }
  const [hw] = await tx<{ id: string }[]>`
    insert into cls_homeworks (org_id, class_id, title) values (${org}, ${c1.id}, 'Probe HW') returning id`
  return { c1: c1.id, c2: c2.id, hw: hw!.id }
}

async function submission(tx: Tx, org: string, cls: { c1: string; hw: string }, user: Who): Promise<string> {
  const [r] = await tx<{ id: string }[]>`
    insert into cls_submissions (org_id, homework_id, class_id, student_id)
    values (${org}, ${cls.hw}, ${cls.c1}, ${ids[user]}) returning id`
  return r!.id
}

describe('insert pins, other modules (20261017030000)', () => {
  it('cls_submissions: a student cannot pre-set visible_override_until / submitted_at / storage_prefix / created_at (control: a manager can; the retention hide applies to the student row)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const cls = await makeClassroom(tx, org)
      const mine = randomUUID()
      const res = await as(tx, 's', () => tx`
        insert into cls_submissions (id, org_id, homework_id, class_id, student_id, visible_override_until, submitted_at, created_at, storage_prefix)
        values (${mine}, ${org}, ${cls.hw}, ${cls.c1}, ${ids.s}, ${FAR}, ${OLD}, ${OLD}, ${`${org}/${cls.c1}/someone-else`})`)
      const staff = randomUUID()
      const staffRes = await as(tx, 'a', () => tx`
        insert into cls_submissions (id, org_id, homework_id, class_id, student_id, visible_override_until, submitted_at)
        values (${staff}, ${org}, ${cls.hw}, ${cls.c1}, ${ids.d}, ${FAR}, ${OLD})`)
      // The class's retention hide kicks in: the student's row must be hidden, the
      // manager's explicit override must keep its row visible.
      await tx`update cls_classes set submissions_hidden_from = now() - interval '1 day' where id = ${cls.c1}`
      const rows = await tx<{ id: string; visible_override_until: Date | null; submitted_at: Date; created_at: Date; storage_prefix: string | null; hidden: boolean }[]>`
        select id, visible_override_until, submitted_at, created_at, storage_prefix, cls_submission_hidden(id) as hidden
        from cls_submissions where id in (${mine}, ${staff})`
      return { res, staffRes, s: rows.find((x) => x.id === mine)!, a: rows.find((x) => x.id === staff)! }
    })
    expect(r.res).toEqual({ error: null, rows: 1 })
    expect(r.s.visible_override_until).toBeNull()
    expect(year(r.s.submitted_at)).toBeGreaterThan(2020)
    expect(year(r.s.created_at)).toBeGreaterThan(2020)
    expect(r.s.storage_prefix).toBeNull()
    expect(r.s.hidden, 'the student row must fall under the class retention hide').toBe(true)
    expect(r.staffRes, 'CONTROL: a manager may still insert').toEqual({ error: null, rows: 1 })
    expect(year(r.a.visible_override_until), 'CONTROL: the manager override is kept').toBe(2099)
    expect(year(r.a.submitted_at)).toBe(2000)
    expect(r.a.hidden, 'CONTROL: the override really keeps a row visible').toBe(false)
  })

  it("cls_submission_files: a file row must point inside its own submission's folder (control: the app's real path shape lands; a manager is not restricted)", async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const cls = await makeClassroom(tx, org)
      const sSub = await submission(tx, org, cls, 's')
      const dSub = await submission(tx, org, cls, 'd')
      const ins = (user: Who, sub: string, path: string) => as(tx, user, () => tx`
        insert into cls_submission_files (org_id, class_id, submission_id, file_name, storage_path)
        values (${org}, ${cls.c1}, ${sub}, 'f.pdf', ${path})`)
      return {
        victimsFolder: await ins('s', sSub, `${org}/${cls.c1}/${dSub}/1-f.pdf`),
        otherClass: await ins('s', sSub, `${org}/${cls.c2}/${sSub}/1-f.pdf`),
        otherOrg: await ins('s', sSub, `${randomUUID()}/${cls.c1}/${sSub}/1-f.pdf`),
        noFile: await ins('s', sSub, `${org}/${cls.c1}/${sSub}/`),
        own: await ins('s', sSub, `${org}/${cls.c1}/${sSub}/1700000000000-f.pdf`),
        staff: await ins('a', sSub, `anything/at/all.pdf`),
        count: (await tx<{ n: number }[]>`select count(*)::int as n from cls_submission_files where submission_id = ${sSub}`)[0]!.n,
      }
    })
    for (const k of ['victimsFolder', 'otherClass', 'otherOrg', 'noFile'] as const) {
      expect(r[k].error, k).toMatch(/does not belong to this submission/)
    }
    expect(r.own, 'CONTROL: the app path shape is accepted').toEqual({ error: null, rows: 1 })
    expect(r.staff, 'CONTROL: a manager is not restricted').toEqual({ error: null, rows: 1 })
    expect(r.count).toBe(2)
  })

  it('vm_layers: a member cannot insert a pre-removed, frozen or back-dated layer (control: a manager may insert a frozen one; tombstone is forced for all)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      await tx`insert into module_roles (org_id, user_id, module_key, role) values (${org}, ${ids.s}, 'visual-messaging', 'member')`
      const [conv] = await tx<{ id: string }[]>`insert into vm_conversations (org_id, title) values (${org}, 'Probe') returning id`
      await tx`insert into vm_conversation_members (org_id, conversation_id, user_id, role, status)
               values (${org}, ${conv!.id}, ${ids.s}, 'participant', 'active')`
      const [root] = await tx<{ id: string }[]>`
        insert into vm_layers (org_id, conversation_id, author_id, path, content)
        values (${org}, ${conv!.id}, ${ids.s}, 'x', '{}') returning id`
      const ins = (user: Who, id: string) => as(tx, user, () => tx`
        insert into vm_layers (id, org_id, conversation_id, parent_layer_id, author_id, path, content,
                               tombstoned, tombstoned_by, tombstoned_at, frozen, created_at)
        values (${id}, ${org}, ${conv!.id}, ${root!.id}, ${ids[user]}, 'x', '{"strokes":[]}',
                true, ${ids.a}, ${OLD}, true, ${OLD})`)
      const mine = randomUUID()
      const staff = randomUUID()
      const res = await ins('s', mine)
      const staffRes = await ins('a', staff)
      const rows = await tx<{ id: string; tombstoned: boolean; tombstoned_by: string | null; tombstoned_at: Date | null; frozen: boolean; created_at: Date; content: unknown }[]>`
        select id, tombstoned, tombstoned_by, tombstoned_at, frozen, created_at, content from vm_layers where id in (${mine}, ${staff})`
      return { res, staffRes, s: rows.find((x) => x.id === mine)!, a: rows.find((x) => x.id === staff)! }
    })
    expect(r.res).toEqual({ error: null, rows: 1 })
    expect(r.s).toMatchObject({ tombstoned: false, tombstoned_by: null, tombstoned_at: null, frozen: false })
    expect(year(r.s.created_at)).toBeGreaterThan(2020)
    expect(r.s.content, 'CONTROL: the drawing itself landed').toEqual({ strokes: [] })
    expect(r.staffRes).toEqual({ error: null, rows: 1 })
    expect(r.a.frozen, 'CONTROL: a manager may still create a frozen layer').toBe(true)
    expect(r.a).toMatchObject({ tombstoned: false, tombstoned_by: null, tombstoned_at: null })
  })

  it('vm_flags: a flag is born open and unreviewed whatever the reporter sends (control: reason/detail land)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      await tx`insert into module_roles (org_id, user_id, module_key, role) values (${org}, ${ids.s}, 'visual-messaging', 'member')`
      const [conv] = await tx<{ id: string }[]>`insert into vm_conversations (org_id, title) values (${org}, 'Probe') returning id`
      await tx`insert into vm_conversation_members (org_id, conversation_id, user_id, role, status)
               values (${org}, ${conv!.id}, ${ids.s}, 'participant', 'active')`
      const [root] = await tx<{ id: string }[]>`
        insert into vm_layers (org_id, conversation_id, author_id, path, content)
        values (${org}, ${conv!.id}, ${ids.d}, 'x', '{}') returning id`
      const ins = (user: Who, id: string) => as(tx, user, () => tx`
        insert into vm_flags (id, org_id, conversation_id, layer_id, reporter_user_id, reason, detail, state, reviewed_by, reviewed_at, created_at)
        values (${id}, ${org}, ${conv!.id}, ${root!.id}, ${ids[user]}, 'spam', 'probe detail', 'dismissed', ${ids.a}, ${OLD}, ${OLD})`)
      const mine = randomUUID()
      const staff = randomUUID()
      const res = await ins('s', mine)
      const staffRes = await ins('a', staff)
      const rows = await tx<{ id: string; state: string; reviewed_by: string | null; reviewed_at: Date | null; created_at: Date; reason: string; detail: string }[]>`
        select id, state, reviewed_by, reviewed_at, created_at, reason, detail from vm_flags where id in (${mine}, ${staff})`
      return { res, staffRes, s: rows.find((x) => x.id === mine)!, a: rows.find((x) => x.id === staff)! }
    })
    expect(r.res).toEqual({ error: null, rows: 1 })
    expect(r.s).toMatchObject({ state: 'open', reviewed_by: null, reviewed_at: null, reason: 'spam', detail: 'probe detail' })
    expect(year(r.s.created_at)).toBeGreaterThan(2020)
    expect(r.staffRes, 'CONTROL: a manager can still file a flag').toEqual({ error: null, rows: 1 })
    expect(r.a).toMatchObject({ state: 'open', reviewed_by: null, reviewed_at: null })
  })

  it('sal_appointments: a customer cannot forge booked_by / checklist / created_at / cancellation (control: an operator books with any values, walk-in included)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const [loc] = await tx<{ id: string }[]>`insert into sal_locations (org_id, name) values (${org}, 'Probe salon') returning id`
      const [svc] = await tx<{ id: string }[]>`
        insert into sal_services (org_id, location_id, name, approx_duration_minutes) values (${org}, ${loc!.id}, 'Mani', 30) returning id`
      const [cust] = await tx<{ id: string }[]>`
        insert into sal_customers (org_id, location_id, user_id, full_name) values (${org}, ${loc!.id}, ${ids.s}, 'S') returning id`
      const [walkIn] = await tx<{ id: string }[]>`
        insert into sal_customers (org_id, location_id, full_name) values (${org}, ${loc!.id}, 'Walk In') returning id`
      const checklist = tx.json([{ label: 'polish', done: true }])
      const ins = (user: Who, id: string, customer: string, state: string) => as(tx, user, () => tx`
        insert into sal_appointments (id, org_id, location_id, customer_id, service_id, scheduled_start, scheduled_end,
                                      state, booked_by, checklist, created_at, cancelled_at, cancel_reason)
        values (${id}, ${org}, ${loc!.id}, ${customer}, ${svc!.id}, now() + interval '1 day', now() + interval '1 day 30 minutes',
                ${state}, ${ids.a}, ${checklist}, ${OLD}, ${OLD}, 'forged')`)
      const mine = randomUUID()
      const staff = randomUUID()
      const res = await ins('s', mine, cust!.id, 'booked')
      const staffRes = await ins('a', staff, walkIn!.id, 'checked_in')
      const rows = await tx<{ id: string; booked_by: string | null; checklist: unknown; created_at: Date; cancelled_at: Date | null; cancel_reason: string | null; state: string }[]>`
        select id, booked_by, checklist, created_at, cancelled_at, cancel_reason, state from sal_appointments where id in (${mine}, ${staff})`
      return { res, staffRes, s: rows.find((x) => x.id === mine)!, a: rows.find((x) => x.id === staff)! }
    })
    expect(r.res).toEqual({ error: null, rows: 1 })
    expect(r.s).toMatchObject({ booked_by: ids.s, checklist: [], cancelled_at: null, cancel_reason: null, state: 'booked' })
    expect(year(r.s.created_at)).toBeGreaterThan(2020)
    expect(r.staffRes, 'CONTROL: operator walk-in booking').toEqual({ error: null, rows: 1 })
    expect(r.a.booked_by, 'CONTROL: operator values kept').toBe(ids.a)
    expect(r.a.checklist).toEqual([{ label: 'polish', done: true }])
    expect(r.a.state).toBe('checked_in')
  })

  it('mm_questions: a proposer cannot pre-lock or pre-approve a question (control: an admin-authored question keeps its locks and approval)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      await tx`insert into module_roles (org_id, user_id, module_key, role) values (${org}, ${ids.s}, 'matchmaking', 'single')`
      const ins = (user: Who, id: string, status: string) => as(tx, user, () => tx`
        insert into mm_questions (id, org_id, text, scale_labels, admin_locks, status, submitted_by, approved_by, approved_at, created_at)
        values (${id}, ${org}, 'Probe?', ${['no', 'yes']}, '{"answer":1,"dealbreaker":true}'::jsonb, ${status}, ${ids[user]}, ${ids.a}, ${OLD}, ${OLD})`)
      const mine = randomUUID()
      const staff = randomUUID()
      const res = await ins('s', mine, 'pending')
      const staffRes = await ins('a', staff, 'approved')
      const rows = await tx<{ id: string; admin_locks: unknown; approved_by: string | null; approved_at: Date | null; created_at: Date; status: string }[]>`
        select id, admin_locks, approved_by, approved_at, created_at, status from mm_questions where id in (${mine}, ${staff})`
      return { res, staffRes, s: rows.find((x) => x.id === mine)!, a: rows.find((x) => x.id === staff)! }
    })
    expect(r.res).toEqual({ error: null, rows: 1 })
    expect(r.s).toMatchObject({ admin_locks: {}, approved_by: null, approved_at: null, status: 'pending' })
    expect(year(r.s.created_at)).toBeGreaterThan(2020)
    expect(r.staffRes).toEqual({ error: null, rows: 1 })
    expect(r.a.admin_locks, 'CONTROL: admin locks kept').toEqual({ answer: 1, dealbreaker: true })
    expect(r.a.approved_by).toBe(ids.a)
  })

  it('job_requests: only makers queue a render, status is always pending, unknown kinds refused (controls: maker + admin succeed; trusted path keeps its values)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      await tx`insert into module_roles (org_id, user_id, module_key, role) values (${org}, ${ids.m}, 'synagogue-schedules', 'maker')`
      const ins = (user: Who, id: string, kind: string) => as(tx, user, () => tx`
        insert into job_requests (id, org_id, requested_by, kind, payload, status, result, error, created_at)
        values (${id}, ${org}, ${ids[user]}, ${kind}, '{"weekStart":"2026-10-18"}'::jsonb, 'done', '{"forged":true}'::jsonb, 'forged', ${OLD})`)
      const render = 'synagogue-schedules.render'
      const memberRes = await ins('s', randomUUID(), render)
      const makerId = randomUUID()
      const makerRes = await ins('m', makerId, render)
      const unknownRes = await ins('m', randomUUID(), 'something.else')
      const adminRes = await ins('a', randomUUID(), render)
      const trusted = randomUUID()
      await tx`insert into job_requests (id, org_id, kind, status) values (${trusted}, ${org}, 'something.else', 'done')`
      const rows = await tx<{ id: string; status: string; result: unknown; error: string | null; created_at: Date }[]>`
        select id, status, result, error, created_at from job_requests where id in (${makerId}, ${trusted})`
      return { memberRes, makerRes, unknownRes, adminRes, maker: rows.find((x) => x.id === makerId)!, trusted: rows.find((x) => x.id === trusted)! }
    })
    expect(r.memberRes.error).toMatch(/Only a schedule maker may request an export/)
    expect(r.unknownRes.error).toMatch(/Unknown job kind/)
    expect(r.makerRes, 'CONTROL: a maker can queue a render').toEqual({ error: null, rows: 1 })
    expect(r.adminRes, 'CONTROL: an org admin can queue a render').toEqual({ error: null, rows: 1 })
    expect(r.maker).toMatchObject({ status: 'pending', result: null, error: null })
    expect(year(r.maker.created_at)).toBeGreaterThan(2020)
    expect(r.trusted.status, 'CONTROL: the no-JWT (worker/seed) path is untouched').toBe('done')
  })

  it("cls_survey_answers: class_id is derived from the survey, so an answer cannot be filed under another class (control: a mislabelled answer to one's own class lands corrected)", async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const cls = await makeClassroom(tx, org)
      const [own] = await tx<{ id: string }[]>`insert into cls_surveys (org_id, class_id, question) values (${org}, ${cls.c1}, 'Mine?') returning id`
      const [other] = await tx<{ id: string }[]>`insert into cls_surveys (org_id, class_id, question) values (${org}, ${cls.c2}, 'Theirs?') returning id`
      const ins = (survey: string, cls_: string, id: string) => as(tx, 's', () => tx`
        insert into cls_survey_answers (id, org_id, survey_id, class_id, user_id, answer)
        values (${id}, ${org}, ${survey}, ${cls_}, ${ids.s}, 'probe')`)
      // A survey in a class s is NOT in, filed under the class s IS in.
      const crossRes = await ins(other!.id, cls.c1, randomUUID())
      // s's own class survey, mislabelled with the other class: corrected, lands.
      const ownId = randomUUID()
      const ownRes = await ins(own!.id, cls.c2, ownId)
      // UPDATE path: moving the answer's class is undone too.
      const moveRes = await as(tx, 's', () => tx`update cls_survey_answers set class_id = ${cls.c2} where id = ${ownId}`)
      const [row] = await tx<{ class_id: string }[]>`select class_id from cls_survey_answers where id = ${ownId}`
      const crossRows = (await tx<{ n: number }[]>`select count(*)::int as n from cls_survey_answers where survey_id = ${other!.id}`)[0]!.n
      return { crossRes, ownRes, moveRes, classId: row?.class_id, crossRows, c1: cls.c1 }
    })
    expect(r.crossRes.error, 'the cross-class answer must be refused').not.toBeNull()
    expect(r.crossRows).toBe(0)
    expect(r.ownRes, 'CONTROL: answering your own class survey works').toEqual({ error: null, rows: 1 })
    expect(r.moveRes.error).toBeNull()
    expect(r.classId).toBe(r.c1)
  })

  // ---- UPDATE-side mirror (section 9 of the migration) --------------------

  it('cls_submissions UPDATE: a student cannot rewrite submitted_at / storage_prefix / created_at / override (control: a manager can; the row is updatable)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const cls = await makeClassroom(tx, org)
      const sub = await submission(tx, org, cls, 's')
      const before = (await tx<{ submitted_at: Date; created_at: Date }[]>`select submitted_at, created_at from cls_submissions where id = ${sub}`)[0]!
      const forge = () => tx`update cls_submissions
        set submitted_at = ${OLD}, created_at = ${OLD}, storage_prefix = 'elsewhere/x', visible_override_until = ${FAR}
        where id = ${sub}`
      const res = await as(tx, 's', forge)
      const after = (await tx<{ submitted_at: Date; created_at: Date; storage_prefix: string | null; visible_override_until: Date | null }[]>`
        select submitted_at, created_at, storage_prefix, visible_override_until from cls_submissions where id = ${sub}`)[0]!
      const staffRes = await as(tx, 'a', forge)
      const staff = (await tx<{ submitted_at: Date; storage_prefix: string | null }[]>`
        select submitted_at, storage_prefix from cls_submissions where id = ${sub}`)[0]!
      return { before, res, after, staffRes, staff }
    })
    expect(r.res, 'CONTROL: the student UPDATE reaches the row').toEqual({ error: null, rows: 1 })
    expect(r.after.submitted_at.getTime()).toBe(r.before.submitted_at.getTime())
    expect(r.after.created_at.getTime()).toBe(r.before.created_at.getTime())
    expect(r.after.storage_prefix).toBeNull()
    expect(r.after.visible_override_until).toBeNull()
    expect(r.staffRes).toEqual({ error: null, rows: 1 })
    expect(year(r.staff.submitted_at), 'CONTROL: a manager may still set it').toBe(2000)
    expect(r.staff.storage_prefix).toBe('elsewhere/x')
  })

  it("cls_survey_answers UPDATE: a student cannot move an answer onto another class's survey (control: the answer text still updates; staff may move it)", async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const cls = await makeClassroom(tx, org)
      const [own] = await tx<{ id: string }[]>`insert into cls_surveys (org_id, class_id, question) values (${org}, ${cls.c1}, 'Mine?') returning id`
      const [other] = await tx<{ id: string }[]>`insert into cls_surveys (org_id, class_id, question) values (${org}, ${cls.c2}, 'Theirs?') returning id`
      const [ans] = await tx<{ id: string }[]>`
        insert into cls_survey_answers (org_id, survey_id, class_id, user_id, answer, created_at)
        values (${org}, ${own!.id}, ${cls.c1}, ${ids.s}, 'first', ${OLD}) returning id`
      const read = async () => (await tx<{ survey_id: string; class_id: string; answer: string; created_at: Date }[]>`
        select survey_id, class_id, answer, created_at from cls_survey_answers where id = ${ans!.id}`)[0]!
      const res = await as(tx, 's', () => tx`update cls_survey_answers
        set survey_id = ${other!.id}, answer = 'second', created_at = now() where id = ${ans!.id}`)
      const after = await read()
      const staffRes = await as(tx, 'a', () => tx`update cls_survey_answers set survey_id = ${other!.id} where id = ${ans!.id}`)
      return { res, after, staffRes, staff: await read(), own: own!.id, other: other!.id, c1: cls.c1, c2: cls.c2 }
    })
    expect(r.res).toEqual({ error: null, rows: 1 })
    expect(r.after.answer, 'CONTROL: the same UPDATE did land').toBe('second')
    expect(r.after.survey_id).toBe(r.own)
    expect(r.after.class_id).toBe(r.c1)
    expect(year(r.after.created_at)).toBe(2000)
    expect(r.staffRes).toEqual({ error: null, rows: 1 })
    expect(r.staff.survey_id, 'CONTROL: staff may move it').toBe(r.other)
    expect(r.staff.class_id, 'and the class follows the survey').toBe(r.c2)
  })

  it('vm_layers / vm_flags UPDATE: author and moderator cannot rewrite created_at (controls: content and triage land; a manager can)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      for (const k of ['s', 'd'] as const) {
        await tx`insert into module_roles (org_id, user_id, module_key, role) values (${org}, ${ids[k]}, 'visual-messaging', 'member')`
      }
      const [conv] = await tx<{ id: string }[]>`insert into vm_conversations (org_id, title) values (${org}, 'Probe') returning id`
      await tx`insert into vm_conversation_members (org_id, conversation_id, user_id, role, status)
               values (${org}, ${conv!.id}, ${ids.s}, 'participant', 'active'),
                      (${org}, ${conv!.id}, ${ids.d}, 'conversation_moderator', 'active')`
      const [layer] = await tx<{ id: string; created_at: Date }[]>`
        insert into vm_layers (org_id, conversation_id, author_id, path, content)
        values (${org}, ${conv!.id}, ${ids.s}, 'x', '{}') returning id, created_at`
      const [flag] = await tx<{ id: string; created_at: Date }[]>`
        insert into vm_flags (org_id, conversation_id, layer_id, reporter_user_id, reason)
        values (${org}, ${conv!.id}, ${layer!.id}, ${ids.s}, 'spam') returning id, created_at`
      const layerRes = await as(tx, 's', () => tx`update vm_layers set content = '{"strokes":[1]}', created_at = ${OLD} where id = ${layer!.id}`)
      const flagRes = await as(tx, 'd', () => tx`update vm_flags set state = 'dismissed', created_at = ${OLD} where id = ${flag!.id}`)
      const l = (await tx<{ content: unknown; created_at: Date }[]>`select content, created_at from vm_layers where id = ${layer!.id}`)[0]!
      const f = (await tx<{ state: string; reviewed_by: string | null; created_at: Date }[]>`select state, reviewed_by, created_at from vm_flags where id = ${flag!.id}`)[0]!
      const mgrRes = await as(tx, 'a', () => tx`update vm_flags set created_at = ${OLD} where id = ${flag!.id}`)
      const fm = (await tx<{ created_at: Date }[]>`select created_at from vm_flags where id = ${flag!.id}`)[0]!
      return { layerRes, flagRes, l, f, layerBefore: layer!.created_at, flagBefore: flag!.created_at, mgrRes, fm }
    })
    expect(r.layerRes).toEqual({ error: null, rows: 1 })
    expect(r.l.content, 'CONTROL: the author edit landed').toEqual({ strokes: [1] })
    expect(r.l.created_at.getTime()).toBe(r.layerBefore.getTime())
    expect(r.flagRes).toEqual({ error: null, rows: 1 })
    expect(r.f.state, 'CONTROL: the triage landed').toBe('dismissed')
    expect(r.f.reviewed_by).toBe(ids.d)
    expect(r.f.created_at.getTime()).toBe(r.flagBefore.getTime())
    expect(r.mgrRes).toEqual({ error: null, rows: 1 })
    expect(year(r.fm.created_at), 'CONTROL: a manager may still set it').toBe(2000)
  })

  it('sal_appointments UPDATE: a customer cannot forge created_at / cancelled_at, nor a cancel_reason without cancelling (controls: cancelling stamps now(); an operator can set them)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const [loc] = await tx<{ id: string }[]>`insert into sal_locations (org_id, name) values (${org}, 'Probe salon') returning id`
      const [svc] = await tx<{ id: string }[]>`
        insert into sal_services (org_id, location_id, name, approx_duration_minutes) values (${org}, ${loc!.id}, 'Mani', 30) returning id`
      const [cust] = await tx<{ id: string }[]>`
        insert into sal_customers (org_id, location_id, user_id, full_name) values (${org}, ${loc!.id}, ${ids.s}, 'S') returning id`
      const appt = async () => (await tx<{ id: string; created_at: Date }[]>`
        insert into sal_appointments (org_id, location_id, customer_id, service_id, scheduled_start, scheduled_end, state)
        values (${org}, ${loc!.id}, ${cust!.id}, ${svc!.id}, now() + interval '1 day', now() + interval '1 day 30 minutes', 'booked')
        returning id, created_at`)[0]!
      const read = async (id: string) => (await tx<{ state: string; created_at: Date; cancelled_at: Date | null; cancel_reason: string | null }[]>`
        select state, created_at, cancelled_at, cancel_reason from sal_appointments where id = ${id}`)[0]!
      const a1 = await appt()
      const sneak = await as(tx, 's', () => tx`update sal_appointments
        set cancel_reason = 'sneaky', cancelled_at = ${OLD}, created_at = ${OLD} where id = ${a1.id}`)
      const sneaked = await read(a1.id)
      const cancel = await as(tx, 's', () => tx`update sal_appointments
        set state = 'cancelled', cancel_reason = 'sick', cancelled_at = ${OLD} where id = ${a1.id}`)
      const cancelled = await read(a1.id)
      const a2 = await appt()
      const op = await as(tx, 'a', () => tx`update sal_appointments set created_at = ${OLD}, cancel_reason = 'op' where id = ${a2.id}`)
      return { a1, sneak, sneaked, cancel, cancelled, op, opRow: await read(a2.id) }
    })
    expect(r.sneak).toEqual({ error: null, rows: 1 })
    expect(r.sneaked).toMatchObject({ state: 'booked', cancelled_at: null, cancel_reason: null })
    expect(r.sneaked.created_at.getTime()).toBe(r.a1.created_at.getTime())
    expect(r.cancel, 'CONTROL: the customer may cancel').toEqual({ error: null, rows: 1 })
    expect(r.cancelled).toMatchObject({ state: 'cancelled', cancel_reason: 'sick' })
    expect(year(r.cancelled.cancelled_at)).toBeGreaterThan(2020)
    expect(r.op).toEqual({ error: null, rows: 1 })
    expect(year(r.opRow.created_at), 'CONTROL: an operator may still set it').toBe(2000)
    expect(r.opRow.cancel_reason).toBe('op')
  })

  // ---- Re-review follow-ups (section 10) -----------------------------------

  /** Grant `user` a classroom professor role scoped to one class. */
  async function professorOf(tx: Tx, org: string, user: Who, classId: string) {
    await tx`insert into module_roles (org_id, user_id, module_key, role, scope_ref)
             values (${org}, ${ids[user]}, 'classroom', 'professor',
                     (select scope_node_id from cls_classes where id = ${classId}))`
  }

  it("cls_submissions UPDATE: a professor of class B is just a student in class A — pinned, incl. ON CONFLICT DO UPDATE (control: class A's professor can)", async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const cls = await makeClassroom(tx, org)
      await professorOf(tx, org, 's', cls.c2) // s: student of c1, professor of c2
      await professorOf(tx, org, 'm', cls.c1) // m: professor of c1 (control)
      const sub = await submission(tx, org, cls, 's')
      const read = async () => (await tx<{ visible_override_until: Date | null; submitted_at: Date; created_at: Date; storage_prefix: string | null }[]>`
        select visible_override_until, submitted_at, created_at, storage_prefix from cls_submissions where id = ${sub}`)[0]!
      const before = await read()
      const upd = await as(tx, 's', () => tx`update cls_submissions
        set visible_override_until = ${FAR}, submitted_at = ${OLD}, created_at = ${OLD}, storage_prefix = 'x/y' where id = ${sub}`)
      const afterUpd = await read()
      const upsert = await as(tx, 's', () => tx`
        insert into cls_submissions (org_id, homework_id, class_id, student_id)
        values (${org}, ${cls.hw}, ${cls.c1}, ${ids.s})
        on conflict (homework_id, student_id) do update
          set visible_override_until = ${FAR}, submitted_at = ${OLD}, created_at = ${OLD}, storage_prefix = 'x/y'`)
      const afterUpsert = await read()
      const ctl = await as(tx, 'm', () => tx`update cls_submissions set visible_override_until = ${FAR} where id = ${sub}`)
      return { before, upd, afterUpd, upsert, afterUpsert, ctl, afterCtl: await read() }
    })
    for (const [k, res, row] of [['update', r.upd, r.afterUpd], ['upsert', r.upsert, r.afterUpsert]] as const) {
      expect(res, `${k} reaches the row`).toEqual({ error: null, rows: 1 })
      expect(row.visible_override_until, k).toBeNull()
      expect(row.storage_prefix, k).toBeNull()
      expect(row.submitted_at.getTime(), k).toBe(r.before.submitted_at.getTime())
      expect(row.created_at.getTime(), k).toBe(r.before.created_at.getTime())
    }
    expect(r.ctl).toEqual({ error: null, rows: 1 })
    expect(year(r.afterCtl.visible_override_until), "CONTROL: class A's professor may set the override").toBe(2099)
  })

  it("cls_review_assignments UPDATE: a reviewer who professors another class cannot re-point their assignment (control: class A's professor can)", async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const cls = await makeClassroom(tx, org)
      await professorOf(tx, org, 's', cls.c2)
      await professorOf(tx, org, 'm', cls.c1)
      const dSub = await submission(tx, org, cls, 'd')
      const aSub = await submission(tx, org, cls, 'a')
      const [ra] = await tx<{ id: string }[]>`
        insert into cls_review_assignments (org_id, homework_id, class_id, reviewer_id, submission_id)
        values (${org}, ${cls.hw}, ${cls.c1}, ${ids.s}, ${dSub}) returning id`
      const read = async () => (await tx<{ submission_id: string }[]>`select submission_id from cls_review_assignments where id = ${ra!.id}`)[0]!.submission_id
      const res = await as(tx, 's', () => tx`update cls_review_assignments set submission_id = ${aSub}, grade = 5 where id = ${ra!.id}`)
      const grade = (await tx<{ grade: number | null }[]>`select grade from cls_review_assignments where id = ${ra!.id}`)[0]!.grade
      const after = await read()
      const ctl = await as(tx, 'm', () => tx`update cls_review_assignments set submission_id = ${aSub} where id = ${ra!.id}`)
      return { res, grade, after, ctl, afterCtl: await read(), dSub, aSub }
    })
    expect(r.res).toEqual({ error: null, rows: 1 })
    expect(Number(r.grade), 'CONTROL: the same UPDATE did land').toBe(5)
    expect(r.after).toBe(r.dSub)
    expect(r.ctl).toEqual({ error: null, rows: 1 })
    expect(r.afterCtl, "CONTROL: class A's professor may re-point it").toBe(r.aSub)
  })

  it('cls_submission_files: no "..", "." or empty segment anywhere in the path (control: the app shape still lands)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const cls = await makeClassroom(tx, org)
      const sSub = await submission(tx, org, cls, 's')
      const dSub = await submission(tx, org, cls, 'd')
      const base = `${org}/${cls.c1}/${sSub}`
      const ins = (path: string) => as(tx, 's', () => tx`
        insert into cls_submission_files (org_id, class_id, submission_id, file_name, storage_path)
        values (${org}, ${cls.c1}, ${sSub}, 'f.pdf', ${path})`)
      return {
        dotdot: await ins(`${base}/../${dSub}/1-f.pdf`),
        dot: await ins(`${base}/./1-f.pdf`),
        empty: await ins(`${base}//1-f.pdf`),
        trailing: await ins(`${base}/sub/`),
        ok: await ins(`${base}/1700000000000-f.pdf`),
      }
    })
    for (const k of ['dotdot', 'dot', 'empty', 'trailing'] as const) {
      expect(r[k].error, k).toMatch(/does not belong to this submission/)
    }
    expect(r.ok, 'CONTROL').toEqual({ error: null, rows: 1 })
  })

  it('cls_review_comments: created_at is server-set on INSERT; an author cannot move a comment to another submission (control: body edits land; staff can move)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const cls = await makeClassroom(tx, org)
      const dSub = await submission(tx, org, cls, 'd')
      const aSub = await submission(tx, org, cls, 'a')
      await tx`insert into cls_review_assignments (org_id, homework_id, class_id, reviewer_id, submission_id)
               values (${org}, ${cls.hw}, ${cls.c1}, ${ids.s}, ${dSub})`
      const id = randomUUID()
      const ins = await as(tx, 's', () => tx`
        insert into cls_review_comments (id, org_id, submission_id, class_id, author_id, file_path, line_start, line_end, body, created_at)
        values (${id}, ${org}, ${dSub}, ${cls.c1}, ${ids.s}, 'main.py', 1, 1, 'nice', ${OLD})`)
      const read = async () => (await tx<{ submission_id: string; body: string; created_at: Date }[]>`
        select submission_id, body, created_at from cls_review_comments where id = ${id}`)[0]!
      const inserted = await read()
      const move = await as(tx, 's', () => tx`update cls_review_comments set submission_id = ${aSub}, body = 'edited', created_at = ${OLD} where id = ${id}`)
      const moved = await read()
      const staff = await as(tx, 'a', () => tx`update cls_review_comments set submission_id = ${aSub} where id = ${id}`)
      return { ins, inserted, move, moved, staff, staffRow: await read(), dSub, aSub }
    })
    expect(r.ins).toEqual({ error: null, rows: 1 })
    expect(year(r.inserted.created_at)).toBeGreaterThan(2020)
    expect(r.move).toEqual({ error: null, rows: 1 })
    expect(r.moved.body, 'CONTROL: the edit landed').toBe('edited')
    expect(r.moved.submission_id).toBe(r.dSub)
    expect(r.moved.created_at.getTime()).toBe(r.inserted.created_at.getTime())
    expect(r.staff).toEqual({ error: null, rows: 1 })
    expect(r.staffRow.submission_id, 'CONTROL: staff may move it').toBe(r.aSub)
  })

  it('smp_items / vm_reactions / vm_conversations: created_at is server-set on INSERT for non-staff (control: the rows land; staff keep a supplied value)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      await tx`insert into module_roles (org_id, user_id, module_key, role) values (${org}, ${ids.s}, 'sample', 'member')`
      await tx`insert into module_roles (org_id, user_id, module_key, role) values (${org}, ${ids.s}, 'visual-messaging', 'member')`
      const [proj] = await tx<{ id: string }[]>`insert into smp_projects (org_id, name) values (${org}, 'P') returning id`
      const item = randomUUID()
      const itemRes = await as(tx, 's', () => tx`
        insert into smp_items (id, org_id, project_id, author_id, body, created_at) values (${item}, ${org}, ${proj!.id}, ${ids.s}, 'b', ${OLD})`)
      const staffItem = randomUUID()
      const staffItemRes = await as(tx, 'a', () => tx`
        insert into smp_items (id, org_id, project_id, author_id, body, created_at) values (${staffItem}, ${org}, ${proj!.id}, ${ids.a}, 'b', ${OLD})`)
      const conv = randomUUID()
      const convRes = await as(tx, 's', () => tx`
        insert into vm_conversations (id, org_id, title, created_by, created_at) values (${conv}, ${org}, 'C', ${ids.s}, ${OLD})`)
      // A conversation to react in (owner-built so the fixture does not depend on the guard above).
      const [c2] = await tx<{ id: string }[]>`insert into vm_conversations (org_id, title) values (${org}, 'R') returning id`
      await tx`insert into vm_conversation_members (org_id, conversation_id, user_id, role, status)
               values (${org}, ${c2!.id}, ${ids.s}, 'participant', 'active')`
      const [layer] = await tx<{ id: string }[]>`
        insert into vm_layers (org_id, conversation_id, author_id, path, content) values (${org}, ${c2!.id}, ${ids.s}, 'x', '{}') returning id`
      const reaction = randomUUID()
      const reactRes = await as(tx, 's', () => tx`
        insert into vm_reactions (id, org_id, conversation_id, layer_id, user_id, kind, created_at)
        values (${reaction}, ${org}, ${c2!.id}, ${layer!.id}, ${ids.s}, 'heart', ${OLD})`)
      const ca = async (t: string, id: string) =>
        (await tx.unsafe<{ created_at: Date }[]>(`select created_at from ${t} where id = $1`, [id]))[0]?.created_at ?? null
      return {
        itemRes, staffItemRes, convRes, reactRes,
        item: await ca('smp_items', item), staffItem: await ca('smp_items', staffItem),
        conv: await ca('vm_conversations', conv), reaction: await ca('vm_reactions', reaction),
      }
    })
    for (const k of ['itemRes', 'staffItemRes', 'convRes', 'reactRes'] as const) {
      expect(r[k], k).toEqual({ error: null, rows: 1 })
    }
    expect(year(r.item)).toBeGreaterThan(2020)
    expect(year(r.conv)).toBeGreaterThan(2020)
    expect(year(r.reaction)).toBeGreaterThan(2020)
    expect(year(r.staffItem), 'CONTROL: a manager keeps a supplied value').toBe(2000)
  })

  it('trusted (no-JWT) inserts keep every supplied value: seed / worker / invite appliers are unaffected', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const cls = await makeClassroom(tx, org)
      const [sub] = await tx<{ visible_override_until: Date | null; submitted_at: Date }[]>`
        insert into cls_submissions (org_id, homework_id, class_id, student_id, visible_override_until, submitted_at)
        values (${org}, ${cls.hw}, ${cls.c1}, ${ids.s}, ${FAR}, ${OLD}) returning visible_override_until, submitted_at`
      await tx`insert into module_roles (org_id, user_id, module_key, role) values (${org}, ${ids.s}, 'matchmaking', 'single')`
      const [q] = await tx<{ admin_locks: unknown; approved_by: string | null }[]>`
        insert into mm_questions (org_id, text, scale_labels, admin_locks, status, approved_by)
        values (${org}, 'Seeded?', ${['a', 'b']}, '{"care":3}'::jsonb, 'approved', ${ids.a}) returning admin_locks, approved_by`
      return { sub: sub!, q: q! }
    })
    expect(year(r.sub.visible_override_until)).toBe(2099)
    expect(year(r.sub.submitted_at)).toBe(2000)
    expect(r.q).toEqual({ admin_locks: { care: 3 }, approved_by: ids.a })
  })
})
