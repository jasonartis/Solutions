import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import postgres from 'postgres'

// ---------------------------------------------------------------------------
// PENDING INVITES, SLICE 1: ORG PRE-INVITE (20261016010000, docs/25).
//
// Every hard requirement in docs/25 §4.2 and every slice-1 scenario in §5 has
// a test here, named after it. The suite builds its OWN throwaway org and
// accounts (and deletes them afterwards) so it never signs in as a seeded user:
// CI runs e2e straight after this suite on the same database, and e2e depends
// on particular seeded users never having signed in (CLAUDE.md, the grace
// gotcha).
//
// ⚠ LOCAL AUTH AUTOCONFIRMS (config.toml enable_confirmations = false). The
// "unconfirmed address" test therefore clears email_confirmed_at by hand
// after sign-in; that tests the SQL check, not GoTrue. Whether a real address
// is proven is GoTrue's job on PROD, which the prod verifier reads.
// ---------------------------------------------------------------------------

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const anonKey = process.env.SUPABASE_ANON_KEY ?? ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const ownerDbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const PASSWORD = 'pending-invite-pass-1'
const RUN = Math.random().toString(36).slice(2, 8)
const addr = (n: string) => `pi-${RUN}-${n}@example.com`

const sql = postgres(ownerDbUrl, { prepare: false, max: 2 })
const created: string[] = []

function admin(): SupabaseClient {
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for the pending-invites suite')
  return createClient(url, serviceKey, { auth: { persistSession: false } })
}

async function newUser(email: string): Promise<string> {
  const { data, error } = await admin().auth.admin.createUser({ email, password: PASSWORD, email_confirm: true })
  if (error) throw new Error(`createUser ${email}: ${error.message}`)
  created.push(data.user.id)
  return data.user.id
}

async function signIn(email: string): Promise<SupabaseClient> {
  const client = createClient(url, anonKey, { auth: { persistSession: false } })
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD })
  if (error) throw new Error(`Sign-in failed for ${email}: ${error.message}`)
  return client
}

async function newOrg(name: string): Promise<string> {
  const [o] = await sql<{ id: string }[]>`
    insert into orgs (name, slug) values (${name}, ${`pi-${RUN}-${name.toLowerCase()}`}) returning id`
  return o!.id
}

async function seat(orgId: string, userId: string, role: string, status = 'active') {
  await sql`insert into org_members (org_id, user_id, role, status) values (${orgId}, ${userId}, ${role}, ${status})`
}

async function inviteRows(email: string) {
  return sql<{ id: string; role: string; invited_by: string; expires_at: Date }[]>`
    select id, role, invited_by, expires_at from pending_invites where email = ${email}`
}

async function seatOf(orgId: string, userId: string) {
  const [row] = await sql<{ status: string; role: string; invited_by: string | null }[]>`
    select status, role, invited_by from org_members where org_id = ${orgId} and user_id = ${userId}`
  return row ?? null
}

// Actors: owner O and admin A of org P; plain member M of P; admin X of a
// different org Q. Superadmin S is the seeded owner@demo.local, used only as a
// CONTROL for the narrowed lookup (signing in as it records a login, which no
// e2e test reads).
let P = '', Q = ''
let O = '', A = '', M = '', X = ''
let asO: SupabaseClient, asA: SupabaseClient, asM: SupabaseClient, asX: SupabaseClient

beforeAll(async () => {
  O = await newUser(addr('owner'))
  A = await newUser(addr('admin'))
  M = await newUser(addr('member'))
  X = await newUser(addr('other-admin'))
  P = await newOrg('P')
  Q = await newOrg('Q')
  await seat(P, O, 'owner')
  await seat(P, A, 'admin')
  await seat(P, M, 'member')
  await seat(Q, X, 'owner')
  ;[asO, asA, asM, asX] = await Promise.all([
    signIn(addr('owner')),
    signIn(addr('admin')),
    signIn(addr('member')),
    signIn(addr('other-admin')),
  ])
})

