// Make the nightly backup's B2 key with EXACTLY two capabilities:
// writeFiles + writeFileRetentions, restricted to the backup bucket
// (docs/12 "Backups"). B2's web UI cannot do this — its "Write Only" key also
// carries deleteFiles, bypassGovernance and every writeBucket* setting
// (measured 2026-11-09), which breaks the founder's "can't read or delete".
//
// THE FOUNDER RUNS THIS HIMSELF, in his own terminal:
//
//   node node_modules/tsx/dist/cli.mjs scripts/b2-create-backup-key.mts
//
// It asks for the account's MASTER application key (B2 website ->
// Application Keys -> Master Application Key -> Generate New). The master key
// is only typed in here — never saved by this script. It prints the new
// key's keyID + applicationKey for GitHub's BACKBLAZE_KEY_ID /
// BACKBLAZE_APP_KEY secrets, and checks the new key's capabilities by
// signing in with it.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { authorize, callOrThrow, resolveBucketId } from './b2.mts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const env = readFileSync(resolve(root, '.env.deploy'), 'utf8')
const bucket = /^BACKBLAZE_BUCKET=(.*)$/m.exec(env)?.[1]?.trim() ?? ''
if (!bucket) {
  console.error('Missing BACKBLAZE_BUCKET in .env.deploy')
  process.exit(1)
}

// Read lines from one iterator (rl.question loses the second answer when
// both arrive in one chunk, e.g. a paste of two lines).
const rl = createInterface({ input: process.stdin })
const lines = rl[Symbol.asyncIterator]()
const ask = async (prompt: string) => {
  process.stdout.write(prompt)
  return String((await lines.next()).value ?? '').trim()
}
const masterId = await ask('Master keyID (12 characters): ')
const masterKey = await ask('Master applicationKey (the long one, ~42 characters): ')
rl.close()

const master = await authorize(masterId, masterKey)
if (!master.capabilities.includes('writeKeys')) {
  console.error('That key cannot make keys (no writeKeys) — use the MASTER application key.')
  process.exit(1)
}
const bucketId = await resolveBucketId(master, bucket)

const created = await callOrThrow(master, 'b2_create_key', {
  accountId: master.accountId,
  keyName: 'github-backup-writer-exact',
  capabilities: ['writeFiles', 'writeFileRetentions'],
  bucketId,
})

// Prove it: sign in with the NEW key and read back what B2 granted.
const check = await authorize(created.applicationKeyId, created.applicationKey)
const caps = [...check.capabilities].sort()
// Same allow-list as backup-to-b2.mts (B2 may add the harmless list* ones).
const allowed = ['writeFiles', 'writeFileRetentions', 'listBuckets', 'listAllBucketNames']
const exact =
  caps.includes('writeFiles') && caps.includes('writeFileRetentions') &&
  caps.every((c) => allowed.includes(c)) && check.restrictedBucketId === bucketId
console.log(`\nNew key capabilities: ${caps.join(', ')}  (bucket-restricted: ${check.restrictedBucketId === bucketId})`)
console.log(exact ? 'OK — exactly upload + set the lock, this bucket only.' : 'WARNING — not the exact set; do not use it.')
console.log('\nPaste these into GitHub (Settings -> Secrets and variables -> Actions), then close this terminal:')
console.log(`  BACKBLAZE_KEY_ID  = ${created.applicationKeyId}`)
console.log(`  BACKBLAZE_APP_KEY = ${created.applicationKey}`)
