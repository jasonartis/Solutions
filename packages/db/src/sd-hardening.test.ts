import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'

// ---------------------------------------------------------------------------
// SPEED DATING HARDENING (20261017010000 part B/C + 20261017020000).
//
// One describe per review finding. Every probe runs AS a signed-in user
// (`set local role authenticated` + `request.jwt.claims`), so RLS, definer
// helpers and auth.uid() see exactly what a real request would. Throwaway
// accounts; every probe in a transaction that is ALWAYS rolled back; accounts
// hard-deleted afterwards. Every negative assertion has a positive control
// beside it (docs/03 vacuity rule).
// ---------------------------------------------------------------------------

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const ownerDbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const sql = postgres(ownerDbUrl, { prepare: false, max: 1 })
const admin = () => createClient(url, serviceKey, { auth: { persistSession: false } })

// p, q = participants in org A; h = host A; o = organizer A; m = org-A admin
// (sd manage tier); x = never a member anywhere; v = the victim, a
// participant in org B only; b = organizer of org B only.
const who = ['p', 'q', 'h', 'o', 'm', 'x', 'v', 'b'] as const
type Who = (typeof who)[number]
const ids = Object.fromEntries(who.map((k) => [k, ''])) as Record<Who, string>

beforeAll(async () => {
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for this suite')
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  for (const k of who) {
    const { data, error } = await admin().auth.admin.createUser({
      email: `sdharden-${k}-${tag}@demo.local`, password: 'password123', email_confirm: true,
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
type Outcome = { error: string | null; rows: number; data: postgres.Row[] }

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

/** Run `stmt` as a signed-in user under a savepoint; back to the owner afterwards. */
async function as(tx: Tx, user: Who, stmt: () => Promise<postgres.RowList<postgres.Row[]>>): Promise<Outcome> {
  await tx.unsafe('savepoint sp')
  let out: Outcome
  try {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: ids[user], role: 'authenticated' })}, true)`
    await tx.unsafe('set local role authenticated')
    const r = await stmt()
    await tx.unsafe('release savepoint sp')
    out = { error: null, rows: r.count, data: [...r] }
  } catch (e: unknown) {
    await tx.unsafe('rollback to savepoint sp')
    out = { error: String((e as Error).message), rows: 0, data: [] }
  }
  await tx.unsafe('reset role')
  await tx`select set_config('request.jwt.claims', '', true)`
  return out
}

async function newOrg(tx: Tx, members: [Who, 'owner' | 'admin' | 'member', string | null][]): Promise<string> {
  const [o] = await tx<{ id: string }[]>`
    insert into orgs (name, slug) values ('SD hardening probe', ${`sdh-${Math.random().toString(36).slice(2, 10)}`})
    returning id`
  for (const [k, role, sdRole] of members) {
    await tx`insert into org_members (org_id, user_id, role, status, accepted_at)
             values (${o!.id}, ${ids[k]}, ${role}, 'active', now())`
    if (sdRole) {
      await tx`insert into module_roles (org_id, user_id, module_key, role) values (${o!.id}, ${ids[k]}, 'speed-dating', ${sdRole})`
    }
  }
  return o!.id
}

const orgA = (tx: Tx) =>
  newOrg(tx, [['p', 'member', 'participant'], ['q', 'member', 'participant'], ['h', 'member', 'host'],
    ['o', 'member', 'organizer'], ['m', 'member', 'admin']])
const orgB = (tx: Tx) => newOrg(tx, [['v', 'member', 'participant'], ['b', 'member', 'organizer']])

async function event(tx: Tx, org: string, state = 'open', format: object = {}): Promise<string> {
  const [e] = await tx<{ id: string }[]>`
    insert into sd_events (org_id, name, state, format)
    values (${org}, 'Hardening probe', ${state}, ${tx.json(format as postgres.JSONValue)}) returning id`
  return e!.id
}

/** Owner-connection seat (no JWT: the trusted-backend path). */
async function seat(tx: Tx, org: string, ev: string, user: Who, extra: Record<string, unknown> = {}): Promise<string> {
  const row = { org_id: org, event_id: ev, user_id: ids[user], status: 'registered', ...extra }
  const [s] = await tx<{ id: string }[]>`insert into sd_participants ${tx(row)} returning id`
  return s!.id
}

async function round(tx: Tx, org: string, ev: string, n = 1): Promise<string> {
  const [r] = await tx<{ id: string }[]>`
    insert into sd_rounds (org_id, event_id, round_number) values (${org}, ${ev}, ${n}) returning id`
  return r!.id
}

async function pair(tx: Tx, org: string, ev: string, rnd: string, a: string, b: string) {
  await tx`insert into sd_pairings (org_id, event_id, round_id, participant_a_id, participant_b_id)
           values (${org}, ${ev}, ${rnd}, ${a}, ${b})`
}

const twoSided = (capA: number | null) => ({
  sides: { a: { label: 'Side A', capacity: capA }, b: { label: 'Side B', capacity: null } },
})

// ---------------------------------------------------------------------------
describe('finding 1: a mentor pointer cannot reach another org (sd_mentors + integrity)', () => {
  it('self-insert route: a forged mentor seat reads nothing; a real, consented mentor seat reads the mentee (control)', async () => {
    const r = await rolledBack(async (tx) => {
      const a = await orgA(tx)
      const b = await orgB(tx)
      const evA = await event(tx, a)
      const evB = await event(tx, b)
      const victim = await seat(tx, b, evB, 'v', { allows_mentor: true, profile_card: 'victim secret' })

      // p self-inserts into org A's event, asking for a mentor seat on the victim.
      const forged = await as(tx, 'p', () =>
        tx`insert into sd_participants (org_id, event_id, user_id, seat_type, mentee_participant_id, status)
           values (${a}, ${evA}, ${ids.p}, 'mentor', ${victim}, 'registered')`)
      const [stored] = await tx<{ seat_type: string; mentee_participant_id: string | null }[]>`
        select seat_type, mentee_participant_id from sd_participants where event_id = ${evA} and user_id = ${ids.p}`
      const read = await as(tx, 'p', () => tx`select profile_card from sd_participants where id = ${victim}`)

      // CONTROL: in org A, q consents; an organizer seats p as q's mentor; p reads q.
      const evA2 = await event(tx, a)
      const qSeat = await seat(tx, a, evA2, 'q', { allows_mentor: true, profile_card: 'q card' })
      const seatMentor = await as(tx, 'o', () =>
        tx`insert into sd_participants (org_id, event_id, user_id, seat_type, mentee_participant_id, status)
           values (${a}, ${evA2}, ${ids.p}, 'mentor', ${qSeat}, 'registered')`)
      const legit = await as(tx, 'p', () => tx`select profile_card from sd_participants where id = ${qSeat}`)
      // ...and withdrawing consent stops the read at once.
      await tx`update sd_participants set allows_mentor = false where id = ${qSeat}`
      const afterConsentGone = await as(tx, 'p', () => tx`select profile_card from sd_participants where id = ${qSeat}`)
      return { forged, stored: stored!, read, seatMentor, legit, afterConsentGone }
    })
    expect(r.forged.error, 'the insert itself is allowed — its forged fields are overwritten').toBeNull()
    expect(r.stored).toEqual({ seat_type: 'participant', mentee_participant_id: null })
    expect(r.read.rows, 'cross-org victim row was readable').toBe(0)
    expect(r.seatMentor.error, 'CONTROL: organizer could not seat a consented mentor').toBeNull()
    expect(r.legit.data, 'CONTROL: a real mentor cannot read their mentee').toEqual([{ profile_card: 'q card' }])
    expect(r.afterConsentGone.rows).toBe(0)
  })

  it('organizer route: refused at write; a pre-existing forged row is inert in sd_mentors (both layers)', async () => {
    const r = await rolledBack(async (tx) => {
      const a = await orgA(tx)
      const b = await orgB(tx)
      const evA = await event(tx, a)
      const evB = await event(tx, b)
      const victim = await seat(tx, b, evB, 'v', { allows_mentor: true, profile_card: 'victim secret' })

      const viaOrganizer = await as(tx, 'o', () =>
        tx`insert into sd_participants (org_id, event_id, user_id, seat_type, mentee_participant_id, status)
           values (${a}, ${evA}, ${ids.p}, 'mentor', ${victim}, 'registered')`)
      // Even the trusted backend (no JWT) cannot write the pointer.
      let backendErr: string | null = null
      await tx.unsafe('savepoint b1')
      try {
        await seat(tx, a, evA, 'p', { seat_type: 'mentor', mentee_participant_id: victim })
        await tx.unsafe('release savepoint b1')
      } catch (e) {
        backendErr = String((e as Error).message)
        await tx.unsafe('rollback to savepoint b1')
      }

      // Layer (b): plant the row with every trigger off (as a row from before
      // the integrity trigger existed would be), then read as p.
      await tx.unsafe('set local session_replication_role = replica')
      await tx`insert into sd_participants (org_id, event_id, user_id, seat_type, mentee_participant_id, status)
               values (${a}, ${evA}, ${ids.p}, 'mentor', ${victim}, 'registered')`
      await tx.unsafe('set local session_replication_role = origin')
      const read = await as(tx, 'p', () => tx`select profile_card from sd_participants where id = ${victim}`)
      // CONTROL: the planted row really is p's mentor seat pointing at the victim.
      const [planted] = await tx<{ n: number }[]>`
        select count(*)::int as n from sd_participants
        where user_id = ${ids.p} and seat_type = 'mentor' and mentee_participant_id = ${victim}`
      return { viaOrganizer, backendErr, read, planted: planted!.n }
    })
    expect(r.viaOrganizer.error).toMatch(/consenting participant in the same event/)
    expect(r.backendErr).toMatch(/consenting participant in the same event/)
    expect(r.planted, 'CONTROL: the forged row was not planted').toBe(1)
    expect(r.read.rows, 'sd_mentors still honours a cross-org pointer').toBe(0)
  })
})

// ---------------------------------------------------------------------------
describe('finding 2: fresh self-registration is decided by the database', () => {
  it('forged fields are overwritten; a full side waitlists even when the client says registered', async () => {
    const r = await rolledBack(async (tx) => {
      const a = await orgA(tx)
      const ev = await event(tx, a, 'open', twoSided(1))
      await seat(tx, a, ev, 'q', { pool_side: 'a' })
      const ins = await as(tx, 'p', () =>
        tx`insert into sd_participants (org_id, event_id, user_id, pool_side, status, seat_type, checked_in, checked_in_at, created_at)
           values (${a}, ${ev}, ${ids.p}, 'a', 'registered', 'audience', true, '2000-01-01', '1970-01-01')`)
      const [row] = await tx<{ status: string; seat_type: string; checked_in: boolean; checked_in_at: Date | null; created_at: Date }[]>`
        select status, seat_type, checked_in, checked_in_at, created_at from sd_participants where event_id = ${ev} and user_id = ${ids.p}`
      return { ins, row: row! }
    })
    expect(r.ins.error).toBeNull()
    expect(r.row.status).toBe('waitlisted')
    expect(r.row.seat_type).toBe('participant')
    expect(r.row.checked_in).toBe(false)
    expect(r.row.checked_in_at).toBeNull()
    expect(r.row.created_at.getUTCFullYear()).toBeGreaterThan(2020)
  })

  it('room -> registered (control); room but someone waiting -> waitlisted; two-sided needs a side; single pool drops the side', async () => {
    const r = await rolledBack(async (tx) => {
      const a = await orgA(tx)
      const roomy = await event(tx, a, 'open', twoSided(5))
      const asksWaitlisted = await as(tx, 'p', () =>
        tx`insert into sd_participants (org_id, event_id, user_id, pool_side, status) values (${a}, ${roomy}, ${ids.p}, 'a', 'waitlisted')`)
      const [roomyRow] = await tx<{ status: string }[]>`select status from sd_participants where event_id = ${roomy} and user_id = ${ids.p}`

      const queue = await event(tx, a, 'open', twoSided(5))
      await seat(tx, a, queue, 'q', { pool_side: 'a', status: 'waitlisted' })
      await as(tx, 'p', () =>
        tx`insert into sd_participants (org_id, event_id, user_id, pool_side, status) values (${a}, ${queue}, ${ids.p}, 'a', 'registered')`)
      const [queueRow] = await tx<{ status: string }[]>`select status from sd_participants where event_id = ${queue} and user_id = ${ids.p}`

      const sided = await event(tx, a, 'open', twoSided(5))
      const noSide = await as(tx, 'p', () =>
        tx`insert into sd_participants (org_id, event_id, user_id, status) values (${a}, ${sided}, ${ids.p}, 'registered')`)

      const single = await event(tx, a, 'open')
      await as(tx, 'p', () =>
        tx`insert into sd_participants (org_id, event_id, user_id, pool_side, status) values (${a}, ${single}, ${ids.p}, 'b', 'registered')`)
      const [singleRow] = await tx<{ status: string; pool_side: string | null }[]>`
        select status, pool_side from sd_participants where event_id = ${single} and user_id = ${ids.p}`
      return { asksWaitlisted, roomy: roomyRow!.status, queue: queueRow!.status, noSide, single: singleRow! }
    })
    expect(r.asksWaitlisted.error).toBeNull()
    expect(r.roomy, 'CONTROL: with room the database registers').toBe('registered')
    expect(r.queue).toBe('waitlisted')
    expect(r.noSide.error).toMatch(/Choose a side/)
    expect(r.single).toEqual({ status: 'registered', pool_side: null })
  })

  it('refused for a non-open event and for a banned user; organizer path unchanged (control)', async () => {
    const r = await rolledBack(async (tx) => {
      const a = await orgA(tx)
      const states: Record<string, string | null> = {}
      for (const st of ['draft', 'running', 'complete', 'cancelled']) {
        const ev = await event(tx, a, st)
        states[st] = (await as(tx, 'p', () =>
          tx`insert into sd_participants (org_id, event_id, user_id, status) values (${a}, ${ev}, ${ids.p}, 'registered')`)).error
      }
      const open = await event(tx, a)
      await tx`insert into sd_bans (org_id, banned_user_id, active) values (${a}, ${ids.p}, true)`
      const banned = await as(tx, 'p', () =>
        tx`insert into sd_participants (org_id, event_id, user_id, status) values (${a}, ${open}, ${ids.p}, 'registered')`)
      const openForQ = await as(tx, 'q', () =>
        tx`insert into sd_participants (org_id, event_id, user_id, status) values (${a}, ${open}, ${ids.q}, 'registered')`)

      // Organizer: draft event, explicit waitlisted status, checked in — all kept.
      const draft = await event(tx, a, 'draft')
      const org = await as(tx, 'o', () =>
        tx`insert into sd_participants (org_id, event_id, user_id, status, checked_in) values (${a}, ${draft}, ${ids.q}, 'waitlisted', true)`)
      const [orgRow] = await tx<{ status: string; checked_in: boolean }[]>`
        select status, checked_in from sd_participants where event_id = ${draft} and user_id = ${ids.q}`
      return { states, banned, openForQ, org, orgRow: orgRow! }
    })
    for (const st of ['draft', 'running', 'complete', 'cancelled']) {
      expect(r.states[st], st).toMatch(/Registration for this event is not open/)
    }
    expect(r.banned.error).toMatch(/not eligible/)
    expect(r.openForQ.error, 'CONTROL: an unbanned participant registers for the open event').toBeNull()
    expect(r.org.error).toBeNull()
    expect(r.orgRow).toEqual({ status: 'waitlisted', checked_in: true })
  })
})

// ---------------------------------------------------------------------------
describe('finding 3: self-editor column pins', () => {
  it('a REMOVED seat is frozen; a registered seat still edits its card (control)', async () => {
    const r = await rolledBack(async (tx) => {
      const a = await orgA(tx)
      const ev = await event(tx, a)
      const removed = await seat(tx, a, ev, 'p', { status: 'removed', profile_card: 'before' })
      const live = await seat(tx, a, ev, 'q', { profile_card: 'before' })
      const edit = await as(tx, 'p', () =>
        tx`update sd_participants set checked_in = true, checked_in_at = '2000-01-01', allows_audience = true, profile_card = 'after' where id = ${removed}`)
      const control = await as(tx, 'q', () => tx`update sd_participants set profile_card = 'after' where id = ${live}`)
      const rows = await tx<{ id: string; checked_in: boolean; checked_in_at: Date | null; allows_audience: boolean; profile_card: string }[]>`
        select id, checked_in, checked_in_at, allows_audience, profile_card from sd_participants where id in (${removed}, ${live})`
      return { edit, control, removed: rows.find((x) => x.id === removed)!, live: rows.find((x) => x.id === live)! }
    })
    expect(r.edit.error).toBeNull()
    expect(r.removed).toMatchObject({ checked_in: false, checked_in_at: null, allows_audience: false, profile_card: 'before' })
    expect(r.control.rows).toBe(1)
    expect(r.live.profile_card, 'CONTROL').toBe('after')
  })

  it('checked_in_at is server-stamped; a withdrawn seat cannot check in; id is pinned', async () => {
    const r = await rolledBack(async (tx) => {
      const a = await orgA(tx)
      const ev = await event(tx, a)
      const reg = await seat(tx, a, ev, 'p')
      const wd = await seat(tx, a, ev, 'q', { status: 'withdrawn' })
      await as(tx, 'p', () => tx`update sd_participants set checked_in = true, checked_in_at = '2000-01-01' where id = ${reg}`)
      await as(tx, 'q', () => tx`update sd_participants set checked_in = true where id = ${wd}`)
      const newId = '00000000-0000-4000-8000-000000000001'
      const idMove = await as(tx, 'p', () => tx`update sd_participants set id = ${newId} where id = ${reg}`)
      const rows = await tx<{ id: string; checked_in: boolean; checked_in_at: Date | null }[]>`
        select id, checked_in, checked_in_at from sd_participants where event_id = ${ev}`
      return { rows, reg, wd, newId, idMove }
    })
    const reg = r.rows.find((x) => x.id === r.reg)
    expect(reg, 'the seat id moved').toBeDefined()
    expect(r.rows.some((x) => x.id === r.newId)).toBe(false)
    expect(r.idMove.error).toBeNull()
    expect(reg!.checked_in, 'CONTROL: the check-in itself landed').toBe(true)
    expect(reg!.checked_in_at!.getUTCFullYear()).toBeGreaterThan(2020)
    expect(r.rows.find((x) => x.id === r.wd)!.checked_in).toBe(false)
  })
})

// ---------------------------------------------------------------------------
describe('finding 4: interest needs a pairing and a registered rater', () => {
  it('unpaired -> refused; paired -> recorded (control) and a mutual pair makes a match; withdrawn rater -> refused', async () => {
    const r = await rolledBack(async (tx) => {
      const a = await orgA(tx)
      const ev = await event(tx, a, 'running')
      const pS = await seat(tx, a, ev, 'p')
      const qS = await seat(tx, a, ev, 'q')
      const mark = (u: Who, rater: string, target: string) => () =>
        tx`insert into sd_interest (org_id, event_id, rater_participant_id, target_participant_id, verdict)
           values (${a}, ${ev}, ${rater}, ${target}, 'interested')`
      const unpaired = await as(tx, 'p', mark('p', pS, qS))
      await pair(tx, a, ev, await round(tx, a, ev), pS, qS)
      const paired = await as(tx, 'p', mark('p', pS, qS))
      const back = await as(tx, 'q', mark('q', qS, pS))
      const [m] = await tx<{ n: number }[]>`select count(*)::int as n from sd_matches where event_id = ${ev}`

      // A withdrawn rater, even though paired.
      await tx`delete from sd_interest where event_id = ${ev}`
      await tx`update sd_participants set status = 'withdrawn' where id = ${pS}`
      const withdrawn = await as(tx, 'p', mark('p', pS, qS))
      return { unpaired, paired, back, matches: m!.n, withdrawn }
    })
    expect(r.unpaired.error).toMatch(/someone you met at this event/)
    expect(r.paired.error, 'CONTROL: a paired, registered rater can mark').toBeNull()
    expect(r.back.error).toBeNull()
    expect(r.matches, 'sd_sync_mutual_match no longer makes a match').toBe(1)
    expect(r.withdrawn.error).toMatch(/someone you met at this event/)
  })
})

// ---------------------------------------------------------------------------
describe('finding 5: reports and notes', () => {
  it('a reporter cannot pre-dismiss or forge a reviewer; event is derived; a removed reporter can still report (control)', async () => {
    const r = await rolledBack(async (tx) => {
      const a = await orgA(tx)
      const ev = await event(tx, a, 'running')
      const other = await event(tx, a, 'running')
      const pS = await seat(tx, a, ev, 'p', { status: 'removed' })
      const qS = await seat(tx, a, ev, 'q')
      const elsewhere = await seat(tx, a, other, 'q')
      const forged = await as(tx, 'p', () =>
        tx`insert into sd_reports (org_id, event_id, reporter_participant_id, reported_participant_id, reason, state, reviewed_by, reviewed_at)
           values (${a}, ${other}, ${pS}, ${qS}, 'rude', 'dismissed', ${ids.o}, '2000-01-01')`)
      const [row] = await tx<{ event_id: string; state: string; reviewed_by: string | null; reviewed_at: Date | null }[]>`
        select event_id, state, reviewed_by, reviewed_at from sd_reports where reporter_participant_id = ${pS}`
      const crossEvent = await as(tx, 'p', () =>
        tx`insert into sd_reports (org_id, event_id, reporter_participant_id, reported_participant_id, reason)
           values (${a}, ${ev}, ${pS}, ${elsewhere}, 'rude')`)
      return { forged, row, crossEvent, ev }
    })
    expect(r.forged.error, 'CONTROL: a removed participant can still file a report').toBeNull()
    expect(r.row).toEqual({ event_id: r.ev, state: 'open', reviewed_by: null, reviewed_at: null })
    expect(r.crossEvent.error).toMatch(/Invalid report/)
  })

  it('a note must be about someone at the event; a random user id gets the same generic answer (no FK oracle)', async () => {
    const r = await rolledBack(async (tx) => {
      const a = await orgA(tx)
      const ev = await event(tx, a, 'running')
      const other = await event(tx, a, 'running')
      const pS = await seat(tx, a, ev, 'p')
      const qS = await seat(tx, a, ev, 'q')
      await seat(tx, a, ev, 'm') // registered, never paired with p
      const os = await seat(tx, a, other, 'p')
      const os2 = await seat(tx, a, other, 'q')
      await pair(tx, a, other, await round(tx, a, other), os, os2)
      const [otherPair] = await tx<{ id: string }[]>`select id from sd_pairings where event_id = ${other}`
      const note = (about: string, pairing: string | null = null) => () =>
        tx`insert into sd_notes (org_id, event_id, author_user_id, about_user_id, pairing_id, body)
           values (${a}, ${ev}, ${ids.p}, ${about}, ${pairing}, 'n')`
      const random = await as(tx, 'p', note('00000000-0000-4000-8000-0000000000aa'))
      const notAtEvent = await as(tx, 'p', note(ids.h))
      const unpairedRegistered = await as(tx, 'p', note(ids.m))
      const unpairedBeforeRound = await as(tx, 'p', note(ids.q))
      await pair(tx, a, ev, await round(tx, a, ev), pS, qS)
      const wrongPairing = await as(tx, 'p', note(ids.q, otherPair!.id))
      const ok = await as(tx, 'p', note(ids.q))
      return { random, notAtEvent, unpairedRegistered, unpairedBeforeRound, wrongPairing, ok }
    })
    expect(r.notAtEvent.error).toMatch(/only keep notes about someone at this event/)
    // A seated author cannot tell "registered but not met" from "not here".
    expect(r.unpairedRegistered.error).toBe(r.notAtEvent.error)
    expect(r.unpairedBeforeRound.error).toBe(r.notAtEvent.error)
    expect(r.random.error).toBe(r.notAtEvent.error)
    expect(r.wrongPairing.error).toBe(r.notAtEvent.error)
    expect(r.ok.error, 'CONTROL: a note about someone you were paired with is accepted').toBeNull()
  })
})

// ---------------------------------------------------------------------------
describe('finding 6: sd_bans.banned_by is server-stamped', () => {
  it('a manager cannot credit a ban to someone else, on insert or update', async () => {
    const r = await rolledBack(async (tx) => {
      const a = await orgA(tx)
      const ins = await as(tx, 'm', () =>
        tx`insert into sd_bans (org_id, banned_user_id, banned_by, active) values (${a}, ${ids.p}, ${ids.o}, true)`)
      const upd = await as(tx, 'm', () =>
        tx`update sd_bans set banned_by = ${ids.o}, reason = 'edited' where org_id = ${a} and banned_user_id = ${ids.p}`)
      const [row] = await tx<{ banned_by: string; reason: string | null }[]>`
        select banned_by, reason from sd_bans where org_id = ${a} and banned_user_id = ${ids.p}`
      return { ins, upd, row }
    })
    expect(r.ins.error, 'CONTROL: the manager can ban').toBeNull()
    expect(r.upd.rows).toBe(1)
    expect(r.row).toEqual({ banned_by: ids.m, reason: 'edited' })
  })
})

// ---------------------------------------------------------------------------
describe('finding 7: authority helpers derive the org from the event', () => {
  it("an organizer/host of org B gets FALSE for (B, an org-A event); TRUE for their own event (control)", async () => {
    const r = await rolledBack(async (tx) => {
      const a = await orgA(tx)
      const b = await newOrg(tx, [['b', 'member', 'organizer'], ['h', 'member', 'host']])
      const evA = await event(tx, a)
      const evB = await event(tx, b)
      const q = (fn: string, org: string, ev: string, u: Who) =>
        as(tx, u, () => tx.unsafe(`select public.${fn}($1, $2) as ok`, [org, ev]))
      return {
        orgMismatch: (await q('sd_can_organize_event', b, evA, 'b')).data[0]!.ok,
        orgOwn: (await q('sd_can_organize_event', b, evB, 'b')).data[0]!.ok,
        hostMismatch: (await q('sd_can_staff_event_of', b, evA, 'h')).data[0]!.ok,
        hostOwn: (await q('sd_can_staff_event_of', b, evB, 'h')).data[0]!.ok,
      }
    })
    expect(r.orgOwn, 'CONTROL').toBe(true)
    expect(r.orgMismatch).toBe(false)
    expect(r.hostOwn, 'CONTROL').toBe(true)
    expect(r.hostMismatch).toBe(false)
  })
})

// ---------------------------------------------------------------------------
describe('finding 8: sd_pairings answers non-organizers generically', () => {
  it('a participant probing seat ids gets one generic error; an organizer still gets the specific one (control)', async () => {
    const r = await rolledBack(async (tx) => {
      const a = await orgA(tx)
      const ev = await event(tx, a, 'running')
      const other = await event(tx, a, 'running')
      const rnd = await round(tx, a, ev)
      const pS = await seat(tx, a, ev, 'p')
      const stranger = await seat(tx, a, other, 'q')
      const probe = (u: Who) => () =>
        tx`insert into sd_pairings (org_id, event_id, round_id, participant_a_id, participant_b_id)
           values (${a}, ${ev}, ${rnd}, ${pS}, ${stranger})`
      return { participant: await as(tx, 'p', probe('p')), organizer: await as(tx, 'o', probe('o')) }
    })
    expect(r.participant.error).toMatch(/^Not allowed to write pairings$/)
    expect(r.organizer.error).toMatch(/is not in event/)
  })
})

// ---------------------------------------------------------------------------
describe('finding 9: an organizer can only seat active org members', () => {
  it('a non-member is refused, on insert and by swapping user_id; a member is seated (control)', async () => {
    const r = await rolledBack(async (tx) => {
      const a = await orgA(tx)
      const ev = await event(tx, a)
      const ins = (u: Who) => () =>
        tx`insert into sd_participants (org_id, event_id, user_id, status) values (${a}, ${ev}, ${ids[u]}, 'registered')`
      const outsider = await as(tx, 'o', ins('x'))
      const member = await as(tx, 'o', ins('q'))
      const swap = await as(tx, 'o', () =>
        tx`update sd_participants set user_id = ${ids.x} where event_id = ${ev} and user_id = ${ids.q}`)
      return { outsider, member, swap }
    })
    expect(r.outsider.error).toMatch(/Only active members of this organization/)
    expect(r.member.error, 'CONTROL').toBeNull()
    expect(r.swap.error).toMatch(/Only active members of this organization/)
  })
})

// ---------------------------------------------------------------------------
// RE-REVIEW items (2026-10-17)
// ---------------------------------------------------------------------------
describe('re-review 1: notes cannot enumerate registrations', () => {
  it('a seatless author gets the SAME error whether the subject is registered, absent, or the event is unknown; a seated author can note (control)', async () => {
    const r = await rolledBack(async (tx) => {
      const a = await orgA(tx)
      await orgB(tx)
      const ev = await event(tx, a, 'running')
      const pS = await seat(tx, a, ev, 'p')
      const qS = await seat(tx, a, ev, 'q')
      await pair(tx, a, ev, await round(tx, a, ev), pS, qS)
      const note = (author: Who, evId: string, about: string) => () =>
        tx`insert into sd_notes (org_id, event_id, author_user_id, about_user_id, body)
           values (${a}, ${evId}, ${ids[author]}, ${about}, 'n')`
      // v: org-B participant, no seat in org A's event (cross-org outsider).
      const registered = await as(tx, 'v', note('v', ev, ids.q))
      const absent = await as(tx, 'v', note('v', ev, ids.h))
      const unknownEvent = await as(tx, 'v', note('v', '00000000-0000-4000-8000-0000000000ee', ids.q))
      // In-org outsider: x joins org A as a plain member — no seat, no role.
      await tx`insert into org_members (org_id, user_id, role, status, accepted_at) values (${a}, ${ids.x}, 'member', 'active', now())`
      const inOrgOutsider = await as(tx, 'x', note('x', ev, ids.q))
      const control = await as(tx, 'p', note('p', ev, ids.q))
      return { registered, absent, unknownEvent, inOrgOutsider, control }
    })
    expect(r.registered.error).toMatch(/only keep notes about someone at this event/)
    expect(r.absent.error).toBe(r.registered.error)
    expect(r.unknownEvent.error).toBe(r.registered.error)
    expect(r.inOrgOutsider.error).toBe(r.registered.error)
    expect(r.control.error, 'CONTROL: a seated author can note a co-participant').toBeNull()
  })
})

describe('re-review 2: a foreign reporter seat reveals nothing', () => {
  it("someone else's seat id and a nonexistent id get the same 'Invalid report'; own seat works (control)", async () => {
    const r = await rolledBack(async (tx) => {
      const a = await orgA(tx)
      const b = await orgB(tx)
      const ev = await event(tx, a, 'running')
      const evB = await event(tx, b, 'running')
      const pS = await seat(tx, a, ev, 'p')
      const qS = await seat(tx, a, ev, 'q')
      const vS = await seat(tx, b, evB, 'v')
      const rep = (reporter: string) => () =>
        tx`insert into sd_reports (org_id, event_id, reporter_participant_id, reason) values (${a}, ${ev}, ${reporter}, 'x')`
      return {
        foreignSameOrg: await as(tx, 'p', rep(qS)),
        foreignOtherOrg: await as(tx, 'p', rep(vS)),
        missing: await as(tx, 'p', rep('00000000-0000-4000-8000-0000000000ff')),
        own: await as(tx, 'p', rep(pS)),
      }
    })
    expect(r.missing.error).toBe('Invalid report')
    expect(r.foreignSameOrg.error).toBe('Invalid report')
    expect(r.foreignOtherOrg.error).toBe('Invalid report')
    expect(r.own.error, 'CONTROL').toBeNull()
  })
})

describe('re-review 3: consents do not travel with a reassigned seat; a mentee must be a participant seat', () => {
  it('organizer reassigns user_id -> consents reset (control: a non-identity edit keeps them)', async () => {
    const r = await rolledBack(async (tx) => {
      const a = await orgA(tx)
      const ev = await event(tx, a)
      const s = await seat(tx, a, ev, 'p', { allows_mentor: true, allows_audience: true })
      const keep = await as(tx, 'o', () => tx`update sd_participants set profile_card = 'x' where id = ${s}`)
      const [kept] = await tx<{ allows_mentor: boolean; allows_audience: boolean }[]>`
        select allows_mentor, allows_audience from sd_participants where id = ${s}`
      const move = await as(tx, 'o', () => tx`update sd_participants set user_id = ${ids.q} where id = ${s}`)
      const [moved] = await tx<{ allows_mentor: boolean; allows_audience: boolean; user_id: string }[]>`
        select allows_mentor, allows_audience, user_id from sd_participants where id = ${s}`
      return { keep, kept: kept!, move, moved: moved! }
    })
    expect(r.keep.rows).toBe(1)
    expect(r.kept, 'CONTROL').toEqual({ allows_mentor: true, allows_audience: true })
    expect(r.move.rows).toBe(1)
    expect(r.moved).toEqual({ allows_mentor: false, allows_audience: false, user_id: ids.q })
  })

  it('sd_mentors ignores a mentee pointer at a non-participant seat (planted), control: participant seat reads', async () => {
    const r = await rolledBack(async (tx) => {
      const a = await orgA(tx)
      const ev = await event(tx, a)
      const audienceSeat = await seat(tx, a, ev, 'q', { seat_type: 'audience', allows_mentor: true, profile_card: 'aud' })
      const partSeat = await seat(tx, a, ev, 'h', { allows_mentor: true, profile_card: 'part' })
      await tx.unsafe('set local session_replication_role = replica')
      await tx`insert into sd_participants (org_id, event_id, user_id, seat_type, mentee_participant_id, status)
               values (${a}, ${ev}, ${ids.p}, 'mentor', ${audienceSeat}, 'registered')`
      await tx.unsafe('set local session_replication_role = origin')
      const bad = await as(tx, 'p', () => tx`select 1 from sd_participants where id = ${audienceSeat}`)
      await tx`update sd_participants set mentee_participant_id = ${partSeat} where user_id = ${ids.p} and event_id = ${ev}`
      const good = await as(tx, 'p', () => tx`select 1 from sd_participants where id = ${partSeat}`)
      return { bad: bad.rows, good: good.rows }
    })
    expect(r.good, 'CONTROL').toBe(1)
    expect(r.bad).toBe(0)
  })
})

describe('re-review 4: an organizer cannot put a self-withdrawn person back', () => {
  it('withdrawn -> registered / waitlisted by an organizer is refused; removed -> withdrawn and waitlisted -> registered still work (controls)', async () => {
    const r = await rolledBack(async (tx) => {
      const a = await orgA(tx)
      const ev = await event(tx, a, 'open', twoSided(5))
      const wd = await seat(tx, a, ev, 'p', { status: 'withdrawn', pool_side: 'a' })
      const rm = await seat(tx, a, ev, 'q', { status: 'removed', pool_side: 'a' })
      const wl = await seat(tx, a, ev, 'h', { status: 'waitlisted', pool_side: 'a' })
      const set = (s: string, st: string) => () => tx`update sd_participants set status = ${st} where id = ${s}`
      return {
        toRegistered: await as(tx, 'o', set(wd, 'registered')),
        toWaitlisted: await as(tx, 'o', set(wd, 'waitlisted')),
        clearRemoval: await as(tx, 'o', set(rm, 'withdrawn')),
        promote: await as(tx, 'o', set(wl, 'registered')),
        self: await as(tx, 'p', set(wd, 'registered')),
      }
    })
    expect(r.toRegistered.error).toMatch(/Only the person can register again/)
    expect(r.toWaitlisted.error).toMatch(/Only the person can register again/)
    expect(r.clearRemoval, 'CONTROL').toMatchObject({ error: null, rows: 1 })
    expect(r.promote, 'CONTROL').toMatchObject({ error: null, rows: 1 })
    expect(r.self, 'CONTROL: the person themselves can').toMatchObject({ error: null, rows: 1 })
  })

  it('the two-step bypass (withdrawn -> removed -> registered/waitlisted) is refused; each allowed transition still works (controls)', async () => {
    const r = await rolledBack(async (tx) => {
      const a = await orgA(tx)
      const ev = await event(tx, a, 'open', twoSided(5))
      const wd = await seat(tx, a, ev, 'p', { status: 'withdrawn', pool_side: 'a' })
      const reg = await seat(tx, a, ev, 'h', { status: 'registered', pool_side: 'a' })
      const set = (s: string, st: string) => () => tx`update sd_participants set status = ${st} where id = ${s}`
      const step1 = await as(tx, 'o', set(wd, 'removed'))
      const step2Registered = await as(tx, 'o', set(wd, 'registered'))
      const step2Waitlisted = await as(tx, 'o', set(wd, 'waitlisted'))
      const removeRegistered = await as(tx, 'o', set(reg, 'removed'))
      const clear = await as(tx, 'o', set(wd, 'withdrawn'))
      const own = await as(tx, 'p', set(wd, 'registered'))
      const [row] = await tx<{ status: string }[]>`select status from sd_participants where id = ${wd}`
      return { step1, step2Registered, step2Waitlisted, removeRegistered, clear, own, final: row!.status }
    })
    expect(r.step1, 'CONTROL: withdrawn -> removed is a removal, allowed').toMatchObject({ error: null, rows: 1 })
    expect(r.step2Registered.error).toMatch(/Only the person can register again/)
    expect(r.step2Waitlisted.error).toMatch(/Only the person can register again/)
    expect(r.removeRegistered, 'CONTROL: registered -> removed').toMatchObject({ error: null, rows: 1 })
    expect(r.clear, 'CONTROL: removed -> withdrawn clears a removal').toMatchObject({ error: null, rows: 1 })
    expect(r.own, "CONTROL: the holder's own rejoin").toMatchObject({ error: null, rows: 1 })
    expect(r.final).toBe('registered')
  })
})

describe('re-review 5: a withdrawn rater can retract interest', () => {
  it("retracting 'interested' deletes the unrevealed match; raising back to 'interested' from a withdrawn seat is refused (control)", async () => {
    const r = await rolledBack(async (tx) => {
      const a = await orgA(tx)
      const ev = await event(tx, a, 'running')
      const pS = await seat(tx, a, ev, 'p')
      const qS = await seat(tx, a, ev, 'q')
      await pair(tx, a, ev, await round(tx, a, ev), pS, qS)
      const mark = (u: Who, rater: string, target: string) => () =>
        tx`insert into sd_interest (org_id, event_id, rater_participant_id, target_participant_id, verdict)
           values (${a}, ${ev}, ${rater}, ${target}, 'interested')`
      await as(tx, 'p', mark('p', pS, qS))
      await as(tx, 'q', mark('q', qS, pS))
      const count = async () => (await tx<{ n: number }[]>`select count(*)::int as n from sd_matches where event_id = ${ev}`)[0]!.n
      const before = await count()
      await tx`update sd_participants set status = 'withdrawn' where id = ${pS}`
      const setVerdict = (v: string) => () =>
        tx`update sd_interest set verdict = ${v} where rater_participant_id = ${pS}`
      const retract = await as(tx, 'p', setVerdict('not_interested'))
      const after = await count()
      const raise = await as(tx, 'p', setVerdict('interested'))
      return { before, retract, after, raise }
    })
    expect(r.before, 'CONTROL: the mutual pair made a match').toBe(1)
    expect(r.retract).toMatchObject({ error: null, rows: 1 })
    expect(r.after).toBe(0)
    expect(r.raise.error).toMatch(/someone you met at this event/)
  })
})
