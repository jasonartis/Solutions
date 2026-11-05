// LOCAL check (2026-10-28) that the worker orchestrator honours the organizer's round cap
// (sd_events.rounds_planned): with cap 1 it builds round 1, then — once that round's clock has
// run out — closes it and builds NO round 2; with cap 2 (the CONTROL) the very same setup DOES
// build round 2. Same fixture both times, only the cap differs, so a pass cannot be vacuous.
// Repeats are ALLOWED in the fixture so the rotation never runs out on its own with two people: the cap is the only thing that can stop round 2.
// Creates and deletes its own events in demo-dating (service role; the guard triggers still
// enforce the state machine). NOT run by CI. Run (local stack up, seeded):
//   node node_modules/tsx/dist/cli.mjs scripts/verify-orchestrator-round-cap.mts
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { runOrchestratorTick } from '../apps/worker/src/jobs/speed-dating-orchestrator.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fromEnvFile = (file: string, key: string) => {
  try {
    return new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(resolve(root, file), 'utf8'))?.[1]?.trim()
  } catch {
    return undefined
  }
}
const url = process.env.SUPABASE_URL ?? fromEnvFile('apps/worker/.env', 'SUPABASE_URL')
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? fromEnvFile('apps/worker/.env', 'SUPABASE_SERVICE_ROLE_KEY')
if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing')
if (!/127\.0\.0\.1|localhost/.test(url)) throw new Error(`refusing to run against ${url}: this script is LOCAL only`)
const admin: SupabaseClient = createClient(url, key, { auth: { persistSession: false } })

let fails = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fails++
}
const must = <T,>(r: { data: T | null; error: { message: string } | null }, what: string): T => {
  if (r.error || r.data === null) throw new Error(`${what}: ${r.error?.message ?? 'no data'}`)
  return r.data
}

const { data: org } = await admin.from('orgs').select('id').eq('slug', 'demo-dating').single()
const { data: people } = await admin.from('profiles').select('user_id, display_name').in('display_name', ['Charlie C', 'Dana D'])
if (!org || (people ?? []).length !== 2) throw new Error('demo-dating / Charlie C / Dana D not found — seed first')

async function scenario(cap: number) {
  const name = `Round cap check ${cap} ${Date.now()}`
  const ev = must(
    await admin
      .from('sd_events')
      .insert({ org_id: org!.id, name, rounds_planned: cap, round_duration_seconds: 60, break_duration_seconds: 0, allow_repeat_pairings: true })
      .select('id')
      .single(),
    'create event',
  )
  try {
    for (const state of ['open', 'running']) {
      const { error } = await admin.from('sd_events').update({ state }).eq('id', ev.id)
      if (error) throw new Error(`-> ${state}: ${error.message}`)
    }
    for (const p of people!) {
      const { error } = await admin.from('sd_participants').insert({
        org_id: org!.id,
        event_id: ev.id,
        user_id: p.user_id,
        status: 'registered',
        seat_type: 'participant',
        checked_in: true,
      })
      if (error) throw new Error(`seat: ${error.message}`)
    }
    const rounds = async () =>
      must(await admin.from('sd_rounds').select('round_number, state').eq('event_id', ev.id).order('round_number'), 'read rounds')

    await runOrchestratorTick(admin)
    const first = await rounds()
    check(`cap ${cap}: the first tick builds round 1`, first.length === 1 && first[0]!.state === 'active', JSON.stringify(first))

    // Run the clock out, then tick again.
    const { error: clockErr } = await admin
      .from('sd_rounds')
      .update({ ends_at: new Date(Date.now() - 3_600_000).toISOString() })
      .eq('event_id', ev.id)
    if (clockErr) throw new Error(`clock: ${clockErr.message}`)
    await runOrchestratorTick(admin)
    return await rounds()
  } finally {
    await admin.from('sd_events').delete().eq('id', ev.id)
  }
}

