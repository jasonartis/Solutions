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

**Now (2026-08-09):** **ENGAGEMENT MONITORING PHASE 1 — LOGIN CAPTURE — IS BUILT AND SHIPPED**
(`20260809010000_login_events.sql`, **a trigger on `auth.users`**). Spec and every decision:
**[docs/17-engagement-monitoring.md](docs/17-engagement-monitoring.md)**. `login_events` (raw,
90-day) + `login_rollup` (permanent), both READ-ONLY to every api role and superadmin-only reads;
an owner-only pruner; a daily pg-boss job. **No UI — that is phase 3, which OWES a "newest
captured login" honesty badge with a test, because the capture trigger swallows its own errors so
it can never cause a login outage.** The fact that made it worth shipping before the UI: **of 12
prod users, 5 have ever signed in and 7 NEVER have** — the outreach list existed on day one.
**Four durable lessons, in docs/03 and docs/17 — read them there:** *a trigger on `auth.users` is
on the auth critical path, so whether it swallows errors is a criticality judgement* (and
**`WHEN OTHERS` does not catch `query_canceled`** — bound the wait with a function-scoped
`lock_timeout` instead of catching the cancel); *never document a test you have not written, even
one you mean to write in the same session*; *RLS filters rows, never columns, so a column added to
`profiles` is readable by every org-mate*; and **a `>>> FULL TURBO` test result after a migration
is a cached replay, not a run** (now a gotcha below). **Founder decisions this session:
superadmin-only reads confirmed, no `profiles` mirror, and hierarchy-governed engagement will be
built on PHASE 2's org-scoped activity — never on raw logins, because a login has no org.**
**Verification: typecheck 9/9, build clean, db 121/121 (real run), e2e 49/49 exit 0 CI-STRICT,
prod pre-flight 11/11, prod-verified.** Detail → journal + docs/17's decisions log.

**Previously — shipped, prod-verified, and fully written up elsewhere.** One line each; the
blow-by-blow is in [docs/history/platform-journal.md](docs/history/platform-journal.md)
(newest first) and the durable rules are in docs/03 / docs/12 / docs/15's decision log. Kept
this short deliberately: this file is a tax on every session, and a second copy of the journal
is the most expensive thing in it.

