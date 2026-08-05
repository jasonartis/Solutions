import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  dataBrowserDeclarations,
  getModule,
  moduleRegistry,
  viewAsCompleteness,
  viewAsTabsFor,
} from '@platform/core'

// RLS isolation test (M0 acceptance, docs/04): a user in org B must see
// nothing of org A. Runs against the seeded local stack:
//   pnpm dev (once)  →  pnpm seed  →  pnpm --filter @platform/db test
const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const anonKey = process.env.SUPABASE_ANON_KEY ?? ''

async function signIn(email: string): Promise<SupabaseClient> {
  const client = createClient(url, anonKey, { auth: { persistSession: false } })
  const { error } = await client.auth.signInWithPassword({ email, password: 'password123' })
  if (error) throw new Error(`Sign-in failed for ${email}: ${error.message} (did you seed?)`)
  return client
}

// Slice 3 (20260727010000): an admin adding a member now creates a PENDING
// invite; the invitee is not a real member (no read/authority) until THEY
// accept. Test setups that need an active member must invite THEN accept — this
// signs in as the invitee and accepts. Tolerant of "already active" so a re-run
// against a not-freshly-reseeded stack doesn't spuriously fail.
async function acceptInviteAs(email: string, orgId: string) {
  const c = await signIn(email)
  const { error } = await c.rpc('org_accept_invite', { check_org_id: orgId })
  if (error && !/no pending invitation/i.test(error.message)) {
    throw new Error(`accept invite failed for ${email} in ${orgId}: ${error.message}`)
  }
}

let alice: SupabaseClient
let bob: SupabaseClient
let orgtest: SupabaseClient

beforeAll(async () => {
  if (!anonKey) throw new Error('SUPABASE_ANON_KEY not set — run `pnpm dev` once to generate .env')
  alice = await signIn('alice@demo.local')
  bob = await signIn('bob@demo.local')
  orgtest = await signIn('orgtest@demo.local')
})

describe('tenancy isolation', () => {
  it('alice sees only her own orgs', async () => {
    const { data } = await alice.from('orgs').select('slug')
    // The orgs alice administers across the module seeds (classroom, synagogue,
    // matchmaking, nail salon, speed dating) plus the dedicated M0 stub-module
    // proof org — and nothing else (excludes demo-b).
    expect(data?.map((o) => o.slug).sort()).toEqual([
      'demo-a',
      'demo-dating',
      'demo-match',
      'demo-salon',
      'demo-shul',
      'demo-visual',
      'platform-self-test',
    ])
  })

  it('bob sees only his own org', async () => {
    const { data } = await bob.from('orgs').select('slug')
    expect(data?.map((o) => o.slug)).toEqual(['demo-b'])
  })

  it("bob cannot read org A's entitlements", async () => {
    const { data } = await bob.from('org_modules').select('org_id, module_key')
    expect(data).toEqual([])
  })

  it("bob cannot read org A's memberships", async () => {
    const { data: aliceRows } = await alice.from('org_members').select('org_id')
    const { data: bobRows } = await bob.from('org_members').select('org_id')
    const aliceOrg = aliceRows?.[0]?.org_id
    expect(aliceOrg).toBeTruthy()
    expect(bobRows?.some((r) => r.org_id === aliceOrg)).toBe(false)
  })

  it('bob cannot grant himself an entitlement', async () => {
    const { data: bobOrg } = await bob.from('orgs').select('id').single()
    const { error } = await bob
      .from('org_modules')
      .insert({ org_id: bobOrg!.id, module_key: 'stub', enabled: true })
    expect(error).not.toBeNull()
  })

  it('bob cannot read other profiles', async () => {
    const { data } = await bob.from('profiles').select('email')
    expect(data?.map((p) => p.email)).toEqual(['bob@demo.local'])
  })

  it('bob cannot make himself superadmin', async () => {
    await bob.from('profiles').update({ is_superadmin: true }).eq('email', 'bob@demo.local')
    const { data } = await bob.from('profiles').select('is_superadmin').single()
    expect(data?.is_superadmin).toBe(false)
  })
})

// Org self-management (2026-07-12, docs/03 "Control hierarchy"): org owners/
// admins can now manage their own org's membership + module roles directly
// (previously superadmin-only). Exercised entirely on the dedicated
// Platform Self-Test org (alice=admin, orgtest=member) so it can't collide
// with any other test's assumptions about who belongs to which org.
describe('org self-management', () => {
  async function selfTestOrgId(client: SupabaseClient) {
    const { data } = await client.from('orgs').select('id').eq('slug', 'platform-self-test').single()
    return data!.id as string
  }

  it('org_find_user_by_email resolves an email only for an org the caller admins', async () => {
    const orgId = await selfTestOrgId(alice)
    const { data: found } = await alice.rpc('org_find_user_by_email', {
      check_org_id: orgId,
      target_email: 'orgtest@demo.local',
    })
    expect(found?.[0]?.email).toBe('orgtest@demo.local')

    const { data: notFound } = await bob.rpc('org_find_user_by_email', {
      check_org_id: orgId,
      target_email: 'orgtest@demo.local',
    })
    expect(notFound ?? []).toEqual([])
  })

  it('alice can add a new member to an org she admins (resolved via org_find_user_by_email)', async () => {
    const orgId = await selfTestOrgId(alice)
    const { data: found } = await alice.rpc('org_find_user_by_email', {
      check_org_id: orgId,
      target_email: 'bob@demo.local',
    })
    const bobUserId = found![0]!.user_id as string
    const { error } = await alice.from('org_members').upsert({ org_id: orgId, user_id: bobUserId, role: 'member' })
    expect(error).toBeNull()
    // cleanup — leave the fixture org as it was for other tests
    await alice.from('org_members').delete().eq('org_id', orgId).eq('user_id', bobUserId)
  })

  it('an owner can promote a member to admin and demote back', async () => {
    const orgId = await selfTestOrgId(alice)
    const { data: orgtestProfile } = await alice
      .from('profiles')
      .select('user_id')
      .eq('email', 'orgtest@demo.local')
      .single()
    const { error: promoteErr } = await alice
      .from('org_members')
      .update({ role: 'admin' })
      .eq('org_id', orgId)
      .eq('user_id', orgtestProfile!.user_id)
    expect(promoteErr).toBeNull()
    const { error: demoteErr } = await alice
      .from('org_members')
      .update({ role: 'member' })
      .eq('org_id', orgId)
      .eq('user_id', orgtestProfile!.user_id)
    expect(demoteErr).toBeNull()
  })

  it('alice cannot write org_members for an org she does NOT admin', async () => {
    const { data: bobOrg } = await bob.from('orgs').select('id').eq('slug', 'demo-b').single()
    const { data: aliceUser } = await alice.auth.getUser()
    const { error } = await alice
      .from('org_members')
      .upsert({ org_id: bobOrg!.id, user_id: aliceUser.user!.id, role: 'member' })
    expect(error).not.toBeNull()
  })

  it('a plain member cannot demote the owner of their own org', async () => {
    const orgId = await selfTestOrgId(alice)
    const { data: aliceUser } = await alice.auth.getUser()
    // Postgres RLS quirk: an UPDATE whose USING clause excludes every
    // matching row succeeds with zero rows affected — it does not error
    // the way a blocked INSERT's WITH CHECK does. So the real assertion is
    // "the row didn't change," not "the call errored."
    await orgtest
      .from('org_members')
      .update({ role: 'member' })
      .eq('org_id', orgId)
      .eq('user_id', aliceUser.user!.id)
    const { data: stillOwner } = await alice
      .from('org_members')
      .select('role')
      .eq('org_id', orgId)
      .eq('user_id', aliceUser.user!.id)
      .single()
    expect(stillOwner?.role).toBe('owner')
  })

  it('the sole owner of an org cannot demote or remove themselves', async () => {
    const orgId = await selfTestOrgId(alice)
    const { data: aliceUser } = await alice.auth.getUser()
    const { error: demoteErr } = await alice
      .from('org_members')
      .update({ role: 'member' })
      .eq('org_id', orgId)
      .eq('user_id', aliceUser.user!.id)
    expect(demoteErr).not.toBeNull()

    const { error: deleteErr } = await alice
      .from('org_members')
      .delete()
      .eq('org_id', orgId)
      .eq('user_id', aliceUser.user!.id)
    expect(deleteErr).not.toBeNull()
  })

  it('org role hierarchy: each level manages only strictly-below levels (20260717010000)', async () => {
    // Fixture: alice = OWNER, orgtest = member of platform-self-test.
    const orgId = await selfTestOrgId(alice)
    const { data: aliceUser } = await alice.auth.getUser()
    const { data: orgtestProfile } = await alice
      .from('profiles')
      .select('user_id')
      .eq('email', 'orgtest@demo.local')
      .single()
    const orgtestId = orgtestProfile!.user_id as string
    // bob's id via the admin-only email resolver (alice & bob share no org
    // otherwise, so a plain profiles read wouldn't see him).
    const { data: found } = await alice.rpc('org_find_user_by_email', {
      check_org_id: orgId,
      target_email: 'bob@demo.local',
    })
    const bobId = found![0]!.user_id as string

    // Owner can create an admin (member -> admin).
    expect(
      (await alice.from('org_members').update({ role: 'admin' }).eq('org_id', orgId).eq('user_id', orgtestId)).error,
    ).toBeNull()
    // Owner CANNOT create an owner — only a superadmin can (3 not > 3).
    expect(
      (await alice.from('org_members').update({ role: 'owner' }).eq('org_id', orgId).eq('user_id', orgtestId)).error,
    ).not.toBeNull()

    // Add bob as a plain member (owner adding a member).
    expect((await alice.from('org_members').upsert({ org_id: orgId, user_id: bobId, role: 'member' })).error).toBeNull()

    // Admin (orgtest) CANNOT promote a member up to admin (can't mint a peer).
    expect(
      (await orgtest.from('org_members').update({ role: 'admin' }).eq('org_id', orgId).eq('user_id', bobId)).error,
    ).not.toBeNull()

    // Admin CANNOT demote/remove the owner above them (alice stays owner).
    await orgtest.from('org_members').update({ role: 'member' }).eq('org_id', orgId).eq('user_id', aliceUser.user!.id)
    const { data: aliceRow } = await alice
      .from('org_members')
      .select('role')
      .eq('org_id', orgId)
      .eq('user_id', aliceUser.user!.id)
      .single()
    expect(aliceRow?.role).toBe('owner')

    // Admin cannot touch ANOTHER admin: promote bob to admin (owner action),
    // then orgtest (admin) can't demote bob (admin) — the equal-rank block
    // that answers "can an admin touch another admin?" = no.
    await alice.from('org_members').update({ role: 'admin' }).eq('org_id', orgId).eq('user_id', bobId)
    expect(
      (await orgtest.from('org_members').update({ role: 'member' }).eq('org_id', orgId).eq('user_id', bobId)).error,
    ).not.toBeNull()

    // Owner's OWN seat is blocked even though a second manager (orgtest) exists
    // — proves the self-block is the hierarchy rule, not the last-admin floor.
    expect(
      (await alice.from('org_members').update({ role: 'admin' }).eq('org_id', orgId).eq('user_id', aliceUser.user!.id)).error,
    ).not.toBeNull()

    // Restore the fixture: remove bob, orgtest back to member.
    await alice.from('org_members').delete().eq('org_id', orgId).eq('user_id', bobId)
    await alice.from('org_members').update({ role: 'member' }).eq('org_id', orgId).eq('user_id', orgtestId)
  })

  it('alice can grant a module role to orgtest for a module enabled on her org', async () => {
    const orgId = await selfTestOrgId(alice)
    const { data: orgtestProfile } = await alice
      .from('profiles')
      .select('user_id')
      .eq('email', 'orgtest@demo.local')
      .single()
    const { error } = await alice.from('module_roles').upsert(
      {
        org_id: orgId,
        user_id: orgtestProfile!.user_id,
        module_key: 'stub',
        role: 'user',
      },
      { onConflict: 'org_id,user_id,module_key,role,scope_ref' },
    )
    expect(error).toBeNull()

    const { data: mine } = await orgtest.from('module_roles').select('role').eq('module_key', 'stub')
    expect(mine?.map((r) => r.role)).toContain('user')
  })
})

