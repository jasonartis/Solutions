import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'

// ---------------------------------------------------------------------------
// SPEED DATING: THE `closed` EVENT STATE (20261027010000).
//
// closed = "registration closed, event still alive". Every route by which a
// person could put THEMSELVES on a live seat is probed against a closed event,
// each with a CONTROL (the same act succeeds when the event is open) so a
// refusal cannot pass for an unrelated reason. Then the state machine, the
// back-to-draft rule, visibility, and two MUTATION CHECKS that re-run a
// scenario against a deliberately weakened function (inside a rolled-back
// transaction — function definitions are transactional) to prove the tests
// have teeth.
//
// Throwaway accounts; every probe runs in a transaction that is ALWAYS rolled
// back, except the concurrency test, which needs two connections and so
// commits a fixture org and deletes it in `finally`. CI runs e2e on this
// database next with no reset between, so nothing may leak.
// ---------------------------------------------------------------------------

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const ownerDbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const sql = postgres(ownerDbUrl, { prepare: false, max: 1 })
const sql2 = postgres(ownerDbUrl, { prepare: false, max: 1 })
const admin = () => createClient(url, serviceKey, { auth: { persistSession: false } })

// p = the participant under test, q = another participant, o = organizer of
// every event, f = a member whose organizer grant is given per test (scoped).
const who = ['p', 'q', 'o', 'f'] as const
type Who = (typeof who)[number]
const ids: Record<Who, string> = { p: '', q: '', o: '', f: '' }

