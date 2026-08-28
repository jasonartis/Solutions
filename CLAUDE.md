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

**Now (2026-08-28) — the view-as surface-coverage ratchet (picked WITH the founder from "Next /
open") just shipped: `packages/db/src/view-as-coverage.test.ts`, 140/140 db tests, no migration.
Classroom's own re-classification is deliberately deferred, not done — see that item below.
Nothing else is in flight. Pick the next item WITH the founder from the "Next / open" list;
do not start unprompted (standing rule).**

**Host state, 2026-08-12:** the machine was migrated to a new Windows profile
(`C:\Users\yarmishj.AEI-LT-JYARMISH`) after the old one was lost. Claude's own state — memories,
560 permission entries, the `log-session` skill — is fully migrated and verified. **If `pnpm` is not
on PATH, that is the known profile issue and the gotchas below have the workaround; it is not a new
fault.** Do not re-diagnose it as tool corruption. **Docker Desktop has several documented
per-profile/host quirks on this machine (admin-group membership, wrong container mode, a crashed
backend process ballooning memory) — all in the gotchas section; check there before re-diagnosing
any of them as new.**

**Previously (2026-08-16 → 08-21): ENGAGEMENT MONITORING PHASE 2 FULLY SHIPPED AND PROD-VERIFIED**
— capture is now LIVE on production with a real recorded event. Full narrative (the CI failure that
looked like a flake but wasn't, the migration that had never actually reached prod despite being
called "pushed," the false lead chasing a `Prefer: return=representation` header) →
[docs/history/platform-journal.md](docs/history/platform-journal.md)'s 2026-08-16 → 08-21 entry.
Commits `d653d4d` (instrumentation: 48 call sites, RLS test port, prod-verify script) and `f121539`
(the CI fix). Migration `20260810010000_activity_events.sql` applied to prod via `pnpm migrate:prod`
2026-08-21 — it had sat committed-but-never-deployed since 2026-08-11. Prod-verify: 78/78, including
a real captured event (dana@demo.local, `walk_in.added`, Demo Salon). A confirmed-Fable re-review of
phase 1's migration also ran and closed the item open since 2026-08-09 (verdict: ship as-is, plus a
`current_user` check now permanent in both prod-verify scripts).

**Previously (2026-08-09):** **ENGAGEMENT MONITORING PHASE 3 — THE CONSOLE PAGE — IS BUILT**
(`/console/engagement`, **no migration**, Sonnet-tier per docs/17 §8b). Spec and every decision:
**[docs/17-engagement-monitoring.md](docs/17-engagement-monitoring.md)**. Reads phase 1's
`login_events`/`login_rollup` through the caller's ordinary RLS client — no `.rpc()`, no
service-role — and answers both directions the founder asked for (org→people, person→orgs) plus a
platform-wide "quietest members" landing view that needs no picker. **The honesty badge — owed
because the capture trigger swallows its own errors — reads `login_rollup`, not the 90-day raw
table**, so it can't misread a healthy-but-quiet platform as a capture failure; rendered with a
test that asserts a real, non-vacuous timestamp. **Schema-friction reported back, as phase 1's own
checklist asked of its first reader:** the deliberate absence of `org_id` really does force
multi-round-trip client-side joins through `org_members` for the platform-wide view — real, not
costly yet at this scale; full argument → docs/17's decisions log. **Verification: typecheck 9/9,
db 121/121 (real run), e2e 50/51 — the one failure is the pre-existing, documented speed-dating
resume-review timeout flake, unrelated to this diff.** Committed `4b036cf`, pushed, deployed READY
on Vercel production. Detail → journal + docs/17's decisions log.

**Previously — shipped, prod-verified, and fully written up elsewhere.** One line each; the
blow-by-blow is in [docs/history/platform-journal.md](docs/history/platform-journal.md)
(newest first) and the durable rules are in docs/03 / docs/12 / docs/15's decision log. Kept
this short deliberately: this file is a tax on every session, and a second copy of the journal
is the most expensive thing in it.

