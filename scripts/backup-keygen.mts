// One-time: make the key pair that encrypts the nightly prod backups
// (docs/12 "Backups").
//
//   node node_modules/tsx/dist/cli.mjs scripts/backup-keygen.mts <folder OUTSIDE the repo>
//
// - The PUBLIC half goes to scripts/backup-recipient.txt and is committed:
//   GitHub Actions encrypts each backup to it. A public key can only lock,
//   never unlock, so a public repo is a fine home for it.
// - The PRIVATE half goes to <folder>/platform-backup-key.txt and NOWHERE
//   else — never the repo, never GitHub, never printed by this script. It is
//   the ONLY way to read any backup. Lose it and every backup is unreadable;
//   B2 cannot recover it.
//
// The key type is age's post-quantum hybrid (ML-KEM-768 + X25519), so a
// backup copied today cannot be opened later by a future quantum computer —
// the founder's "collect now, decrypt later" concern (docs/12, 2026-11-03).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateHybridIdentity, identityToRecipient } from 'age-encryption'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outArg = process.argv[2]
if (!outArg) {
  console.error('Usage: backup-keygen.mts <folder outside the repo for the PRIVATE key>')
  process.exit(1)
}
const outDir = resolve(outArg)
const rel = relative(root, outDir)
if (!rel.startsWith('..') && !isAbsolute(rel)) {
  console.error('Refusing: the private key folder is inside the repo. Pick a folder outside it.')
  process.exit(1)
}

const keyFile = resolve(outDir, 'platform-backup-key.txt')
const recipientFile = resolve(root, 'scripts', 'backup-recipient.txt')
// Never overwrite: replacing either half silently would make new backups
// unreadable with the key the founder has stored.
for (const f of [keyFile, recipientFile]) {
  if (existsSync(f)) {
    console.error(`Refusing: ${f} already exists. Rotating the key is a deliberate act — see docs/12.`)
    process.exit(1)
  }
}

const identity = await generateHybridIdentity()
const recipient = await identityToRecipient(identity)

mkdirSync(outDir, { recursive: true })
writeFileSync(
  keyFile,
  [
    '# Solutions Platform — PRIVATE key for the encrypted prod backups.',
    `# created: ${new Date().toISOString()}`,
    '# Anyone holding this line can read every backup. Keep it offline.',
    '# Losing it makes every backup unreadable; nobody can recover it.',
    '# Restore: scripts/backup-restore-from-b2.mts (docs/12 "Backups").',
    identity,
    '',
  ].join('\n'),
  { flag: 'wx' },
)
writeFileSync(recipientFile, recipient + '\n', { flag: 'wx' })

console.log(`Private key written to: ${keyFile}  (not printed)`)
console.log(`Public key written to:  ${recipientFile}  (${recipient.length} chars, starts ${recipient.slice(0, 8)})`)
