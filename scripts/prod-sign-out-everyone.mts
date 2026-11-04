// INCIDENT TOOL: signs every user out of PRODUCTION by deleting all
// `auth.refresh_tokens` and `auth.sessions` rows. Written 2026-11-03 after the
// nightly backup artifacts (which contain both tables) were found downloadable
// from the public repo (docs/12). A copied refresh token stops working the
// moment its row is gone. An already-issued access token (JWT) keeps working
// until it expires (the project's JWT expiry, 1 hour by default) — nothing
// server-side can recall it short of rotating the JWT signing key.
//
// Everyone, including the founder, must sign in again. Nothing else changes:
// accounts, passwords and data are untouched.
//
// Connects like scripts/prod-verify-superadmin-log.mts (session pooler +
// SUPABASE_DB_PASSWORD from .env.deploy). Runs in ONE transaction and prints
// counts before and after.
//
// Usage: pnpm exec tsx scripts/prod-sign-out-everyone.mts
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const env = readFileSync(resolve(root, '.env.deploy'), 'utf8')
const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''

const ref = get('SUPABASE_PROJECT_REF')
const pw = get('SUPABASE_DB_PASSWORD')
if (!ref || !pw) throw new Error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD in .env.deploy')

const sql = postgres(
  `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`,
  { ssl: 'require', max: 1 },
)

const counts = async (tx: postgres.TransactionSql | postgres.Sql) => {
  const [r] = await tx`
    select (select count(*) from auth.sessions)::int as sessions,
           (select count(*) from auth.refresh_tokens)::int as refresh_tokens,
           (select count(*) from auth.users)::int as users`
  return r
}

try {
  console.log('before:', await counts(sql))
  await sql.begin(async (tx) => {
    await tx`delete from auth.refresh_tokens`
    await tx`delete from auth.sessions`
  })
  const after = await counts(sql)
  console.log('after: ', after)
  // Control: users must be untouched, or something far worse than a sign-out happened.
  if (after.sessions !== 0 || after.refresh_tokens !== 0) process.exitCode = 1
} finally {
  await sql.end()
}