- **2026-08-09 — engagement monitoring phase 1, login capture** (`20260809010000_login_events.sql`,
  a trigger on `auth.users`). `login_events` (raw, 90-day) + `login_rollup` (permanent), both
  READ-ONLY to every api role and superadmin-only reads; an owner-only pruner; a daily pg-boss job.
  Of 12 prod users, 5 have ever signed in and 7 NEVER have — the outreach list existed on day one.
  Founder decisions: superadmin-only reads, no `profiles` mirror, hierarchy-governed engagement
  built on phase 2 not raw logins (a login has no org). **Four durable lessons → docs/03/docs/17:**
  `WHEN OTHERS` does not catch `query_canceled` (bound lock waits with a function-scoped
  `lock_timeout` instead); never document a test you have not written; RLS filters rows never
  columns, so a column added to `profiles` is readable by every org-mate; a `>>> FULL TURBO` result
  after a migration is a cached replay, not a run (gotcha below). Prod-verified 11/11 pre-flight.
- **2026-08-09 — the rank admission map** (`ba4eb6a`, no migration). `rank-admission.test.ts` +
  generated **[docs/rank-admission-map.md](docs/rank-admission-map.md)** (also docs/13's "what does
  rank 2 mean here?" table); rank readers and the position vocabulary are both DISCOVERED, and an
  unclassifiable comparison FAILS rather than skipping. Also extended the CI ratchet to
  `requiredFiles`. Three rules → docs/03.
- **2026-08-07/08 — the superadmin lookup log** (`eef09ce`, `20260807010000`, prod 23/23). Both
  console tools log every lookup; a failed write is BADGED. Closed docs/12 item 9; brought
  `scripts/prod-verify-superadmin-log.mts` (the table/policy verifier template — see the gotcha
  about `prod-verify-migration.ts` being function-only). Three rules → docs/03. **What a SECOND
  superadmin should see is now DECIDED (2026-08-10) but not built — detail in the list below.**
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
ENGAGEMENT MONITORING PHASES 1 AND 3; what remains is the unranked list below. **Engagement
monitoring phase 2 is FOUNDER-APPROVED AND ITS MIGRATION IS BUILT, VERIFIED AND PUSHED
(2026-08-11)** — the exception to "pick it up only with the founder", because that pick-up already
happened; finishing it is the three mechanical tasks in "Now" above, not a new decision. Two
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
- **ENGAGEMENT MONITORING — PHASES 1, 2 AND 3 ALL LIVE ON PROD (phase 2 shipped and prod-verified
  2026-08-21 — see "Previously" above and the journal for the full story).** §12 remains the build
  brief it always was, but **note two places it is now WRONG and
  was deliberately overridden** — do not "fix" the code back to it: §12.4 demanded the actor's
  `role`/`scope_ref` as NOT NULL scalars (not implementable — multiple simultaneous grants are
  first-class, and `is_org_admin` authority is not in `module_roles` at all, so `actor_grants` is a
  jsonb array of PAIRED objects), and it proposed an `org_modules` entitlement check (rejected —
  `org_modules` gates no RLS anywhere, so a guard stricter than the modules would silently drop
  real activity, and by founder decision 3 that drop is invisible). Full spec + dated decisions:
  **[docs/17-engagement-monitoring.md](docs/17-engagement-monitoring.md)**. Live: login capture
  (phase 1), org-scoped activity capture (phase 2, ~48 call sites across all 6 modules), and the
  console page (phase 3, `/console/engagement`, reads phase 1 only — phase 2 SHIPS CAPTURE-ONLY,
  no reader yet, per docs/17's decisions log item 10) — the honesty badge phase 3 owed is BUILT,
  with a test. **Four things carried forward, all recorded there in full:**
  **(i) RETENTION IS NOT ENFORCED IN PROD UNTIL THE WORKER RUNS THERE** (still the
  `pnpm worker:prod` stopgap) — raw events accumulate past 90 days meanwhile; the pruner is
  idempotent and range-based so the first real run catches up. **(ii) HIERARCHY-GOVERNED
  ENGAGEMENT GOES ON PHASE 2's DATA, NEVER ON RAW LOGINS** (founder agreed 2026-08-09): a login has
  no org, so "frank sees dana's logins" reports activity that may belong to a different client's
  org entirely. **(iii) Phase 2 stays MANDATORY-hierarchy-columns** — role/scope at write time are
  unreconstructable because `module_roles` is mutated in place. **(iv) `auth.audit_log_entries` is
  still never written to on prod** (`ins=0`, re-measured 2026-08-09 with the sibling-table insert
  counts as control) — never build on it; it is fully populated locally, which is the trap.
  **New from the phase 3 build, worth weighing before phase 2's own schema is drafted: the
  deliberate absence of `org_id` on phase 1's tables really did force multi-round-trip
  client-side joining for the platform-wide "quietest members" view** — not costly at this
  platform's current scale, but real friction; full argument in docs/17's decisions log.
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
- ~~**A CONFIRMED-FABLE RE-REVIEW OF `20260809010000` IS OPEN.**~~ **DONE 2026-08-16** — verdict SHIP
  AS-IS, plus one concrete fix: the "worker's pooler connection really authenticates as `postgres`"
  claim rested on a single one-time manual measurement and is now a permanent, re-runnable check in
  both `scripts/prod-verify-login-events.mts` and `scripts/prod-verify-activity-events.mts`. Full
  writeup → docs/17's decisions log, 2026-08-16 entry.
- **`blinded` CHECKS ONE TABLE PER MODULE** (the `scopeEntity`), never per role table — so a
  future migration dropping an `is_org_admin` arm on an ordinary role table gives a silent,
  error-free, **UNBADGED** empty section. `20260806010000` is proof the category already bit
  once, caught only because it hit the scope-entity table, whose symptom is loud. *(Promoted
  2026-08-09 out of the struck-through view-as item, where it was invisible. Full context:
  docs/15 finding 6.)*
- **Should `view_as_sessions`' own whole-org admin read be narrowed by hierarchy?** Today it
  is whole-org, since an org admin has no scope dimension — and the data browser makes that
  data *findable* where it was merely readable. Same founder principle as the second-superadmin
  decision below; own migration, own review. *(Also promoted 2026-08-09 out of two different
  struck-through items; recorded in docs/13 and docs/15 §8.1.)*
- **FOUNDER DECISION RECORDED 2026-08-10, NOT YET IMPLEMENTABLE: a second superadmin should read
  their own lookups plus those "lower" than them** (raised 2026-08-07/08 by the log's own build;
  decided 2026-08-10; full argument in docs/12 item 9 and docs/15's 2026-08-10 entry). Same shape
  as the appointment-rule/hierarchy pattern used everywhere else — reads flow down, never up. **Not
  built**, and deliberately so: there is exactly one superadmin today, so there is nothing to rank
  and no live case to build against (extract-don't-speculate). It is also missing the thing the
  decision presupposes — **superadmins have no ordering today** (`is_superadmin` is a flat boolean,
  no rank/seniority/appointment-chain column) — so a second, narrower question (what determines
  "lower"?) has to be answered with a real second operator in front of you before this becomes a
  migration. "A second superadmin" remains the trigger — now to implement this, not to decide it.
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
- ~~**Machine-enforce "every module table is classified on every surface."**~~ **RATCHET DONE
  2026-08-28** — `packages/db/src/view-as-coverage.test.ts` now enumerates each module's real
  tables from `pg_catalog` (by the prefix its own declaration uses, so no hand-maintained
  prefix map to drift) and fails on any table missing from role/personal/excluded/
  unreadableByPosition **or a nested `embed`** on any declared surface, with a
  `KNOWN_GAPS` baseline so only NEW gaps fail the build (same shape as
  `data-browser-coverage.test.ts`'s tier-2 backlog report). Verified it has real teeth, not
  just a pass: deliberately removed one accepted entry (failed, naming the exact table) and
  deliberately added a stale one already-satisfied entry (failed the other direction too), then
  restored and reran clean — 140/140 db tests. **STILL OPEN, deliberately deferred, not
  forgotten:** classroom's own re-classification. It FAILS today's stricter question if the
  baseline were empty — GA classifies 9/16 real `cls_` tables, Student 13/16 (counting embeds) —
  frozen in `KNOWN_GAPS` rather than answered, because each of the ~10 gaps is a real per-table
  RLS judgment call (e.g. can a GA actually read `cls_exams`?), not mechanical. Nail-salon has
  zero gaps under the same check — the control that proves this isn't vacuous for a module that
  actually got its table-by-table review. Opus-tier if picked up (per the original estimate);
  ~half a day.
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
- `gh` is NOT installed on this machine. **CI PASS/FAIL is readable from the terminal without
  it** — the `deploy` job has `needs: check`, so a `READY` production deployment proves `check`
  was green. Query it with the `VERCEL_TOKEN` already in `.env.deploy`:
  `GET https://api.vercel.com/v6/deployments?limit=8` with `Authorization: Bearer <token>`,
  and match `meta.githubCommitSha` against the commit. Gives state/target/sha/time per
  deploy — answers "did it ship?" in seconds. **And the actual failure text IS readable from
  the terminal too, without `gh` and without a configured PAT (2026-08-21)** — the repo's
  `.env.accounts` `GITHUB_PAT` field has always been an unfilled template placeholder, not a
  real token, so don't waste time hunting for one there. Instead reuse Git Credential Manager's
  own cached OAuth token (the same thing that lets `git push` work without prompting):
  `printf 'protocol=https\nhost=github.com\n' | git credential fill` prints a `password=` line
  that IS a usable bearer token for the GitHub REST API. Use it against
  `GET /repos/<owner>/<repo>/actions/runs?per_page=N` to find the run, then
  `GET /repos/<owner>/<repo>/actions/jobs/<job_id>/logs` **with `curl -L`** (the endpoint 302s to
  a signed blob URL — the redirect must be followed or you get an empty file) to get the FULL
  raw job log as plain text, no zip. This is how the exact e2e failure that broke CI on
  `d653d4d` was found and fixed same-session — check-run annotations alone (`.../check-runs/
  <id>/annotations`) only gave a generic "exit code 1" with no Playwright reporter configured for
  GitHub, so the full log was genuinely necessary, not just a convenience.
  **CI also differs from local in two ways that matter for e2e:** `retries: 1` (local 0) and a
  PREBUILT server via `pnpm start` (local `pnpm dev` compiles routes mid-test) —
  `apps/web/playwright.config.ts:9,15`. So a test that flakes locally may be reliably green in CI
  and vice versa; judge by the actual CI run. **And a CI failure that looks like flakiness
  because two different local reproductions both passed clean is not proof of flakiness** — it
  can mean the reproduction didn't match CI's literal step order. `.github/workflows/ci.yml` runs
  `pnpm --filter @platform/db test` immediately before `pnpm test:e2e` on the SAME database with
  NO reset in between; reproducing that exact order (not just "reset, then eventually run e2e
  at some point") is what actually surfaces an order-dependent failure like the grace/login-history
  one below.
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
- **THE PRIVACY-POLICY LINE IS NOW DOUBLY OUTSTANDING, NOT A PRE-LAUNCH NICETY (2026-08-09,
  ESCALATED 2026-08-21).** docs/12 item 6 said this wording was a PRECONDITION of shipping —
  phase 1 shipped anyway on 2026-08-09, and **phase 2 also shipped 2026-08-21 without it**, despite
  docs/17 §9 explicitly saying phase 2's line "must exist BEFORE it ships." Both times recorded
  honestly rather than the rule being quietly relaxed. **Two lines are now owed, not one**: phase
  1's "authentication events (when you sign in)" and phase 2's per-org-activity line (materially
  bigger claim — logging what someone opened, not just that they signed in). Exposure today is
  still nil (prod's only captured phase-2 event is a demo account) and there is STILL no privacy
  page of any kind to put either line on — the single most concrete "must happen before a real
  customer" item on the platform now, precisely because two live features have shipped ahead of it.
  Full detail: docs/12 item 6.
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
- **DOCKER DESKTOP CAN COME BACK UP IN *WINDOWS CONTAINERS* MODE, AND IT LOOKS EXACTLY LIKE THE
  ENGINE BEING DEAD (2026-08-11).** Symptom: every `docker` command returns
  *"request returned 500 Internal Server Error … dockerDesktop**Windows**Engine … check if the
  server supports the requested API version"*, and — the part that sends you down a rabbit hole —
  **`wsl --list --verbose` reports "has no installed distributions"** and
  `C:\ProgramData\DockerDesktop\vm-data` is MISSING. It reads as total loss of the Linux VM,
  images and volumes. **It is not: nothing is lost.** In Windows-containers mode the Linux distro
  is simply not registered. **Diagnose with `docker context ls`** — if the starred context is
  `desktop-windows` (and no `desktop-linux` exists) this is it, not the 2026-08-09 crash below.
  **Fix: `& "$env:ProgramFiles\Docker\Docker\DockerCli.exe" -SwitchDaemon`, then FULLY restart
  Docker Desktop** (stop `Docker Desktop`/`com.docker.backend`/`com.docker.build`, relaunch) — the
  switch alone left the Linux engine still 500ing. Everything returns healthy with volumes intact;
  Kong still needs its usual restart afterwards. **Distinguishing rule: a 500 naming an ENGINE PIPE
  is a mode/provisioning problem; "cannot find the file specified" on the pipe is the engine being
  genuinely gone (below).**
- **IF SEVERAL TOOLS LOOK "MISSING" AT ONCE, CHECK WHICH WINDOWS PROFILE YOU ARE IN BEFORE
  DIAGNOSING ANYTHING ELSE — `$env:USERPROFILE` (2026-08-11).** After the founder was forced to
  restart the machine, a session came up under `C:\Users\yarmishj.AEI-LT-JYARMISH` instead of the
  normal `C:\Users\yarmishj`, and THREE tools appeared to vanish simultaneously: `pnpm` off PATH,
  Playwright's browser binary gone, and `wsl --list --verbose` reporting *"no installed
  distributions"*. **NOTHING WAS LOST OR CORRUPTED.** All three are PER-USER state sitting in the
  other profile — `AppData\Local\pnpm`, `AppData\Local\ms-playwright` (holding the exact
  `chromium_headless_shell-1228` that was reported missing), and WSL's distro registration, which
  lives in **HKCU**. Docker Desktop's settings are per-user too (`%APPDATA%\Docker`), which is very
  likely why it also came up in the wrong container mode.
  **A profile name carrying a `.MACHINE`/`.DOMAIN` suffix is Windows saying it could not load the
  real profile and created a new one** — so every per-user install, PATH entry and cache is absent
  by definition, and anything saved to "Desktop"/"Documents" lands where the founder will not find
  it. **TELL THE FOUNDER IMMEDIATELY rather than working around it**, because it affects far more
  than this repo. If you must proceed anyway: corepack for pnpm, `playwright install chromium`.
  **Do NOT write this up as tool-state loss or corruption — this entry exists because that was the
  first (wrong) diagnosis, and it would have sent the next session hunting a phantom.**
  **Two more per-profile gaps found under this same new profile, 2026-08-16 — same root cause, don't
  re-diagnose as something new:**
  1. **The `docker-users` local group only listed the OLD profile's identities** (`jyarmish`,
     `NXE\YarmishJ`), not `aei-lt-jyarmish\yarmishj`, so Docker Desktop refused to treat this account
     as a Docker admin. Fix (needs an ELEVATED prompt, which Claude cannot grant itself — this is on
     the founder): `net localgroup docker-users "aei-lt-jyarmish\yarmishj" /add`, then **sign out and
     back in** (or reboot) — group membership only takes effect in a fresh login token.
  2. Separately, this Docker Desktop install had never had the Windows **Hyper-V** and **Containers**
     optional features turned on at all (`Enable-WindowsOptionalFeature -Online -FeatureName
     Microsoft-Hyper-V,Containers -All`, elevated, then a full reboot). Unclear whether this is a
     THIRD per-profile-migration casualty or just a fresh-install gap that was never hit before — not
     worth re-deriving, just know Docker Desktop will say so plainly ("Windows containers feature is
     disabled") and name the fix itself.
- **A CRASHED `com.docker.backend` CAN BALLOON TO 13+GB AND SILENTLY STARVE EVERY SUBSEQUENT LAUNCH
  ATTEMPT (2026-08-16).** Symptom: Docker Desktop shows an "unexpected error, needs to close" dialog on
  launch, the engine pipe never comes up, and each RETRY fails the same way — looking like a
  fundamentally broken install. **The actual cause: the CRASHED instance from the PREVIOUS attempt
  doesn't release its memory when the crash dialog appears** — `Get-Process com.docker.backend` showed
  13.8GB resident (normal idle is a few hundred MB), which alone accounted for the difference between
  31GB total and 1.5GB FREE. Every relaunch attempt then starved for memory and crashed again,
  indistinguishable from a genuine install problem. **Fix: before retrying a launch, always check
  first** — `Get-Process -Name "com.docker.backend","com.docker.build","Docker Desktop" | Stop-Process
  -Force`, confirm free memory recovers (`Get-CimInstance Win32_OperatingSystem` →
  `FreePhysicalMemory`), THEN relaunch. Same family as the documented "Docker Desktop dies under
  session memory pressure" gotcha below, but the causality here runs the other way — the crash caused
  the memory pressure, not the reverse — so don't assume freeing RAM elsewhere first will help; check
  for a stray `com.docker.backend` specifically.
- **DOCKER CAN FAIL TO BIND A SUPABASE PORT WITH "forbidden by its access permissions" EVEN
  THOUGH NOTHING IS USING IT (2026-08-28).** After Docker Desktop wasn't running and was started
  fresh, `supabase start` failed recreating the db container: `listen tcp 0.0.0.0:54322: bind: An
  attempt was made to access a socket in a way forbidden by its access permissions.` `docker
  inspect`/`Get-NetTCPConnection` both confirmed nothing was actually listening on that port — this
  is NOT "port in use." **Cause: Windows had 54322 inside a Hyper-V/WSL dynamic TCP port EXCLUSION
  range** (`netsh interface ipv4 show excludedportrange protocol=tcp` — look for a range spanning
  the port; ours was `54238-54337`), which blocks any process from binding it regardless of whether
  anything holds it. A full Docker Desktop restart and even `wsl --shutdown` did NOT clear it.
  **Fix (needs an ELEVATED prompt — same category as the `docker-users` group gotcha, on the
  founder): `net stop winnat` then `net start winnat`**, which resets Windows' NAT service and
  regenerates the exclusion list without that port. Confirmed the range was gone via the same
  `netsh` command immediately after, then `supabase start` succeeded on the next try with no other
  changes. **Do not mistake this for the "Kong stale route" or "Windows-containers mode" gotchas
  above — the tell is the literal string "forbidden by its access permissions" on a bind, paired
  with a confirmed-empty port.**
- **A HANGING `git push` IS USUALLY A CREDENTIAL DIALOG WAITING ON THE FOUNDER'S DESKTOP, NOT A
  NETWORK PROBLEM (2026-08-11 — cost ~10 minutes across two timeouts).** `git push` produced NO
  output and hit a 3-minute and then a 7-minute timeout, while `git ls-remote --heads origin`
  returned instantly — which rules out network and read auth and makes it look like a hung remote.
  **The tell: `Get-Process | Where-Object { $_.Name -match "git|credential" }` showed
  `GitHub.UI` with MainWindowTitle "Connect to GitHub".** Git Credential Manager
  (`credential.helper=manager-core`) had opened an interactive auth window that only the founder
  can see and complete; `GIT_TERMINAL_PROMPT=0` does NOT prevent it, because it is a GUI prompt
  rather than a terminal one. **Check for that window before diagnosing anything else, and tell the
  founder it is waiting — they cannot know otherwise.** There are no hooks in `.git/hooks`, so rule
  that out cheaply too.
- **`pnpm` MAY NOT BE ON PATH, while `corepack` is (2026-08-11).** `pnpm : The term 'pnpm' is not
  recognized`, yet `corepack pnpm --version` prints 10.34.3. **`corepack pnpm <cmd>` is NOT a
  workaround** — the repo's own scripts shell out to bare `pnpm` (`pnpm --filter @platform/db
  seed`), so it fails one level down with a confusing "'pnpm' is not recognized" from inside a
  script that appeared to start fine. **`corepack enable` needs admin** (`EPERM … 'C:\Program
  Files\nodejs\pnpx'`). Non-admin fix: `corepack enable --install-directory <writable dir>` then
  prepend that dir to `$env:PATH` in EVERY command (shell state does not persist between tool
  calls). Appeared in the same session as the Docker mode flip, so suspect a common cause if both
  show up together.
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
- **THE WHOLE E2E SUITE FAILING IS ALWAYS INFRASTRUCTURE, NEVER YOUR DIFF — and there are FOUR
  causes that look identical at the summary line.** (Merged 2026-08-11 from three separate entries;
  they kept being written as if each were the only one, which is exactly what makes the summary
  line misleading.) **READ THE PER-TEST ERROR FIRST — it names which of the four this is, and only
  the first two are worth any worry:**
  1. **`ERR_CONNECTION_REFUSED` + `FATAL ERROR: ... JavaScript heap out of memory` in the
     `[WebServer]` lines (2026-08-09)** — the full suite OOMs the `pnpm dev` server. A PARTIAL run
     is the same cause: tests pass until it dies, then everything after fails. Clearing
     `%TEMP%\node-compile-cache` does NOT help. **Fix: run it the way CI does —
     `CI=true pnpm --filter web exec playwright test`, having built first.** That serves the
     PREBUILT app (`pnpm start`) instead of JIT-compiling routes: far lighter on memory, and the
     STRICTER config (5s expect, 30s test, retries 1).
  2. **Stuck on `Working…` at sign-in (2026-08-06)** — auth, two sub-causes. **(a) A stale dev
     server**: the local Playwright config REUSES whatever is already on :3000, and one left from a
     session three days earlier silently served every run. `netstat -ano | grep :3000` then
     `Get-CimInstance Win32_Process -Filter "ProcessId=N"` shows its **CreationDate**; if it
     predates your work, kill it. **(b) Kong's stale auth route after `db:reset`** —
     `docker restart supabase_kong_...` must come AFTER the reset, since resetting recreates the
     auth container and re-stales the route.
  3. **`browserType.launch: Executable doesn't exist at …\ms-playwright\chromium_headless_shell-…`
     (2026-08-11)** — the browser binary is simply not installed. The app builds, the server
     starts, the seed succeeds. **Fix: `pnpm --filter web exec playwright install chromium`.**
  4. **Docker not actually running** — see the Docker entries above; a dead or wrong-mode engine
     takes the database with it.
  **Measure, don't theorise** (the 2026-08-06 lesson cost an hour): `curl -X POST
  "$SUPABASE_URL/auth/v1/token?grant_type=password" -H "apikey: $ANON" -d
  '{"email":"owner@demo.local","password":"password123"}'` — 502 is Kong, 400 means the seed did
  not run, 200 means auth is fine and the problem is the app server. **Working order: `db:reset` →
  restart Kong → `seed` → curl says 200 → build → run.**
  **And do NOT pipe the run through `Select-Object -Last N` / `tail`** — it truncates away the
  per-test error (the only thing that distinguishes the four) and leaves a trailing list of test
  names that reads as a mysterious mass failure. Redirect to a file and grep it; the same rule
  already stated below for exit codes applies to diagnosing causes.
- **Do NOT edit app source while the e2e suite is running** (the local config serves
  `pnpm dev`, so an edit lands mid-run on a half-compiled app). Editing `docs/*.md` is safe.
  Related: piping the run through `| tail -N` swallows its exit code, so a failing suite
  reports success to the shell — redirect to a file and check `$?` instead.
- **Reproducing a flaky/order-dependent e2e failure: `db:reset` + `pnpm seed` immediately before the reproduction run, not just once at the start of the session.** Several e2e tests are documented non-idempotent (assume fresh seed state). Running a suspect test in isolation first (to confirm it currently passes) mutates that seed data; a subsequent full-suite reproduction attempt then fails for the mundane reason of stale state from your OWN prior run — which looks like the bug you're chasing but isn't (hit in a 2026-07-30 session validating the speed-dating flaky-test fix: an isolated run advanced the seeded event to `complete`, then the very next full-suite run failed at the first "Register" step instead of reproducing the real timing issue).
  **THE SAME TRAP APPLIES TO RUNNING THE FULL SUITE TWICE IN A ROW, not just an isolated test then the
  full suite (2026-08-16).** Running the complete e2e suite once, then again immediately without a
  `db:reset`+`seed` in between, produced 11 failures on the second run (down from 1) — every one of
  them stale-seed-state noise, not real bugs (bookings/matches/etc. the first run had already advanced
  past their starting state). **Verify a fix with exactly ONE clean run against freshly reset+seeded
  data, never a second consecutive full run on the same stack.**
- ~~**PHASE 2's RLS SUITE AND STANDALONE PROBE SCRIPT BOTH SIGN IN AS `grace@demo.local` — AND
  PHASE 3's E2E SUITE DEPENDS ON HER NEVER HAVING SIGNED IN.**~~ **FIXED 2026-08-20, and it was NOT
  a flake — it broke CI deterministically, every run.** Grace is the seed's *only* scoped nail-salon
  manager grant (`packages/db/src/seed.ts`), so `rls.test.ts`'s phase-2 block needs her as a real
  signed-in user to prove a SCOPED `{role, scope_ref}` pair survives the write path — but
  `apps/web/e2e/platform.spec.ts`'s phase-3 engagement test picks her BECAUSE she's an active member
  "this whole e2e suite never signs in as," and asserts she reads "never signed in." A real password
  sign-in advances her `last_sign_in_at`, which phase 1's capture trigger faithfully records. **This
  looked like it might be environment-specific flakiness — it passed clean in two separate local
  reproductions before the real mechanism was found** — but `.github/workflows/ci.yml` runs
  `pnpm --filter @platform/db test` immediately before `pnpm test:e2e` on the SAME database with NO
  reset in between, so it is 100% deterministic in CI, not a flake at all: the GitHub Actions run for
  `d653d4d` failed on exactly this test, and reproducing CI's literal step order locally (reset →
  seed → db test → e2e, no reset) reproduced the failure on demand. **Fixed at the root**: the
  phase-2 describe block's own `afterAll` now deletes grace's `login_events`/`login_rollup` rows via
  a raw owner-level connection (both tables are read-only to every api role including the superadmin,
  so this can't go through the ordinary RLS client) — the suite that dirties her state now cleans it
  up itself, so no downstream test ever sees the pollution regardless of run order. Verified by
  reproducing the exact CI sequence locally post-fix: 139/139 db, then 51/51 e2e, no reset between.
  **`scripts/verify-activity-capture.mts` still signs in as grace with no equivalent cleanup** — it's
  a standalone script never run by CI, but running it by hand before e2e with no reset in between
  will still reintroduce this. A `db:reset`+`seed` before e2e fixes it same as it always did (a
  targeted `delete from login_events/login_rollup where user_id = <grace>` also works and is faster,
  but only fixes that one run — a full reset is what
  actually restores a clean baseline for everything downstream, including e2e's own well-known
  non-idempotence).
- **`Prefer: return=representation` on an INSERT makes PostgREST also SELECT the row back —
  which fails with a generic RLS 42501 if the table has no self-read policy, even though the
  INSERT itself would have succeeded (2026-08-21).** Manually proving activity-capture worked on
  prod via a raw `curl` insert (as a real demo user, mirroring `recordActivity()`) failed with
  "new row violates row-level security policy," reproduced even locally — which correctly pointed
  at "my request differs from the app's," not "prod is broken." `activity_events` (like
  `login_events`/`superadmin_lookup_log`) deliberately has NO `user_id = auth.uid()` self-read
  arm, superadmin-only by design (§7.1's rank-0 trap) — so PostgREST's implicit post-insert SELECT
  has nothing to read and the whole request reports as an RLS failure. The real `recordActivity()`
  helper never chains `.select()` / requests representation, so it was never at risk; the bug was
  in the manual test, not the migration. **When hand-verifying an insert-only, no-self-read table
  via `curl`/PostgREST directly: omit `Prefer: return=representation`, or the false negative will
  send you hunting a schema bug that isn't there.** **The same mechanism, same false negative,
  shows up in raw SQL too, not just PostgREST** — this is how the true cause was actually found:
  a diagnostic `insert into activity_events (...) values (...) returning *` via a raw
  `postgres.js` connection (simulating the caller's session with `set local role authenticated`
  + `request.jwt.claims`) hit the identical 42501, for the identical reason — `RETURNING`
  requires the same SELECT-policy check as reading the row back afterward, regardless of whether
  the read-back is requested via PostgREST's `Prefer` header or SQL's own `RETURNING` clause.
  Dropping `RETURNING *` (or `RETURNING` any column) from a raw-SQL insert probe on a
  no-self-read table fixes the false negative exactly like dropping the `Prefer` header does over
  HTTP — same root cause, two different surfaces.**
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
- **ASK CHOICES AS CONCRETE SCENARIOS, NOT AS ABSTRACTIONS (founder, 2026-08-11, after sending
  the same question back twice).** His words: *"This too is not clear what you are asking. Say I
  am asking if we should do A or B. Here is the scenario and if we do A then xyz, if we do B then
  ghj etc."* An `AskUserQuestion` option like "keep one bucket / split the buckets" is unanswerable
  — it asks him to hold the consequences in his head. What works: name a real situation with real
  seed users, then state what actually happens under each choice ("Charlie files a report March
  8th and never returns. Under A he reads as lapsed and gets a come-back email. Under B you see
  `report.filed` and don't send it, but the report's existence is now in a table you browse in
  bulk"). **Corollary that also came from that exchange: when he asks a question back rather than
  answering — "how would you define staff vs members?" — go and MEASURE the answer** (that one was
  settled by reading `docs/rank-admission-map.md` and finding rank cannot express it at all),
  rather than restating the question more carefully.
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
