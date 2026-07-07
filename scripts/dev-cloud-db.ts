// `pnpm dev:cloud-db` — web + worker run natively on this machine, pointed at
// the STAGING cloud Supabase project (docs/01 dev-mode matrix). For
// reproducing cloud-only issues. Never points at production — see guard rails.
//
// Setup (once): copy .env.cloud-db.example to .env.cloud-db and fill it in
// from the staging project's dashboard (docs/07).
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mask, repoRoot, run, writeEnvFile } from './lib'

const dryRun = process.argv.includes('--dry-run')
const envPath = resolve(repoRoot, '.env.cloud-db')

if (!existsSync(envPath)) {
  console.error('Missing .env.cloud-db — copy .env.cloud-db.example and fill in the staging values.')
  process.exit(1)
}

const env: Record<string, string> = {}
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
  if (match && match[1]) env[match[1]] = match[2] ?? ''
}

// Guard rails (docs/01): explicit staging confirmation, no localhost mixups,
// no production. All checked before anything starts.
const problems: string[] = []
for (const key of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL']) {
  if (!env[key]) problems.push(`${key} is not set`)
}
if (env.STAGING_CONFIRMED !== 'yes') {
  problems.push(
    'STAGING_CONFIRMED=yes is missing — add it only after verifying every value points at the STAGING project, never production',
  )
}
if (env.SUPABASE_URL && /localhost|127\.0\.0\.1/.test(env.SUPABASE_URL)) {
  problems.push('SUPABASE_URL points at localhost — use plain `pnpm dev` for local development')
}
if (env.PRODUCTION_PROJECT_REF && env.SUPABASE_URL?.includes(env.PRODUCTION_PROJECT_REF)) {
  problems.push('SUPABASE_URL contains the PRODUCTION project ref — refusing')
}
if (problems.length > 0) {
  console.error('Refusing to start dev:cloud-db:')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

console.log('Resolved configuration:')
console.log(`  SUPABASE_URL     = ${env.SUPABASE_URL} [cloud: staging]`)
console.log(`  ANON_KEY         = ${mask(env.SUPABASE_ANON_KEY)}`)
console.log(`  SERVICE_ROLE_KEY = ${mask(env.SUPABASE_SERVICE_ROLE_KEY)}`)
console.log(`  DATABASE_URL     = ${env.DATABASE_URL!.replace(/:[^:@/]+@/, ':******@')}`)

if (!dryRun) {
  writeEnvFile(resolve(repoRoot, '.env'), {
    SUPABASE_URL: env.SUPABASE_URL!,
    SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY!,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY!,
    DATABASE_URL: env.DATABASE_URL!,
  })
  writeEnvFile(resolve(repoRoot, 'apps/web/.env.local'), {
    NEXT_PUBLIC_SUPABASE_URL: env.SUPABASE_URL!,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY!,
  })
  writeEnvFile(resolve(repoRoot, 'apps/worker/.env'), {
    DATABASE_URL: env.DATABASE_URL!,
  })
  console.log('\nNOTE: .env files now point at STAGING. Run plain `pnpm dev` to switch back to local.')
}

run('pnpm', ['exec', 'turbo', 'run', 'dev'], { dryRun })
