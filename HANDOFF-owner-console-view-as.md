# HANDOFF — Owner Console view-as (in flight, 2026-08-06)

**DELETE THIS FILE when the work ships and the real docs are written.** It exists
only so a chat can be lost without losing anything. It is a working note, not a
decision record — the durable homes are the code/migration comments now, and
docs/15 + docs/03 + the journal at the docs beat.

Deliberately left UNTRACKED by git so `git diff --staged` is exactly the work
under review and a reviewer is not anchored by this note.

---

## Where the work is

**Built and staged, not committed, NOT pushed.** Do not push to `master` until the
verification beats below are done — `deploy` runs on master pushes.

CLAUDE.md "Next" item 4. Read `git diff --staged` for the whole change. Start
with the header of `apps/web/lib/console-view-as.ts` — the design, what is
bypassed, and the logging decision are all there.

| File | What it is |
|---|---|
| `apps/web/lib/console-view-as.ts` | NEW. Mode model, refusals, pair grid, the logging decision |
| `apps/web/app/(app)/console/view-as/page.tsx` | NEW. The screen |
| `apps/web/lib/view-as.ts` | `RenderAuthority` union; scope-error + `blinded`; per-section `personFilter` |
| `packages/platform/src/view-as.ts` | `surfaceIsPersonFilterable()` shared with `viewAsCompleteness()` |
| `apps/web/components/view-as/section-table.tsx` | Extracted from the in-module page, + the `not-narrowed` badge |
| `apps/web/components/view-as/off-surface.tsx` | Extracted; renders all THREE off-surface lists |
| `apps/web/components/view-as/page.tsx` | Uses the extracted components + names its authority |
| `apps/web/app/(app)/console/page.tsx` | Nav link |
| `supabase/migrations/20260806010000_sal_locations_superadmin_read.sql` | One policy. Header explains why it is required |

## Design, in three lines

Three founder-specified modes are modelled as **one axis, not three code paths**:
the mode picks the PERSON axis only (me / one named holder / nobody), and scope is
an independent picker in every mode. That is docs/15's "position + optional person
+ optional scope" literally. Superadmin authority bypasses exactly three things —
the declared edge, the rank/scope-coverage conditions, and §8.1 point 10's
caller-scope intersection — and nothing else. Never RLS, never the surface
declaration.

## Verification done

- `pnpm typecheck` 9/9; `pnpm build` clean with `/console/view-as` registered.
- Migration applied from a clean `db:reset` + `pnpm seed`; policy confirmed live as
  `(is_org_member(org_id) OR is_superadmin())`.
- Migration premise measured: `sal_locations` was **0 rows to the superadmin / 1 to
  service_role** before, **1/1** after, and every scoped salon section then returns
  its full row set. Non-emptiness control included, per the vacuity rule.
- CI's destructive-migration guard: clean (`drop policy` is not matched).
- No test asserts the old policy expression; all existing uses are as `alice`, an
  org member, unaffected by adding a disjunct.

## ADVERSARIAL REVIEW FINDINGS (2026-08-06) — beat 1 DONE

Four parallel subagents, one per claim cluster. **Provenance caveat: requested as
Fable, model UNVERIFIED** — the subagent transcripts are 0 bytes on disk, the session
log records only the request, and the harness's injected "you are model X" string is
demonstrably unreliable (it was stale in the orchestrator's own context during this
very session). Treat as "Fable-requested, unverified", not as a Fable review.

**No ship-blocker inside the diff.** Claims 1, 4, 7 survived; 2 and 3 broke; 5 survives
today but is narrower than it reads; 6's deferral is defensible with one reasoning error.

Ranked for the apply beat:

