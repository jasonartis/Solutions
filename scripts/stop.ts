// Stops the local stack: supabase containers. Dev processes started by
// `pnpm dev` stop with Ctrl+C in their terminal.
import { execSync } from 'node:child_process'
import { repoRoot } from './lib'

const dryRun = process.argv.includes('--dry-run')
console.log('[run] pnpm exec supabase stop')
if (!dryRun) {
  execSync('pnpm exec supabase stop', { cwd: repoRoot, stdio: 'inherit' })
  console.log('Local stack stopped.')
}
