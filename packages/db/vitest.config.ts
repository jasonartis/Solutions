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
  },
  resolve: {
    alias: { '@platform/core': resolve(here, '../platform/src/index.ts') },
  },
})