- **2026-08-09 — the rank admission map** (`ba4eb6a`, no migration). `rank-admission.test.ts` +
  generated **[docs/rank-admission-map.md](docs/rank-admission-map.md)** (also docs/13's "what does
  rank 2 mean here?" table); rank readers and the position vocabulary are both DISCOVERED, and an
  unclassifiable comparison FAILS rather than skipping. Also extended the CI ratchet to
  `requiredFiles`. Three rules → docs/03.
- **2026-08-07/08 — the superadmin lookup log** (`eef09ce`, `20260807010000`, prod 23/23). Both
  console tools log every lookup; a failed write is BADGED. Closed docs/12 item 9; brought
  `scripts/prod-verify-superadmin-log.mts` (the table/policy verifier template — see the gotcha
  about `prod-verify-migration.ts` being function-only). Three rules → docs/03. **Its open item —
  what a SECOND superadmin should see — is in the list below.**
- **2026-08-06/07 — the Owner Console view-as** (`6a90110`, `20260806010000`). `/console/view-as`,
  superadmin-only; the three founder modes are ONE AXIS, not three code paths. Rules: *naming a
  gate is not passing one* → docs/03; *a `for all` policy's USING also covers SELECT* → docs/15.
- **2026-08-05 — nail-salon view-as surface review** (`89fae0a`, `20260804010000`, 33/33). All 12
  `sal_` tables classified; rule → docs/03 #18. **Its unclosed gap is in the list below.**
- **Earlier — the per-person data browser** (`070a73b`), **slice 5 view-as** (`20260731010000` +
  `20260802010000`, `ad8e989`) and **the ACL hardening sweep** (`20260728010000`, `a16f4a5`: `anon`
  holds nothing in `public`). Rules → docs/03 #17/#18/#19.

**Next / open (pick WITH the founder — do not start unprompted; details in docs/15 §11).
AS OF 2026-08-09 the numbered items 1–6 are ALL DONE, and so are the rank/tier-wrapper gap and
ENGAGEMENT MONITORING PHASE 1; what remains is the unranked list below. THE RECOMMENDED NEXT REAL
PIECE IS ENGAGEMENT MONITORING PHASE 3 — the console page that reads what phase 1 now captures
(org→people and person→orgs, per docs/17 §1). It needs NO migration, so it is Sonnet-tier.
**START AT docs/17 §8b — a numbered checklist of everything that page must get right, collected
there precisely so a new session does not have to reassemble it from three sections of a long
document.** Its hardest item is the honesty badge with a test (§10 point 4).
Phase 2 (org-scoped activity) is specced but NOT founder-approved and ships a migration. Two
numbered items survive below because they still carry live operational facts, not because they are
open:**

- ~~**1. Confirm CI/deploy for slice 5.** **2. Peer-review comments.** **3. The speed-dating
  waitlist flake.** **4. The Owner Console view-as.** **5. Push and prod-verify.**~~ **ALL DONE**
  2026-08-02 → 08-09; detail in the journal. Their open follow-ons were PROMOTED into the list
  below rather than left inside struck-through headings — *open state hidden inside a completed
  item is how it gets lost.*
  **Item 3 (the e2e flake family) is CLOSED at this docs beat**, on the condition this file itself
  set: CI green across several pushes. It has now been green across six consecutive production
  deploys (`c142c1d` → `4ed2958`), plus a clean local 49/49. **The two reusable facts are kept —
  as a gotcha below (`test.slow()` does not extend an `expect()` timeout) and in the journal's
  2026-08-05 entry (the family has two sub-shapes needing two different knobs).** Standing rule
  unchanged: *judge a flake by CI, not locally.*
- ~~**6. PROD'S DEMO DATA IS STALE.**~~ **DONE 2026-08-07.** Two live facts only:
  **(i) `scripts/verify-console-view-as.mts` is 35/35 local but PROD 34/35 permanently, BY DESIGN**
  — the founder really owns an org, so the mode-1 blurb's "the superadmin belongs to no org" is not
  literally true for that account. Not a target to chase. **(ii) It is parameterised**
  (`VERIFY_DEMO_PASSWORD` / `VERIFY_SUPERADMIN_EMAIL` / `VERIFY_SUPERADMIN_PASSWORD`) because
  prod's superadmin is the founder's REAL account — `seed.ts`'s remote guard forces
  `owner@demo.local` to `is_superadmin = false` off-localhost. **But those three are in NO env
  file** (checked 2026-08-09: `.env.deploy` and `.env.accounts` both carry `PROD_DEMO_PASSWORD`
  instead), so a prod run needs them exported by hand — the fallback to
  `owner@demo.local`/`password123` is silent, and that account is not a superadmin on prod.
  Tidy-up, founder's call because it touches credential files: add them to `.env.accounts.example`
  + `.env.deploy`, or just document the export line. Full story → journal.
Everything below is open but unranked:
- **ENGAGEMENT MONITORING — PHASE 1 BUILT 2026-08-09. PHASE 3 IS THE RECOMMENDED NEXT PIECE;
  PHASE 2 IS SPECCED BUT NOT APPROVED.** Full spec + dated decisions:
  **[docs/17-engagement-monitoring.md](docs/17-engagement-monitoring.md)**. What is live: capture
  only, no UI. **Five things carried forward, all recorded there in full:**
  **(i) PHASE 3 OWES AN HONESTY BADGE** ("newest captured login", with a test that renders it) —
  the capture trigger swallows its own errors so it can never cause a login outage, which makes a
  capture failure SILENT, and an empty engagement table is indistinguishable from "nobody uses the
  platform". **(ii) RETENTION IS NOT ENFORCED IN PROD UNTIL THE WORKER RUNS THERE** (still the
  `pnpm worker:prod` stopgap) — raw events accumulate past 90 days meanwhile; the pruner is
  idempotent and range-based so the first real run catches up. **(iii) HIERARCHY-GOVERNED
  ENGAGEMENT GOES ON PHASE 2's DATA, NEVER ON RAW LOGINS** (founder agreed 2026-08-09): a login has
  no org, so "frank sees dana's logins" reports activity that may belong to a different client's
  org entirely. **(iv) Phase 2 stays MANDATORY-hierarchy-columns** — role/scope at write time are
  unreconstructable because `module_roles` is mutated in place. **(v) `auth.audit_log_entries` is
  still never written to on prod** (`ins=0`, re-measured 2026-08-09 with the sibling-table insert
  counts as control) — never build on it; it is fully populated locally, which is the trap.