const capped = await scenario(1)
check('cap 1: the expired round is closed', capped[0]?.state === 'complete', JSON.stringify(capped))
check('cap 1: NO second round is built', capped.length === 1, `${capped.length} round(s)`)

const control = await scenario(2)
check('CONTROL cap 2: round 1 closes and round 2 IS built', control.length === 2 && control[0]?.state === 'complete' && control[1]?.state === 'active', JSON.stringify(control))

// ---- Check-in (founder 2026-10-28): format.checkIn decides whether arrival matters -------------------
// Same fixture each time; only the event's checkIn setting and the people's checked_in flag differ.
async function firstTickRounds(format: Record<string, unknown>, checkedIn: boolean) {
  const name = `Check-in check ${Date.now()}`
  const ev = must(
    await admin
      .from('sd_events')
      .insert({ org_id: org!.id, name, format, round_duration_seconds: 60, break_duration_seconds: 0 })
      .select('id')
      .single(),
    'create event',
  )
  try {
    for (const state of ['open', 'running']) {
      const { error } = await admin.from('sd_events').update({ state }).eq('id', ev.id)
      if (error) throw new Error(`-> ${state}: ${error.message}`)
    }
    for (const p of people!) {
      const { error } = await admin.from('sd_participants').insert({
        org_id: org!.id,
        event_id: ev.id,
        user_id: p.user_id,
        status: 'registered',
        seat_type: 'participant',
        checked_in: checkedIn,
      })
      if (error) throw new Error(`seat: ${error.message}`)
    }
    await runOrchestratorTick(admin)
    return must(await admin.from('sd_rounds').select('round_number').eq('event_id', ev.id), 'read rounds').length
  } finally {
    await admin.from('sd_events').delete().eq('id', ev.id)
  }
}
check('check-in USED (staff), nobody arrived: NO round is built', (await firstTickRounds({ checkIn: 'staff' }, false)) === 0)
check('CONTROL check-in USED (staff), everybody arrived: the round IS built', (await firstTickRounds({ checkIn: 'staff' }, true)) === 1)
check('check-in USED (self), nobody arrived: NO round is built', (await firstTickRounds({ checkIn: 'self' }, false)) === 0)
check('check-in NOT used, nobody arrived: the round IS built (the old worker built none)', (await firstTickRounds({}, false)) === 1)

// ---- "Round X of N" follows who is actually there (founder 2026-11-05) -----------------------------------
// The organizer's cap (rounds_planned) is never rewritten any more; the worker recounts sd_events.rounds_expected
// at every round start from the people checked in. Check-in used, cap 8 throughout.
const { data: more } = await admin.from('profiles').select('user_id, display_name').in('display_name', ['Eve E', 'Frank F'])
const eve = more?.find((p) => p.display_name === 'Eve E')
const frank = more?.find((p) => p.display_name === 'Frank F')
if (!eve || !frank) throw new Error('Eve E / Frank F not found — seed first')

