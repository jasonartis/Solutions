import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'

// ---------------------------------------------------------------------------
// STAFF "View as" — migration 20261127010000. docs/13 "STAFF VIEW AS".
//
// Org staff (a classroom professor; a salon admin/manager) see a person's real
// screen, trimmed to their AREA. Every probe runs AS a real role inside a
// transaction that is ALWAYS rolled back; throwaway accounts are hard-deleted
// afterwards. Every refusal or empty result carries a control that shows the
// same thing is there without the view (or for a viewer who may).
//
//   v = viewer (professor / manager)   p = the person viewed
//   o = org owner   g = another professor   s = superadmin   x = an outsider
// ---------------------------------------------------------------------------

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const ownerDbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const sql = postgres(ownerDbUrl, { prepare: false, max: 1, onnotice: () => {} })
const admin = () => createClient(url, serviceKey, { auth: { persistSession: false } })

const who = ['v', 'p', 'o', 'g', 's', 'x'] as const
type Who = (typeof who)[number]
const ids: Record<Who, string> = { v: '', p: '', o: '', g: '', s: '', x: '' }

beforeAll(async () => {
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for this suite')
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  for (const k of who) {
    const { data, error } = await admin().auth.admin.createUser({
      email: `staffview-${k}-${tag}@demo.local`,
      password: 'password123',
      email_confirm: true,
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
type Outcome = { error: string | null; data: postgres.Row[] }

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

type AsOpts = { view?: string; actor?: Who; hook?: boolean; keep?: boolean }

/** Runs `stmt` as `user` (role authenticated), the way PostgREST would. */
async function as(tx: Tx, user: Who, stmt: () => Promise<postgres.RowList<postgres.Row[]>>, o: AsOpts = {}): Promise<Outcome> {
  await tx.unsafe('savepoint sp')
  let out: Outcome
  try {
    const claims: Record<string, unknown> = { sub: ids[user], role: 'authenticated' }
    if (o.view !== undefined) claims.view_as = { session: o.view, actor: ids[o.actor ?? 'v'] }
    await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`
    await tx.unsafe('set local role authenticated')
    if (o.hook ?? o.view !== undefined) await tx`select public.view_as_pre_request()`
    const r = await stmt()
    out = { error: null, data: [...r] }
  } catch (e: unknown) {
    out = { error: String((e as Error).message), data: [] }
  }
  if (out.error === null && o.keep) await tx.unsafe('release savepoint sp')
  else await tx.unsafe('rollback to savepoint sp')
  await tx.unsafe('reset role')
  await tx`select set_config('request.jwt.claims', '', true)`
  return out
}

function ok(o: Outcome): postgres.Row[] {
  expect(o.error).toBeNull()
  return o.data
}

type Fixture = {
  org: { id: string; slug: string }
  courseA: string
  classA: string
  nodeA: string
  courseB: string
  classB: string
  nodeB: string
  hwA: string
  hwB: string
}

/**
 * One org with classroom + nail-salon. Two courses, one class each (A, B).
 * p: student in A and B (scoped grants). o: owner. v, g: plain members (their
 * seats are added per test). Homeworks and grades for p in both classes.
 */
async function fixture(tx: Tx): Promise<Fixture> {
  const slug = 'staff-view-' + Date.now() + Math.random().toString(36).slice(2, 6)
  const [org] = await tx`insert into orgs (name, slug) values ('Staff view probe', ${slug}) returning id, slug`
  const orgId = org!.id as string
  for (const m of ['classroom', 'nail-salon']) await tx`insert into org_modules (org_id, module_key, enabled) values (${orgId}, ${m}, true)`
  await tx`insert into org_members (org_id, user_id, role, status) values (${orgId}, ${ids.o}, 'owner', 'active')`
  for (const k of ['v', 'p', 'g'] as const) {
    await tx`insert into org_members (org_id, user_id, role, status) values (${orgId}, ${ids[k]}, 'member', 'active')`
  }
  const [cA] = await tx`insert into cls_courses (org_id, name) values (${orgId}, 'Statistics') returning id`
  const [cB] = await tx`insert into cls_courses (org_id, name) values (${orgId}, 'Math') returning id`
  const [kA] = await tx`insert into cls_classes (org_id, course_id, name) values (${orgId}, ${cA!.id}, 'Stats A') returning id, scope_node_id`
  const [kB] = await tx`insert into cls_classes (org_id, course_id, name) values (${orgId}, ${cB!.id}, 'Math B') returning id, scope_node_id`
  for (const k of [kA!, kB!]) {
    await tx`insert into module_roles (org_id, user_id, module_key, role, scope_ref) values (${orgId}, ${ids.p}, 'classroom', 'student', ${k.scope_node_id})`
    await tx`insert into cls_class_members (org_id, class_id, user_id, role) values (${orgId}, ${k.id}, ${ids.p}, 'student')`
  }
  const [hA] = await tx`insert into cls_homeworks (org_id, class_id, title) values (${orgId}, ${kA!.id}, 'HW A') returning id`
  const [hB] = await tx`insert into cls_homeworks (org_id, class_id, title) values (${orgId}, ${kB!.id}, 'HW B') returning id`
  for (const [k, h] of [[kA!, hA!], [kB!, hB!]] as const) {
    await tx`insert into cls_grades (org_id, class_id, homework_id, student_id, source, score, is_final, visible)
             values (${orgId}, ${k.id}, ${h.id}, ${ids.p}, 'instructor', 90, true, true)`
  }
  return {
    org: { id: orgId, slug },
    courseA: cA!.id, classA: kA!.id, nodeA: kA!.scope_node_id,
    courseB: cB!.id, classB: kB!.id, nodeB: kB!.scope_node_id,
    hwA: hA!.id, hwB: hB!.id,
  }
}

/** A seat inserted by the owner connection (auth.uid() null → granted_by kept as given). */
async function seat(tx: Tx, f: Fixture, k: Who, module: string, role: string, scope: string | null = null, grantedBy: string | null = null) {
  await tx`insert into module_roles (org_id, user_id, module_key, role, scope_ref, granted_by)
           values (${f.org.id}, ${ids[k]}, ${module}, ${role}, ${scope}, ${grantedBy})`
}

async function start(tx: Tx, f: Fixture, viewer: Who = 'v', target: Who = 'p'): Promise<Outcome> {
  return as(tx, viewer, () => tx`select public.view_as_staff_start(${f.org.id}::uuid, ${ids[target]}::uuid) as id`, { keep: true })
}

async function startOk(tx: Tx, f: Fixture, viewer: Who = 'v', target: Who = 'p'): Promise<string> {
  const r = await start(tx, f, viewer, target)
  expect(r.error).toBeNull()
  return r.data[0]!.id as string
}

const idsOf = (rows: postgres.Row[]) => rows.map((r) => r.id as string).sort()

describe('who may start a staff view', () => {
  it('a professor (seat given by someone else) may view a student; the row is kind=staff, org set, module null', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      await seat(tx, f, 'v', 'classroom', 'professor')
      const id = await startOk(tx, f)
      const [row] = await tx`select kind, org_id, module_key, actor_user_id, target_user_id from view_as_real_sessions where id = ${id}`
      expect(row).toMatchObject({ kind: 'staff', org_id: f.org.id, module_key: null, actor_user_id: ids.v, target_user_id: ids.p })
    })
  })

  it('refuses: no seat, a peer (GA -> student), a self-given seat, oneself, from inside a view (each with a control)', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      // No seat at all.
      expect((await start(tx, f)).error).toMatch(/can't view/)
      // A GA is a peer of a student: no edge.
      await seat(tx, f, 'g', 'classroom', 'ga')
      expect((await start(tx, f, 'g')).error).toMatch(/can't view/)
      // A professor seat the viewer gave herself (answer 5).
      await seat(tx, f, 'v', 'classroom', 'professor', null, ids.v)
      expect((await start(tx, f)).error).toMatch(/can't view/)
      // Control: the same seat given by the owner works.
      await tx`update module_roles set granted_by = ${ids.o} where org_id = ${f.org.id} and user_id = ${ids.v}`
      const id = await startOk(tx, f)
      // Oneself; and never from inside a view.
      expect((await start(tx, f, 'v', 'v')).error).toMatch(/someone else/)
      const inside = await as(tx, 'p', () => tx`select public.view_as_staff_start(${f.org.id}::uuid, ${ids.p}::uuid)`, { view: id })
      expect(inside.error).toMatch(/Not allowed/)
    })
  })

  it('refuses a more powerful person: an org owner/admin, a superadmin, or someone holding a seat as high as the viewer (review R1)', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      await seat(tx, f, 'v', 'classroom', 'professor')
      // "Make the owner my student": o gets a student seat in A.
      await seat(tx, f, 'o', 'classroom', 'student', f.nodeA)
      expect((await start(tx, f, 'v', 'o')).error).toMatch(/can't view/)
      // An org admin likewise.
      await tx`update org_members set role = 'admin' where org_id = ${f.org.id} and user_id = ${ids.p}`
      expect((await start(tx, f)).error).toMatch(/can't view/)
      await tx`update org_members set role = 'member' where org_id = ${f.org.id} and user_id = ${ids.p}`
      // Control: p is viewable as a plain member.
      await startOk(tx, f)
      // p also holds a professor seat in B: as high as v's seat → refused.
      await seat(tx, f, 'p', 'classroom', 'professor', f.nodeB)
      expect((await start(tx, f)).error).toMatch(/can't view/)
      await tx`delete from module_roles where org_id = ${f.org.id} and user_id = ${ids.p} and role = 'professor'`
      // A superadmin person.
      await tx`update user_private set is_superadmin = true where user_id = ${ids.p}`
      expect((await start(tx, f)).error).toMatch(/can't view/)
    })
  })

  it('refuses a person who is not an active member, and a viewer who is not one', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      await seat(tx, f, 'v', 'classroom', 'professor')
      await startOk(tx, f)
      await tx`update org_members set status = 'pending' where org_id = ${f.org.id} and user_id = ${ids.p}`
      expect((await start(tx, f)).error).toMatch(/can't view/)
      await tx`update org_members set status = 'active' where org_id = ${f.org.id} and user_id = ${ids.p}`
      await tx`update org_members set status = 'pending' where org_id = ${f.org.id} and user_id = ${ids.v}`
      expect((await start(tx, f)).error).toMatch(/can't view/)
    })
  })

  it('a scoped professor cannot view a student of a class she does not cover; a seat in another org gives nothing', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      const g = await fixture(tx) // a second org; v is a member there too
      // v is professor of B only in org g; in org f she has nothing.
      await tx`insert into module_roles (org_id, user_id, module_key, role, scope_ref) values (${g.org.id}, ${ids.v}, 'classroom', 'professor', ${g.nodeB})`
      expect((await start(tx, f)).error).toMatch(/can't view/)
      // p in org g studies in A and B; v covers B → allowed there (control).
      await startOk(tx, g)
      // A student who is only in A of org g: not covered.
      await tx`delete from module_roles where org_id = ${g.org.id} and user_id = ${ids.p} and scope_ref = ${g.nodeB}`
      expect((await start(tx, g)).error).toMatch(/can't view/)
    })
  })
})

describe('granted_by is stamped by the server', () => {
  it('a signed-in caller always becomes granted_by; an owner who gives herself a seat cannot use it to view', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      // The owner gives v a professor seat, claiming someone else granted it.
      ok(await as(tx, 'o', () => tx`insert into module_roles (org_id, user_id, module_key, role, granted_by)
                                     values (${f.org.id}, ${ids.v}, 'classroom', 'professor', ${ids.x})`, { keep: true }))
      const [r1] = await tx`select granted_by from module_roles where org_id = ${f.org.id} and user_id = ${ids.v}`
      expect(r1!.granted_by).toBe(ids.o)
      // ...so v may view (given by o).
      await startOk(tx, f)
      // The owner gives HERSELF the seat: stamped as hers → cannot view.
      ok(await as(tx, 'o', () => tx`insert into module_roles (org_id, user_id, module_key, role)
                                     values (${f.org.id}, ${ids.o}, 'classroom', 'professor')`, { keep: true }))
      const [r2] = await tx`select granted_by from module_roles where org_id = ${f.org.id} and user_id = ${ids.o} and role = 'professor'`
      expect(r2!.granted_by).toBe(ids.o)
      expect((await start(tx, f, 'o')).error).toMatch(/can't view/)
      // An update that does not change the seat keeps granted_by; one that does, re-stamps it.
      ok(await as(tx, 'o', () => tx`update module_roles set granted_by = ${ids.x} where org_id = ${f.org.id} and user_id = ${ids.v}`, { keep: true }))
      const [r3] = await tx`select granted_by from module_roles where org_id = ${f.org.id} and user_id = ${ids.v}`
      expect(r3!.granted_by).toBe(ids.o)
    })
  })
})

describe('what a staff view reads', () => {
  it('rows: a professor scoped to A sees the person in A only; a global professor sees both (controls: the person sees both)', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      // Control: as himself, p sees both classes, homeworks and grades.
      const own = ok(await as(tx, 'p', () => tx`select id from cls_classes where org_id = ${f.org.id}`))
      expect(idsOf(own)).toEqual([f.classA, f.classB].sort())

      await seat(tx, f, 'v', 'classroom', 'professor', f.nodeA)
      const id = await startOk(tx, f)
      const q = (t: string) => () => tx.unsafe(`select id from ${t} where org_id = '${f.org.id}'`)
      expect(idsOf(ok(await as(tx, 'p', q('cls_classes'), { view: id })))).toEqual([f.classA])
      expect(idsOf(ok(await as(tx, 'p', q('cls_homeworks'), { view: id })))).toEqual([f.hwA])
      const grades = ok(await as(tx, 'p', () => tx`select homework_id from cls_grades where org_id = ${f.org.id}`, { view: id }))
      expect(grades.map((r) => r.homework_id)).toEqual([f.hwA])

      // A global professor (g) covers both.
      await seat(tx, f, 'g', 'classroom', 'professor')
      const idG = await startOk(tx, f, 'g')
      expect(idsOf(ok(await as(tx, 'p', q('cls_classes'), { view: idG, actor: 'g' })))).toEqual([f.classA, f.classB].sort())
    })
  })

  it('THE KEYSTONE: on every cls_ table, what the staff view returns is a subset of what the viewer reads herself', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      await seat(tx, f, 'v', 'classroom', 'professor', f.nodeA)
      await tx`insert into cls_class_members (org_id, class_id, user_id, role) values (${f.org.id}, ${f.classA}, ${ids.v}, 'professor')`
      const id = await startOk(tx, f)
      const tables = await tx`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                               where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'cls\\_%'
                                 and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'id')`
      expect(tables.length).toBeGreaterThan(10)
      let nonEmpty = 0
      for (const { relname } of tables) {
        const viewed = ok(await as(tx, 'p', () => tx.unsafe(`select id from public.${relname}`), { view: id }))
        const hers = ok(await as(tx, 'v', () => tx.unsafe(`select id from public.${relname}`)))
        const herSet = new Set(hers.map((r) => r.id as string))
        const extra = viewed.filter((r) => !herSet.has(r.id as string))
        expect(extra, `${relname}: rows in the staff view the viewer cannot read herself`).toEqual([])
        if (viewed.length > 0) nonEmpty++
      }
      // Non-vacuous: the view did return rows on several tables.
      expect(nonEmpty).toBeGreaterThanOrEqual(3)
    })
  })

  it('role booleans see only in-area grants: a GA seat outside the area is invisible (control: a viewer who covers it)', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      await seat(tx, f, 'p', 'classroom', 'ga', f.nodeB)
      // Control: as himself, p is a GA.
      expect(ok(await as(tx, 'p', () => tx`select public.cls_is_ga(${f.org.id}::uuid) as v`))[0]!.v).toBe(true)
      await seat(tx, f, 'v', 'classroom', 'professor', f.nodeA)
      const id = await startOk(tx, f)
      expect(ok(await as(tx, 'p', () => tx`select public.cls_is_ga(${f.org.id}::uuid) as v`, { view: id }))[0]!.v).toBe(false)
      const seats = ok(await as(tx, 'p', () => tx`select role, scope_ref from module_roles where org_id = ${f.org.id}`, { view: id }))
      expect(seats).toEqual([{ role: 'student', scope_ref: f.nodeA }])
      // A global professor covers B, and professor -> GA is an edge.
      await seat(tx, f, 'g', 'classroom', 'professor')
      const idG = await startOk(tx, f, 'g')
      expect(ok(await as(tx, 'p', () => tx`select public.cls_is_ga(${f.org.id}::uuid) as v`, { view: idG, actor: 'g' }))[0]!.v).toBe(true)
    })
  })

  it('modules outside the area are dark; feedback is dark; other orgs are dark (controls without the view)', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      // p is a salon customer: no edge, so nail-salon is not in v's area.
      await seat(tx, f, 'p', 'nail-salon', 'customer')
      const [loc] = await tx`insert into sal_locations (org_id, name) values (${f.org.id}, 'Downtown') returning id`
      await tx`insert into feedback_tickets (created_by, kind, title) values (${ids.p}, 'bug', 'probe')`
      await seat(tx, f, 'v', 'classroom', 'professor')
      const id = await startOk(tx, f)
      // Controls as p.
      expect(ok(await as(tx, 'p', () => tx`select id from sal_locations where id = ${loc!.id}`)).length).toBe(1)
      expect(ok(await as(tx, 'p', () => tx`select id from feedback_tickets where created_by = ${ids.p}`)).length).toBe(1)
      // Under the staff view.
      expect(ok(await as(tx, 'p', () => tx`select id from sal_locations where id = ${loc!.id}`, { view: id }))).toEqual([])
      expect(ok(await as(tx, 'p', () => tx`select id from feedback_tickets where created_by = ${ids.p}`, { view: id }))).toEqual([])
      const seats = ok(await as(tx, 'p', () => tx`select module_key from module_roles where org_id = ${f.org.id}`, { view: id }))
      expect(seats.map((r) => r.module_key)).toEqual(['classroom', 'classroom'])
      // Another org's classroom: p is a student there, v is not staff there.
      const g = await fixture(tx)
      expect(ok(await as(tx, 'p', () => tx`select id from cls_classes where org_id = ${g.org.id}`))).toHaveLength(2)
      expect(ok(await as(tx, 'p', () => tx`select id from cls_classes where org_id = ${g.org.id}`, { view: id }))).toEqual([])
      // Every other module: view_as_may_read is false.
      for (const m of ['speed-dating', 'matchmaking', 'visual-messaging', 'synagogue-schedules', 'nail-salon']) {
        expect(ok(await as(tx, 'p', () => tx`select public.view_as_may_read(${f.org.id}::uuid, ${m}) as v`, { view: id }))[0]!.v, m).toBe(false)
      }
      expect(ok(await as(tx, 'p', () => tx`select public.view_as_may_read(${f.org.id}::uuid, 'classroom') as v`, { view: id }))[0]!.v).toBe(true)
    })
  })

  it('a salon manager scoped to one location sees the worker at that location only', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      const [l1] = await tx`insert into sal_locations (org_id, name) values (${f.org.id}, 'Downtown') returning id, scope_node_id`
      const [l2] = await tx`insert into sal_locations (org_id, name) values (${f.org.id}, 'Uptown') returning id, scope_node_id`
      // A worker at Downtown (a scoped manager covers only scoped seats under her: a node never covers global).
      await seat(tx, f, 'p', 'nail-salon', 'worker', l1!.scope_node_id)
      await seat(tx, f, 'v', 'nail-salon', 'manager', l1!.scope_node_id)
      const [s1] = await tx`insert into sal_services (org_id, location_id, name, approx_duration_minutes) values (${f.org.id}, ${l1!.id}, 'Gel', 30) returning id`
      await tx`insert into sal_services (org_id, location_id, name, approx_duration_minutes) values (${f.org.id}, ${l2!.id}, 'Gel', 30)`
      expect(ok(await as(tx, 'p', () => tx`select id from sal_services where org_id = ${f.org.id}`))).toHaveLength(2)
      const id = await startOk(tx, f)
      expect(idsOf(ok(await as(tx, 'p', () => tx`select id from sal_services where org_id = ${f.org.id}`, { view: id })))).toEqual([s1!.id])
      expect(idsOf(ok(await as(tx, 'p', () => tx`select id from sal_locations where org_id = ${f.org.id}`, { view: id })))).toEqual([l1!.id])
      // Classroom is NOT in the area (v has no classroom seat): dark.
      expect(ok(await as(tx, 'p', () => tx`select id from cls_classes where org_id = ${f.org.id}`, { view: id }))).toEqual([])
    })
  })

  it('the two classroom definers check the area (control: the person sees his comments)', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      const [sub] = await tx`insert into cls_submissions (org_id, class_id, homework_id, student_id) values (${f.org.id}, ${f.classB}, ${f.hwB}, ${ids.p}) returning id`
      await tx`insert into cls_review_comments (org_id, class_id, submission_id, author_id, file_path, body) values (${f.org.id}, ${f.classB}, ${sub!.id}, ${ids.o}, 'a.R', 'nice')`
      expect(ok(await as(tx, 'p', () => tx`select * from public.cls_comments_for_my_submission(${sub!.id}::uuid)`))).toHaveLength(1)
      await seat(tx, f, 'v', 'classroom', 'professor', f.nodeA)
      const id = await startOk(tx, f)
      expect(ok(await as(tx, 'p', () => tx`select * from public.cls_comments_for_my_submission(${sub!.id}::uuid)`, { view: id }))).toEqual([])
    })
  })
})

describe('liveness, kinds and the check', () => {
  it('the view stops at once when the viewer loses her seat, the person becomes an admin, or the org is deleted', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      await seat(tx, f, 'v', 'classroom', 'professor')
      const id = await startOk(tx, f)
      const read = () => as(tx, 'p', () => tx`select id from cls_classes where org_id = ${f.org.id}`, { view: id })
      expect(ok(await read())).toHaveLength(2)
      await tx`update org_members set role = 'admin' where org_id = ${f.org.id} and user_id = ${ids.p}`
      expect(ok(await read())).toEqual([])
      await tx`update org_members set role = 'member' where org_id = ${f.org.id} and user_id = ${ids.p}`
      expect(ok(await read())).toHaveLength(2)
      await tx`delete from module_roles where org_id = ${f.org.id} and user_id = ${ids.v}`
      expect(ok(await read())).toEqual([])
      // Org deleted: the row's org_id becomes NULL — dead, never a whole-account view (R3).
      await seat(tx, f, 'v', 'classroom', 'professor')
      await tx`delete from orgs where id = ${f.org.id}`
      const [row] = await tx`select org_id, kind from view_as_real_sessions where id = ${id}`
      expect(row).toMatchObject({ org_id: null, kind: 'staff' })
      const probe = ok(await as(tx, 'p', () => tx`select public.view_as_platform_ok() as pl, public.view_as_may_read(gen_random_uuid(), 'classroom') as mr`, { view: id }))
      expect(probe[0]).toEqual({ pl: false, mr: false })
    })
  })

  it('a staff session never satisfies the platform branch, even when the viewer is a superadmin', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      await tx`insert into org_members (org_id, user_id, role, status) values (${f.org.id}, ${ids.s}, 'member', 'active')`
      await tx`update user_private set is_superadmin = true where user_id = ${ids.s}`
      await seat(tx, f, 's', 'classroom', 'professor', f.nodeA)
      const id = await startOk(tx, f, 's')
      const r = ok(await as(tx, 'p', () => tx`select public.view_as_platform_ok() as pl, public.view_as_may_read(${f.org.id}::uuid, 'speed-dating') as sd`, { view: id, actor: 's' }))
      expect(r[0]).toEqual({ pl: false, sd: false })
      expect(idsOf(ok(await as(tx, 'p', () => tx`select id from cls_classes where org_id = ${f.org.id}`, { view: id, actor: 's' })))).toEqual([f.classA])
      // Control: a whole-account (platform) session by the same superadmin reads both.
      const pid = ok(await as(tx, 's', () => tx`select public.view_as_real_start(${ids.p}::uuid) as id`, { keep: true }))[0]!.id as string
      expect(ok(await as(tx, 'p', () => tx`select id from cls_classes where org_id = ${f.org.id}`, { view: pid, actor: 's' }))).toHaveLength(2)
    })
  })

  it('view_as_real_check: kind staff, area modules, in scope only on the area module pages of that org', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      await seat(tx, f, 'v', 'classroom', 'professor')
      const id = await startOk(tx, f)
      const check = async (path: string) =>
        ok(await as(tx, 'v', () => tx`select kind, area_modules, in_scope, org_slug, module_key from public.view_as_real_check(${id}::uuid, ${path}, false)`))[0]
      const base = `/o/${f.org.slug}`
      expect(await check(`${base}/m/classroom`)).toMatchObject({ kind: 'staff', area_modules: ['classroom'], in_scope: true, org_slug: f.org.slug, module_key: null })
      expect((await check(`${base}/m/classroom/homework/x`))!.in_scope).toBe(true)
      for (const p of [base, `${base}/m/classroom/view-as`, `${base}/m/classroom/view-as/x`, `${base}/members`, `${base}/m/nail-salon`, `${base}/m/classroomx`, `/o/${f.org.slug}x/m/classroom`, '/dashboard', '/account', '/console']) {
        expect((await check(p))!.in_scope, p).toBe(false)
      }
      // Only the session's own actor gets an answer.
      expect(ok(await as(tx, 'x', () => tx`select * from public.view_as_real_check(${id}::uuid, ${base + '/m/classroom'}, false)`))).toEqual([])
      // The actor may end it; then the check answers nothing.
      ok(await as(tx, 'v', () => tx`select public.view_as_real_end(${id}::uuid)`, { keep: true }))
      expect(ok(await as(tx, 'v', () => tx`select * from public.view_as_real_check(${id}::uuid, ${base + '/m/classroom'}, false)`))).toEqual([])
    })
  })

  it('view_as_staff_targets lists exactly the people the caller may view in that module', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      await seat(tx, f, 'v', 'classroom', 'professor', f.nodeA)
      await seat(tx, f, 'o', 'classroom', 'student', f.nodeA) // an owner: never listed
      await seat(tx, f, 'g', 'classroom', 'ga', f.nodeB)       // outside v's scope: not listed
      const rows = ok(await as(tx, 'v', () => tx`select user_id, roles from public.view_as_staff_targets(${f.org.id}::uuid, 'classroom')`))
      expect(rows).toEqual([{ user_id: ids.p, roles: ['student'] }])
      // A plain student lists nobody.
      expect(ok(await as(tx, 'p', () => tx`select * from public.view_as_staff_targets(${f.org.id}::uuid, 'classroom')`))).toEqual([])
    })
  })

  it('org admins read their org\'s staff sessions; other members do not (the permanent record, answer 1A)', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      await seat(tx, f, 'v', 'classroom', 'professor')
      const id = await startOk(tx, f)
      expect(ok(await as(tx, 'o', () => tx`select id from view_as_real_sessions where id = ${id}`))).toHaveLength(1)
      expect(ok(await as(tx, 'g', () => tx`select id from view_as_real_sessions where id = ${id}`))).toEqual([])
      expect(ok(await as(tx, 'p', () => tx`select id from view_as_real_sessions where id = ${id}`))).toEqual([])
    })
  })

  it('a staff view is read-only, and the shared rules never raise on odd claims', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      await seat(tx, f, 'v', 'classroom', 'professor')
      const id = await startOk(tx, f)
      const w = await as(tx, 'p', () => tx`update cls_class_members set role = role where org_id = ${f.org.id}`, { view: id })
      expect(w.error).toMatch(/read-only transaction/)
      // Control: without the view, the same statement runs.
      expect((await as(tx, 'p', () => tx`update cls_class_members set role = role where user_id = ${ids.p}`)).error).toBeNull()
      for (const claims of ['not json', '{"view_as":{"session":"nope"}}', '{"sub":"x","view_as":1}']) {
        await tx`select set_config('request.jwt.claims', ${claims}, true)`
        const [r] = await tx`select public.view_as_may_read_in(gen_random_uuid(), 'classroom', null) as a,
                                    public.view_as_grant_visible(gen_random_uuid(), 'classroom', null) as b`
        expect(r, claims).toBeDefined()
      }
      await tx`select set_config('request.jwt.claims', '', true)`
    })
  })
})
