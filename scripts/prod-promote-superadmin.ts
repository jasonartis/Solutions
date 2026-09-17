// Platform-owner tool: promote a PRODUCTION account to superadmin.
//   pnpm exec tsx scripts/prod-promote-superadmin.ts someone@example.com
// Reads credentials from .env.deploy (git-ignored). Service-role — use with care.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const here = dirname(fileURLToPath(import.meta.url))
const env = readFileSync(resolve(here, '../.env.deploy'), 'utf8')
const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''

const email = process.argv[2]
if (!email) {
  console.error('Usage: pnpm exec tsx scripts/prod-promote-superadmin.ts <email>')
  process.exit(1)
}

async function main() {
  const admin = createClient(
    `https://${get('SUPABASE_PROJECT_REF')}.supabase.co`,
    get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  )

  // Resolve through the ADMIN AUTH API. `profiles.email` no longer exists
  // (docs/22), and `service_role` holds no privilege on `auth.users` either
  // despite `rolbypassrls` (docs/22 §2.2) — so neither table read is available.
  // The GoTrue admin endpoint is a separate surface that the service-role key
  // does authorise.
  const { data: list, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (listErr) throw new Error(listErr.message)
  const found = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())
  if (!found) {
    throw new Error(`No account found for ${email} — did they sign up?`)
  }

  // `is_superadmin` lives on the PRIVATE companion row now (docs/22 §21).
  const { data: before } = await admin
    .from('user_private')
    .select('is_superadmin')
    .eq('user_id', found.id)
    .maybeSingle()

  const { error } = await admin
    .from('user_private')
    .upsert({ user_id: found.id, is_superadmin: true })
  if (error) throw new Error(error.message)
  console.log(`${email} -> superadmin (was: ${before?.is_superadmin ?? false})`)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