// Plays the event through the worker: `arrived` are checked in from the start; `lateBeforeRound` (if any)
// checks in just before that round is built. Records rounds_planned / rounds_expected after every tick
// that built a round, and runs until the worker builds no more.
async function playEvent(opts: { arrived: string[]; noShows: string[]; late?: { userId: string; beforeRound: number }; allowRepeats?: boolean }) {
  const ev = must(
    await admin
      .from('sd_events')
      .insert({ org_id: org!.id, name: `Rounds expected check ${Date.now()}`, rounds_planned: 8, allow_repeat_pairings: opts.allowRepeats ?? false, round_duration_seconds: 60, break_duration_seconds: 0, format: { checkIn: 'self' } })
      .select('id')
      .single(),
    'create event',
  )
  const seen: { round: number; planned: number | null; expected: number | null }[] = []
  let lateSeat = "(no late arrival)"
  try {
    for (const state of ['open', 'running']) {
      const { error } = await admin.from('sd_events').update({ state }).eq('id', ev.id)
      if (error) throw new Error(`-> ${state}: ${error.message}`)
    }
    const seats = [
      ...opts.arrived.map((u) => [u, true] as const),
      ...opts.noShows.map((u) => [u, false] as const),
      ...(opts.late ? [[opts.late.userId, false] as const] : []),
    ]
    for (const [user_id, checked_in] of seats) {
      const { error } = await admin.from('sd_participants').insert({
        org_id: org!.id, event_id: ev.id, user_id, status: 'registered', seat_type: 'participant', checked_in,
      })
      if (error) throw new Error(`seat: ${error.message}`)
    }
    for (let i = 0; i < 12; i++) {
      const before = must(await admin.from('sd_rounds').select('id').eq('event_id', ev.id), 'read rounds').length
      if (opts.late && before + 1 === opts.late.beforeRound) {
        const { error } = await admin.from('sd_participants').update({ checked_in: true }).eq('event_id', ev.id).eq('user_id', opts.late.userId)
        if (error) throw new Error(`late check-in: ${error.message}`)
        lateSeat = JSON.stringify((await admin.from('sd_participants').select('checked_in, status').eq('event_id', ev.id).eq('user_id', opts.late.userId)).data)
      }
      await runOrchestratorTick(admin)
      const after = must(await admin.from('sd_rounds').select('id').eq('event_id', ev.id), 'read rounds').length
      const row = must(await admin.from('sd_events').select('rounds_planned, rounds_expected').eq('id', ev.id).single(), 'read event')
      if (after > before) seen.push({ round: after, planned: row.rounds_planned, expected: row.rounds_expected })
      else return { seen, ran: after, finalExpected: row.rounds_expected, finalPlanned: row.rounds_planned, lateSeat }
      // run this round's clock out so the next tick closes it and builds the next
      const { error } = await admin.from('sd_rounds').update({ ends_at: new Date(Date.now() - 3_600_000).toISOString() }).eq('event_id', ev.id)
      if (error) throw new Error(`clock: ${error.message}`)
    }
    throw new Error('runaway: the worker kept building rounds')
  } finally {
    await admin.from('sd_events').delete().eq('id', ev.id)
  }
}
const [charlie, dana] = people!.map((p) => p.user_id)

// No-show: four registered, three come (odd pool of three -> three rounds). The old rule said "of 4".
const noShow = await playEvent({ arrived: [charlie!, dana!, eve.user_id], noShows: [frank.user_id] })
check('no-show: the organizer cap stays as typed (8) every round', noShow.seen.every((s) => s.planned === 8) && noShow.finalPlanned === 8, JSON.stringify(noShow))
check('no-show: N counts the three who came, not the four registered', noShow.seen.every((s) => s.expected === 3), JSON.stringify(noShow.seen))
check('no-show: N was exact — exactly that many rounds ran', noShow.ran === 3, `${noShow.ran} ran`)

// Late arrival: three come, Frank checks in just before round 2. N goes up from round 2 and is then exact.
const late = await playEvent({ arrived: [charlie!, dana!, eve.user_id], noShows: [], late: { userId: frank.user_id, beforeRound: 2 } })
check('late arrival: round 1 says 3 (the three there)', late.seen[0]?.expected === 3, JSON.stringify(late.seen))
check('late arrival: from round 2, N is exactly the rounds that then ran', late.seen.slice(1).every((s) => s.expected === late.ran), `${JSON.stringify(late.seen)}; ran ${late.ran}`)
check('CONTROL late arrival: the late arrival really added rounds (more than 3 ran)', late.ran > 3, `${late.ran} ran`)
check('late arrival: when the rotation ran out, N equals the rounds run', late.finalExpected === late.ran, JSON.stringify(late))
check('late arrival: the organizer cap stays 8', late.finalPlanned === 8)

// Repeats allowed: no natural end, so N is the organizer's cap.
const repeats = await playEvent({ arrived: [charlie!, dana!], noShows: [], allowRepeats: true })
check('CONTROL repeats allowed: N is the cap (8) and 8 rounds run', repeats.seen.every((s) => s.expected === 8) && repeats.ran === 8, JSON.stringify(repeats))

