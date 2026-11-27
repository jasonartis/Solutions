import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'

// ---------------------------------------------------------------------------
// STAFF "View as" — second wave (migration review 2026-11-26, docs/13 "STAFF
// VIEW AS — AS BUILT"): files, org-level rows, a full keystone, salon,
// liveness, cross-module powers, speed and odd claims. Same harness as
// view-as-staff.test.ts: every probe runs AS a real role inside a transaction
// that is ALWAYS rolled back; every refusal carries a control.
//
//   v = viewer   p = the person viewed   o = org owner   g = another member
//   s = superadmin   x = an outsider
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
      email: `staffview2-${k}-${tag}@demo.local`,
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

type AsOpts = { view?: string; actor?: Who; keep?: boolean }

async function as(tx: Tx, user: Who, stmt: () => Promise<postgres.RowList<postgres.Row[]>>, o: AsOpts = {}): Promise<Outcome> {
  await tx.unsafe('savepoint sp')
  let out: Outcome
  try {
    const claims: Record<string, unknown> = { sub: ids[user], role: 'authenticated' }
    if (o.view !== undefined) claims.view_as = { session: o.view, actor: ids[o.actor ?? 'v'] }
    await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`
    await tx.unsafe('set local role authenticated')
    if (o.view !== undefined) await tx`select public.view_as_pre_request()`
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

const idsOf = (rows: postgres.Row[]) => rows.map((r) => r.id as string).sort()

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

async function fixture(tx: Tx): Promise<Fixture> {
  const slug = 'staff-view2-' + Date.now() + Math.random().toString(36).slice(2, 6)
  const [org] = await tx`insert into orgs (name, slug) values ('Staff view probe 2', ${slug}) returning id, slug`
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

/** p's rows in classes A and B on every classroom table, plus their files in storage. */
async function fullClassroom(tx: Tx, f: Fixture) {
  const out = {} as Record<'A' | 'B', { sub: string; file: string; paper: string; material: string; survey: string }>
  for (const [key, cls, course, hw] of [['A', f.classA, f.courseA, f.hwA], ['B', f.classB, f.courseB, f.hwB]] as const) {
    const org = f.org.id
    await tx`insert into cls_announcements (org_id, class_id, body) values (${org}, ${cls}, ${'news ' + key})`
    const [sv] = await tx`insert into cls_surveys (org_id, class_id, question, results_visible) values (${org}, ${cls}, 'Pace?', true) returning id`
    await tx`insert into cls_survey_answers (org_id, survey_id, class_id, user_id, answer) values (${org}, ${sv!.id}, ${cls}, ${ids.p}, 'ok')`
    const [sub] = await tx`insert into cls_submissions (org_id, class_id, homework_id, student_id) values (${org}, ${cls}, ${hw}, ${ids.p}) returning id`
    const file = `${org}/${cls}/${sub!.id}/work-${key}.R`
    await tx`insert into cls_submission_files (org_id, submission_id, class_id, file_name, storage_path) values (${org}, ${sub!.id}, ${cls}, 'work.R', ${file})`
    await tx`insert into storage.objects (bucket_id, name) values ('cls-submissions', ${file})`
    await tx`insert into cls_review_assignments (org_id, homework_id, class_id, reviewer_id, submission_id) values (${org}, ${hw}, ${cls}, ${ids.p}, ${sub!.id})`
    await tx`insert into cls_review_comments (org_id, class_id, submission_id, author_id, file_path, body) values (${org}, ${cls}, ${sub!.id}, ${ids.o}, 'work.R', 'good')`
    const mpath = `${org}/${course}/notes-${key}.pdf`
    const [mat] = await tx`insert into cls_materials (org_id, course_id, kind, title, storage_path) values (${org}, ${course}, 'lecture', ${'Notes ' + key}, ${mpath}) returning id`
    await tx`insert into storage.objects (bucket_id, name) values ('cls-materials', ${mpath})`
    await tx`insert into cls_publications (org_id, class_id, material_id) values (${org}, ${cls}, ${mat!.id})`
    const [ex] = await tx`insert into cls_exams (org_id, class_id, title) values (${org}, ${cls}, ${'Exam ' + key}) returning id`
    const paper = `${org}/${cls}/${ex!.id}/paper-${key}.pdf`
    await tx`insert into cls_exam_papers (org_id, exam_id, class_id, student_id, storage_path) values (${org}, ${ex!.id}, ${cls}, ${ids.p}, ${paper})`
    await tx`insert into storage.objects (bucket_id, name) values ('cls-exams', ${paper})`
    out[key] = { sub: sub!.id, file, paper, material: mat!.id, survey: sv!.id }
  }
  return out
}

describe('the full keystone, files and org-level rows', () => {
  it('KEYSTONE (full): on every cls_ table with a class, the A-scoped view returns class A rows only, and only rows the viewer reads herself', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      await fullClassroom(tx, f)
      await seat(tx, f, 'v', 'classroom', 'professor', f.nodeA)
      await tx`insert into cls_class_members (org_id, class_id, user_id, role) values (${f.org.id}, ${f.classA}, ${ids.v}, 'professor')`
      const id = await startOk(tx, f)
      const tables = (await tx`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                               where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'cls\\_%'
                                 and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'class_id')
                               order by 1`).map((r) => r.relname as string)
      const nonEmpty: string[] = []
      for (const t of tables) {
        const q = () => tx.unsafe(`select id, class_id from public.${t} where org_id = '${f.org.id}'`)
        const own = ok(await as(tx, 'p', q))
        const viewed = ok(await as(tx, 'p', q, { view: id }))
        const hers = new Set(ok(await as(tx, 'v', () => tx.unsafe(`select id from public.${t}`))).map((r) => r.id as string))
        expect(viewed.filter((r) => r.class_id !== f.classA), `${t}: a class-B row in the A-scoped view`).toEqual([])
        expect(viewed.filter((r) => !hers.has(r.id as string)), `${t}: rows the viewer cannot read herself`).toEqual([])
        if (own.some((r) => r.class_id === f.classB) && viewed.length > 0) nonEmpty.push(t)
      }
      // Non-vacuous: these all had the person's rows in BOTH classes and showed the A ones.
      for (const t of ['cls_announcements', 'cls_class_members', 'cls_exams', 'cls_grades', 'cls_homeworks', 'cls_publications',
        'cls_submission_files', 'cls_submissions', 'cls_survey_answers', 'cls_surveys']) {
        expect(nonEmpty, t).toContain(t)
      }
    })
  })

  it('FILES: only files whose row is in the area are readable (controls as the person); other buckets are dark', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      const r = await fullClassroom(tx, f)
      await tx`insert into storage.objects (bucket_id, name) values ('syn-exports', ${f.org.id + '/week.pdf'})`
      await seat(tx, f, 'v', 'classroom', 'professor', f.nodeA)
      const id = await startOk(tx, f)
      const files = (o: AsOpts = {}) => as(tx, 'p', () => tx`select name from storage.objects where name like ${f.org.id + '/%'} order by 1`, o)
      const own = ok(await files()).map((x) => x.name as string)
      for (const n of [r.A.file, r.B.file, f.org.id + '/week.pdf']) expect(own, `control ${n}`).toContain(n)
      const viewed = ok(await files({ view: id })).map((x) => x.name as string)
      expect(viewed).toContain(r.A.file)
      for (const n of [r.B.file, r.B.paper, f.org.id + '/week.pdf']) expect(viewed, n).not.toContain(n)
    })
  })

  it('MATERIALS: one published to the area class is visible to a class-scoped viewer; one published only to B is not', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      const r = await fullClassroom(tx, f)
      await seat(tx, f, 'v', 'classroom', 'professor', f.nodeA)
      const id = await startOk(tx, f)
      const q = () => tx`select id from cls_materials where org_id = ${f.org.id}`
      expect(idsOf(ok(await as(tx, 'p', q)))).toEqual([r.A.material, r.B.material].sort())
      expect(idsOf(ok(await as(tx, 'p', q, { view: id })))).toEqual([r.A.material])
      const files = ok(await as(tx, 'p', () => tx`select name from storage.objects where bucket_id = 'cls-materials' and name like ${f.org.id + '/%'}`, { view: id }))
      expect(files.map((x) => x.name)).toEqual([`${f.org.id}/${f.courseA}/notes-A.pdf`])
    })
  })

  it('cls_survey_results checks the area (control: the person sees B results)', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      const r = await fullClassroom(tx, f)
      await seat(tx, f, 'v', 'classroom', 'professor', f.nodeA)
      const id = await startOk(tx, f)
      expect(ok(await as(tx, 'p', () => tx`select * from public.cls_survey_results(${r.B.survey}::uuid)`))).toHaveLength(1)
      expect(ok(await as(tx, 'p', () => tx`select * from public.cls_survey_results(${r.B.survey}::uuid)`, { view: id }))).toEqual([])
      expect(ok(await as(tx, 'p', () => tx`select * from public.cls_survey_results(${r.A.survey}::uuid)`, { view: id }))).toHaveLength(1)
    })
  })

  it('ORG-LEVEL rows: only the viewed org (orgs, members, modules, scope nodes, names), each with a control', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      const g = await fixture(tx) // p, v, g, o are members of a second org too
      await seat(tx, f, 'v', 'classroom', 'professor')
      const id = await startOk(tx, f)
      const probe = async (o: AsOpts = {}) =>
        ok(await as(tx, 'p', () => tx`select
          (select count(*)::int from orgs where id in (${f.org.id}, ${g.org.id})) as orgs,
          (select count(*)::int from org_members where org_id = ${g.org.id}) as other_members,
          (select count(*)::int from org_members where org_id = ${f.org.id}) as members,
          (select count(*)::int from org_modules where org_id = ${g.org.id}) as other_modules,
          (select count(*)::int from module_scope_nodes where org_id = ${g.org.id}) as other_nodes`, o))[0]!
      const own = await probe()
      expect(own.orgs).toBe(2)
      expect(own.other_members).toBeGreaterThan(0)
      expect(own.other_modules).toBeGreaterThan(0)
      expect(own.other_nodes).toBeGreaterThan(0)
      const viewed = await probe({ view: id })
      expect(viewed).toMatchObject({ orgs: 1, other_members: 0, other_modules: 0, other_nodes: 0 })
      expect(viewed.members).toBe(own.members)
      // Names: x shares only the second org with p.
      await tx`insert into org_members (org_id, user_id, role, status) values (${g.org.id}, ${ids.x}, 'member', 'active')`
      const name = (o: AsOpts = {}) => as(tx, 'p', () => tx`select user_id from profiles where user_id = ${ids.x}`, o)
      expect(ok(await name())).toHaveLength(1)
      expect(ok(await name({ view: id }))).toEqual([])
      expect(ok(await as(tx, 'p', () => tx`select user_id from profiles where user_id = ${ids.v}`, { view: id }))).toHaveLength(1)
    })
  })

  it('the superadmin whole-account view still reads everything the person reads (platform branch unchanged)', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      const g = await fixture(tx)
      await fullClassroom(tx, f)
      await tx`update user_private set is_superadmin = true where user_id = ${ids.s}`
      const pid = ok(await as(tx, 's', () => tx`select public.view_as_real_start(${ids.p}::uuid) as id`, { keep: true }))[0]!.id as string
      const q = () => tx`select
        (select count(*)::int from cls_classes where org_id in (${f.org.id}, ${g.org.id})) as classes,
        (select count(*)::int from orgs where id in (${f.org.id}, ${g.org.id})) as orgs,
        (select count(*)::int from storage.objects where name like ${f.org.id + '/%'}) as files,
        (select count(*)::int from module_roles where user_id = ${ids.p}) as seats`
      const own = ok(await as(tx, 'p', q))[0]
      expect(own!.classes).toBe(4)
      expect(own!.files).toBeGreaterThan(0)
      expect(ok(await as(tx, 'p', q, { view: pid, actor: 's' }))[0]).toEqual(own)
    })
  })
})

describe('who may be viewed, and when a view dies', () => {
  it('a person holding a manager-tier seat in ANY module of the org cannot be viewed (control: removing it)', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      await seat(tx, f, 'v', 'classroom', 'professor')
      await tx`insert into org_modules (org_id, module_key, enabled) values (${f.org.id}, 'speed-dating', true)`
      await seat(tx, f, 'p', 'speed-dating', 'organizer')
      expect((await start(tx, f)).error).toMatch(/can't view/)
      await tx`delete from module_roles where org_id = ${f.org.id} and user_id = ${ids.p} and module_key = 'speed-dating'`
      await startOk(tx, f)
    })
  })

  it('a module switched off for the org is not in the area (control: switched on)', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      await seat(tx, f, 'v', 'classroom', 'professor')
      // (org_modules_pin_enablement pins 'enabled' for non-superadmins, so re-create the row.)
      await tx`delete from org_modules where org_id = ${f.org.id} and module_key = 'classroom'`
      await tx`insert into org_modules (org_id, module_key, enabled) values (${f.org.id}, 'classroom', false)`
      expect((await start(tx, f)).error).toMatch(/can't view/)
      await tx`delete from org_modules where org_id = ${f.org.id} and module_key = 'classroom'`
      await tx`insert into org_modules (org_id, module_key, enabled) values (${f.org.id}, 'classroom', true)`
      await startOk(tx, f)
    })
  })

  it('a live view dies when the viewer goes pending, the person is banned, it expires, the viewer self-gives her seat, or it is ended', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      await seat(tx, f, 'v', 'classroom', 'professor')
      const id = await startOk(tx, f)
      const n = async () => ok(await as(tx, 'p', () => tx`select id from cls_classes where org_id = ${f.org.id}`, { view: id })).length
      expect(await n()).toBe(2)
      await tx`update org_members set status = 'pending' where org_id = ${f.org.id} and user_id = ${ids.v}`
      expect(await n()).toBe(0)
      await tx`update org_members set status = 'active' where org_id = ${f.org.id} and user_id = ${ids.v}`
      expect(await n()).toBe(2)
      await tx`update auth.users set banned_until = now() + interval '1 day' where id = ${ids.p}`
      expect(await n()).toBe(0)
      await tx`update auth.users set banned_until = null where id = ${ids.p}`
      expect(await n()).toBe(2)
      await tx`update view_as_real_sessions set expires_at = now() - interval '1 second' where id = ${id}`
      expect(await n()).toBe(0)
      await tx`update view_as_real_sessions set expires_at = now() + interval '10 minutes' where id = ${id}`
      expect(await n()).toBe(2)
      await tx`update module_roles set granted_by = ${ids.v} where org_id = ${f.org.id} and user_id = ${ids.v}`
      expect(await n()).toBe(0)
      await tx`update module_roles set granted_by = null where org_id = ${f.org.id} and user_id = ${ids.v}`
      expect(await n()).toBe(2)
      ok(await as(tx, 'v', () => tx`select public.view_as_real_end(${id}::uuid)`, { keep: true }))
      expect(await n()).toBe(0)
    })
  })

  it('granted_by: a no-op update keeps it; a seat change re-stamps it; deleting the grantor clears it', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      await seat(tx, f, 'v', 'classroom', 'professor', null, ids.g)
      const grantedBy = async () => (await tx`select granted_by from module_roles where org_id = ${f.org.id} and user_id = ${ids.v}`)[0]!.granted_by
      ok(await as(tx, 'o', () => tx`update module_roles set role = role where org_id = ${f.org.id} and user_id = ${ids.v}`, { keep: true }))
      expect(await grantedBy()).toBe(ids.g)
      ok(await as(tx, 'o', () => tx`update module_roles set scope_ref = ${f.nodeA} where org_id = ${f.org.id} and user_id = ${ids.v}`, { keep: true }))
      expect(await grantedBy()).toBe(ids.o)
      // Deleting the grantor with a signed-in user on the connection clears it instead of failing.
      await tx`update module_roles set granted_by = ${ids.x} where org_id = ${f.org.id} and user_id = ${ids.v}`
      expect(await grantedBy()).toBe(ids.x)
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: ids.o, role: 'authenticated' })}, true)`
      await tx`delete from auth.users where id = ${ids.x}`
      await tx`select set_config('request.jwt.claims', '', true)`
      expect(await grantedBy()).toBeNull()
    })
  })

  it('the picker names in-area roles only (a GA seat in another class is not named)', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      await seat(tx, f, 'p', 'classroom', 'ga', f.nodeB)
      await seat(tx, f, 'v', 'classroom', 'professor', f.nodeA)
      const rows = ok(await as(tx, 'v', () => tx`select user_id, roles from public.view_as_staff_targets(${f.org.id}::uuid, 'classroom')`))
      expect(rows).toEqual([{ user_id: ids.p, roles: ['student'] }])
      // Control: a global professor covers both and is told both.
      await seat(tx, f, 'g', 'classroom', 'professor')
      const all = ok(await as(tx, 'g', () => tx`select user_id, roles from public.view_as_staff_targets(${f.org.id}::uuid, 'classroom')`))
      expect(all.find((r) => r.user_id === ids.p)?.roles).toEqual(['ga', 'student'])
    })
  })
})

