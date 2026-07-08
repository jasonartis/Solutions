// Run the worker on THIS machine against PRODUCTION — the free stopgap until
// the VPS exists (docs/10). The worker only makes outbound connections, so a
// dev PC works fine: production exports process whenever this is running;
// while it's off, job_requests queue harmlessly until the next run.
//
//   pnpm worker:prod        (Ctrl+C to stop)
//
// Credentials come from .env.deploy (git-ignored). The DATABASE_URL uses the
// Supabase SESSION POOLER (IPv4; the direct connection is IPv6-only) — host
// verified against the project's region (us-west-2) on 2026-07-09.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const env = readFileSync(resolve(root, '.env.deploy'), 'utf8')
const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''

const ref = get('SUPABASE_PROJECT_REF')
const dbPassword = get('SUPABASE_DB_PASSWORD')
const serviceKey = get('SUPABASE_SERVICE_ROLE_KEY')
if (!ref || !dbPassword || !serviceKey) {
  console.error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD / SUPABASE_SERVICE_ROLE_KEY in .env.deploy')
  process.exit(1)
}

const poolerHost = 'aws-1-us-west-2.pooler.supabase.com'
const databaseUrl = `postgresql://postgres.${ref}:${encodeURIComponent(dbPassword)}@${poolerHost}:5432/postgres`

console.log('┌─────────────────────────────────────────────────────────────┐')
console.log('│  PRODUCTION worker (local stopgap — docs/10 has the VPS     │')
console.log(`│  plan). Project: ${ref}  DB via session pooler.   │`)
console.log('│  Exports/jobs process while this runs; Ctrl+C to stop.      │')
console.log('└─────────────────────────────────────────────────────────────┘')

const child = spawn(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['--filter', 'worker', 'dev'],
  {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      SUPABASE_URL: `https://${ref}.supabase.co`,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey,
      MYZMANIM_USER: get('MYZMANIM_USER'),
      MYZMANIM_KEY: get('MYZMANIM_KEY'),
      // Different port from the local-dev worker so both can run at once.
      WORKER_HEALTH_PORT: process.env.WORKER_HEALTH_PORT ?? '8902',
    },
  },
)
child.on('exit', (code) => process.exit(code ?? 0))
