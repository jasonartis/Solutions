import { describe, expect, it, beforeAll } from 'vitest'
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

beforeAll(async () => {
  if (!anonKey) throw new Error('SUPABASE_ANON_KEY not set — run `pnpm dev` once to generate .env')
  alice = await signIn('alice@demo.local')
  bob = await signIn('bob@demo.local')
})

describe('tenancy isolation', () => {
  it('alice sees only her own orgs', async () => {
    const { data } = await alice.from('orgs').select('slug')
    // The three orgs alice administers across the module seeds (classroom +
    // synagogue + matchmaking) — and nothing else (still excludes demo-b).
    expect(data?.map((o) => o.slug).sort()).toEqual(['demo-a', 'demo-match', 'demo-shul'])
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
