# Solutions Platform

A multi-tenant, modular web platform. Each client engagement produces a **module** — a self-contained solution to that client's problem — built on shared platform primitives (organizations, users, roles, entitlements, files, workflows, notifications, dashboards). Clients get access to the module built for them, and can be granted access to any existing module. See [docs/00-vision-and-strategy.md](docs/00-vision-and-strategy.md).

**Working name:** "Solutions Platform" (placeholder — rename when branding is chosen).

## Status

- **Phase:** Planning complete, foundation not yet started.
- Six modules are fully specified from client discussions (2026-07-06). No code exists yet.
- Next step: M0 foundation skeleton per [docs/04-build-plan.md](docs/04-build-plan.md).

## Documentation map

Read in this order for full context:

| Doc | Contents |
|---|---|
| [docs/00-vision-and-strategy.md](docs/00-vision-and-strategy.md) | Business model, principles, risks |
| [docs/01-architecture.md](docs/01-architecture.md) | System design, monorepo layout, multi-tenancy, local dev, cloud topology, batch/live processes, storage |
| [docs/02-technology-decisions.md](docs/02-technology-decisions.md) | Every tech choice with rationale, open-source/free evaluation, alternatives, exit ramps |
| [docs/03-adding-a-module.md](docs/03-adding-a-module.md) | Conventions and step-by-step process for building new modules (human + AI workflow) |
| [docs/04-build-plan.md](docs/04-build-plan.md) | Milestones, build order, acceptance criteria |
| [docs/05-operations.md](docs/05-operations.md) | Environments, deploy pipeline, backups, monitoring, cost phases |
| [docs/06-prior-art.md](docs/06-prior-art.md) | Review of founder's existing codebases — what to borrow, what they warn against |
| [docs/07-account-setup.md](docs/07-account-setup.md) | Founder checklist: GitHub, Supabase, Vercel, and later accounts |
| [docs/08-first-shul-walkthrough.md](docs/08-first-shul-walkthrough.md) | Hands-on production test script: build + publish a schedule click by click |
| [docs/modules/](docs/modules/) | Full specification for each module (1–6) |

## Modules specified so far

1. **Make-a-Match** — matchmaking platform (singles, matchmakers, admins; slider-based compatibility scoring)
2. **Classroom** — online course management (students, GAs, professors; submissions, peer review, gradebook)
3. **Synagogue Schedules** — zmanim-driven schedule builder with rules engine and multi-format export
4. **Visual Messaging** — layered image-annotation conversations (tree-structured transparent reply layers)
5. **Nail Salon** — booking, appointment workflow, billing, light bookkeeping
6. **Speed Dating** — live video events with timed round-robin rotation (Jitsi)

## Running locally

Prerequisites (already installed on the dev machine): Node 24+, pnpm, Docker Desktop, git.

1. **Start Docker Desktop** (whale icon in system tray must be running).
2. Open a terminal in this folder and run **`pnpm dev`** — or double-click **`scripts\start-dev.bat`**.
   It starts local Supabase in Docker if needed, writes the `.env` files, and launches the web app + worker. First output shows the resolved config; wait for Next.js to print `Ready`.
3. Open **http://localhost:3000** → you land on the **login page**.

Demo logins (created by `pnpm seed`; all password `password123`):

| Email | What you'll see after login |
|---|---|
| `owner@demo.local` | Dashboard (no orgs) + **Owner Console** link in the header — create orgs, toggle modules, add members |
| `alice@demo.local` | Dashboard showing **Demo Org A** with the **Demo Module** button — click it to see the entitlement-gated module page |
| `bob@demo.local` | Dashboard showing **Demo Org B** with no modules — proving entitlements are per-org |

Other local URLs: Supabase Studio (database GUI) at http://127.0.0.1:54323 · Mailpit (catches all auth emails, e.g. magic links) at http://127.0.0.1:54324.

**Stopping:** `Ctrl+C` in the terminal stops web+worker; `pnpm stop` (or `scripts\stop-dev.bat`) stops the Supabase containers. If the database is ever in a weird state: `pnpm db:reset` re-applies migrations, then `pnpm seed` restores the demo data.
