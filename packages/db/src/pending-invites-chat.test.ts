import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import postgres from 'postgres'

// ---------------------------------------------------------------------------
// PENDING INVITES, SLICE 2: CHAT PRE-INVITE + A MODULE ROLE ON AN ORG INVITE
// (20261018020000, docs/25 §12).
//
// One test per slice-2 requirement and per §5 scenario it touches (1, 2, 3, 5,
// 6, 4, 9), plus one per adversarial-review finding, named after it. Like the
// slice-1 suite it builds its OWN org and accounts and never signs in as a
// seeded user (CI runs e2e straight after this suite on the same database).
// ---------------------------------------------------------------------------

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const anonKey = process.env.SUPABASE_ANON_KEY ?? ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const ownerDbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const PASSWORD = 'pending-chat-pass-1'
const RUN = Math.random().toString(36).slice(2, 8)
const addr = (n: string) => `pc-${RUN}-${n}@example.com`
const VM = 'visual-messaging'

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
    insert into orgs (name, slug) values (${name}, ${`pc-${RUN}-${name.toLowerCase()}`}) returning id`
  await sql`insert into org_modules (org_id, module_key) values (${o!.id}, ${VM})`
  return o!.id
}

const seat = (orgId: string, userId: string, role: string, status = 'active') =>
  sql`insert into org_members (org_id, user_id, role, status) values (${orgId}, ${userId}, ${role}, ${status})`
const vmRole = (orgId: string, userId: string, role = 'member') =>
  sql`insert into module_roles (org_id, user_id, module_key, role) values (${orgId}, ${userId}, ${VM}, ${role})`

async function newConversation(orgId: string, creator: string, title: string): Promise<string> {
  const [c] = await sql<{ id: string }[]>`
    insert into vm_conversations (org_id, title, created_by) values (${orgId}, ${title}, ${creator}) returning id`
  await sql`insert into vm_conversation_members (org_id, conversation_id, user_id, role, status)
            values (${orgId}, ${c!.id}, ${creator}, 'admin', 'active')`
  return c!.id
}

const rows = (email: string) =>
  sql<{ id: string; kind: string; invited_by: string; target_id: string; claimed_by: string | null }[]>`
    select id, kind, invited_by, target_id, claimed_by from pending_invites where email = ${email} order by kind`
const convSeat = async (conv: string, userId: string) =>
  (await sql<{ status: string; role: string; invited_by: string | null; self_blocked: boolean }[]>`
    select status, role, invited_by, self_blocked from vm_conversation_members
    where conversation_id = ${conv} and user_id = ${userId}`)[0] ?? null
const orgSeat = async (orgId: string, userId: string) =>
  (await sql<{ status: string }[]>`select status from org_members where org_id = ${orgId} and user_id = ${userId}`)[0] ?? null
const hasVmRole = async (orgId: string, userId: string, role = 'member') =>
  (await sql`select 1 from module_roles where org_id = ${orgId} and user_id = ${userId}
             and module_key = ${VM} and role = ${role} and scope_ref is null`).length === 1

const issueVm = (c: SupabaseClient, conv: string, email: string) =>
  c.rpc('pending_invite_issue_vm', { check_conversation_id: conv, target_email: email })
const issueOrg = (c: SupabaseClient, email: string, opts: { role?: string; moduleRole?: string; org?: string } = {}) =>
  c.rpc('pending_invite_issue_org', {
    check_org_id: opts.org ?? P,
    target_email: email,
    invited_role: opts.role ?? 'member',
    ...(opts.moduleRole ? { with_module_key: VM, with_module_role: opts.moduleRole } : {}),
  })
const claim = (c: SupabaseClient) => c.rpc('pending_invites_claim_mine')
const list = (c: SupabaseClient, org: string, target?: string) =>
  c.rpc('pending_invites_list', { check_org_id: org, ...(target ? { check_target_id: target } : {}) })

// Actors in org P (visual-messaging enabled):
//   O  owner
//   K  a CHAT MAKER: plain org member with the vm 'member' role, admin of conversation C only
//   K2 another plain vm member, also admin of C (a co-admin who did not issue)
//   E  an existing plain vm member (an ordinary would-be invitee)
//   N  plain org member WITHOUT the vm role
// X  owner of a different org Q.
let P = '', Q = '', C = ''
let O = '', K = '', K2 = '', E = '', N = '', X = ''
let asO: SupabaseClient, asK: SupabaseClient, asK2: SupabaseClient, asE: SupabaseClient, asX: SupabaseClient

beforeAll(async () => {
  ;[O, K, K2, E, N, X] = await Promise.all([
    newUser(addr('owner')),
    newUser(addr('maker')),
    newUser(addr('coadmin')),
    newUser(addr('existing')),
    newUser(addr('norole')),
    newUser(addr('other')),
  ])
  P = await newOrg('P')
  Q = await newOrg('Q')
  await seat(P, O, 'owner')
  for (const u of [K, K2, E, N]) await seat(P, u, 'member')
  for (const u of [K, K2, E]) await vmRole(P, u)
  await seat(Q, X, 'owner')
  C = await newConversation(P, K, 'Family sketch')
  await sql`insert into vm_conversation_members (org_id, conversation_id, user_id, role, status)
            values (${P}, ${C}, ${K2}, 'admin', 'active')`
  ;[asO, asK, asK2, asE, asX] = await Promise.all([
    signIn(addr('owner')),
    signIn(addr('maker')),
    signIn(addr('coadmin')),
    signIn(addr('existing')),
    signIn(addr('other')),
  ])
})

afterAll(async () => {
  await sql`delete from orgs where slug like ${`pc-${RUN}-%`}`
  await sql`delete from pending_invites where email like ${`pc-${RUN}-%`}`
  for (const id of created) await admin().auth.admin.deleteUser(id)
  await sql.end()
})

describe('scenario 1 — the founder case end to end: org invite WITH a module role, plus a chat invite', () => {
  it('signs up -> pending org seat only; accepts -> the module role is granted and the PENDING chat seat appears; accepts that', async () => {
    const email = addr('family')
    expect((await issueOrg(asO, email, { moduleRole: 'member' })).data).toBe('invited')
    expect((await issueVm(asK, C, email)).data).toBe('invited')
    expect((await rows(email)).map((r) => r.kind)).toEqual(['module_role', 'org', 'vm_conversation'])

    const F = await newUser(email)
    const asF = await signIn(email)
    expect((await claim(asF)).data, 'only the org seat applies at sign-up').toBe(1)
    expect((await orgSeat(P, F))!.status).toBe('pending')
    expect(await hasVmRole(P, F), 'a module role must never be granted while the org seat is only pending').toBe(false)
    expect(await convSeat(C, F)).toBeNull()

    expect((await asF.rpc('org_accept_invite', { check_org_id: P })).error).toBeNull()
    expect((await claim(asF)).data, 'module role, then the chat seat, in one claim').toBe(2)
    expect(await hasVmRole(P, F)).toBe(true)
    const s = await convSeat(C, F)
    expect(s!.status, 'applying produces the accept-first PENDING seat, never an active one').toBe('pending')
    expect(s!.invited_by, 'the seat is stamped with the inviter').toBe(K)
    expect(await rows(email), 'every address row is gone once used').toHaveLength(0)

    const { data: invites } = await asF.rpc('vm_my_pending_invites', { check_org_id: P })
    expect((invites as { conversation_id: string }[]).map((i) => i.conversation_id)).toContain(C)
    expect((await asF.rpc('vm_accept_conversation_invite', { check_conversation_id: C })).error).toBeNull()
    expect((await convSeat(C, F))!.status).toBe('active')
  })
})

describe('scenario 2 — a chat maker who is NOT an org admin invites an address that is not in the org', () => {
  it('held until an org admin adds them; never creates org membership; then appears', async () => {
    const email = addr('outsider')
    expect((await issueVm(asK, C, email)).data).toBe('invited')
    const W = await newUser(email)
    const asW = await signIn(email)

    expect((await claim(asW)).data).toBe(0)
    expect(await orgSeat(P, W), 'a chat invite must NEVER create org membership').toBeNull()
    expect(await convSeat(C, W)).toBeNull()
    expect(await rows(email), 'held, not used up').toHaveLength(1)

    // An org admin adds them (direct add = a pending seat) and grants the role.
    expect((await asO.from('org_members').insert({ org_id: P, user_id: W, role: 'member' })).error).toBeNull()
    expect((await claim(asW)).data, 'still pending org acceptance').toBe(0)
    await asW.rpc('org_accept_invite', { check_org_id: P })
    expect((await claim(asW)).data, 'org member but no vm role yet').toBe(0)
    expect(await rows(email)).toHaveLength(1)
    await vmRole(P, W)
    expect((await claim(asW)).data, 'prerequisites met later -> it comes alive').toBe(1)
    expect((await convSeat(C, W))!.status).toBe('pending')
  })
})

describe('§4.2.3 no oracle for the ordinary inviter (scenario 3)', () => {
  it('issuing answers the same for: no account, an existing eligible member, a member without the role, an outsider, a self-blocked member', async () => {
    const blocker = await newUser(addr('blocker'))
    await seat(P, blocker, 'member')
    await vmRole(P, blocker)
    await sql`insert into vm_conversation_members (org_id, conversation_id, user_id, role, status, self_blocked)
              values (${P}, ${C}, ${blocker}, 'participant', 'banned', true)`
    await newUser(addr('stranger'))
    const answers = await Promise.all(
      [addr('nobody'), addr('existing'), addr('norole'), addr('stranger'), addr('blocker')].map((e) => issueVm(asK, C, e)),
    )
    for (const a of answers) {
      expect(a.error).toBeNull()
      expect(a.data).toBe('invited')
    }
  })

  it("the ordinary inviter's list shows only their own rows and NO reason; they cannot read the table", async () => {
    const email = addr('list-own')
    await issueVm(asK, C, email)
    await issueVm(asK2, C, addr('list-other'))
    const { data } = await list(asK, P, C)
    const mine = data as { email: string; waiting_on: string | null }[]
    expect(mine.map((r) => r.email)).toContain(email)
    expect(mine.map((r) => r.email), "a co-admin's invitation is not shown").not.toContain(addr('list-other'))
    expect(mine.every((r) => r.waiting_on === null), 'an ordinary inviter must never see what an invite waits for').toBe(true)
    const { data: direct } = await asK.from('pending_invites').select('id')
    expect(direct ?? [], 'RLS: only org admins read the table').toHaveLength(0)
    // Without a target, an ordinary inviter sees nothing at all.
    expect((await list(asK, P)).data ?? []).toHaveLength(0)
  })

  it('an invitee whose invitation is only HELD learns nothing: the claim answers 0 and their invitation list is empty', async () => {
    // N is an org member WITHOUT the vm role, so the invitation is held.
    await issueVm(asK, C, addr('norole'))
    const asN = await signIn(addr('norole'))
    expect((await claim(asN)).data).toBe(0)
    const { data } = await asN.rpc('vm_my_pending_invites', { check_org_id: P })
    expect(data ?? []).toHaveLength(0)
  })
})

describe("founder answer 3/4 — org admins see every chat invitation in their org, with what it is waiting for", () => {
  it('waiting_on: org_membership / org_acceptance / module_role / ready, computed only from the org\'s own seats', async () => {
    const none = addr('w-none')
    const pend = addr('w-pend')
    const role = addr('w-role')
    const ready = addr('w-ready')
    const P2 = await newUser(pend)
    const R2 = await newUser(role)
    const D2 = await newUser(ready)
    await seat(P, P2, 'member', 'pending')
    await seat(P, R2, 'member')
    await seat(P, D2, 'member')
    await vmRole(P, D2)
    for (const e of [none, pend, role, ready]) await issueVm(asK, C, e)
    const { data } = await list(asO, P)
    const by = new Map((data as { email: string; waiting_on: string; target_title: string }[]).map((r) => [r.email, r]))
    expect(by.get(none)!.waiting_on).toBe('org_membership')
    expect(by.get(pend)!.waiting_on).toBe('org_acceptance')
    expect(by.get(role)!.waiting_on).toBe('module_role')
    expect(by.get(ready)!.waiting_on).toBe('ready')
    expect(by.get(none)!.target_title).toBe('Family sketch')
    // An account OUTSIDE the org reads exactly like no account at all.
    await newUser(addr('w-outside'))
    await issueVm(asK, C, addr('w-outside'))
    const { data: again } = await list(asO, P)
    const outside = (again as { email: string; waiting_on: string }[]).find((r) => r.email === addr('w-outside'))
    expect(outside!.waiting_on, 'must not reveal that the address has an account').toBe('org_membership')
  })

  it("another org's admin sees none of them", async () => {
    await issueVm(asK, C, addr('cross'))
    expect((await list(asX, P)).data ?? []).toHaveLength(0)
    const { data } = await asX.from('pending_invites').select('id').eq('org_id', P)
    expect(data ?? []).toHaveLength(0)
  })
})

describe('§4.2.2 authority re-checked when a held invite applies (scenario 5)', () => {
  // Each case uses its own throwaway inviter so the shared actors stay intact.
  async function freshMaker(name: string) {
    const id = await newUser(addr(name))
    await seat(P, id, 'member')
    await vmRole(P, id)
    await sql`insert into vm_conversation_members (org_id, conversation_id, user_id, role, status)
              values (${P}, ${C}, ${id}, 'admin', 'active')`
    return { id, client: await signIn(addr(name)) }
  }

  it('inviter REMOVED FROM THE ORG before the invitee qualifies -> nothing applies', async () => {
    const m = await freshMaker('maker-left-org')
    const email = addr('victim-1')
    await issueVm(m.client, C, email)
    const who = await newUser(email)
    await sql`delete from org_members where org_id = ${P} and user_id = ${m.id}`
    await seat(P, who, 'member')
    await vmRole(P, who)
    expect((await claim(await signIn(email))).data).toBe(0)
    expect(await convSeat(C, who)).toBeNull()
    expect(await rows(email)).toHaveLength(0)
  })

  it("inviter's conversation ADMIN SEAT demoted to participant -> nothing applies", async () => {
    const m = await freshMaker('maker-demoted')
    const email = addr('victim-2')
    await issueVm(m.client, C, email)
    const who = await newUser(email)
    // Through the real conversation admin K: a raw owner-level UPDATE with no
    // JWT is silently reverted by vm_pin_member's role pin.
    expect(
      (await asK.from('vm_conversation_members').update({ role: 'participant' })
        .eq('conversation_id', C).eq('user_id', m.id)).error,
    ).toBeNull()
    expect((await convSeat(C, m.id))!.role, 'CONTROL: the demotion really happened').toBe('participant')
    await seat(P, who, 'member')
    await vmRole(P, who)
    expect((await claim(await signIn(email))).data).toBe(0)
    expect(await convSeat(C, who)).toBeNull()
  })

  it("inviter LOST THE VM MODULE ROLE -> nothing applies (they could no longer add anyone)", async () => {
    const m = await freshMaker('maker-norole')
    const email = addr('victim-3')
    await issueVm(m.client, C, email)
    const who = await newUser(email)
    await sql`delete from module_roles where org_id = ${P} and user_id = ${m.id}`
    await seat(P, who, 'member')
    await vmRole(P, who)
    expect((await claim(await signIn(email))).data).toBe(0)
    expect(await convSeat(C, who)).toBeNull()
  })

  it('inviter BANNED from the platform -> nothing applies', async () => {
    const m = await freshMaker('maker-banned')
    const email = addr('victim-4')
    await issueVm(m.client, C, email)
    const who = await newUser(email)
    await sql`update auth.users set banned_until = now() + interval '10 years' where id = ${m.id}`
    await seat(P, who, 'member')
    await vmRole(P, who)
    expect((await claim(await signIn(email))).data).toBe(0)
    expect(await convSeat(C, who)).toBeNull()
  })

  it('CONTROL: an org owner (not in the conversation) still qualifies as a manager', async () => {
    const email = addr('owner-issued')
    expect((await issueVm(asO, C, email)).data).toBe('invited')
    const who = await newUser(email)
    await seat(P, who, 'member')
    await vmRole(P, who)
    expect((await claim(await signIn(email))).data).toBe(1)
    expect((await convSeat(C, who))!.invited_by).toBe(O)
  })
})

describe('§4.2.4 a self-block beats any pending invite (scenario 6)', () => {
  it('a member who self-blocked the conversation: the invite never applies, the block stands, the row is used up', async () => {
    const email = addr('self-blocker')
    const B = await newUser(email)
    await seat(P, B, 'member')
    await vmRole(P, B)
    await sql`insert into vm_conversation_members (org_id, conversation_id, user_id, role, status, self_blocked)
              values (${P}, ${C}, ${B}, 'participant', 'banned', true)`
    expect((await issueVm(asK, C, email)).data).toBe('invited')
    expect((await claim(await signIn(email))).data).toBe(0)
    const s = await convSeat(C, B)
    expect(s!.status).toBe('banned')
    expect(s!.self_blocked).toBe(true)
    expect(await rows(email)).toHaveLength(0)
  })

  it('an already-ACTIVE member is not touched either (any seat uses the invite up)', async () => {
    const email = addr('already-in')
    const A2 = await newUser(email)
    await seat(P, A2, 'member')
    await vmRole(P, A2)
    await sql`insert into vm_conversation_members (org_id, conversation_id, user_id, role, status)
              values (${P}, ${C}, ${A2}, 'viewer', 'active')`
    await issueVm(asK, C, email)
    expect((await claim(await signIn(email))).data).toBe(0)
    expect((await convSeat(C, A2))!.role, 'a pre-invite must not change an existing seat').toBe('viewer')
  })
})

describe('issue authority', () => {
  it('only someone who could add a member directly may issue: a plain member, a co-member and another org cannot', async () => {
    expect((await issueVm(asE, C, addr('nope-1'))).error?.message).toBe('Not authorized')
    expect((await issueVm(asX, C, addr('nope-2'))).error?.message).toBe('Not authorized')
    expect(
      (await asE.rpc('pending_invite_issue_vm', { check_conversation_id: crypto.randomUUID(), target_email: addr('n') })).error
        ?.message,
      'an unknown conversation answers exactly like a forbidden one',
    ).toBe('Not authorized')
    expect((await rows(addr('nope-1'))).length + (await rows(addr('nope-2'))).length).toBe(0)
  })
})

describe('cancel and resend (scenario 9)', () => {
  it('the inviter cancels their own; a co-admin and a plain member get "not found"; an org admin may cancel any', async () => {
    const email = addr('cancel-me')
    await issueVm(asK, C, email)
    const [row] = await rows(email)
    expect((await asK2.rpc('pending_invite_cancel', { invite_id: row!.id })).error?.message).toBe('Invitation not found')
    expect((await asE.rpc('pending_invite_cancel', { invite_id: row!.id })).error?.message).toBe('Invitation not found')
    expect((await asK.rpc('pending_invite_cancel', { invite_id: row!.id })).error).toBeNull()
    expect(await rows(email)).toHaveLength(0)

    await issueVm(asK, C, email)
    const [again] = await rows(email)
    expect((await asO.rpc('pending_invite_cancel', { invite_id: again!.id })).error).toBeNull()
    expect(await rows(email)).toHaveLength(0)
  })

  it('resend: 30 more days, moved to the resender; a co-admin who did not issue it cannot', async () => {
    const email = addr('resend-me')
    await issueVm(asK, C, email)
    await sql`update pending_invites set expires_at = now() + interval '2 days' where email = ${email}`
    const [row] = await rows(email)
    expect((await asK2.rpc('pending_invite_resend', { invite_id: row!.id })).error?.message).toBe('Invitation not found')
    expect((await asO.rpc('pending_invite_resend', { invite_id: row!.id })).error).toBeNull()
    const [after] = await sql<{ invited_by: string; days: number }[]>`
      select invited_by, extract(day from expires_at - now())::int as days from pending_invites where email = ${email}`
    expect(after!.invited_by).toBe(O)
    expect(after!.days).toBeGreaterThanOrEqual(29)
  })

  it('cancelling an org invitation also removes the module role that rode on it', async () => {
    const email = addr('org-cancel')
    await issueOrg(asO, email, { moduleRole: 'member' })
    const org = (await rows(email)).find((r) => r.kind === 'org')!
    expect((await asO.rpc('pending_invite_cancel', { invite_id: org.id })).error).toBeNull()
    expect(await rows(email)).toHaveLength(0)
  })
})

describe('expiry (scenario 4)', () => {
  it('an expired chat invitation never applies; the pruner deletes it and the rows of a deleted conversation', async () => {
    const email = addr('expired')
    const T = await newUser(email)
    await seat(P, T, 'member')
    await vmRole(P, T)
    await issueVm(asK, C, email)
    await sql`update pending_invites set expires_at = now() - interval '1 minute' where email = ${email}`
    expect((await claim(await signIn(email))).data).toBe(0)
    expect(await convSeat(C, T)).toBeNull()

    const doomed = await newConversation(P, K, 'Doomed')
    await issueVm(asK, doomed, addr('orphan'))
    await sql`delete from vm_conversations where id = ${doomed}`
    await sql`select public.pending_invites_prune_expired()`
    expect(await rows(email)).toHaveLength(0)
    expect(await rows(addr('orphan')), "a deleted conversation's invitations go with the next prune").toHaveLength(0)
  })
})

describe('adversarial review 2026-10-18 — the findings, each pinned', () => {
  it('a module role belongs to ITS org invitation: the pending seat removed, a later seat from someone else -> no grant', async () => {
    const email = addr('withdrawn')
    await issueOrg(asO, email, { moduleRole: 'admin' })
    const D = await newUser(email)
    const asD = await signIn(email)
    await claim(asD)
    expect((await rows(email)).find((r) => r.kind === 'module_role')!.claimed_by).toBe(D)
    // O withdraws: removes the pending seat. A different admin later adds D.
    await sql`delete from org_members where org_id = ${P} and user_id = ${D}`
    await sql`insert into org_members (org_id, user_id, role, status, invited_by, invited_at)
              values (${P}, ${D}, 'member', 'active', ${O}, now() + interval '1 second')`
    await claim(asD)
    expect(await hasVmRole(P, D, 'admin'), "a withdrawn invitation's role must not ride in on a later seat").toBe(false)
    expect(await rows(email)).toHaveLength(0)
  })

  it('a DECLINED org invitation takes its module role with it', async () => {
    const email = addr('decliner')
    await issueOrg(asO, email, { moduleRole: 'member' })
    const D = await newUser(email)
    const asD = await signIn(email)
    await claim(asD)
    await asD.from('org_members').delete().eq('org_id', P).eq('user_id', D)
    await claim(asD)
    expect(await rows(email), 'the address must not outlive a decline').toHaveLength(0)
  })

  it('a conversation moved to another org: its held invitations are dead, not applied in the new org', async () => {
    const moved = await newConversation(P, K, 'Moving')
    const email = addr('mover')
    await issueVm(asK, moved, email)
    const V = await newUser(email)
    // Eligible in BOTH orgs, so only the move check stops a seat landing in Q.
    await seat(P, V, 'member')
    await vmRole(P, V)
    await seat(Q, V, 'member')
    await sql`insert into module_roles (org_id, user_id, module_key, role) values (${Q}, ${V}, ${VM}, 'member')`
    // Moved by someone who administers BOTH orgs (vm_pin_conversation pins
    // org_id for anyone else, including a raw owner-level UPDATE with no JWT).
    const both = await newUser(addr('two-org-admin'))
    await seat(P, both, 'admin')
    await seat(Q, both, 'admin')
    const asBoth = await signIn(addr('two-org-admin'))
    expect((await asBoth.from('vm_conversations').update({ org_id: Q }).eq('id', moved)).error).toBeNull()
    const [now] = await sql<{ org_id: string }[]>`select org_id from vm_conversations where id = ${moved}`
    expect(now!.org_id, 'CONTROL: the conversation really moved').toBe(Q)
    expect((await claim(await signIn(email))).data).toBe(0)
    expect(await convSeat(moved, V)).toBeNull()
    expect(await rows(email)).toHaveLength(0)
  })

  it("an org invitation answering 'exists' leaves the owner's module role untouched", async () => {
    const A = await newUser(addr('lower-admin'))
    await seat(P, A, 'admin')
    const asA = await signIn(addr('lower-admin'))
    const email = addr('owner-held')
    await issueOrg(asO, email, { role: 'admin', moduleRole: 'admin' })
    expect((await issueOrg(asA, email, { role: 'member', moduleRole: 'member' })).data).toBe('exists')
    const [mr] = await sql<{ role: string; invited_by: string }[]>`
      select role, invited_by from pending_invites where email = ${email} and kind = 'module_role'`
    expect(mr).toEqual({ role: 'admin', invited_by: O })
  })

  it('the per-address cap counts distinct INVITERS: one chat maker inviting an address to many conversations is one', async () => {
    // Uses the DEFAULT cap (20). It never writes platform_settings: that row is
    // platform-wide and vitest runs files in parallel, so the slice-1 caps
    // tests would race it. (Slice 1 only ever sets maxPerInviter.)
    const email = addr('many-convs')
    const convs = await Promise.all(Array.from({ length: 25 }, (_, n) => newConversation(P, K, `Many ${n}`)))
    for (const c of convs) expect((await issueVm(asK, c, email)).data).toBe('invited')
    expect(await rows(email), 'one inviter alone never fills the cap, even past 20 rows').toHaveLength(25)
    // The leak the review found: K's 25 rows must not crowd out SOMEONE ELSE.
    const c2 = await newConversation(P, K2, 'Second')
    await issueVm(asK2, c2, email)
    expect(
      await sql`select 1 from pending_invites where email = ${email} and invited_by = ${K2}`,
      "one person's many invitations must not use up another inviter's room",
    ).toHaveLength(1)
    // 19 more distinct inviters elsewhere: 20 distinct in all.
    const others = await Promise.all(Array.from({ length: 19 }, (_, n) => newUser(addr(`cap-inv-${n}`))))
    // (target_id needs no real conversation: the cap only counts rows.)
    for (const o of others) {
      await sql`insert into pending_invites (kind, org_id, target_id, email, role, invited_by, expires_at)
                values ('vm_conversation', ${Q}, ${crypto.randomUUID()}, ${email}, 'participant', ${o},
                        now() + interval '30 days')`
    }
    const c3 = await newConversation(P, E, 'Third')
    expect((await issueVm(asE, c3, email)).data, 'the 21st inviter gets the ordinary answer').toBe('invited')
    const byE = await sql`select 1 from pending_invites where email = ${email} and invited_by = ${E}`
    expect(byE, 'over the cap nothing is stored').toHaveLength(0)
    // CONTROL: someone ALREADY among the inviters is never stopped by it.
    const c4 = await newConversation(P, K, 'Fourth')
    await issueVm(asK, c4, email)
    expect(await sql`select 1 from pending_invites where email = ${email} and target_id = ${c4}`).toHaveLength(1)
  }, 30_000)
})

describe('§4.2.6 hygiene — the new internal functions are not callable', () => {
  it('apply_held, waiting_on and slot refuse a signed-in user', async () => {
    const id = crypto.randomUUID()
    expect((await asO.rpc('pending_invite_apply_held', { invite_id: id, invitee: O })).error).not.toBeNull()
    expect((await asO.rpc('pending_invite_waiting_on', { invite_id: id })).error).not.toBeNull()
    expect(
      (await asO.rpc('pending_invite_slot', { p_inviter: O, p_email: 'a@b.c', p_kind: 'org', p_target: P, p_module_key: null }))
        .error,
    ).not.toBeNull()
  })
})
