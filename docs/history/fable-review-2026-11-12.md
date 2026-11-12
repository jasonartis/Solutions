# Fable re-review of the "Fable-requested but unverified" items — 2026-11-12

**Why this exists.** Between 2026-07-20 (Fable credits ran out) and 2026-11-12, eleven security
reviews were *requested* at Fable tier but were served by a subagent whose model could not be
verified, by a session silently reseated to Sonnet, or never ran at all (CLAUDE.md "Model choice";
memory `fable-via-subagent-and-model-provenance`). On 2026-11-12 the founder set the main session to
Fable (`/model fable`, confirmed by the harness) and asked for all of them to be re-reviewed. Each
review ran as a **fork of that Fable session** (a fork always runs on the parent's model), one
artifact and one question per reviewer, word-capped, read-only, rolled-back local probes only.
Load-bearing findings were re-run by the orchestrator before being written here.

**Provenance, stated honestly:** the main session's model is what the harness reported after
`/model fable`; the forks' requests were sent to `claude-fable-5-1` (the 429 errors below name
that model id, which is the strongest evidence this repo has had). Verification catches false
positives, not silence.

## Status

| # | Item | Artifact | Original review | Fable 2026-11-12 | Verdict |
|---|---|---|---|---|---|
| 1 | User-model slice 5 view-as | `20260731010000_view_as_sessions.sql`, docs/15 §8.1 | 2026-07-30 "Fable-tier" subagent | DONE | **HOLDS** — 2 LOW, by design |
| 2 | Per-person data browser | `packages/platform/src/data-browser*.ts`, `apps/web/lib/data-browser.ts` | 2026-08-03 two "Fable" subagents | DONE | **HOLDS** — 4 LOW (stale comments, a lookup gap) |
| 3 | Owner Console view-as | `20260806010000`, `apps/web/app/(app)/console/view-as` | 2026-08-06 four "Fable" subagents, picker refused | DONE | **HOLDS** — 2 LOW (stale invariant, missing negative e2e) |
| 4 | Superadmin lookup log | `20260807010000_superadmin_lookup_log.sql` | 2026-08-07 unverified | DONE | **HOLDS** — 2 LOW (stale comment, verifier structure-only) |
| 5 | Login capture (phase 1) | `20260809010000_login_events.sql` | 2026-08-09 claimed-Fable; 08-16 `model: fable` | DONE | **HOLDS** — zero defects |
| 6 | Activity events (phase 2) | `20260810010000_activity_events.sql` | 2026-08-11 Fable subagent, unverified | DONE | **1 MEDIUM** (rollup amplification NOT closed) + 8 holds |
| 7 | Email definers / profiles public | `20260917010000`, `20260917020000`, docs/22 §13–14 | 2026-09-16 Fable-requested, orchestrator re-measured | **PAUSED** (5-hour limit) | — |
| 8 | Rank map, three modules | `20260925030000_rank_map_three_modules.sql`, docs/24 | NEVER reviewed (Sonnet design after reseat; Opus build) | **PAUSED** | — |
| 9 | Pending invites slice 1 (org) | `20261016010000_pending_invites_org.sql`, docs/25 §11 | 2026-10-15 "two narrow Fable reviewers" | **PAUSED** | — |
| 10 | Pending invites slice 2 (chat + module role) | `20261018020000_pending_invites_chat.sql`, docs/25 §12 | 2026-10-18 "two narrow Fable reviewers" | **PAUSED** | — |
| 11 | REAL view-as (design + draft code) | docs/13 "THE DESIGN", draft `20261116010000_real_view_as.sql` (uncommitted, another session's) | never — this is the review the design asked for | **PAUSED** | — |

**PAUSED = the reviewer hit the Fable 5-hour limit mid-run (resets 17:00 America/New_York,
2026-11-12); its work is saved and the orchestrating session (`solutions-platform-27`) can resume
each with one message.** If that session is gone, re-run each as a fresh narrow Fable fork with the
question in "Pending questions" below. Item 11's findings are to be APPENDED to docs/13 under
"THE DESIGN" as `### FABLE REVIEW (2026-11-12)` — that file only, unstaged — per the owning session
(`solutions-platform-90`), which will fold the fixes in and commit.

## Findings by item (completed reviews)

### 6. `activity_events` — MEDIUM, confirmed by the orchestrator

**The 2026-08-11 "unbounded rollup amplification" fix only reshaped the surface.** The CHECK
`activity_events_action_shape` (`20260810010000:384-386`) admits `^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`
up to 60 chars; `activity_rollup` is never pruned (`:886-890`; the pruner trims only the raw table).
`authenticated` holds INSERT on `activity_events` through PostgREST, and PostgREST accepts bulk
arrays, so one member can mint thousands of permanent rollup rows in ONE request.

Re-run by the orchestrator (rolled back, local): as `charlie@demo.local`, active member of demo-a,
`insert into activity_events (org_id, module_key, action) select <demo-a>, 'classroom',
'a.'||translate(md5(g::text),…) from generate_series(1,500)` → `INSERT 0 500`; `activity_rollup`
**27 → 527 rows, 544 kB**.

Blast radius: bloat of a superadmin-only table and noise in `/console/engagement` for the
attacker's own org only — the guard forces `user_id` to self and refuses any org the caller is not
an active member of (confirmed), so **no tenancy crossing**. Account deletion already deletes the
person's rollup rows (`20261007090000`, `20261109010000`).

Recommended close (keeps founder decision 1, "no migration to add an action"): in
`activity_event_guard`, refuse an INSERT whose `action` is not already in the caller's rollup for
that (user, org, module) once that rollup holds ≥ N distinct actions (N ≈ 64; the largest real
vocabulary is 13). Bounded cardinality per person, no vocabulary table. Migration + Opus tier; add
an N+1 probe to `scripts/prod-verify-activity-events.mts` (its `:260-263` only asserts the regex
exists, so it passes vacuously today) and to `rls.test.ts`.

Everything else held with controls: forged `user_id`/`actor_grants`/`actor_org_role`/`occurred_at`
are overwritten by the guard (`:618-619`, `:704-726`); org B refused for an A member (`:679`);
foreign `scope_ref` refused (`:688`); unknown module/odd action shape refused by CHECK; the tab-only
`dedupe_key` bug is fixed (`:663`); non-superadmin SELECT = 0 (control 2001 rows as owner);
UPDATE/DELETE = 42501; `dedupe_key` collisions can only reveal the caller's own rows.
`recordActivity` (`packages/platform/src/activity.ts:373-386`) sends `return=minimal` and swallows
23505, so no `return=representation` false negative (read, not run over HTTP).

### 5. `login_events` — holds, zero defects

Twelve probes as `supabase_auth_admin` in rolled-back transactions: capture fires (214→215); the
table renamed away → `WARNING 42P01`, `UPDATE 1` (sign-in survives, `:457-461`); a forced CHECK
violation → `WARNING 23514`, `UPDATE 1`; a held row lock → 54.7 ms, `WARNING 55P03`, `UPDATE 1`
(`lock_timeout=50ms` does what the header claims); signup with no `profiles` row yet → 1 event
(`handle_new_user` runs first); same-timestamp rewrite → no phantom row (`:476` WHEN clause);
`delete from auth.users` as GoTrue's role succeeds. Catalog: `capture_login` owner `postgres`,
definer, `search_path=public, lock_timeout=50ms`, EXECUTE owner-only (fires anyway — EXECUTE is
checked at CREATE TRIGGER); both tables `authenticated: SELECT` only, two `is_superadmin()` read
policies (control 253), api INSERT/UPDATE/DELETE and anon/service_role SELECT all 42501; a
non-superadmin reads 0/0 while the tables hold 1156/24.

Residual facts (not defects): (a) a future read-only-transaction mark reaching the AUTH connection
would make capture fail SILENTLY (`WHEN OTHERS`), detectable only by phase 3's honesty badge —
relevant to real view-as, whose `pgrst.db_pre_request` is set on `authenticator`, not on GoTrue's
role, so it does not apply today; (b) `query_canceled` still propagates, as the header says
(`:350-357`); (c) the pruner runs only in the worker (`apps/worker/src/jobs/login-events-prune.ts`),
so prod retention is not enforced — already documented.

### 4. `superadmin_lookup_log` — holds

Grants exactly as the file says (`:262-264`): authenticated INSERT+SELECT, service_role SELECT, anon
none. As grace (non-superadmin): SELECT 0 (control 104 as owner); INSERT refused by the guard
(`:303-305`). As owner: forged `actor_user_id`/`created_at` overwritten (`:286-287`); cross-tenant
`scope_ref` and wrong-module node both raise (`:322-329`); null org and bad shape refused; UPDATE /
DELETE / TRUNCATE / `on conflict do update` → 42501 (append-only at the grant layer); the only
trigger is BEFORE INSERT, so `ON DELETE SET NULL` is not blocked — deleting the subject user, the
org and the scope node all succeed and the 104 rows survive with nulled columns. Demoting the
superadmin closes the read (0 rows). `user_private.is_superadmin` is not writable by api roles.

LOW: `apps/web/lib/superadmin-log.ts:91-92` still says mode is derivable from the row; the
migration's own header (`:159-168`) says that derivation is unsound — fix the comment.
LOW: `scripts/prod-verify-superadmin-log.mts` is structure-only (every negative has a control, so
not vacuous) but has no rolled-back behaviour probe; copy the forged-actor INSERT and the
non-superadmin SELECT in, as `prod-verify-feedback.mts` does.
Observation: the app side is fail-open by decision (a failed log write still renders, with the red
"NOT recorded" badge) — a documented trade-off; the log is oversight of the UI path only.

### 3. Owner Console view-as — holds

Correction to the brief: docs/15 L971 and `lib/console-view-as.ts:10-27` already say the bypass is
FOUR things (edge; rank/coverage; caller-scope intersection; `org_modules.enabled`). The migration
creates no function and changes no ACL — only the `sal_locations` select policy
(`is_org_member(org_id) OR is_superadmin()`; control 35 `sal_` policies). `requireSuperadmin()`
(`lib/platform.ts:161-182`) 404s unless `rpc('is_superadmin')`; the page's only client is the
caller's RLS client. Behaviour: bob (demo-b only) reads 0 `sal_locations`, the superadmin reads 2
without being a member. `user_private.is_superadmin` UPDATE as bob → 42501; `is_superadmin()` has no
anon EXECUTE. Mode-3 "not narrowed" badge is tracked explicitly (`view-as.ts:502-514, 568, 713-717`),
not inferred from result shape. 0 policies reference `org_modules` (the fourth bypass's premise).

LOW: the "no `.rpc()` on the console path" invariant (`console-view-as.ts:51-52`,
`superadmin-log.ts:25`, verifier `:330`) is already false twice — `requireSuperadmin()` and
`data-browser.ts:372` (`superadmin_user_emails`) — and the verifier scans only four lib files, so it
passes vacuously. Both definers self-gate on `is_superadmin()` (bob → 0 rows), so nothing is lost;
restate the rule as an allow-list and widen the scan.
LOW: no e2e proves a non-superadmin gets 404 on `/console/view-as` (the only negative console test
is the data browser's `not.toBeVisible`, the vacuity shape).

### 2. Per-person data browser — holds

Every query runs on the cookie anon-key client (`apps/web/lib/supabase/server.ts:19-21`; no
service-role use under `apps/web`). The one `.rpc()`, `superadmin_user_emails`, is a definer whose
body has `where public.is_superadmin() and … deleted_at is null`, pinned search_path, no anon
EXECUTE. Coverage: all 86 person-ish uuid columns in `public` probed; every `auth.users` FK is in a
`lookups`/`omitted`/`neverReadable` list, and every declared `personColumns` entry really FKs
`auth.users`. `neverReadable` has a real CI fixture with a non-vacuity floor (`rls.test.ts:2484-2532`).
`account_signup_blocks`: 0 policies, grants only to postgres. `.or()` inputs are DB-returned uuids.

LOW (false claims): `apps/web/lib/data-browser.ts:4-6`, `packages/platform/src/data-browser.ts:26-30`
and `docs/03-adding-a-module.md:548` still say no code on this path may ever call `.rpc()`; only
`scripts/verify-data-browser.mts:331-348` was updated to the allow-list rule.
LOW: `via` child lookups are not org-filtered and cap at 100/200 across all orgs; a section that
truncates to zero rows is hidden by `!showEmpty`, so the truncation badge is never seen (needs >100
rows for one person — unrealistic today). Via-only tables with no children are absent from
`sections` entirely, so "show empty tables" cannot list them.
LOW–MED (design gap, not a leak): a subject is selectable ONLY from `org_members`; a person whose
seat is gone but whose module rows / `activity_events` / lookup-log rows remain cannot be looked up —
exactly when deletion/export is the reason to ask. Not documented anywhere (the walk-in salon gap is).

### 1. `view_as_sessions` (slice 5) — holds

Nothing in the database consumes a session row to open a read: 0 of 253 policies and 0 procs
reference `view_as_sessions` (control: 23 procs reference `module_roles`); the render is the caller's
own RLS client and the row only supplies `subjectUserId`/`targetScopeRef`, which can only narrow.
Guard bound and enabled (BEFORE INSERT). Fourteen probes as real users: forged actor/expiry
overwritten; GA→student, student→peer, non-member, scoped-as-global, cross-module, scoped
manager→global worker, cashier→worker, self — all refused with the right message; global
manager→worker OK; UPDATE/DELETE and anon INSERT → 42501; the target reads 0 rows about himself.
ACL: authenticated INSERT+SELECT, service_role SELECT (since `20260802010000`), anon nothing; guard
fn owner-only EXECUTE, definer, `search_path=public`; `module_view_as_edge` IMMUTABLE, no anon.

LOW: `module_scope_covers` is a definer with NO api-role EXECUTE, so the TS mirror
(`view-as.ts:95-112`) is the only thing the app can run — TS/SQL parity rests on the test suite.
LOW (by design, documented `view-as.ts:217-219`): a session row outlives a revoked grant for up to
30 min; `page.tsx:74-78` re-checks per render and the render is RLS-bounded anyway.
Probe file: scratchpad `va_probe3.sql` (session-local, not kept).

## Pending questions (for the five paused reviews — resume or re-run verbatim)

- **7 (email):** can any `authenticated`/`anon` caller learn another person's email or confirm an
  address has an account, through any definer the two migrations create (ACL incl. anon, authority
  check, error/row-count oracle, org argument widening), `has_column_privilege` on every
  email-bearing column, views over `profiles`/`auth.users`, `pg_publication_tables`, or any other
  `pg_proc` body referencing `auth.users`/`.email` executable by authenticated (with a count)?
- **8 (rank map):** list every function/policy calling `module_position_rank`,
  `module_caller_covers_rank`, `module_has_manager_grant` or comparing ranks; for each, what can a
  newly rank-1 `matchmaker`/`maker`/vm role do that rank 0 could not — the `module_roles` hierarchy
  guard, view-as edge admission, the census SELECT policy, speed-dating `rank >= N` wrappers (is
  `module_key` always passed?); and the `conversation_moderator` rename's handling of rows/CHECKs.
- **9 (invites, org):** account-existence oracle at issue; SELECT policy after demotion and
  row-disappearance; who/what invokes the claim (unconfirmed email? normalisation?); inviter re-check
  at claim; whether the cap is counted across orgs (a cross-tenant signal); pruner owner/grants.
- **10 (invites, chat):** does the accept-time module-role grant bypass `module_roles`' guard
  (fires? as whom? which `auth.uid()`); inviter re-check against CURRENT authority on that exact
  scope/role; can a stamped row be re-pointed; can one inviter read how many OTHER inviters exist
  (cap-only error); does a chat claim seat a non-ACTIVE member (ordering vs `20261015010000`).
- **11 (real view-as):** can a real view write, read beyond the data browser, or leak the token —
  attack all four write layers (`pgrst.db_pre_request` + `transaction_read_only` incl. RPC/storage/
  GraphQL and definer undo; RESTRICTIVE storage policies for all verbs/buckets; the proxy's non-GET
  403 vs server actions/RSC/`/view-as/stop`; the token's `exp`, never-to-browser, auth methods
  throwing, error/Sentry paths, GoTrue refresh), Q3's "classroom adds nothing beyond the data
  browser" against `data-browser-modules.ts`, `view_as_real_check` (caller, ownership, 30-min
  expiry), and a target who is or becomes superadmin mid-view. Code: `apps/web/lib/view-as-real.ts`,
  `apps/web/proxy.ts`, `apps/web/lib/supabase/server.ts`, `app/view-as/stop/route.ts`,
  `app/(app)/console/view-as/real/*`, `components/view-as-banner.tsx`,
  `packages/db/src/real-view-as.test.ts`. Side fact from review 2: the draft migration is applied
  by hand on the local DB and `view_as_real_sessions` is not yet declared in
  `data-browser-modules.ts`, so `data-browser-coverage.test.ts` fails there until it is.

## What to do with the completed six

Nothing ship-blocking. One migration-worthy fix (item 6, Opus tier, founder go-ahead) and a batch of
LOW doc/comment/verifier fixes (Sonnet tier, no migration) listed above. None was applied in this
session — it was review-only by design.
