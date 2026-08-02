# CLAUDE.md — Solutions Platform

## What this is

A multi-tenant modular platform: each client engagement produces a **module** built on shared primitives; clients are org users entitled to modules. Full context lives in `docs/` — **treat the docs as the source of truth and keep them current; a change that makes docs stale isn't done.**

## Read before working

1. [docs/00-vision-and-strategy.md](docs/00-vision-and-strategy.md) — why, principles (extract-don't-speculate; one deployment; tenancy isolation is existential)
2. [docs/01-architecture.md](docs/01-architecture.md) — monorepo layout, multi-tenancy/RLS rules, primitives catalog, local dev, batch/live
3. [docs/03-adding-a-module.md](docs/03-adding-a-module.md) — module anatomy, hard rules, process (when touching/creating modules)
4. [docs/04-build-plan.md](docs/04-build-plan.md) — current milestone and order
5. The relevant `docs/modules/*.md` spec — every module decision is recorded there, dated

## Current state (kept lean — full dated journal in docs/history/platform-journal.md)

<!-- MAINTENANCE: this section auto-loads every session, so keep it SHORT. When shipping a
     slice, move the old blow-by-blow into docs/history/platform-journal.md (newest-first)
     and update only the compact "Now / Next / Standing rules" below. A fresh chat must never
     pay for the full journal. See "Session hygiene". -->

**Now (2026-07-31):** Live on prod (solutions-platform.vercel.app). **User-model slice 5 —
VIEW-AS — is BUILT AND LOCALLY VERIFIED, NOT YET PUSHED TO PROD**
(`20260731010000_view_as_sessions.sql`, uncommitted). A higher position can render a lower
position's page shape as themselves (mode 1) or, for a declared pair, view a NAMED person's
surface read-only (mode 2). **Declarations exist for all 8 modules** — the rank-differential
completeness check is only a check if no module can opt out — but **edges are ON for classroom
only**, on the rule that §8.1 point 9 makes surface classification a per-module security review,
so an edge may only be ON where that review happened. **professor→student, the pair the spec
left explicitly OPEN, is answered ON (both modes)** with a deliberately narrow surface —
FOUNDER CONFIRMATION WANTED. **No new database read path**: everything renders through the
caller's own RLS client and the surface declaration is a column allow-list, so a table nobody
declared cannot appear. Enforcement is a TypeScript mapped type (undeclared pair ⇒ `pnpm
typecheck` fails, CI runs it) **plus** a SQL rank-parity test — the type keys on the TS rank
table while the authority is SQL's `module_position_rank()`, so **the type alone does not
deliver the amendment's guarantee**. Two Fable reviews; review 1 found 3 ship-blockers, all
fixed: the manifest edge table had **no enforcement at the live insert path** (a speed-dating
organizer could have minted a session naming a participant, a permanently banned pair) → ON
pairs mirrored into IMMUTABLE SQL (`module_view_as_edge()`) with one grant required to satisfy
rank+scope+edge together; FKs `on delete cascade` would have let a routine node delete erase the
audit trail → `set null`; and a missing explicit `revoke all` would have handed prod's
`ALTER DEFAULT PRIVILEGES` a TRUNCATE-able audit log. Review 2 then caught a regression created by review 1's own fix — the append-only
trigger and the new `on delete set null` FKs are incompatible (Postgres runs SET NULL as
a real UPDATE, so the trigger aborted the parent DELETE and made any referenced node,
user or org permanently undeletable) → append-only is now grants-only, as
`vm_moderation_log` always did it; plus a vacuous probe, a GA misclassification (a third
list, `unreadableByPosition`, now separates "viewer declines to render" from "the
position cannot read it"), and a test that looped only one surface. A self-review also
found mode 1 was not filtering by subject at all. RLS **77/77** (was 57), 2 e2e as real
users, **21/21 live probes** (`scripts/verify-view-as.mts`), typecheck 9/9. Rules → docs/03
**#18**; decisions → docs/15 (2026-07-31) + docs/modules/module-2-classroom.md; record →
journal.

**Previously (2026-07-29):** **ACL HARDENING SWEEP is PUSHED TO PROD AND PROD-VERIFIED**
(`20260728010000`, commit `a16f4a5`): backup → `--dry-run` → `migrate:prod` →
`verify-acl-hardening.ts --probe` 39/39 on prod, including a rolled-back live `anon` probe where
all 20 table reads/writes were refused `42501`. Closes the GRANT layer platform-wide so RLS stops
being the only gate: `anon` now holds nothing in `public` but schema `USAGE` + EXECUTE on the two
`syn_public_*` functions; the 54 trigger fns hold no api-role EXECUTE; `authenticated` keeps
EXECUTE on the other 81 non-trigger fns (**required** — policy expressions are permission-checked
as the querying role) but loses TRUNCATE/REFERENCES/TRIGGER/MAINTAIN (**RLS cannot gate
TRUNCATE**). Prod row counts unchanged; no data touched. Rules → docs/03 **#17**, docs/12.
`graphql_public` was raised as a possible anon surface and CLOSED — `pg_graphql` is not installed
on prod, so the wrapper returns "extension is not enabled" and no data is reachable.

**Next / open (pick WITH the founder — do not start unprompted; details in docs/15 §11):**
- **Slice 5 follow-ons (nearest work, all cheap now the mechanism exists):** confirm or flip
  **professor→student**; run the **nail-salon** view-as surface review (its 9 pairs are
  enumerated and OFF — manager→worker/cashier looks straightforward) and then **speed-dating**'s
  6; decide whether view-as **targets are notified** (§8.1 point 6 leaves it a product call);
  confirm the guard's deliberate **lack of an `is_org_admin` short-circuit**, a conscious break
  from docs/03 #9. Then **push slice 5 to prod** (backup → `--dry-run` → `migrate:prod` →
  `prod-verify-migration.ts`) — it is committed-but-unpushed work until then.
- Slice 3 remainder: **entity-level joinPolicy** (invite-only/request-approval/open per
  class/location/event) — deferred follow-on. Slice 4 (defaults-on-join) is the only
  unbuilt slice left.
- Single-entity modules (matchmaking / synagogue-schedules / visual-messaging) NOT yet
  rank-mapped — OPTIONAL (a real behavior change, not cosmetic). **Note since slice 5:** their
  vocabularies are entirely rank 0, so they imply no view-as pairs today; rank-mapping any of
  them will FAIL THE BUILD until every newly-implied pair is explicitly answered. That is the
  2026-07-30 amendment working as designed, not an obstacle — but budget for it.
- **Flaky e2e test — FIXED 2026-07-30** (`speed-dating module: register → round → mutual
  interest → reveal`): diagnosed as genuine timing/load, not RLS-suite data contamination or
  the test's own non-idempotency (full reasoning in docs/history/platform-journal.md's
  2026-07-30 entry). Fixed with a scoped `test.slow()`; verified via clean `db:reset` → seed →
  full RLS suite → full e2e suite reproduction (the exact failure-inducing order) — now passes.