1. **`cls_review_comments` over-shows — LIVE DEFECT, OUTSIDE THIS DIFF.** Classroom
   declares it `subjectColumn: null` while the comment above that field says the rows
   are about the student as reviewee. No hop-filter, no embed, no exclusion — so any
   student's tab shows EVERY student's peer-review comments, badged "not-per-person"
   like a class-wide announcement. This is the anti-pattern docs/03 #18 bans by name,
   in a feature shipped 2026-07-31. Invisible to every test: zero seed rows. Own fix +
   fixture, not part of this build.
   **SEVERITY, PINNED DOWN 2026-08-06 — it is a FALSE CLAIM, not a leak.** The live
   student UI is CORRECT: `modules/classroom/ui/**` goes through
   `cls_comments_for_my_submission()`, verified live as
   `join cls_submissions s ... where s.student_id = auth.uid()`. Only the VIEW-AS
   surface reads the raw table. And a professor already reads every comment in their
   course under their own RLS, so no data crosses a boundary — what breaks is the
   tab's claim to show what the STUDENT sees. That is the docs/15 "a false claim the
   next reader trusts" category: serious, but do not treat it as a tenancy incident.
   **Prescribed fix** (docs/03 #18 gives the menu, and the 2026-08-02 founder decision
   — student sees the COMMENTS on their own homework, never the peer GRADES — picks
   from it): mirror the function's filter, i.e. embed under `cls_submissions` keyed on
   `student_id`. Not `excluded` — the student genuinely is meant to see their own.
2. **`RenderAuthority` gates SPECIFICATION, not CONSTRUCTION.** `{ kind:
   'platform-superadmin' }` is a bare structurally-typed literal. The mandatory `kind`
   closes the ACCIDENTAL bypass (a defaulting boolean) but naming a gate is not passing
   one — any future action or script can type that literal and call `renderSurface`
   without `requireSuperadmin()`, and it type-checks. docs/13 asked for a union no
   caller can invoke without naming the gate it passed. Fix: a factory that can only
   mint the value from a superadmin-checked input, not an exported bare type.
3. **The source-scan probe never sees the new files.** `verify-data-browser.mts` probe
   [6] hardcodes three data-browser paths. The "no `.rpc()`, no service-role" invariant
   is the whole reason the UI gate is sound, and for these five files it currently rests
   on manual tracing only. Mirror into `rls.test.ts` too — `scripts/*.mts` are not CI.