// Org invite-accept (slice 3, 20260727010000): being added to an org creates a
// PENDING invite that is INVISIBLE and INERT until the invited user accepts.
// The tenancy properties CI must protect: a pending invitee reads nothing and
// can do nothing in the org; only the invitee (never an admin) can activate the
// seat; a module grant to a pending user confers no authority until acceptance.
describe('org invite-accept (slice 3)', () => {
  let pstId: string
  let shulId: string
  let demoAId: string
  let bobId: string
  let charlieId: string
  let owner: SupabaseClient // superadmin (owner@demo.local is superadmin locally)

  beforeAll(async () => {
    owner = await signIn('owner@demo.local')
    pstId = (await alice.from('orgs').select('id').eq('slug', 'platform-self-test').single()).data!.id
    shulId = (await alice.from('orgs').select('id').eq('slug', 'demo-shul').single()).data!.id
    demoAId = (await alice.from('orgs').select('id').eq('slug', 'demo-a').single()).data!.id
    const resolve = async (email: string) =>
      (await alice.rpc('org_find_user_by_email', { check_org_id: pstId, target_email: email })).data![0].user_id as string
    bobId = await resolve('bob@demo.local')
    charlieId = await resolve('charlie@demo.local')
  })

  // Leave no trace between tests: bob is a shared global fixture (admin of
  // demo-b), so every test that touches his membership cleans up across all
  // three orgs it might have used, plus any test-created grants/entities.
  afterEach(async () => {
    for (const org of [pstId, shulId, demoAId]) {
      await alice.from('module_roles').delete().eq('org_id', org).eq('user_id', bobId)
      await alice.from('org_members').delete().eq('org_id', org).eq('user_id', bobId)
    }
    // ONLY the global grant this block creates — never charlie's SEED-scoped
    // student grant (scope_ref = the Stats-101 class node), which the classroom
    // e2e depends on.
    await alice.from('module_roles').delete().eq('org_id', demoAId).eq('user_id', charlieId).eq('module_key', 'classroom').is('scope_ref', null)
    await alice.from('syn_schedule_types').delete().eq('org_id', shulId).eq('name', 'RLS Invite Sheet')
    const { data: leftover } = await alice.from('cls_courses').select('id, scope_node_id').eq('org_id', demoAId).eq('name', 'RLS Invite Course')
    for (const c of leftover ?? []) {
      await alice.from('cls_courses').delete().eq('id', c.id)
      if (c.scope_node_id) await alice.from('module_scope_nodes').delete().eq('id', c.scope_node_id)
    }
  })

  it('an invited user is pending, invisible, and inert until they accept', async () => {
    expect((await alice.from('org_members').insert({ org_id: pstId, user_id: bobId, role: 'member' })).error).toBeNull()

    // The insert lands as a pending invite (server-forced, regardless of input).
    const { data: seat } = await alice
      .from('org_members')
      .select('status, invited_by')
      .eq('org_id', pstId)
      .eq('user_id', bobId)
      .single()
    expect(seat?.status).toBe('pending')
    const { data: aliceUser } = await alice.auth.getUser()
    expect(seat?.invited_by).toBe(aliceUser.user!.id) // inviter server-stamped

    // Bob cannot see the org, its entitlements, or its other members…
    expect((await bob.from('orgs').select('id').eq('id', pstId)).data?.length).toBe(0)
    expect((await bob.from('org_modules').select('module_key').eq('org_id', pstId)).data?.length).toBe(0)
    const { data: bobSeesMembers } = await bob.from('org_members').select('user_id').eq('org_id', pstId)
    expect(bobSeesMembers?.map((r) => r.user_id)).toEqual([bobId]) // only his own invite row (select_self)
    // …and gains no cross-member profile visibility (shares_org_with is active-only).
    const { data: profs } = await bob.from('profiles').select('email')
    expect(profs?.map((p) => p.email)).not.toContain('orgtest@demo.local')

    // But he DOES see the invite via the narrow name-only definer.
    const { data: invites } = await bob.rpc('org_my_pending_invites')
    const inv = (invites ?? []).find((i: { org_id: string }) => i.org_id === pstId)
    expect(inv?.org_name).toBe('Platform Self-Test')
    expect(inv?.invited_role).toBe('member')
  })

  it('org_member_profiles: an admin reads a pending invitee\'s identity; a non-admin gets nothing', async () => {
    await alice.from('org_members').insert({ org_id: pstId, user_id: bobId, role: 'member' })
    // Alice (org admin) can see bob's name/email even though he's pending and
    // shares_org_with would hide him.
    const { data: asAdmin } = await alice.rpc('org_member_profiles', { check_org_id: pstId })
    expect((asAdmin ?? []).some((r: { email: string }) => r.email === 'bob@demo.local')).toBe(true)
    // Bob (pending, not an admin of pst) gets zero rows.
    const { data: asBob } = await bob.rpc('org_member_profiles', { check_org_id: pstId })
    expect(asBob ?? []).toEqual([])
  })

  it('an admin cannot force-activate an invite — only the invitee accepts (consent)', async () => {
    await alice.from('org_members').insert({ org_id: pstId, user_id: bobId, role: 'member' })

    // Alice (org admin) trying to flip bob to active on his behalf is rejected.
    const { error } = await alice
      .from('org_members')
      .update({ status: 'active' })
      .eq('org_id', pstId)
      .eq('user_id', bobId)
    expect(error).not.toBeNull()

    const { data: seat } = await alice
      .from('org_members')
      .select('status')
      .eq('org_id', pstId)
      .eq('user_id', bobId)
      .single()
    expect(seat?.status).toBe('pending')
  })

  it('accepting makes the invitee a real member; then a plain member can leave', async () => {
    await alice.from('org_members').insert({ org_id: pstId, user_id: bobId, role: 'member' })

    // Before accept: invisible. After accept: visible + a real member.
    expect((await bob.from('orgs').select('id').eq('id', pstId)).data?.length).toBe(0)
    expect((await bob.rpc('org_accept_invite', { check_org_id: pstId })).error).toBeNull()
    expect((await bob.from('orgs').select('id').eq('id', pstId)).data?.length).toBe(1)

    // A plain member may leave their own seat (self-DELETE carve-out).
    expect(
      (await bob.from('org_members').delete().eq('org_id', pstId).eq('user_id', bobId)).error,
    ).toBeNull()
    expect((await bob.from('orgs').select('id').eq('id', pstId)).data?.length).toBe(0)
  })

  it('an invitee can decline (self-delete their pending row)', async () => {
    await alice.from('org_members').insert({ org_id: pstId, user_id: bobId, role: 'member' })
    expect(
      (await bob.from('org_members').delete().eq('org_id', pstId).eq('user_id', bobId)).error,
    ).toBeNull()
    const { data: invites } = await bob.rpc('org_my_pending_invites')
    expect((invites ?? []).some((i: { org_id: string }) => i.org_id === pstId)).toBe(false)
  })

  it('accepting with no pending invite errors', async () => {
    // Bob has no pending invite to demo-a → the definer refuses.
    const { error } = await bob.rpc('org_accept_invite', { check_org_id: demoAId })
    expect(error).not.toBeNull()
  })

  it('an active admin cannot self-remove (must ask a co-admin)', async () => {
    // Invite bob, accept, promote to admin (alice, owner). His own seat is then
    // untouchable by himself even though carve-out (b) covers pending/member.
    await alice.from('org_members').insert({ org_id: pstId, user_id: bobId, role: 'member' })
    await bob.rpc('org_accept_invite', { check_org_id: pstId })
    expect(
      (await alice.from('org_members').update({ role: 'admin' }).eq('org_id', pstId).eq('user_id', bobId)).error,
    ).toBeNull()
    // Bob (active admin) cannot delete his own seat.
    expect(
      (await bob.from('org_members').delete().eq('org_id', pstId).eq('user_id', bobId)).error,
    ).not.toBeNull()
    const { data: still } = await alice
      .from('org_members')
      .select('role, status')
      .eq('org_id', pstId)
      .eq('user_id', bobId)
      .single()
    expect(still?.status).toBe('active') // still there
  })

  it('a module grant confers NO authority while the holder is a pending invite', async () => {
    // Bob is invited to the synagogue org as a plain member (pending) AND granted
    // the 'maker' module role. The grant must be inert until he accepts.
    await alice.from('org_members').insert({ org_id: shulId, user_id: bobId, role: 'member' })
    expect(
      (await alice
        .from('module_roles')
        .insert({ org_id: shulId, user_id: bobId, module_key: 'synagogue-schedules', role: 'maker' })).error,
    ).toBeNull()

    // Pending: syn_can_write() (now active-gated via has_module_role) refuses the write.
    expect(
      (await bob.from('syn_schedule_types').insert({ org_id: shulId, name: 'RLS Invite Sheet' })).error,
    ).not.toBeNull()

    // Accept → the same maker grant now works.
    expect((await bob.rpc('org_accept_invite', { check_org_id: shulId })).error).toBeNull()
    expect(
      (await bob.from('syn_schedule_types').insert({ org_id: shulId, name: 'RLS Invite Sheet' })).error,
    ).toBeNull()
  })

  it('a pending OWNER/ADMIN invite cannot write module data (syn_can_write leak closed)', async () => {
    // The specific inline-org_members leak: syn_can_write took owner/admin without
    // a status filter. Invite bob as ADMIN (pending) — he must NOT be able to write.
    await alice.from('org_members').insert({ org_id: shulId, user_id: bobId, role: 'admin' })
    const { data: seat } = await alice
      .from('org_members')
      .select('status, role')
      .eq('org_id', shulId)
      .eq('user_id', bobId)
      .single()
    expect(seat).toMatchObject({ status: 'pending', role: 'admin' })

    expect(
      (await bob.from('syn_schedule_types').insert({ org_id: shulId, name: 'RLS Invite Sheet' })).error,
    ).not.toBeNull()
  })

  it('a pending professor cannot reach the classroom coarse gate (cls_can_manage)', async () => {
    // cls_can_manage backs the classroom Storage buckets (student PII) + course
    // insert. Its module_roles arm is now active-gated, so a pending professor
    // cannot insert a course (nor, by the same gate, read the storage buckets).
    await alice.from('org_members').insert({ org_id: demoAId, user_id: bobId, role: 'member' })
    await alice.from('module_roles').insert({ org_id: demoAId, user_id: bobId, module_key: 'classroom', role: 'professor' })

    expect(
      (await bob.from('cls_courses').insert({ org_id: demoAId, name: 'RLS Invite Course' })).error,
    ).not.toBeNull()

    // Accept → the same professor grant now works.
    expect((await bob.rpc('org_accept_invite', { check_org_id: demoAId })).error).toBeNull()
    expect(
      (await bob.from('cls_courses').insert({ org_id: demoAId, name: 'RLS Invite Course' })).error,
    ).toBeNull()
  })

  it('a pending manager cannot staff other users (shared module_roles write path)', async () => {
    // module_has_manager_grant / module_caller_can_manage_seat are the SHARED
    // module_roles write authority. A pending "professor" must not be able to
    // grant roles to OTHER users until they accept.
    await alice.from('org_members').insert({ org_id: demoAId, user_id: bobId, role: 'member' })
    await alice.from('module_roles').insert({ org_id: demoAId, user_id: bobId, module_key: 'classroom', role: 'professor' })

    const grantCharlie = () =>
      bob.from('module_roles').insert({ org_id: demoAId, user_id: charlieId, module_key: 'classroom', role: 'student' })
    expect((await grantCharlie()).error).not.toBeNull() // pending: no write authority

    expect((await bob.rpc('org_accept_invite', { check_org_id: demoAId })).error).toBeNull()
    expect((await grantCharlie()).error).toBeNull() // active professor: may staff a student
  })

  it('a superadmin may add a member immediately-active (the escape hatch)', async () => {
    // Founder decision 2026-07-27: the platform owner controls everything, so a
    // superadmin can choose to skip the invite and add an ACTIVE member directly.
    expect(
      (await owner.from('org_members').insert({ org_id: pstId, user_id: bobId, role: 'member', status: 'active' })).error,
    ).toBeNull()
    const { data: seat } = await alice
      .from('org_members')
      .select('status')
      .eq('org_id', pstId)
      .eq('user_id', bobId)
      .single()
    expect(seat?.status).toBe('active')
    // Bob is a real member without accepting anything.
    expect((await bob.from('orgs').select('id').eq('id', pstId)).data?.length).toBe(1)
  })

  it('a superadmin add with no status still defaults to a pending invite', async () => {
    expect((await owner.from('org_members').insert({ org_id: pstId, user_id: bobId, role: 'member' })).error).toBeNull()
    const { data: seat } = await alice
      .from('org_members')
      .select('status')
      .eq('org_id', pstId)
      .eq('user_id', bobId)
      .single()
    expect(seat?.status).toBe('pending')
  })

  it('an ORG ADMIN cannot force an active add — the guard forces pending', async () => {
    // Alice (owner of pst, not a superadmin) tries to add bob as active directly.
    expect(
      (await alice.from('org_members').insert({ org_id: pstId, user_id: bobId, role: 'member', status: 'active' })).error,
    ).toBeNull() // the insert succeeds…
    const { data: seat } = await alice
      .from('org_members')
      .select('status')
      .eq('org_id', pstId)
      .eq('user_id', bobId)
      .single()
    expect(seat?.status).toBe('pending') // …but lands pending, not active
  })
})

// Nail-salon worker availability (2026-07-16, 20260716010000): the
// sal_worker_has_time_off definer RPC lets a CUSTOMER honor a worker's time
// off at booking without reading sal_worker_time_off (its `reason` is
// operator/self-only). The tenancy property that CI must protect: a
// non-member of the salon's org can never use it to probe a worker's time
// off — they always get `false`, indistinguishable from "no time off".
describe('nail-salon worker availability RPC', () => {
  it('customer gets a truthful overlap answer; non-member always gets false (no cross-tenant probe)', async () => {
    const charlie = await signIn('charlie@demo.local') // salon customer (org member)
    // alice administers demo-salon (operate tier), so she can read the fixtures
    // + the seeded time-off row to compute in/out-of-window probe times.
    const { data: salon } = await alice.from('orgs').select('id').eq('slug', 'demo-salon').single()
    const { data: loc } = await alice.from('sal_locations').select('id').eq('org_id', salon!.id).single()
    const { data: dana } = await alice.from('profiles').select('user_id').eq('email', 'dana@demo.local').single()
    const { data: timeOff } = await alice
      .from('sal_worker_time_off')
      .select('starts_at, ends_at')
      .order('starts_at')
      .limit(1)
      .single()

    const at = (base: string, offsetMs: number) => new Date(new Date(base).getTime() + offsetMs).toISOString()
    const args = (ws: string, we: string) => ({
      check_worker_id: dana!.user_id,
      check_location_id: loc!.id,
      window_start: ws,
      window_end: we,
    })
    const inStart = at(timeOff!.starts_at, 30 * 60000) // 30m into the block
    const inEnd = at(timeOff!.starts_at, 60 * 60000)
    const outStart = at(timeOff!.ends_at, 3 * 3600000) // 3h after it ends
    const outEnd = at(timeOff!.ends_at, 3.5 * 3600000)

    const { data: cIn } = await charlie.rpc('sal_worker_has_time_off', args(inStart, inEnd))
    expect(cIn).toBe(true)
    const { data: cOut } = await charlie.rpc('sal_worker_has_time_off', args(outStart, outEnd))
    expect(cOut).toBe(false)

    // bob is not a member of demo-salon → the SAME real-overlap window is false.
    const { data: bIn } = await bob.rpc('sal_worker_has_time_off', args(inStart, inEnd))
    expect(bIn).toBe(false)

    // And the customer still cannot read the raw rows (reason stays private).
    const { data: raw } = await charlie.from('sal_worker_time_off').select('id')
    expect(raw).toEqual([])
  })
})