// ---- The organizer's manual path computes the same N as the worker (re-review 2026-11-05) ---------------
// runPairingRound runs AS THE ORGANIZER under RLS; the worker runs as service role. N is only consistent if
// the organizer can read every pairing row and every seat (incl. a WITHDRAWN one) the worker reads. Measured:
// the worker runs two rounds, someone withdraws in between, then alice — signed in as herself — rebuilds N
// from exactly what RLS lets her read, and it must equal what the worker stored.
import { projectedTotalRounds, seatsPerRound } from '../modules/speed-dating/src/index.ts'
const anonKey = fromEnvFile('apps/web/.env.local', 'NEXT_PUBLIC_SUPABASE_ANON_KEY')
if (!anonKey) throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY missing in apps/web/.env.local')
const asAlice: SupabaseClient = createClient(url, anonKey, { auth: { persistSession: false } })
{
  const { error } = await asAlice.auth.signInWithPassword({ email: 'alice@demo.local', password: 'password123' })
  if (error) throw new Error(`alice sign-in: ${error.message}`)
}
{
  const ev = must(
    await admin
      .from('sd_events')
      .insert({ org_id: org!.id, name: `Organizer N check ${Date.now()}`, rounds_planned: 8, allow_repeat_pairings: false, round_duration_seconds: 60, break_duration_seconds: 0 })
      .select('id')
      .single(),
    'create event',
  )
  try {
    for (const state of ['open', 'running']) {
      const { error } = await admin.from('sd_events').update({ state }).eq('id', ev.id)
      if (error) throw new Error(`-> ${state}: ${error.message}`)
    }
    for (const user_id of [charlie!, dana!, eve.user_id, frank.user_id]) {
      const { error } = await admin.from('sd_participants').insert({ org_id: org!.id, event_id: ev.id, user_id, status: 'registered', seat_type: 'participant' })
      if (error) throw new Error(`seat: ${error.message}`)
    }
    await runOrchestratorTick(admin) // round 1, four people
    const { error: wErr } = await admin.from('sd_participants').update({ status: 'withdrawn' }).eq('event_id', ev.id).eq('user_id', frank.user_id)
    if (wErr) throw new Error(`withdraw: ${wErr.message}`)
    await admin.from('sd_rounds').update({ ends_at: new Date(Date.now() - 3_600_000).toISOString() }).eq('event_id', ev.id)
    await runOrchestratorTick(admin) // round 2, three people
    const stored = must(await admin.from('sd_events').select('rounds_expected').eq('id', ev.id).single(), 'read event').rounds_expected as number | null

    // What the worker reads (service role) vs what alice reads (RLS).
    const count = async (c: SupabaseClient, t: string) => (await c.from(t).select('id', { count: 'exact', head: true }).eq('event_id', ev.id)).count
    const svcPairings = await count(admin, 'sd_pairings'), alicePairings = await count(asAlice, 'sd_pairings')
    const svcSeats = await count(admin, 'sd_participants'), aliceSeats = await count(asAlice, 'sd_participants')
    check('CONTROL: two rounds ran and the withdrawn seat is in round 1\'s rows', (svcPairings ?? 0) >= 4 && svcSeats === 4, `pairings ${svcPairings}, seats ${svcSeats}`)
    check('the organizer reads every pairing row the worker reads', alicePairings === svcPairings, `alice ${alicePairings} vs ${svcPairings}`)
    check('the organizer reads every seat, the WITHDRAWN one included', aliceSeats === svcSeats, `alice ${aliceSeats} vs ${svcSeats}`)

    // Alice rebuilds N exactly as runPairingRound does, from her own reads.
    const rounds = must(await asAlice.from('sd_rounds').select('id, round_number').eq('event_id', ev.id), 'alice rounds')
    const pairings = must(await asAlice.from('sd_pairings').select('round_id, participant_a_id, participant_b_id').eq('event_id', ev.id), 'alice pairings')
    const every = must(await asAlice.from('sd_participants').select('id, user_id, pool_side, status').eq('event_id', ev.id), 'alice seats')
    const sideOf = new Map(every.map((s) => [s.id as string, s.pool_side as string | null]))
    const present = every.filter((s) => s.status === 'registered').map((s) => ({ id: s.id as string, userId: s.user_id as string, poolSide: s.pool_side as string | null }))
    const aliceN = projectedTotalRounds({ roundsSoFar: seatsPerRound(rounds, pairings, (id) => sideOf.get(id) ?? null), present, allowRepeats: false, cap: 8 })
    check('the organizer\'s N equals the worker\'s stored N', aliceN === stored, `alice ${aliceN} vs worker ${stored}`)
  } finally {
    await admin.from('sd_events').delete().eq('id', ev.id)
  }
}
await asAlice.auth.signOut()