- **PARKED 2026-08-09, both raised by the login-capture build and both about `profiles`:**
  **(a) should `profiles_select_shared_org` be hierarchy-narrowed?** The founder's stated rule is
  *never any visibility to someone lower of someone higher*, and that policy breaks it today for
  name/email — share ANY org, read the whole row, no rank arm (proven live: charlie, a rank-0 salon
  customer, reads frank the rank-3 admin). It has been that way deliberately since `20260708020000`
  because rosters were rendering UUIDs. Narrowing it touches every roster in every module, so it is
  its own migration and review. **(b) Anything placed in `profiles.settings` is readable by every
  org-mate** — today just one console preference (`superadminDefaultAddActive`), so nothing
  sensitive, but it is an easy trap to walk into later. Both are why the login mirror went onto a
  superadmin-only table instead.
- **A CONFIRMED-FABLE RE-REVIEW OF `20260809010000` IS OPEN** (founder ask, 2026-08-09). Fable is
  not selectable as a session model, so that migration's adversarial review ran as a user-directed
  Fable SUBAGENT — and a subagent's tier cannot be verified from inside the session, so it is
  recorded as **claimed-Fable, unverified** (docs/17's decisions log). Nothing rests on it: both
  findings that mattered were independently checked against documented Postgres behaviour and the
  live catalog. Worth one pass by a confirmed Fable when one is available, since the prune function
  is the platform's only exception to append-only logging.
- **`blinded` CHECKS ONE TABLE PER MODULE** (the `scopeEntity`), never per role table — so a
  future migration dropping an `is_org_admin` arm on an ordinary role table gives a silent,
  error-free, **UNBADGED** empty section. `20260806010000` is proof the category already bit
  once, caught only because it hit the scope-entity table, whose symptom is loud. *(Promoted
  2026-08-09 out of the struck-through view-as item, where it was invisible. Full context:
  docs/15 finding 6.)*
- **Should `view_as_sessions`' own whole-org admin read be narrowed by hierarchy?** Today it
  is whole-org, since an org admin has no scope dimension — and the data browser makes that
  data *findable* where it was merely readable. Same founder principle as the second-superadmin
  question below; own migration, own review. *(Also promoted 2026-08-09 out of two different
  struck-through items; recorded in docs/13 and docs/15 §8.1.)*
- **FOUNDER DECISION PENDING: what should a SECOND superadmin see in the lookup log?**
  (raised 2026-08-07/08 by the log's own build; full argument in docs/15's 2026-08-07/08 entry
  decision 5 and docs/12 item 9.) The log's read policy is a flat `is_superadmin()`, which
  with ONE operator is exactly the founder's "only the superadmin can see them". With TWO it
  silently becomes "each reads 100% of the other's lookups, unscoped, forever". **That is a v1
  default, NOT a derivation of the appointment rule** — there is no rank domain among
  superadmins to compare over, so "strict rank + scope coverage" has nothing to compute. The
  alternative (each reads only their own) would make the log pure self-audit and give no
  oversight at all, which is why the default went the way it did. Wants an explicit answer
  BEFORE a second superadmin exists — it is already a named expiry condition in docs/12 item 9,
  and this is now a second, independent reason that condition matters. *Listed here as well as
  under the lookup-log line above because it is an OPEN item that lived under a struck-through DONE
  heading, and the 2026-08-07 lesson is that open state hidden inside a completed item is how
  it gets lost.*
- **Slice 5 remaining follow-ons:** ~~the nail-salon surface review~~ **DONE 2026-08-04**
  (see Previously). Left: **speed-dating's 6 pairs** — and note its review is genuinely harder than
  the salon's, because a host deliberately cannot read `sd_interest`/`sd_matches` while an
  organizer can, so an organizer rendering a host tab must respect an exclusion their own
  ambient reach does not impose (the salon had no equivalent: manager ⊇ cashier ⊇ worker with
  one clean exception). Its four `participant` pairs stay permanently OFF. Also still open:
  whether view-as **targets are notified** (§8.1 point 6 leaves it a per-module product
  call). *(professor→student, the `is_org_admin` question and the slice-5 prod push are all
  SETTLED.)* **Reusable lesson from the salon review, worth carrying into speed-dating's:**
  ask of each position whether its reach is a function of WHO it is or only of WHAT SCOPE it
  covers — mode 2 is only honest for the former, and a mode-1-only pair needs no migration
  arm at all.
- ~~**Seed the salon's back office.**~~ **DONE 2026-08-05.** (Salon demo logins are
  now: **frank = admin**, alice = manager, eve = cashier, dana = worker, charlie = customer.)
