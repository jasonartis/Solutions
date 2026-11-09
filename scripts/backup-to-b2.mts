// Nightly: encrypt the newest prod dump and upload it to the PRIVATE
// Backblaze B2 bucket with a 30-day compliance lock (docs/12 "Backups").
// Runs in .github/workflows/backup-b2.yml right after `pnpm backup:prod`.
//
//   B2_KEY_ID=… B2_APP_KEY=… B2_BUCKET=… node node_modules/tsx/dist/cli.mjs scripts/backup-to-b2.mts
//
// Founder's rules (2026-11-03/08), each enforced here:
// 1. Backups never go anywhere public — this script writes ONLY to B2, and
//    only ciphertext. Nothing about the dump's contents is printed (the repo
//    and therefore this job's log are public).
// 2. Encrypted before upload to the public key in scripts/backup-recipient.txt;
//    the private half stays offline with the founder.
// 3. The B2 key can't read or delete — checked EVERY night, two ways: its
//    capability list, and real attempts that must be refused.
// 4. 30-day compliance lock on each file (set per upload; the bucket has no
//    default retention).
// The job goes red if any of these fails; the upload still happens first,
// because a locked encrypted backup is better than none.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Encrypter } from 'age-encryption'
import { authorize, call, downloadById, resolveBucketId, sha1Hex, uploadLocked } from './b2.mts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RETENTION_DAYS = 30

const keyId = process.env.B2_KEY_ID ?? ''
const appKey = process.env.B2_APP_KEY ?? ''
const bucket = process.env.B2_BUCKET ?? ''
if (!keyId || !appKey || !bucket) {
  console.error('Missing B2_KEY_ID / B2_APP_KEY / B2_BUCKET')
  process.exit(1)
}

// --- the dump to send: newest backups/<stamp>/ folder ----------------------
const backupsDir = resolve(root, 'backups')
const stamps = readdirSync(backupsDir)
  .filter((d) => /^\d{4}-\d{2}-\d{2}T/.test(d) && statSync(resolve(backupsDir, d)).isDirectory())
  .sort()
const stamp = stamps.at(-1)
if (!stamp) {
  console.error('No backups/<timestamp>/ folder found — did `pnpm backup:prod` run?')
  process.exit(1)
}
const files = ['schema.sql', 'data.sql']

// --- encrypt -----------------------------------------------------------------
// Whole-file in memory: today's dump is well under 1 MB. If it ever grows
// past a few hundred MB, switch to the library's stream form of encrypt().
const recipient = readFileSync(resolve(root, 'scripts', 'backup-recipient.txt'), 'utf8').trim()
if (!recipient.startsWith('age1')) {
  console.error('scripts/backup-recipient.txt does not hold an age public key')
  process.exit(1)
}
const encrypter = new Encrypter()
encrypter.addRecipient(recipient)

const failures: string[] = []
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

// --- authorize + capability check -------------------------------------------
const auth = await authorize(keyId, appKey)
const caps = [...auth.capabilities].sort()
console.log(`Key capabilities: ${caps.join(', ')}`)
for (const need of ['writeFiles', 'writeFileRetentions']) check(caps.includes(need), `key HAS ${need}`)
// Anything that could read, delete, share, unlock, or loosen the bucket.
const forbidden = [
  'readFiles', 'shareFiles', 'listFiles', 'deleteFiles',
  'bypassGovernance', 'writeFileLegalHolds',
  'writeBuckets', 'deleteBuckets', 'writeBucketRetentions', 'writeBucketEncryption',
  'writeBucketReplications', 'writeBucketNotifications', 'writeBucketLogging',
  'writeKeys', 'deleteKeys',
]
for (const bad of forbidden) check(!caps.includes(bad), `key LACKS ${bad}`)

// --- upload, locked ------------------------------------------------------------
const bucketId = await resolveBucketId(auth, bucket)
const retainUntil = Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000
const uploaded: { fileName: string; fileId: string }[] = []
for (const f of files) {
  const plain = readFileSync(resolve(backupsDir, stamp, f))
  const cipher = await encrypter.encrypt(new Uint8Array(plain))
  // Belt and braces: an age file always starts with this header line. If it
  // didn't, we would be about to upload plaintext.
  check(Buffer.from(cipher.subarray(0, 21)).toString() === 'age-encryption.org/v1', `${f} is age ciphertext`)
  if (failures.length) break
  const fileName = `prod/${stamp}/${f}.age`
  const res = await uploadLocked(auth, bucketId, fileName, cipher, retainUntil)
  check(res.contentSha1 === sha1Hex(cipher), `${fileName} uploaded (${cipher.byteLength} bytes, sha1 matches)`)
  uploaded.push({ fileName, fileId: res.fileId })
}
console.log(`Locked (compliance) until ${new Date(retainUntil).toISOString()}`)

// --- prove the key can't read, delete, list, or loosen ------------------------
// Each must be REFUSED. A 401 is B2's "this key lacks the capability".
const probe = uploaded[0]
if (probe) {
  const dl = await downloadById(auth, probe.fileId)
  await dl.arrayBuffer().catch(() => {})
  check(dl.status === 401, `read refused (download -> HTTP ${dl.status})`)

  const del = await call(auth, 'b2_delete_file_version', { fileName: probe.fileName, fileId: probe.fileId })
  check(!del.ok, `delete refused (-> ${del.status} ${del.code})`)

  const list = await call(auth, 'b2_list_file_names', { bucketId, maxFileCount: 1 })
  check(!list.ok, `list refused (-> ${list.status} ${list.code})`)

  const shorten = await call(auth, 'b2_update_file_retention', {
    fileName: probe.fileName,
    fileId: probe.fileId,
    fileRetention: { mode: 'compliance', retainUntilTimestamp: Date.now() + 60 * 60 * 1000 },
  })
  check(!shorten.ok, `shortening the lock refused (-> ${shorten.status} ${shorten.code})`)
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) FAILED — see above. docs/12 "Backups".`)
  process.exit(1)
}
console.log(`\nOK: prod/${stamp}/ — ${uploaded.length} encrypted files, locked ${RETENTION_DAYS} days.`)