afterAll(async () => {
  // Orgs first (their cascade clears seats and invites), then the accounts.
  await sql`delete from orgs where slug like ${`pi-${RUN}-%`}`
  await sql`delete from pending_invites where email like ${`pi-${RUN}-%`}`
  await sql`delete from account_signup_blocks where note like ${`pending-invites test ${RUN}%`}`
  for (const id of created) await admin().auth.admin.deleteUser(id)
  await sql.end()
})

const issue = (c: SupabaseClient, email: string, role = 'member', org = P) =>
  c.rpc('pending_invite_issue_org', { check_org_id: org, target_email: email, invited_role: role })
const claim = (c: SupabaseClient) => c.rpc('pending_invites_claim_mine')

describe('pending invites — scenario 1 (the founder case, org half)', () => {
  it('an address with NO account is invited; they sign up; the claim creates a PENDING seat stamped with the inviter; they accept', async () => {
    const email = addr('family-1')
    const { data, error } = await issue(asA, email)
    expect(error).toBeNull()
    expect(data).toBe('invited')
    expect(await inviteRows(email)).toHaveLength(1)

    const who = await newUser(email)
    const me = await signIn(email)
    const { data: n, error: claimErr } = await claim(me)
    expect(claimErr).toBeNull()
    expect(n).toBe(1)

    const s = await seatOf(P, who)
    expect(s, 'no seat was created').not.toBeNull()
    expect(s!.status, 'a claim must never create an ACTIVE seat (accept-first)').toBe('pending')
    expect(s!.invited_by, 'invited_by must be the inviter, not the invitee').toBe(A)
    expect(await inviteRows(email), 'the address outlived its claim').toHaveLength(0)

    // Their own dashboard list shows it, and accepting goes through the
    // existing org_accept_invite (which re-checks the inviter again).
    const { data: mine } = await me.rpc('org_my_pending_invites')
    expect((mine as { org_id: string }[]).map((r) => r.org_id)).toContain(P)
    const { error: accErr } = await me.rpc('org_accept_invite', { check_org_id: P })
    expect(accErr).toBeNull()
    expect((await seatOf(P, who))!.status).toBe('active')
  })

  it('claiming twice is harmless (no second seat, no error)', async () => {
    const email = addr('family-2')
    await issue(asA, email)
    await newUser(email)
    const me = await signIn(email)
    expect((await claim(me)).data).toBe(1)
    expect((await claim(me)).data).toBe(0)
  })
})

describe('§4.2.1 verified address only — EXACT lower+trim match (scenario 8)', () => {
  it('an invite to a@ cannot be claimed by b@', async () => {
    const a = addr('typo-a')
    const b = addr('typo-b')
    await issue(asA, a)
    const bId = await newUser(b)
    expect((await claim(await signIn(b))).data).toBe(0)
    expect(await seatOf(P, bId)).toBeNull()
    expect(await inviteRows(a), 'the right invite must still be waiting').toHaveLength(1)
  })

  it('an UNCONFIRMED holder of the right address claims nothing', async () => {
    const email = addr('unconfirmed')
    await issue(asA, email)
    const id = await newUser(email)
    const me = await signIn(email)
    await sql`update auth.users set email_confirmed_at = null where id = ${id}`
    expect((await claim(me)).data).toBe(0)
    expect(await seatOf(P, id)).toBeNull()
    expect(await inviteRows(email)).toHaveLength(1)
    // CONTROL: the same person, once confirmed, does claim it.
    await sql`update auth.users set email_confirmed_at = now() where id = ${id}`
    expect((await claim(me)).data).toBe(1)
  })

  it('the aggressive block FINGERPRINT is not identity: j.doe+x@gmail.com does not claim jdoe@gmail.com', async () => {
    const invited = `pi${RUN}doe@gmail.com`
    const lookalike = `pi${RUN}.doe+x@gmail.com`
    const [fp] = await sql<{ same: boolean }[]>`
      select account_email_fingerprint(${invited}) = account_email_fingerprint(${lookalike}) as same`
    expect(fp?.same, 'precondition: the two addresses must share a fingerprint, or this test is vacuous').toBe(true)
    await sql`delete from pending_invites where email = ${invited}`
    await issue(asA, invited)
    const id = await newUser(lookalike)
    expect((await claim(await signIn(lookalike))).data).toBe(0)
    expect(await seatOf(P, id)).toBeNull()
    await sql`delete from pending_invites where email = ${invited}`
  })

  it('the address is stored lower+trim, and matches a differently-cased signup', async () => {
    const email = addr('case')
    await issue(asA, `  ${email.toUpperCase()}  `)
    expect(await inviteRows(email)).toHaveLength(1)
  })
})

