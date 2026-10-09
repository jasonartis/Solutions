import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'

// ---------------------------------------------------------------------------
// ADMIN FLOORS IGNORE SOMEONE WHO IS LEAVING (20261009030000, docs/21 §7.10).
//
// The wedge this closes: org admins A and B; B asks to delete their account;
// A steps down, allowed because B still "held" the floor; on day 30 the
// silhouette cannot revoke B's seat (B is now the sole admin), so B's deletion
// fails every day, forever — and B cannot fix it, because signing in cancels
// their own deletion.
//
// Two throwaway accounts, every probe inside a transaction that is ALWAYS
// rolled back, accounts hard-deleted afterwards. CI runs e2e on this database
// next with no reset between, so nothing may leak.
// ---------------------------------------------------------------------------

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const ownerDbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const sql = postgres(ownerDbUrl, { prepare: false, max: 1 })
const admin = () => createClient(url, serviceKey, { auth: { persistSession: false } })
let a = ''
let b = ''

beforeAll(async () => {
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for this suite')
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  for (const who of ['a', 'b'] as const) {
    const { data, error } = await admin().auth.admin.createUser({
      email: `floor-${who}-${tag}@demo.local`, password: 'password123', email_confirm: true,
    })
    if (error) throw new Error(`createUser ${who}: ${error.message}`)
    if (who === 'a') a = data.user!.id
    else b = data.user!.id
  }
})

afterAll(async () => {
  try {
    for (const id of [a, b].filter(Boolean)) {
      const { error } = await admin().auth.admin.deleteUser(id)
      expect(error, 'could not hard-delete a probe account').toBeNull()
    }
  } finally {
    await sql.end()
  }
})

