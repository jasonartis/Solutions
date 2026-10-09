import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'

// ---------------------------------------------------------------------------
// A SILHOUETTE HOLDS NO AUTHORITY — even with a token in hand.
// (docs/21 §7.9 asked for this; §7.10 recorded it as checked by reading the
// function body. This file is the live proof that was promised and not, until
// now, written.)
//
// After the silhouette step (20261007090000) a deleted person cannot sign in,
// has no sessions and no memberships. The first three are proven in
// account-deletion.test.ts. This file asks the remaining question: if a token
// for that person DID still exist — an access token minted in the last hour
// before deletion, say — could it still WRITE anything?
//
// The case under test is `cls_set_preferred_name`, the one predicate docs/19
// still records as half-open: an unenrolled-but-still-in-org member can rename
// themselves on a roster. Its deployed body requires is_org_member(class org),
// and a silhouette has no membership, so it must be a no-op.
//
// HOW THE TOKEN IS SIMULATED: inside one transaction, `set local role
// authenticated` plus `request.jwt.claims` naming the user — exactly what
// PostgREST does for a real request. No GoTrue sign-in is needed, which matters
// because a silhouette cannot sign in.
//
// EVERYTHING RUNS IN ONE TRANSACTION THAT IS ALWAYS ROLLED BACK, and the one
// throwaway account is hard-deleted afterwards. CI runs e2e on this database
// next with no reset, so nothing may leak.
// ---------------------------------------------------------------------------

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const ownerDbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const sql = postgres(ownerDbUrl, { prepare: false, max: 1 })
let probeId = ''

beforeAll(async () => {
  // A missing key must FAIL, not skip (docs/03 vacuity rule).
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for this suite')
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
  const { data, error } = await admin.auth.admin.createUser({
    email: `silhouette-authority-${Date.now()}@demo.local`,
    password: 'password123',
    email_confirm: true,
  })
  if (error) throw new Error(`createUser: ${error.message}`)
  probeId = data.user!.id
})

afterAll(async () => {
  try {
    if (probeId) {
      const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
      const { error } = await admin.auth.admin.deleteUser(probeId)
      expect(error, 'could not hard-delete the probe account').toBeNull()
    }
  } finally {
    await sql.end()
  }
})

/** Call cls_set_preferred_name AS the probe user, then go back to owner. */
async function renameAsProbe(tx: postgres.TransactionSql, classId: string, first: string) {
  await tx.unsafe(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: probeId, role: 'authenticated' }),
  ])
  await tx.unsafe('set local role authenticated')
  await tx`select public.cls_set_preferred_name(${classId}, ${first}, 'Probe')`
  await tx.unsafe('reset role')
  await tx.unsafe(`select set_config('request.jwt.claims', '', true)`)
}

describe('a silhouette holds no authority, even with a token (20261007090000)', () => {
  it('cls_set_preferred_name: works for the live member (control), is a no-op for the silhouette', async () => {
    let outcome: { before: string | null; after: string | null; memberships: number } | null = null

    await sql
      .begin(async (tx) => {
        const [klass] = await tx<{ id: string; org_id: string }[]>`
          select id, org_id from cls_classes order by created_at limit 1`
        if (!klass) throw new Error('no class seeded — this test would be vacuous')

        await tx`insert into org_members (org_id, user_id, role, status, accepted_at)
                 values (${klass.org_id}, ${probeId}, 'member', 'active', now())`
        await tx`insert into cls_class_members (org_id, class_id, user_id, role)
                 values (${klass.org_id}, ${klass.id}, ${probeId}, 'student')`
        const nameNow = async () =>
          (await tx<{ n: string | null }[]>`
            select preferred_first_name as n from cls_class_members
            where class_id = ${klass.id} and user_id = ${probeId}`)[0]?.n ?? null

        // CONTROL: while a live member, the very same call DOES rename. Without
        // this, a no-op below could just mean the probe is wired wrong.
        await renameAsProbe(tx, klass.id, 'Alive')
        const before = await nameNow()

        // Make the probe a silhouette exactly as the daily job would: a due
        // departure, then the job, as owner with no JWT.
        await tx`insert into account_deletions (user_id, state, initiated_via, requested_by, requested_at, due_at)
                 values (${probeId}, 'departed', 'self', ${probeId}, now() - interval '31 days', now() - interval '1 day')`
        const [job] = await tx<{ r: { deleted: number } }[]>`select public.account_complete_due_deletions() as r`
        if (job!.r.deleted < 1) throw new Error(`the silhouette step did not run: ${JSON.stringify(job!.r)}`)

        await renameAsProbe(tx, klass.id, 'Ghost')
        const after = await nameNow()
        const [m] = await tx<{ n: number }[]>`
          select count(*)::int as n from org_members where user_id = ${probeId}`

        outcome = { before, after, memberships: m!.n }
        throw new Error('__rollback__')
      })
      .catch((e: unknown) => {
        if ((e as Error)?.message !== '__rollback__') throw e
      })

    expect(outcome, 'the transaction body never completed').not.toBeNull()
    expect(outcome!.before, 'CONTROL failed: a live member could not rename — the probe is miswired').toBe('Alive')
    expect(outcome!.memberships, 'the silhouette still holds an org membership').toBe(0)
    // The silhouette scrubbed the preferred name to NULL, and the token-holding
    // silhouette could not write it back.
    expect(outcome!.after, 'a silhouette with a token renamed itself on a class roster').toBeNull()
  })
})
