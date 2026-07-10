// Apply migrations to PRODUCTION — the only sanctioned path (docs/12).
//
//   pnpm migrate:prod
//
// Explicit-by-construction: the prod connection is built from .env.deploy
// here and passed as --db-url, so no standing project link exists in the
// repo for a confused session to trip over (`supabase db reset --linked`
// against a linked prod project would wipe it). Take a backup first for
// anything beyond additive changes: pnpm backup:prod.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const env = readFileSync(resolve(root, '.env.deploy'), 'utf8')
const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''

const ref = get('SUPABASE_PROJECT_REF')
const dbPassword = get('SUPABASE_DB_PASSWORD')
if (!ref || !dbPassword) {
  console.error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD in .env.deploy')
  process.exit(1)
}
const dbUrl = `postgresql://postgres.${ref}:${encodeURIComponent(dbPassword)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`

console.log(`Applying migrations to PRODUCTION (${ref})…`)
const cmd = ['pnpm', 'exec', 'supabase', 'db', 'push', '--db-url', '"' + dbUrl + '"'].join(' ')
const res = spawnSync(cmd, { cwd: root, stdio: 'inherit', shell: true })
process.exit(res.status ?? 1)