/** Run `body` in a transaction that is always rolled back; return its result. */
async function rolledBack<T>(body: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
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

/** Try a statement under a savepoint; return the error message, or null if it ran. */
async function attempt(tx: postgres.TransactionSql, stmt: () => Promise<unknown>): Promise<string | null> {
  await tx.unsafe('savepoint sp')
  try {
    await stmt()
    await tx.unsafe('release savepoint sp')
    return null
  } catch (e: unknown) {
    await tx.unsafe('rollback to savepoint sp')
    return String((e as Error).message)
  }
}

/** A probe org where a and b are both active owners. */
async function twoOwnerOrg(tx: postgres.TransactionSql): Promise<string> {
  const [o] = await tx<{ id: string }[]>`
    insert into orgs (name, slug) values ('Floor probe', ${`floor-${Math.random().toString(36).slice(2, 10)}`})
    returning id`
  await tx`insert into org_members (org_id, user_id, role, status, accepted_at) values
           (${o!.id}, ${a}, 'owner', 'active', now()),
           (${o!.id}, ${b}, 'owner', 'active', now())`
  return o!.id
}

const depart = (tx: postgres.TransactionSql, id: string, due = "now() + interval '30 days'") =>
  tx.unsafe(
    `insert into account_deletions (user_id, state, initiated_via, requested_by, requested_at, due_at)
     values ($1, 'departed', 'self', $1, now(), ${due})`,
    [id],
  )

describe('admin floors ignore someone who is leaving (20261009030000)', () => {
  it('org floor: with B leaving, A may not step down; with B staying (control), A may', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await twoOwnerOrg(tx)
      const stepDown = () => tx`update org_members set role = 'member' where org_id = ${org} and user_id = ${a}`

      // CONTROL: B is a normal co-owner, so A stepping down is fine.
      const whileStaying = await attempt(tx, stepDown)
      // Undo it so the next probe starts from two owners again.
      await tx`update org_members set role = 'owner' where org_id = ${org} and user_id = ${a}`

      await depart(tx, b)
      const whileLeaving = await attempt(tx, stepDown)

      // B cancels (signs back in, recorded as a cancel): B counts again.
      await tx`update account_deletions set state = 'cancelled', cancelled_at = now(), cancel_reason = 'signed_in'
               where user_id = ${b}`
      const afterCancel = await attempt(tx, stepDown)
      return { whileStaying, whileLeaving, afterCancel }
    })
    expect(r.whileStaying, 'CONTROL: stepping down beside a normal co-owner was refused').toBeNull()
    expect(r.whileLeaving).toMatch(/An org must keep at least one owner or admin/)
    expect(r.afterCancel, 'a cancelled departure still blocked the co-owner').toBeNull()
  })

  it('the wedge is gone: A stays, so the day-30 silhouette of B succeeds', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await twoOwnerOrg(tx)
      await depart(tx, b, "now() - interval '1 minute'")
      // What used to wedge: A trying to leave first. Now refused…
      const aLeaves = await attempt(tx, () => tx`delete from org_members where org_id = ${org} and user_id = ${a}`)
      // …so on day 30 there is still a real admin, and B's silhouette runs.
      const [job] = await tx<{ r: { deleted: number; failed: number } }[]>`
        select public.account_complete_due_deletions() as r`
      const [st] = await tx<{ state: string; last_error: string | null }[]>`
        select state, last_error from account_deletions where user_id = ${b}`
      const [left] = await tx<{ n: number }[]>`
        select count(*)::int as n from org_members where org_id = ${org} and role = 'owner' and status = 'active'`
      return { aLeaves, job: job!.r, st: st!, owners: left!.n }
    })
    expect(r.aLeaves).toMatch(/An org must keep at least one owner or admin/)
    expect(r.st, `B's deletion did not complete: ${r.st.last_error}`).toMatchObject({ state: 'deleted', last_error: null })
    expect(r.owners, 'the org was left with no owner').toBe(1)
  })

  // DELIBERATELY THE OPPOSITE of the org floor. Ignoring a departing
  // conversation admin would trap the REMAINING admin: unable to leave, and
  // unable to self-block — the platform's only user-level block — right when a
  // superadmin has removed an abuser who was co-admin. The silhouette never
  // touches conversation seats, so there is no wedge to prevent here. This test
  // pins that choice so it is not "fixed" back (migration header, 2026-10-09).
  it('conversation floor: a leaving admin STILL holds it, on purpose', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await twoOwnerOrg(tx)
      const [c] = await tx<{ id: string }[]>`
        insert into vm_conversations (org_id, title, created_by) values (${org}, 'floor probe', ${b}) returning id`
      // Owner connection, no JWT: the seat triggers treat it as the trusted backend.
      const [m] = await tx<{ id: string; role: string; status: string }[]>`
        insert into vm_conversation_members (org_id, conversation_id, user_id, role, status)
        values (${org}, ${c!.id}, ${b}, 'admin', 'active') returning id, role, status`
      if (m!.role !== 'admin' || m!.status !== 'active') {
        throw new Error(`fixture premise gone: seat is ${m!.role}/${m!.status}, not admin/active`)
      }
      const holds = async () =>
        (await tx<{ h: boolean }[]>`select public.vm_seat_holds_admin_floor(${m!.id}) as h`)[0]!.h
      const staying = await holds()
      await depart(tx, b)
      const leaving = await holds()
      return { staying, leaving }
    })
    expect(r.staying, 'CONTROL: an active admin who is staying does not hold the floor').toBe(true)
    expect(
      r.leaving,
      'a departing admin stopped holding the conversation floor — that traps the remaining admin (no leave, no self-block)',
    ).toBe(true)
  })

  it('Director floor: carries the same rule (structural — no session-holding caller can reach its refusal)', async () => {
    // module_roles_guard_last_director lets no-session, superadmin and org-admin
    // callers through, and nobody else can outrank a rank-4 seat to remove it,
    // so its refusal is unreachable by a real caller today (0 rank-4 grants
    // exist anywhere). Asserting the deployed body is the honest test.
    const [f] = await sql<{ src: string }[]>`
      select prosrc as src from pg_proc where oid = 'public.module_roles_guard_last_director()'::regprocedure`
    expect(f!.src).toMatch(/and not public\.account_pending_departure\(user_id\)/)
  })
})
