import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'

// ---------------------------------------------------------------------------
// SPEED DATING: HOST UN-TICK + CAMERA/MIC/CONNECTION STATUS (20261109010000).
//
// Part 1 — only the person ticks themselves in. On SOMEONE ELSE's seat, staff
// (organizer, host, an event-scoped host) may take a tick away (true -> false,
// time cleared) and nothing else: no tick-in, no moving "ready since".
// Part 2 — sd_device_status: written only for the caller's own seat through
// sd_report_device_status (server-side throttle, server-stamped time), read by
// the event's staff and the person; nobody else. Rows die with the event's live
// states and with the account silhouette.
//
// Every probe runs AS a signed-in user (role authenticated + JWT claims, the
// same helper as sd-closed-state.test.ts) in a transaction that is ALWAYS
// rolled back; the two-connection test commits a fixture org and deletes it in
// `finally`. Every negative has a control (docs/03 vacuity rule) and the two
// load-bearing rules have mutation checks.
// ---------------------------------------------------------------------------

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const ownerDbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const sql = postgres(ownerDbUrl, { prepare: false, max: 1 })
const sql2 = postgres(ownerDbUrl, { prepare: false, max: 1 })
const admin = () => createClient(url, serviceKey, { auth: { persistSession: false } })

// p = the dater under test, q = another dater at the same event, o = organizer,
// h = host (whole module), s = host scoped to ONE event (granted per test),
// b = organizer of a DIFFERENT org, x = never a member of anything here.
const who = ['p', 'q', 'o', 'h', 's', 'b', 'x'] as const
type Who = (typeof who)[number]
const ids: Record<Who, string> = { p: '', q: '', o: '', h: '', s: '', b: '', x: '' }