// Speed-dating two-sided capacity (2026-07-16, 20260716020000): the
// sd_side_registered_count definer RPC lets a registering participant find
// out how full a side is even though their own RLS session can't see other
// participants' rows. The tenancy property CI must protect: a non-member of
// the event's org always gets 0 and can't probe another org's event sizes.
describe('speed-dating side capacity RPC', () => {
  it('a member counts a side they cannot directly read; a non-member always gets 0', async () => {
    const charlie = await signIn('charlie@demo.local') // demo-dating participant
    // alice organizes demo-dating, so she can set up a fixture event + seat.
    const { data: org } = await alice.from('orgs').select('id').eq('slug', 'demo-dating').single()
    const eventName = 'RLS Capacity Fixture'
    await alice.from('sd_events').delete().eq('org_id', org!.id).eq('name', eventName)
    const { data: event } = await alice
      .from('sd_events')
      .insert({
        org_id: org!.id,
        name: eventName,
        state: 'open',
        format: { sides: { a: { label: 'Men', capacity: 1 }, b: { label: 'Women', capacity: 1 } } },
      })
      .select('id')
      .single()
    const { data: dana } = await alice.from('profiles').select('user_id').eq('email', 'dana@demo.local').single()
    // Seat dana on side 'a' (organizer can insert any participant row).
    await alice.from('sd_participants').insert({
      org_id: org!.id,
      event_id: event!.id,
      user_id: dana!.user_id,
      pool_side: 'a',
      status: 'registered',
    })

    // charlie (a DIFFERENT member) can't directly see dana's row...
    const { count: direct } = await charlie
      .from('sd_participants')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', event!.id)
      .eq('pool_side', 'a')
      .eq('status', 'registered')
    expect(direct ?? 0).toBe(0)
    // ...but the RPC gives him the true count.
    const { data: memberCount } = await charlie.rpc('sd_side_registered_count', {
      check_event_id: event!.id,
      check_side: 'a',
    })
    expect(memberCount).toBe(1)

    // bob is not a member of demo-dating → always 0.
    const { data: nonMemberCount } = await bob.rpc('sd_side_registered_count', {
      check_event_id: event!.id,
      check_side: 'a',
    })
    expect(nonMemberCount).toBe(0)

    await alice.from('sd_events').delete().eq('id', event!.id) // cleanup
  })
})

// Module grants scope — slice 1 (2026-07-20, 20260720010000_module_grants_scope).
// Generalizes module_roles into SCOPED grants (user, position, scope) with a
// per-module entity tree and the ported two-branch hierarchy guard (docs/15
// §4/§4.1). The security properties CI must protect, all exercised as real
// users under RLS on the Platform Self-Test org + a dedicated 'usermodel-test'
// module_key so nothing collides with the shipped modules' seeded grants.
describe('module grants scope (slice 1)', () => {
  const MOD = 'usermodel-test'
  let orgId: string
  let demoBId: string
  const uid: Record<string, string> = {}
  const node: Record<string, string> = {}
  let charlie: SupabaseClient
  let dana: SupabaseClient
  let eve: SupabaseClient
  let frank: SupabaseClient

  const errored = (r: { error: unknown }) => r.error != null
  const okWrite = (r: { error: unknown }) => r.error == null
  // Params accept `undefined` because the fixture records are typed
  // Record<string,string> and tsconfig has noUncheckedIndexedAccess on; the
  // values are always present after beforeAll runs.
  const grant = (c: SupabaseClient, user: string | undefined, role: string, scope: string | null | undefined) =>
    c.from('module_roles').insert({ org_id: orgId, module_key: MOD, user_id: user, role, scope_ref: scope })

  beforeAll(async () => {
    charlie = await signIn('charlie@demo.local')
    dana = await signIn('dana@demo.local')
    eve = await signIn('eve@demo.local')
    frank = await signIn('frank@demo.local')

    orgId = (await alice.from('orgs').select('id').eq('slug', 'platform-self-test').single()).data!.id
    demoBId = (await bob.from('orgs').select('id').eq('slug', 'demo-b').single()).data!.id
    uid.alice = (await alice.auth.getUser()).data.user!.id
    for (const e of ['bob', 'charlie', 'dana', 'eve', 'frank']) {
      const { data } = await alice.rpc('org_find_user_by_email', {
        check_org_id: orgId,
        target_email: `${e}@demo.local`,
      })
      uid[e] = data![0].user_id as string
      await alice.from('org_members').upsert({ org_id: orgId, user_id: uid[e], role: 'member' })
      await acceptInviteAs(`${e}@demo.local`, orgId) // slice 3: pending -> active
    }
    // Clean fixtures then build the tree: STEM{Math,CS}, Humanities.
    await alice.from('module_roles').delete().eq('org_id', orgId).eq('module_key', MOD)
    await alice.from('module_scope_nodes').delete().eq('org_id', orgId)
    const mk = async (name: string, parent: string | null | undefined) =>
      (await alice
        .from('module_scope_nodes')
        .insert({ org_id: orgId, module_key: MOD, name, parent_id: parent })
        .select('id')
        .single()).data!.id as string
    node.stem = await mk('STEM', null)
    node.math = await mk('Math', node.stem)
    node.cs = await mk('CS', node.stem)
    node.humanities = await mk('Humanities', null)
  })

  afterAll(async () => {
    await alice.from('module_roles').delete().eq('org_id', orgId).eq('module_key', MOD)
    await alice.from('module_scope_nodes').delete().eq('org_id', orgId)
    await bob.from('module_scope_nodes').delete().eq('org_id', demoBId).eq('module_key', MOD)
    for (const e of ['bob', 'charlie', 'dana', 'eve', 'frank']) {
      await alice.from('org_members').delete().eq('org_id', orgId).eq('user_id', uid[e])
    }
  })

  it('path is trigger-computed (client value ignored) and re-parenting is blocked', async () => {
    const { data: injected } = await alice
      .from('module_scope_nodes')
      .insert({ org_id: orgId, module_key: MOD, name: 'Injected', parent_id: node.stem, path: 'HACKED/' })
      .select('id, path')
      .single()
    const { data: stemRow } = await alice.from('module_scope_nodes').select('path').eq('id', node.stem).single()
    expect(injected!.path.startsWith(stemRow!.path)).toBe(true)
    expect(injected!.path.includes('HACKED')).toBe(false)
    // Re-parenting / re-keying is deferred to slice 2 and rejected.
    expect(errored(await alice.from('module_scope_nodes').update({ parent_id: node.humanities }).eq('id', node.math))).toBe(true)
    expect(errored(await alice.from('module_scope_nodes').update({ module_key: 'x' }).eq('id', node.math))).toBe(true)
    await alice.from('module_scope_nodes').delete().eq('id', injected!.id)
  })

  it('scope-node tenancy is validated unconditionally (even for an org admin)', async () => {
    // A node in ANOTHER org, created by that org's own admin.
    const { data: bNode } = await bob
      .from('module_scope_nodes')
      .insert({ org_id: demoBId, module_key: MOD, name: 'B-root' })
      .select('id')
      .single()
    expect(errored(await grant(alice, uid.charlie, 'lead', bNode!.id))).toBe(true) // cross-org pointer
    // A node in a DIFFERENT module of the SAME org.
    const { data: omNode } = await alice
      .from('module_scope_nodes')
      .insert({ org_id: orgId, module_key: 'other-module', name: 'OM' })
      .select('id')
      .single()
    expect(errored(await grant(alice, uid.charlie, 'lead', omNode!.id))).toBe(true) // cross-module pointer
    expect(errored(await grant(alice, uid.charlie, 'lead', '00000000-0000-0000-0000-000000000000'))).toBe(true) // non-existent
  })

  it('slice 2a: multiple SCOPED grants per (user, role) are legal; duplicate GLOBAL is rejected', async () => {
    // alice (org owner) bypasses the ladder, so this exercises the surrogate-PK
    // + NULLS-NOT-DISTINCT identity index (20260723010000), not the guard.
    const g = (scope: string | null | undefined) =>
      alice.from('module_roles').insert({ org_id: orgId, module_key: MOD, user_id: uid.frank, role: 'position', scope_ref: scope })
    // Two DISTINCT scopes, same (user, role) — the new capability (a student in
    // Math AND Bio). Both allowed.
    expect(okWrite(await g(node.math))).toBe(true)
    expect(okWrite(await g(node.cs))).toBe(true)
    // Same scope again → duplicate identity rejected by the unique index.
    expect(errored(await g(node.math))).toBe(true)
    // One GLOBAL grant ok; a second GLOBAL (null scope) rejected — NULLS NOT
    // DISTINCT preserves the old "one global grant per (user, role)" invariant.
    expect(okWrite(await g(null))).toBe(true)
    expect(errored(await g(null))).toBe(true)
    // Upsert of the global grant on the identity target is idempotent (updates).
    expect(
      okWrite(
        await alice
          .from('module_roles')
          .upsert({ org_id: orgId, module_key: MOD, user_id: uid.frank, role: 'position' }, { onConflict: 'org_id,user_id,module_key,role,scope_ref' }),
      ),
    ).toBe(true)
    await alice.from('module_roles').delete().eq('org_id', orgId).eq('module_key', MOD).eq('user_id', uid.frank).eq('role', 'position')
  })

  it('two-branch guard: a non-admin coordinator manages only inside its scope', async () => {
    // Setup (via alice, who bypasses the ladder as org owner).
    expect(okWrite(await grant(alice, uid.eve, 'director', null))).toBe(true)
    expect(okWrite(await grant(alice, uid.bob, 'coordinator', node.stem))).toBe(true)

    // Branch A: director@global appoints coordinator@STEM.
    expect(okWrite(await grant(eve, uid.charlie, 'coordinator', node.stem))).toBe(true)
    // Branch A: coordinator@STEM appoints lead@Math (strictly outranks + covers).
    expect(okWrite(await grant(bob, uid.dana, 'lead', node.math))).toBe(true)
    // Branch A fails: STEM does not cover Humanities.
    expect(errored(await grant(bob, uid.frank, 'lead', node.humanities))).toBe(true)
    // Branch B: coordinator@STEM appoints coordinator@Math (same position, strictly inside).
    expect(okWrite(await grant(bob, uid.frank, 'coordinator', node.math))).toBe(true)
    // Peers: coordinator@STEM cannot appoint coordinator@STEM (same scope not strictly inside; equal rank).
    expect(errored(await grant(bob, uid.eve, 'coordinator', node.stem))).toBe(true)
    // Cannot exceed own rank; a node scope can never cover global.
    expect(errored(await grant(bob, uid.dana, 'director', null))).toBe(true)
    // Own-seat is untouchable.
    expect(
      errored(await bob.from('module_roles').update({ role: 'director' }).eq('org_id', orgId).eq('module_key', MOD).eq('user_id', uid.bob)),
    ).toBe(true)
    // Sibling non-touch: coordinator@Math (frank) cannot remove coordinator@STEM (charlie, its parent).
    expect(
      errored(await frank.from('module_roles').delete().eq('org_id', orgId).eq('module_key', MOD).eq('user_id', uid.charlie).eq('role', 'coordinator')),
    ).toBe(true)
  })

  it('branch B is Coordinator-tier only: a non-admin director cannot self-replicate directors (branch A still works) — founder 2026-07-22', async () => {
    // eve holds director@global (a non-admin org member, set up above). Branch
    // B once let a director mint another director at a sub-scope (global
    // strictly contains STEM); restricting branch B to the Coordinator tier
    // (rank 3) removes that self-replication — a Director must be org-appointed
    // (§2.2), not spawned by another Director. charlie's 'director' slot is free
    // (he only holds coordinator@STEM), so this reaches the guard, not the PK.
    expect(errored(await grant(eve, uid.charlie, 'director', node.stem))).toBe(true)
    // Branch A is untouched: a director still appoints the tier below it.
    // dana's 'coordinator' slot is free (she only holds lead@Math).
    expect(okWrite(await grant(eve, uid.dana, 'coordinator', node.humanities))).toBe(true)
    await alice.from('module_roles').delete().eq('org_id', orgId).eq('module_key', MOD).eq('user_id', uid.dana).eq('role', 'coordinator')
  })

  it('re-point escalation defense: UPDATE checks BOTH old and new scope (docs/15 §4.1 item 1)', async () => {
    // dana holds lead@Math, granted by bob (coordinator@STEM) in the prior test.
    const repoint = (scope: string | null | undefined) =>
      bob.from('module_roles').update({ scope_ref: scope }).eq('org_id', orgId).eq('module_key', MOD).eq('user_id', uid.dana).eq('role', 'lead')
    expect(errored(await repoint(null))).toBe(true) // -> global: rejected
    expect(errored(await repoint(node.humanities))).toBe(true) // -> outside STEM: rejected
    expect(okWrite(await repoint(node.cs))).toBe(true) // Math -> CS, both inside STEM: allowed
    await repoint(node.math) // restore
  })

  it('a scoped grant confers no GLOBAL authority through has_module_role', async () => {
    // dana holds only lead@Math (scoped); eve holds director@global.
    const danaScoped = await dana.rpc('has_module_role', { check_org_id: orgId, check_module_key: MOD, check_role: 'lead' })
    expect(danaScoped.data).toBe(false)
    const eveGlobal = await eve.rpc('has_module_role', { check_org_id: orgId, check_module_key: MOD, check_role: 'director' })
    expect(eveGlobal.data).toBe(true)
    // Additive: an ordinary global grant still resolves TRUE (unchanged behavior).
    await alice.from('module_roles').upsert({ org_id: orgId, user_id: uid.frank, module_key: 'stub', role: 'user' }, { onConflict: 'org_id,user_id,module_key,role,scope_ref' })
    const frankStub = await frank.rpc('has_module_role', { check_org_id: orgId, check_module_key: 'stub', check_role: 'user' })
    expect(frankStub.data).toBe(true)
    await alice.from('module_roles').delete().eq('org_id', orgId).eq('user_id', uid.frank).eq('module_key', 'stub').eq('role', 'user')
  })

  it('last-Director escape hatch: an org admin can empty the sole Director; a non-admin cannot', async () => {
    // eve is the sole director@global. A non-admin cannot remove her; the org owner can.
    expect(
      errored(await bob.from('module_roles').delete().eq('org_id', orgId).eq('module_key', MOD).eq('user_id', uid.eve).eq('role', 'director')),
    ).toBe(true)
    expect(
      okWrite(await alice.from('module_roles').delete().eq('org_id', orgId).eq('module_key', MOD).eq('user_id', uid.eve).eq('role', 'director')),
    ).toBe(true)
  })
})

