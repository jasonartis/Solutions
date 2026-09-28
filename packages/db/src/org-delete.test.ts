import { describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import postgres from 'postgres'

// ---------------------------------------------------------------------------
// ORG DELETION AND THE ADMIN FLOOR (20260928010000, docs/20 §30.1).
//
// `orgs` -> `org_members` is ON DELETE CASCADE, and `org_members_guard_last_admin`
// (a BEFORE DELETE/UPDATE trigger enforcing "an org must keep at least one
// active owner/admin") had no cascade escape — so deleting an org raised and
// every real org was undeletable. The migration adds ONE clause: skip the floor
// check when the parent org no longer exists.
//
// WHY THESE TESTS ARE THE INTERESTING PART. The fix is one line, and a one-line
// fix to a guard is exactly the shape that silently removes the guard. Three of
// the five tests below assert the floor STILL HOLDS; only one asserts the new
// capability. If the escape were written as `pg_trigger_depth() > 1` — the
// generic technique docs/20 §30.3 recommends — test 4 would FAIL, because that
// test cannot tell the orgs-cascade (floor is moot, allow) from the
// auth.users-cascade (org survives with zero admins, must block). That is the
// whole reason the escape asks about the parent instead of the depth.
//
// Every DDL/DML probe runs inside a transaction that is ALWAYS rolled back: CI
// runs this suite and then e2e against the SAME database with no reset between,
// so a leaked probe org would surface later as an unrelated failure.
// ---------------------------------------------------------------------------

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const anonKey = process.env.SUPABASE_ANON_KEY ?? ''
const ownerDbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

async function signIn(email: string): Promise<SupabaseClient> {
  const client = createClient(url, anonKey, { auth: { persistSession: false } })
  const { error } = await client.auth.signInWithPassword({ email, password: 'password123' })
  if (error) throw new Error(`Sign-in failed for ${email}: ${error.message} (did you seed?)`)
  return client
}

const slug = () => `probe-${Math.random().toString(36).slice(2, 10)}`

/** Run `body` against a probe org with one ACTIVE OWNER, then roll everything back. */
async function withProbeOrg<T>(
  body: (tx: postgres.TransactionSql, orgId: string, userId: string) => Promise<T>,
): Promise<T> {
  const sql = postgres(ownerDbUrl, { prepare: false, max: 1 })
  let result!: T
  try {
    await sql
      .begin(async (tx) => {
        const [u] = await tx<{ user_id: string }[]>`select user_id from profiles limit 1`
        if (!u) throw new Error('no profiles seeded — these tests would be vacuous')
        const [o] = await tx<{ id: string }[]>`
          insert into orgs (name, slug) values ('Probe', ${slug()}) returning id`
        await tx`
          insert into org_members (org_id, user_id, role, status)
          values (${o!.id}, ${u.user_id}, 'owner', 'active')`
        result = await body(tx, o!.id, u.user_id)
        throw new Error('__rollback__')
      })
      .catch((e: unknown) => {
        if ((e as Error)?.message !== '__rollback__') throw e
      })
  } finally {
    await sql.end()
  }
  return result
}

/** Did `fn` raise the admin-floor error specifically? Not just "any error". */
async function refusedByFloor(tx: postgres.TransactionSql, stmt: string): Promise<string | null> {
  await tx.unsafe('savepoint sp')
  try {
    await tx.unsafe(stmt)
    await tx.unsafe('release savepoint sp')
    return null
  } catch (e: unknown) {
    await tx.unsafe('rollback to savepoint sp')
    return String((e as Error).message)
  }
}

describe('org deletion and the admin floor (20260928010000)', () => {
  it('THE FIX: an org whose only member is an active owner can be deleted', async () => {
    const leftover = await withProbeOrg(async (tx, orgId) => {
      await tx.unsafe(`delete from orgs where id = '${orgId}'`)
      const [org] = await tx<{ n: number }[]>`
        select count(*)::int as n from orgs where id = ${orgId}`
      const [mem] = await tx<{ n: number }[]>`
        select count(*)::int as n from org_members where org_id = ${orgId}`
      return { org: org!.n, members: mem!.n }
    })
    expect(leftover.org, 'the org survived its own delete').toBe(0)
    expect(leftover.members, 'org_members rows survived — the cascade did not run').toBe(0)
  })

  it('THE FLOOR HOLDS: the sole owner SEAT still cannot be deleted', async () => {
    const err = await withProbeOrg((tx, orgId) =>
      refusedByFloor(tx, `delete from org_members where org_id = '${orgId}'`),
    )
    expect(
      err,
      'deleting the last owner seat was ALLOWED — the cascade escape is too broad and has ' +
        'effectively removed the admin floor',
    ).toMatch(/at least one owner or admin/i)
  })

  it('THE FLOOR HOLDS: the sole owner still cannot be demoted', async () => {
    const err = await withProbeOrg((tx, orgId) =>
      refusedByFloor(tx, `update org_members set role = 'member' where org_id = '${orgId}'`),
    )
    expect(err, 'demoting the last owner was ALLOWED').toMatch(/at least one owner or admin/i)
  })

  it('THE FLOOR HOLDS ACROSS THE OTHER CASCADE: deleting a sole-admin USER is still refused', async () => {
    // org_members.user_id is ALSO ON DELETE CASCADE (from auth.users). Here the
    // ORG SURVIVES and would be left with zero admins, so the floor genuinely
    // still applies. This is the test that a `pg_trigger_depth() > 1` escape
    // would fail — it cannot distinguish this cascade from the orgs one.
    const err = await withProbeOrg((tx, _orgId, userId) =>
      refusedByFloor(tx, `delete from auth.users where id = '${userId}'`),
    )
    expect(
      err,
      'deleting a user who solely administers an org was ALLOWED — that silently orphans the ' +
        'org, leaving it with no owner or admin and no way to appoint one',
    ).toMatch(/at least one owner or admin/i)
  })

  it('org_delete_impact itemises what would be destroyed, and is superadmin-only', async () => {
    const sql = postgres(ownerDbUrl, { prepare: false, max: 1 })
    let orgId = ''
    try {
      // Committed rather than rolled back: the two clients below are separate
      // sessions and cannot see an uncommitted transaction. Removed in `finally`.
      const [u] = await sql<{ user_id: string }[]>`select user_id from profiles limit 1`
      const [o] = await sql<{ id: string }[]>`
        insert into orgs (name, slug) values ('Impact Probe', ${slug()}) returning id`
      orgId = o!.id
      await sql`
        insert into org_members (org_id, user_id, role, status)
        values (${orgId}, ${u!.user_id}, 'owner', 'active')`
      await sql`insert into org_modules (org_id, module_key, enabled) values (${orgId}, 'nail-salon', true)`

      const superadmin = await signIn('owner@demo.local')
      const { data, error } = await superadmin.rpc('org_delete_impact', { check_org_id: orgId })
      expect(error, `superadmin could not read the impact: ${error?.message}`).toBeNull()
      const rows = (data ?? []) as { table_name: string; row_count: number }[]
      const byTable = new Map(rows.map((r) => [r.table_name, Number(r.row_count)]))
      // Non-vacuous: it must actually FIND the rows that exist.
      expect(byTable.get('org_members'), 'the inventory missed org_members').toBe(1)
      expect(byTable.get('org_modules'), 'the inventory missed org_modules').toBe(1)
      // And it reports only what is there — a table with no rows for this org
      // must not appear, or the operator cannot tell signal from noise.
      expect(
        rows.every((r) => Number(r.row_count) > 0),
        'the inventory listed a table with zero rows',
      ).toBe(true)

      const ordinary = await signIn('charlie@demo.local')
      const denied = await ordinary.rpc('org_delete_impact', { check_org_id: orgId })
      expect(
        denied.error,
        'an ordinary member could enumerate an org\'s row counts — this function is superadmin-only',
      ).not.toBeNull()
    } finally {
      if (orgId) await sql`delete from orgs where id = ${orgId}`
      await sql.end()
    }
  })
})
