// Installs the server-only token that the public Report content page needs
// (migration 20261114010000, module-9 spec §B1). Without it, content_report_submit
// refuses every report ("Report intake unavailable") and the console says so.
//
//   node node_modules/tsx/dist/cli.mjs scripts/set-content-report-token.mts --local
//   node node_modules/tsx/dist/cli.mjs scripts/set-content-report-token.mts          (PROD)
//
// --local: installs the hash of the fixed dev token 'local-dev-content-report-token'
//   in the local database (scripts/dev.ts puts the same token in apps/web/.env.local;
//   CI runs this after `pnpm seed`). Safe to re-run.
//
// PROD: makes a NEW random token, writes only its SHA-256 to prod through the
//   pooler (SUPABASE_DB_PASSWORD), and sets CONTENT_REPORT_TOKEN on Vercel
//   (production) with VERCEL_TOKEN — both from .env.deploy. The token is never
//   printed or saved anywhere else. It takes effect at the NEXT deploy; until
//   then the live site holds the old token (or none) and reports are refused.
//   Re-running rotates it (same rule: refused until the next deploy).
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL = process.argv.includes('--local')
export const LOCAL_TOKEN = 'local-dev-content-report-token'

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

async function install(sql: ReturnType<typeof postgres>, token: string) {
  await sql`insert into public.content_report_intake_config (id, token_sha256, updated_at)
            values (true, ${sha256(token)}, now())
            on conflict (id) do update set token_sha256 = excluded.token_sha256, updated_at = now()`
  const [row] = await sql<{ ok: boolean }[]>`select token_sha256 = ${sha256(token)} as ok from public.content_report_intake_config`
  if (!row?.ok) throw new Error('The token hash did not land')
}

if (LOCAL) {
  const sql = postgres(process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres', { max: 1 })
  try {
    await install(sql, LOCAL_TOKEN)
    console.log('Local report intake configured (token: local-dev-content-report-token).')
  } finally {
    await sql.end()
  }
} else {
  const env = readFileSync(resolve(root, '.env.deploy'), 'utf8')
  const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''
  const ref = get('SUPABASE_PROJECT_REF')
  const pw = get('SUPABASE_DB_PASSWORD')
  const vercel = get('VERCEL_TOKEN')
  if (!ref || !pw || !vercel) throw new Error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD / VERCEL_TOKEN in .env.deploy')

  const token = randomBytes(32).toString('base64url')

  // Vercel first: if it fails, prod's database still holds the old hash and nothing changed.
  const res = await fetch('https://api.vercel.com/v10/projects/solutions-platform/env?upsert=true', {
    method: 'POST',
    headers: { Authorization: `Bearer ${vercel}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'CONTENT_REPORT_TOKEN', value: token, type: 'encrypted', target: ['production'] }),
  })
  if (!res.ok) throw new Error(`Vercel refused the env var: ${res.status} ${(await res.text()).slice(0, 200)}`)
  console.log('Vercel: CONTENT_REPORT_TOKEN set for production.')

  const sql = postgres(
    `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`,
    { ssl: 'require', max: 1 },
  )
  try {
    await install(sql, token)
    console.log('Prod database: token hash installed.')
  } finally {
    await sql.end()
  }
  console.log('Next: redeploy (or push) so the live site picks up the new token, then run scripts/prod-verify-content-reports.mts.')
}