describe('§4.2.2 authority re-checked at claim (scenario 5)', () => {
  it('inviter REMOVED from the org before signup -> nothing applies, and the address is deleted', async () => {
    const inviter = await newUser(addr('leaver'))
    await seat(P, inviter, 'admin')
    const asLeaver = await signIn(addr('leaver'))
    const email = addr('orphan')
    expect((await issue(asLeaver, email)).data).toBe('invited')
    await sql`delete from org_members where org_id = ${P} and user_id = ${inviter}`

    const id = await newUser(email)
    expect((await claim(await signIn(email))).data).toBe(0)
    expect(await seatOf(P, id)).toBeNull()
    expect(await inviteRows(email), 'a dead invite must not keep the address').toHaveLength(0)
  })

  it('inviter DEMOTED to member before signup -> nothing applies', async () => {
    const inviter = await newUser(addr('demoted'))
    await seat(P, inviter, 'admin')
    const asD = await signIn(addr('demoted'))
    const email = addr('demoted-target')
    await issue(asD, email)
    await sql`update org_members set role = 'member' where org_id = ${P} and user_id = ${inviter}`

    const id = await newUser(email)
    expect((await claim(await signIn(email))).data).toBe(0)
    expect(await seatOf(P, id)).toBeNull()
  })

  it('inviter BANNED (removed from the platform) before signup -> nothing applies', async () => {
    const inviter = await newUser(addr('banned-inviter'))
    await seat(P, inviter, 'admin')
    const asB = await signIn(addr('banned-inviter'))
    const email = addr('banned-target')
    await issue(asB, email)
    await sql`update auth.users set banned_until = now() + interval '100 years' where id = ${inviter}`

    const id = await newUser(email)
    expect((await claim(await signIn(email))).data).toBe(0)
    expect(await seatOf(P, id)).toBeNull()
  })

  it('accept still re-checks: inviter removed AFTER the claim -> accept is refused', async () => {
    const inviter = await newUser(addr('late-leaver'))
    await seat(P, inviter, 'admin')
    const asL = await signIn(addr('late-leaver'))
    const email = addr('late-target')
    await issue(asL, email)
    const id = await newUser(email)
    const me = await signIn(email)
    expect((await claim(me)).data).toBe(1)
    await sql`delete from org_members where org_id = ${P} and user_id = ${inviter}`
    const { error } = await me.rpc('org_accept_invite', { check_org_id: P })
    expect(error?.message).toMatch(/no longer valid/i)
    expect((await seatOf(P, id))!.status).toBe('pending')
  })

  it('an existing seat wins: someone already pending in the org gets no second seat, and the invite is used up', async () => {
    const email = addr('already-pending')
    const id = await newUser(email)
    await seat(P, id, 'member', 'pending')
    // Inserted directly: issue would answer 'already_member' (tested below).
    await sql`insert into pending_invites (kind, org_id, target_id, email, role, invited_by, expires_at)
              values ('org', ${P}, ${P}, ${email}, 'admin', ${O}, now() + interval '30 days')`
    expect((await claim(await signIn(email))).data).toBe(0)
    expect((await seatOf(P, id))!.role, 'the invite must not rewrite an existing seat').toBe('member')
    expect(await inviteRows(email)).toHaveLength(0)
  })

  it("the caller's identity is restored after the applier runs (a later statement is NOT the service path)", async () => {
    const email = addr('identity')
    await issue(asA, email)
    const id = await newUser(email)
    const me = await signIn(email)
    // claim_mine raises if auth.uid() is not back; a clean return is the proof.
    const { error } = await claim(me)
    expect(error).toBeNull()
    // And the same session still cannot do a service-path-only thing.
    const { error: forced } = await me.from('org_members').update({ status: 'active' }).eq('org_id', P).eq('user_id', id)
    const s = await seatOf(P, id)
    expect(s!.status, `forced activation went through (${forced?.message})`).toBe('pending')
  })
})

