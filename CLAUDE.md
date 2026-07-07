# CLAUDE.md — Solutions Platform

## What this is

A multi-tenant modular platform: each client engagement produces a **module** built on shared primitives; clients are org users entitled to modules. Full context lives in `docs/` — **treat the docs as the source of truth and keep them current; a change that makes docs stale isn't done.**

## Read before working

1. [docs/00-vision-and-strategy.md](docs/00-vision-and-strategy.md) — why, principles (extract-don't-speculate; one deployment; tenancy isolation is existential)
2. [docs/01-architecture.md](docs/01-architecture.md) — monorepo layout, multi-tenancy/RLS rules, primitives catalog, local dev, batch/live
3. [docs/03-adding-a-module.md](docs/03-adding-a-module.md) — module anatomy, hard rules, process (when touching/creating modules)
4. [docs/04-build-plan.md](docs/04-build-plan.md) — current milestone and order
5. The relevant `docs/modules/*.md` spec — every module decision is recorded there, dated

## Current state (update this section as work progresses)

- **2026-07-07 (night):** **Module 3 ACCEPTANCE PASSED** — Pozna's real Shabbos schedule reproduced from real myzmanim values (`pozna-acceptance.test.ts`, 49 module tests). Rule grammar complete (open zman vocab, day anchors, clamps, line-refs, fallback text, weekday conditions, title templating + molad) and fully exposed in the rule-builder UI. **Extraction pass done** (docs/03 conventions; `requireOrgModule()` gate; module 3 = exemplar). **Production live: solutions-platform.vercel.app** (Vercel via GitHub Actions deploy, prod Supabase migrated, founder is superadmin, real org `pozne` configured; walkthrough test script in docs/08). PARKED: myzmanim auth (context in module SPEC). NOT deployed: worker (prod exports pend until Phase B VPS). **Module 2 scaffold + module 1 scoring engine being drafted by agents** into modules/classroom/ and modules/matchmaking/ (drafts; integration next).
- **2026-07-07 (late):** **Module 3 core loop complete** — rule grammar + evaluator + week generator (15 unit tests), schedule view UI, maker setup UI (rule builder, publish controls, weekly messages), export pipeline (job_requests contract + worker Playwright renders → syn-exports bucket, verified: pdf/jpg files), public no-login viewer at `/s/<slug>` via security-definer functions exposing only published weeks. e2e 7/7; CI green through run #13; all four migrations on prod Supabase (`jbjqrkxdoiolwlglvoki`).
  **Blocked on founder:** myzmanim API key (connector next), sample schedule + rules sheet (acceptance validation), Vercel account (signup broken — fallback: VPS hosting per docs/05).
  **Platform primitives that now exist:** job_requests (async job→result), storage bucket w/ org-scoped read, has_module_role(), settings-in-org_modules pattern, public-access-via-definer-functions pattern.

- **2026-07-06 (evening):** M0 foundation built and verified locally. Monorepo scaffolded (Next.js 16 web app, pg-boss worker, packages/db + platform); core schema with RLS applied to local Supabase; seed script (`pnpm seed`) creates founder + two demo orgs; **RLS isolation tests 7/7 passing** (`pnpm --filter @platform/db test`); auth (password + magic link) + entitlement-driven app shell + stub module + owner console render and gate correctly; dev harness (`pnpm dev`) and CI workflow written. Local logins: owner/alice/bob `@demo.local` / `password123`.
  **2026-07-07 update:** pushed to GitHub (`github.com/jasonartis/Solutions`, remote pinned to the `jasonartis` credential) — CI green including RLS tests. Playwright e2e added (5 tests: entitlement chain, cross-org 404, console, redirects, sign-out) and wired into CI against the prod build. `dev:cloud-db` mode added with staging-only guard rails. `pnpm status` shows what's running; worker serves `/healthz` on :8901.
  **Remaining for M0:** first cloud deploy (founder does docs/07 Parts 2–3: Supabase + Vercel accounts), Sentry/UptimeRobot wiring at deploy time. `dev:docker` deliberately deferred to the VPS-deploy milestone. Then M1: module 3 (synagogue schedules) — needs founder's sample schedule output + rules sheet + synagogue zip + myzmanim key.
- **2026-07-06:** Planning complete. Six module specs + all architecture/tech/ops decisions documented.

## Hard-won local-dev gotchas (Windows host)

- Node module compile cache corruption makes pnpm OOM-crash at tiny heaps → delete `%TEMP%\node-compile-cache`.
- PowerShell 5.1 `-Encoding utf8` writes a BOM; the Supabase CLI refuses BOM'd `.env` files. Write env files from Node (scripts/dev.ts) or with BOM-less UTF8.
- After `supabase db reset`, Kong can hold a stale route to the recreated auth container (502 on `/auth/v1/*` while `rest` works) → `docker restart supabase_kong_Solutions_Platform`.
- `import.meta.dirname` is `undefined` under tsx — use `dirname(fileURLToPath(import.meta.url))`.
- Docker Desktop's WSL backend crashed under parallel image pulls → `C:\Users\yarmishj\.wslconfig` caps WSL at 8GB/4CPU (delete to revert); pull images sequentially if it recurs; zero-log segfaulting containers (exit 139) = corrupted image layers, `docker rmi` + re-pull.
- Tables created in CLI migrations do NOT inherit Supabase's default API-role grants — every migration must `grant` explicitly (see 20260706120000_core.sql).

## Key standing decisions

- **Stack:** TypeScript, Next.js (App Router), Supabase (Postgres+Auth+Storage+Realtime; local via `supabase start`), Drizzle, pg-boss worker, Tailwind+shadcn/ui, pnpm+Turborepo monorepo. Rationale + alternatives + exit ramps: docs/02.
- **Hosting:** managed-first (Supabase + Vercel free tiers), one small VPS for the worker later, cost phases in docs/05.
- **Security invariant:** every module table has `org_id` + RLS policy; web app queries as the user (RLS enforced); service-role key only in the worker.
- **Code style:** explicit over clever — the founder codes alongside AI (Apps Script/JS background; Copilot may be used too). Fewer abstractions, standard patterns, inline docs where intent isn't obvious.
- Module tables are prefixed (`mm_`, `cls_`, `syn_`, `vm_`, `sal_`, `sd_`); modules never import other modules; shared behavior goes through `packages/platform`.
- **exFAT constraint:** the repo drive (D:) can't do symlinks. NO `workspace:*` dependencies — internal packages are imported via `@platform/*` tsconfig path aliases, and `.npmrc` pins `node-linker=hoisted`. Details + deferred NTFS revert: docs/01.

## Founder profile & working style (canonical — mirror of any session memory)

- **Founder:** Jason (yarmishj@artisenergy.com; platform account jasonartisenergy@gmail.com).
  Google Apps Script/Sheets background; teaches a university course (module 2 mirrors his
  real class workflow); day job at Artis Energy (energy/utility domain — the prior-art
  codebases in docs/06 are his).
- **How he works with AI:** maximum autonomous momentum. His words (2026-07-07): "Ask me as
  little as possible for permissions. Even when you do have something to ask me, you can
  pause to ask but try to work on something else as well while you wait." Batch questions;
  keep an independent track moving while anything is pending; use background tasks and
  parallel agents freely; report outcomes, not requests for permission.
- **Interaction patterns that work:** numbered load-bearing questions (he answers inline,
  point by point); real client artifacts as specs; click-by-click walkthroughs for testing;
  plain-language explanations of infra concepts (he asks — answer directly, no jargon).
- **Code prefs:** explicit TypeScript over clever; few abstractions; inline docs where
  intent isn't obvious; he may read/modify code himself and Copilot may join.
- **Command execution on this machine:** run sandboxed by default — the sandbox-bypass
  flag triggers permission prompts every time and was the main prompt-fatigue source.
  Single commands starting with an allowlisted program (pnpm/git/node/tsx/docker/supabase);
  complex logic goes in script files, not shell one-liners.

## Working agreements

- Never build platform primitives speculatively — extract them when a second module needs the same thing.
- Migrations: forward-only, additive-first, always run locally before cloud.
- Every module ships with seed data and critical-path e2e tests (each role completes its core task).
- Dated **decisions logs** in module specs record client choices — don't re-litigate them silently; if a decision must change, update the spec with a new dated entry.
