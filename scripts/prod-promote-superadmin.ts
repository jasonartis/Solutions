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

  const { data: profile, error: findErr } = await admin
    .from('profiles')
    .select('user_id, email, is_superadmin')
    .eq('email', email)
    .single()
  if (findErr || !profile) {
    throw new Error(`Profile not found for ${email} — did they sign up? (${findErr?.message})`)
  }

  const { error } = await admin
    .from('profiles')
    .update({ is_superadmin: true })
    .eq('user_id', profile.user_id)
  if (error) throw new Error(error.message)
  console.log(`${email} -> superadmin (was: ${profile.is_superadmin})`)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
