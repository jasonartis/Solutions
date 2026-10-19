import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'

// ---------------------------------------------------------------------------
// SPEED DATING: SELF-REJOIN AFTER A SELF-WITHDRAWAL (20261017010000).
//
// A participant who withdrew themselves may register again themselves; the
// DATABASE decides 'registered' vs 'waitlisted'; a removal stays a removal;
// waitlist order (created_at) cannot be jumped. Every behaviour is exercised
// as a real caller: `set local role authenticated` + `request.jwt.claims`, so
// RLS and auth.uid() see exactly what a signed-in user's request would.
//
// Throwaway accounts; every probe runs in a transaction that is ALWAYS
// rolled back; accounts hard-deleted afterwards. CI runs e2e on this database
// next with no reset between, so nothing may leak.
// ---------------------------------------------------------------------------

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const ownerDbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const sql = postgres(ownerDbUrl, { prepare: false, max: 1 })
const admin = () => createClient(url, serviceKey, { auth: { persistSession: false } })

// p = the participant under test, q = another participant, w = someone
// already waiting, h = host, o = organizer, x = never an org member.
const who = ['p', 'q', 'w', 'h', 'o', 'x'] as const
type Who = (typeof who)[number]
const ids: Record<Who, string> = { p: '', q: '', w: '', h: '', o: '', x: '' }

