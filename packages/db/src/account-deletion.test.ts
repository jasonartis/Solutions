import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import postgres from 'postgres'

// ---------------------------------------------------------------------------
// ACCOUNT DELETION — the silhouette model (20261007090000, docs/21 §7).
//
// EVERY SUBJECT HERE IS A THROWAWAY ACCOUNT created by this file and hard-
// deleted at the end. CI runs this suite and then e2e against the SAME
// database with no reset between, so a seeded user must never be departed,
// silhouetted or banned here — e2e signs in as them minutes later. The probe
// speed-dating event and probe org are likewise this file's own, removed in
// afterAll.
//
// The cast:
//   pat   — the person who leaves. Ends as a silhouette.
//   quinn — pat's counterparty. A revealed MATCH with pat, wrote a safety note
//           about pat. The viewer for every "what do others see" assertion.
//   rory  — said no to quinn (no match row). Departs, then signs back in at
//           expiry time, so the job must CANCEL, not delete.
//   sam   — departs, then becomes the sole admin of an org during the grace
//           period, so the job must FAIL for sam alone and record why.
// ---------------------------------------------------------------------------

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const anonKey = process.env.SUPABASE_ANON_KEY ?? ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const ownerDbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const PASSWORD = 'password123'

const sql = postgres(ownerDbUrl, { prepare: false, max: 1 })
const admin = () => {
  // A missing key must FAIL, not skip: a skipped suite reports green and
  // proves nothing (docs/03 vacuity rule).
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for the account-deletion suite')
  return createClient(url, serviceKey, { auth: { persistSession: false } })
}

async function signIn(email: string): Promise<SupabaseClient> {
  const client = createClient(url, anonKey, { auth: { persistSession: false } })
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD })
  if (error) throw new Error(`Sign-in failed for ${email}: ${error.message}`)
  return client
}

type Probe = { id: string; email: string }
const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
const probes: Record<'pat' | 'quinn' | 'rory' | 'sam', Probe> = {} as never
let datingOrg = ''
let probeOrg = ''
let eventId = ''
let matchId = ''
const seat = {} as Record<'pat' | 'quinn' | 'rory' | 'sam', string>

async function rpc(client: SupabaseClient, fn: string, args: Record<string, unknown> = {}) {
  const { data, error } = await client.rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data
}
const stateOf = async (id: string) =>
  (await sql<{ state: string; cancel_reason: string | null; last_error: string | null }[]>`
    select state, cancel_reason, last_error from account_deletions where user_id = ${id}`)[0] ?? null
const runJob = async () =>
  (await sql<{ r: { deleted: number; cancelled: number; failed: number } }[]>`
    select public.account_complete_due_deletions() as r`)[0]!.r