beforeAll(async () => {
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for this suite')
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  for (const k of who) {
    const { data, error } = await admin().auth.admin.createUser({
      email: `sddevice-${k}-${tag}@demo.local`, password: 'password123', email_confirm: true,
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

type Outcome = { error: string | null; rows: number; value: unknown }

/** Run `stmt` AS a signed-in user under a savepoint; `value` is the first column of the first row. */
async function as(tx: Tx, user: Who, stmt: () => Promise<postgres.RowList<postgres.Row[]>>): Promise<Outcome> {
  await tx.unsafe('savepoint sp')
  let out: Outcome
  try {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: ids[user], role: 'authenticated' })}, true)`
    await tx.unsafe('set local role authenticated')
    const r = await stmt()
    await tx.unsafe('release savepoint sp')
    const first = r[0] ? Object.values(r[0])[0] : undefined
    out = { error: null, rows: r.count, value: first }
  } catch (e: unknown) {
    await tx.unsafe('rollback to savepoint sp')
    out = { error: String((e as Error).message), rows: 0, value: undefined }
  }
  await tx.unsafe('reset role')
  await tx`select set_config('request.jwt.claims', '', true)`
  return out
}

/** Org A: p, q daters; o organizer; h host; s a member whose host grant is scoped per test. */
async function makeOrg(tx: Tx | postgres.Sql): Promise<string> {
  const [o] = await tx<{ id: string }[]>`
    insert into orgs (name, slug) values ('SD device probe', ${`sddevice-${Math.random().toString(36).slice(2, 10)}`})
    returning id`
  const org = o!.id
  for (const k of ['p', 'q', 'o', 'h', 's'] as Who[]) {
    await tx`insert into org_members (org_id, user_id, role, status, accepted_at)
             values (${org}, ${ids[k]}, 'member', 'active', now())`
  }
  const roles: [Who, string][] = [['p', 'participant'], ['q', 'participant'], ['o', 'organizer'], ['h', 'host']]
  for (const [k, role] of roles) {
    await tx`insert into module_roles (org_id, user_id, module_key, role) values (${org}, ${ids[k]}, 'speed-dating', ${role})`
  }
  return org
}

/** Org B: b is its organizer and a member of nothing in org A. */
async function makeOtherOrg(tx: Tx): Promise<{ org: string; ev: string }> {
  const [o] = await tx<{ id: string }[]>`
    insert into orgs (name, slug) values ('SD device other', ${`sddevice-b-${Math.random().toString(36).slice(2, 10)}`})
    returning id`
  await tx`insert into org_members (org_id, user_id, role, status, accepted_at) values (${o!.id}, ${ids.b}, 'member', 'active', now())`
  await tx`insert into module_roles (org_id, user_id, module_key, role) values (${o!.id}, ${ids.b}, 'speed-dating', 'organizer')`
  return { org: o!.id, ev: await makeEvent(tx, o!.id, 'running') }
}

async function makeEvent(tx: Tx | postgres.Sql, org: string, state: string): Promise<string> {
  const [e] = await tx<{ id: string }[]>`
    insert into sd_events (org_id, name, state) values (${org}, 'Device probe', ${state}) returning id`
  return e!.id
}

/** Fixture seat written as the owner (no JWT: guards bypassed by design). */
async function seat(tx: Tx, org: string, event: string, user: Who, status = 'registered', checkedIn = false): Promise<string> {
  const [s] = await tx<{ id: string }[]>`
    insert into sd_participants (org_id, event_id, user_id, status) values (${org}, ${event}, ${ids[user]}, ${status}) returning id`
  if (checkedIn) {
    // As the owner (no JWT), so the pin trigger lets the fixture through; a fixed past time.
    await tx`update sd_participants set checked_in = true, checked_in_at = now() - interval '10 minutes' where id = ${s!.id}`
  }
  return s!.id
}

/** Grant s the host role scoped to ONE event's scope node. */
async function scopeHost(tx: Tx, org: string, ev: string) {
  const [n] = await tx<{ scope_node_id: string }[]>`select scope_node_id from sd_events where id = ${ev}`
  if (!n?.scope_node_id) throw new Error('fixture premise: event has a scope node')
  await tx`insert into module_roles (org_id, user_id, module_key, role, scope_ref)
           values (${org}, ${ids.s}, 'speed-dating', 'host', ${n.scope_node_id})`
}

const checkIn = async (tx: Tx, s: string) =>
  (await tx<{ checked_in: boolean; checked_in_at: Date | null }[]>`select checked_in, checked_in_at from sd_participants where id = ${s}`)[0]!

const setTick = (tx: Tx, s: string, value: boolean) => () =>
  tx`update sd_participants set checked_in = ${value}, checked_in_at = ${value ? new Date() : null} where id = ${s}`

const report = (tx: Tx, ev: string, camera = 'ok', mic = 'ok', connection = 'not_in_call') => () =>
  tx`select public.sd_report_device_status(${ev}, ${camera}, ${mic}, ${connection}) as r`

const visibleRows = (tx: Tx, ev: string) => () =>
  tx`select participant_id from sd_device_status where event_id = ${ev}`

/** Owner-side: move a seat's last report into the past (now() is fixed inside one transaction). */
const age = (tx: Tx, s: string, seconds: number) =>
  tx`update sd_device_status set reported_at = now() - make_interval(secs => ${seconds}) where participant_id = ${s}`

/** Replace a function body inside the current (rolled-back) transaction; throws if `from` is absent. */
async function mutate(tx: Tx, fn: string, from: string, to: string) {
  const [d] = await tx<{ def: string }[]>`select pg_get_functiondef(${`public.${fn}`}::regprocedure) as def`
  if (!d!.def.includes(from)) throw new Error(`mutation target not found in ${fn}: ${from}`)
  await tx.unsafe(d!.def.split(from).join(to))
}

// ===========================================================================
// PART 1 — check-in on someone else's seat can only be taken away.
// ===========================================================================
describe('speed dating: only the person ticks themselves in (20261109010000)', () => {
  it('a host un-ticks someone: checked_in false, time cleared (it was silently reverted before)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'running')
      const s = await seat(tx, org, ev, 'p', 'registered', true)
      const before = await checkIn(tx, s)
      const res = await as(tx, 'h', setTick(tx, s, false))
      return { before, res, after: await checkIn(tx, s) }
    })
    expect(r.before.checked_in, 'premise: p is ticked').toBe(true)
    expect(r.res).toMatchObject({ error: null, rows: 1 })
    expect(r.after).toEqual({ checked_in: false, checked_in_at: null })
  })

  it('a host cannot tick someone in; the person can (control)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'running')
      const sq = await seat(tx, org, ev, 'q')
      const sp = await seat(tx, org, ev, 'p')
      const host = await as(tx, 'h', setTick(tx, sq, true))
      const self = await as(tx, 'p', setTick(tx, sp, true))
      return { host, q: await checkIn(tx, sq), self, p: await checkIn(tx, sp) }
    })
    expect(r.host.error).toContain('Only the person can check themselves in')
    expect(r.q.checked_in).toBe(false)
    expect(r.self).toMatchObject({ error: null, rows: 1 })
    expect(r.p.checked_in, 'CONTROL: self check-in still works').toBe(true)
    expect(r.p.checked_in_at).not.toBeNull()
  })

  it('an ORGANIZER cannot tick someone in either (the rule is the database\'s now); un-tick works (control)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'running')
      const sq = await seat(tx, org, ev, 'q')
      const sp = await seat(tx, org, ev, 'p', 'registered', true)
      const tickIn = await as(tx, 'o', setTick(tx, sq, true))
      const untick = await as(tx, 'o', setTick(tx, sp, false))
      return { tickIn, q: await checkIn(tx, sq), untick, p: await checkIn(tx, sp) }
    })
    expect(r.tickIn.error).toContain('Only the person can check themselves in')
    expect(r.q.checked_in).toBe(false)
    expect(r.untick).toMatchObject({ error: null, rows: 1 })
    expect(r.p).toEqual({ checked_in: false, checked_in_at: null })
  })

  it('a bulk "everyone arrived" update by an organizer fails as a whole', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'running')
      await seat(tx, org, ev, 'p')
      await seat(tx, org, ev, 'q')
      const res = await as(tx, 'o', () => tx`update sd_participants set checked_in = true where event_id = ${ev}`)
      const [n] = await tx<{ n: number }[]>`select count(*)::int as n from sd_participants where event_id = ${ev} and checked_in`
      return { res, ticked: n!.n }
    })
    expect(r.res.error).toContain('Only the person can check themselves in')
    expect(r.ticked).toBe(0)
  })

  it('nobody else can move "ready since": checked_in_at is pinned for organizer and host', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'running')
      const s = await seat(tx, org, ev, 'p', 'registered', true)
      const before = (await checkIn(tx, s)).checked_in_at!.getTime()
      const moveTo = new Date(Date.now() + 3_600_000)
      const byO = await as(tx, 'o', () => tx`update sd_participants set checked_in_at = ${moveTo} where id = ${s}`)
      const afterO = (await checkIn(tx, s)).checked_in_at!.getTime()
      const byH = await as(tx, 'h', () => tx`update sd_participants set checked_in_at = ${moveTo} where id = ${s}`)
      const afterH = (await checkIn(tx, s)).checked_in_at!.getTime()
      return { before, byO, afterO, byH, afterH }
    })
    expect(r.byO, 'premise: the organizer write reached the row').toMatchObject({ error: null, rows: 1 })
    expect(r.byH, 'premise: the host write reached the row').toMatchObject({ error: null, rows: 1 })
    expect(r.afterO).toBe(r.before)
    expect(r.afterH).toBe(r.before)
  })

  it('a host scoped to event X un-ticks in X (control) and reaches no row in event Y', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const x = await makeEvent(tx, org, 'running')
      const y = await makeEvent(tx, org, 'running')
      await scopeHost(tx, org, x)
      const sx = await seat(tx, org, x, 'p', 'registered', true)
      const sy = await seat(tx, org, y, 'q', 'registered', true)
      const inX = await as(tx, 's', setTick(tx, sx, false))
      const inY = await as(tx, 's', setTick(tx, sy, false))
      return { inX, x: await checkIn(tx, sx), inY, y: await checkIn(tx, sy) }
    })
    expect(r.inX).toMatchObject({ error: null, rows: 1 })
    expect(r.x.checked_in, 'CONTROL: scoped host un-ticked in their own event').toBe(false)
    expect(r.inY).toMatchObject({ error: null, rows: 0 })
    expect(r.y.checked_in).toBe(true)
  })

  it('a host still may only REMOVE someone (unchanged), and may un-tick in the same statement', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'running')
      const s = await seat(tx, org, ev, 'p', 'registered', true)
      const withdraw = await as(tx, 'h', () => tx`update sd_participants set status = 'withdrawn' where id = ${s}`)
      const remove = await as(tx, 'h', () =>
        tx`update sd_participants set status = 'removed', checked_in = false where id = ${s}`)
      const [row] = await tx<{ status: string; checked_in: boolean }[]>`select status, checked_in from sd_participants where id = ${s}`
      return { withdraw, remove, row: row! }
    })
    expect(r.withdraw.error).toContain('Host may only remove a participant')
    expect(r.remove).toMatchObject({ error: null, rows: 1 })
    expect(r.row).toEqual({ status: 'removed', checked_in: false })
  })

  it('MUTATION: without the rule, an organizer AND a host could tick someone in', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'running')
      const sp = await seat(tx, org, ev, 'p')
      const sq = await seat(tx, org, ev, 'q')
      await mutate(tx, 'sd_pin_participant()', 'if old.user_id is distinct from auth.uid() then', 'if false then')
      const byO = await as(tx, 'o', setTick(tx, sp, true))
      const byH = await as(tx, 'h', setTick(tx, sq, true))
      return { byO, p: await checkIn(tx, sp), byH, q: await checkIn(tx, sq) }
    })
    expect(r.byO).toMatchObject({ error: null, rows: 1 })
    expect(r.p.checked_in, 'organizer tick-in lands without the rule').toBe(true)
    expect(r.byH).toMatchObject({ error: null, rows: 1 })
    expect(r.q.checked_in, 'host tick-in lands without the rule (the old host pin is gone)').toBe(true)
  })
})

// ===========================================================================
// PART 2 — sd_device_status.
// ===========================================================================
describe('speed dating: device status — the write path (20261109010000)', () => {
  it('the person reports for their own seat; the server stamps the time and copies the seat\'s identity', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'open')
      const s = await seat(tx, org, ev, 'p')
      const res = await as(tx, 'p', report(tx, ev, 'blocked', 'ok', 'not_in_call'))
      const [row] = await tx<Record<string, unknown>[]>`
        select participant_id, org_id, event_id, user_id, camera, mic, connection, reported_at = now() as stamped
        from sd_device_status where participant_id = ${s}`
      return { res, row, s, org, ev }
    })
    expect(r.res.value).toBe('saved')
    expect(r.row).toEqual({
      participant_id: r.s, org_id: r.org, event_id: r.ev, user_id: ids.p,
      camera: 'blocked', mic: 'ok', connection: 'not_in_call', stamped: true,
    })
  })

  it('throttle: a second write within 5 s is throttled; identical within 25 s is unchanged; a change after 5 s and a heartbeat after 25 s are saved', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'running')
      const s = await seat(tx, org, ev, 'p')
      const first = await as(tx, 'p', report(tx, ev))
      const tooSoon = await as(tx, 'p', report(tx, ev, 'missing'))
      await age(tx, s, 10)
      const same10 = await as(tx, 'p', report(tx, ev))
      const changed10 = await as(tx, 'p', report(tx, ev, 'missing'))
      const [c] = await tx<{ camera: string; fresh: boolean }[]>`select camera, reported_at = now() as fresh from sd_device_status where participant_id = ${s}`
      await age(tx, s, 30)
      const heartbeat = await as(tx, 'p', report(tx, ev, 'missing'))
      const [h] = await tx<{ fresh: boolean }[]>`select reported_at = now() as fresh from sd_device_status where participant_id = ${s}`
      return { first, tooSoon, same10, changed10, c: c!, heartbeat, h: h! }
    })
    expect(r.first.value).toBe('saved')
    expect(r.tooSoon.value).toBe('throttled')
    expect(r.same10.value).toBe('unchanged')
    expect(r.changed10.value).toBe('saved')
    expect(r.c).toEqual({ camera: 'missing', fresh: true })
    expect(r.heartbeat.value).toBe('saved')
    expect(r.h.fresh, 'the heartbeat refreshed last-seen').toBe(true)
  })

  it('refused: no seat, a withdrawn/removed seat, an ex-member, a draft/complete/cancelled event; saved for a waitlisted seat (control)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const running = await makeEvent(tx, org, 'running')
      const closed = await makeEvent(tx, org, 'closed')
      await seat(tx, org, running, 'q', 'withdrawn')
      await seat(tx, org, closed, 'q', 'waitlisted')
      await seat(tx, org, running, 'h', 'removed')
      const draft = await makeEvent(tx, org, 'draft')
      await seat(tx, org, draft, 'p')
      const complete = await makeEvent(tx, org, 'complete')
      await seat(tx, org, complete, 'p')
      const cancelled = await makeEvent(tx, org, 'cancelled')
      await seat(tx, org, cancelled, 'p')
      const out = {
        noSeat: await as(tx, 'x', report(tx, running)),
        noSeatMember: await as(tx, 'o', report(tx, running)),
        withdrawn: await as(tx, 'q', report(tx, running)),
        removed: await as(tx, 'h', report(tx, running)),
        draft: await as(tx, 'p', report(tx, draft)),
        complete: await as(tx, 'p', report(tx, complete)),
        cancelled: await as(tx, 'p', report(tx, cancelled)),
        waitlistedClosed: await as(tx, 'q', report(tx, closed)),
        unknownEvent: await as(tx, 'p', report(tx, '00000000-0000-0000-0000-000000000000')),
      }
      // Ex-member: p's membership ends; a seat at a running event remains.
      const sp = await seat(tx, org, running, 'p')
      const memberControl = await as(tx, 'p', report(tx, running))
      await tx`delete from sd_device_status where participant_id = ${sp}`
      await tx`delete from org_members where org_id = ${org} and user_id = ${ids.p}`
      const [still] = await tx<{ n: number }[]>`select count(*)::int as n from sd_participants where id = ${sp}`
      if (still!.n !== 1) throw new Error('fixture premise: the seat survives the membership ending')
      const exMember = await as(tx, 'p', report(tx, running))
      const [n] = await tx<{ n: number }[]>`
        select count(*)::int as n from sd_device_status where event_id in (${running}, ${draft}, ${complete}, ${cancelled})`
      return { ...out, memberControl, exMember, rowsLeft: n!.n }
    })
    for (const k of ['noSeat', 'noSeatMember', 'withdrawn', 'removed', 'draft', 'complete', 'cancelled', 'unknownEvent', 'exMember'] as const) {
      expect(r[k], k).toMatchObject({ error: null, value: 'refused' })
    }
    expect(r.waitlistedClosed.value, 'CONTROL: a waitlisted seat at a closed event reports').toBe('saved')
    expect(r.memberControl.value, 'CONTROL: the same seat reports while p is a member').toBe('saved')
    expect(r.rowsLeft).toBe(0)
  })

  it('malformed values raise (no free text reaches the table)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'running')
      await seat(tx, org, ev, 'p')
      return {
        label: await as(tx, 'p', report(tx, ev, 'FaceTime HD Camera')),
        nullMic: await as(tx, 'p', () => tx`select public.sd_report_device_status(${ev}, 'ok', null, 'connected')`),
        conn: await as(tx, 'p', report(tx, ev, 'ok', 'ok', 'online')),
      }
    })
    expect(r.label.error).toContain('Invalid device status')
    expect(r.nullMic.error).toContain('Invalid device status')
    expect(r.conn.error).toContain('Invalid device status')
  })

  it('no API role writes the table directly — not the person, not the organizer', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'running')
      const s = await seat(tx, org, ev, 'p')
      const control = await as(tx, 'p', report(tx, ev))
      return {
        control,
        insert: await as(tx, 'q', () => tx`insert into sd_device_status (participant_id, org_id, event_id, user_id, camera, mic, connection)
                                           values (${s}, ${org}, ${ev}, ${ids.p}, 'ok', 'ok', 'connected')`),
        updateSelf: await as(tx, 'p', () => tx`update sd_device_status set reported_at = now() + interval '1 hour' where participant_id = ${s}`),
        updateOrg: await as(tx, 'o', () => tx`update sd_device_status set camera = 'blocked' where participant_id = ${s}`),
        deleteOrg: await as(tx, 'o', () => tx`delete from sd_device_status where participant_id = ${s}`),
      }
    })
    expect(r.control.value).toBe('saved')
    for (const k of ['insert', 'updateSelf', 'updateOrg', 'deleteOrg'] as const) {
      expect(r[k].error, k).toContain('permission denied')
    }
  })
})

describe('speed dating: device status — who reads it', () => {
  it('organizer, host, event-scoped host and the person read it; another dater, another event\'s scoped host, another org and a non-member do not', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'running')
      const other = await makeEvent(tx, org, 'running')
      await seat(tx, org, ev, 'p')
      await seat(tx, org, ev, 'q')
      expect((await as(tx, 'p', report(tx, ev))).value).toBe('saved')
      const b = await makeOtherOrg(tx)
      const [all] = await tx<{ n: number }[]>`select count(*)::int as n from sd_device_status where event_id = ${ev}`
      const out = {
        owner: all!.n,
        o: await as(tx, 'o', visibleRows(tx, ev)),
        h: await as(tx, 'h', visibleRows(tx, ev)),
        p: await as(tx, 'p', visibleRows(tx, ev)),
        q: await as(tx, 'q', visibleRows(tx, ev)),
        b: await as(tx, 'b', visibleRows(tx, ev)),
        x: await as(tx, 'x', visibleRows(tx, ev)),
      }
      // s: scoped to the OTHER event first (no read), then to this one (control).
      await scopeHost(tx, org, other)
      const sOther = await as(tx, 's', visibleRows(tx, ev))
      await scopeHost(tx, org, ev)
      const sHere = await as(tx, 's', visibleRows(tx, ev))
      // b's control: b reads their OWN event's rows.
      await tx`insert into org_members (org_id, user_id, role, status, accepted_at) values (${b.org}, ${ids.p}, 'member', 'active', now())`
      await tx`insert into sd_participants (org_id, event_id, user_id, status) values (${b.org}, ${b.ev}, ${ids.p}, 'registered')`
      expect((await as(tx, 'p', report(tx, b.ev))).value).toBe('saved')
      const bOwn = await as(tx, 'b', visibleRows(tx, b.ev))
      return { ...out, sOther, sHere, bOwn }
    })
    expect(r.owner, 'premise: one row exists').toBe(1)
    expect(r.o.rows, 'CONTROL: organizer reads it').toBe(1)
    expect(r.h.rows, 'CONTROL: host reads it').toBe(1)
    expect(r.p.rows, 'CONTROL: the person reads their own').toBe(1)
    expect(r.sHere.rows, 'CONTROL: a host scoped to this event reads it').toBe(1)
    expect(r.bOwn.rows, 'CONTROL: b reads their own org\'s rows').toBe(1)
    expect(r.q).toMatchObject({ error: null, rows: 0 })
    expect(r.sOther).toMatchObject({ error: null, rows: 0 })
    expect(r.b).toMatchObject({ error: null, rows: 0 })
    expect(r.x).toMatchObject({ error: null, rows: 0 })
  })
})

describe('speed dating: device status — lifetime', () => {
  // (open/closed -> draft is in the trigger too, but unreachable with a row: back-to-draft needs zero
  // registered/waitlisted seats, and a seat leaving those states loses its row — next test.)
  it('an event moving to complete / cancelled deletes its rows; another event\'s row survives (control)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const out: Record<string, number> = {}
      const keep = await makeEvent(tx, org, 'running')
      await seat(tx, org, keep, 'q')
      expect((await as(tx, 'q', report(tx, keep))).value).toBe('saved')
      for (const [from, to] of [['running', 'complete'], ['running', 'cancelled']] as const) {
        const ev = await makeEvent(tx, org, from)
        await seat(tx, org, ev, 'p')
        expect((await as(tx, 'p', report(tx, ev))).value).toBe('saved')
        const before = (await tx<{ n: number }[]>`select count(*)::int as n from sd_device_status where event_id = ${ev}`)[0]!.n
        // As the organizer, through the real guard.
        const move = await as(tx, 'o', () => tx`update sd_events set state = ${to} where id = ${ev}`)
        expect(move, `organizer moves ${from} -> ${to}`).toMatchObject({ error: null, rows: 1 })
        const after = (await tx<{ n: number }[]>`select count(*)::int as n from sd_device_status where event_id = ${ev}`)[0]!.n
        out[`${to}Before`] = before
        out[`${to}After`] = after
      }
      out.kept = (await tx<{ n: number }[]>`select count(*)::int as n from sd_device_status where event_id = ${keep}`)[0]!.n
      return out
    })
    expect(r.completeBefore).toBe(1)
    expect(r.completeAfter).toBe(0)
    expect(r.cancelledBefore).toBe(1)
    expect(r.cancelledAfter).toBe(0)
    expect(r.kept, 'CONTROL: another event\'s row is untouched').toBe(1)
  })

  it('a seat that is withdrawn (by its holder) or removed (by a host) loses its row; a promotion keeps it (control)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'running')
      const sp = await seat(tx, org, ev, 'p')
      const sq = await seat(tx, org, ev, 'q')
      const closed = await makeEvent(tx, org, 'closed')
      const sw = await seat(tx, org, closed, 'q', 'waitlisted')
      for (const [u, e] of [['p', ev], ['q', ev], ['q', closed]] as const) {
        expect((await as(tx, u, report(tx, e))).value).toBe('saved')
      }
      const has = async (s: string) =>
        (await tx<{ n: number }[]>`select count(*)::int as n from sd_device_status where participant_id = ${s}`)[0]!.n
      const withdraw = await as(tx, 'p', () => tx`update sd_participants set status = 'withdrawn' where id = ${sp}`)
      const remove = await as(tx, 'h', () => tx`update sd_participants set status = 'removed' where id = ${sq}`)
      const promote = await as(tx, 'o', () => tx`update sd_participants set status = 'registered' where id = ${sw}`)
      return { withdraw, remove, promote, p: await has(sp), q: await has(sq), w: await has(sw) }
    })
    expect(r.withdraw).toMatchObject({ error: null, rows: 1 })
    expect(r.remove).toMatchObject({ error: null, rows: 1 })
    expect(r.promote).toMatchObject({ error: null, rows: 1 })
    expect(r.p).toBe(0)
    expect(r.q).toBe(0)
    expect(r.w, 'CONTROL: waitlisted -> registered keeps the row').toBe(1)
  })

  it('MUTATION: without the trigger, a completed event keeps its rows', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'running')
      await seat(tx, org, ev, 'p')
      await as(tx, 'p', report(tx, ev))
      await mutate(tx, 'sd_events_clear_device_status()', "if new.state in ('draft', 'complete', 'cancelled')", 'if false')
      await as(tx, 'o', () => tx`update sd_events set state = 'complete' where id = ${ev}`)
      return (await tx<{ n: number }[]>`select count(*)::int as n from sd_device_status where event_id = ${ev}`)[0]!.n
    })
    expect(r).toBe(1)
  })

  // Belt and braces, stated honestly: the silhouette also WITHDRAWS live seats, which the seat trigger
  // already answers, so this passes with either mechanism alone. The explicit line is docs/03 #35's
  // classification and survives a future silhouette that stops withdrawing.
  it('the account silhouette deletes the person\'s rows; another person\'s row survives (control)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await makeOrg(tx)
      const ev = await makeEvent(tx, org, 'running')
      await seat(tx, org, ev, 'p')
      await seat(tx, org, ev, 'q')
      await as(tx, 'p', report(tx, ev))
      await as(tx, 'q', report(tx, ev))
      const count = async (u: Who) =>
        (await tx<{ n: number }[]>`select count(*)::int as n from sd_device_status where user_id = ${ids[u]}`)[0]!.n
      const before = { p: await count('p'), q: await count('q') }
      await tx`select public.account_silhouette(${ids.p})`
      return { before, after: { p: await count('p'), q: await count('q') } }
    })
    expect(r.before).toEqual({ p: 1, q: 1 })
    expect(r.after).toEqual({ p: 0, q: 1 })
  })
})

describe('speed dating: device status — a report in flight blocks the event leaving its live states (two connections)', () => {
  it('the organizer\'s "complete" waits for an uncommitted report (FOR SHARE on the event)', async () => {
    const org = await makeOrg(sql)
    try {
      const ev = await makeEvent(sql, org, 'running')
      await sql`insert into sd_participants (org_id, event_id, user_id, status) values (${org}, ${ev}, ${ids.p}, 'registered')`
      let organizer: { error: string | null } = { error: 'not run' }
      await rolledBack(async (tx) => {
        expect((await as(tx, 'p', report(tx, ev))).value, 'premise: the report itself succeeded').toBe('saved')
        await sql2.begin(async (t2) => {
          await t2.unsafe("set local lock_timeout = '400ms'")
          await t2`update sd_events set state = 'complete' where id = ${ev}`
        }).then(
          () => { organizer = { error: null } },
          (e: unknown) => { organizer = { error: String((e as Error).message) } },
        )
      })
      expect(organizer.error).toContain('lock timeout')
    } finally {
      await sql`delete from orgs where id = ${org}`
    }
  })

  it('MUTATION: without FOR SHARE the "complete" slips past an uncommitted report (the race is real)', async () => {
    const org = await makeOrg(sql)
    try {
      const ev = await makeEvent(sql, org, 'running')
      await sql`insert into sd_participants (org_id, event_id, user_id, status) values (${org}, ${ev}, ${ids.p}, 'registered')`
      let organizer: { error: string | null } = { error: 'not run' }
      await rolledBack(async (tx) => {
        await mutate(tx, 'sd_report_device_status(uuid,text,text,text)', 'where e.id = p_event_id for share', 'where e.id = p_event_id')
        expect((await as(tx, 'p', report(tx, ev))).value, 'premise: the report itself succeeded').toBe('saved')
        await sql2.begin(async (t2) => {
          await t2.unsafe("set local lock_timeout = '400ms'")
          await t2`update sd_events set state = 'complete' where id = ${ev}`
          throw new Error('__rollback2__') // leave the fixture event running
        }).then(
          () => { organizer = { error: null } },
          (e: unknown) => {
            const m = String((e as Error).message)
            organizer = { error: m === '__rollback2__' ? null : m }
          },
        )
      })
      // Not blocked: had the dater committed, a status row would outlive the event's live state.
      expect(organizer.error).toBeNull()
    } finally {
      await sql`delete from orgs where id = ${org}`
    }
  })
})