beforeAll(async () => {
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for this suite')
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  for (const k of who) {
    const { data, error } = await admin().auth.admin.createUser({
      email: `sdrejoin-${k}-${tag}@demo.local`, password: 'password123', email_confirm: true,
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

/** Run `body` in a transaction that is always rolled back; return its result. */
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

/**
 * Run `stmt` AS a signed-in user, under a savepoint. Returns the error message
 * (null if it ran) and the affected row count. Afterwards the connection is
 * back to the owner role with no JWT, so fixture reads see the truth.
 */
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

const setStatus = (tx: Tx, seat: string, status: string) => () =>
  tx`update sd_participants set status = ${status} where id = ${seat}`

async function seatRow(tx: Tx, seat: string) {
  const [r] = await tx<{ status: string; checked_in: boolean; checked_in_at: Date | null; created_at: Date }[]>`
    select status, checked_in, checked_in_at, created_at from sd_participants where id = ${seat}`
  return r!
}

/** Org with p/q/w participants, h host, o organizer (all active members). x is not a member. */
async function makeOrg(tx: Tx): Promise<string> {
  const [o] = await tx<{ id: string }[]>`
    insert into orgs (name, slug) values ('SD rejoin probe', ${`sdrejoin-${Math.random().toString(36).slice(2, 10)}`})
    returning id`
  const org = o!.id
  for (const k of ['p', 'q', 'w', 'h', 'o'] as const) {
    await tx`insert into org_members (org_id, user_id, role, status, accepted_at)
             values (${org}, ${ids[k]}, 'member', 'active', now())`
  }
  const roles: [Who, string][] = [['p', 'participant'], ['q', 'participant'], ['w', 'participant'], ['h', 'host'], ['o', 'organizer']]
  for (const [k, role] of roles) {
    await tx`insert into module_roles (org_id, user_id, module_key, role) values (${org}, ${ids[k]}, 'speed-dating', ${role})`
  }
  return org
}

async function makeEvent(tx: Tx, org: string, state: string, format: object = {}): Promise<string> {
  const [e] = await tx<{ id: string }[]>`
    insert into sd_events (org_id, name, state, format)
    values (${org}, 'Rejoin probe', ${state}, ${tx.json(format as postgres.JSONValue)}) returning id`
  return e!.id
}

async function seat(tx: Tx, org: string, event: string, user: Who, status: string, side: string | null = null,
  createdAt = 'now()'): Promise<string> {
  const [s] = await tx.unsafe<{ id: string }[]>(
    `insert into sd_participants (org_id, event_id, user_id, pool_side, status, checked_in, checked_in_at, created_at)
     values ($1, $2, $3, $4, $5, true, now(), ${createdAt}) returning id`,
    [org, event, ids[user], side, status],
  )
  return s!.id
}

const twoSided = (capA: number | null) => ({
  sides: { a: { label: 'Side A', capacity: capA }, b: { label: 'Side B', capacity: null } },
})

describe('speed dating: self-rejoin after self-withdrawal (20261017010000)', () => {
  it('single pool, open event: withdrawn -> registered, check-in reset, created_at re-stamped', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'open')
      const s = await seat(tx, org, ev, 'p', 'withdrawn', null, "'2000-01-01'")
      const before = await seatRow(tx, s)
      const res = await as(tx, 'p', setStatus(tx, s, 'registered'))
      return { before, res, after: await seatRow(tx, s) }
    })
    expect(r.before.status, 'fixture premise: seat starts withdrawn').toBe('withdrawn')
    expect(r.before.checked_in, 'fixture premise: seat starts checked in').toBe(true)
    expect(r.res).toEqual({ error: null, rows: 1 })
    expect(r.after.status).toBe('registered')
    expect(r.after.checked_in).toBe(false)
    expect(r.after.checked_in_at).toBeNull()
    expect(r.after.created_at.getTime()).toBeGreaterThan(r.before.created_at.getTime())
  })

  it('two-sided: full side -> waitlisted even when the client asks for registered; room -> registered (control)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const full = await makeEvent(tx, org, 'open', twoSided(1))
      await seat(tx, org, full, 'q', 'registered', 'a')
      const s1 = await seat(tx, org, full, 'p', 'withdrawn', 'a')
      const askedRegistered = await as(tx, 'p', setStatus(tx, s1, 'registered'))

      const roomy = await makeEvent(tx, org, 'open', twoSided(2))
      await seat(tx, org, roomy, 'q', 'registered', 'a')
      const s2 = await seat(tx, org, roomy, 'p', 'withdrawn', 'a')
      // The client asks for 'waitlisted' with room free: the DB still decides.
      const askedWaitlisted = await as(tx, 'p', setStatus(tx, s2, 'waitlisted'))
      return {
        askedRegistered, full: (await seatRow(tx, s1)).status,
        askedWaitlisted, roomy: (await seatRow(tx, s2)).status,
      }
    })
    expect(r.askedRegistered.error).toBeNull()
    expect(r.full).toBe('waitlisted')
    expect(r.askedWaitlisted.error).toBeNull()
    expect(r.roomy, 'CONTROL: with room the rejoin should register').toBe('registered')
  })

  it('a rejoiner goes to the BACK of the waitlist, and waits behind people already waiting even when a seat is free', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      // Full side: q registered, w waiting since 2001; p originally registered in 2000.
      const ev = await makeEvent(tx, org, 'open', twoSided(1))
      await seat(tx, org, ev, 'q', 'registered', 'a')
      const wSeat = await seat(tx, org, ev, 'w', 'waitlisted', 'a', "'2001-01-01'")
      const pSeat = await seat(tx, org, ev, 'p', 'withdrawn', 'a', "'2000-01-01'")
      const res = await as(tx, 'p', setStatus(tx, pSeat, 'registered'))
      const order = await tx<{ id: string }[]>`
        select id from sd_participants where event_id = ${ev} and pool_side = 'a' and status = 'waitlisted'
        order by created_at asc`

      // Room on the side (cap 5, nobody registered) but w is waiting: p waits too.
      const ev2 = await makeEvent(tx, org, 'open', twoSided(5))
      await seat(tx, org, ev2, 'w', 'waitlisted', 'a', "'2001-01-01'")
      const p2 = await seat(tx, org, ev2, 'p', 'withdrawn', 'a', "'2000-01-01'")
      await as(tx, 'p', setStatus(tx, p2, 'registered'))
      return { res, order: order.map((o) => o.id), wSeat, pSeat, behindQueue: (await seatRow(tx, p2)).status }
    })
    expect(r.res.error).toBeNull()
    expect(r.order, 'both should be waiting, w first').toEqual([r.wSeat, r.pSeat])
    expect(r.behindQueue).toBe('waitlisted')
  })

  it('a REMOVED person can neither rejoin nor convert the removal to withdrawn; once an organizer clears it to withdrawn, they can (control)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'open')
      const s = await seat(tx, org, ev, 'p', 'removed')
      const rejoin = await as(tx, 'p', setStatus(tx, s, 'registered'))
      const launder = await as(tx, 'p', setStatus(tx, s, 'withdrawn'))
      const stillRemoved = (await seatRow(tx, s)).status
      const cleared = await as(tx, 'o', setStatus(tx, s, 'withdrawn'))
      const rejoinAfter = await as(tx, 'p', setStatus(tx, s, 'registered'))
      return { rejoin, launder, stillRemoved, cleared, rejoinAfter, final: (await seatRow(tx, s)).status }
    })
    expect(r.rejoin.error).toMatch(/You were removed from this event/)
    expect(r.launder.error).toMatch(/You were removed from this event/)
    expect(r.stillRemoved).toBe('removed')
    expect(r.cleared).toEqual({ error: null, rows: 1 })
    expect(r.rejoinAfter.error, 'CONTROL: after an organizer clears the removal the person may rejoin').toBeNull()
    expect(r.final).toBe('registered')
  })

  it('waitlisted cannot self-promote; registered cannot move anywhere but withdrawn (control: both can withdraw)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'open', twoSided(1))
      const qSeat = await seat(tx, org, ev, 'q', 'registered', 'a')
      const pSeat = await seat(tx, org, ev, 'p', 'waitlisted', 'a')
      const promote = await as(tx, 'p', setStatus(tx, pSeat, 'registered'))
      const qToWait = await as(tx, 'q', setStatus(tx, qSeat, 'waitlisted'))
      const qToRemoved = await as(tx, 'q', setStatus(tx, qSeat, 'removed'))
      const pWithdraw = await as(tx, 'p', setStatus(tx, pSeat, 'withdrawn'))
      const qWithdraw = await as(tx, 'q', setStatus(tx, qSeat, 'withdrawn'))
      return { promote, qToWait, qToRemoved, pWithdraw, qWithdraw,
        p: (await seatRow(tx, pSeat)).status, q: (await seatRow(tx, qSeat)).status }
    })
    expect(r.promote.error).toMatch(/You may only withdraw your registration/)
    expect(r.qToWait.error).toMatch(/You may only withdraw your registration/)
    expect(r.qToRemoved.error).toMatch(/You may only withdraw your registration/)
    expect(r.pWithdraw).toEqual({ error: null, rows: 1 })
    expect(r.qWithdraw).toEqual({ error: null, rows: 1 })
    expect([r.p, r.q]).toEqual(['withdrawn', 'withdrawn'])
  })

  it('refused unless the event is open (draft/running/complete/cancelled), control: open succeeds', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const out: Record<string, Outcome & { status: string }> = {}
      for (const state of ['draft', 'running', 'complete', 'cancelled', 'open']) {
        const ev = await makeEvent(tx, org, state)
        const s = await seat(tx, org, ev, 'p', 'withdrawn')
        const res = await as(tx, 'p', setStatus(tx, s, 'registered'))
        out[state] = { ...res, status: (await seatRow(tx, s)).status }
      }
      return out
    })
    for (const state of ['draft', 'running', 'complete', 'cancelled']) {
      expect(r[state]!.error, state).toMatch(/Registration for this event is not open/)
      expect(r[state]!.status, state).toBe('withdrawn')
    }
    expect(r.open!.error, 'CONTROL').toBeNull()
    expect(r.open!.status).toBe('registered')
  })

  it('an actively banned user is refused; an inactive ban does not block (control)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'open')
      const s = await seat(tx, org, ev, 'p', 'withdrawn')
      await tx`insert into sd_bans (org_id, banned_user_id, active) values (${org}, ${ids.p}, true)`
      const banned = await as(tx, 'p', setStatus(tx, s, 'registered'))
      const whileBanned = (await seatRow(tx, s)).status
      await tx`update sd_bans set active = false where org_id = ${org} and banned_user_id = ${ids.p}`
      const lifted = await as(tx, 'p', setStatus(tx, s, 'registered'))
      return { banned, whileBanned, lifted, after: (await seatRow(tx, s)).status }
    })
    expect(r.banned.error).toMatch(/not eligible/)
    expect(r.whileBanned).toBe('withdrawn')
    expect(r.lifted.error, 'CONTROL').toBeNull()
    expect(r.after).toBe('registered')
  })

  it("another participant cannot touch someone else's seat (0 rows), control: the owner can", async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'open')
      await seat(tx, org, ev, 'q', 'registered')
      const s = await seat(tx, org, ev, 'p', 'withdrawn')
      const other = await as(tx, 'q', setStatus(tx, s, 'registered'))
      const afterOther = (await seatRow(tx, s)).status
      const own = await as(tx, 'p', setStatus(tx, s, 'registered'))
      return { other, afterOther, own }
    })
    expect(r.other).toEqual({ error: null, rows: 0 })
    expect(r.afterOther).toBe('withdrawn')
    expect(r.own).toEqual({ error: null, rows: 1 })
  })

  it('no participant role -> refused; no org membership -> RLS matches 0 rows; never a member -> 0 rows (controls in-test)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'open')
      const s = await seat(tx, org, ev, 'p', 'withdrawn')
      // x has a seat but was never an org member (inserted by the owner connection).
      const xSeat = await seat(tx, org, ev, 'x', 'withdrawn')
      const xTry = await as(tx, 'x', setStatus(tx, xSeat, 'registered'))

      await tx`delete from module_roles where org_id = ${org} and user_id = ${ids.p} and role = 'participant'`
      const noRole = await as(tx, 'p', setStatus(tx, s, 'registered'))
      await tx`insert into module_roles (org_id, user_id, module_key, role) values (${org}, ${ids.p}, 'speed-dating', 'participant')`

      await tx`delete from org_members where org_id = ${org} and user_id = ${ids.p}`
      const notMember = await as(tx, 'p', setStatus(tx, s, 'registered'))
      const stillWithdrawn = (await seatRow(tx, s)).status

      await tx`insert into org_members (org_id, user_id, role, status, accepted_at) values (${org}, ${ids.p}, 'member', 'active', now())`
      const control = await as(tx, 'p', setStatus(tx, s, 'registered'))
      return { xTry, noRole, notMember, stillWithdrawn, control, x: (await seatRow(tx, xSeat)).status }
    })
    expect(r.xTry).toEqual({ error: null, rows: 0 })
    expect(r.x).toBe('withdrawn')
    expect(r.noRole.error).toMatch(/not eligible/)
    expect(r.notMember).toEqual({ error: null, rows: 0 })
    expect(r.stillWithdrawn).toBe('withdrawn')
    expect(r.control, 'CONTROL: with role and membership restored the rejoin succeeds').toEqual({ error: null, rows: 1 })
  })

  it('organizer: may promote, remove, clear a removal and reorder created_at — but not reinstate a removal directly', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'open', twoSided(1))
      await seat(tx, org, ev, 'q', 'registered', 'a')
      const s = await seat(tx, org, ev, 'p', 'waitlisted', 'a')
      const promote = await as(tx, 'o', setStatus(tx, s, 'registered'))
      const remove = await as(tx, 'o', setStatus(tx, s, 'removed'))
      // Consent rule (20261017010000 part D): removed -> registered is the
      // person's own act (via withdrawn), never the organizer's.
      const reinstate = await as(tx, 'o', setStatus(tx, s, 'registered'))
      const clear = await as(tx, 'o', setStatus(tx, s, 'withdrawn'))
      const stamp = await as(tx, 'o', () => tx`update sd_participants set created_at = '2000-01-01' where id = ${s}`)
      return { promote, remove, reinstate, clear, stamp, row: await seatRow(tx, s) }
    })
    for (const k of ['promote', 'remove', 'clear', 'stamp'] as const) {
      expect(r[k], k).toEqual({ error: null, rows: 1 })
    }
    expect(r.reinstate.error).toMatch(/Only the person can register again/)
    expect(r.row.status).toBe('withdrawn')
    expect(r.row.created_at.toISOString().slice(0, 10)).toBe('2000-01-01')
  })

  it('host unchanged: may remove, may not reinstate a withdrawn seat', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'open')
      const qSeat = await seat(tx, org, ev, 'q', 'registered')
      const pSeat = await seat(tx, org, ev, 'p', 'withdrawn')
      const reinstate = await as(tx, 'h', setStatus(tx, pSeat, 'registered'))
      const remove = await as(tx, 'h', setStatus(tx, qSeat, 'removed'))
      return { reinstate, remove, p: (await seatRow(tx, pSeat)).status, q: (await seatRow(tx, qSeat)).status }
    })
    // The consent rule (nobody but the person re-registers a withdrawn seat)
    // fires before host triage.
    expect(r.reinstate.error).toMatch(/Only the person can register again/)
    expect(r.p).toBe('withdrawn')
    expect(r.remove, 'CONTROL: host removal still works').toEqual({ error: null, rows: 1 })
    expect(r.q).toBe('removed')
  })

  it('a waitlisted participant can no longer move themselves up the queue via created_at (control: profile edit still lands)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'open', twoSided(1))
      await seat(tx, org, ev, 'q', 'registered', 'a')
      const s = await seat(tx, org, ev, 'p', 'waitlisted', 'a')
      const before = await seatRow(tx, s)
      const res = await as(tx, 'p', () =>
        tx`update sd_participants set created_at = '1970-01-01', profile_card = 'hello' where id = ${s}`)
      const [after] = await tx<{ created_at: Date; profile_card: string | null }[]>`
        select created_at, profile_card from sd_participants where id = ${s}`
      return { before, res, after: after! }
    })
    expect(r.res).toEqual({ error: null, rows: 1 })
    expect(r.after.profile_card, 'CONTROL: the same UPDATE did land').toBe('hello')
    expect(r.after.created_at.getTime()).toBe(r.before.created_at.getTime())
  })
})