4. **Fourth bypass: `org_modules.enabled` — FOUNDER-DECIDED 2026-08-06, BUILD IT.**
   `browsableModuleKeys` deliberately omits the filter (data-browser.ts:274-286,
   reasoned 2026-08-03); `requireOrgModule` 404s on it (module-gate.ts:33). A disabled
   module still renders fully in the console.
   **Mechanism, established live 2026-08-06 (all CONFIRMED, do not re-derive):**
   `org_modules(org_id, module_key, enabled bool default true, settings jsonb)`, core
   migration `20260706120000`. `enabled` has exactly ONE write path in the app —
   `toggleModule()` at `console/actions.ts:64-73`, `requireSuperadmin()`-gated — plus
   the seed. Org admins are deliberately locked out by the `org_modules_pin_enablement`
   trigger (`20260712030000`), because RLS can allow an UPDATE on a row but cannot
   protect one COLUMN of it; enablement is a platform-owner business call (docs/03).
   **ZERO RLS policies anywhere reference `org_modules`** — queried `pg_policies` for
   `qual`/`with_check` mentioning it, empty. So `enabled` is a ROUTING gate only; the
   data is fully intact and the superadmin's RLS reach is identical either way.
   Disabling is deliberately STEP ONE of docs/03's deprecation sequence (disable →
   export on request → mark deprecated → remove code), i.e. it happens BEFORE anyone
   has exported anything. **All 8 seed modules are `enabled=true`, so NOTHING in the
   test suite exercises the disabled path — a third vacuity trap, needs a fixture.**
   **DECISION: render the disabled module, but BADGE it** ("this module is disabled for
   this org; no holder can currently open these tabs"). Rationale: suppressing it would
   lose the deprecation-time value that made the data browser's choice right — the
   moment you most need to know what a manager could see is when deciding what to
   export before deleting. But rendering it unbadged is a false claim, since a position
   in a disabled module sees NOTHING (its tabs 404). Badging matches the honesty
   pattern already used for not-narrowed and blinded. Costs one boolean
   `browsableModuleKeys` already SELECTs and currently discards. Also fix the "exactly
   three things and nothing else" comment, which is false as written either way.
5. **The mode-3 badge is SCOPE-BLIND.** `personFilter` is a pure function of
   `subjectColumn !== null`, so it says nothing about the scope axis. Salon `manager`
   and `cashier` are location-narrowed and declare `subjectColumn: null` on every table
   — so in mode 3 with scope "all", every location's data combines and NO section can
   ever be badged. The UI copy "affected sections say so" is false 100% of the time for
   those two positions.
6. **`blinded` checks ONE table per module** (the `scopeEntity`), never recomputed per
   role table. A future migration dropping an admin arm on an ordinary role table gives
   a silent, error-free, unbadged empty section. The migration in this diff is proof the
   category already bit once — caught only because it hit the scope-entity table, which
   has a loud symptom.
7. **Reasoning error in the log header.** "A superadmin row in `view_as_sessions` fails
   closed ONLY because `sessionStillAuthorised()` re-checks" is an overstatement: the
   `view_as_guard_session()` BEFORE INSERT trigger rejects it outright, since a
   superadmin holds no `module_roles` row and the `exists` can never match. Both
   conclusions true; the stated mechanism is the wrong one. Do not repeat it in the
   eventual migration header.
8. **Log follow-on, two things to settle BEFORE building.** The feared failure does NOT
   bite: an RLS-gated `insert ... with check (actor_user_id = auth.uid() and
   is_superadmin())` needs no `.rpc()` and no service-role, so the data browser's
   soundness argument survives. But (a) the page is a bare GET with querystring state —
   decide "log every render" vs "log once per explicit action", or reloads and Link
   prefetches mint phantom rows; wire it at the `ConsoleViewAsPage` call site, NEVER
   into the shared `renderSurface`; and (b) the new table immediately fails
   `data-browser-coverage.test.ts` until it is declared.

**Survived, with evidence:** claim 1 (no `.rpc()`/service-role anywhere on the path;
non-superadmin gets a bare 404 leaking no metadata); claim 4 (premise true across all 11
sibling tables via live policy trace, non-superadmin read sets byte-identical, RLS fails
CLOSED if the drop/create ever split); claim 7 (identical call sites, no drift possible —
but the predicate's surface-level coarseness is exactly what lets finding 1 through).

**Correction to "Verification done" below:** line "nothing in this build changes when the
log lands" is nearly right — additive is correct — EXCEPT the badge text, and
`RenderAuthority` if logging is wired into the shared renderer rather than the page.

**Findings 1 and 5 are UNPROVABLE ON THE CURRENT SEED** (zero rows / one location). This
sharpens beat 3 below: fixtures first, or both pass on an empty universe.

## REMAINING BEATS (docs/03 #12 order) — beats 1 and the FIXTURES are DONE

1. ~~**Adversarial review — Fable.**~~ **DONE 2026-08-06** — findings above.
   (Requested as Fable; model unverified — see the caveat in the findings header.)
1b. ~~**Build fixtures.**~~ **DONE 2026-08-06, commit `7baaeaa`** — all three
   vacuity traps closed, 183 tests green, RLS 90/90. Full inventory of what you
   inherit is in the FIXTURES section below. **E2E has NOT been run.**
2. **Apply findings** (Opus). Items 2/3/4/5 are in-diff; item 1 is a separate live
   defect in shipped classroom code; items 6-8 are notes and the log follow-on.
3. **Run the e2e suite FIRST** (it has not been run since the fixtures landed —
   expect possible fallout from the second salon location and the disabled
   `visual-messaging` row), then **live-verify in a browser as the real superadmin**
   (`owner@demo.local` / `password123`) and as **`grace@demo.local`**, the
   Uptown-scoped manager who exists specifically for the mode-3 headline case.
4. **RLS tests + `scripts/verify-console-view-as.mts`.** Must include a
   **source-scan probe for `.rpc()` and service-role on this path** — copy
   `verify-data-browser.mts` probe [6]. That invariant is the whole reason the UI
   gate is sound, and `scripts/*.mts` are NOT run by CI, so anything stated as fact
   to an operator belongs in `rls.test.ts` too (docs/03 #19's own lesson).
5. **Raise `tests-floor.json`** (both counters).
6. **Docs:** docs/15 decision entry, docs/03 #18 additions, journal, CLAUDE.md
   Now/Next, docs/12 if the log lands on the pre-launch checklist. Then delete this
   file.

## FIXTURES ARE DONE (2026-08-06, commit `7baaeaa`) — the traps below are CLOSED

The three vacuity traps are seeded and the suites are green. **What you inherit:**

- **Salon has TWO locations now**: Downtown (full demo) + **Uptown** (deliberately
  sparse — service/promotion/expense/shopping-list only, NO appointment, bill,
  worker profile or customer, so no e2e flow changed). Row counts DIFFER between
  them on purpose, so a scope filter that silently does nothing shows as a wrong
  number rather than an identical one.
- **`grace@demo.local` / `password123` — a manager SCOPED to Uptown.** alice stays
  ORG-WIDE, so "same position, different reach" is finally observable. Grace is the
  login for the mode-3 headline case ("the Uptown manager's back office").
- **Classroom peer review has real rows**: `cls_review_assignments`,
  `cls_review_comments` (**CROSS-AUTHORED** — charlie comments on dana's submission
  and vice versa, which is the only shape that makes the finding-1 leak detectable;
  with comments on one submission a broken filter looks identical to a working one),
  `cls_grades` (peer + instructor, per the 2026-08-02 split), `cls_survey_answers`.
  **STILL EMPTY: `cls_exam_papers`** — it needs a `cls_exams` parent that nothing
  seeds. Left open deliberately; the GA/student exam section stays unfalsifiable.
- **A DISABLED entitlement exists**: `visual-messaging` on the salon org, so the
  new badge is testable.
- **One test needed fixing and was fixed**: the worker-availability RPC test did
  `.eq('org_id', …).single()` on `sal_locations` and got null once Uptown existed.
  Now derives the location from the time-off row. Other `sal_locations` call sites
  were checked and are safe (they build their own fixtures or use
  `.order('created_at').limit(1)`, which still picks Downtown).

**Verified:** typecheck 9/9; all five test packages green — 183 tests, **RLS still
90/90**. **E2E NOT RUN YET — that is your first job.** Expect possible fallout in
salon e2e (a second location may change day-board/booking copy or counts) and in any
test that counts the salon org's module cards, since the disabled `visual-messaging`
row now exists.

**NEW HOST GOTCHA, belongs in CLAUDE.md at the docs beat:** `pnpm test` OOMs on this
Windows host under turbo's 5-way parallelism (`FATAL ERROR: Committing semi space
failed`, at absurdly small heaps, ~6.9GB free). It is NOT the documented
`node-compile-cache` corruption — clearing that did not help. **`pnpm exec turbo run
test --concurrency=1` is clean.** Do not read a parallel-run failure as a real one.

## THE ORIGINAL TWO VACUITY TRAPS — kept for context, now CLOSED (see above)

Measured this session on a clean seed:

1. **nail-salon has exactly ONE scope node.** So the scope-narrowing path — the
   headline mode, the Uptown-manager case — cannot be exercised at all. A test
   written against the clean seed would pass proving nothing.
2. **Five classroom surface tables have ZERO rows**: `cls_grades`,
   `cls_review_comments`, `cls_review_assignments`, `cls_exam_papers`,
   `cls_survey_answers`. So the student and GA surfaces render largely blank — which
   is **indistinguishable from the exact failure the migration just fixed**.

## Empirical facts found this session (all already in code comments, listed so
## they are not re-derived)

- `is_org_admin()` short-circuits on `is_superadmin()`; **`is_org_member()` does
  NOT.** That single asymmetry decides everything about superadmin reach: every
  policy arm routed through `is_org_admin` passes, every arm routed through
  `is_org_member` fails.
- The superadmin (`owner@demo.local`) is a member of **no org** and holds **no
  module grants**.
- `sal_locations` was the ONLY table in the whole schema where service_role sees
  rows and the superadmin sees zero with no error. Root cause in the migration
  header (a `for all` policy's USING also covers SELECT; splitting it per-command
  removed an inherited read arm).
- `scope_node_id` is **NULLABLE with `on delete set null`** on all four scopeEntity
  tables — so `.in(nodeColumn, ids)` silently drops such rows. Handled for the
  superadmin whole-module path; the ordinary path keeps the enumeration
  deliberately (RLS agrees — `module_caller_covers_rank` refuses a null node).
- `sal_earnings_ledger` IS readable by the superadmin (its
  `sal_can_manage_location` arm routes to `is_org_admin`).
- Unrelated, not on any surface: `syn_zmanim_cache` has no `authenticated` grant
  at all → hard `permission denied`. An error, not a silent lie. Not chased.

## SETTLED — the log decision (founder, 2026-08-06). No open decisions remain.

**THE LOG GETS BUILT**, as a follow-on. This build still ships UNLOGGED and its
on-screen badge is accurate; the log is purely additive, so nothing in this build
changes when it lands. Full reasoning + the corrected ground 1 are in
`lib/console-view-as.ts`'s header.

**Spec for the follow-on (Opus, ~2h + its own review — it is a new table with RLS
and grants, so the docs/03 #12 rhythm applies in full):**

- **A NEW table, not `view_as_sessions`.** Founder asked directly whether a separate
  table was still needed once hierarchy reads make the disclosure objection moot.
  It is moot — but three reasons stand, the first decisive: (1) it is a DIFFERENT
  EVENT, since the log covers both console tools and the data browser has no
  session / target_role / scope_ref / expiry; (2) a `view_as_sessions` row IS a
  capability, so mixing non-capability rows in makes safety depend on a downstream
  re-check instead of on the row not existing; (3) narrowing
  `view_as_sessions_select_org_admin` is its own migration that removes tenant
  reach and hits "org admin has no rank".
- **Shape:** roughly `(actor_user_id, tool, org_id, module_key?, subject_user_id?,
  position?, scope_ref?, created_at)`. `tool` distinguishes view-as from the data
  browser.
- **Written by BOTH Owner Console tools** — this one and `/console/data-browser`.
  Logging only the narrower tool is the incoherent option, since the data browser
  is `select *` over every row naming a person.
- **Visibility: the APPOINTMENT rule** (strict rank + scope coverage), NOT view-as's
  per-pair declaration. A log row is metadata with no surface and no third-party
  secret, so per-pair entries would be ceremony with no decision behind them. "If
  you can remove someone, you can review what they did" is one rule, needs no
  declarations, derives for every module including those with no view-as review,
  and brings scope narrowing along for free. Superadmin rows are therefore
  superadmin-readable only.
- **Append-only by GRANTS, never a trigger** — `on delete set null` fires BEFORE
  UPDATE triggers, which would make every referenced user/node/org undeletable
  (docs/03 #18; the mistake `view_as_sessions` already corrected). And name
  `service_role` in the revoke: prod's default privileges hand it the wipe
  privilege otherwise, which for an audit log is the one thing that must not happen
  (the `20260802010000` lesson).
- **The trap:** a log row names TWO people. Hierarchy answers who may read by
  ACTOR (oversight). Reading by TARGET — "a manager viewed your account" — is
  §8.1 point 6's notify-the-target question, still deliberately open. One table,
  two features; a single policy must not try to be both.
- **Goes on the Next list AND docs/12's pre-launch checklist.** Note the one real
  cost of the delay: a log started later can never cover the period before it
  existed, so it must exist before the first paying customer.

**Also now on the record, and separate:** the governing principle is that
hierarchy-governed visibility should apply to EVERY activity log on the platform.
That implies a second, independent question — should `view_as_sessions`' own
whole-org admin read be narrowed the same way? Same principle, own migration, own
review. This is docs/13's parked question, now with a principle attached.

## SEPARATE follow-on the same conversation produced (not part of this build)

Founder asked how many hierarchies exist and whether they are unified. Answer:
**one rank table (`module_position_rank`), read by four different rules** —
appointment (strict `>`), view-as pair DOMAIN (strict `>`), RLS tier thresholds
(`rank >= N`), and nothing at all for log reads. Plus two things that are not rank:
view-as edges (hand-declared per pair — this MUST stay separate, §8.1 point 11:
rank is cheap to change, view-as must never change silently) and name-based
`has_module_role()` checks in never-rank-mapped modules (`vm_can_moderate_org` is
the live example).

**The real gap found:** tier thresholds are magic numbers scattered across
per-module wrappers, and **nothing verifies that a rank remap did not silently
change what a tier wrapper admits.** Promote nail-salon `cashier` from 1 to 2 and
it silently gains the earnings ledger — the module's key documented asymmetry.
Today that case is caught only BY ACCIDENT (manager/cashier becoming equal rank
breaks their view-as pair entry and fails typecheck); remap a position with no pair
entries and nothing catches it. Verified for salon and classroom only, not all
eight modules.

This is docs/13's parked *"Generalising per-position visibility — a documented map,
NOT generated RLS"* entry, which is flagged there as the highest-value follow-on.
Two pieces: an audit producing one table of every rank use across all modules, and
a test that fails when a rank remap changes what a tier wrapper admits.

## Model guidance for the beats

Fable for the adversarial review only. Opus for applying findings, the RLS tests
and any migration. Sonnet is fine for the docs beat and for fixtures/e2e once the
mechanism is settled.
