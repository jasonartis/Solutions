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

**Now (2026-08-03):** Live on prod. **PER-PERSON DATA BROWSER BUILT — NOT YET PUSHED.**
`/console/data-browser`, superadmin-only; first half of docs/13's Owner Console pair (founder
re-sequenced 2026-08-03: data browser first, Owner Console view-as next). Answers *"what do I
hold about this person?"* — every row the VIEWER may read that names the subject — as opposed to
view-as's *"what does this person see?"*. **ZERO MIGRATIONS**: `is_org_admin()` already
short-circuits on `is_superadmin()`, so the whole feature is presentation over the caller's own
RLS client. **The superadmin gate is therefore a UI gate, and that is sound HERE** — every query
is one the caller could already issue via PostgREST. That does NOT contradict docs/03 #18 (which
was about view-as, where starting a session was a real WRITE). **The invariant it rests on: no
`.rpc()` and no service-role client on this path, ever** — source-scanned by a probe. Two Fable
reviews: no ship-blocker on the security claim; one on honesty — **`sal_bills` has no customer
column**, so reaching a paying customer takes TWO hops and a customer with an account saw zero
bills (fixed: `PersonVia.then`). Verification: typecheck 9/9, db **82/82**, **22/22 live probes**
zero skips, 2 new e2e, full clean-seed suite. Rules → docs/03 **#19**; decisions → docs/15
(2026-08-03); record → journal. **Rode along:** the matchmaking e2e flake — confirmed pre-existing
on clean `master`, diagnosed (post-failure DB state identical to seed, so only the re-render was
late), fixed with `test.slow()` + a 20s `expect` timeout. `test.slow()` alone is NOT enough — it
raises the TEST timeout, not the `expect` timeout.

**Previously:** **slice 5 (VIEW-AS) is ON PROD and PROD-VERIFIED** (`20260731010000` +
`20260802010000`, commit `ad8e989`; 29/29 prod probes) — declarations for all 8 modules, edges ON
for classroom only, professor→student ON and founder-confirmed, no new read path. **The ACL
HARDENING SWEEP is ON PROD and PROD-VERIFIED** (`20260728010000`, commit `a16f4a5`; 39/39) —
`anon` holds nothing in `public`, `authenticated` lost TRUNCATE (RLS cannot gate it). Full
blow-by-blow for both → docs/history/platform-journal.md; rules → docs/03 #17/#18.

**Next / open (pick WITH the founder — do not start unprompted; details in docs/15 §11).
RECOMMENDED ORDER as of 2026-08-03 — the first two are done, next is a bigger design/RLS
piece (Opus/Fable territory, not Sonnet), then unranked follow-ons:**

- ~~**1. Confirm CI/deploy for slice 5.**~~ **DONE 2026-08-02** — all three pushes
  (`ad8e989`, `1f2fc05`, `01d7339`) are `READY` in Vercel production, which proves CI was
  green (the `deploy` job has `needs: check`). Prod app and prod schema are in sync.
- ~~**2. Students cannot see peer-review comments on their own homework.**~~ **DONE 2026-08-03**
  (see the dated bullet below).
- **3. The speed-dating waitlist flake** (details in its own bullet below). Only truly urgent
  if it is what broke CI, which is now ruled out by item 1. **CI has `retries: 1` and runs the
  PREBUILT server (`pnpm start`), while local runs the dev server with JIT compilation and 0
  retries** — and the 2026-07-30 diagnosis pinned this family on exactly that dev-server/load
  combination, so it may well be green in CI and be a local-suite annoyance only. A clean
  `db:reset` → seed → full e2e run on 2026-08-03 (verifying the peer-review-comments fix)
  reproduced BOTH speed-dating tests passing cleanly — so the flake, when it happens, is
  intermittent even under the documented failure-inducing order, not a hard regression.
- **4. The superadmin console + per-person data browser.** ~~Data browser half~~ **DONE
  2026-08-03** (see Now). **NEXT UP IS NOT THIS — founder 2026-08-03 put the nail-salon
  view-as surface review first** (own bullet below); the console needs surfaces to have
  anything to render. **STILL TO BUILD after that: the Owner Console view-as** — a superadmin
  surface that bypasses every declared edge, kept out of the in-module tab strips, and
  unlogged. Founder answers on record: **all three modes** (mode 1, mode 2, and a third
  "this position's surface with no person filter", which is what you actually want when
  debugging) with the choice made obvious in the UI; plus fold in docs/13's cheap read-only
  positions/ranks/pair-grid viewer. **Two things the code says that the spec did not:**
  (a) `renderSurface` intersects the target's scope with what the CALLER governs, and a
  superadmin holds NO module grants, so a scoped target renders EMPTY — bypassing edges is
  not enough, the scope intersection needs an explicit authority parameter (a discriminated
  union, so no caller can invoke the renderer without naming which gate it passed);
  (b) the bypass can only render a position that has a declared SURFACE, so today it lights
  up classroom `student`/`ga` and nothing else — the permanently-banned speed-dating
  `participant` pair renders blank regardless. Expect it to be SMALL. **Model note:** still
  Opus 4.8+ (edge-bypass design), and the adversarial review beat is Fable.

