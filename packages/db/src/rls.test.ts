import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

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