- **New, unstarted (2026-08-02, surfaced by slice 5's clean-seed full-suite run):** a SECOND
  speed-dating test in the same flaky family — `speed-dating module: two-sided event enforces
  per-side capacity and waitlist promotion` — fails at the end of a full sequential run
  (timeout waiting for the event link after `signIn`) but **passes in 29s in isolation on a
  fresh seed**. Same symptom and shape as the sibling fixed 2026-07-30 (many sign-ins,
  data-heavy server components, unbuilt dev server, late in a long run), so a scoped
  `test.slow()` is the likely one-line fix — but that diagnosis has NOT been established the
  way the sibling's was (error-context analysis), so it was deliberately not applied blind.
  Unrelated to view-as: nothing in slice 5 is reachable from this flow. Note the earlier
  5-failure run in the same session was the documented order-dependency trap (the RLS suite
  ran immediately before e2e without a reset), not a real regression.
- Low-priority verification: the **worker** was not exercised after the ACL sweep (neither the RLS
  suite nor e2e touches it). It should be unaffected — `service_role`'s privileges are provably
  unchanged (the verifier asserts they can't shrink), it makes zero `.rpc()` calls, and pg-boss
  connects as `postgres`. Watch the next real job run rather than building a test for it.
- `gh` is NOT installed on this machine — CI status can't be read from the terminal; check
  GitHub's UI.
- **Founder-raised 2026-08-02, parked in docs/13:** a superadmin **read-only** view of every
  module's positions/ranks/view-as pair grid + surfaces (highest-value follow-on — those
  decisions are real and tested but buried in a TS file), and generalising per-position
  visibility as a *documented, test-proven* map rather than generated RLS. Both entries carry
  the reusable line they produced: **anything that WIDENS reach belongs in code; anything that
  only NARROWS it can be a runtime switch.**
- Everywhere role-clarity labels (founder testing-round items 31–42) — high value; the
  view-as half of that item is now built.
- Deferred platform hardening — the `revoke PUBLIC`/anon-table items are **DONE pending the prod
  push** (see Now, above). Still open, all recorded with rationale in docs/15's 2026-07-29 entry:
  **`storage`-schema grants** (prod grants anon the full set incl. TRUNCATE; buckets private,
  policies key on `auth.uid()`; a `public`-schema sweep doesn't touch it); **prod's
  `ALTER DEFAULT PRIVILEGES`**, which re-opens every FUTURE object so the sweep decays without a
  drift check — Supabase removes the legacy auto-expose 2026-10-30, so the fix is likely project
  config not SQL, and note a local-only check structurally CANNOT catch prod drift; ~9
  internal-only helpers keeping `authenticated` EXECUTE they don't need; 3 provably dead functions
  locked not dropped; `service_role`'s retained TRUNCATE. Plus: generic scope-wrappers deriving
  org from the entity row; generalize coarse `<prefix>_can_manage(org)`; per-class storage
  scoping; per-module scoped-assignment UIs.
- Pre-launch before real customers (docs/12 checklist): automated+tested backups, monitoring,
  2FA, privacy/terms, custom SMTP.

**Standing rules:** never start a slice/module build without the founder initiating; every
migration/RLS/trigger change runs the docs/03 #12 rhythm (draft → adversarial review →
live-verify as real users → RLS tests → docs); model-choice + subagent + fresh-chat guidance
in the sections below.

**Full dated history** (2026-07-06 → 2026-07-28, every prior entry verbatim):
[docs/history/platform-journal.md](docs/history/platform-journal.md).

## Hard-won local-dev gotchas (Windows host)

- Node module compile cache corruption makes pnpm OOM-crash at tiny heaps → delete `%TEMP%\node-compile-cache`.
- PowerShell 5.1 `-Encoding utf8` writes a BOM; the Supabase CLI refuses BOM'd `.env` files. Write env files from Node (scripts/dev.ts) or with BOM-less UTF8.
- After `supabase db reset`, Kong can hold a stale route to the recreated auth container (502 on `/auth/v1/*` while `rest` works) → `docker restart supabase_kong_Solutions_Platform`.
- `import.meta.dirname` is `undefined` under tsx — use `dirname(fileURLToPath(import.meta.url))`.
- Docker Desktop's WSL backend crashed under parallel image pulls → `C:\Users\yarmishj\.wslconfig` caps WSL at 8GB/4CPU (delete to revert); pull images sequentially if it recurs; zero-log segfaulting containers (exit 139) = corrupted image layers, `docker rmi` + re-pull.
- **Reproducing a flaky/order-dependent e2e failure: `db:reset` + `pnpm seed` immediately before the reproduction run, not just once at the start of the session.** Several e2e tests are documented non-idempotent (assume fresh seed state). Running a suspect test in isolation first (to confirm it currently passes) mutates that seed data; a subsequent full-suite reproduction attempt then fails for the mundane reason of stale state from your OWN prior run — which looks like the bug you're chasing but isn't (hit in a 2026-07-30 session validating the speed-dating flaky-test fix: an isolated run advanced the seeded event to `complete`, then the very next full-suite run failed at the first "Register" step instead of reproducing the real timing issue).
- **`ON DELETE SET NULL` fires the referencing table's BEFORE UPDATE triggers** — Postgres implements the FK action as a real UPDATE. So an append-only `before update or delete ... raise exception` trigger silently makes every row the table has ever referenced UNDELETABLE (the parent DELETE aborts), including whole orgs via a cascading `org_id`. Enforce append-only with GRANTS instead (no UPDATE/DELETE to api roles → `42501`), which is why `vm_moderation_log` has no such trigger. Found live in the 2026-07-31 view-as review, one review after `set null` had been (correctly) required.
- **Since slice 3, a test fixture that adds an org member must ACCEPT the invite** (`org_accept_invite`, as that user) or the member stays `pending` and satisfies no membership predicate. A negative assertion then passes for the mundane reason that the user isn't a member yet — proving nothing about the thing under test. Hit while verifying view-as scope isolation 2026-07-31: "a course-A professor cannot view a course-B student" passed vacuously until the fixture accepted.
- Tables created in CLI migrations do NOT inherit Supabase's default API-role grants — every migration must `grant` explicitly (see 20260706120000_core.sql). **Functions are the inverse trap and dev/prod DIVERGE:** Postgres grants `EXECUTE` to `PUBLIC` at CREATE (so anon can call), and on PROD `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` ALSO grants `EXECUTE` directly to `anon`/`authenticated` — which `revoke ... from public` does NOT remove. Local lacks that default, so a function locked down with only `revoke ... from public` looks closed locally but is open on prod (the 2026-07-22 `module_scope_covers` gap → `20260722010000`). Rule: state the full intended ACL explicitly (`revoke execute ... from public, anon, authenticated;` then `grant` to exactly who needs it), and verify security-sensitive ACLs against PROD — the local RLS suite can't catch this. See docs/03 convention #1. **`pnpm exec tsx scripts/prod-verify-migration.ts <migration>` now automates that prod check** (read-only: per-function body md5, secdef, pinned search_path, real EXECUTE ACL incl. anon).

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

## Model choice (founder preference, 2026-07-10; Fable tier added 2026-07-16)

- **Sonnet 5** for routine slices: UI/CRUD work, walkthrough-feedback fixes,
  docs, manifest copies.
- **Opus 4.8 (or better)** for anything touching `supabase/migrations/`, RLS
  policies, triggers, export/privacy rules, or gnarly multi-step debugging.
- **Fable 5 (limited credits — spend deliberately)** only when Opus-tier work
  has an extra reason to want the strongest model:
  - **Adversarial security review of a NOVEL RLS/trigger/privacy design**
    (a new mechanism, not a copy of an existing audited pattern) — tenancy
    isolation is existential, so the review step specifically is where the
    top model earns its cost. Routine "same shape as an existing audited
    policy" migrations stay Opus.
  - **Debugging that has already defeated one session** — a bug Opus/Sonnet
    investigated and misdiagnosed or couldn't reproduce, especially
    cross-layer ones (RLS + trigger + client + infra interacting).
  - **Big cross-cutting design/refactor passes** (extraction passes, a
    platform primitive touching every module) where one wrong abstraction
    is expensive to unwind.
  - NOT for: resuming well-documented in-flight work, building UIs on
    already-verified migrations, docs, seeds, e2e, feedback batches —
    that's Sonnet/Opus territory even when the session started on Fable.
- **Switching has a cost too**: don't churn models mid-task — a mid-session
  switch loses working context. Pick the tier when a work item STARTS; if a
  session's remaining work drops a tier, finish the session, then switch
  down for the next one.
- Whatever the model: the docs/03 #12 security rhythm (agent-draft →
  security-review → live verification) is the invariant, not the model.