describe('salon, speed and odd claims', () => {
  it('SALON KEYSTONE: a manager at Downtown sees the worker\'s Downtown rows only, all readable by her', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      const org = f.org.id
      const [d] = await tx`insert into sal_locations (org_id, name) values (${org}, 'Downtown') returning id, scope_node_id`
      const [u] = await tx`insert into sal_locations (org_id, name) values (${org}, 'Uptown') returning id, scope_node_id`
      for (const l of [d!, u!]) {
        await seat(tx, f, 'p', 'nail-salon', 'worker', l.scope_node_id)
        const [svc] = await tx`insert into sal_services (org_id, location_id, name, approx_duration_minutes) values (${org}, ${l.id}, 'Gel', 30) returning id`
        const [wp] = await tx`insert into sal_worker_profiles (org_id, location_id, user_id) values (${org}, ${l.id}, ${ids.p}) returning id`
        await tx`insert into sal_worker_time_off (org_id, location_id, worker_profile_id, starts_at, ends_at) values (${org}, ${l.id}, ${wp!.id}, now(), now() + interval '1 day')`
        const [cu] = await tx`insert into sal_customers (org_id, location_id, full_name) values (${org}, ${l.id}, 'Cust') returning id`
        const [ap] = await tx`insert into sal_appointments (org_id, location_id, customer_id, service_id, worker_id, scheduled_start, scheduled_end)
                              values (${org}, ${l.id}, ${cu!.id}, ${svc!.id}, ${ids.p}, now(), now() + interval '1 hour') returning id`
        await tx`insert into sal_earnings_ledger (org_id, location_id, appointment_id, worker_id, kind, amount) values (${org}, ${l.id}, ${ap!.id}, ${ids.p}, 'sale', 10)`
      }
      await seat(tx, f, 'v', 'nail-salon', 'manager', d!.scope_node_id)
      const id = await startOk(tx, f)
      const tables = (await tx`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                               where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'sal\\_%'
                                 and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'location_id')
                               order by 1`).map((r) => r.relname as string)
      const nonEmpty: string[] = []
      for (const t of tables) {
        const q = () => tx.unsafe(`select id, location_id from public.${t} where org_id = '${org}'`)
        const own = ok(await as(tx, 'p', q))
        const viewed = ok(await as(tx, 'p', q, { view: id }))
        const hers = new Set(ok(await as(tx, 'v', () => tx.unsafe(`select id from public.${t}`))).map((r) => r.id as string))
        expect(viewed.filter((r) => r.location_id !== d!.id), `${t}: an Uptown row`).toEqual([])
        expect(viewed.filter((r) => !hers.has(r.id as string)), `${t}: rows the manager cannot read herself`).toEqual([])
        if (own.some((r) => r.location_id === u!.id) && viewed.length > 0) nonEmpty.push(t)
      }
      for (const t of ['sal_appointments', 'sal_services', 'sal_worker_profiles', 'sal_worker_time_off']) expect(nonEmpty, t).toContain(t)
      expect(ok(await as(tx, 'p', () => tx`select public.sal_is_worker(${org}::uuid) as w`, { view: id }))[0]!.w).toBe(true)
    })
  })

  it('a global admin viewing a GLOBAL worker (the NULL-node branch) sees every location', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      const [d] = await tx`insert into sal_locations (org_id, name) values (${f.org.id}, 'Downtown') returning id`
      const [u] = await tx`insert into sal_locations (org_id, name) values (${f.org.id}, 'Uptown') returning id`
      await seat(tx, f, 'p', 'nail-salon', 'worker')
      await seat(tx, f, 'v', 'nail-salon', 'admin')
      const id = await startOk(tx, f)
      expect(idsOf(ok(await as(tx, 'p', () => tx`select id from sal_locations where org_id = ${f.org.id}`, { view: id })))).toEqual([d!.id, u!.id].sort())
      expect(ok(await as(tx, 'p', () => tx`select role from module_roles where org_id = ${f.org.id} and module_key = 'nail-salon'`, { view: id }))).toEqual([{ role: 'worker' }])
    })
  })

  it('SPEED: a staff view over 2,000 rows stays well inside the 8 s statement timeout', async () => {
    await rolledBack(async (tx) => {
      const f = await fixture(tx)
      await tx`insert into cls_announcements (org_id, class_id, body) select ${f.org.id}, ${f.classA}, 'n' || g from generate_series(1, 2000) g`
      await seat(tx, f, 'v', 'classroom', 'professor')
      const id = await startOk(tx, f)
      const t0 = Date.now()
      const rows = ok(await as(tx, 'p', () => tx`select count(*)::int as n from cls_announcements where org_id = ${f.org.id}`, { view: id }))
      const ms = Date.now() - t0
      expect(rows[0]!.n).toBe(2000)
      expect(ms, `took ${ms} ms`).toBeLessThan(4000)
    })
  })

  it('the shared rules return the right values, without raising, for odd claims (as authenticated)', async () => {
    await rolledBack(async (tx) => {
      const cases: [string, boolean][] = [
        [JSON.stringify({ sub: ids.p, role: 'authenticated' }), true], // not a view
        [JSON.stringify({ sub: ids.p, role: 'authenticated', view_as: { session: 'nope' } }), false],
        [JSON.stringify({ sub: ids.p, role: 'authenticated', view_as: { session: '00000000-0000-0000-0000-000000000001' } }), false],
        [JSON.stringify({ sub: ids.p, role: 'authenticated', view_as: 1 }), false],
      ]
      for (const [claims, want] of cases) {
        await tx.unsafe('savepoint c')
        await tx`select set_config('request.jwt.claims', ${claims}, true)`
        await tx.unsafe('set local role authenticated')
        const [r] = await tx`select public.view_as_may_read_in(gen_random_uuid(), 'classroom', null) as a,
                                    public.view_as_grant_visible(gen_random_uuid(), 'classroom', null) as b,
                                    public.view_as_may_read(gen_random_uuid(), 'classroom') as c,
                                    public.view_as_org_ok(gen_random_uuid()) as d`
        expect(r, claims).toEqual({ a: want, b: want, c: want, d: want })
        await tx.unsafe('rollback to savepoint c')
        await tx.unsafe('reset role')
      }
    })
  })

  it('the area rule has exactly these callers (rank-admission.test.ts treats it as NARROWING_ONLY; a new caller must be reviewed)', async () => {
    // view_as_staff_area is a rank gate for who may START a staff view (live,
    // targets) as well as a narrowing rule for what a view reads. The rank map
    // does not propagate it (it would mark every role boolean as rank-gated),
    // so this list is where a new use of it shows up.
    const rows = await sql`select proname from pg_proc where pronamespace = 'public'::regnamespace
                             and prosrc like '%view_as_staff_area(%' order by 1`
    expect(rows.map((r) => r.proname)).toEqual(['view_as_now', 'view_as_real_check', 'view_as_staff_live', 'view_as_staff_targets'])
  })

  it('every cls_/sal_ table carries the restrictive _staff_area policy (a NEW module table must add one)', async () => {
    const missing = await sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and (c.relname like 'cls\\_%' or c.relname like 'sal\\_%')
        and not exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = c.relname || '_staff_area' and not p.polpermissive)`
    const total = await sql`select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and (c.relname like 'cls\\_%' or c.relname like 'sal\\_%')`
    expect(total[0]!.n).toBeGreaterThan(25)
    expect(missing.map((r) => r.relname)).toEqual([])
  })
})