// Remove probe-org seats even when one is the org's only owner. The admin floor
// (org_members_guard_last_admin) has no bypass for a direct delete, which is
// right for real use and wrong for fixture teardown, so triggers are suspended
// for this one statement in its own transaction.
const dropSeats = (ids: string[]) =>
  sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`
    await tx`delete from org_members where org_id = ${probeOrg} and user_id = any(${ids})`
  })
const makeDue = (id: string) =>
  sql`update account_deletions set due_at = now() - interval '1 minute' where user_id = ${id}`

beforeAll(async () => {
  const a = admin()
  for (const name of ['pat', 'quinn', 'rory', 'sam'] as const) {
    const email = `deletion-${name}-${tag}@demo.local`
    const { data, error } = await a.auth.admin.createUser({
      email, password: PASSWORD, email_confirm: true, user_metadata: { display_name: `Probe ${name}` },
    })
    if (error) throw new Error(`createUser ${name}: ${error.message}`)
    probes[name] = { id: data.user!.id, email }
    await sql`update profiles set display_name = ${`Probe ${name}`} where user_id = ${data.user!.id}`
  }

  const [dating] = await sql<{ id: string }[]>`select id from orgs where slug = 'demo-dating'`
  if (!dating) throw new Error('demo-dating not seeded — run the seed first')
  datingOrg = dating.id

  // No-JWT owner connection: the hierarchy guards treat it as the trusted
  // backend, exactly as the seed does.
  for (const p of Object.values(probes)) {
    await sql`insert into org_members (org_id, user_id, role, status, accepted_at)
              values (${datingOrg}, ${p.id}, 'member', 'active', now())`
    await sql`insert into module_roles (org_id, user_id, module_key, role)
              values (${datingOrg}, ${p.id}, 'speed-dating', 'participant')`
  }

  const [ev] = await sql<{ id: string }[]>`
    insert into sd_events (org_id, name, state) values (${datingOrg}, ${`Deletion probe ${tag}`}, 'complete') returning id`
  eventId = ev!.id
  for (const [name, side] of [['pat', 'a'], ['quinn', 'b'], ['rory', 'a'], ['sam', 'a']] as const) {
    const [s] = await sql<{ id: string }[]>`
      insert into sd_participants (org_id, event_id, user_id, status, pool_side, profile_card, profile)
      values (${datingOrg}, ${eventId}, ${probes[name].id}, 'registered', ${side},
              ${`I am ${name}, I like hiking`}, ${sql.json({ bio: `${name} bio` })})
      returning id`
    seat[name] = s!.id
  }
  // pat <-> quinn: both said yes -> a revealed match, contacts shared.
  await sql`insert into sd_interest (org_id, event_id, rater_participant_id, target_participant_id, verdict) values
            (${datingOrg}, ${eventId}, ${seat.pat}, ${seat.quinn}, 'interested'),
            (${datingOrg}, ${eventId}, ${seat.quinn}, ${seat.pat}, 'interested'),
            (${datingOrg}, ${eventId}, ${seat.quinn}, ${seat.rory}, 'interested'),
            (${datingOrg}, ${eventId}, ${seat.rory}, ${seat.quinn}, 'not_interested')`
  // The reciprocal 'interested' pair makes sd_interest_mutual create the match
  // row itself — the real path — so the fixture only reveals it and records the
  // contact share, as the organizer's reveal would.
  const [m] = await sql<{ id: string }[]>`
    update sd_matches
       set revealed = true, matched_at = now(),
           contact_shared = ${sql.json({
             [probes.pat.id]: { displayName: 'Probe pat', email: probes.pat.email },
             [probes.quinn.id]: { displayName: 'Probe quinn', email: probes.quinn.email },
           })}
     where event_id = ${eventId}
       and ${seat.pat} in (participant_a_id, participant_b_id)
       and ${seat.quinn} in (participant_a_id, participant_b_id)
    returning id`
  if (!m) throw new Error('sd_interest_mutual did not create the pat/quinn match — the fixture premise is gone')
  matchId = m.id
  // CONTROL for §7.8: rory said no to quinn, so no match row may exist for them.
  const [noMatch] = await sql<{ n: number }[]>`
    select count(*)::int as n from sd_matches
    where event_id = ${eventId} and ${seat.rory} in (participant_a_id, participant_b_id)`
  if (noMatch!.n !== 0) throw new Error('a match row exists for a one-sided interest — the §7.8 test would be vacuous')
  // A human act ABOUT pat, by someone else — must survive (§7.1, both directions).
  await sql`insert into sd_notes (org_id, event_id, author_user_id, about_user_id, body)
            values (${datingOrg}, ${eventId}, ${probes.quinn.id}, ${probes.pat.id}, 'felt unsafe in round 2')`

  // A probe org sam will become the sole admin of (used in the failure test).
  const [o] = await sql<{ id: string }[]>`
    insert into orgs (name, slug) values ('Deletion probe org', ${`deletion-probe-${tag}`}) returning id`
  probeOrg = o!.id
}, 60_000)

afterAll(async () => {
  try {
    if (eventId) await sql`delete from sd_events where id = ${eventId}`
    // org deletion cascades org_members; the cascade escape in the admin floor allows it.
    if (probeOrg) await sql`delete from orgs where id = ${probeOrg}`
    const a = admin()
    for (const p of Object.values(probes)) {
      // A HARD delete of a silhouette must still work: nothing the silhouette
      // step did may make a user undeletable (the docs/20 §30 trap class).
      const { error } = await a.auth.admin.deleteUser(p.id)
      expect(error, `hard-deleting probe ${p.email} failed`).toBeNull()
    }
  } finally {
    await sql.end()
  }
}, 60_000)

describe('account deletion (20261007090000)', () => {
  it('refuses a self-serve request whose typed confirmation is not your own address', async () => {
    const pat = await signIn(probes.pat.email)
    const r = await rpc(pat, 'account_request_deletion', { confirm_email: probes.quinn.email })
    expect(r).toMatchObject({ ok: false, reason: 'confirmation_mismatch' })
    expect(await stateOf(probes.pat.id), 'a refused request still wrote a row').toBeNull()
  })

  it('refuses the sole admin of an org, and names the org; a superadmin is refused too', async () => {
    await sql`insert into org_members (org_id, user_id, role, status, accepted_at)
              values (${probeOrg}, ${probes.sam.id}, 'owner', 'active', now())`
    try {
      const sam = await signIn(probes.sam.email)
      expect(await rpc(sam, 'account_my_deletion_blockers')).toEqual(['sole_admin:Deletion probe org'])
      const r = await rpc(sam, 'account_request_deletion', { confirm_email: probes.sam.email })
      expect(r).toMatchObject({ ok: false, reason: 'blocked' })
      expect(await stateOf(probes.sam.id)).toBeNull()
    } finally {
      await dropSeats([probes.sam.id])
    }
    // CONTROL: the same person with no sole-admin seat has no blockers, so the
    // refusal above was about the seat, not about sam.
    const sam = await signIn(probes.sam.email)
    expect(await rpc(sam, 'account_my_deletion_blockers')).toEqual([])

    const owner = await signIn('owner@demo.local')
    expect(await rpc(owner, 'account_my_deletion_blockers')).toContain('superadmin')
  })

  it('a request signs you out everywhere, and the counterparty of a REVEALED match learns you left', async () => {
    const quinn = await signIn(probes.quinn.email)
    // CONTROL: before anyone leaves, quinn's archive is empty.
    expect(await rpc(quinn, 'sd_my_departed_matches', { check_event_id: eventId })).toEqual([])

    const pat = await signIn(probes.pat.email)
    const r = await rpc(pat, 'account_request_deletion', { confirm_email: probes.pat.email.toUpperCase() })
    expect(r).toMatchObject({ ok: true })
    expect((await stateOf(probes.pat.id))?.state).toBe('departed')

    const { error: refreshErr } = await pat.auth.refreshSession()
    expect(refreshErr, 'a refresh token survived the departure').not.toBeNull()

    expect(await rpc(quinn, 'sd_my_departed_matches', { check_event_id: eventId })).toEqual([matchId])
    // The grace period is NOT the silhouette: pat still renders by name.
    expect(await rpc(quinn, 'former_members', { check_user_ids: [probes.pat.id] })).toEqual([])
  })

  it('§7.8: a counterparty who said NO is never reported as having left', async () => {
    const rory = await signIn(probes.rory.email)
    expect(await rpc(rory, 'account_request_deletion', { confirm_email: probes.rory.email })).toMatchObject({ ok: true })
    const quinn = await signIn(probes.quinn.email)
    // quinn said yes to rory, rory said no: no match row, so departure is not
    // the cause of anything, and is not disclosed. Only pat's match appears.
    expect(await rpc(quinn, 'sd_my_departed_matches', { check_event_id: eventId })).toEqual([matchId])
  })

  it('a co-admin who is already leaving does not count as the one who stays', async () => {
    // rory is in a grace period (previous test). Make rory and sam the two
    // owners of the probe org: sam must be blocked, or both could leave and
    // the second would be wedged as sole admin after the first is deleted.
    await sql`insert into org_members (org_id, user_id, role, status, accepted_at) values
              (${probeOrg}, ${probes.rory.id}, 'owner', 'active', now()),
              (${probeOrg}, ${probes.sam.id}, 'owner', 'active', now())`
    try {
      const sam = await signIn(probes.sam.email)
      expect(await rpc(sam, 'account_my_deletion_blockers')).toEqual(['sole_admin:Deletion probe org'])
      // CONTROL: once rory is not leaving, rory counts again and sam is free.
      await sql`update account_deletions set state = 'cancelled', cancelled_at = now(), cancel_reason = 'superadmin'
                where user_id = ${probes.rory.id}`
      expect(await rpc(sam, 'account_my_deletion_blockers')).toEqual([])
      await sql`update account_deletions set state = 'departed', cancelled_at = null, cancel_reason = null
                where user_id = ${probes.rory.id}`
    } finally {
      await dropSeats([probes.rory.id, probes.sam.id])
    }
  })

  it('an access token issued BEFORE the request cannot cancel it; a real sign-in does', async () => {
    const before = await signIn(probes.sam.email)
    const samNow = await signIn(probes.sam.email)
    expect(await rpc(samNow, 'account_request_deletion', { confirm_email: probes.sam.email })).toMatchObject({ ok: true })

    expect(await rpc(before, 'account_deletion_resume')).toEqual({ cancelled: false })
    expect((await stateOf(probes.sam.id))?.state).toBe('departed')

    const again = await signIn(probes.sam.email)
    expect(await rpc(again, 'account_deletion_resume')).toEqual({ cancelled: true })
    expect(await stateOf(probes.sam.id)).toMatchObject({ state: 'cancelled', cancel_reason: 'signed_in' })
  })

  it('only a superadmin can start or cancel a deletion for someone else', async () => {
    const quinn = await signIn(probes.quinn.email)
    expect(await rpc(quinn, 'account_request_deletion_for_email', { target_email: probes.sam.email }))
      .toMatchObject({ ok: false, reason: 'not_authorized' })
    expect((await stateOf(probes.sam.id))?.state, 'an ordinary member changed someone else\'s deletion').toBe('cancelled')

    const owner = await signIn('owner@demo.local')
    expect(await rpc(owner, 'account_request_deletion_for_email', { target_email: probes.sam.email }))
      .toMatchObject({ ok: true })
    expect(await stateOf(probes.sam.id)).toMatchObject({ state: 'departed' })

    expect(await rpc(quinn, 'account_cancel_deletion', { target: probes.sam.id }))
      .toMatchObject({ ok: false, reason: 'not_authorized' })
    expect((await stateOf(probes.sam.id))?.state).toBe('departed')

    expect(await rpc(owner, 'account_cancel_deletion', { target: probes.sam.id })).toMatchObject({ ok: true })
    expect(await stateOf(probes.sam.id)).toMatchObject({ state: 'cancelled', cancel_reason: 'superadmin' })
    // Leave sam departed for the expiry test.
    expect(await rpc(owner, 'account_request_deletion_for_email', { target_email: probes.sam.email }))
      .toMatchObject({ ok: true })

    // A JWT caller cannot run the silhouette job at all — not even a superadmin.
    const { error } = await owner.rpc('account_complete_due_deletions')
    expect(error, 'a superadmin session could run the silhouette job').not.toBeNull()
  })

  it('the daily job silhouettes pat, cancels rory (signed back in), and fails sam alone with a reason', async () => {
    // rory signs back in AFTER the request — the job must cancel, not delete.
    await signIn(probes.rory.email)
    // sam becomes the sole admin of an org during the grace period.
    await sql`insert into org_members (org_id, user_id, role, status, accepted_at)
              values (${probeOrg}, ${probes.sam.id}, 'owner', 'active', now())`
    for (const p of [probes.pat, probes.rory, probes.sam]) await makeDue(p.id)

    // CONTROL: pat really has the things the silhouette must remove.
    const [pre] = await sql<{ m: number; r: number; l: number }[]>`
      select (select count(*)::int from org_members where user_id = ${probes.pat.id}) m,
             (select count(*)::int from module_roles where user_id = ${probes.pat.id}) r,
             (select count(*)::int from login_events where user_id = ${probes.pat.id}) l`
    expect(pre).toEqual({ m: 1, r: 1, l: expect.any(Number) })
    expect(pre!.l).toBeGreaterThan(0)

    const result = await runJob()
    expect(result).toMatchObject({ deleted: 1, cancelled: 1, failed: 1 })

    expect(await stateOf(probes.pat.id)).toMatchObject({ state: 'deleted' })
    expect(await stateOf(probes.rory.id)).toMatchObject({ state: 'cancelled', cancel_reason: 'signed_in' })
    const sam = await stateOf(probes.sam.id)
    expect(sam?.state, 'a blocked silhouette must stay departed, to be retried').toBe('departed')
    expect(sam?.last_error).toContain('sole_admin:Deletion probe org')
    // sam's failure rolled back cleanly: still a member everywhere.
    expect((await sql`select 1 from org_members where user_id = ${probes.sam.id}`).length).toBe(2)
    await dropSeats([probes.sam.id])
  })

  it('the silhouette: identity scrubbed, memberships revoked, derived rows gone, human acts kept', async () => {
    const id = probes.pat.id
    const [s] = await sql<Record<string, unknown>[]>`
      select
        (select display_name from profiles where user_id = ${id}) as display_name,
        (select count(*)::int from org_members where user_id = ${id}) as memberships,
        (select count(*)::int from module_roles where user_id = ${id}) as grants,
        (select count(*)::int from login_events where user_id = ${id}) as logins,
        (select count(*)::int from login_rollup where user_id = ${id}) as rollup,
        (select email from auth.users where id = ${id}) as email,
        (select banned_until > now() + interval '50 years' from auth.users where id = ${id}) as banned,
        (select count(*)::int from auth.identities where user_id = ${id}) as identities,
        (select count(*)::int from auth.sessions where user_id = ${id}) as sessions,
        (select raw_user_meta_data from auth.users where id = ${id}) as meta,
        (select profile_card from sd_participants where id = ${seat.pat}) as card,
        (select profile from sd_participants where id = ${seat.pat}) as profile,
        (select contact_shared from sd_matches where id = ${matchId}) as contacts,
        (select count(*)::int from sd_notes where about_user_id = ${id}) as notes_about,
        (select count(*)::int from sd_interest where rater_participant_id = ${seat.pat}) as interest,
        (select count(*)::int from sd_matches where id = ${matchId}) as match`
    expect(s).toMatchObject({
      display_name: null, memberships: 0, grants: 0, logins: 0, rollup: 0,
      email: null, banned: true, identities: 0, sessions: 0, meta: {},
      card: null, profile: {}, notes_about: 1, interest: 1, match: 1,
    })
    // pat's contact entry is gone; quinn's own is untouched.
    expect(Object.keys(s!.contacts as object)).toEqual([probes.quinn.id])

    // Cannot sign in, and GoTrue can still load the row (a NULL in a column
    // GoTrue scans as a plain string would make this error).
    const anon = createClient(url, anonKey, { auth: { persistSession: false } })
    const { error: signErr } = await anon.auth.signInWithPassword({ email: probes.pat.email, password: PASSWORD })
    expect(signErr, 'a silhouette could still sign in').not.toBeNull()
    const { data: loaded, error: loadErr } = await admin().auth.admin.getUserById(id)
    expect(loadErr, `GoTrue could not load the silhouette: ${loadErr?.message}`).toBeNull()
    expect(loaded.user?.id).toBe(id)

    // §7.2: a returning person is a NEW person — the address is free again.
    const { data: fresh, error: freshErr } = await admin().auth.admin.createUser({
      email: probes.pat.email, password: PASSWORD, email_confirm: true,
    })
    expect(freshErr, 'the deleted address could not be reused').toBeNull()
    expect(fresh.user!.id).not.toBe(id)
    await admin().auth.admin.deleteUser(fresh.user!.id)
  })

  it('others see a silhouette as a former member, and the match stays archived with its reason', async () => {
    const quinn = await signIn(probes.quinn.email)
    expect(await rpc(quinn, 'former_members', { check_user_ids: [probes.pat.id, probes.quinn.id, probes.rory.id] }))
      .toEqual([probes.pat.id])
    // NOT AN ORACLE: someone who never shared an org with pat learns nothing,
    // even holding pat's uuid (adversarial review, 2026-10-07).
    const bob = await signIn('bob@demo.local')
    expect(await rpc(bob, 'former_members', { check_user_ids: [probes.pat.id] })).toEqual([])
    expect(await rpc(quinn, 'sd_my_departed_matches', { check_event_id: eventId })).toEqual([matchId])
    // The match itself is still readable to quinn — it moved to the archive, it did not vanish.
    const { data } = await quinn.from('sd_matches').select('id').eq('id', matchId)
    expect(data).toEqual([{ id: matchId }])
    // The silhouette's profile row is no longer visible to its former co-member.
    const { data: prof } = await quinn.from('profiles').select('user_id').eq('user_id', probes.pat.id)
    expect(prof).toEqual([])
  })

  it('a failed silhouette is retried by the next run, and finished ones are not redone', async () => {
    // sam's sole-admin seat was removed at the end of the expiry test, so the
    // blocker is gone and the next daily run must pick sam up again.
    expect(await runJob()).toEqual({ deleted: 1, cancelled: 0, failed: 0 })
    expect(await stateOf(probes.sam.id)).toMatchObject({ state: 'deleted', last_error: null })
    // Nothing left that is due: a further run is a no-op.
    expect(await runJob()).toEqual({ deleted: 0, cancelled: 0, failed: 0 })
  })
})

// ---------------------------------------------------------------------------
// REMOVE FROM PLATFORM (20261008020000). Its own throwaway cast, created and
// hard-deleted here. In THIS file rather than its own because the daily job
// it exercises acts on every due row in the database, and vitest runs files in
// parallel: from a separate file it could silhouette the probes above mid-test.
// Here it runs after them, in sequence.
//   rex   — removed; proves the ban, the refusals, and that nothing he or an
//           "at request" action does can turn it back into a cancellable one.
//           A stale sign-in timestamp cannot cancel it; day 30 silhouettes him.
//   tess  — removed, then UNDONE by the superadmin: the ban lifts.
//   una   — the sole admin of an org: removal is NOT refused (a warning), the
//           ban applies at once, and day 30 fails visibly while the ban holds.
// ---------------------------------------------------------------------------
describe('remove from platform (20261008020000)', () => {
  const cast = {} as Record<'rex' | 'tess' | 'una', Probe>
  let unaOrg = ''
  let owner: SupabaseClient
  const bannedUntil = async (id: string) =>
    (await sql<{ b: Date | null }[]>`select banned_until as b from auth.users where id = ${id}`)[0]!.b
  const sessions = async (id: string) =>
    (await sql<{ n: number }[]>`select count(*)::int as n from auth.sessions where user_id = ${id}`)[0]!.n
  const viaOf = async (id: string) =>
    (await sql<{ v: string }[]>`select initiated_via as v from account_deletions where user_id = ${id}`)[0]?.v

  beforeAll(async () => {
    const a = admin()
    for (const name of ['rex', 'tess', 'una'] as const) {
      const email = `removal-${name}-${tag}@demo.local`
      const { data, error } = await a.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true })
      if (error) throw new Error(`createUser ${name}: ${error.message}`)
      cast[name] = { id: data.user!.id, email }
    }
    const [o] = await sql<{ id: string }[]>`
      insert into orgs (name, slug) values ('Removal probe org', ${`removal-probe-${tag}`}) returning id`
    unaOrg = o!.id
    await sql`insert into org_members (org_id, user_id, role, status, accepted_at)
              values (${unaOrg}, ${cast.una.id}, 'owner', 'active', now())`
    owner = await signIn('owner@demo.local')
  }, 60_000)

  afterAll(async () => {
    if (unaOrg) await sql`delete from orgs where id = ${unaOrg}`
    for (const p of Object.values(cast)) {
      const { error } = await admin().auth.admin.deleteUser(p.id)
      expect(error, `hard-deleting probe ${p.email} failed`).toBeNull()
    }
  }, 60_000)

  it('only a superadmin can remove someone', async () => {
    const tess = await signIn(cast.tess.email)
    expect(await rpc(tess, 'account_remove_from_platform', { target_email: cast.rex.email, category: 'other', note: 'test removal reason' }))
      .toMatchObject({ ok: false, reason: 'not_authorized' })
    expect(await stateOf(cast.rex.id), 'an ordinary member removed someone').toBeNull()
    expect(await bannedUntil(cast.rex.id)).toBeNull()
  })

  it('a superadmin cannot be removed, not even by themselves', async () => {
    expect(await rpc(owner, 'account_remove_from_platform', { target_email: 'owner@demo.local', category: 'other', note: 'test removal reason' }))
      .toMatchObject({ ok: false, reason: 'blocked', blockers: ['superadmin'] })
    const [me] = await sql<{ b: Date | null }[]>`
      select u.banned_until as b from auth.users u where lower(u.email) = 'owner@demo.local'`
    expect(me!.b, 'the superadmin banned themselves').toBeNull()
  })

  it('removal blocks sign-in AT ONCE and signs out everywhere', async () => {
    const before = await signIn(cast.rex.email)
    expect(await sessions(cast.rex.id), 'CONTROL: rex has a live session').toBeGreaterThan(0)
    expect(await rpc(owner, 'account_remove_from_platform', { target_email: cast.rex.email, category: 'other', note: 'test removal reason' }))
      .toMatchObject({ ok: true, warnings: [] })
    expect(await stateOf(cast.rex.id)).toMatchObject({ state: 'departed' })
    expect(await viaOf(cast.rex.id)).toBe('removal')
    expect(await sessions(cast.rex.id), 'a session survived the removal').toBe(0)
    const [rt] = await sql<{ n: number }[]>`
      select count(*)::int as n from auth.refresh_tokens where user_id = ${cast.rex.id}`
    expect(rt!.n, 'a refresh token survived the removal').toBe(0)
    expect((await bannedUntil(cast.rex.id))!.getTime()).toBeGreaterThan(Date.now() + 365 * 86400_000)

    const c = createClient(url, anonKey, { auth: { persistSession: false } })
    const { error } = await c.auth.signInWithPassword({ email: cast.rex.email, password: PASSWORD })
    expect(error?.message ?? '', 'a removed person signed in').toMatch(/banned/i)

    // His access token from BEFORE the removal is still valid for its hour —
    // and cannot be used to undo or downgrade the removal.
    expect(await rpc(before, 'account_request_deletion', { confirm_email: cast.rex.email }))
      .toMatchObject({ ok: false, reason: 'removed' })
    expect(await rpc(before, 'account_deletion_resume')).toEqual({ cancelled: false })
    expect(await rpc(before, 'account_cancel_deletion', { target: cast.rex.id }))
      .toMatchObject({ ok: false, reason: 'not_authorized' })
    expect(await viaOf(cast.rex.id), 'rex downgraded his removal').toBe('removal')
  })

  it('a superadmin "at the person\'s request" deletion does not overwrite a removal', async () => {
    expect(await rpc(owner, 'account_request_deletion_for_email', { target_email: cast.rex.email }))
      .toMatchObject({ ok: false, reason: 'removed' })
    expect(await viaOf(cast.rex.id)).toBe('removal')
  })

  it('a sign-in timestamp after the request cannot cancel it: not live, not on day 30', async () => {
    // Simulate the edge the ban should make impossible: a sign-in recorded after the request.
    await sql`update auth.users set last_sign_in_at = now() + interval '1 minute' where id = ${cast.rex.id}`
    const [live] = await sql<{ p: boolean }[]>`select public.account_pending_departure(${cast.rex.id}) as p`
    expect(live!.p, 'a sign-in timestamp cancelled a removal').toBe(true)
    await makeDue(cast.rex.id)
    await runJob()
    expect(await stateOf(cast.rex.id), 'the daily job cancelled a removal instead of completing it')
      .toMatchObject({ state: 'deleted' })
  })

  it('only a superadmin undoes a removal, and undoing it lifts the ban', async () => {
    expect(await rpc(owner, 'account_remove_from_platform', { target_email: cast.tess.email, category: 'other', note: 'test removal reason' }))
      .toMatchObject({ ok: true })
    expect(await bannedUntil(cast.tess.id), 'CONTROL: tess is banned').not.toBeNull()
    expect(await rpc(owner, 'account_cancel_deletion', { target: cast.tess.id }))
      .toMatchObject({ ok: true, lifted_ban: true })
    expect(await stateOf(cast.tess.id)).toMatchObject({ state: 'cancelled', cancel_reason: 'superadmin' })
    expect(await bannedUntil(cast.tess.id), 'the undo left the ban in place').toBeNull()
    await signIn(cast.tess.email) // throws if still refused
  })

  it('the sole admin of an org is removed anyway (warned); the ban holds while day 30 fails visibly', async () => {
    const r = (await rpc(owner, 'account_remove_from_platform', { target_email: cast.una.email, category: 'other', note: 'test removal reason' })) as {
      ok: boolean
      warnings: string[]
    }
    expect(r.ok, 'removal was refused for a sole admin').toBe(true)
    expect(r.warnings).toEqual(['sole_admin:Removal probe org'])
    expect(await bannedUntil(cast.una.id), 'the ban waited on org housekeeping').not.toBeNull()
    await makeDue(cast.una.id)
    await runJob()
    const s = await stateOf(cast.una.id)
    expect(s?.state, 'a sole-admin silhouette went through').toBe('departed')
    expect(s?.last_error ?? '', 'the failure is not recorded').not.toBe('')
    expect(await bannedUntil(cast.una.id), 'the ban was lost when day 30 failed').not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// "SOMEONE YOU SAID YES TO HAS LEFT" (20261009010000, founder decision
// 2026-10-08). The reveal guard: the answer depends ONLY on the viewer's own
// yes and the target's COMPLETED departure — never on the target's verdict.
//   vic — the viewer; said yes to all four below.
//   xan — said NO to vic.        Deleted.
//   yul — never decided.          Deleted.
//   zed — never decided.          Only in the GRACE period (reversible).
//   wes — said yes back (match).  Deleted — reported via the MATCH path only.
// Account rows are written straight to account_deletions: this function reads
// only `state`, and the silhouette itself is covered above.
// ---------------------------------------------------------------------------
describe('someone you said yes to has left (20261009010000)', () => {
  const who = {} as Record<'vic' | 'xan' | 'yul' | 'zed' | 'wes', Probe>
  const seatOf = {} as Record<keyof typeof who, string>
  let ev = ''
  let liveEv = ''
  let vicLiveSeat = ''
  let xanLiveSeat = ''
  let vic: SupabaseClient

  beforeAll(async () => {
    const a = admin()
    for (const name of ['vic', 'xan', 'yul', 'zed', 'wes'] as const) {
      const email = `interests-${name}-${tag}@demo.local`
      const { data, error } = await a.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true })
      if (error) throw new Error(`createUser ${name}: ${error.message}`)
      who[name] = { id: data.user!.id, email }
      await sql`insert into org_members (org_id, user_id, role, status, accepted_at)
                values (${datingOrg}, ${data.user!.id}, 'member', 'active', now())`
    }
    const [e1] = await sql<{ id: string }[]>`
      insert into sd_events (org_id, name, state) values (${datingOrg}, ${`Interests probe ${tag}`}, 'complete') returning id`
    ev = e1!.id
    const [e2] = await sql<{ id: string }[]>`
      insert into sd_events (org_id, name, state) values (${datingOrg}, ${`Interests live ${tag}`}, 'running') returning id`
    liveEv = e2!.id
    for (const name of Object.keys(who) as (keyof typeof who)[]) {
      const [s] = await sql<{ id: string }[]>`
        insert into sd_participants (org_id, event_id, user_id, status, pool_side)
        values (${datingOrg}, ${ev}, ${who[name].id}, 'registered', ${name === 'vic' ? 'a' : 'b'}) returning id`
      seatOf[name] = s!.id
    }
    const v = seatOf.vic
    await sql`insert into sd_interest (org_id, event_id, rater_participant_id, target_participant_id, verdict) values
              (${datingOrg}, ${ev}, ${v}, ${seatOf.xan}, 'interested'),
              (${datingOrg}, ${ev}, ${v}, ${seatOf.yul}, 'interested'),
              (${datingOrg}, ${ev}, ${v}, ${seatOf.zed}, 'interested'),
              (${datingOrg}, ${ev}, ${v}, ${seatOf.wes}, 'interested'),
              (${datingOrg}, ${ev}, ${seatOf.xan}, ${v}, 'not_interested'),
              (${datingOrg}, ${ev}, ${seatOf.wes}, ${v}, 'interested')`
    // The same yes, in an event that is still RUNNING.
    const [vl] = await sql<{ id: string }[]>`
      insert into sd_participants (org_id, event_id, user_id, status, pool_side)
      values (${datingOrg}, ${liveEv}, ${who.vic.id}, 'registered', 'a') returning id`
    const [xl] = await sql<{ id: string }[]>`
      insert into sd_participants (org_id, event_id, user_id, status, pool_side)
      values (${datingOrg}, ${liveEv}, ${who.xan.id}, 'registered', 'b') returning id`
    vicLiveSeat = vl!.id
    xanLiveSeat = xl!.id
    await sql`insert into sd_interest (org_id, event_id, rater_participant_id, target_participant_id, verdict)
              values (${datingOrg}, ${liveEv}, ${vicLiveSeat}, ${xanLiveSeat}, 'interested')`

    for (const name of ['xan', 'yul', 'wes'] as const) {
      await sql`insert into account_deletions (user_id, state, initiated_via, requested_at, due_at, deleted_at)
                values (${who[name].id}, 'deleted', 'self', now() - interval '31 days', now() - interval '1 day', now())`
    }
    await sql`insert into account_deletions (user_id, state, initiated_via, requested_at, due_at)
              values (${who.zed.id}, 'departed', 'self', now(), now() + interval '30 days')`
    vic = await signIn(who.vic.email)
  }, 60_000)

  afterAll(async () => {
    await sql`delete from sd_events where id in (${ev}, ${liveEv})`
    for (const p of Object.values(who)) {
      const { error } = await admin().auth.admin.deleteUser(p.id)
      expect(error, `hard-deleting probe ${p.email} failed`).toBeNull()
    }
  }, 60_000)

  it('CONTROL: the premise — wes is a match, xan/yul/zed are not', async () => {
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from sd_matches where event_id = ${ev}
        and ${seatOf.vic} in (participant_a_id, participant_b_id)`
    expect(n!.n, 'expected exactly one match (vic–wes)').toBe(1)
  })

  it('a yes to someone who said NO and a yes to someone UNDECIDED get the identical answer', async () => {
    const got = (await rpc(vic, 'sd_my_departed_interests', { check_event_id: ev })) as string[]
    expect(got, 'a no and an undecided were not treated identically').toEqual(expect.arrayContaining([seatOf.xan, seatOf.yul]))
  })

  it('an UNREVEALED match is returned exactly like a no or an undecided (no "they said yes too" leak)', async () => {
    // The event is complete but the organizer has not revealed matches yet.
    const [m] = await sql<{ revealed: boolean }[]>`
      select revealed from sd_matches where event_id = ${ev}
        and ${seatOf.vic} in (participant_a_id, participant_b_id)`
    expect(m!.revealed, 'CONTROL: the vic–wes match starts unrevealed').toBe(false)
    const got = ((await rpc(vic, 'sd_my_departed_interests', { check_event_id: ev })) as string[]).sort()
    expect(got, 'an unrevealed match was singled out by its absence').toEqual([seatOf.xan, seatOf.yul, seatOf.wes].sort())
  })

  it('once REVEALED, the match leaves this list for its own path; the grace period is never reported', async () => {
    await sql`update sd_matches set revealed = true where event_id = ${ev}
              and ${seatOf.vic} in (participant_a_id, participant_b_id)`
    const got = (await rpc(vic, 'sd_my_departed_interests', { check_event_id: ev })) as string[]
    expect(got, 'a revealed match was reported twice').not.toContain(seatOf.wes)
    expect(got, 'a reversible departure leaked to a non-match').not.toContain(seatOf.zed)
    expect(await rpc(vic, 'sd_my_departed_matches', { check_event_id: ev }), 'CONTROL: the match path reports it').toHaveLength(1)
  })

  it('nothing is reported while the event is still running', async () => {
    expect(await rpc(vic, 'sd_my_departed_interests', { check_event_id: liveEv })).toEqual([])
    // CONTROL: the row it would otherwise report exists.
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from sd_interest where event_id = ${liveEv} and verdict = 'interested'`
    expect(n!.n).toBe(1)
  })

  it('only the caller’s OWN yeses: someone else asking about the same event gets nothing', async () => {
    // zed said nothing to anyone, and asks about the event vic's yeses are in.
    const zed = await signIn(who.zed.email)
    expect(await rpc(zed, 'sd_my_departed_interests', { check_event_id: ev })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// RE-SIGNUP BLOCKS (20261009020000, docs/21 §7.12). Its own throwaway cast.
//   kai — removed for abuse; completes day 30; the address is then refused
//         (exact, case and +tag variants, and through an email CHANGE), until a
//         superadmin lifts it with a reason; then a NEW account works, and
//         removing that new account shows the history.
//   mia — removed, then undone during the grace period: her block is lifted.
//   lee — an unrelated account, used for the email-change bypass attempt.
// These go through GoTrue for real (signUp / updateUser), because the
// enforcement is a trigger on auth.users and the message comes from the hook.
// ---------------------------------------------------------------------------
describe('re-signup blocks (20261009020000)', () => {
  const cast = {} as Record<'kai' | 'mia' | 'lee', Probe>
  const created: string[] = [] // accounts made by signUp during the tests
  let owner: SupabaseClient
  const list = async (client: SupabaseClient) =>
    (await rpc(client, 'account_signup_blocks_list')) as {
      id: string; user_id: string | null; category: string; note: string; lifted_at: string | null
      lift_reason: string | null; account_state: string | null; times_blocked: number
    }[]
  const blockOf = async (userId: string) => (await list(owner)).find((b) => b.user_id === userId && !b.lifted_at)
  const trySignUp = async (email: string) => {
    const c = createClient(url, anonKey, { auth: { persistSession: false } })
    const { data, error } = await c.auth.signUp({ email, password: PASSWORD })
    if (data.user?.id) created.push(data.user.id)
    return { error, id: data.user?.id ?? null }
  }

  beforeAll(async () => {
    const a = admin()
    for (const name of ['kai', 'mia', 'lee'] as const) {
      const email = `blocks-${name}-${tag}@demo.local`
      const { data, error } = await a.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true })
      if (error) throw new Error(`createUser ${name}: ${error.message}`)
      cast[name] = { id: data.user!.id, email }
    }
    owner = await signIn('owner@demo.local')
  }, 60_000)

  afterAll(async () => {
    for (const id of [...Object.values(cast).map((p) => p.id), ...created]) {
      const { error } = await admin().auth.admin.deleteUser(id)
      expect(error, `hard-deleting probe ${id} failed`).toBeNull()
    }
    // Blocks are never deleted by the app; these are test rows.
    await sql`delete from account_signup_blocks where note like 'BLOCKS-TEST %'`
  }, 60_000)

  it('a removal now requires a category and a short factual note', async () => {
    expect(await rpc(owner, 'account_remove_from_platform', { target_email: cast.kai.email, category: 'nope', note: 'BLOCKS-TEST long enough' }))
      .toMatchObject({ ok: false, reason: 'bad_category' })
    expect(await rpc(owner, 'account_remove_from_platform', { target_email: cast.kai.email, category: 'other', note: 'short' }))
      .toMatchObject({ ok: false, reason: 'bad_note' })
    expect(await stateOf(cast.kai.id), 'a refused removal left a row').toBeNull()
  })

  it('removing creates a block with the reason; the list shows it and never the address', async () => {
    const r = await rpc(owner, 'account_remove_from_platform', {
      target_email: cast.kai.email, category: 'abuse_or_harassment', note: 'BLOCKS-TEST repeated abusive messages',
    })
    expect(r).toMatchObject({ ok: true, prior_blocks: 0 })
    const b = await blockOf(cast.kai.id)
    expect(b).toMatchObject({ category: 'abuse_or_harassment', note: 'BLOCKS-TEST repeated abusive messages', account_state: 'departed', times_blocked: 1 })
    expect(JSON.stringify(b), 'the list leaked the address or the fingerprint').not.toMatch(/@|fingerprint/)
    // Nobody but a superadmin sees blocks at all.
    const lee = await signIn(cast.lee.email)
    expect(await list(lee)).toEqual([])
  })

  it('during the grace period a lift is refused — "Undo removal" is the action then', async () => {
    const b = await blockOf(cast.kai.id)
    expect(await rpc(owner, 'account_lift_signup_block', { block_id: b!.id, lift_reason: 'BLOCKS-TEST trying too early' }))
      .toMatchObject({ ok: false, reason: 'still_pending' })
  })

  it('after day 30 the address is refused: exact, case and +tag variants, with the already-registered wording', async () => {
    await makeDue(cast.kai.id)
    await runJob()
    expect(await stateOf(cast.kai.id), 'CONTROL: kai was deleted, so the address is free in auth.users').toMatchObject({ state: 'deleted' })
    const [local, domain] = cast.kai.email.split('@')
    for (const variant of [cast.kai.email, cast.kai.email.toUpperCase(), `${local}+again@${domain}`]) {
      const { error, id } = await trySignUp(variant)
      expect(id, `${variant} signed up despite the block`).toBeNull()
      expect(error?.message ?? '', `${variant}: a distinctive message would reveal the removal`).toBe('User already registered')
    }
    // CONTROL: a different address signs up fine, so the refusals above are the block.
    const ok = await trySignUp(`blocks-free-${tag}@demo.local`)
    expect(ok.error, JSON.stringify(ok.error)).toBeNull()
    expect(ok.id).not.toBeNull()
  })

  it('an email CHANGE to the blocked address is refused too (the creation hook alone would miss it)', async () => {
    const lee = await signIn(cast.lee.email)
    const { error } = await lee.auth.updateUser({ email: cast.kai.email })
    expect(error, 'lee took over a removed person\'s address').not.toBeNull()
    const [u] = await sql<{ email: string; email_change: string }[]>`
      select email, coalesce(email_change, '') as email_change from auth.users where id = ${cast.lee.id}`
    expect(u!.email).toBe(cast.lee.email)
    expect(u!.email_change).toBe('')
  })

  it('only the address being SET is judged: an account whose current address matches a block can still move off it', async () => {
    // A false-positive shape (e.g. a +tag host without subaddressing): lee's OWN
    // current address matches a block that is not lee's.
    await sql`insert into account_signup_blocks (email_fingerprint, category, note)
              values (account_email_fingerprint(${cast.lee.email}), 'other', 'BLOCKS-TEST false positive on lee')`
    const lee = await signIn(cast.lee.email)
    const { error } = await lee.auth.updateUser({ email: `blocks-lee-moved-${tag}@demo.local` })
    expect(error, `lee could not move off a blocked current address: ${JSON.stringify(error)}`).toBeNull()
    await sql`delete from account_signup_blocks where note = 'BLOCKS-TEST false positive on lee'`
  })

  it('a lookup by typed address finds it, and every lookup is logged; others get nothing and leave no log', async () => {
    const before = (await sql<{ n: number }[]>`select count(*)::int as n from account_signup_block_lookups`)[0]!.n
    const ids = (await rpc(owner, 'account_signup_block_lookup', { target_email: cast.kai.email.toUpperCase() })) as string[]
    expect(ids).toContain((await list(owner)).find((b) => b.user_id === cast.kai.id)!.id)
    const lee = await signIn(cast.lee.email)
    expect(await rpc(lee, 'account_signup_block_lookup', { target_email: cast.kai.email })).toEqual([])
    const after = (await sql<{ n: number }[]>`select count(*)::int as n from account_signup_block_lookups`)[0]!.n
    expect(after - before, 'exactly the superadmin lookup was logged').toBe(1)
  })

  it('the hook and the fingerprint are not callable by an ordinary user (no "was X removed?" oracle)', async () => {
    const lee = await signIn(cast.lee.email)
    const hook = await lee.rpc('auth_before_user_created', { event: { user: { email: cast.kai.email } } })
    expect(hook.error, 'an ordinary user can call the signup hook').not.toBeNull()
    const fp = await lee.rpc('account_email_fingerprint', { addr: cast.kai.email })
    expect(fp.error, 'an ordinary user can compute fingerprints').not.toBeNull()
  })

  it('a superadmin lifts it with a reason; then a NEW account can be made, and removing it shows the history', async () => {
    const b = (await list(owner)).find((x) => x.user_id === cast.kai.id && !x.lifted_at)!
    expect(await rpc(owner, 'account_lift_signup_block', { block_id: b.id, lift_reason: 'short' }))
      .toMatchObject({ ok: false, reason: 'bad_reason' })
    const lee = await signIn(cast.lee.email)
    expect(await rpc(lee, 'account_lift_signup_block', { block_id: b.id, lift_reason: 'BLOCKS-TEST not my call' }))
      .toMatchObject({ ok: false, reason: 'not_authorized' })
    expect(await rpc(owner, 'account_lift_signup_block', { block_id: b.id, lift_reason: 'BLOCKS-TEST appeal received and accepted' }))
      .toMatchObject({ ok: true })

    const fresh = await trySignUp(cast.kai.email)
    expect(fresh.error, `the lifted address still cannot sign up: ${JSON.stringify(fresh.error)}`).toBeNull()
    expect(fresh.id, 'a lift must give a NEW account, never the old one back').not.toBe(cast.kai.id)

    const again = await rpc(owner, 'account_remove_from_platform', {
      target_email: cast.kai.email, category: 'spam_or_fraud', note: 'BLOCKS-TEST back and spamming',
    })
    expect(again, 'the history was not reported at removal time').toMatchObject({ ok: true, prior_blocks: 1 })
    expect((await list(owner)).find((x) => x.user_id === fresh.id && !x.lifted_at)?.times_blocked).toBe(2)
    // The old, lifted row is kept, with who/why.
    expect((await list(owner)).find((x) => x.id === b.id)).toMatchObject({ lift_reason: 'BLOCKS-TEST appeal received and accepted' })
  })

  it('undoing a removal during the grace period lifts THAT removal\'s block, and only it', async () => {
    expect(await rpc(owner, 'account_remove_from_platform', {
      target_email: cast.mia.email, category: 'other', note: 'BLOCKS-TEST removed by mistake',
    })).toMatchObject({ ok: true })
    const mine = await blockOf(cast.mia.id)
    expect(mine, 'CONTROL: mia has an active block').toBeTruthy()
    const otherActive = (await list(owner)).filter((x) => x.user_id !== cast.mia.id && !x.lifted_at).length
    expect(await rpc(owner, 'account_cancel_deletion', { target: cast.mia.id })).toMatchObject({ ok: true, lifted_ban: true })
    expect((await list(owner)).find((x) => x.id === mine!.id)).toMatchObject({ lift_reason: 'Removal undone before the account was deleted.' })
    expect((await list(owner)).filter((x) => x.user_id !== cast.mia.id && !x.lifted_at).length, 'undo lifted someone else\'s block')
      .toBe(otherActive)
  })
})
