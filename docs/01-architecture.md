# Architecture

## System overview

One multi-tenant web application + one background worker, sharing one Postgres database. Modules are packages inside a monorepo — **not** dynamically loaded plugins. Access control (entitlements) decides who sees which module; all code ships together.

```
                ┌─────────────────────────────────────────────┐
                │                  Postgres                    │
                │  (schema-per-module tables, RLS everywhere,  │
                │   pg-boss job queue, entitlements, orgs)     │
                └────────┬───────────────────────┬────────────┘
                         │                       │
              ┌──────────┴─────────┐   ┌─────────┴──────────┐
              │  Next.js app       │   │  Worker            │
              │  (UI + API routes, │   │  (pg-boss jobs:    │
              │  auth, public      │   │  match scoring,    │
              │  pages, PWA)       │   │  renders, syncs,   │
              └──────────┬─────────┘   │  emails, purges;   │
                         │             │  Socket.IO for M6) │
              ┌──────────┴─────────┐   └────────────────────┘
              │  Supabase services │
              │  Auth / Storage /  │        ┌───────────────┐
              │  Realtime          │        │ Jitsi VPS     │ (only when
              └────────────────────┘        │ (module 6)    │  module 6 ships)
                                            └───────────────┘
```

## Monorepo layout (pnpm workspaces + Turborepo)

```
/
├── apps/
│   ├── web/                  # Next.js (App Router) — all UI + API routes
│   └── worker/               # Node service: pg-boss consumers, cron, Socket.IO (M6)
├── packages/
│   ├── db/                   # Drizzle schema, migrations, seed scripts
│   ├── platform/             # Shared primitives (see catalog below)
│   └── ui/                   # Shared components (shadcn/ui based)
├── modules/
│   ├── matchmaking/          # each module: one package, strict anatomy (docs/03)
│   ├── classroom/
│   ├── synagogue-schedules/
│   ├── visual-messaging/
│   ├── nail-salon/
│   └── speed-dating/
├── docs/
├── supabase/                 # supabase CLI config, SQL policies
└── CLAUDE.md
```

A module package contains its DB schema (table-prefixed), API route handlers, React pages/components, worker jobs, settings schema, and a **manifest** (id, name, entitlement key, roles, nav entries, jobs). `apps/web` imports each module's manifest and mounts its routes/nav behind entitlement checks.

## Multi-tenancy and security

Core tables (in `packages/db`, owned by the platform, module tables reference them):

- `orgs` — every client organization (a synagogue, a salon, a class-running university dept, a family). Has settings JSON, optional branding.
- `locations` — child of org (module 5 needs it; costs nothing for others).
- `users` — one identity per person (Supabase Auth). A user can belong to many orgs.
- `org_members` — (org, user, platform_role). Platform roles: `owner`, `admin`, `member`.
- `org_modules` — entitlements: which module keys an org has enabled, with per-org module settings JSON.
- `module_roles` — (org, user, module_key, role) — module-specific roles (e.g., `matchmaker`, `ga`, `cashier`). Each module defines its role vocabulary in its manifest.

**Row-level security (RLS) rules — non-negotiable:**

