# Build Plan

Strategy (docs/00 principle 1): build real modules first, extract the platform from what they share. Order decided 2026-07-06.

## M0 — Foundation skeleton (deliberately thin)

Repo scaffold (pnpm+Turborepo monorepo, TypeScript, lint/format), Supabase local + cloud project, Drizzle + first migration, auth (login/signup/magic link), core tables (orgs, org_members, org_modules, module_roles), app shell (nav shows enabled modules), platform-owner console (create org, toggle entitlements), seed script, CI (typecheck/test/migrate/deploy), Vercel deployment, Sentry + UptimeRobot.

Includes the **dev-script harness** (docs/01 dev-mode matrix): named start/stop commands for native/Docker/cloud-staging combinations, layered env loading with committed templates, strict env validation (`${VAR:?msg}` in compose), masked resolved-config echo, cloud-mode guard rails, `--dry-run`. Patterns from the prior-art review (docs/06) — building them into M0 is cheap; retrofitting isn't.

**Acceptance:** founder logs into prod; creates test org; enables a stub module; a second user in another org can't see any of it (RLS verified by test); a PR runs green CI and auto-deploys; every dev-mode command in the matrix starts and stops cleanly on the founder's Windows machine.

**Explicitly excluded:** dashboard builders, ingestion frameworks, any primitive no module needs yet.

**Status: DONE (2026-07-07).** Live in production at solutions-platform.vercel.app (Vercel + GitHub Actions, prod Supabase migrated); RLS isolation proven by test; CI green with e2e. Sentry/UptimeRobot are not yet wired (tracked as a founder action, docs/12).

## M1 — Module 3: Synagogue Schedules (first real module)