- **Two-way say-so rule:** a lighter model whose task drifts into
  heavier territory must SAY SO and suggest switching up — never push
  through quietly. Symmetrically, **a heavier model (Opus/Fable) must say
  at the START of a turn when the requested work doesn't need its tier**
  and recommend the cheaper model for next session — never silently burn
  limited credits on routine work.
- Safeguards, never-do list, backups, recovery: [docs/12-safeguards.md](docs/12-safeguards.md).

## Session hygiene (subagents & fresh chats) — founder ask, 2026-07-27

- **Parallel subagents** — use for independent work that can run concurrently
  (adversarial security reviews, schema/code surveys, migration drafting, RLS-test
  authoring) AND to keep heavy reading/analysis OFF the main context. They trade
  MORE total tokens for parallelism + a leaner main window — they are NOT a way to
  save a token budget. Use only when quality won't suffer: the proven rhythm is
  agent-draft → the orchestrator READS the draft itself → independent 2-reviewer
  adversarial fan-out → test-author → live verify. The orchestrator ALWAYS reviews
  subagent output; the adversarial review + tests are the quality gate, never the
  subagent's own say-so. Token math: subagent overhead dominates in a SMALL context
  (self-do is cheaper there); in a LARGE context their fresh-start saving can
  outweigh it for heavy tasks. The reliable wins are parallelism + context-leanness,
  not budget.
