// Local credential-file backup (founder request, 2026-09-02). Snapshots every
// real (non-.example) .env* file in the repo into a timestamped folder under
// env-backups/ (git-ignored) — same drive, deliberately: this protects
// against an accidental edit/delete of the working copy, NOT against disk
// failure or loss. .env.deploy and .env.accounts are the two files whose
// loss is genuinely unrecoverable (docs/12) — keep those two specifically
// in a password manager too.
//
//   pnpm backup:envs
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const files = [
  '.env',
  '.env.deploy',
  '.env.accounts',
  'apps/web/.env.local',
  'apps/worker/.env',
  '.vercel/.env.production.local',
]

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const outDir = resolve(root, 'env-backups', stamp)
mkdirSync(outDir, { recursive: true })

let copied = 0
for (const f of files) {
  const src = resolve(root, f)
  if (!existsSync(src)) continue
  const dest = resolve(outDir, f.replace(/[\\/]/g, '__'))
  writeFileSync(dest, readFileSync(src))
  console.log(`  ${relative(root, src)} -> env-backups/${stamp}/${relative(outDir, dest)}`)
  copied++
}

console.log(`Backed up ${copied}/${files.length} env file(s) to env-backups/${stamp}/`)
if (copied < files.length) {
  console.log('(missing files are skipped, not an error — not every file exists on every machine)')
}