// ---- Mid-round: N follows an arrival / un-tick without waiting for the next round (2026-11-05) -----------
{
  const ev = must(
    await admin
      .from('sd_events')
      .insert({ org_id: org!.id, name: `Mid-round N check ${Date.now()}`, rounds_planned: 8, allow_repeat_pairings: false, round_duration_seconds: 600, break_duration_seconds: 0, format: { checkIn: 'self' } })
      .select('id')
      .single(),
    'create event',
  )
  try {
    for (const state of ['open', 'running']) {
      const { error } = await admin.from('sd_events').update({ state }).eq('id', ev.id)
      if (error) throw new Error(`-> ${state}: ${error.message}`)
    }
    for (const [user_id, checked_in] of [[charlie!, true], [dana!, true], [eve.user_id, true], [frank.user_id, false]] as const) {
      const { error } = await admin.from('sd_participants').insert({ org_id: org!.id, event_id: ev.id, user_id, status: 'registered', seat_type: 'participant', checked_in })
      if (error) throw new Error(`seat: ${error.message}`)
    }
    const n = async () => must(await admin.from('sd_events').select('rounds_expected').eq('id', ev.id).single(), 'read').rounds_expected as number | null
    const roundCount = async () => must(await admin.from('sd_rounds').select('id').eq('event_id', ev.id), 'rounds').length
    await runOrchestratorTick(admin) // round 1 with three; its 10-minute clock keeps running
    const atStart = await n()
    const setFrank = async (checked_in: boolean) => {
      const { error } = await admin.from('sd_participants').update({ checked_in }).eq('event_id', ev.id).eq('user_id', frank.user_id)
      if (error) throw new Error(`frank: ${error.message}`)
    }
    await runOrchestratorTick(admin)
    check('CONTROL mid-round: a quiet tick leaves N alone (3) and builds no round', (await n()) === 3 && (await roundCount()) === 1 && atStart === 3, `start ${atStart}`)
    await setFrank(true)
    const frankSeat = JSON.stringify((await admin.from('sd_participants').select('checked_in, status').eq('event_id', ev.id).eq('user_id', frank.user_id)).data)
    const roundsBefore = JSON.stringify((await admin.from('sd_rounds').select('round_number, state, ends_at').eq('event_id', ev.id)).data)
    await runOrchestratorTick(admin)
    const afterArrival = await n()
    check('mid-round: Frank arriving raises N at once (3 -> 4), still in round 1', afterArrival === 4 && (await roundCount()) === 1, `N ${afterArrival}; frank ${frankSeat}; rounds ${roundsBefore}; now ${new Date().toISOString()}`)
    await setFrank(false)
    await runOrchestratorTick(admin)
    check('mid-round: Frank un-ticked lowers N again (back to 3)', (await n()) === 3, `N ${await n()}`)
  } finally {
    await admin.from('sd_events').delete().eq('id', ev.id)
  }
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED')
process.exit(fails ? 1 : 0)