- ~~**`cls_exam_papers` zero-row / exam section unfalsifiable.**~~ **DONE 2026-08-09**,
  seed-only. Kept for one reusable line: **a fixture must not pre-satisfy another test's
  starting condition** — the seeded exam is titled `Quiz 1 — Warm-up`, grades nobody and
  publishes nothing, precisely so it cannot collide with the classroom exam e2e's own
  `Midterm`. Reasoning in the journal.
- **STILL OPEN, and the one gap the salon review deliberately did not close: machine-enforce
  "every module table is classified on every surface."** Today it is HAND-checked —
  `viewAsCompleteness()` only refuses a table appearing in two lists; it never enumerates the
  module's real tables and never inspects `embed`. So a future `sal_tips` migration leaves all
  three surfaces silently incomplete with CI green, and §8.1 point 9's "unclassified defaults
  to PERSONAL" fails open. Not a leak (view-as can only render what is declared) — a false
  CLAIM, which the next reader trusts. The pattern to copy is
  `packages/db/src/data-browser-coverage.test.ts` (reads `pg_catalog`, never
  `information_schema`). **The catch that makes it more than an afternoon: classroom would FAIL
  it today** — its student/GA surfaces were never classified table-by-table the way salon's
  were. Recommended shape: **baseline-and-ratchet** — snapshot today's unclassified set as an
  accepted list and fail only on anything NEW (the data browser's own test already reports its
  backlog without failing, so there is precedent). That gets the guarantee going forward
  without forcing the classroom back-classification. Opus; ~2 hours as a ratchet, ~half a day
  if classroom is classified properly at the same time.
- Slice 3 remainder: **entity-level joinPolicy** (invite-only/request-approval/open per
  class/location/event) — deferred follow-on. Slice 4 (defaults-on-join) is the only
  unbuilt slice left.
- Single-entity modules (matchmaking / synagogue-schedules / visual-messaging) NOT yet
  rank-mapped — OPTIONAL (a real behavior change, not cosmetic). **Note since slice 5:** their
  vocabularies are entirely rank 0, so they imply no view-as pairs today; rank-mapping any of
  them will FAIL THE BUILD until every newly-implied pair is explicitly answered. That is the
  2026-07-30 amendment working as designed, not an obstacle — but budget for it.
