# Build Plan

Strategy (docs/00 principle 1): build real modules first, extract the platform from what they share. Order decided 2026-07-06.

## M0 — Foundation skeleton (deliberately thin)

Repo scaffold (pnpm+Turborepo monorepo, TypeScript, lint/format), Supabase local + cloud project, Drizzle + first migration, auth (login/signup/magic link), core tables (orgs, org_members, org_modules, module_roles), app shell (nav shows enabled modules), platform-owner console (create org, toggle entitlements), seed script, CI (typecheck/test/migrate/deploy), Vercel deployment, Sentry + UptimeRobot.

**Acceptance:** founder logs into prod; creates test org; enables a stub module; a second user in another org can't see any of it (RLS verified by test); a PR runs green CI and auto-deploys.

**Explicitly excluded:** dashboard builders, ingestion frameworks, any primitive no module needs yet.

## M1 — Module 3: Synagogue Schedules (first real module)

Why first: smallest scope, live demand (replaces founder's current Sheets solution), and it forces org multi-tenancy, public pages, the API connector + cache (myzmanim, hebcal), the settings primitive, the worker + render pipeline, and i18n/RTL.

**Acceptance:** one real synagogue configured end-to-end; a maker generates a week's schedules; "Export" produces all enabled presets correctly; the public page serves congregants with no login; results match the founder's existing Sheets output for the same week.

## M2 — Module 2: Classroom (second real module)

Why second: the founder's most mature existing solution, and it forces files/storage, workflow state machines, visibility windows + retention, approval-adjacent flows, the gradebook, code rendering with line comments, the Google connector (roster sync, Drive video embeds), notifications, and surveys.

**Acceptance:** a full simulated course cycle in staging with seeded students: publish materials on a schedule → students submit multi-file homework → GA grades by subproblem → peer review round-trips with the assignment matrix → gradebook computes `0.2*peer+0.8*GA`-style combination → student sees only Final when flipped visible → retention sweep hides submissions.

## Extraction pass (after M2)

The platform-defining milestone: factor everything modules 2 and 3 share into `packages/platform`, refactor both modules onto the shared primitives, write/finalize docs/03 conventions against reality, designate `modules/synagogue-schedules` the canonical exemplar, and update CLAUDE.md. **Acceptance:** both modules pass their e2e suites on shared primitives; a written checklist proves a new module needs no code outside its own folder + platform extensions.

## M3 — Module 1: Make-a-Match

First module built "the fast way" against stable conventions — this validates the whole model. Forces: question engine, pair scoring with the stale-row worker pattern, approval queues, conversations, dealbreaker/lock settings. **Acceptance:** built in days-not-weeks (if not, fix the conventions, that's the real deliverable); full flow singles→questions→scores→mutual agreement→introduction works with seeded data.

## M4 — Module 5: Nail Salon

Forces: scheduling/availability, appointment state machine, billing/receipts, ledger/expenses, day-view live board. Reuses: roles ladder, settings+locks, workflows, notifications.

## M5 — Module 4: Visual Messaging

Forces: canvas stack (Konva), vector layer storage, tree navigation, thumbnails, moderation (tombstones), PWA gestures. Deliberately after the platform is stable — its effort is frontend-deep, platform-shallow.

## M6 — Module 6: Speed Dating

Last on purpose: leans on module 1's primitives (questions, matches, orgs) plus the two heaviest new pieces — Jitsi video (provider interface, VPS) and the Socket.IO orchestration engine. **Acceptance:** a seeded 7v7 test event runs end-to-end locally against docker-jitsi with simulated clients; organizer console controls a live event; mutual-interest reveal honors privacy rules.

## Cross-cutting, throughout

- Every milestone updates docs + CLAUDE.md (stale docs are bugs).
- Backups verified by actually restoring (docs/05) before any real client data exists.
- Google Sheets connector matured opportunistically (M2 roster sync first, general import later) — it's the client-migration on-ramp.
