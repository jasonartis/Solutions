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

**Now (2026-08-09):** **THE RANK/TIER-WRAPPER VERIFICATION GAP IS CLOSED** (`ba4eb6a`, pushed,
**no migration**) — the last thing docs/13 was carrying. `packages/db/src/rank-admission.test.ts`
+ the generated **[docs/rank-admission-map.md](docs/rank-admission-map.md)**, which doubles as
docs/13's "what does rank 2 mean in this module?" table. Rank readers AND the position
vocabulary are both DISCOVERED (from `pg_proc.prosrc` and the ladder's own body), and a
comparison the parser cannot classify FAILS rather than being skipped. Proven by remapping
salon `cashier` 1→2 in the live DB: fails, and the diff names `sal_earnings_ledger`.
**Three reusable lessons, all now in docs/03 — read them there, not here:** *a count of
mechanisms is not a count of code* (docs/13's "FOUR rules" was eight functions, and the two it
omitted included the only reader of rank 4, which fails **OPEN**); *a checker must fail on what
it cannot understand, never skip it*; and *when half a fact comes from the source of truth, the
other half is where the next gap is* — which is the mistake the adversarial review caught this
very file making. **CI ratchet extended:** `tests-floor.json.requiredFiles` fails on a
schema-coverage file that is missing *or merely untracked*. **Verification: typecheck 9/9,
build clean, db 109/109, e2e 49/49 exit 0 CI-STRICT.** Detail → journal + docs/15 2026-08-09.

**Previously — shipped, prod-verified, and fully written up elsewhere.** One line each; the
blow-by-blow is in [docs/history/platform-journal.md](docs/history/platform-journal.md)
(newest first) and the durable rules are in docs/03 / docs/12 / docs/15's decision log. Kept
this short deliberately: this file is a tax on every session, and a second copy of the journal
is the most expensive thing in it.

- **2026-08-07/08 — the superadmin lookup log** (`eef09ce`, `20260807010000`, prod 23/23).
  Both Owner Console tools record every lookup; a failed write is BADGED, not swallowed;
  docs/12 item 9 closed. Gave three rules now living in docs/03: *unranked is not rank 0*;
  *a CHECK constraint can re-create the `ON DELETE SET NULL` trap*; *a read arm keyed on who
  you WERE outlives the authority it was granted for*. **Its one open item is in the Next
  list below** (what a SECOND superadmin should see). Brought `scripts/prod-verify-superadmin-log.mts`,
  the template to copy for any table/policy migration — see the gotcha about
  `prod-verify-migration.ts` being function-only.
- **2026-08-06/07 — the Owner Console view-as** (`6a90110`, `20260806010000`). `/console/view-as`,
  superadmin-only. The three founder modes are ONE AXIS, not three code paths. Gave: *a `for
  all` policy's USING also covers SELECT, so splitting it per-command silently drops an
  inherited read arm*, and *naming a gate is not passing one* (the `SuperadminGate` brand).
- **2026-08-05 — nail-salon view-as surface review** (`89fae0a`, `20260804010000`, 33/33).
  All 12 `sal_` tables classified. Gave the durable rule in docs/03 #18: *mode 1 answers "what
  can this POSITION see?", mode 2 "what does this PERSON see?", and mode 2 is only honest
  where RLS narrows PER PERSON.* **What it deliberately did not close is in the Next list**
  (the 12-table accounting is hand-checked, not machine-enforced).
- **Earlier — the per-person data browser** (`070a73b`), **slice 5 view-as**
  (`20260731010000` + `20260802010000`, `ad8e989`, 29/29) and **the ACL hardening sweep**
  (`20260728010000`, `a16f4a5`, 39/39: `anon` holds nothing in `public`). Rules → docs/03
  #17/#18/#19.

**Next / open (pick WITH the founder — do not start unprompted; details in docs/15 §11).
AS OF 2026-08-09 the numbered items 1–6 are ALL DONE, and so is the rank/tier-wrapper gap; what
remains is the unranked list below. THE RECOMMENDED NEXT REAL PIECE IS THE ENGAGEMENT-MONITORING
BUILD, whose spec is `docs/17-engagement-monitoring.md` (founder-approved 2026-08-09, phase 1
only, Opus — it ships a migration and a trigger on `auth.users`). Two numbered items survive
below because they still carry live operational facts, not because they are open:**

- ~~**1. Confirm CI/deploy for slice 5.**~~ ~~**2. Peer-review comments.**~~
  ~~**4. THE OWNER CONSOLE VIEW-AS.**~~ ~~**5. Push and prod-verify.**~~ **ALL DONE**
  2026-08-02 → 08-07; detail in the journal. The open follow-ons they produced have been
  PROMOTED into the unranked list below rather than left inside a struck-through heading —
  that is the 2026-08-07 lesson (*open state hidden inside a completed item is how it gets
  lost*) applied to this file itself.
- **3. The speed-dating waitlist flake** (details in its own bullet below). Only truly urgent
  if it is what broke CI, which is now ruled out by item 1. **CI has `retries: 1` and runs the
  PREBUILT server (`pnpm start`), while local runs the dev server with JIT compilation and 0
  retries** — and the 2026-07-30 diagnosis pinned this family on exactly that dev-server/load
  combination, so it may well be green in CI and be a local-suite annoyance only. A clean
  `db:reset` → seed → full e2e run on 2026-08-03 (verifying the peer-review-comments fix)
  reproduced BOTH speed-dating tests passing cleanly — so the flake, when it happens, is
  intermittent even under the documented failure-inducing order, not a hard regression.
  **More evidence, 2026-08-07: THREE full clean-seed suite runs in one session, speed-dating
  green in all three** (final run 47/47, exit 0). What makes those three worth counting is
  that they are the FIRST full runs SINCE the 2026-08-05 harness fix — so they are evidence
  the fix worked, not evidence the flake never existed. **Do not tally them against older
  runs:** 2026-08-04's three runs each lost a test and the waitlist test was one of them
  (see the harness bullet below). Consistent with the fix holding; not proof. The standing
  rule stands — *judge a flake by CI, not locally* — so consider closing this at a docs beat
  only after CI has stayed green across several pushes, which would let this bullet and the
  two harness bullets below collapse into one.
- ~~**6. PROD'S DEMO DATA IS STALE.**~~ **DONE 2026-08-07.** Two facts from it are still
  operationally live and are the only reason this line survives:
  **(i) `scripts/verify-console-view-as.mts` is 35/35 local but PROD 34/35, permanently, BY
  DESIGN** — not a target to chase. The founder genuinely owns a real org (`Solutions`), so
  `is_org_member` genuinely returns true for him and the console's mode-1 blurb premise ("the
  superadmin belongs to no org") is not literally true for that account. The check still tells
  the truth; its FAIL is the understood steady state.
  **(ii) The script is parameterised** — `VERIFY_DEMO_PASSWORD` / `VERIFY_SUPERADMIN_EMAIL` /
  `VERIFY_SUPERADMIN_PASSWORD`, because prod's superadmin is the founder's REAL account, never
  `owner@demo.local` (the remote-seed guard in `seed.ts` sets that account's `is_superadmin`
  to `false` off-localhost).
Everything below is open but unranked:
- **ENGAGEMENT MONITORING — SPECCED 2026-08-09, PHASE 1 APPROVED, NOT BUILT. The recommended
  next real piece.** Full spec + dated decisions:
  **[docs/17-engagement-monitoring.md](docs/17-engagement-monitoring.md)**. Answers "who has
  gone quiet, and who should I reach out to", org→people and person→orgs. **The finding that
  decides the design, and the reason it was specced before any code: `auth.audit_log_entries`
  has NEVER been written to on prod** (`ins=0`, with `auth.users`/`sessions`/`refresh_tokens`
  insert counts as the control proving the read works) — it is fully populated LOCALLY, so
  building on it yields a feature that demos perfectly and ships permanently empty. Prod has
  only `last_sign_in_at`: the LAST login, never a frequency. **Second hard fact: a login
  cannot be attributed to an org** — people sign into the platform, not an org — so logins
  (phase 1) and org-scoped activity (phase 2) are different data, and fanning one login out
  across a member's three orgs would be a false claim. Capture mechanism is an
  `AFTER UPDATE OF last_sign_in_at` trigger on `auth.users`, the same mechanism as the live
  `on_auth_user_created`. Founder decisions already made: logins first; 90-day retention +
  permanent rollup; no user notice, one privacy-policy line; no hierarchy columns in phase 1
  but MANDATORY in phase 2 (role/scope at write time are unreconstructable — `module_roles` is
  mutated in place); superadmin-only in v1 with hierarchy-governed reads as a named future
  enhancement. **Ships a migration → full docs/03 #12 rhythm, Opus.**
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
- **Flaky e2e test — FIXED 2026-07-30** (`speed-dating module: register → round → mutual
  interest → reveal`): genuine timing/load, not data contamination; scoped `test.slow()`,
  verified in the exact failure-inducing order. Reasoning → journal, 2026-07-30.
- ~~**The local e2e suite loses ONE test per full run, a DIFFERENT one each time.**~~ **FIXED
  AT THE HARNESS LEVEL 2026-08-05** — and the diagnosis is the part worth keeping. Three
  clean-seed full runs on 2026-08-04 each lost exactly one test and it was a different test
  every time (classroom homework, then speed-dating waitlist), each passing in isolation. **A
  moving failure is environmental, not a set of test bugs** — the local dev server compiles
  routes mid-test — which is why per-test patches were whack-a-mole. The family has **two
  sub-shapes needing two DIFFERENT knobs**, and confusing them is how a session wastes an hour:
  1. **the assertion after a navigation times out** (the link is in the DOM, the page just has
     not changed yet) → `expect.timeout`, now 15s locally. `test.slow()` does NOT help here: it
     raises the TEST timeout, not the per-assertion one.
  2. **the `.click()` ACTION stalls to the test timeout** (log ends at "element is visible,
     enabled and stable, scrolling into view if needed") → `test.slow()` or a longer test
     timeout; an `expect` timeout cannot fix it.
  **CI is deliberately left STRICTER (5s expect, 30s test)** because it serves a PREBUILT app
  where a slow assertion means something is genuinely slow — the split is what keeps this from
  becoming a blanket "wait longer" that hides a regression. **Still judge a flake by CI, not
  locally.**
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
  *(The 2026-08-02 founder decision behind item 2 — a student sees the COMMENTS on their own
  homework but never the peer GRADES — was BUILT 2026-08-03; `cls_comments_for_my_submission()`
  already had the right filter and grant. Details → module-2 spec, 2026-08-03.)*
- ~~**The per-person data browser.**~~ **DONE 2026-08-03.** One known gap is still open and
  is the only reason this line survives: **walk-in salon customers have no account, so they are
  not findable** — the fix, if ever wanted, is letting a salon LINK a walk-in to an account when
  they sign up, not requiring accounts up front. (Its other recorded gap, the view-as session
  log's whole-org admin read, was promoted to its own bullet above on 2026-08-09.)
- **Founder-raised 2026-08-02, parked in docs/13.** The **read-only positions/ranks/pair-grid
  viewer is DONE 2026-08-06** (folded into `/console/view-as`). ~~**The rank/tier-wrapper
  verification gap**~~ **DONE 2026-08-09 — see Now.** What REMAINS of this entry is the
  original, larger idea: generalising per-position visibility as a *documented, test-proven*
  map rather than generated RLS, across every position × every table. Opus. It carries the
  reusable line it produced: **anything that WIDENS reach belongs in code; anything that only
  NARROWS it can be a runtime switch.** Note the rank map does NOT subsume it — that map
  answers "which POSITIONS does a rank gate admit", never "which TABLES may a position read",
  and it deliberately ignores non-rank arms (role-name checks, `is_org_admin`) because those
  do not move when the ladder moves.
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
- Tables created in CLI migrations do NOT inherit Supabase's default API-role grants — every migration must `grant` explicitly (see 20260706120000_core.sql). **Functions are the inverse trap and dev/prod DIVERGE:** Postgres grants `EXECUTE` to `PUBLIC` at CREATE (so anon can call), and on PROD `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` ALSO grants `EXECUTE` directly to `anon`/`authenticated` — which `revoke ... from public` does NOT remove. Local lacks that default, so a function locked down with only `revoke ... from public` looks closed locally but is open on prod (the 2026-07-22 `module_scope_covers` gap → `20260722010000`). Rule: state the full intended ACL explicitly (`revoke execute ... from public, anon, authenticated;` then `grant` to exactly who needs it), and verify security-sensitive ACLs against PROD — the local RLS suite can't catch this. See docs/03 convention #1. **`pnpm exec tsx scripts/prod-verify-migration.ts <path-to-migration.sql>` now automates that prod check** (read-only: per-function body md5, secdef, pinned search_path, real EXECUTE ACL incl. anon). **It takes a PATH, not a version — and it checks FUNCTIONS ONLY, so for a migration that defines none (a policy, a grant, an index) its "0 failures" is VACUOUS.** Hit 2026-08-07 on `20260806010000`, a policy-only migration: the run passed while asserting nothing about the policy. Verify those with a direct read-only `pg_policies` query against prod, and carry a control (count all policies) so an empty result is a real absence rather than a broken catalog read. **DO NOT HAND-ROLL THAT ANY MORE — `scripts/prod-verify-superadmin-log.mts` (2026-08-09) is the worked template**: no args, no app credentials (it uses the pooler + `SUPABASE_DB_PASSWORD`), and it checks the whole class the function-only script is blind to — real table ACL, each policy's expression, **the ABSENCE of a policy arm asserted as a negative**, the trigger being BOUND rather than merely defined, and every FK's delete action — each with its own control. Copy it per migration.

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
