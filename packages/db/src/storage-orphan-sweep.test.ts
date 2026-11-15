import { afterAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { findStorageOrphans } from '../../../apps/worker/src/jobs/storage-orphan-sweep'

// ---------------------------------------------------------------------------
// STORAGE ORPHAN SWEEP (apps/worker/src/jobs/storage-orphan-sweep.ts).
//
// Which uploaded files count as orphans. Removing one cannot be undone, so the
// cases that must be KEPT matter as much as the ones found. Every object is
// planted as the owner inside a transaction that is always rolled back.
// ---------------------------------------------------------------------------

const ownerDbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const sql = postgres(ownerDbUrl, { prepare: false, max: 1 })

afterAll(async () => {
  await sql.end()
})

describe('storage orphan sweep', () => {
  it('finds files whose org or owning record is gone, and keeps everything else', async () => {
    let found: Awaited<ReturnType<typeof findStorageOrphans>> | undefined
    let names: Record<string, string> = {}
    await sql
      .begin(async (tx) => {
        const [conv] = await tx`select id, org_id from public.vm_conversations limit 1`
        const [sub] = await tx`select id, org_id, class_id from public.cls_submissions limit 1`
        const [course] = await tx`select id, org_id from public.cls_courses limit 1`
        expect(conv && sub && course, 'seed needs a conversation, a submission and a course').toBeTruthy()
        const gone = String((await tx`select gen_random_uuid()::text as gone`)[0]?.gone)
        const t = Date.now()
        const n = {
          liveConv: `${conv!.org_id}/${conv!.id}/live-${t}.png`,
          goneConv: `${conv!.org_id}/${gone}/gone-${t}.png`,
          goneOrg: `${gone}/${conv!.id}/org-${t}.png`,
          liveSub: `${sub!.org_id}/${sub!.class_id}/${sub!.id}/live-${t}.pdf`,
          goneSub: `${sub!.org_id}/${sub!.class_id}/${gone}/gone-${t}.pdf`,
          liveCourse: `${course!.org_id}/${course!.id}/live-${t}.pdf`,
          goneCourse: `${course!.org_id}/${gone}/gone-${t}.pdf`,
          notUuid: `probe/${conv!.id}/odd-${t}.png`,
          rootLevel: `root-${t}.png`,
          young: `${conv!.org_id}/${gone}/young-${t}.png`,
        }
        names = n
        const old = "now() - interval '2 days'"
        const plant = async (bucket: string, name: string, createdAt = old) =>
          tx.unsafe(`insert into storage.objects (bucket_id, name, metadata, created_at) values ($1, $2, '{"size": 10}', ${createdAt})`, [bucket, name])
        await plant('vm-images', n.liveConv)
        await plant('vm-images', n.goneConv)
        await plant('vm-images', n.goneOrg)
        await plant('cls-submissions', n.liveSub)
        await plant('cls-submissions', n.goneSub)
        await plant('cls-materials', n.liveCourse)
        await plant('cls-materials', n.goneCourse)
        await plant('vm-images', n.notUuid)
        await plant('vm-images', n.rootLevel)
        await plant('vm-images', n.young, 'now()')
        // A bucket that is not on the list is never swept, even with a dead uuid first.
        await tx`insert into storage.buckets (id, name, public) values ('orphan-probe', 'orphan-probe', false)`
        await plant('orphan-probe', `${gone}/x-${t}.png`)

        found = await findStorageOrphans(tx as unknown as postgres.Sql)
        throw new Error('__rollback__')
      })
      .catch((e: unknown) => {
        if ((e as Error)?.message !== '__rollback__') throw e
      })

    const reasonOf = (name: string | undefined) => found!.orphans.find((o) => o.name === name)?.reason
    expect(reasonOf(names.goneConv)).toBe('conversation deleted')
    expect(reasonOf(names.goneOrg)).toBe('org deleted')
    expect(reasonOf(names.goneSub)).toBe('submission deleted')
    expect(reasonOf(names.goneCourse)).toBe('course deleted')
    for (const kept of ['liveConv', 'liveSub', 'liveCourse', 'notUuid', 'rootLevel', 'young']) {
      expect(reasonOf(names[kept]!), `${kept} must be kept`).toBeUndefined()
    }
    expect(found!.orphans.some((o) => o.bucket === 'orphan-probe')).toBe(false)
    expect(found!.unrecognised).toBeGreaterThanOrEqual(2) // notUuid + rootLevel
  })
})