// Slice 2b (20260724010000): classroom authority is scope-aware. A grant's
// reach is its scope subtree (global = whole module). Verified as REAL users.
describe('classroom scoped authority (slice 2b)', () => {
  let orgA: string
  const uid: Record<string, string> = {}
  const ids: Record<string, string> = {}
  let bobC: SupabaseClient // scoped professor @ CS course
  let charlieC: SupabaseClient // scoped student @ CS class
  let eveC: SupabaseClient // GLOBAL professor (non-admin) — proves global covers all

  const errored = (r: { error: unknown }) => r.error != null
  const okWrite = (r: { error: unknown }) => r.error == null
  const hw = (c: SupabaseClient, classId: string | undefined, title: string) =>
    c.from('cls_homeworks').insert({ org_id: orgA, class_id: classId, title })
  const grant = (c: SupabaseClient, user: string | undefined, role: string, scope: string | null | undefined) =>
    c.from('module_roles').insert({ org_id: orgA, user_id: user, module_key: 'classroom', role, scope_ref: scope })

  beforeAll(async () => {
    bobC = await signIn('bob@demo.local')
    charlieC = await signIn('charlie@demo.local')
    eveC = await signIn('eve@demo.local')
    orgA = (await alice.from('orgs').select('id').eq('slug', 'demo-a').single()).data!.id
    for (const e of ['bob', 'charlie', 'dana', 'eve']) {
      const { data } = await alice.rpc('org_find_user_by_email', { check_org_id: orgA, target_email: `${e}@demo.local` })
      uid[e] = data![0].user_id as string
      await alice.from('org_members').upsert({ org_id: orgA, user_id: uid[e], role: 'member' })
      await acceptInviteAs(`${e}@demo.local`, orgA) // slice 3: pending -> active
    }
    // Two isolated courses + a class each (as alice, org owner → bypass guard).
    const mkCourse = async (name: string) =>
      (await alice.from('cls_courses').insert({ org_id: orgA, name }).select('id, scope_node_id').single()).data!
    const cs = await mkCourse('RLS-CS')
    const bio = await mkCourse('RLS-Bio')
    ids.csCourse = cs.id as string
    ids.csCourseNode = cs.scope_node_id as string
    ids.bioCourse = bio.id as string
    ids.bioCourseNode = bio.scope_node_id as string
    const mkClass = async (courseId: string, name: string) =>
      (await alice.from('cls_classes').insert({ org_id: orgA, course_id: courseId, name }).select('id, scope_node_id').single()).data!
    const csClass = await mkClass(ids.csCourse, 'RLS-CS-Fall')
    const bioClass = await mkClass(ids.bioCourse, 'RLS-Bio-Fall')
    ids.csClass = csClass.id as string
    ids.csClassNode = csClass.scope_node_id as string
    ids.bioClass = bioClass.id as string
    ids.bioClassNode = bioClass.scope_node_id as string
    await alice.from('module_roles').insert([
      { org_id: orgA, user_id: uid.bob, module_key: 'classroom', role: 'professor', scope_ref: ids.csCourseNode },
      { org_id: orgA, user_id: uid.charlie, module_key: 'classroom', role: 'student', scope_ref: ids.csClassNode },
      { org_id: orgA, user_id: uid.eve, module_key: 'classroom', role: 'professor', scope_ref: null },
    ])
  })

  afterAll(async () => {
    await alice.from('module_roles').delete().eq('org_id', orgA).eq('module_key', 'classroom').eq('user_id', uid.eve).is('scope_ref', null)
    await alice.from('cls_courses').delete().in('id', [ids.csCourse, ids.bioCourse]) // cascades classes/homeworks
    // Deleting the course nodes cascades child class nodes AND every scoped grant
    // pinned to them (module_roles.scope_ref ON DELETE CASCADE).
    await alice.from('module_scope_nodes').delete().in('id', [ids.csCourseNode, ids.bioCourseNode])
    await alice.from('org_members').delete().eq('org_id', orgA).eq('user_id', uid.bob)
    await alice.from('org_members').delete().eq('org_id', orgA).eq('user_id', uid.eve)
  })

  it('a scoped professor manages only their own course subtree', async () => {
    // bob = professor@CS course → covers the CS class (course is its ancestor).
    expect(okWrite(await hw(bobC, ids.csClass, 'CS HW'))).toBe(true)
    // …but NOT the Bio class (different subtree).
    expect(errored(await hw(bobC, ids.bioClass, 'Bio HW (should fail)'))).toBe(true)
    // Scoped read: sees the CS course row, not the Bio course row.
    expect((await bobC.from('cls_courses').select('id').eq('id', ids.csCourse)).data?.length).toBe(1)
    expect((await bobC.from('cls_courses').select('id').eq('id', ids.bioCourse)).data?.length).toBe(0)
  })

  it('a GLOBAL professor (non-admin) covers every class — unchanged behavior', async () => {
    // eve holds professor@global (scope null) and is NOT an org admin.
    expect(okWrite(await hw(eveC, ids.csClass, 'CS HW by global prof'))).toBe(true)
    expect(okWrite(await hw(eveC, ids.bioClass, 'Bio HW by global prof'))).toBe(true)
  })

  it('a non-admin professor can create a course + class (review Finding 1 — no self-ref regression)', async () => {
    // eve = GLOBAL professor, NOT an org admin. Course INSERT gates on coarse
    // staff; class INSERT on covering the parent course. No RETURNING (the app
    // inserts without it), so the SELECT policy's self-join is never hit.
    expect(okWrite(await eveC.from('cls_courses').insert({ org_id: orgA, name: 'RLS-EveCourse' }))).toBe(true)
    const { data: c } = await alice.from('cls_courses').select('id, scope_node_id').eq('org_id', orgA).eq('name', 'RLS-EveCourse').single()
    expect(okWrite(await eveC.from('cls_classes').insert({ org_id: orgA, course_id: c!.id, name: 'RLS-EveClass' }))).toBe(true)
    await alice.from('cls_courses').delete().eq('id', c!.id) // cascades class
    await alice.from('module_scope_nodes').delete().eq('id', c!.scope_node_id) // cascades child class node
  })

  it('a scoped student sees only their own class', async () => {
    // charlie = student@CS class → a class member of CS, not Bio.
    expect((await charlieC.from('cls_classes').select('id').eq('id', ids.csClass)).data?.length).toBe(1)
    expect((await charlieC.from('cls_classes').select('id').eq('id', ids.bioClass)).data?.length).toBe(0)
  })

  it('enrollment guard: a scoped professor enrolls in-scope, cannot mint a co-professor or reach another course', async () => {
    // bob (professor@CS course) enrolls dana as a student of the CS class.
    expect(okWrite(await grant(bobC, uid.dana, 'student', ids.csClassNode))).toBe(true)
    // …cannot mint another professor (co-instructor) — needs a Coordinator/admin.
    expect(errored(await grant(bobC, uid.dana, 'professor', ids.csClassNode))).toBe(true)
    // …cannot enroll into the Bio class (outside their scope).
    expect(errored(await grant(bobC, uid.dana, 'student', ids.bioClassNode))).toBe(true)
  })
})

describe('nail-salon scoped authority (slice 2 — 20260726010000)', () => {
  // Mirrors the classroom slice-2b block: a LOCATION entity tree replaces
  // course→class. alice is the salon org OWNER (bypasses the ladder via
  // is_org_admin), so she does all setup. Every assertion runs as the real
  // scoped user. sal_locations gains scope_node_id (each location is a root
  // node minted by a BEFORE-INSERT trigger); sal_can_manage_location /
  // sal_can_operate_location gate per-row writes/reads by scope coverage, and
  // a GLOBAL grant (scope_ref null) still covers every location unchanged.
  let salonOrg: string
  const uid: Record<string, string> = {}
  const ids: Record<string, string> = {}
  let charlieC: SupabaseClient // GLOBAL manager (non-admin) — proves global covers all

  const errored = (r: { error: unknown }) => r.error != null
  const okWrite = (r: { error: unknown }) => r.error == null
  // Manage-tier write probe. sal_services write is manager-only (no operate
  // policy) and location-scoped via sal_services_write_manage. approx_duration
  // is NOT NULL with no default, so it must be supplied. org_id is re-derived
  // from location_id by the scope-sync trigger; we pass the real one anyway.
  const svc = (c: SupabaseClient, locId: string | undefined, name: string) =>
    c.from('sal_services').insert({ org_id: salonOrg, location_id: locId, name, price: 10, approx_duration_minutes: 30 })
  const grant = (c: SupabaseClient, user: string | undefined, role: string, scope: string | null | undefined) =>
    c.from('module_roles').insert({ org_id: salonOrg, user_id: user, module_key: 'nail-salon', role, scope_ref: scope })

  beforeAll(async () => {
    charlieC = await signIn('charlie@demo.local')
    salonOrg = (await alice.from('orgs').select('id').eq('slug', 'demo-salon').single()).data!.id
    for (const e of ['bob', 'charlie', 'dana']) {
      const { data } = await alice.rpc('org_find_user_by_email', { check_org_id: salonOrg, target_email: `${e}@demo.local` })
      uid[e] = data![0].user_id as string
    }
    // bob is not a salon member (he's in demo-b); charlie/dana are seeded
    // salon members already. Add only bob, as alice (org owner).
    await alice.from('org_members').upsert({ org_id: salonOrg, user_id: uid.bob, role: 'member' })
    await acceptInviteAs('bob@demo.local', salonOrg) // slice 3: pending -> active

    // Two fresh locations (as alice, owner → bypass). The BEFORE-INSERT trigger
    // mints each location's root scope node; capture both ids + node ids.
    const mkLoc = async (name: string) =>
      (await alice.from('sal_locations').insert({ org_id: salonOrg, name }).select('id, scope_node_id').single()).data!
    const l1 = await mkLoc('RLS-Loc-1')
    const l2 = await mkLoc('RLS-Loc-2')
    ids.loc1 = l1.id as string
    ids.loc1Node = l1.scope_node_id as string
    ids.loc2 = l2.id as string
    ids.loc2Node = l2.scope_node_id as string

    // One expense per location, for the location-scoped READ assertion.
    const mkExp = async (locId: string, cat: string) =>
      (await alice.from('sal_expenses').insert({ org_id: salonOrg, location_id: locId, category: cat, amount: 5 }).select('id').single()).data!
    ids.exp1 = (await mkExp(ids.loc1, 'RLS-exp-1')).id as string
    ids.exp2 = (await mkExp(ids.loc2, 'RLS-exp-2')).id as string

    // Grants (as alice, org owner → bypasses the ladder guard).
    await alice.from('module_roles').insert([
      { org_id: salonOrg, user_id: uid.bob, module_key: 'nail-salon', role: 'manager', scope_ref: ids.loc1Node }, // scoped @ loc1
      { org_id: salonOrg, user_id: uid.charlie, module_key: 'nail-salon', role: 'manager', scope_ref: null }, // GLOBAL, non-admin
    ])
  })

  afterAll(async () => {
    // charlie's GLOBAL manager grant (scope null) is not node-cascaded — delete
    // it explicitly, leaving his seeded 'customer' grant (also scope null) intact.
    await alice.from('module_roles').delete().eq('org_id', salonOrg).eq('module_key', 'nail-salon').eq('user_id', uid.charlie).eq('role', 'manager').is('scope_ref', null)
    await alice.from('sal_locations').delete().in('id', [ids.loc1, ids.loc2]) // cascades services/expenses
    // Deleting the location nodes cascades every scoped grant pinned to them
    // (bob manager@loc1, dana cashier@loc1 — module_roles.scope_ref ON DELETE CASCADE).
    await alice.from('module_scope_nodes').delete().in('id', [ids.loc1Node, ids.loc2Node])
    await alice.from('org_members').delete().eq('org_id', salonOrg).eq('user_id', uid.bob)
  })

  it('a scoped manager acts only within its own location, not a sibling', async () => {
    // bob = manager@loc1 → manages loc1's manage-tier rows…
    expect(okWrite(await svc(bob, ids.loc1, 'RLS-svc-loc1'))).toBe(true)
    // …but NOT loc2 (different location subtree — cross-location isolation).
    expect(errored(await svc(bob, ids.loc2, 'RLS-svc-loc2 (should fail)'))).toBe(true)
    // Location-scoped read (sal_expenses): sees loc1's expense, not loc2's.
    expect((await bob.from('sal_expenses').select('id').eq('id', ids.exp1)).data?.length).toBe(1)
    expect((await bob.from('sal_expenses').select('id').eq('id', ids.exp2)).data?.length).toBe(0)
  })

  it('a GLOBAL manager (non-admin) manages every location — unchanged behavior', async () => {
    // charlie holds manager@global (scope null) and is NOT an org admin.
    expect(okWrite(await svc(charlieC, ids.loc1, 'RLS-svc-global-1'))).toBe(true)
    expect(okWrite(await svc(charlieC, ids.loc2, 'RLS-svc-global-2'))).toBe(true)
  })

  it('enrollment guard: a scoped manager grants in-scope operate staff, cannot mint a co-manager or reach a sibling', async () => {
    // bob (manager@loc1, rank 2) grants dana a cashier (rank 1) scoped to loc1:
    // branch A — strictly outranks + covers loc1. Insert without RETURNING.
    expect(okWrite(await grant(bob, uid.dana, 'cashier', ids.loc1Node))).toBe(true)
    // …cannot mint another manager at loc1 (branch A 2>2 false; branch B is
    // rank-3/Coordinator-tier only, and needs strict containment anyway).
    expect(errored(await grant(bob, uid.dana, 'manager', ids.loc1Node))).toBe(true)
    // …cannot grant anything at loc2 (scope not covered by a loc1 grant).
    expect(errored(await grant(bob, uid.dana, 'cashier', ids.loc2Node))).toBe(true)
  })
})

