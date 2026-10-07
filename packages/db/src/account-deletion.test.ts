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