Why first: smallest scope, live demand (replaces founder's current Sheets solution), and it forces org multi-tenancy, public pages, the API connector + cache (myzmanim, hebcal), the settings primitive, the worker + render pipeline, and i18n/RTL.

**Acceptance:** one real synagogue configured end-to-end; a maker generates a week's schedules; "Export" produces all enabled presets correctly; the public page serves congregants with no login; results match the founder's existing Sheets output for the same week.

**Status: ACCEPTANCE PASSED (2026-07-07 night).** Pozna's real Shabbos schedule reproduced from real myzmanim values (49 module tests). Full rule grammar exposed in the maker UI; production configured for the real org `pozne`. Remaining: myzmanim live auth is parked (context in the module spec) since the export pipeline (worker) already renders correctly; prod exports run via `pnpm worker:prod` on the founder's PC pending the VPS (docs/10).

## M2 — Module 2: Classroom (second real module)

Why second: the founder's most mature existing solution, and it forces files/storage, workflow state machines, visibility windows + retention, approval-adjacent flows, the gradebook, code rendering with line comments, the Google connector (roster sync, Drive video embeds), notifications, and surveys.

**Acceptance:** a full simulated course cycle in staging with seeded students: publish materials on a schedule → students submit multi-file homework → GA grades by subproblem → peer review round-trips with the assignment matrix → gradebook computes `0.2*peer+0.8*GA`-style combination → student sees only Final when flipped visible → retention sweep hides submissions.

**Status (2026-07-09, later): core spec surface COMPLETE.** Beyond the 2026-07-09-morning core loop, subsequent slices shipped: exam grading (problem structure, per-subproblem scoring, published finals), per-class surveys with aggregate reveal, **automatic weighted gradebook combination** (GA+peer blend, renormalized, override-wins), and the retention sweep (daily worker job purging/hiding expired materials/publications per settings). Submission retention's founder decisions (never delete; hide from students+GAs after a per-class date; professor manual re-reveal) were also **implemented** the same window (`20260709080000_classroom_submission_retention.sql` — `cls_classes.submissions_hidden_from`, `cls_submissions.visible_override_until`, both wired to UI) — the module spec doc had gone stale claiming this was still an open item; corrected 2026-07-12. **Module 2 has no known remaining gaps against its own spec.** GA-specific dedicated views (vs. the shared grading console) remain a nice-to-have, not required — this is the only unbuilt item, and it's explicitly optional.

## Extraction pass (after M2)

The platform-defining milestone: factor everything modules 2 and 3 share into `packages/platform`, refactor both modules onto the shared primitives, write/finalize docs/03 conventions against reality, designate `modules/synagogue-schedules` the canonical exemplar, and update CLAUDE.md. **Acceptance:** both modules pass their e2e suites on shared primitives; a written checklist proves a new module needs no code outside its own folder + platform extensions.

**Status: DONE (2026-07-07), extended twice more (2026-07-09).** `is_org_admin()` + `DERIVED_SCOPE_PLACEHOLDER` + the new-module acceptance checklist landed in the first pass; a second pass added `module_can_manage()` (export-controls dispatcher) and further conventions (docs/03) as real modules kept proving them out. `modules/sample` (module 0) is the living template, annotated convention-by-convention, with its own seed + e2e.

## M3 — Module 1: Make-a-Match

First module built "the fast way" against stable conventions — this validates the whole model. Forces: question engine, pair scoring with the stale-row worker pattern, approval queues, conversations, dealbreaker/lock settings. **Acceptance:** built in days-not-weeks (if not, fix the conventions, that's the real deliverable); full flow singles→questions→scores→mutual agreement→introduction works with seeded data.

**Status (2026-07-10): usable end-to-end.** Full UI shipped on the live schema — single view (answer questions, see top-X matches, share-with-match reveal via the `mm_shared_answers` definer fn), matchmaker view, admin console (approval queue, question authoring, recompute). The `matchmaking.rescore` worker job now runs the same pure engine on a 30s tick, so recompute is automatic (the manual button is now just an instant-refresh convenience). Validated the "days-not-weeks" acceptance goal for the conventions. Group/assignment management UI shipped 2026-07-11. **Mutual-agreement→introduction shipped 2026-07-16** (`mm_interests` + `mm_mutual_matches()`/`mm_mutual_pairs()` definer fns, express/withdraw UI, "It's a match!" reveal, matchmaker/admin facilitation views — see the module spec for the open reveal-email-vs-matchmaker-only question). **Remaining:** only the conversations primitive for users→admin messaging (still doesn't exist platform-wide).

## M4 — Module 5: Nail Salon

Forces: scheduling/availability, appointment state machine, billing/receipts, ledger/expenses, day-view live board. Reuses: roles ladder, settings+locks, workflows, notifications.

**Status (2026-07-10): usable end-to-end.** Operational spine (day board, booking, billing with auto earnings-ledger feed), worker chair view, manager back office (revenue summary, service catalog, promotions, expense log, shopping-list→expense flow), and **customer self-booking** (book + cancel) all shipped. Reporting expanded 2026-07-11 (net profit, top services, expenses by category). **Per-worker availability windows shipped 2026-07-16** (weekly schedule + time-off editor, enforced at every booking entry point — see module spec). **Remaining:** assignment-algorithm + reminder workers (the latter needs a notification primitive no module has yet).

## M5 — Module 4: Visual Messaging

Forces: canvas stack (Konva), vector layer storage, tree navigation, thumbnails, moderation (tombstones), PWA gestures. Deliberately after the platform is stable — its effort is frontend-deep, platform-shallow.

**Status (2026-07-11): the most feature-complete module on the platform.** Core loop (conversations, drawing, reactions), the gesture layer (swipe navigation, sibling dots, zoomed-out tree view), a full moderation queue (flag/review/tombstone/restore/freeze), and deep-link joining (open/invite policy, viewer seats for org members) all shipped — plus the **spec's entire layer-content vocabulary**: freehand strokes, emoji stamps, styled text, and image stamps, all mixable in one reply. All of it built with **zero migrations** beyond the original 2026-07-09 schema (the security review anticipated image stamps' storage needs a session ahead of the UI). Remaining: per-org tunable size/opacity guards (fixed defaults today), org-per-group auto-creation for ad-hoc groups (awaiting founder confirmation), and anonymous public view-links (explicitly deferred as a future enhancement, not v1).

## M6 — Module 6: Speed Dating

Last on purpose: leans on module 1's primitives (questions, matches, orgs) plus the two heaviest new pieces — Jitsi video (provider interface, VPS) and the Socket.IO orchestration engine. **Acceptance:** a seeded 7v7 test event runs end-to-end locally against docker-jitsi with simulated clients; organizer console controls a live event; mutual-interest reveal honors privacy rules.

**Status (2026-07-09): event-runnable minus video.** Full UI (events, registration, lifecycle controls) plus the **real rotation engine + automatic round-clock worker** (two-sided/single-pool rotation, byes, block avoidance, no-repeat enforcement — 7 unit tests, 7 live clock assertions) replaced the manual organizer stand-in. Mutual-interest reveal honors privacy end-to-end (proven by e2e). Notes/reports/blocks UI shipped 2026-07-11. **Lobby/live-round UI shipped 2026-07-16** (live "who you're paired with now" + countdown, computed from `ends_at` since the schema's `'break'` state is never actually written — see module spec for a real bug caught and fixed in the manual round-advance action along the way). **Two-sided capacity + waitlist shipped 2026-07-16** (also revealed pool sides were never actually used anywhere in the app until this pass; capacity/labels + side selection + roster/promotion UI all work, but the capacity COUNT itself has a real RLS-invisible-read bug caught by e2e — needs an Opus session for a definer-function fix, see module spec). **Remaining:** Jitsi video (needs the VPS decision), resume-review profiles beyond the profile card, the waitlist capacity-count fix above.

## Cross-cutting, throughout

- Every milestone updates docs + CLAUDE.md (stale docs are bugs).
- Backups verified by actually restoring (docs/05) before any real client data exists.
- Google Sheets connector matured opportunistically (M2 roster sync first, general import later) — it's the client-migration on-ramp.
