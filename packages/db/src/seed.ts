import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

// import.meta.dirname is undefined under tsx — derive it from the module URL.
const here = dirname(fileURLToPath(import.meta.url))

// Local-dev seed (docs/03: seed data is mandatory).
// Creates: a superadmin founder, two demo orgs with one user each, and the
// stub module enabled for Demo Org A only — the exact fixture the RLS
// isolation test needs.
//
// Idempotent: safe to re-run. Uses the service-role key — LOCAL/STAGING ONLY.

function loadRootEnv() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return
  try {
    const envFile = readFileSync(resolve(here, '../../../.env'), 'utf8')
    for (const line of envFile.split(/\r?\n/)) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
      if (match && match[1] && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2]!.replace(/^"|"$/g, '')
      }
    }
  } catch {
    // no .env file — rely on process env
  }
}

loadRootEnv()

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceKey) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set. Run `pnpm dev` once first.')
  process.exit(1)
}
if (!/localhost|127\.0\.0\.1/.test(url) && process.env.SEED_ALLOW_REMOTE !== 'yes') {
  console.error(`Refusing to seed non-local Supabase (${url}). Set SEED_ALLOW_REMOTE=yes to override.`)
  process.exit(1)
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

async function ensureUser(email: string, password: string, displayName: string) {
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: displayName },
  })
  if (created?.user) return created.user.id
  if (error && !/already/i.test(error.message)) throw error

  // Already exists — look up via profiles (service role bypasses RLS).
  const { data: profile } = await admin
    .from('profiles')
    .select('user_id')
    .eq('email', email)
    .single()
  if (!profile) throw new Error(`User ${email} exists but has no profile row`)
  return profile.user_id as string
}

async function ensureOrg(name: string, slug: string) {
  const { data } = await admin
    .from('orgs')
    .upsert({ name, slug }, { onConflict: 'slug' })
    .select('id')
    .single()
  if (!data) throw new Error(`Failed to upsert org ${slug}`)
  return data.id as string
}

async function main() {
  const founderId = await ensureUser('owner@demo.local', 'password123', 'Founder')
  const aliceId = await ensureUser('alice@demo.local', 'password123', 'Alice A')
  const bobId = await ensureUser('bob@demo.local', 'password123', 'Bob B')

  await admin.from('profiles').update({ is_superadmin: true }).eq('user_id', founderId)

  const orgA = await ensureOrg('Demo Org A', 'demo-a')
  const orgB = await ensureOrg('Demo Org B', 'demo-b')

  await admin.from('org_members').upsert([
    { org_id: orgA, user_id: aliceId, role: 'admin' },
    { org_id: orgB, user_id: bobId, role: 'admin' },
  ])

  // Stub module: enabled for A only — B's absence is what the RLS test exercises.
  await admin.from('org_modules').upsert({ org_id: orgA, module_key: 'stub', enabled: true })
  await admin.from('module_roles').upsert({
    org_id: orgA,
    user_id: aliceId,
    module_key: 'stub',
    role: 'admin',
  })

  console.log('Seed complete:')
  console.log('  owner@demo.local / password123  (superadmin)')
  console.log('  alice@demo.local / password123  (admin of Demo Org A, stub module enabled)')
  console.log('  bob@demo.local   / password123  (admin of Demo Org B, no modules)')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