beforeAll(async () => {
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for this suite')
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  for (const k of who) {
    const { data, error } = await admin().auth.admin.createUser({
      email: `sdclosed-${k}-${tag}@demo.local`, password: 'password123', email_confirm: true,
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
    await sql2.end()
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

/** Run `stmt` AS a signed-in user, under a savepoint (same helper as sd-self-rejoin.test.ts). */
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

async function makeOrg(tx: Tx | postgres.Sql): Promise<string> {
  const [o] = await tx<{ id: string }[]>`
    insert into orgs (name, slug) values ('SD closed probe', ${`sdclosed-${Math.random().toString(36).slice(2, 10)}`})
    returning id`
  const org = o!.id
  for (const k of who) {
    await tx`insert into org_members (org_id, user_id, role, status, accepted_at)
             values (${org}, ${ids[k]}, 'member', 'active', now())`
  }
  const roles: [Who, string][] = [['p', 'participant'], ['q', 'participant'], ['o', 'organizer']]
  for (const [k, role] of roles) {
    await tx`insert into module_roles (org_id, user_id, module_key, role) values (${org}, ${ids[k]}, 'speed-dating', ${role})`
  }
  return org
}

async function makeEvent(tx: Tx | postgres.Sql, org: string, state: string, format: object = {}): Promise<string> {
  const [e] = await tx<{ id: string }[]>`
    insert into sd_events (org_id, name, state, format)
    values (${org}, 'Closed probe', ${state}, ${tx.json(format as postgres.JSONValue)}) returning id`
  return e!.id
}

/** Fixture seat written as the owner (no JWT: guards bypassed by design). */
async function seat(tx: Tx, org: string, event: string, user: Who, status: string, side: string | null = null): Promise<string> {
  const [s] = await tx<{ id: string }[]>`
    insert into sd_participants (org_id, event_id, user_id, pool_side, status)
    values (${org}, ${event}, ${ids[user]}, ${side}, ${status}) returning id`
  return s!.id
}

/** Fixture state change as the owner — fires the guard (it fires without a JWT too). */
async function setState(tx: Tx, event: string, state: string) {
  await tx`update sd_events set state = ${state} where id = ${event}`
}

const statusOf = async (tx: Tx, s: string) =>
  (await tx<{ status: string }[]>`select status from sd_participants where id = ${s}`)[0]!.status
const stateOf = async (tx: Tx, e: string) =>
  (await tx<{ state: string }[]>`select state from sd_events where id = ${e}`)[0]!.state

const selfInsert = (tx: Tx, org: string, ev: string, side: string | null = null) => () =>
  tx`insert into sd_participants (org_id, event_id, user_id, pool_side, status)
     values (${org}, ${ev}, ${ids.p}, ${side}, 'registered')`
const setStatus = (tx: Tx, s: string, status: string) => () =>
  tx`update sd_participants set status = ${status} where id = ${s}`
const moveEvent = (tx: Tx, ev: string, state: string) => () =>
  tx`update sd_events set state = ${state} where id = ${ev}`

const twoSided = (capA: number | null) => ({
  sides: { a: { label: 'Side A', capacity: capA }, b: { label: 'Side B', capacity: null } },
})

/**
 * Replace a function body inside the current (rolled-back) transaction with
 * `from` swapped for `to`. Throws if `from` is absent, so a mutation can never
 * silently mutate nothing.
 */
async function mutate(tx: Tx, fn: string, from: string, to: string) {
  const [d] = await tx<{ def: string }[]>`select pg_get_functiondef(${`public.${fn}`}::regprocedure) as def`
  if (!d!.def.includes(from)) throw new Error(`mutation target not found in ${fn}: ${from}`)
  await tx.unsafe(d!.def.split(from).join(to))
}

describe('speed dating: closed event state — no new registration by a person\'s own act (20261027010000)', () => {
  it('fresh self-registration: refused while closed; succeeds while open (control)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const closed = await makeEvent(tx, org, 'closed')
      const open = await makeEvent(tx, org, 'open')
      return { closed: await as(tx, 'p', selfInsert(tx, org, closed)), open: await as(tx, 'p', selfInsert(tx, org, open)) }
    })
    expect(r.open).toEqual({ error: null, rows: 1 })
    expect(r.closed.error).toContain('Registration for this event is closed')
  })

  it('two-sided fresh registration (waitlist path): refused while closed; control open', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const closed = await makeEvent(tx, org, 'closed', twoSided(0))
      const open = await makeEvent(tx, org, 'open', twoSided(0))
      return { closed: await as(tx, 'p', selfInsert(tx, org, closed, 'a')), open: await as(tx, 'p', selfInsert(tx, org, open, 'a')) }
    })
    expect(r.open).toEqual({ error: null, rows: 1 })
    expect(r.closed.error).toContain('Registration for this event is closed')
  })

  it('INSERT ... ON CONFLICT DO UPDATE on an existing withdrawn seat cannot rejoin while closed', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'closed')
      const s = await seat(tx, org, ev, 'p', 'withdrawn')
      const res = await as(tx, 'p', () =>
        tx`insert into sd_participants (org_id, event_id, user_id, status) values (${org}, ${ev}, ${ids.p}, 'registered')
           on conflict (event_id, user_id) do update set status = 'registered'`)
      return { res, after: await statusOf(tx, s) }
    })
    expect(r.res.error).not.toBeNull()
    expect(r.after).toBe('withdrawn')
  })

  it('withdrawn person registering again: refused while closed; succeeds while open (control)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const closed = await makeEvent(tx, org, 'closed')
      const open = await makeEvent(tx, org, 'open')
      const sc = await seat(tx, org, closed, 'p', 'withdrawn')
      const so = await seat(tx, org, open, 'p', 'withdrawn')
      return {
        closed: await as(tx, 'p', setStatus(tx, sc, 'registered')),
        closedAfter: await statusOf(tx, sc),
        open: await as(tx, 'p', setStatus(tx, so, 'registered')),
        openAfter: await statusOf(tx, so),
      }
    })
    expect(r.open).toEqual({ error: null, rows: 1 })
    expect(r.openAfter).toBe('registered')
    expect(r.closed.error).toContain('Registration for this event is closed')
    expect(r.closedAfter).toBe('withdrawn')
  })

  it('waitlist promotion: refused by the person\'s own act; an organizer may still promote while closed', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'closed', twoSided(1))
      const sp = await seat(tx, org, ev, 'p', 'waitlisted', 'a')
      const sq = await seat(tx, org, ev, 'q', 'waitlisted', 'a')
      const self = await as(tx, 'p', setStatus(tx, sp, 'registered'))
      const byOrganizer = await as(tx, 'o', setStatus(tx, sq, 'registered'))
      return { self, selfAfter: await statusOf(tx, sp), byOrganizer, orgAfter: await statusOf(tx, sq) }
    })
    expect(r.self.error).not.toBeNull()
    expect(r.selfAfter).toBe('waitlisted')
    expect(r.byOrganizer).toEqual({ error: null, rows: 1 })
    expect(r.orgAfter).toBe('registered')
  })

  it('withdrawing is still allowed while closed (registered and waitlisted)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'closed')
      const sp = await seat(tx, org, ev, 'p', 'registered')
      const sq = await seat(tx, org, ev, 'q', 'waitlisted')
      const a = await as(tx, 'p', setStatus(tx, sp, 'withdrawn'))
      const b = await as(tx, 'q', setStatus(tx, sq, 'withdrawn'))
      return { a, b, pAfter: await statusOf(tx, sp), qAfter: await statusOf(tx, sq) }
    })
    expect(r.a).toEqual({ error: null, rows: 1 })
    expect(r.b).toEqual({ error: null, rows: 1 })
    expect(r.pAfter).toBe('withdrawn')
    expect(r.qAfter).toBe('withdrawn')
  })

  it('an organizer can still clear a removal while closed; the person still cannot rejoin until reopened', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'closed')
      const s = await seat(tx, org, ev, 'p', 'removed')
      const clear = await as(tx, 'o', setStatus(tx, s, 'withdrawn'))
      const rejoinClosed = await as(tx, 'p', setStatus(tx, s, 'registered'))
      await setState(tx, ev, 'open')
      const rejoinOpen = await as(tx, 'p', setStatus(tx, s, 'registered'))
      return { clear, rejoinClosed, rejoinOpen, after: await statusOf(tx, s) }
    })
    expect(r.clear).toEqual({ error: null, rows: 1 })
    expect(r.rejoinClosed.error).toContain('closed')
    expect(r.rejoinOpen).toEqual({ error: null, rows: 1 })
    expect(r.after).toBe('registered')
  })

  it('reopen restores registration: open -> closed (refused) -> open (accepted)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'open')
      const close = await as(tx, 'o', moveEvent(tx, ev, 'closed'))
      const whileClosed = await as(tx, 'p', selfInsert(tx, org, ev))
      const reopen = await as(tx, 'o', moveEvent(tx, ev, 'open'))
      const afterReopen = await as(tx, 'p', selfInsert(tx, org, ev))
      return { close, whileClosed, reopen, afterReopen }
    })
    expect(r.close).toEqual({ error: null, rows: 1 })
    expect(r.whileClosed.error).toContain('closed')
    expect(r.reopen).toEqual({ error: null, rows: 1 })
    expect(r.afterReopen).toEqual({ error: null, rows: 1 })
  })
})

