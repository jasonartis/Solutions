// Production database backup (docs/12 safeguards). Dumps schema + data from
// the PROD Supabase into a timestamped folder under backups/ (git-ignored).
//
//   pnpm backup:prod
//
// Run before anything risky touches production (migrations beyond additive,
// bulk scripts, reseeds) and periodically regardless. Credentials come from
// .env.deploy; the connection uses the session pooler (IPv4).
import { readFileSync, mkdirSync } from 'node:fs'
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

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const outDir = resolve(root, 'backups', stamp)
mkdirSync(outDir, { recursive: true })

function dump(args: string[], file: string) {
  // One quoted command string: the repo path contains a space, and Windows
  // needs shell execution for pnpm — unquoted arg concatenation truncates.
  const cmd = [
    'pnpm', 'exec', 'supabase', 'db', 'dump',
    '--db-url', '"' + dbUrl + '"',
    '-f', '"' + resolve(outDir, file) + '"',
    ...args,
  ].join(' ')
  const res = spawnSync(cmd, { cwd: root, stdio: 'inherit', shell: true })
  if (res.status !== 0) {
    console.error('Backup step failed: ' + file)
    process.exit(res.status ?? 1)
  }
}

console.log(`Backing up prod (${ref}) to backups/${stamp}/ …`)
dump([], 'schema.sql')
dump(['--data-only'], 'data.sql')
console.log(`Done. Restore guidance lives in docs/12-safeguards.md.`)
