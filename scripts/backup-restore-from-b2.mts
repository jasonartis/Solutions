// Get a prod backup back out of B2 and decrypt it (docs/12 "Backups").
//
//   node node_modules/tsx/dist/cli.mjs scripts/backup-restore-from-b2.mts <path to platform-backup-key.txt> [stamp]
//
// Needs in .env.deploy (git-ignored): B2_READ_KEY_ID, B2_READ_APP_KEY,
// B2_BUCKET — the READ-ONLY key, never the nightly write-only one.
// Without [stamp] it fetches the newest backup and lists the others.
//
// Writes backups/restored-from-b2/<stamp>/schema.sql + data.sql (git-ignored).
// Loading those into a database is the docs/12 restore recipe — same files
// as `pnpm backup:prod` makes.
//
// It also reports each file's Object Lock as B2 sees it, so a restore drill
// doubles as a check that the 30-day compliance lock is really on.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Decrypter } from 'age-encryption'
import { authorize, call, callOrThrow, downloadById, resolveBucketId, sha1Hex } from './b2.mts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [keyPath, wantStamp] = process.argv.slice(2)
if (!keyPath) {
  console.error('Usage: backup-restore-from-b2.mts <path to platform-backup-key.txt> [stamp]')
  process.exit(1)
}

const env = readFileSync(resolve(root, '.env.deploy'), 'utf8')
const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''
const keyId = get('B2_READ_KEY_ID')
const appKey = get('B2_READ_APP_KEY')
const bucket = get('B2_BUCKET')
if (!keyId || !appKey || !bucket) {
  console.error('Missing B2_READ_KEY_ID / B2_READ_APP_KEY / B2_BUCKET in .env.deploy')
  process.exit(1)
}

// The identity is the one line starting AGE-SECRET-KEY; the rest are comments.
const identity = readFileSync(resolve(keyPath), 'utf8')
  .split(/\r?\n/)
  .find((l) => l.startsWith('AGE-SECRET-KEY-'))
if (!identity) {
  console.error('No AGE-SECRET-KEY line in that file.')
  process.exit(1)
}
const decrypter = new Decrypter()
decrypter.addIdentity(identity)

const auth = await authorize(keyId, appKey)
const caps = auth.capabilities
console.log(`Read key capabilities: ${[...caps].sort().join(', ')}`)
for (const bad of ['writeFiles', 'deleteFiles']) {
  if (caps.includes(bad)) console.log(`WARNING: this "read" key also has ${bad}.`)
}
const bucketId = await resolveBucketId(auth, bucket)

// List every backup file (names look like prod/<stamp>/<file>.age).
const all: { fileName: string; fileId: string }[] = []
let startFileName: string | null = null
do {
  const page = await callOrThrow(auth, 'b2_list_file_names', {
    bucketId, prefix: 'prod/', maxFileCount: 1000, ...(startFileName ? { startFileName } : {}),
  })
  all.push(...page.files)
  startFileName = page.nextFileName
} while (startFileName)

const stamps = [...new Set(all.map((f) => f.fileName.split('/')[1]))].sort()
console.log(`${stamps.length} backup(s) in B2: ${stamps.slice(-5).join(', ')}${stamps.length > 5 ? ' …' : ''}`)
const stamp = wantStamp ?? stamps.at(-1)
const chosen = all.filter((f) => f.fileName.startsWith(`prod/${stamp}/`))
if (!stamp || chosen.length === 0) {
  console.error(`No files for backup ${stamp ?? '(none)'}`)
  process.exit(1)
}

const outDir = resolve(root, 'backups', 'restored-from-b2', stamp)
mkdirSync(outDir, { recursive: true })
for (const f of chosen) {
  const info = await call(auth, 'b2_get_file_info', { fileId: f.fileId })
  const ret = info.body?.fileRetention
  const lock = ret?.isClientAuthorizedToRead
    ? `${ret.value?.mode ?? 'NONE'} until ${ret.value?.retainUntilTimestamp ? new Date(ret.value.retainUntilTimestamp).toISOString() : '-'}`
    : '(this key cannot read retention)'

  const res = await downloadById(auth, f.fileId)
  if (!res.ok) throw new Error(`download ${f.fileName} failed: HTTP ${res.status}`)
  const cipher = new Uint8Array(await res.arrayBuffer())
  if (sha1Hex(cipher) !== res.headers.get('x-bz-content-sha1')) throw new Error(`${f.fileName}: sha1 mismatch`)
  // age is authenticated encryption: a tampered or truncated file throws here.
  const plain = await decrypter.decrypt(cipher)
  const outName = f.fileName.split('/').at(-1)!.replace(/\.age$/, '')
  writeFileSync(resolve(outDir, outName), plain)
  console.log(`${outName}: ${cipher.byteLength} bytes encrypted -> ${plain.byteLength} decrypted; lock: ${lock}`)
}
console.log(`Restored to backups/restored-from-b2/${stamp}/`)
