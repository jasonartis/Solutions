// Removes uploaded files whose owning record is gone — the worker's
// platform.storage-orphan-sweep job, run by hand (prod has no always-on worker).
// The rules and their reasons live in apps/worker/src/jobs/storage-orphan-sweep.ts.
//
//   node node_modules/tsx/dist/cli.mjs scripts/storage-orphan-sweep.mts            # prod, dry run: lists only
//   node node_modules/tsx/dist/cli.mjs scripts/storage-orphan-sweep.mts --apply    # prod, removes them
//   ... --local [--apply]                                                          # local stack
//
// Removing a file cannot be undone (the nightly backup holds storage ROWS, not
// files), so read the dry-run list before --apply.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { runStorageOrphanSweep } from '../apps/worker/src/jobs/storage-orphan-sweep'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL = process.argv.includes('--local')
const APPLY = process.argv.includes('--apply')

let connectionString: string
let url: string
let serviceKey: string
if (LOCAL) {
  connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
  url = process.env.SUPABASE_URL || 'http://127.0.0.1:54321'
  serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
} else {
  const env = readFileSync(resolve(root, '.env.deploy'), 'utf8')
  const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''
  const ref = get('SUPABASE_PROJECT_REF')
  const pw = get('SUPABASE_DB_PASSWORD')
  if (!ref || !pw) throw new Error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD in .env.deploy')
  connectionString = `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres?sslmode=require`
  url = `https://${ref}.supabase.co`
  serviceKey = get('SUPABASE_SERVICE_ROLE_KEY')
}
if (APPLY && !serviceKey) throw new Error('--apply needs SUPABASE_SERVICE_ROLE_KEY')

console.log(`${LOCAL ? 'LOCAL' : 'PROD'} — ${APPLY ? 'REMOVING orphaned files' : 'dry run (nothing is removed)'}`)
const admin = serviceKey ? createClient(url, serviceKey, { auth: { persistSession: false } }) : null
const { orphans, removed, unrecognised } = await runStorageOrphanSweep(connectionString, admin, { apply: APPLY })
for (const o of orphans) console.log(`  ${o.bucket}  ${o.reason}  ${o.bytes} B  ${o.name}`)
console.log(`${orphans.length} orphaned, ${removed} removed, ${unrecognised} left alone (unrecognised path)`)