- **Proactively recommend a fresh chat when THIS context grows large.** Per-turn
  cost scales with accumulated context, so a long session gets progressively more
  expensive. When the chat has grown big AND you're at a clean, committed, shipped
  boundary (nothing uncommitted/unpushed), TELL the founder it's a good time to
  start a fresh chat — don't wait to be asked. A fresh chat auto-loads this file +
  docs/15 + docs/03, so nothing is lost. Keep the current-state section above and
  the docs decision logs current so the handoff is always clean.
- **Keep this file (CLAUDE.md) lean — it auto-loads every session, so its size is a
  tax every future chat pays.** As part of the docs-update step when shipping a slice
  (docs/03 #12's final beat), do NOT append the full blow-by-blow to "## Current
  state." Instead: append the detailed dated entry to `docs/history/platform-journal.md`
  (newest-first), and update ONLY the compact "Now / Next / Standing rules" in the
  current-state section here. Durable decisions/conventions go to their real homes
  (docs/15 decision log, docs/03 conventions, docs/12 safeguards), not here. Same
  principle for the other always-loaded lists (gotchas, standing decisions): prune/merge
  rather than let them grow unbounded. A fresh chat should never pay for the full journal.

- Never build platform primitives speculatively — extract them when a second module needs the same thing.
- Migrations: forward-only, additive-first, always run locally before cloud.
- Every module ships with seed data and critical-path e2e tests (each role completes its core task).
- Dated **decisions logs** in module specs record client choices — don't re-litigate them silently; if a decision must change, update the spec with a new dated entry.