describe('speed dating: closed event state — the state machine (20261027010000)', () => {
  const legal: [string, string][] = [
    ['draft', 'open'], ['draft', 'cancelled'],
    ['open', 'closed'], ['open', 'running'], ['open', 'cancelled'], ['open', 'draft'],
    ['closed', 'open'], ['closed', 'running'], ['closed', 'cancelled'], ['closed', 'draft'],
    ['running', 'complete'], ['running', 'cancelled'],
  ]
  const illegal: [string, string][] = [
    ['draft', 'closed'], ['draft', 'running'], ['closed', 'complete'], ['running', 'closed'],
    ['running', 'open'], ['running', 'draft'], ['complete', 'closed'], ['complete', 'open'],
    ['cancelled', 'open'], ['cancelled', 'closed'], ['cancelled', 'draft'],
  ]

  it('every legal move succeeds as the organizer; every illegal one is refused', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const out: Record<string, Outcome> = {}
      for (const [from, to] of [...legal, ...illegal]) {
        const ev = await makeEvent(tx, org, from)
        out[`${from}->${to}`] = await as(tx, 'o', moveEvent(tx, ev, to))
      }
      return out
    })
    for (const [from, to] of legal) expect(r[`${from}->${to}`], `${from}->${to}`).toEqual({ error: null, rows: 1 })
    for (const [from, to] of illegal) expect(r[`${from}->${to}`]!.error, `${from}->${to}`).toContain('Illegal event transition')
  })

  it('a participant cannot close, reopen or draft an event (RLS: 0 rows); the organizer can (control)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'open')
      const byP = await as(tx, 'p', moveEvent(tx, ev, 'closed'))
      const stateAfterP = await stateOf(tx, ev)
      const byO = await as(tx, 'o', moveEvent(tx, ev, 'closed'))
      return { byP, stateAfterP, byO, stateAfterO: await stateOf(tx, ev) }
    })
    expect(r.byP.rows).toBe(0)
    expect(r.stateAfterP).toBe('open')
    expect(r.byO).toEqual({ error: null, rows: 1 })
    expect(r.stateAfterO).toBe('closed')
  })

  it('back to draft: refused with ONE registered or ONE waitlisted seat or a round; allowed with only withdrawn/removed seats', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const out: Record<string, Outcome> = {}
      for (const [label, from, status] of [
        ['open+registered', 'open', 'registered'], ['closed+registered', 'closed', 'registered'],
        ['open+waitlisted', 'open', 'waitlisted'], ['closed+waitlisted', 'closed', 'waitlisted'],
      ] as const) {
        const ev = await makeEvent(tx, org, from)
        await seat(tx, org, ev, 'p', status)
        out[label] = await as(tx, 'o', moveEvent(tx, ev, 'draft'))
      }
      const withRound = await makeEvent(tx, org, 'closed')
      await tx`insert into sd_rounds (org_id, event_id, round_number) values (${org}, ${withRound}, 1)`
      out['closed+round'] = await as(tx, 'o', moveEvent(tx, withRound, 'draft'))

      const empty = await makeEvent(tx, org, 'closed')
      await seat(tx, org, empty, 'p', 'withdrawn')
      await seat(tx, org, empty, 'q', 'removed')
      out['closed+only-dead-seats'] = await as(tx, 'o', moveEvent(tx, empty, 'draft'))
      const bare = await makeEvent(tx, org, 'open')
      out['open+none'] = await as(tx, 'o', moveEvent(tx, bare, 'draft'))
      return out
    })
    for (const k of ['open+registered', 'closed+registered', 'open+waitlisted', 'closed+waitlisted', 'closed+round']) {
      expect(r[k]!.error, k).toContain('cannot go back to draft')
    }
    expect(r['closed+only-dead-seats']).toEqual({ error: null, rows: 1 })
    expect(r['open+none']).toEqual({ error: null, rows: 1 })
  })

  it('a participant can still READ a closed event (it does not vanish); a draft stays hidden (control)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const closed = await makeEvent(tx, org, 'closed')
      const draft = await makeEvent(tx, org, 'draft')
      const read = (ev: string) => as(tx, 'q', () => tx`select id from sd_events where id = ${ev}`)
      return { closed: await read(closed), draft: await read(draft) }
    })
    expect(r.closed).toEqual({ error: null, rows: 1 })
    expect(r.draft).toEqual({ error: null, rows: 0 })
  })
})

