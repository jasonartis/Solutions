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

**Now (2026-08-07):** **THE OWNER CONSOLE VIEW-AS IS ON PROD AND PROD-VERIFIED** (commit
`6a90110`, migration `20260806010000`; Vercel production `READY`, which proves CI was green
since `deploy` has `needs: check`; prod policy confirmed live as
`(is_org_member(org_id) OR is_superadmin())` against 200 visible policies as the control). `/console/view-as`, superadmin-only, absent from the in-module tab
strips. Renders any declared position's surface in any org, bypassing **four** things — the
declared edge, the rank/scope-coverage conditions, §8.1 point 10's caller-scope intersection,
and `org_modules.enabled` — and **never RLS, never the surface declaration**. The three
founder-specified modes are **ONE AXIS, not three code paths**: the mode picks the PERSON
axis (me / one named holder / nobody) and scope is an independent picker in every mode, which
is what makes mode 3 answer the case the salon review refused to fake. docs/13's read-only
positions/ranks/pair-grid viewer is folded into the same screen. One migration
(`20260806010000`) restores the superadmin's SELECT on `sal_locations` — **a `for all`
policy's USING also covers SELECT, so splitting one per-command silently drops an inherited
read arm.**

**The adversarial review's 8 findings are all applied.** Two are worth carrying forward:
**finding 1 was a LIVE DEFECT outside the diff** (classroom's student surface declared
`cls_review_comments` with `subjectColumn: null`, so every student's tab showed the whole
class's peer feedback — a FALSE CLAIM, not a leak, since the live student UI uses a definer
that filters and strips the author; now an embed under `cls_submissions` keyed on
`student_id`), and **finding 2 gave the reusable mechanism: naming a gate is not passing
one** — `RenderAuthority`'s superadmin arm now carries a `SuperadminGate`, a `declare const
unique symbol` brand that only `requireSuperadmin()` can mint.

**UNLOGGED GOT ITS DATED DECISION, not an assumption: this build ships unlogged and says so
on screen; THE LOG GETS BUILT as a follow-on** (own table, written by BOTH console tools,
hierarchy-governed visibility by the appointment rule). It is now **docs/12 checklist item 9**
— a log started later can never cover the period before it existed.

**Verification:** typecheck 9/9, build clean, db suite **97/97 (RLS 93/93)**, e2e **47**,
floor raised to **47/93**, **35/35 new console probes + 22/22 data-browser probes, zero
skips** (`scripts/verify-console-view-as.mts`). Full detail → journal + docs/15's
2026-08-06/07 entry; reusable rules → **docs/03 #18** (seven new bullets) + Test discipline.

**Previously (2026-08-05):** **NAIL-SALON VIEW-AS SURFACE REVIEW IS ON PROD AND PROD-VERIFIED**
(commit `89fae0a`, migration `20260804010000`; **33/33 prod probes**, and the Vercel production
deploy is `READY`, which proves CI was green since `deploy` has `needs: check`). Module 5's
own §8.1 point 9 review, the follow-on the founder sequenced ahead of the Owner Console: nine
pairs answered, three surfaces written, all 12 `sal_` tables classified per position.
**Mode 1 ON for all five staff-to-staff pairs, mode 2 additionally for the two into `worker`,
all four customer pairs OFF (re-decided, not inherited).**

**The finding, which generalises past this module: mode 1 answers "what can this POSITION
see?", mode 2 answers "what does this PERSON see?", and mode 2 is only honest where RLS
narrows PER PERSON.** Salon narrows per LOCATION for manager/cashier (so no row is about
either as a person — filtering an authorship stamp would UNDER-show the tab, and
`viewAsCompleteness()` refuses mode 2 without a per-person table) and per PERSON only for
worker. The migration is just those two ON pairs, because `module_view_as_edge()` mirrors
MODE 2 only — it gates the session INSERT, and mode 1 writes nothing.

Full reasoning, the surface findings (a cashier reads ZERO revenue rows; a worker cannot read
even the earnings carrying their own `worker_id`), the two rode-along honesty fixes, and what
the review deliberately left open → **docs/15 (2026-08-04)**, journal, module-5 spec; reusable
rules → **docs/03 #18** (six new bullets) + its Test-discipline section. Verification:
typecheck 9/9, RLS **90/90**, **36/36 probes zero skips**, 3 new e2e; floor raised (e2e 42 /
rls 86). **Two Opus adversarial reviews: no ship-blocker on the
mechanism, but four FALSE factual claims in the notes and a keystone test that only proved the
query parsed — all fixed.**

**Then four founder-approved follow-ups, same session (2026-08-05 — full reasoning in docs/15's
2026-08-05 entry):** (a) the dead `columns?` field on `PersonalLayer`/`ExcludedFromSurface` is
GONE — the overlap check made it unusable, so column decisions live in the role allow-list plus
a caveat, and `excluded: []` means "no whole table withheld", not "nothing withheld";
(b) **the CI test-count ratchet now counts TESTS** — its RLS half was an unanchored
`grep -c "it("` that also matched every `.limit(` line (real 90, measured 105), now anchored
with an exact floor (docs/12); (c) **the salon seed gained a paid visit, the bookkeeping rows,
and a salon ADMIN (frank)** — which closes the review's one open gap, since only an `admin` can
open the Manager tab and there was nobody to sign in as; a new e2e renders it and asserts a real
earnings row; (d) **e2e timeouts are now environment-dependent and CI is deliberately STRICTER**
(local `expect` 15s / test 45s; CI keeps 5s, because it serves a PREBUILT app where slow means
slow). **Still known-open, on purpose:** the 12-table accounting is hand-checked, not
machine-enforced — see the Next list.

**Previously:** the **per-person data browser is ON PROD** (`070a73b`, zero migrations —
Vercel production `READY`, which proves CI was green since `deploy` has `needs: check`);
`/console/data-browser`, superadmin-only, answering *"what do I hold about this person?"* as
against view-as's *"what does this person see?"*. Its UI gate is sound only because nothing
on that path may ever call `.rpc()` or a service-role client — source-scanned by a probe.
**Slice 5 (VIEW-AS) is ON PROD and PROD-VERIFIED** (`20260731010000` + `20260802010000`,
`ad8e989`; 29/29 prod probes). **The ACL HARDENING SWEEP is ON PROD and PROD-VERIFIED**
(`20260728010000`, `a16f4a5`; 39/39) — `anon` holds nothing in `public`, `authenticated` lost
TRUNCATE. Blow-by-blow for all three → docs/history/platform-journal.md; rules → docs/03
#17/#18/#19.

**Next / open (pick WITH the founder — do not start unprompted; details in docs/15 §11).
RECOMMENDED ORDER as of 2026-08-04 — items 1–3 are done; the next real piece is the Owner
Console view-as (Opus territory, not Sonnet), then unranked follow-ons:**

- ~~**1. Confirm CI/deploy for slice 5.**~~ **DONE 2026-08-02** — prod app and prod schema in
  sync; a `READY` production deploy proves CI was green (`deploy` has `needs: check`).
- ~~**2. Students cannot see peer-review comments on their own homework.**~~ **DONE
  2026-08-03** — UI-only, no migration; details in the journal + module-2 spec.
- **3. The speed-dating waitlist flake** (details in its own bullet below). Only truly urgent
  if it is what broke CI, which is now ruled out by item 1. **CI has `retries: 1` and runs the
  PREBUILT server (`pnpm start`), while local runs the dev server with JIT compilation and 0
  retries** — and the 2026-07-30 diagnosis pinned this family on exactly that dev-server/load
  combination, so it may well be green in CI and be a local-suite annoyance only. A clean
  `db:reset` → seed → full e2e run on 2026-08-03 (verifying the peer-review-comments fix)
  reproduced BOTH speed-dating tests passing cleanly — so the flake, when it happens, is
  intermittent even under the documented failure-inducing order, not a hard regression.
- ~~**4. THE OWNER CONSOLE VIEW-AS.**~~ **DONE 2026-08-06/07 — see Now.** Three follow-ons
  it produced, all recorded rather than closed:
  **(a) THE SUPERADMIN LOOKUP LOG** — founder-decided, spec settled, now docs/12 item 9 and
  must exist before the first paying customer. New table (not `view_as_sessions`: different
  event, and a `view_as_sessions` row IS a capability), written by BOTH console tools,
  visibility by the APPOINTMENT rule (strict rank + scope coverage), append-only by GRANTS
  with `service_role` named in the revoke. The trap: a log row names TWO people — hierarchy
  answers who may read by ACTOR; reading by TARGET is §8.1 point 6's notify question, still
  open. Opus, ~2h + its own review (new table with RLS and grants ⇒ full docs/03 #12).
  **(b) `blinded` CHECKS ONE TABLE PER MODULE** (the `scopeEntity`), never per role table, so
  a future migration dropping an `is_org_admin` arm on an ordinary role table gives a silent,
  error-free, UNBADGED empty section. `20260806010000` is proof the category already bit once
  — caught only because it hit the scope-entity table, whose symptom is loud.
  **(c) Should `view_as_sessions`' own whole-org admin read be narrowed by hierarchy too?**
  Same founder principle as (a), own migration, own review.
- ~~**5. Push and prod-verify.**~~ **DONE 2026-08-07** — see Now. Backup at
  `backups/2026-08-07T22-05-54/` before the migration, per docs/12.
- **6. PROD'S DEMO DATA IS STALE relative to the 2026-08-06 fixtures — a founder decision,
  not a task to start unprompted.** Measured on prod 2026-08-07: **no `grace@demo.local`, 1
  salon location, 0 `cls_review_comments`** (10 profiles total as the non-emptiness control).
  Consequence: `scripts/verify-console-view-as.mts` **cannot meaningfully run against prod**
  — it fails at grace's sign-in and its second-location / cross-authored-comment controls
  would report honest skips, which under the no-silent-skips rule proves nothing. The same
  gap is on the SCREEN: prod's mode-3 scope case has one location to narrow, and the
  classroom peer-comment fix has no comments to filter, so neither shipped behaviour is
  observable there. **That is the exact vacuity the fixtures closed locally, now sitting on
  prod.** Fix is `SEED_ALLOW_REMOTE=yes` + `PROD_DEMO_PASSWORD` (deletes are demo-org-scoped,
  docs/12 guard 5) — but it WRITES TO PRODUCTION, so it needs an explicit go-ahead. Sonnet.

Everything below is open but unranked:
- **Slice 5 remaining follow-ons:** ~~the nail-salon surface review~~ **DONE 2026-08-04**
  (see Now). Left: **speed-dating's 6 pairs** — and note its review is genuinely harder than
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
- ~~**Seed the salon's back office.**~~ **DONE 2026-08-05** — see Now. (Salon demo logins are
  now: **frank = admin**, alice = manager, eve = cashier, dana = worker, charlie = customer.)
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
- `import.meta.dirname` is `undefined` under tsx — use `dirname(fileURLToPath(import.meta.url))`.
- Docker Desktop's WSL backend crashed under parallel image pulls → `C:\Users\yarmishj\.wslconfig` caps WSL at 8GB/4CPU (delete to revert); pull images sequentially if it recurs; zero-log segfaulting containers (exit 139) = corrupted image layers, `docker rmi` + re-pull.
- **`pnpm test` OOM-crashes on this host under turbo's 5-way parallelism** (`FATAL ERROR:
  Committing semi space failed`, at absurdly small heaps with ~7GB free). It is NOT the
  `node-compile-cache` corruption below — clearing that does not help. **Use `pnpm exec turbo
  run test --concurrency=1`.** Never read a parallel-run failure as a real one.
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
- Tables created in CLI migrations do NOT inherit Supabase's default API-role grants — every migration must `grant` explicitly (see 20260706120000_core.sql). **Functions are the inverse trap and dev/prod DIVERGE:** Postgres grants `EXECUTE` to `PUBLIC` at CREATE (so anon can call), and on PROD `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` ALSO grants `EXECUTE` directly to `anon`/`authenticated` — which `revoke ... from public` does NOT remove. Local lacks that default, so a function locked down with only `revoke ... from public` looks closed locally but is open on prod (the 2026-07-22 `module_scope_covers` gap → `20260722010000`). Rule: state the full intended ACL explicitly (`revoke execute ... from public, anon, authenticated;` then `grant` to exactly who needs it), and verify security-sensitive ACLs against PROD — the local RLS suite can't catch this. See docs/03 convention #1. **`pnpm exec tsx scripts/prod-verify-migration.ts <path-to-migration.sql>` now automates that prod check** (read-only: per-function body md5, secdef, pinned search_path, real EXECUTE ACL incl. anon). **It takes a PATH, not a version — and it checks FUNCTIONS ONLY, so for a migration that defines none (a policy, a grant, an index) its "0 failures" is VACUOUS.** Hit 2026-08-07 on `20260806010000`, a policy-only migration: the run passed while asserting nothing about the policy. Verify those with a direct read-only `pg_policies` query against prod, and carry a control (count all policies) so an empty result is a real absence rather than a broken catalog read.

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