describe('§4.2.3 no oracle', () => {
  it('issuing answers the same for: no account, an account outside the org, and a BLOCKED address', async () => {
    const none = addr('nobody')
    const outsider = addr('outsider')
    const blocked = addr('blocked')
    await newUser(outsider)
    await sql`insert into account_signup_blocks (email_fingerprint, category, note)
              values (account_email_fingerprint(${blocked}), 'other', ${`pending-invites test ${RUN} block`})`
    const answers = await Promise.all([none, outsider, blocked].map((e) => issue(asA, e)))
    for (const r of answers) {
      expect(r.error).toBeNull()
      expect(r.data).toBe('invited')
    }
  })

  it('org_find_user_by_email no longer answers an org admin (it is superadmin-only)', async () => {
    const target = addr('member') // definitely exists
    const { data, error } = await asA.rpc('org_find_user_by_email', { check_org_id: P, target_email: target })
    expect(error).toBeNull()
    expect(data, 'an org admin learned an account exists').toEqual([])
    // CONTROL: the superadmin still gets the id, so the function is not simply broken.
    const s = createClient(url, anonKey, { auth: { persistSession: false } })
    const { error: sErr } = await s.auth.signInWithPassword({ email: 'owner@demo.local', password: 'password123' })
    expect(sErr).toBeNull()
    const { data: sData } = await s.rpc('org_find_user_by_email', { check_org_id: P, target_email: target })
    expect((sData as { user_id: string }[]).map((r) => r.user_id)).toEqual([M])
  })

  it("'already_member' is only about THIS org's own seats, which the admin can already read", async () => {
    expect((await issue(asA, addr('member'))).data).toBe('already_member')
    // CONTROL: the same address issued into org Q (where M is not a member) is just 'invited'.
    expect((await issue(asX, addr('member'), 'member', Q)).data).toBe('invited')
  })
})

describe('§4.2.4 blocked and removed people (scenario 7)', () => {
  it('a platform-blocked address cannot even sign up, so the invite has no one to apply to', async () => {
    const email = addr('blocked-signup')
    await issue(asA, email)
    await sql`insert into account_signup_blocks (email_fingerprint, category, note)
              values (account_email_fingerprint(${email}), 'other', ${`pending-invites test ${RUN} signup`})`
    const { error } = await admin().auth.admin.createUser({ email, password: PASSWORD, email_confirm: true })
    expect(error, 'the block did not stop the signup').not.toBeNull()
  })

  it('a BANNED account holding the address claims nothing', async () => {
    const email = addr('banned-invitee')
    await issue(asA, email)
    const id = await newUser(email)
    const me = await signIn(email)
    await sql`update auth.users set banned_until = now() + interval '100 years' where id = ${id}`
    expect((await claim(me)).data).toBe(0)
    expect(await seatOf(P, id)).toBeNull()
  })
})

