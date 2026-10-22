import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Two jobs, both added for the view-as slice (docs/15 §8.1, 20260731010000):
//
// 1. Resolve `@platform/core`. The RLS suite now asserts the view-as
//    declarations against the live database — notably that every TypeScript
//    position rank matches SQL's `module_position_rank()`, and that
//    `module_view_as_edge()` agrees with the TypeScript edge map pair for pair.
//    The repo has no `workspace:*` deps (exFAT can't do symlinks, docs/01), so
//    the alias is spelled out here the way apps/web/tsconfig.json spells it out
//    for Next.
//
// 2. Load the repo-root `.env` into process.env. The suite reads
//    SUPABASE_URL/SUPABASE_ANON_KEY from there, and its own error message says
//    "run `pnpm dev` once to generate .env" — but Vitest looks for .env beside
//    the package, where there is none, so `pnpm --filter @platform/db test`
//    only worked when those vars happened to already be exported (as CI does).
//    Loading them explicitly makes the documented local command work as
//    documented. Real environment variables still win: CI sets them directly.
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')

export default defineConfig({
  test: {
    // '' as the prefix means every var, not just VITE_-prefixed ones.
    env: loadEnv('', repoRoot, ''),
    // TEST FILES RUN ONE AT A TIME. Every file here shares ONE database, and
    // several commit real rows (users, orgs, org_members) before cleaning up.
    // rls.test.ts's "CI-ORDER GUARD" snapshots the whole org_members table and
    // asserts it is unchanged at the end of its block — so any OTHER file
    // committing a membership row while that block runs fails it, at random
    // (seen 2026-10-20: CI red on 28 rows vs 44, green on the same sha when
    // re-run, blocking every deploy). Serial files make the guard meaningful and
    // also remove the "5s timeout under parallel load" flakes the pending-invites
    // files hit. Cost: ~1 min -> ~3 min for the suite (docs/12 item 1).
    fileParallelism: false,
  },
  resolve: {
    alias: { '@platform/core': resolve(here, '../platform/src/index.ts') },
  },
})