describe('speed dating: closed event state — a seat cannot be moved into another event (review hole, 2026-10-27)', () => {
  /**
   * f becomes an organizer of `ev` ONLY (scoped grant on the event's scope
   * node), and a participant — like the seeded attacker in the review (frank).
   * Without the participant grant Y is invisible to f and the non-definer scope
   * trigger refuses the move with "Unknown event", which would make the
   * mutation check pass for an unrelated reason.
   */
  async function scopeOrganizer(tx: Tx, org: string, ev: string) {
    await tx`insert into module_roles (org_id, user_id, module_key, role) values (${org}, ${ids.f}, 'speed-dating', 'participant')`
    const [n] = await tx<{ scope_node_id: string }[]>`select scope_node_id from sd_events where id = ${ev}`
    if (!n?.scope_node_id) throw new Error('fixture premise: event has a scope node')
    await tx`insert into module_roles (org_id, user_id, module_key, role, scope_ref)
             values (${org}, ${ids.f}, 'speed-dating', 'organizer', ${n.scope_node_id})`
  }
  const moveSeat = (tx: Tx, s: string, to: string) => () => tx`update sd_participants set event_id = ${to} where id = ${s}`

  it('an organizer scoped to X cannot move a seat from X into closed Y; control: the scoped grant really organizes X', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const x = await makeEvent(tx, org, 'open')
      const y = await makeEvent(tx, org, 'closed')
      await scopeOrganizer(tx, org, x)
      const controlInsert = await as(tx, 'f', () =>
        tx`insert into sd_participants (org_id, event_id, user_id, status) values (${org}, ${x}, ${ids.f}, 'registered') returning id`)
      const [s] = await tx<{ id: string }[]>`select id from sd_participants where event_id = ${x} and user_id = ${ids.f}`
      const move = await as(tx, 'f', moveSeat(tx, s!.id, y))
      const [after] = await tx<{ event_id: string }[]>`select event_id from sd_participants where id = ${s!.id}`
      return { controlInsert, move, after: after!.event_id, x }
    })
    expect(r.controlInsert, 'CONTROL: f organizes X').toEqual({ error: null, rows: 1 })
    expect(r.move.error).toContain('cannot be moved to another event')
    expect(r.after).toBe(r.x)
  })

  it('even a whole-module organizer cannot move a seat between events (delete and re-register instead)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const x = await makeEvent(tx, org, 'open')
      const y = await makeEvent(tx, org, 'open')
      const s = await seat(tx, org, x, 'p', 'registered')
      return as(tx, 'o', moveSeat(tx, s, y))
    })
    expect(r.error).toContain('cannot be moved to another event')
  })

  it('MUTATION: without the event_id refusal the scoped organizer lands a REGISTERED seat in closed Y', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const x = await makeEvent(tx, org, 'open')
      const y = await makeEvent(tx, org, 'closed')
      await scopeOrganizer(tx, org, x)
      await as(tx, 'f', () =>
        tx`insert into sd_participants (org_id, event_id, user_id, status) values (${org}, ${x}, ${ids.f}, 'registered')`)
      const [s] = await tx<{ id: string }[]>`select id from sd_participants where event_id = ${x} and user_id = ${ids.f}`
      await mutate(tx, 'sd_pin_participant()', 'if new.event_id is distinct from old.event_id then', 'if false then')
      const move = await as(tx, 'f', moveSeat(tx, s!.id, y))
      const [after] = await tx<{ event_id: string; status: string }[]>`select event_id, status from sd_participants where id = ${s!.id}`
      return { move, after: after!, y }
    })
    expect(r.move).toEqual({ error: null, rows: 1 })
    expect(r.after).toEqual({ event_id: r.y, status: 'registered' })
  })
})