- ~~**The e2e flake family** (2026-07-30 speed-dating; 2026-08-05 "loses ONE test per full run,
  a different one each time").~~ **BOTH FIXED; closed at the 2026-08-09 docs beat — see item 3.**
  The diagnosis is the part worth keeping: **a MOVING failure is environmental, not a set of test
  bugs** (the local dev server compiles routes mid-test), and the family has **two sub-shapes
  needing two DIFFERENT knobs** — an assertion timing out after a navigation wants `expect.timeout`
  (15s locally), a stalled `.click()` wants `test.slow()`/a longer test timeout, and neither knob
  fixes the other. **CI is deliberately STRICTER (5s expect, 30s test) against a PREBUILT app**, so
  a slow assertion there means something is genuinely slow. Full reasoning → journal 2026-07-30 +
  2026-08-05.
- Low-priority verification: **the worker's PRE-EXISTING jobs** were never exercised after the ACL
  sweep (neither suite touches them). Should be unaffected — `service_role`'s privileges provably
  cannot shrink, zero `.rpc()` calls, pg-boss connects as `postgres`. Watch the next real job run.
  *(The NEW `login-events-prune` job was exercised end-to-end 2026-08-09; that says nothing about
  the others.)*
- `gh` is NOT installed on this machine, so GitHub Actions logs need the web UI — **but CI
  PASS/FAIL is readable from the terminal indirectly**: the `deploy` job has `needs: check`,
  so a `READY` production deployment proves `check` was green. Query it with the
  `VERCEL_TOKEN` already in `.env.deploy`:
  `GET https://api.vercel.com/v6/deployments?limit=8` with `Authorization: Bearer <token>`,
  and match `meta.githubCommitSha` against the commit. Gives state/target/sha/time per
  deploy. Only the UI shows *why* a run failed, but this answers "did it ship?" in seconds.
  **CI also differs from local in two ways that matter for e2e:** `retries: 1` (local 0) and a
  PREBUILT server via `pnpm start` (local `pnpm dev` compiles routes mid-test) —
  `apps/web/playwright.config.ts:9,15`. So a test that flakes locally may be reliably green in CI
  and vice versa; judge by the actual CI run.
- ~~**The per-person data browser.**~~ **DONE 2026-08-03.** One known gap is still open and
  is the only reason this line survives: **walk-in salon customers have no account, so they are
  not findable** — the fix, if ever wanted, is letting a salon LINK a walk-in to an account when
  they sign up, not requiring accounts up front. (Its other recorded gap, the view-as session
  log's whole-org admin read, was promoted to its own bullet above on 2026-08-09.)
- **Founder-raised 2026-08-02, parked in docs/13** (its pair-grid viewer and rank/tier-wrapper
  halves are both DONE, 2026-08-06 / 08-09). What REMAINS is the original larger idea:
  per-position visibility as a *documented, test-proven* map across every position × every table,
  rather than generated RLS. Opus. **The rank map does NOT subsume it** — that answers "which
  POSITIONS does a rank gate admit", never "which TABLES may a position read", and it ignores
  non-rank arms (role-name checks, `is_org_admin`) because those don't move when the ladder does.
  Carries the rule: *anything that WIDENS reach belongs in code; anything that only NARROWS it can
  be a runtime switch.*
- Everywhere role-clarity labels (founder testing-round items 31–42) — high value; the
  view-as half of that item is now built.
- Deferred platform hardening — the `revoke PUBLIC`/anon-table items are **DONE and pushed**
  (see Previously). Still open, all recorded with rationale in docs/15's 2026-07-29 entry:
  **`storage`-schema grants** (prod grants anon the full set incl. TRUNCATE; buckets private,
  policies key on `auth.uid()`; a `public`-schema sweep doesn't touch it); **prod's
  `ALTER DEFAULT PRIVILEGES`**, which re-opens every FUTURE object so the sweep decays without a
  drift check — Supabase removes the legacy auto-expose 2026-10-30, so the fix is likely project
  config not SQL, and note a local-only check structurally CANNOT catch prod drift; ~9
  internal-only helpers keeping `authenticated` EXECUTE they don't need; 3 provably dead functions
  locked not dropped; `service_role`'s retained TRUNCATE. Plus: generic scope-wrappers deriving
  org from the entity row; generalize coarse `<prefix>_can_manage(org)`; per-class storage
  scoping; per-module scoped-assignment UIs.
- **What should actually gate `master`? — OPEN, raised 2026-08-07, full brief in docs/12
  item 10.** Every direct push prints `Bypassed rule violations … Required status check
  "check" is expected`. Two facts settle the panic and open the real question: **a required
  status check can never be satisfied by a direct push** (the check is triggered BY the push,
  so the commit has no result yet — it is a PR mechanism), and **prod is gated by `needs:
  check` inside the workflow, not by any branch rule**, so "READY proves CI was green" still
  holds exactly. The live exposure is only that a RED COMMIT CAN LAND ON MASTER. Wants a
  comprehensive review of the balance (drop the misleading rule / PRs for
  `supabase/migrations/` only / PRs wholesale / a pre-push hook), plus the deeper question of
  whether an AI agent should hold bypass rights on master at all. **First step: find out what
  the ruleset really enforces and against whom** — including whether force-push protection
  (docs/12 guard 3) is bypassable too, which is now marked UNVERIFIED. Needs the GitHub UI or
  a token; `gh` is not installed here. Opus tier; ends in a founder decision.
- **THE PRIVACY-POLICY LINE FOR LOGIN CAPTURE IS AN OUTSTANDING OBLIGATION, NOT A PRE-LAUNCH
  NICETY (2026-08-09).** docs/12 item 6 said that wording was "a PRECONDITION of shipping"
  engagement monitoring; phase 1 shipped anyway, so the obligation has changed status rather than
  disappeared: **the feature is collecting on prod NOW, so the wording is owed before the first
  real customer account exists.** One line under "what we collect" — *"authentication events (when
  you sign in)"* — founder-decided, no user-facing notice. Exposure today is nil (12 prod accounts,
  all demo or the founder's, 7 never signed in) and there is no privacy page yet at all, which is
  exactly how this could hide inside the pre-launch checklist below. Recorded in docs/12 item 6.
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
- **Resolving a path from `import.meta.url` — TWO traps on this host, same family.**
  `import.meta.dirname` is `undefined` under tsx; and **`new URL('...', import.meta.url).pathname`
  leaves the space in `D:\Solutions Platform` PERCENT-ENCODED**, so anything written through it
  lands in a phantom `D:\Solutions%20Platform\` that git never sees and nobody ever looks in.
  Hit 2026-08-09 writing the rank map: the test reported "snapshot written" and passed, and the
  file simply was not in the repo. **Always `dirname(fileURLToPath(import.meta.url))`** — it
  decodes. The failure is silent and looks like success, which is what makes it worth a bullet.
- Docker Desktop's WSL backend crashed under parallel image pulls → `C:\Users\yarmishj\.wslconfig` caps WSL at 8GB/4CPU (delete to revert); pull images sequentially if it recurs; zero-log segfaulting containers (exit 139) = corrupted image layers, `docker rmi` + re-pull.
- **DOCKER DESKTOP CAN DIE OUTRIGHT UNDER A LONG SESSION'S MEMORY PRESSURE, and the symptom
  reads as a test failure (2026-08-09).** After a session of resets + builds + Playwright runs,
  the db suite reported `ECONNREFUSED 127.0.0.1:54321/54322` and 104 tests SKIPPED — which
  looks like a broken diff and is not. `docker ps` then failed with *"failed to connect to the
  docker API … dockerDesktopLinuxEngine: The system cannot find the file specified"* — the
  ENGINE was gone, not the containers. Tell-tales that precede it: `supabase db reset` hanging
  with an EMPTY log and the db container's uptime NOT resetting (a real reset recreates it),
  and `bash: fork: Resource temporarily unavailable`. **Fix: `Start-Process "$env:ProgramFiles\
  Docker\Docker\Docker Desktop.exe"`, wait ~10s, then restart Kong** (the containers
  auto-restart and Postgres keeps its volume, so reset+seed state survives — but Kong's auth
  route goes stale exactly as after a `db:reset`). Free RAM measured AFTER the crash looks
  healthy (11GB of 31GB), which is misleading: it is free BECAUSE Docker died. Same family as
  the OOM entries below — **any all-tests-fail-at-connection result is infrastructure, never
  code.**
- **A `>>> FULL TURBO` TEST RESULT AFTER A MIGRATION IS A CACHED REPLAY, NOT A RUN (2026-08-09).**
  `turbo run test` reported `Cached: 5 cached, 5 total >>> FULL TURBO` and "109/109 passed"
  immediately after a `db reset` applied a new migration — and the db suite had not executed at
  all; the timestamp in its replayed log predated the change. **Turbo's cache key cannot include
  database state**, so any suite that asserts against Postgres (the whole `@platform/db` package)
  will happily replay a stale pass after a schema change. Caught only because a reviewer noticed
  the new tables were empty when 11 seeded users should have filled them. → **After any migration,
  run `pnpm --filter @platform/db test` directly** (or `turbo run test --force`), and treat
  `FULL TURBO` on a DB-backed suite as "did not run". Same family as the tally rule in docs/03:
  before reporting a number, produce it.
- **`pnpm test` OOM-crashes on this host under turbo's 5-way parallelism** (`FATAL ERROR:
  Committing semi space failed`, at absurdly small heaps with ~7GB free). It is NOT the
  `node-compile-cache` corruption below — clearing that does not help. **Use `pnpm exec turbo
  run test --concurrency=1`.** Never read a parallel-run failure as a real one. The same
  applies to `typecheck` and `build` (exit code **134** = SIGABRT is this, not a type error).
- **THE FULL E2E SUITE OOMs THE `pnpm dev` SERVER on this host, and the fix is to run it the
  way CI does (2026-08-09).** Symptom: 49/49 fail, every one `page.goto: net::
  ERR_CONNECTION_REFUSED`, with `FATAL ERROR: ... JavaScript heap out of memory` in the
  `[WebServer]` lines — the dev server never came up, or died partway (a partial run is the
  same cause: tests pass until it dies, then everything after fails). Clearing
  `%TEMP%\node-compile-cache` does NOT fix it. **`CI=true pnpm --filter web exec playwright
  test` does** — that serves the PREBUILT app (`pnpm start`) instead of JIT-compiling routes,
  which is both far lighter on memory and the STRICTER configuration (5s expect, 30s test,
  retries 1). Build first. Generalises the existing sign-in rule: **all-tests-fail-at-connection
  is an infrastructure symptom, never a code one** — read the `[WebServer]` output before
  suspecting your diff.
- **EVERY e2e test failing at sign-in ("Sign in" stuck on `Working…`) is an INFRASTRUCTURE
  symptom, never a code one.** Two causes, both hit on 2026-08-06, and the wasted hour came
  from theorising instead of measuring:
  1. **A stale dev server.** The local Playwright config REUSES whatever is already on
     :3000. One left over from a session three days earlier was silently serving every run.
     `netstat -ano | grep :3000` then `Get-CimInstance Win32_Process -Filter "ProcessId=N"`
     shows its **CreationDate** — if it predates your work, kill it and let Playwright start
     a fresh one.
  2. **Kong's stale auth route after `db:reset`** (the gotcha below). `docker restart
     supabase_kong_...` must come AFTER the reset, not before — resetting recreates the auth
     container and re-staleness the route.
  **Measure first:** `curl -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" -H
  "apikey: $ANON" -d '{"email":"owner@demo.local","password":"password123"}'` — 502 is Kong,
  400 means the seed did not run, 200 means auth is fine and the problem is the app server.
  Working order: `db:reset` → restart Kong → `seed` → curl says 200 → run.
- **Do NOT edit app source while the e2e suite is running** (the local config serves
  `pnpm dev`, so an edit lands mid-run on a half-compiled app). Editing `docs/*.md` is safe.
  Related: piping the run through `| tail -N` swallows its exit code, so a failing suite
  reports success to the shell — redirect to a file and check `$?` instead.
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
- **NEVER `git add -A` WHEN ANOTHER CLAUDE SESSION MAY BE WORKING IN THIS REPO — STAGE PATHS
  EXPLICITLY (2026-08-09).** Two windows on one repo is normal here (it is why log-session needs a
  nonce probe), and `-A` stages THEIR in-progress work too. Hit live: a 3-line CLAUDE.md fix
  committed and pushed a concurrent session's unfinished 269-line `apps/web/lib/engagement.ts`
  under a docs message that never mentioned it. **It fails SILENTLY in the worst direction** — the
  commit succeeds, `git log` looks clean, and had that file not compiled, master would have gone
  red with the blame pointing at the wrong session. → `git add <path>` for what you actually
  touched, and read the commit's file count: if it exceeds what you edited, stop before pushing.
  → Corollary: once you tell the founder a session is finished, treat the repo as handed over.
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
- Tables created in CLI migrations do NOT inherit Supabase's default API-role grants — every migration must `grant` explicitly (see 20260706120000_core.sql). **Functions are the inverse trap and dev/prod DIVERGE:** Postgres grants `EXECUTE` to `PUBLIC` at CREATE (so anon can call), and on PROD `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` ALSO grants `EXECUTE` directly to `anon`/`authenticated` — which `revoke ... from public` does NOT remove. Local lacks that default, so a function locked down with only `revoke ... from public` looks closed locally but is open on prod (the 2026-07-22 `module_scope_covers` gap → `20260722010000`). Rule: state the full intended ACL explicitly (`revoke execute ... from public, anon, authenticated;` then `grant` to exactly who needs it), and verify security-sensitive ACLs against PROD — the local RLS suite can't catch this. See docs/03 convention #1. **`pnpm exec tsx scripts/prod-verify-migration.ts <path-to-migration.sql>` now automates that prod check** (read-only: per-function body md5, secdef, pinned search_path, real EXECUTE ACL incl. anon). **It takes a PATH, not a version — and it checks FUNCTIONS ONLY, so for a migration that defines none (a policy, a grant, an index) its "0 failures" is VACUOUS.** Hit 2026-08-07 on `20260806010000`, a policy-only migration: the run passed while asserting nothing about the policy. Verify those with a direct read-only `pg_policies` query against prod, and carry a control (count all policies) so an empty result is a real absence rather than a broken catalog read. **DO NOT HAND-ROLL THAT ANY MORE — `scripts/prod-verify-superadmin-log.mts` (2026-08-09) is the worked template**: no args, no app credentials (it uses the pooler + `SUPABASE_DB_PASSWORD`), and it checks the whole class the function-only script is blind to — real table ACL, each policy's expression, **the ABSENCE of a policy arm asserted as a negative**, the trigger being BOUND rather than merely defined, and every FK's delete action — each with its own control. Copy it per migration. **A second worked
  example, `scripts/prod-verify-login-events.mts` (2026-08-09), adds the beat that one lacks: a
  final check that the feature's DATA is actually arriving on prod** (it FAILS until a real sign-in
  has been captured). A migration can be structurally perfect and functionally dead — the whole
  reason docs/17 exists — so for anything that CAPTURES data, assert the capture, not just the
  schema.

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
- **DELETING A WORKING NOTE IS A STATE MIGRATION, NOT A CLEANUP (learned 2026-08-07, after
  it nearly lost three things).** A handoff/scratch note holds two kinds of content: a task
  list, and STATE — open items, known gaps, findings parked for later. Ticking off the task
  list and running `git rm` silently drops the second kind. **Before deleting one, grep it
  for open-state markers** (`STILL`, `OPEN`, `NOT`, `left`, `gap`, `empty`, `deliberately`,
  `unresolved`, `follow-on`) **and check each hit against the repo.** Three real misses that
  session: `cls_exam_papers` (zero-row, unfalsifiable surface section) and the rank/tier-
  wrapper verification gap both lived ONLY in the deleted note; a third was self-inflicted.
  Two traps that made them hard to see, both worth knowing on their own:
  - **A grep that HITS is not proof the thing is documented — read the hits.** Searching
    "rank remap" returned four confident-looking matches, all about a DIFFERENT mechanism
    (the view-as pair check, which proves rank parity and pair coverage and says nothing
    about what a `rank >= N` wrapper admits). Adjacent vocabulary manufactured a false
    positive. This is the vacuity rule in search form: presence must be READ, not counted.
  - **A status change is a multi-file edit until proven otherwise.** Marking docs/13's
    read-only pair-grid viewer BUILT left CLAUDE.md still calling it parked, because the same
    fact lived in two places. After flipping any DONE/BUILT/SHIPPED claim, grep for every
    other reference to it.

- Never build platform primitives speculatively — extract them when a second module needs the same thing.
- Migrations: forward-only, additive-first, always run locally before cloud.
- Every module ships with seed data and critical-path e2e tests (each role completes its core task).
- Dated **decisions logs** in module specs record client choices — don't re-litigate them silently; if a decision must change, update the spec with a new dated entry.
