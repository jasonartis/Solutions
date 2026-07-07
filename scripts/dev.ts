// Dev-mode harness (docs/01 dev-mode matrix).
//   pnpm dev              — supabase local (Docker) + web & worker native
//   pnpm dev --dry-run    — print what would run, run nothing
// Pattern adopted from dascher.base's startup scripts (docs/06): resolved-config
// echo with masked secrets, env layering, guard rails.
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mask, repoRoot, run, supabaseStatus, writeEnvFile } from './lib'

// Optional myzmanim credentials pass-through from .env.deploy (git-ignored).
function myzmanimEnv(): Record<string, string> {
  const deployPath = resolve(repoRoot, '.env.deploy')
  if (!existsSync(deployPath)) return {}
  const content = readFileSync(deployPath, 'utf8')
  const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(content)?.[1]?.trim() ?? ''
  const user = get('MYZMANIM_USER')
  const key = get('MYZMANIM_KEY')
  return user && key ? { MYZMANIM_USER: user, MYZMANIM_KEY: key } : {}
}

const dryRun = process.argv.includes('--dry-run')

let status = supabaseStatus()
if (!status) {
  console.log('[supabase] not running — starting local stack (first run pulls Docker images)…')
  if (!dryRun) {
    execSync('pnpm exec supabase start', { cwd: repoRoot, stdio: 'inherit' })
    status = supabaseStatus()
  }
}
if (!status && !dryRun) {
  console.error('Could not read supabase status. Is Docker Desktop running?')
  process.exit(1)
}

if (status) {
  const apiUrl = status.API_URL ?? 'http://127.0.0.1:54321'
  const anonKey = status.ANON_KEY ?? ''
  const serviceKey = status.SERVICE_ROLE_KEY ?? ''
  const dbUrl = status.DB_URL ?? ''

  // Guard rail: this script only ever targets local. Cloud modes are separate
  // commands with their own checks (docs/01).
  if (!/localhost|127\.0\.0\.1/.test(apiUrl)) {
    console.error(`Refusing: supabase status returned a non-local URL (${apiUrl}).`)
    process.exit(1)
  }

  console.log('Resolved configuration:')
  console.log(`  API_URL          = ${apiUrl} [local]`)
  console.log(`  ANON_KEY         = ${mask(anonKey)}`)
  console.log(`  SERVICE_ROLE_KEY = ${mask(serviceKey)}`)
  console.log(`  DB_URL           = ${dbUrl.replace(/:[^:@/]+@/, ':******@')}`)
  console.log(`  Studio           = ${status.STUDIO_URL ?? 'http://127.0.0.1:54323'}`)
  console.log(`  Mail (Mailpit)   = ${status.INBUCKET_URL ?? status.MAILPIT_URL ?? 'http://127.0.0.1:54324'}`)

  if (!dryRun) {
    writeEnvFile(resolve(repoRoot, '.env'), {
      SUPABASE_URL: apiUrl,
      SUPABASE_ANON_KEY: anonKey,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey,
      DATABASE_URL: dbUrl,
    })
    const myzmanim = myzmanimEnv()
    writeEnvFile(resolve(repoRoot, 'apps/web/.env.local'), {
      NEXT_PUBLIC_SUPABASE_URL: apiUrl,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
      ...myzmanim,
    })
    writeEnvFile(resolve(repoRoot, 'apps/worker/.env'), {
      DATABASE_URL: dbUrl,
      SUPABASE_URL: apiUrl,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey,
      ...myzmanim,
    })
  }
}

run('pnpm', ['exec', 'turbo', 'run', 'dev'], { dryRun })