describe('speed dating: closed event state — mutation checks (the tests above have teeth)', () => {
  it('weakening the insert guard to admit closed makes the closed self-registration SUCCEED', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'closed')
      const real = await as(tx, 'p', selfInsert(tx, org, ev))
      await mutate(tx, 'sd_participants_insert_guard()', "if ev.state = 'closed' then", 'if false then')
      await mutate(tx, 'sd_participants_insert_guard()', "if ev.state is distinct from 'open' then", "if ev.state not in ('open', 'closed') then")
      const mutated = await as(tx, 'p', selfInsert(tx, org, ev))
      return { real, mutated }
    })
    expect(r.real.error).toContain('closed')
    expect(r.mutated).toEqual({ error: null, rows: 1 })
  })

  it('removing the live-seat check from the guard lets an event with a registration go back to draft', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'closed')
      await seat(tx, org, ev, 'p', 'registered')
      const real = await as(tx, 'o', moveEvent(tx, ev, 'draft'))
      await mutate(tx, 'sd_guard_event()', "if new.state = 'draft' then", 'if false then')
      const mutated = await as(tx, 'o', moveEvent(tx, ev, 'draft'))
      return { real, mutated }
    })
    expect(r.real.error).toContain('cannot go back to draft')
    expect(r.mutated).toEqual({ error: null, rows: 1 })
  })
})

describe('speed dating: closed event state — concurrency (two connections)', () => {
  it('a registration in flight blocks the organizer\'s back-to-draft until it settles (FOR SHARE on the event)', async () => {
    // Committed fixture (a second connection cannot see an uncommitted one);
    // deleted in finally. The dater's transaction is held open and rolled back.
    const org = await makeOrg(sql)
    try {
      const ev = await makeEvent(sql, org, 'open')
      let organizer: { error: string | null } = { error: null }
      await rolledBack(async (tx) => {
        const reg = await as(tx, 'p', selfInsert(tx, org, ev))
        expect(reg, 'premise: the registration itself succeeded').toEqual({ error: null, rows: 1 })
        // Registration uncommitted: the organizer must WAIT, not slip past.
        await sql2.begin(async (t2) => {
          await t2.unsafe("set local lock_timeout = '400ms'")
          await t2`update sd_events set state = 'draft' where id = ${ev}`
        }).then(
          () => { organizer = { error: null } },
          (e: unknown) => { organizer = { error: String((e as Error).message) } },
        )
      })
      expect(organizer.error).toContain('lock timeout')
      // Control: with the registration rolled back, the same move goes through.
      const [after] = await sql2<{ state: string }[]>`update sd_events set state = 'draft' where id = ${ev} returning state`
      expect(after!.state).toBe('draft')
    } finally {
      await sql`delete from orgs where id = ${org}`
    }
  })

  it('MUTATION: without FOR SHARE the back-to-draft slips past an in-flight registration (the race is real)', async () => {
    const org = await makeOrg(sql)
    try {
      const ev = await makeEvent(sql, org, 'open')
      let organizer: { error: string | null } = { error: 'not run' }
      await rolledBack(async (tx) => {
        // The mutation lives only in this (rolled-back) transaction.
        await mutate(tx, 'sd_participants_insert_guard()', 'where e.id = new.event_id for share', 'where e.id = new.event_id')
        const reg = await as(tx, 'p', selfInsert(tx, org, ev))
        expect(reg, 'premise: the registration itself succeeded').toEqual({ error: null, rows: 1 })
        await sql2.begin(async (t2) => {
          await t2.unsafe("set local lock_timeout = '400ms'")
          await t2`update sd_events set state = 'draft' where id = ${ev}`
        }).then(
          () => { organizer = { error: null } },
          (e: unknown) => { organizer = { error: String((e as Error).message) } },
        )
      })
      // Not blocked and not refused: had the dater committed, a live seat would sit on a draft event.
      expect(organizer.error).toBeNull()
    } finally {
      await sql`delete from orgs where id = ${org}`
    }
  })
})