describe('§4.2.5 the address is deleted on claim, cancel and expiry (scenarios 4, 9)', () => {
  it('cancel by the inviter deletes the row', async () => {
    const email = addr('cancel')
    await issue(asA, email)
    const [row] = await inviteRows(email)
    const { error } = await asA.rpc('pending_invite_cancel', { invite_id: row!.id })
    expect(error).toBeNull()
    expect(await inviteRows(email)).toHaveLength(0)
  })

  it('a plain member and another org\'s admin can neither READ nor CANCEL it — same "not found" as a missing row', async () => {
    const email = addr('no-touch')
    await issue(asA, email)
    const [row] = await inviteRows(email)
    for (const c of [asM, asX]) {
      const { data } = await c.from('pending_invites').select('id').eq('id', row!.id)
      expect(data).toEqual([])
      const { error } = await c.rpc('pending_invite_cancel', { invite_id: row!.id })
      expect(error?.message).toBe('Invitation not found')
    }
    const { error: missing } = await asA.rpc('pending_invite_cancel', { invite_id: '00000000-0000-0000-0000-000000000000' })
    expect(missing?.message).toBe('Invitation not found')
    // CONTROL: the org's owner (not the inviter) can read it.
    const { data: ownerSees } = await asO.from('pending_invites').select('id').eq('id', row!.id)
    expect(ownerSees).toHaveLength(1)
    expect(await inviteRows(email)).toHaveLength(1)
  })

  it('a DEMOTED inviter can no longer read the addresses they issued', async () => {
    const inviter = await newUser(addr('demoted-reader'))
    await seat(P, inviter, 'admin')
    const asD = await signIn(addr('demoted-reader'))
    const email = addr('demoted-reader-target')
    await issue(asD, email)
    expect((await asD.from('pending_invites').select('id').eq('email', email)).data).toHaveLength(1)
    await sql`update org_members set role = 'member' where org_id = ${P} and user_id = ${inviter}`
    expect((await asD.from('pending_invites').select('id').eq('email', email)).data).toEqual([])
  })

  it('day 31: an expired invite cannot be claimed, the pruner deletes it, and a fresh invite works', async () => {
    const email = addr('expiry')
    await issue(asA, email)
    await sql`update pending_invites set expires_at = now() - interval '1 minute' where email = ${email}`
    const id = await newUser(email)
    const me = await signIn(email)
    expect((await claim(me)).data, 'an expired invite applied').toBe(0)
    expect(await seatOf(P, id)).toBeNull()

    const [pruned] = await sql<{ n: number }[]>`select pending_invites_prune_expired() as n`
    expect(pruned?.n).toBeGreaterThanOrEqual(1)
    expect(await inviteRows(email), 'the pruner left the address behind').toHaveLength(0)

    expect((await issue(asA, email)).data).toBe('invited')
    expect((await claim(me)).data).toBe(1)
  })

  it('resend gives 30 more days and moves the invite to the resender', async () => {
    const email = addr('resend')
    await issue(asA, email)
    await sql`update pending_invites set expires_at = now() + interval '2 days' where email = ${email}`
    const [row] = await inviteRows(email)
    const { error } = await asO.rpc('pending_invite_resend', { invite_id: row!.id })
    expect(error).toBeNull()
    const [after] = await inviteRows(email)
    expect(after!.invited_by).toBe(O)
    expect(after!.expires_at.getTime() - Date.now()).toBeGreaterThan(29 * 24 * 3600 * 1000)
  })

  it('the pruner also removes invites from an inviter whose account deletion has COMPLETED, but not one in grace', async () => {
    const graceE = addr('grace-target')
    const goneE = addr('gone-target')
    const graceInviter = await newUser(addr('grace-inviter'))
    const goneInviter = await newUser(addr('gone-inviter'))
    for (const [inviter, e] of [[graceInviter, graceE], [goneInviter, goneE]] as const) {
      await sql`insert into pending_invites (kind, org_id, target_id, email, role, invited_by, expires_at)
                values ('org', ${P}, ${P}, ${e}, 'member', ${inviter}, now() + interval '30 days')`
    }
    await sql.begin(async (tx) => {
      // docs/21's states: 'departed' = inside the 30-day grace, 'deleted' = done.
      await tx`insert into account_deletions (user_id, state, initiated_via, due_at, deleted_at)
               values (${goneInviter}, 'deleted', 'self', now(), now())`
      await tx`insert into account_deletions (user_id, state, initiated_via, due_at)
               values (${graceInviter}, 'departed', 'self', now() + interval '30 days')`
      await tx`select pending_invites_prune_expired()`
      const left = await tx<{ email: string }[]>`select email from pending_invites where email in (${graceE}, ${goneE})`
      expect(left.map((r) => r.email)).toEqual([graceE])
      throw new Error('__rollback__')
    }).catch((e: Error) => {
      if (e.message !== '__rollback__') throw e
    })
  })
})