1. Every module table carries `org_id` and has RLS policies scoping reads/writes to the caller's org membership + module role.
2. The web app talks to Postgres as the authenticated user (Supabase client with the user's JWT) so RLS applies automatically.
3. Only the worker uses the service-role key (bypasses RLS); worker jobs must always filter by org explicitly and are code-reviewed for it.
4. Public pages (module 3 viewers) read through views/policies that expose only rows explicitly marked public — never via service role in request handlers.
5. Cross-org queries exist only in platform-owner admin tooling, clearly separated.

**Platform-owner superadmin** (the founder) is a flag on `users`, checked server-side, granting the cross-org console: create orgs, toggle entitlements, impersonate-for-support (audit-logged).

## Platform primitives catalog

Extracted/expected shared services in `packages/platform`. Rule: modules never fork a primitive — they extend it upstream (see docs/03).

| Primitive | Description | First needed by |
|---|---|---|
| Orgs, users, roles, entitlements | See above | M0 foundation |
| Settings with admin locks | Typed settings objects, per-org and per-module, with per-field lock flags (admin-locked values users can't change) | Module 1 |
| Question/answer engine | Text question + up to 5 labeled scale points, answers, care weights, approval workflow | Modules 1, 6 |
| Workflow state machines | Typed states per entity, transition permissions, state-driven visibility | Modules 2, 5 |
| Visibility windows | `visible_from`/`visible_until` on any shareable item; hide vs purge retention policies | Module 2 |
| Notifications | In-app notification records + badge counts; email digests via worker | Modules 1, 2 |
| Conversations/messaging | Generic conversation container + messages (users→admin now; peer chat later without remodeling) | Module 1 |
| Files | Storage buckets per module, signed URLs, size limits, retention hooks | Module 2 |
| Approval queues | Submitted items + review/approve/tweak flow + notification | Module 1 |
| Audit log | Who did what when (moderation, overrides, refunds, impersonation) | Module 1 |
| Scheduling/availability | Calendars, slots, durations, working hours, time-off | Module 5 |
| External API connector + cache | Keyed fetch-and-cache (myzmanim, Google APIs), rate-limit aware | Module 3 |
| Export/render pipeline | HTML template → PDF/JPG via Playwright in worker; named render presets | Module 3 |
| Public pages | Unauthenticated org-scoped pages (`/s/<org-slug>/...`) | Module 3 |
| Job queue + cron | pg-boss: on-demand jobs, schedules, retries | Module 1 |
| Realtime | Supabase Realtime (DB-change subscriptions) for UI freshness; dedicated Socket.IO only for M6 orchestration | Modules 1, 6 |
| Email | Provider-abstracted send (templates, per-org sender name); Mailpit locally | Module 2 |
| Ledger/expenses | Earnings ledger, expense log, shopping lists | Module 5 |
| Video provider interface | create room / issue token / close room; Jitsi first implementation | Module 6 |
| i18n/RTL | Hebrew+English content fields, RTL rendering | Module 3 |
| Google connector | Sheets/Drive/Groups read via service account (roster sync, Drive video embeds, data migration) | Module 2 |

## Local development (Windows host)

Everything runs locally with full cloud parity:

| Concern | Local | Cloud |
|---|---|---|
| Postgres, Auth, Storage, Realtime | `supabase start` (Docker Desktop, WSL2 backend) | Supabase cloud project |
| Next.js app | `pnpm dev` | Vercel (Phase A/B) — see docs/05 |
| Worker | `pnpm dev` (runs alongside) | VPS (from Phase B) |
| Email | Mailpit container (catches all outbound mail, web UI) | Resend/SES |
| Jitsi | `jitsi/docker-jitsi-meet` compose (only when working on M6) | Jitsi VPS |
| Secrets | `.env.local` (git-ignored) | Host env vars / GitHub secrets |

Workflow: `supabase start` → `pnpm dev` → develop against local DB with seeded test orgs/users → `supabase db diff` generates migrations → commit → CI applies migrations to cloud and deploys. **Migrations are forward-only and always exercised locally first.** Seed scripts (`packages/db/seed`) create a demo org per module with realistic test data — this is also the AI-development substrate (an agent can always boot a working local world).

### Dev-mode matrix (pattern borrowed from dascher.base — see docs/06)

Each runnable piece can independently run **native**, **Docker**, or **cloud**, selected by named root scripts rather than manual env juggling. The dascher.base convention (per-service `scripts/` + parent scripts composing combinations) is adopted, but implemented as **cross-platform Node scripts** (`scripts/dev.ts` + pnpm scripts), not `.bat` files, and simplified by the monorepo (workspace filtering replaces parent/child repo orchestration).

| Command | Web | Worker | DB/Auth/Storage | Use case |
|---|---|---|---|---|
| `pnpm dev` (default) | native | native | local Docker (supabase) | day-to-day development |
| `pnpm dev:web` / `dev:worker` | one piece native | — | local Docker | focused work |
| `pnpm dev:cloud-db` | native | native | **staging** Supabase | reproduce cloud-only issues |
| `pnpm dev:docker` | Docker | Docker | local Docker | full-parity check before deploy |
| `pnpm stop` | stops everything incl. compose remnants (`down --remove-orphans`) | | | |

Conventions that make this safe (all lifted from dascher.base's scripts, kept; its committed secrets, dropped):

- **Layered env loading:** repo `.env` → app `.env` → mode-specific `.env.<mode>` (e.g. `.env.cloud-db`), each git-ignored with a committed `.env.example`/template.
- **Resolved-config echo:** every start script prints the effective endpoints/flags with secrets masked (`HASURA_ADMIN_SECRET=****** [set]` style) before starting.
- **Guard rails:** cloud modes refuse to start if a secret still holds a local default value, and refuse to point at production — cloud-db mode targets staging only. `--dry-run` prints what would run without running it.

## Batch processes (worker + pg-boss)

pg-boss stores its queue in Postgres — no Redis, no extra infrastructure. Job catalog (grows per module):

- `matchmaking.rescore` — recompute stale pair-score rows (continuous; see module 1 spec)
- `schedules.render` — generate export files for a synagogue/date (module 3)
- `classroom.roster-sync` — Google Group → roster reconciliation (module 2, cron)
- `classroom.peer-review-assign` — generate review matrix (module 2)
- `retention.sweep` — apply hide/purge visibility policies (cron, module 2)
- `email.send` — all outbound mail goes through the queue (retries, rate limits)
- `speeddating.event-orchestrator` — event state machine driver (module 6)
- `backup.dump` — scheduled pg_dump to storage (docs/05)

Rules: jobs are idempotent, org-scoped, and logged. Cron schedules live in code (worker startup), not in a dashboard.

**Job result contract** (behavioral spec borrowed from artispy's topic/resultId pattern — docs/06): enqueueing a job returns a job/result id immediately; the job writes its result/status to a row; the UI learns of completion via Supabase Realtime on that row (no polling). Long operations (schedule renders, match rescoring, review-matrix generation) all follow this shape so every module's "working…" UX is the same component.

## Live processes

- **UI freshness / notifications:** Supabase Realtime subscriptions on relevant tables (e.g., admin sees new question-to-approve appear). No custom socket infrastructure needed.
- **Module 6 event orchestration:** the one true realtime system — a Socket.IO namespace served by the worker, holding authoritative event state (round, clock, pairings) in Postgres with in-memory hot state; clients receive `round_started`/`break`/`pairing` events. Designed so it could split into its own service later; starts colocated in the worker.

## Storage

Supabase Storage (S3-compatible), one bucket per module + `platform-public` (org logos). All access via signed URLs with short expiry; public bucket only for genuinely public assets (module 3 exported schedules if the synagogue opts in). Upload limits enforced per module (manifest declares max sizes/types). Retention hooks connect to the visibility-window primitive (purge jobs).

## Data model conventions

- Table names prefixed per module: `mm_` (matchmaking), `cls_` (classroom), `syn_` (synagogue), `vm_` (visual messaging), `sal_` (salon), `sd_` (speed dating). Platform tables unprefixed.
- Every table: `id` (uuid), `org_id`, `created_at`, `updated_at`. Soft-delete (`deleted_at`) only where a spec demands it (tombstones); otherwise hard delete + audit log entry.
- Money as integer cents. Times as `timestamptz` (UTC); wall-clock scheduling concepts (module 3/5) store the org's IANA timezone and compute explicitly.
- JSON columns for module settings and flexible per-item config; typed with Zod schemas in the module package.

## Frontend

Next.js App Router, Tailwind + shadcn/ui, responsive-first, installable **PWA** (modules 1, 4, 6 are phone-centric). Module 4 additionally uses a canvas stack (Konva + perfect-freehand) — the one deliberately non-boring frontend area, isolated inside that module. Hebrew/RTL support via CSS logical properties and per-field language tagging (module 3).