describe('speed-dating scoped authority (slice 2 — 20260726030000)', () => {
  // Mirrors the nail-salon slice-2 block: an EVENT entity tree replaces
  // location. alice is the demo-dating org OWNER (bypasses the ladder via
  // is_org_admin), so she does all setup; every assertion runs as the real
  // scoped user. sd_events gains scope_node_id (each event a root node minted by
  // a BEFORE-INSERT trigger); the PRECISE sd_can_organize_event /
  // sd_can_staff_event_of gate per-row writes/reads + the reveal RPC by scope
  // coverage of a SPECIFIC event, while a GLOBAL grant (scope_ref null) still
  // covers every event unchanged.
  let datingOrg: string
  const uid: Record<string, string> = {}
  const ids: Record<string, string> = {}
  let danaC: SupabaseClient // GLOBAL organizer (non-admin) — proves global covers all

  const errored = (r: { error: unknown }) => r.error != null
  const okWrite = (r: { error: unknown }) => r.error == null
  // Event-scoped write probe. sd_rounds is the simplest organize-write table (its
  // _write_organize policy gates on sd_can_organize_event(org_id, event_id)).
  // round_number is NOT NULL (check > 0) with no default, so it must be supplied;
  // org_id + event_id are re-derived from the round's event by the scope-sync
  // trigger, we pass the real ones anyway.
  const round = (c: SupabaseClient, eventId: string | undefined, n: number) =>
    c.from('sd_rounds').insert({ org_id: datingOrg, event_id: eventId, round_number: n })
  const grant = (c: SupabaseClient, user: string | undefined, role: string, scope: string | null | undefined) =>
    c.from('module_roles').insert({ org_id: datingOrg, user_id: user, module_key: 'speed-dating', role, scope_ref: scope })

  beforeAll(async () => {
    danaC = await signIn('dana@demo.local')
    datingOrg = (await alice.from('orgs').select('id').eq('slug', 'demo-dating').single()).data!.id
    for (const e of ['bob', 'dana', 'frank']) {
      const { data } = await alice.rpc('org_find_user_by_email', { check_org_id: datingOrg, target_email: `${e}@demo.local` })
      uid[e] = data![0].user_id as string
    }
    // dana/frank are seeded demo-dating members (participants); bob is not (he's
    // in demo-b). Add only bob, as alice (org owner).
    await alice.from('org_members').upsert({ org_id: datingOrg, user_id: uid.bob, role: 'member' })
    await acceptInviteAs('bob@demo.local', datingOrg) // slice 3: pending -> active

    // Two fresh events (as alice, owner → bypass). The BEFORE-INSERT trigger mints
    // each event's root scope node; capture both ids + node ids.
    const mkEvent = async (name: string) =>
      (await alice.from('sd_events').insert({ org_id: datingOrg, name, state: 'open' }).select('id, scope_node_id').single()).data!
    const e1 = await mkEvent('RLS-Event-1')
    const e2 = await mkEvent('RLS-Event-2')
    ids.event1 = e1.id as string
    ids.event1Node = e1.scope_node_id as string
    ids.event2 = e2.id as string
    ids.event2Node = e2.scope_node_id as string

    // One round per event, for the event-scoped READ assertion.
    const mkRound = async (eventId: string, n: number) =>
      (await alice.from('sd_rounds').insert({ org_id: datingOrg, event_id: eventId, round_number: n }).select('id').single()).data!
    ids.round1 = (await mkRound(ids.event1, 1)).id as string
    ids.round2 = (await mkRound(ids.event2, 1)).id as string

    // Grants (as alice, org owner → bypasses the ladder guard).
    await alice.from('module_roles').insert([
      { org_id: datingOrg, user_id: uid.bob, module_key: 'speed-dating', role: 'organizer', scope_ref: ids.event1Node }, // scoped @ event1
      { org_id: datingOrg, user_id: uid.dana, module_key: 'speed-dating', role: 'organizer', scope_ref: null }, // GLOBAL, non-admin
    ])
  })

  afterAll(async () => {
    // dana's GLOBAL organizer grant (scope null) is not node-cascaded — delete it
    // explicitly, leaving her seeded 'participant' grant (also scope null) intact.
    await alice.from('module_roles').delete().eq('org_id', datingOrg).eq('module_key', 'speed-dating').eq('user_id', uid.dana).eq('role', 'organizer').is('scope_ref', null)
    await alice.from('sd_events').delete().in('id', [ids.event1, ids.event2]) // cascades rounds/participants/etc.
    // Deleting the event nodes cascades every scoped grant pinned to them
    // (bob organizer@event1, frank host@event1 — module_roles.scope_ref ON DELETE CASCADE).
    await alice.from('module_scope_nodes').delete().in('id', [ids.event1Node, ids.event2Node])
    await alice.from('org_members').delete().eq('org_id', datingOrg).eq('user_id', uid.bob)
  })

  it('a scoped organizer runs only its own event, not a sibling', async () => {
    // bob = organizer@event1 → writes event1's organize-tier rows…
    expect(okWrite(await round(bob, ids.event1, 2))).toBe(true)
    // …but NOT event2 (different event subtree — cross-event isolation).
    expect(errored(await round(bob, ids.event2, 2))).toBe(true)
    // Event-scoped read (sd_rounds): sees event1's round, not event2's.
    expect((await bob.from('sd_rounds').select('id').eq('id', ids.round1)).data?.length).toBe(1)
    expect((await bob.from('sd_rounds').select('id').eq('id', ids.round2)).data?.length).toBe(0)
  })

  it('a GLOBAL organizer (non-admin) runs every event — unchanged behavior', async () => {
    // dana holds organizer@global (scope null) and is NOT an org admin.
    expect(okWrite(await round(danaC, ids.event1, 3))).toBe(true)
    expect(okWrite(await round(danaC, ids.event2, 3))).toBe(true)
  })

  it('the mutual-interest reveal is event-scoped (privacy-critical)', async () => {
    // bob = organizer@event1 → may reveal event1's matches (a count of 0 is fine)…
    expect(okWrite(await bob.rpc('sd_reveal_matches', { check_event_id: ids.event1 }))).toBe(true)
    // …but is REJECTED for event2 ('Only an organizer may reveal matches').
    expect(errored(await bob.rpc('sd_reveal_matches', { check_event_id: ids.event2 }))).toBe(true)
  })

  it('enrollment guard: a scoped organizer grants in-scope staff, cannot mint a co-organizer or reach a sibling', async () => {
    // bob (organizer@event1, rank 2) grants frank a host (rank 1) scoped to event1:
    // branch A — strictly outranks + covers event1. Insert without RETURNING.
    expect(okWrite(await grant(bob, uid.frank, 'host', ids.event1Node))).toBe(true)
    // …cannot mint another organizer at event1 (branch A 2>2 false; branch B is
    // rank-3/Coordinator-tier only, and needs strict containment anyway).
    expect(errored(await grant(bob, uid.frank, 'organizer', ids.event1Node))).toBe(true)
    // …cannot grant anything at event2 (scope not covered by an event1 grant).
    expect(errored(await grant(bob, uid.frank, 'host', ids.event2Node))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ACL hardening (20260728010000) — the `anon` role.
//
// WHY THIS BLOCK EXISTS: every other test in this file signs in first, so until
// now the suite had never once exercised the `anon` (not-logged-in) role.
//
// READ THIS BEFORE TRUSTING IT: these tests run against LOCAL, and local was never
// the vulnerable side. Local `anon` has only ever held `Dxtm` (TRUNCATE/REFERENCES/
// TRIGGER/MAINTAIN — no DML), and 20260722010000's `revoke ... from public` did
// close the oracle locally. So every assertion here would have been GREEN on local
// throughout the entire window prod sat open. **This block does NOT close the
// 2026-07-22 class of gap and must not be treated as if it does** — only
// `scripts/verify-acl-hardening.ts` run against PROD can, because the divergence
// lives in prod's ALTER DEFAULT PRIVILEGES, which local does not have.
//
// What this block IS good for: locking the invariant in place going forward. It
// fails loudly if a future migration re-grants anon something on local, or if the
// public no-login surface regresses. That is a ratchet, not a proof about prod.
//
// These run over PostgREST with the anon key and NO sign-in — the same surface a
// stranger on the internet reaches. Two distinct things are asserted:
//   * the SEMANTIC invariant (a stranger obtains and changes nothing), which held
//     before this migration too, via RLS; and
//   * the MECHANISM (a stranger is now refused at the privilege layer, before RL
//     is consulted), which is what this migration actually changed. Asserting
//     only the first would pass whether or not the migration worked.
describe('acl hardening: the anon role (20260728010000)', () => {
  // A client with the anon key and no session -> Postgres role `anon`.
  const anonClient = () => createClient(url, anonKey, { auth: { persistSession: false } })

  // One representative table per module + the platform core tables. Each carries a
  // column that REALLY EXISTS on it, because a filter/payload naming a non-existent
  // column makes PostgREST fail with PGRST204/42703 before the request ever reaches
  // the privilege check — which would make the write assertions below untestable.
  // (Four of these have no `id` column at all: profiles, org_members, org_modules,
  // syn_published_weeks.)
  const TABLES: { name: string; key: string }[] = [
    { name: 'profiles', key: 'user_id' },
    { name: 'orgs', key: 'id' },
    { name: 'org_members', key: 'org_id' },
    { name: 'org_modules', key: 'org_id' },
    { name: 'module_roles', key: 'org_id' },
    { name: 'module_scope_nodes', key: 'id' },
    { name: 'job_requests', key: 'id' },
    { name: 'cls_classes', key: 'id' },
    { name: 'cls_submissions', key: 'id' },
    { name: 'mm_questions', key: 'id' },
    { name: 'sal_appointments', key: 'id' },
    { name: 'sd_events', key: 'id' },
    { name: 'vm_conversations', key: 'id' },
    { name: 'syn_published_weeks', key: 'org_id' },
    { name: 'smp_projects', key: 'id' },
  ]

  // A TABLE-privilege denial and an RLS `WITH CHECK` violation are BOTH SQLSTATE
  // 42501, so the code alone cannot tell them apart on a write — and conflating
  // them is exactly the false confidence this block is supposed to rule out. The
  // message disambiguates: "permission denied for table X" (privilege) vs "new row
  // violates row-level security policy" (RLS). Require the former and exclude the
  // latter, so an RLS-only refusal can never make these tests green.
  const isPrivilegeDenied = (error: { code?: string; message?: string } | null) => {
    if (!error) return false
    const msg = error.message ?? ''
    return (
      error.code === '42501' &&
      /permission denied for (table|relation|function|view)/i.test(msg) &&
      !/row-level security/i.test(msg)
    )
  }

  it('a stranger can read no rows from any table (semantic invariant)', async () => {
    const anon = anonClient()
    for (const { name } of TABLES) {
      const { data, error } = await anon.from(name).select('*').limit(1)
      // Either refused outright, or allowed through but yielding nothing.
      const leaked = !error && Array.isArray(data) && data.length > 0
      expect(leaked, `anon read rows from ${name}`).toBe(false)
    }
  })

  it('a stranger is refused at the PRIVILEGE layer, not merely filtered by RLS', async () => {
    const anon = anonClient()
    for (const { name } of TABLES) {
      const { error } = await anon.from(name).select('*').limit(1)
      // On a SELECT this distinction is unambiguous: RLS filters silently and
      // returns 200/[], so a 42501 here can only be the table privilege.
      expect(isPrivilegeDenied(error), `${name}: expected permission-denied, got ${JSON.stringify(error)}`).toBe(true)
    }
  })

  it('a stranger cannot insert, update or delete anywhere', async () => {
    const anon = anonClient()
    // Deliberately assert the PRIVILEGE denial rather than merely "an error".
    // A bare {id} insert would also fail on a not-null/constraint violation even
    // WITH permission, and an UPDATE/DELETE matching no rows succeeds with no
    // error at all — so a truthiness check here would pass vacuously and give
    // false confidence that the revoke worked.
    const beef = '00000000-0000-4000-8000-00000000beef'
    for (const { name, key } of TABLES) {
      // The payload key is computed per table, so it can't be checked against the
      // generated row types — cast it. The VALUE of the payload is irrelevant here:
      // a table-privilege denial is raised before the row is ever validated.
      const payload = { [key]: beef } as never
      const ins = await anon.from(name).insert(payload)
      expect(isPrivilegeDenied(ins.error), `${name}: anon insert not privilege-denied (${JSON.stringify(ins.error)})`).toBe(true)

      const upd = await anon.from(name).update(payload).eq(key, beef)
      expect(isPrivilegeDenied(upd.error), `${name}: anon update not privilege-denied (${JSON.stringify(upd.error)})`).toBe(true)

      const del = await anon.from(name).delete().eq(key, beef)
      expect(isPrivilegeDenied(del.error), `${name}: anon delete not privilege-denied (${JSON.stringify(del.error)})`).toBe(true)
    }
  })

  it('a stranger cannot call platform authority functions', async () => {
    const anon = anonClient()
    // Authority predicates and privileged RPCs alike must be closed to anon.
    const closed: [string, Record<string, unknown>][] = [
      ['is_org_member', { check_org_id: '00000000-0000-4000-8000-00000000beef' }],
      ['is_org_admin', { check_org_id: '00000000-0000-4000-8000-00000000beef' }],
      ['is_superadmin', {}],
      ['has_module_role', { check_org_id: '00000000-0000-4000-8000-00000000beef', check_module_key: 'classroom', check_role: 'lecturer' }],
      ['org_my_pending_invites', {}],
      ['org_accept_invite', { check_org_id: '00000000-0000-4000-8000-00000000beef' }],
      ['module_scope_covers', { ancestor: '00000000-0000-4000-8000-00000000beef', descendant: '00000000-0000-4000-8000-00000000beef' }],
    ]
    for (const [fn, args] of closed) {
      const { error } = await anon.rpc(fn, args)
      expect(isPrivilegeDenied(error), `${fn}: expected permission-denied, got ${JSON.stringify(error)}`).toBe(true)
    }
  })

  it('the public no-login schedule surface still works for a stranger', async () => {
    const anon = anonClient()
    // This is the ENTIRE intended anon surface — two read-only definer functions.
    const { data: index, error: e1 } = await anon.rpc('syn_public_weeks', { p_org_slug: 'demo-shul' })
    expect(e1, `syn_public_weeks failed for anon: ${e1?.message}`).toBeNull()
    expect(Array.isArray(index?.weeks)).toBe(true)
    expect(index.weeks.length).toBeGreaterThan(0)

    const { data: week, error: e2 } = await anon.rpc('syn_public_week', {
      p_org_slug: 'demo-shul',
      p_week_start: index.weeks[0],
    })
    expect(e2, `syn_public_week failed for anon: ${e2?.message}`).toBeNull()
    expect(week?.org?.name).toBeTruthy()
  })

  it('an unpublished org exposes nothing through the public surface', async () => {
    const anon = anonClient()
    // Same function, an org with no published weeks -> null, not a leak.
    const { data, error } = await anon.rpc('syn_public_weeks', { p_org_slug: 'demo-a' })
    expect(error).toBeNull()
    expect(data).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// User-model slice 5 — VIEW-AS (docs/15 §8 + §8.1). 20260731010000.
//
// Three things need proving, and only one of them is about the new table.
//
// 1. THE COMPLETENESS CHECK IS REAL (§8.1 point 11). The TypeScript mapped type
//    in packages/platform/src/view-as.ts fails `pnpm typecheck` on an
//    undeclared rank-differential pair — but it is only as trustworthy as the
//    TS rank table it is keyed on, and the AUTHORITATIVE rank lives in SQL's
//    module_position_rank(). A SQL-only rank remap — exactly the "one-line
//    migration with no backfill" the amendment was written to catch — would
//    NOT fail that type. The parity test below is what closes that gap; the
//    mapped type alone does not deliver the amendment's guarantee.
//
// 2. THE PERSONAL / EXCLUDED SPLIT IS HONEST (§8.1 point 1). "Personal layer"
//    means RLS-UNREADABLE to higher positions, never merely UI-hidden, and a
//    personal marking on a staff-readable table is a spec violation. So the
//    split is asserted in BOTH directions: every `personal` entry must be
//    unreadable by a position holding a mode-2 edge in, and every `excluded`
//    entry must be readable by it — proving the author was not quietly calling
//    an ambiently-readable table "personal" to dodge the rule.
//
// 3. THE SESSION LOG IS A FLOOR, NOT A RECORD. The guard trigger enforces
//    strict rank + scope coverage independently of the TypeScript edge table,
//    so a bug in the app layer cannot mint an impersonation session.
// ---------------------------------------------------------------------------
describe('view-as: the rank-differential completeness check (slice 5)', () => {
  it('every declared TS rank matches SQL module_position_rank() — the check keys on SQL, not on itself', async () => {
    for (const mod of moduleRegistry) {
      for (const [role, tsRank] of Object.entries(mod.viewAs.positions)) {
        const { data, error } = await alice.rpc('module_position_rank', {
          module_key: mod.key,
          role,
        })
        expect(error, `${mod.key}/${role}: ${JSON.stringify(error)}`).toBeNull()
        expect(data, `${mod.key}/${role}: TS says ${tsRank}, SQL says ${data}`).toBe(tsRank)
      }
    }
  })

  it('every module declares a position for exactly its manifest roles', () => {
    for (const mod of moduleRegistry) {
      expect(Object.keys(mod.viewAs.positions).sort(), `${mod.key}`).toEqual([...mod.roles].sort())
    }
  })

  it('every module passes the runtime completeness check (the backstop behind the mapped type)', () => {
    const problems = moduleRegistry.flatMap((m) => viewAsCompleteness(m.key, m.viewAs))
    expect(problems.map((p) => `${p.moduleKey}: ${p.problem}`)).toEqual([])
  })

  it('equal-rank pairs carry no entry at all — GA and student stay peers for free', () => {
    const cls = getModule('classroom')!.viewAs
    expect(cls.positions.ga).toBe(cls.positions.student)
    expect(cls.edges.ga).toBeUndefined()
    expect(cls.edges.student).toBeUndefined()
  })

  it('SQL module_view_as_edge() agrees with the TypeScript edge map for EVERY ordered pair', async () => {
    // The second gate (docs/03 #17). The manifest is the authoritative
    // declaration, but `authenticated` can reach view_as_sessions through
    // PostgREST directly, so the database mirrors the ON pairs and the guard
    // enforces them. These two copies must never drift — including on pairs
    // that are OFF, where a stray SQL `true` would silently unban an edge the
    // manifest forbids.
    for (const mod of moduleRegistry) {
      const positions = Object.keys(mod.viewAs.positions)
      for (const a of positions) {
        for (const b of positions) {
          const ts = mod.viewAs.edges[a]?.[b]?.mode2 === true
          const { data, error } = await alice.rpc('module_view_as_edge', {
            module_key: mod.key,
            from_role: a,
            to_role: b,
          })
          expect(error, `${mod.key} ${a}->${b}: ${JSON.stringify(error)}`).toBeNull()
          expect(data, `${mod.key} ${a}->${b}: TS mode2=${ts}, SQL=${data}`).toBe(ts)
        }
      }
    }
  })

  it('every registered module has a populated declaration — no module can opt out of the check', () => {
    for (const mod of moduleRegistry) {
      expect(mod.viewAs, `${mod.key} has no viewAs declaration`).toBeDefined()
      expect(Object.keys(mod.viewAs.positions).length, `${mod.key} declares no positions`).toBeGreaterThan(0)
    }
  })

  it('speed-dating end-user ban is expressed as pairs, not a second mechanism (point 7 subsumed)', () => {
    const sd = getModule('speed-dating')!.viewAs
    for (const a of ['admin', 'organizer', 'host']) {
      const edge = sd.edges[a]?.participant
      expect(edge, `${a} -> participant must be declared`).toBeDefined()
      expect(edge!.mode1).toBe(false)
      expect(edge!.mode2).toBe(false)
    }
  })
})

describe('view-as: the personal / excluded split is honest (slice 5)', () => {
  // Fixtures for the unreadable-by-position check. A clean seed has zero
  // cls_review_assignments and zero cls_survey_answers, so without these the
  // "a GA cannot read this" assertions would pass because the tables are
  // EMPTY, not because RLS hides them — which is exactly the vacuity the
  // control inside that test exists to refuse. (Discovered the honest way:
  // the control failed the first time it ran on a fresh database. An earlier
  // manual row count had been contaminated by e2e leftovers.)
  const fixture: { assignmentId?: string; surveyId?: string } = {}

  beforeAll(async () => {
    const orgId = (await alice.from('orgs').select('id').eq('slug', 'demo-a').single()).data!.id
    const sub = (
      await alice.from('cls_submissions').select('id, class_id, homework_id, student_id').limit(2)
    ).data!
    const target = sub[0]!
    const reviewer = sub[1]?.student_id ?? target.student_id

    // ORDER-INDEPENDENT ON PURPOSE (hardened 2026-08-05). All this fixture owes
    // the tests below is that cls_review_assignments is NOT EMPTY, so the
    // "a GA cannot read it" assertion is not vacuous. It used to insist on
    // inserting its own row, which made the whole describe fail with a duplicate
    // key whenever the e2e suite had run first without a reset — the classroom
    // grading-workflow test creates a peer-review assignment for the same
    // (homework, reviewer, submission) triple. That reads as a broken security
    // test when it is only a stale-state collision (the trap CLAUDE.md's
    // gotchas list records). So: insert if we can, otherwise adopt whatever row
    // is already there and leave it alone in afterAll.
    const asg = await alice
      .from('cls_review_assignments')
      .insert({
        org_id: orgId,
        class_id: target.class_id,
        homework_id: target.homework_id,
        submission_id: target.id,
        reviewer_id: reviewer,
      })
      .select('id')
      .single()
    if (asg.error) {
      if (!/duplicate key/i.test(asg.error.message)) {
        throw new Error(`view-as fixture (review assignment): ${asg.error.message}`)
      }
      const existing = await alice.from('cls_review_assignments').select('id').limit(1)
      if ((existing.data ?? []).length === 0) {
        throw new Error(
          'view-as fixture: the review-assignment insert reported a duplicate but no row is ' +
            'readable — the non-emptiness control below would be vacuous',
        )
      }
      // Deliberately NOT recorded in `fixture`, so afterAll does not delete a
      // row this run did not create.
    } else {
      fixture.assignmentId = asg.data.id as string
    }

    const svy = await alice
      .from('cls_surveys')
      .insert({ org_id: orgId, class_id: target.class_id, question: 'View-as fixture survey?' })
      .select('id')
      .single()
    if (svy.error) throw new Error(`view-as fixture (survey): ${svy.error.message}`)
    fixture.surveyId = svy.data.id as string

    // The answer must be written BY its owner — cls_survey_answers is own-row.
    const charlie = await signIn('charlie@demo.local')
    const ans = await charlie
      .from('cls_survey_answers')
      .insert({
        org_id: orgId,
        class_id: target.class_id,
        survey_id: fixture.surveyId,
        user_id: (await charlie.auth.getUser()).data.user!.id,
        answer: 'fixture',
      })
    if (ans.error) throw new Error(`view-as fixture (survey answer): ${ans.error.message}`)
  })

  afterAll(async () => {
    if (fixture.assignmentId) {
      await alice.from('cls_review_assignments').delete().eq('id', fixture.assignmentId)
    }
    // Deleting the survey cascades its answers.
    if (fixture.surveyId) await alice.from('cls_surveys').delete().eq('id', fixture.surveyId)
  })

  // Alice is the seeded GLOBAL professor in demo-a, i.e. the position holding a
  // mode-2 edge into both ga and student.
  it('every table marked PERSONAL really is unreadable by the position that can view-as into it', async () => {
    for (const mod of moduleRegistry) {
      for (const targets of Object.values(mod.viewAs.edges)) {
        for (const [target, edge] of Object.entries(targets)) {
          if (!edge.mode2) continue
          for (const p of mod.viewAs.surfaces[target]?.personal ?? []) {
            const { data, error } = await alice.from(p.table).select('*').limit(1)
            const readable = !error && (data ?? []).length > 0
            expect(
              readable,
              `${mod.key}: ${p.table} is marked personal for ${target} but the viewer reads rows from it`,
            ).toBe(false)
          }
        }
      }
    }
  })

  it('every table marked EXCLUDED really IS ambiently readable — so it was right not to call it personal', async () => {
    // Loops EVERY surface of every module with edges on, not just `student`.
    // The 2026-07-31 review found the first version hardcoded `student` and so
    // skipped `ga` — which was exactly where a misclassification was sitting.
    for (const mod of moduleRegistry) {
      for (const [position, surface] of Object.entries(mod.viewAs.surfaces)) {
        for (const e of surface.excluded) {
          const { error } = await alice.from(e.table).select('*').limit(1)
          expect(
            error,
            `${mod.key}/${position}: ${e.table} is marked excluded (a product decision over ` +
              `data the viewer reads anyway) but the viewer cannot read it — it belongs in ` +
              `personal or unreadableByPosition`,
          ).toBeNull()
        }
      }
    }
    // Classroom declares NO personal layer, and that emptiness is the finding —
    // the module has no sd_notes analogue, so nothing here is RLS-hidden upward.
    expect(getModule('classroom')!.viewAs.surfaces.student!.personal).toEqual([])
    expect(getModule('classroom')!.viewAs.surfaces.ga!.personal).toEqual([])
  })

  it('every table marked UNREADABLE-BY-POSITION really is unreadable by someone holding that position', async () => {
    // The third claim, about the third reader: not "the viewer cannot see it"
    // (personal) and not "the viewer can but we decline to render it"
    // (excluded), but "this POSITION has no read path at all". Asserted as the
    // real position-holder, so the label cannot drift away from the policies.
    // Gabe is the seeded GA and Charlie the seeded student in demo-a.
    const holder: Record<string, SupabaseClient> = {
      ga: await signIn('gabe@demo.local'),
      student: await signIn('charlie@demo.local'),
    }
    let checked = 0
    for (const [position, surface] of Object.entries(getModule('classroom')!.viewAs.surfaces)) {
      const client = holder[position]
      if (!client) continue
      for (const u of surface.unreadableByPosition ?? []) {
        // Control first: a privileged reader must see rows, otherwise "the
        // position sees nothing" would be true merely because the table is
        // empty and the assertion below would prove nothing.
        const { data: seeded } = await alice.from(u.table).select('*').limit(1)
        expect(
          (seeded ?? []).length,
          `${u.table} has no seeded rows, so the unreadability check below is vacuous`,
        ).toBeGreaterThan(0)

        const { data, error } = await client.from(u.table).select('*').limit(1)
        const readable = !error && (data ?? []).length > 0
        expect(readable, `${position} can read ${u.table}, declared unreadable to them`).toBe(false)
        checked++
      }
    }
    // Guard against the whole assertion quietly becoming a no-op.
    expect(checked, 'no unreadableByPosition entries were actually checked').toBeGreaterThan(0)
  })

  it('positive control: a genuinely personal table (sd_notes) is unreadable by staff, so the assertion is not vacuous', async () => {
    // sd_notes is author-only with no staff arm anywhere (20260709050000) — the
    // shape a real personal-layer entry must have. Alice is the seeded
    // speed-dating organizer in demo-dating and authors no notes there.
    const { data, error } = await alice.from('sd_notes').select('*').limit(1)
    expect(error).toBeNull()
    expect((data ?? []).length).toBe(0)
  })

  it('the declared surfaces are fully readable by the professor — no gap for view-as to bridge (point 1)', async () => {
    // The keystone stated as a positive: if a declared surface table were NOT
    // readable by the caller, the tab would be a widening mechanism waiting to
    // happen. Every declared table must answer without a privilege/policy error.
    const decl = getModule('classroom')!.viewAs
    for (const position of ['student', 'ga'] as const) {
      for (const t of decl.surfaces[position]!.role) {
        const { error } = await alice.from(t.table).select(t.columns.join(', ')).limit(1)
        expect(error, `${position}/${t.table}: ${JSON.stringify(error)}`).toBeNull()
      }
    }
  })
})

describe('view-as: nail-salon surfaces (module 5 review, 2026-08-04)', () => {
  // The salon's own surface security review (§8.1 point 9). Four things need
  // proving here that the generic per-module tests structurally cannot:
  //
  //  1. THE KEYSTONE AS A REAL MANAGER. alice OWNS demo-salon, so every read of
  //     hers short-circuits through is_org_admin and proves nothing about the
  //     manager POSITION. bob gets a global, non-admin manager grant instead.
  //  2. THE unreadableByPosition CLAIMS, AS THE REAL CASHIER AND WORKER. When
  //     this block was written, a clean seed had ZERO rows in ALL SIX tables
  //     involved (bills, bill items, earnings, promotions, expenses, shopping
  //     list), so every one of these "cannot read" assertions would have passed
  //     on an empty universe — docs/03's vacuity rule. The seed gained a paid
  //     visit and the bookkeeping rows later the same day, so the tables are no
  //     longer empty; the fixtures below are KEPT anyway, deliberately, so these
  //     assertions never depend on the seed continuing to carry them. The
  //     non-emptiness control inside the test is what actually enforces it either
  //     way, and it is scoped to demo-salon.
  //  3. THE WORKER NARROWINGS ARE REAL, not just declared: the worker surface
  //     rests on "dana sees only her own appointments / her own time off / only
  //     the customers she is booked with". Each gets a second row belonging to
  //     someone else, so the narrowing is demonstrated rather than asserted.
  //  4. THE mode-1-only PAIRS ARE REFUSED BY THE DATABASE. The five staff pairs
  //     have mode 1 on and mode 2 off for three of them; the app not offering a
  //     picker is not a gate (docs/03 #18), so the guard must refuse a forged
  //     session insert on manager -> cashier while allowing manager -> worker.
  let salonOrg: string
  let bobMgr: SupabaseClient // GLOBAL manager, plain member — no is_org_admin bypass
  let eveCashier: SupabaseClient
  let danaWorker: SupabaseClient
  const uid: Record<string, string> = {}
  const fx: Record<string, string> = {}

  const salon = () => getModule('nail-salon')!.viewAs

  beforeAll(async () => {
    eveCashier = await signIn('eve@demo.local')
    danaWorker = await signIn('dana@demo.local')
    bobMgr = await signIn('bob@demo.local')
    salonOrg = (await alice.from('orgs').select('id').eq('slug', 'demo-salon').single()).data!.id

    for (const e of ['bob', 'eve', 'dana', 'charlie']) {
      const { data } = await alice.rpc('org_find_user_by_email', {
        check_org_id: salonOrg,
        target_email: `${e}@demo.local`,
      })
      uid[e] = data![0].user_id as string
    }

    // bob is not a salon member (he lives in demo-b). Invite + ACCEPT — since
    // slice 3 an unaccepted invite leaves him `pending`, which satisfies no
    // membership predicate and would make his reads below fail for a reason
    // that has nothing to do with the manager position.
    await alice.from('org_members').upsert({ org_id: salonOrg, user_id: uid.bob, role: 'member' })
    await acceptInviteAs('bob@demo.local', salonOrg)
    const g = await alice
      .from('module_roles')
      .insert({ org_id: salonOrg, user_id: uid.bob, module_key: 'nail-salon', role: 'manager', scope_ref: null })
    if (g.error) throw new Error(`salon view-as fixture (bob manager grant): ${g.error.message}`)

    // The seeded location, service and customer (Downtown / Manicure / Charlie).
    const loc = (
      await alice.from('sal_locations').select('id').eq('org_id', salonOrg).order('created_at').limit(1).single()
    ).data!
    fx.loc = loc.id as string
    fx.service = (
      await alice.from('sal_services').select('id').eq('location_id', fx.loc).order('sort').limit(1).single()
    ).data!.id as string
    fx.customer = (
      await alice.from('sal_customers').select('id').eq('location_id', fx.loc).eq('user_id', uid.charlie).single()
    ).data!.id as string

    // A SECOND customer at the location, with no appointment with dana. This is
    // the control behind the worker surface's `excluded` entry for
    // sal_customers: the claim "rendering it unfiltered would be falsely
    // permissive" is only checkable if a customer dana must NOT see exists.
    const cust2 = await alice
      .from('sal_customers')
      .insert({ org_id: salonOrg, location_id: fx.loc, full_name: 'View-as fixture walk-in' })
      .select('id')
      .single()
    if (cust2.error) throw new Error(`salon view-as fixture (2nd customer): ${cust2.error.message}`)
    fx.otherCustomer = cust2.data.id as string

    // A SECOND worker profile (bob) with its own time-off row — the control
    // behind "a worker reads only their own time off", which the surface renders
    // as an embed under the profile.
    const wp = await alice
      .from('sal_worker_profiles')
      .insert({ org_id: salonOrg, location_id: fx.loc, user_id: uid.bob, display_name: 'View-as fixture worker' })
      .select('id')
      .single()
    if (wp.error) throw new Error(`salon view-as fixture (2nd worker profile): ${wp.error.message}`)
    fx.otherProfile = wp.data.id as string
    const to = await alice.from('sal_worker_time_off').insert({
      org_id: salonOrg,
      location_id: fx.loc,
      worker_profile_id: fx.otherProfile,
      starts_at: new Date(Date.now() + 6 * 864e5).toISOString(),
      ends_at: new Date(Date.now() + 6 * 864e5 + 36e5).toISOString(),
      reason: 'view-as fixture',
    })
    if (to.error) throw new Error(`salon view-as fixture (2nd time off): ${to.error.message}`)

    // An appointment with NO worker assigned, so it never joins dana's chair
    // view even if a failed run leaves it behind — and so it doubles as the
    // control for "dana sees only her own appointments".
    const start = new Date(Date.now() + 5 * 864e5)
    const appt = await alice
      .from('sal_appointments')
      .insert({
        org_id: salonOrg,
        location_id: fx.loc,
        customer_id: fx.otherCustomer,
        service_id: fx.service,
        worker_id: null,
        scheduled_start: start.toISOString(),
        scheduled_end: new Date(start.getTime() + 30 * 60000).toISOString(),
      })
      .select('id')
      .single()
    if (appt.error) throw new Error(`salon view-as fixture (appointment): ${appt.error.message}`)
    fx.appt = appt.data.id as string

    // The money chain: bill -> line item -> an earnings row. All three are empty
    // on a clean seed, and all three are declared unreadable to the worker (the
    // ledger to the cashier as well).
    const bill = await alice
      .from('sal_bills')
      .insert({ org_id: salonOrg, location_id: fx.loc, appointment_id: fx.appt, subtotal: 40, total: 40 })
      .select('id')
      .single()
    if (bill.error) throw new Error(`salon view-as fixture (bill): ${bill.error.message}`)
    fx.bill = bill.data.id as string

    const item = await alice.from('sal_bill_items').insert({
      org_id: salonOrg,
      location_id: fx.loc,
      bill_id: fx.bill,
      service_id: fx.service,
      description: 'View-as fixture line',
      quantity: 1,
      unit_price: 40,
      line_total: 40,
    })
    if (item.error) throw new Error(`salon view-as fixture (bill item): ${item.error.message}`)

    // Inserted directly rather than by paying the bill: sal_feed_earnings is
    // covered elsewhere, and an explicit row is easier to clean up (bill_id is
    // ON DELETE SET NULL, so the ledger outlives its bill by design).
    const earn = await alice
      .from('sal_earnings_ledger')
      .insert({
        org_id: salonOrg,
        location_id: fx.loc,
        appointment_id: fx.appt,
        bill_id: fx.bill,
        kind: 'sale',
        amount: 40,
      })
      .select('id')
      .single()
    if (earn.error) throw new Error(`salon view-as fixture (earnings): ${earn.error.message}`)
    fx.earning = earn.data.id as string

    const promo = await alice
      .from('sal_promotions')
      .insert({
        org_id: salonOrg,
        location_id: fx.loc,
        name: 'View-as fixture promo',
        kind: 'visit_count',
        threshold: 5,
        discount_type: 'percent',
        discount_value: 10,
      })
      .select('id')
      .single()
    if (promo.error) throw new Error(`salon view-as fixture (promotion): ${promo.error.message}`)
    fx.promo = promo.data.id as string

    const exp = await alice
      .from('sal_expenses')
      .insert({ org_id: salonOrg, location_id: fx.loc, category: 'view-as fixture', amount: 7 })
      .select('id')
      .single()
    if (exp.error) throw new Error(`salon view-as fixture (expense): ${exp.error.message}`)
    fx.expense = exp.data.id as string

    const shop = await alice
      .from('sal_shopping_list')
      .insert({ org_id: salonOrg, location_id: fx.loc, item: 'View-as fixture cotton pads' })
      .select('id')
      .single()
    if (shop.error) throw new Error(`salon view-as fixture (shopping item): ${shop.error.message}`)
    fx.shopping = shop.data.id as string
  })

  afterAll(async () => {
    // Ledger first: bill_id/appointment_id are ON DELETE SET NULL, so it would
    // otherwise survive its parents and pollute later runs.
    if (fx.earning) await alice.from('sal_earnings_ledger').delete().eq('id', fx.earning)
    if (fx.appt) await alice.from('sal_appointments').delete().eq('id', fx.appt) // cascades bill -> items
    if (fx.promo) await alice.from('sal_promotions').delete().eq('id', fx.promo)
    if (fx.expense) await alice.from('sal_expenses').delete().eq('id', fx.expense)
    if (fx.shopping) await alice.from('sal_shopping_list').delete().eq('id', fx.shopping)
    if (fx.otherProfile) await alice.from('sal_worker_profiles').delete().eq('id', fx.otherProfile) // cascades time off
    if (fx.otherCustomer) await alice.from('sal_customers').delete().eq('id', fx.otherCustomer)
    await alice
      .from('module_roles')
      .delete()
      .eq('org_id', salonOrg)
      .eq('module_key', 'nail-salon')
      .eq('user_id', uid.bob)
      .eq('role', 'manager')
      .is('scope_ref', null)
    await alice.from('org_members').delete().eq('org_id', salonOrg).eq('user_id', uid.bob)
  })

  it('every declared salon surface column and embed path RESOLVES (not a readability claim)', async () => {
    // Deliberately narrow, and titled for what it proves: a select that RLS
    // empties returns `data: []` with `error: null`, so this asserts only that
    // the allow-list names real columns and every `embed` alias/FK path resolves.
    // That is worth its own test — it is the only place a typo in an embed is
    // caught before an operator sees a red section — but it is NOT the keystone.
    // The keystone is the next test.
    let checked = 0
    for (const [position, surface] of Object.entries(salon().surfaces)) {
      for (const t of surface.role) {
        const embeds = (t.embed ?? []).map((e) => `${e.alias}:${e.table}(${e.columns.join(',')})`)
        const select = [...t.columns, ...embeds].join(', ')
        const { error } = await bobMgr.from(t.table).select(select).limit(1)
        expect(error, `${position}/${t.table}: ${JSON.stringify(error)}`).toBeNull()
        checked++
      }
    }
    expect(checked, 'no salon surface tables were checked').toBeGreaterThan(20)
  })

  it('the keystone: wherever a surface table HAS rows, a real manager actually reads them', async () => {
    // §8.1 point 1 as a positive with a real control, and as the POSITION rather
    // than as an org admin (alice owns demo-salon, so her reads short-circuit
    // through is_org_admin and would prove nothing — docs/03 #18, last bullet).
    //
    // The control is alice: for every declared surface table she can see a row
    // in, bob-the-manager must see one too. Tables that are empty even for her
    // are SKIPPED rather than silently counted as passes, and the number
    // actually compared is asserted, so this cannot decay into a no-op the way a
    // bare error-is-null check does.
    let compared = 0
    const empty: string[] = []
    for (const [position, surface] of Object.entries(salon().surfaces)) {
      for (const t of surface.role) {
        const ctl = await alice.from(t.table).select('id').eq('org_id', salonOrg).limit(1)
        expect(ctl.error, `control read of ${t.table}: ${JSON.stringify(ctl.error)}`).toBeNull()
        if ((ctl.data ?? []).length === 0) {
          empty.push(`${position}/${t.table}`)
          continue
        }
        const mgr = await bobMgr.from(t.table).select('id').eq('org_id', salonOrg).limit(1)
        expect(mgr.error, `${position}/${t.table} as manager: ${JSON.stringify(mgr.error)}`).toBeNull()
        expect(
          (mgr.data ?? []).length,
          `${position}/${t.table}: the org owner reads rows but the MANAGER POSITION reads none — ` +
            `a gap in the ladder's RLS, which is never something view-as may bridge (§8.1 point 1)`,
        ).toBeGreaterThan(0)
        compared++
      }
    }
    // 11 + 10 + 4 = 25 declared sections; the fixtures give every salon table at
    // least one row, so nothing should land in `empty`. Asserted as a floor plus
    // an explicit report, so a table quietly emptying out is visible rather than
    // being absorbed as a skip.
    expect(compared, `only ${compared} sections had rows to compare; empty: ${empty.join(', ')}`).toBe(25)
  })

  it('every table marked UNREADABLE-BY-POSITION on a salon surface really is, with a non-emptiness control', async () => {
    const holder: Record<string, SupabaseClient> = { cashier: eveCashier, worker: danaWorker }
    let checked = 0
    let declared = 0
    for (const [position, surface] of Object.entries(salon().surfaces)) {
      declared += (surface.unreadableByPosition ?? []).length
      const client = holder[position]
      if (!client) continue
      for (const u of surface.unreadableByPosition ?? []) {
        // Control FIRST, and SCOPED TO THE SALON ORG: without a row in the org
        // whose cashier/worker is then asserted blind, "sees nothing" is true of
        // an empty table and the assertion proves nothing. alice belongs to
        // several orgs, so an unscoped control could be satisfied by a row the
        // salon staffer was never anywhere near.
        const { data: seeded } = await alice.from(u.table).select('id').eq('org_id', salonOrg).limit(1)
        expect(
          (seeded ?? []).length,
          `${u.table} has no rows in demo-salon, so the check below is vacuous — fix the fixture`,
        ).toBeGreaterThan(0)

        const { data, error } = await client.from(u.table).select('*').limit(1)
        // An ERROR must not be mistaken for "RLS hid the rows". Every one of these
        // tables is granted to `authenticated`, so the honest outcome is an empty
        // result; if the query errored, the assertion below would pass for the
        // wrong reason — a typo'd table name would "prove" unreadability.
        expect(error, `salon ${position} reading ${u.table} errored instead of returning nothing`).toBeNull()
        expect((data ?? []).length, `salon ${position} can read ${u.table}, declared unreadable to them`).toBe(0)
        checked++
      }
    }
    // Every declared entry belongs to cashier or worker, so a mismatch means a
    // position gained entries with no holder to check them as.
    expect(checked, 'salon unreadableByPosition entries were not all checked').toBe(declared)
    expect(checked, 'the salon claims fewer unreadable tables than the review found').toBeGreaterThanOrEqual(7)
  })

  it('a cashier cannot read one single revenue row — the fact the cashier tab exists to state', async () => {
    // Called out on its own because it is the module's clearest asymmetric
    // read: the whole operate tier writes expenses but only manage-tier reads
    // takings. Both halves asserted, so neither can rot into a half-truth.
    const { data: mgrSees } = await bobMgr.from('sal_earnings_ledger').select('id, amount')
    expect((mgrSees ?? []).length, 'the manager control read no earnings rows').toBeGreaterThan(0)

    const { data: eveEarnings } = await eveCashier.from('sal_earnings_ledger').select('id')
    expect((eveEarnings ?? []).length).toBe(0)

    // …while the same cashier DOES read the expense side, which is why expenses
    // are on her surface and the ledger is not.
    const { data: eveExpenses } = await eveCashier.from('sal_expenses').select('id')
    expect((eveExpenses ?? []).length, 'a cashier should read expenses (operate tier)').toBeGreaterThan(0)
  })

  it('the worker surface narrowings are real: own appointments, own time off, only booked customers', async () => {
    // Appointments: the seeded one is dana's; the fixture one has no worker.
    const { data: allAppts } = await bobMgr.from('sal_appointments').select('id, worker_id')
    expect((allAppts ?? []).length, 'control: the manager sees more than one appointment').toBeGreaterThan(1)
    const { data: danaAppts } = await danaWorker.from('sal_appointments').select('id, worker_id')
    expect((danaAppts ?? []).length).toBeGreaterThan(0)
    expect(
      (danaAppts ?? []).every((a) => a.worker_id === uid.dana),
      'a worker read an appointment that is not assigned to her',
    ).toBe(true)
    expect((danaAppts ?? []).some((a) => a.id === fx.appt), 'the unassigned fixture appointment leaked').toBe(false)

    // Time off: hers is seeded, the fixture added another worker's.
    const { data: allOff } = await bobMgr.from('sal_worker_time_off').select('id, worker_profile_id')
    expect((allOff ?? []).length, 'control: the manager sees more than one time-off row').toBeGreaterThan(1)
    const { data: danaOff } = await danaWorker.from('sal_worker_time_off').select('id, worker_profile_id')
    expect((danaOff ?? []).length).toBeGreaterThan(0)
    expect(
      (danaOff ?? []).every((r) => r.worker_profile_id !== fx.otherProfile),
      "a worker read another worker's time off",
    ).toBe(true)

    // Customers: she is booked with Charlie and not with the fixture walk-in.
    // This is the control behind declaring sal_customers `excluded` on her
    // surface rather than rendering it unfiltered.
    const { data: danaCust } = await danaWorker.from('sal_customers').select('id')
    expect((danaCust ?? []).some((c) => c.id === fx.customer), 'a worker lost her own chair customer').toBe(true)
    expect(
      (danaCust ?? []).some((c) => c.id === fx.otherCustomer),
      'a worker read a customer she has no appointment with — the falsely-permissive case',
    ).toBe(false)

    // And the wider read the surface's caveat admits to, asserted so the caveat
    // cannot quietly become false: worker profiles ARE org-member readable.
    const { data: profiles } = await danaWorker.from('sal_worker_profiles').select('id')
    expect(
      (profiles ?? []).some((p) => p.id === fx.otherProfile),
      "the worker surface caveat claims a worker reads colleagues' profiles; they did not",
    ).toBe(true)
  })

  it('mode 2 is refused by the DATABASE for the mode-1-only pairs, and allowed for manager -> worker', async () => {
    // `string | undefined` because noUncheckedIndexedAccess types every lookup
    // in the uid map that way; an undefined target would fail the guard's
    // grant-existence check anyway, which is the correct outcome.
    const start = (target: string | undefined, role: string) =>
      bobMgr
        .from('view_as_sessions')
        .insert({
          org_id: salonOrg,
          module_key: 'nail-salon',
          actor_user_id: uid.bob,
          target_user_id: target,
          target_role: role,
          target_scope_ref: null,
        })
        .select('id, actor_user_id')
        .single()

    // manager -> worker: mode 2 ON, and bob's global grant covers dana's.
    const ok = await start(uid.dana, 'worker')
    expect(ok.error, `manager -> worker should be allowed: ${JSON.stringify(ok.error)}`).toBeNull()
    expect(ok.data!.actor_user_id).toBe(uid.bob)

    // manager -> cashier: mode 1 only. The UI never offers a picker, but the UI
    // is not a gate — the guard must refuse the raw insert.
    const refused = await start(uid.eve, 'cashier')
    expect(refused.error, 'manager -> cashier is mode-1-only and must be refused').not.toBeNull()
    expect(refused.error!.message).toMatch(/declares an edge/)
  })

  it('the nine pairs answer exactly as the review decided — including every customer pair OFF', async () => {
    const decl = salon()
    const on1 = (a: string, b: string) => decl.edges[a]?.[b]?.mode1 === true
    const on2 = (a: string, b: string) => decl.edges[a]?.[b]?.mode2 === true

    // Five staff pairs: mode 1 on all, mode 2 only into worker (the one position
    // whose RLS narrows per person rather than per location).
    for (const [a, b] of [
      ['admin', 'manager'],
      ['admin', 'cashier'],
      ['admin', 'worker'],
      ['manager', 'cashier'],
      ['manager', 'worker'],
    ] as const) {
      expect(on1(a, b), `${a} -> ${b} mode 1`).toBe(true)
      expect(on2(a, b), `${a} -> ${b} mode 2`).toBe(b === 'worker')
    }

    // All four customer pairs off, in both modes.
    for (const a of ['admin', 'manager', 'cashier', 'worker'] as const) {
      const edge = decl.edges[a]?.customer
      expect(edge, `${a} -> customer must be declared`).toBeDefined()
      expect(edge!.mode1, `${a} -> customer mode 1`).toBe(false)
      expect(edge!.mode2, `${a} -> customer mode 2`).toBe(false)
    }

    // Tabs follow from the edges, so assert the strip a real caller would see —
    // with the empty cases, which is where an accidental edge would show up.
    expect(viewAsTabsFor(decl, ['admin']).map((t) => t.position)).toEqual(['manager', 'cashier', 'worker'])
    expect(viewAsTabsFor(decl, ['manager']).map((t) => t.position)).toEqual(['cashier', 'worker'])
    expect(viewAsTabsFor(decl, ['cashier'])).toEqual([])
    expect(viewAsTabsFor(decl, ['worker'])).toEqual([])
    expect(viewAsTabsFor(decl, ['customer'])).toEqual([])
  })

  it('salon declares no personal layer, and that emptiness is the finding', async () => {
    // §8.1 point 1: `personal` means RLS-unreadable to the viewer. Nail-salon has
    // no sd_notes analogue — a manager reads every salon table inside the
    // locations they govern — so marking anything personal here would be the
    // spec violation point 1 names. Asserted rather than commented, because a
    // future migration adding a genuinely private table should make this fail
    // and force a conscious classification.
    for (const [position, surface] of Object.entries(salon().surfaces)) {
      expect(surface.personal, `salon/${position} declares a personal layer`).toEqual([])
    }
  })
})

describe('view-as session log: append-only, and a floor under the edge table (slice 5)', () => {
  let orgA: string
  let charlieV: SupabaseClient
  let gabeV: SupabaseClient
  const uid = {} as Record<string, string> & { alice: string; charlie: string; dana: string; gabe: string }
  const errored = (r: { error: unknown }) => r.error != null

  const session = (c: SupabaseClient, target: string, role: string, scope: string | null) =>
    c
      .from('view_as_sessions')
      .insert({
        org_id: orgA,
        module_key: 'classroom',
        actor_user_id: uid.alice,
        target_user_id: target,
        target_role: role,
        target_scope_ref: scope,
      })
      .select('id, actor_user_id, expires_at')
      .single()

  beforeAll(async () => {
    charlieV = await signIn('charlie@demo.local')
    gabeV = await signIn('gabe@demo.local')
    orgA = (await alice.from('orgs').select('id').eq('slug', 'demo-a').single()).data!.id
    for (const e of ['alice', 'charlie', 'dana', 'gabe']) {
      const { data } = await alice.rpc('org_find_user_by_email', {
        check_org_id: orgA,
        target_email: `${e}@demo.local`,
      })
      uid[e] = data![0].user_id as string
    }
  })

  it('a professor may open a session on a student grant; identity and expiry are server-stamped', async () => {
    // Charlie is the seeded student, SCOPED to the Statistics 101 class node.
    const { data: grant } = await alice
      .from('module_roles')
      .select('scope_ref')
      .eq('org_id', orgA)
      .eq('module_key', 'classroom')
      .eq('user_id', uid.charlie)
      .eq('role', 'student')
      .single()
    const { data, error } = await session(alice, uid.charlie, 'student', grant!.scope_ref as string | null)
    expect(error, JSON.stringify(error)).toBeNull()
    expect(data!.actor_user_id).toBe(uid.alice)
    expect(new Date(data!.expires_at as string).getTime()).toBeGreaterThan(Date.now())
  })

  it('the actor column is the real caller even when the client forges it', async () => {
    const { data, error } = await charlieV
      .from('view_as_sessions')
      .insert({
        org_id: orgA,
        module_key: 'classroom',
        actor_user_id: uid.alice, // forged
        target_user_id: uid.dana,
        target_role: 'student',
        target_scope_ref: null,
      })
      .select('id')
      .single()
    // Charlie is a student: rewritten to himself, then refused for not
    // outranking. The forgery never survives to a stored row.
    expect(error, JSON.stringify(data)).not.toBeNull()
  })

  it('EQUAL RANK is refused in the database: a GA cannot open a session on a student', async () => {
    // The peers rule (docs/15 §5) enforced independently of the TypeScript
    // edge table — ga and student are both rank 1.
    expect(errored(await session(gabeV, uid.charlie, 'student', null))).toBe(true)
  })

  it('upward and self targets are refused', async () => {
    expect(errored(await session(charlieV, uid.alice, 'professor', null))).toBe(true)
    expect(errored(await session(alice, uid.alice, 'professor', null))).toBe(true)
  })

  it('a target grant that does not exist is refused (point 4: the target is a real grant triple)', async () => {
    expect(errored(await session(alice, uid.dana, 'ga', null))).toBe(true)
  })

  it('the log is append-only — no UPDATE, no DELETE, by anyone', async () => {
    const { data: mine } = await alice.from('view_as_sessions').select('id').limit(1).single()
    expect(errored(await alice.from('view_as_sessions').update({ target_role: 'ga' }).eq('id', mine!.id))).toBe(true)
    expect(errored(await alice.from('view_as_sessions').delete().eq('id', mine!.id))).toBe(true)
  })

  it('a session is visible to its actor and to org admins, not to the wider org', async () => {
    const { data: charlieSees } = await charlieV.from('view_as_sessions').select('id')
    expect(charlieSees ?? []).toEqual([])
    const { data: aliceSees } = await alice.from('view_as_sessions').select('id')
    expect((aliceSees ?? []).length).toBeGreaterThan(0)
  })

  it('a stranger reaches the session log at neither the privilege nor the row layer', async () => {
    const anon = createClient(url, anonKey, { auth: { persistSession: false } })
    const read = await anon.from('view_as_sessions').select('*').limit(1)
    expect(read.error?.code, JSON.stringify(read.error)).toBe('42501')
    const write = await anon.from('view_as_sessions').insert({
      org_id: orgA,
      module_key: 'classroom',
      actor_user_id: uid.alice,
      target_user_id: uid.charlie,
      target_role: 'student',
    })
    expect(write.error?.code, JSON.stringify(write.error)).toBe('42501')
  })
})

// ---------------------------------------------------------------------------
// Data browser (docs/13, docs/03 #19)
// ---------------------------------------------------------------------------
describe('data browser: the neverReadable claim is TRUE, not just declared', () => {
  // WHY THIS IS IN THE CI SUITE AND NOT ONLY IN scripts/verify-data-browser.mts.
  // `neverReadable` is rendered to an operator as a statement of fact — "rows
  // about this person exist here and NOBODY, including you, may read them".
  // Nothing else checks that the statement is true: the coverage test only
  // checks the entry is well-formed, and the probe script is not run by CI. A
  // migration that added `or public.is_superadmin()` to sd_notes_all_own would
  // leave every automated check green while the UI kept asserting the opposite.
  //
  // This mirrors what view-as already does for `unreadableByPosition` above —
  // the same claim shape deserves the same enforcement.

  // Each neverReadable table needs a recipe that creates a REAL row as whoever
  // is allowed to, so the "nobody can read it" assertion is never satisfied by
  // an empty table (docs/03 #18's non-emptiness control). A declared table with
  // no recipe FAILS rather than being skipped: an unprovable claim on screen is
  // exactly what this test exists to prevent.
  type Fixture = { rowId: string; author: SupabaseClient; cleanup: () => Promise<void> }
  const recipes: Record<string, () => Promise<Fixture>> = {
    sd_notes: async () => {
      const organizer = await signIn('alice@demo.local')
      const author = await signIn('charlie@demo.local')
      const subject = await signIn('dana@demo.local')
      const authorId = (await author.auth.getUser()).data.user!.id
      const subjectId = (await subject.auth.getUser()).data.user!.id
      const org = (await organizer.from('orgs').select('id').eq('slug', 'demo-dating').single()).data!

      const ev = await organizer
        .from('sd_events')
        .insert({ org_id: org.id, name: 'neverReadable fixture', scheduled_at: new Date(Date.now() + 864e5).toISOString() })
        .select('id')
        .single()
      if (ev.error) throw new Error(`fixture event: ${ev.error.message}`)

      const parts = await organizer
        .from('sd_participants')
        .insert([
          { org_id: org.id, event_id: ev.data.id, user_id: authorId },
          { org_id: org.id, event_id: ev.data.id, user_id: subjectId },
        ])
        .select('id')
      if (parts.error) throw new Error(`fixture participants: ${parts.error.message}`)

      const note = await author
        .from('sd_notes')
        .insert({
          org_id: org.id,
          event_id: ev.data.id,
          author_user_id: authorId,
          about_user_id: subjectId,
          body: 'neverReadable fixture',
        })
        .select('id')
        .single()
      if (note.error) throw new Error(`fixture note: ${note.error.message}`)

      return {
        rowId: note.data.id,
        author,
        cleanup: async () => {
          await author.from('sd_notes').delete().eq('id', note.data.id)
          for (const p of parts.data ?? []) await organizer.from('sd_participants').delete().eq('id', p.id)
          await organizer.from('sd_events').delete().eq('id', ev.data.id)
        },
      }
    },
  }

  it('every neverReadable table really is unreadable — by staff and by the superadmin', async () => {
    const superadmin = await signIn('owner@demo.local')
    const organizer = await signIn('alice@demo.local')

    // The superadmin precondition is itself asserted: if owner@demo.local were
    // not a superadmin locally, "the superadmin cannot read it" would pass for
    // the wrong reason entirely.
    const ownerId = (await superadmin.auth.getUser()).data.user!.id
    const { data: prof } = await superadmin.from('profiles').select('is_superadmin').eq('user_id', ownerId).single()
    expect(prof?.is_superadmin, 'owner@demo.local must be the local superadmin for this test to mean anything').toBe(true)

    const entries = Object.entries(dataBrowserDeclarations).flatMap(([key, decl]) =>
      decl.neverReadable.map((u) => ({ moduleKey: key, table: u.table })),
    )
    expect(entries.length, 'no neverReadable entries were checked').toBeGreaterThan(0)

    for (const entry of entries) {
      const recipe = recipes[entry.table]
      expect(
        recipe,
        `${entry.moduleKey} declares ${entry.table} neverReadable but no fixture recipe proves it — ` +
          `add one to rls.test.ts rather than shipping an unprovable claim to the UI`,
      ).toBeDefined()

      const fixture = await recipe!()
      try {
        // CONTROL: the row exists and someone can read it.
        const { data: byAuthor } = await fixture.author.from(entry.table).select('id').eq('id', fixture.rowId)
        expect((byAuthor ?? []).length, `${entry.table}: the fixture row is not readable by its own author`).toBe(1)

        for (const [who, client] of [
          ['module staff', organizer],
          ['the platform superadmin', superadmin],
        ] as [string, SupabaseClient][]) {
          const { data } = await client.from(entry.table).select('id').eq('id', fixture.rowId)
          expect(
            (data ?? []).length,
            `${entry.table} is declared readable by nobody, but ${who} can read it`,
          ).toBe(0)
        }
      } finally {
        await fixture.cleanup()
      }
    }
  })
})