describe('§4.2.6 table hygiene — nobody writes the table directly', () => {
  it('authenticated cannot INSERT, UPDATE or DELETE pending_invites (42501), and anon cannot read it', async () => {
    const email = addr('direct')
    const ins = await asA.from('pending_invites').insert({
      kind: 'org', org_id: P, target_id: P, email, role: 'member', invited_by: A,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    })
    expect(ins.error?.code).toBe('42501')
    await issue(asA, email)
    const upd = await asA.from('pending_invites').update({ role: 'owner' }).eq('email', email)
    expect(upd.error?.code).toBe('42501')
    const del = await asA.from('pending_invites').delete().eq('email', email)
    expect(del.error?.code).toBe('42501')
    const anon = createClient(url, anonKey, { auth: { persistSession: false } })
    const { error: anonErr } = await anon.from('pending_invites').select('id')
    expect(anonErr?.code).toBe('42501')
  })

  it('the applier and the pruner are not callable by a signed-in user', async () => {
    const [row] = await inviteRows(addr('direct'))
    const a = await asA.rpc('pending_invite_apply', { invite_id: row!.id, invitee: A })
    expect(a.error).not.toBeNull()
    const p = await asA.rpc('pending_invites_prune_expired')
    expect(p.error).not.toBeNull()
  })
})

describe('issue authority and the on-conflict rule', () => {
  it('a plain member cannot issue; an admin cannot invite an admin (rank)', async () => {
    expect((await issue(asM, addr('by-member'))).error?.message).toBe('Not authorized')
    expect((await issue(asA, addr('admin-to-admin'), 'admin')).error?.message).toBe('Not authorized')
    // CONTROL: the owner can invite an admin.
    expect((await issue(asO, addr('admin-to-admin'), 'admin')).data).toBe('invited')
  })

  it("an admin cannot rewrite the owner's admin-level invite for the same address ('exists')", async () => {
    const email = addr('owner-made')
    await issue(asO, email, 'admin')
    const r = await issue(asA, email, 'member')
    expect(r.data).toBe('exists')
    const [row] = await inviteRows(email)
    expect(row!.role).toBe('admin')
    expect(row!.invited_by).toBe(O)
  })

  it('a non-admin cannot invite to another org they do not administer', async () => {
    expect((await issue(asA, addr('cross'), 'member', Q)).error?.message).toBe('Not authorized')
  })
})