Everything below is open but unranked:
- **Slice 5 remaining follow-ons:** the **nail-salon** view-as surface review (its 9 pairs are
  enumerated and OFF — manager→worker/cashier looks straightforward) and then
  **speed-dating**'s 6; and decide whether view-as **targets are notified** (§8.1 point 6
  leaves it a per-module product call). *(professor→student, the `is_org_admin` question and
  the prod push are all SETTLED — see Now and docs/15's 2026-08-02 entry.)*
  **FOUNDER DECISION 2026-08-03: the nail-salon surface review comes BEFORE the Owner
  Console view-as (item 4).** Reason: the console can only render a position that HAS a
  declared surface, so today it would light up classroom `student`/`ga` and nothing else —
  the surface review is what gives the console something to show, not the other way round.
  Note the salon's own data-browser findings (docs/modules/module-5-nail-salon.md,
  2026-08-03) are relevant input: `sal_bills` reaches a customer only through the
  appointment, and most customers are account-less walk-ins.
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
- `gh` is NOT installed on this machine, so GitHub Actions logs need the web UI — **but CI
  PASS/FAIL is readable from the terminal indirectly**: the `deploy` job has `needs: check`,
  so a `READY` production deployment proves `check` was green. Query it with the
  `VERCEL_TOKEN` already in `.env.deploy`:
  `GET https://api.vercel.com/v6/deployments?limit=8` with `Authorization: Bearer <token>`,
  and match `meta.githubCommitSha` against the commit. Gives state/target/sha/time per
  deploy. Only the UI shows *why* a run failed, but this answers "did it ship?" in seconds. **CI differs from local in two ways that matter for flaky e2e:** `retries: 1`
  (local 0) and a PREBUILT server via `pnpm start` (local uses `pnpm dev`, so route
  compilation happens mid-test). A test that flakes locally may be reliably green in CI, and
  vice versa — judge by the actual CI run, not the local one. Both settings are in
  `apps/web/playwright.config.ts:9,15`.
- ~~**Founder decision 2026-08-02, small and unbuilt:** a student must see the COMMENTS on
  their own homework but never the peer GRADES given to them.~~ **BUILT 2026-08-03** — UI-only,
  no migration/grant change needed (`cls_comments_for_my_submission()` already had the right
  RLS-equivalent filter and its `authenticated` grant). The homework page now renders a
  "Peer review comments" section via that RPC; extended the existing grading-workflow e2e
  rather than adding a new one. Typecheck 9/9, full clean-seed e2e suite 37/37. Details →
  docs/modules/module-2-classroom.md's 2026-08-03 entry.
- ~~**The per-person data browser.**~~ **DONE 2026-08-03** — see Now and item 4. The Owner
  Console view-as half is what remains of that pair; its detail now lives in item 4.
  **Known gaps recorded rather than closed:** walk-in salon customers (no account, so not
  findable — the fix, if ever wanted, is letting a salon LINK a walk-in to an account when
  they sign up, not requiring accounts up front); and whether an org admin's read of the
  view-as session log should be scope-narrowed (today it is whole-org, since org admin has
  no scope dimension — the browser makes that data findable where it was merely readable).
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
- **A passing NEGATIVE assertion proves nothing unless something nearby proves the subject
  exists** — the vacuity rule, generalised in docs/03 after it appeared three times in one
  session in three unrecognisably different forms (an RLS check on an empty table, a
  catalog query whose view silently excluded the `auth` schema and returned zero rows, and
  a `not.toBeVisible()` on text a wording change had deleted everywhere). A vacuous test
  does not just miss a bug, it reports the bug's absence. Full version + the three worked
  cases: docs/03 "Test discipline".
- **Don't edit files while a backgrounded `git add -A && git commit` is in flight** — the
  add races the edit and the change silently misses the commit while `git log` looks
  correct. Hit 2026-08-03; caught only because the next step grepped `git show HEAD` for
  the change rather than trusting that the commit had run.
- **A one-off script run with `tsx` must live INSIDE the repo** — Node resolves
  dependencies from the script's own location, not the cwd, so a scratchpad script
  importing `@supabase/supabase-js` fails with ERR_MODULE_NOT_FOUND however you invoke it.
  Write it to the repo root and delete it after, or give it zero third-party imports.
- **`test.slow()` does NOT extend an `expect()` timeout** — it triples the TEST timeout only.
  A flaky Playwright assertion that reports `Expect "toBeVisible" with timeout 5000ms` is
  hitting the per-assertion default and will keep failing however slow you mark the test;
  pass `{ timeout: N }` to that assertion as well. Hit 2026-08-03 on the matchmaking flake.
  Related diagnostic that settled it in one step: **capture the DB state immediately after a
  UI-assertion failure.** If the data already shows the change, the write succeeded and the
  bug is a late re-render, not a lost mutation — which turns "mystery flake" into a timeout
  question and avoids patching blind.
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
