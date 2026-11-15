import { afterAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'

// ---------------------------------------------------------------------------
// STORAGE UPLOAD PATHS NAME THE REAL ORG (20261117010000).
//
// cls-submissions and vm-images uploads used to check only the parent-row
// folder, so a member could file their own upload under another org's id
// (journal 2026-11-12). Every probe runs as a real seeded member inside a
// transaction that is always rolled back. Each refusal has a positive control:
// the same upload under the correct path succeeds for the same person.
// ---------------------------------------------------------------------------

const ownerDbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const sql = postgres(ownerDbUrl, { prepare: false, max: 1 })

afterAll(async () => {
  await sql.end()
})

type Tx = postgres.TransactionSql

async function rolledBack(body: (tx: Tx) => Promise<void>): Promise<void> {
  await sql
    .begin(async (tx) => {
      await body(tx)
      throw new Error('__rollback__')
    })
    .catch((e: unknown) => {
      if ((e as Error)?.message !== '__rollback__') throw e
    })
}

/** The first row, or a failure naming what the seed lacks. */
function first(rows: postgres.RowList<postgres.Row[]>, what: string): postgres.Row {
  const row = rows[0]
  if (!row) throw new Error(`seed has no ${what}`)
  return row
}

/** Inserts one storage object as `userId`; returns the error code or null. */
async function uploadAs(tx: Tx, userId: string, bucket: string, name: string): Promise<string | null> {
  await tx.unsafe('savepoint sp')
  try {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: 'authenticated' })}, true)`
    await tx.unsafe('set local role authenticated')
    await tx`insert into storage.objects (bucket_id, name, owner) values (${bucket}, ${name}, ${userId})`
    await tx.unsafe('release savepoint sp')
    return null
  } catch (e: unknown) {
    await tx.unsafe('rollback to savepoint sp')
    return (e as { code?: string }).code ?? 'error'
  } finally {
    await tx.unsafe('reset role')
  }
}

describe('storage upload paths must name the real org', () => {
  it('cls-submissions: only <own org>/<own class>/<own submission>/ is accepted', async () => {
    await rolledBack(async (tx) => {
      const m = first(await tx`
        select cm.user_id, cm.org_id, cm.class_id, h.id as homework_id
        from public.cls_class_members cm
        join public.cls_homeworks h on h.class_id = cm.class_id
        where cm.role = 'student'
        limit 1`, 'student with a homework')
      const other = first(await tx`select id from public.orgs where id <> ${m.org_id} limit 1`, 'second org')
      // The seed has one class; any class id other than the submission's must be refused.
      const otherClass = first(await tx`select gen_random_uuid() as id`, 'uuid')

      // An open submission for this student (homework made undated inside the rollback).
      await tx`update public.cls_homeworks set due_at = null where id = ${m.homework_id}`
      await tx`delete from public.cls_submissions where homework_id = ${m.homework_id} and student_id = ${m.user_id}`
      const s = first(await tx`
        insert into public.cls_submissions (org_id, homework_id, class_id, student_id)
        values (${m.org_id}, ${m.homework_id}, ${m.class_id}, ${m.user_id})
        returning id`, 'new submission')

      const good = `${m.org_id}/${m.class_id}/${s.id}/a.pdf`
      expect(await uploadAs(tx, m.user_id, 'cls-submissions', good), 'control: the right path uploads').toBeNull()
      expect(await uploadAs(tx, m.user_id, 'cls-submissions', `${other.id}/${m.class_id}/${s.id}/b.pdf`)).toBe('42501')
      expect(await uploadAs(tx, m.user_id, 'cls-submissions', `${m.org_id}/${otherClass.id}/${s.id}/c.pdf`)).toBe('42501')
    })
  })

  it('vm-images: only <the conversation org>/<conversation>/ is accepted', async () => {
    await rolledBack(async (tx) => {
      // Not every seated member may post (a seat also needs a module role), so
      // pick the first seat whose holder vm_can_post says yes to.
      const seats = await tx`
        select m.user_id, c.org_id, c.id as conversation_id
        from public.vm_conversation_members m
        join public.vm_conversations c on c.id = m.conversation_id
        where m.status = 'active' and m.role = 'participant'`
      let m: postgres.Row | undefined
      for (const seat of seats) {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: seat.user_id, role: 'authenticated' })}, true)`
        const r = first(await tx`select public.vm_can_post(${seat.conversation_id}) as ok`, 'answer')
        if (r.ok) { m = seat; break }
      }
      expect(m, 'seed has no vm participant who may post').toBeTruthy()
      if (!m) return
      const other = first(await tx`select id from public.orgs where id <> ${m.org_id} limit 1`, 'second org')

      expect(await uploadAs(tx, m.user_id, 'vm-images', `${m.org_id}/${m.conversation_id}/a.png`), 'control').toBeNull()
      expect(await uploadAs(tx, m.user_id, 'vm-images', `${other.id}/${m.conversation_id}/b.png`)).toBe('42501')
      // The same org written in upper case is the same uuid but not the same folder text.
      expect(await uploadAs(tx, m.user_id, 'vm-images', `${String(m.org_id).toUpperCase()}/${m.conversation_id}/c.png`)).toBe('42501')
    })
  })

  it('the helpers are callable by signed-in users only and the policies use them', async () => {
    const acl = await sql`
      select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authed, p.prosecdef
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('cls_submission_upload_ok', 'vm_image_upload_ok')
      order by 1`
    expect(acl.map((r) => [r.proname, r.anon, r.authed, r.prosecdef])).toEqual([
      ['cls_submission_upload_ok', false, true, true],
      ['vm_image_upload_ok', false, true, true],
    ])
    const pol = await sql`
      select policyname, with_check from pg_policies
      where schemaname = 'storage' and tablename = 'objects'
        and policyname in ('cls_submissions_storage_write', 'vm_images_write')
      order by 1`
    expect(pol).toHaveLength(2)
    expect(pol[0]?.with_check).toContain('cls_submission_upload_ok')
    expect(pol[1]?.with_check).toContain('vm_image_upload_ok')
  })
})