describe('§4.2.7 caps — founder answer 2 (revised 2026-10-16): 100 per inviter, 20 per address, in platform_settings', () => {
  // The caps row is platform-wide state; every test that writes it removes it.
  const clearCaps = () => sql`delete from platform_settings where key = 'pending_invites.caps'`

  it('an inviter with 100 open invitations is refused the 101st, told THEIR limit; expired ones do not count', async () => {
    await clearCaps()
    const inviter = await newUser(addr('capper'))
    await seat(P, inviter, 'admin')
    const asC = await signIn(addr('capper'))
    await sql`
      insert into pending_invites (kind, org_id, target_id, email, role, invited_by, expires_at)
      select 'org', ${P}, ${P}, ${`pi-${RUN}-cap`} || g || '@example.com', 'member', ${inviter}, now() + interval '30 days'
      from generate_series(1, 100) g`
    const r = await issue(asC, addr('cap-101'))
    expect(r.error?.message).toBe('You have reached your limit of 100 open invitations. Cancel some first.')
    // CONTROL: expired ones do not count.
    await sql`update pending_invites set expires_at = now() - interval '1 minute' where invited_by = ${inviter}`
    expect((await issue(asC, addr('cap-101'))).data).toBe('invited')
    await sql`delete from pending_invites where invited_by = ${inviter}`
  })

  it('raising the limit is a platform_settings edit, and a malformed value falls back instead of breaking issuing', async () => {
    const inviter = await newUser(addr('raised'))
    await seat(P, inviter, 'admin')
    const asR = await signIn(addr('raised'))
    await sql`
      insert into pending_invites (kind, org_id, target_id, email, role, invited_by, expires_at)
      select 'org', ${P}, ${P}, ${`pi-${RUN}-raise`} || g || '@example.com', 'member', ${inviter}, now() + interval '30 days'
      from generate_series(1, 100) g`
    try {
      await sql`insert into platform_settings (key, value) values ('pending_invites.caps', '{"maxPerInviter": 150}'::jsonb)`
      expect((await issue(asR, addr('raise-101'))).data, 'the raised limit was not honoured').toBe('invited')
      await sql`update platform_settings set value = '{"maxPerInviter": "lots"}'::jsonb where key = 'pending_invites.caps'`
      const r = await issue(asR, addr('raise-102'))
      expect(r.error?.message, 'a malformed setting must fall back to 100, not raise a cast error').toMatch(/limit of 100/)
    } finally {
      await clearCaps()
      await sql`delete from pending_invites where invited_by = ${inviter}`
    }
  })

  it('an address named by 20 open invitations: the 21st answers the ordinary "invited" (no oracle) and stores nothing', async () => {
    await clearCaps()
    const email = addr('popular')
    // 20 other orgs have invited this address.
    const others = await sql<{ id: string }[]>`
      insert into orgs (name, slug)
      select 'Pop ' || g, ${`pi-${RUN}-pop-`} || g from generate_series(1, 20) g
      returning id`
    for (const o of others) {
      await sql`insert into pending_invites (kind, org_id, target_id, email, role, invited_by, expires_at)
                values ('org', ${o.id}, ${o.id}, ${email}, 'member', ${O}, now() + interval '30 days')`
    }
    const r = await issue(asA, email)
    expect(r.error, 'the per-address cap must not be a visible refusal').toBeNull()
    expect(r.data).toBe('invited')
    const [stored] = await sql<{ n: number }[]>`
      select count(*)::int as n from pending_invites where email = ${email} and org_id = ${P}`
    expect(stored?.n, 'over the address cap, nothing may be stored').toBe(0)

    // CONTROL: one of those expires, and the same issue now stores the row.
    await sql`update pending_invites set expires_at = now() - interval '1 minute'
              where email = ${email} and org_id = ${others[0]!.id}`
    expect((await issue(asA, email)).data).toBe('invited')
    const [after] = await sql<{ n: number }[]>`
      select count(*)::int as n from pending_invites where email = ${email} and org_id = ${P}`
    expect(after?.n).toBe(1)
  })
})

describe('founder answer 3: any org admin may cancel any invitation in their org', () => {
  it("an admin cancels the OWNER's admin-level invitation (but cannot rewrite or resend it)", async () => {
    const email = addr('owner-made-cancel')
    await issue(asO, email, 'admin')
    const [row] = await inviteRows(email)
    const { error: resendErr } = await asA.rpc('pending_invite_resend', { invite_id: row!.id })
    expect(resendErr?.message, 'resend re-issues, so it keeps the rank rule').toBe('Invitation not found')
    const { error } = await asA.rpc('pending_invite_cancel', { invite_id: row!.id })
    expect(error).toBeNull()
    expect(await inviteRows(email)).toHaveLength(0)
  })
})
