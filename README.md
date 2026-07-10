# Solutions Platform

A multi-tenant, modular web platform. Each client engagement produces a **module** — a self-contained solution to that client's problem — built on shared platform primitives (organizations, users, roles, entitlements, files, workflows, notifications, dashboards). Clients get access to the module built for them, and can be granted access to any existing module. See [docs/00-vision-and-strategy.md](docs/00-vision-and-strategy.md).

**Working name:** "Solutions Platform" (placeholder — rename when branding is chosen).

## Status (2026-07-10)

- **Production is live:** https://solutions-platform.vercel.app (Vercel + cloud Supabase; every green CI run deploys automatically).
- **All six modules are built and usable** — schemas security-reviewed with live-verified guards, role-adaptive UIs, per-role in-app walkthroughs (**Help** on every org card), and authorship-based data export with per-level controls.
- Module 3 (Synagogue Schedules) passed acceptance against the first real client's data; a real org runs on it.
- Platform primitives: org/entitlement/RLS tenancy, self-contained module composition (`modules/<key>` + `MODULES` env filter for white-label builds), background worker jobs (exports, round clocks, rescoring, retention), data export, in-app help. `modules/sample` is the living template for module 7+.
- The worker runs in production via `pnpm worker:prod` from the dev PC ([docs/10](docs/10-worker-deploy.md) has the VPS runbook).
- Founder testing round in progress against [docs/11](docs/11-walkthrough-testing-script.md).

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
| [docs/09-continuing-development.md](docs/09-continuing-development.md) | Restarting development in a fresh session: starter prompt + where every thread lives |
| [docs/10-worker-deploy.md](docs/10-worker-deploy.md) | Background worker: the local prod stopgap + the Hetzner VPS runbook |
| [docs/11-walkthrough-testing-script.md](docs/11-walkthrough-testing-script.md) | Founder testing itinerary: every module, every role, from zero (production or offline) |
| [docs/12-safeguards.md](docs/12-safeguards.md) | Mechanical guards, never-do list, backups, recovery playbook |
| [docs/13-future-ideas.md](docs/13-future-ideas.md) | Parking lot for future platform ideas (dated, attributed, non-committal) |
| [docs/modules/](docs/modules/) | Full specification for each module (1–6) |

## Modules (all live)

1. **Make-a-Match** — weighted-question matchmaking: care sliders, dealbreakers, automatic rescoring, share-with-match reveal
2. **Classroom** — materials with visibility windows, homework, GA + anonymous peer + exam grading, gradebook combination, surveys, retention
3. **Synagogue Schedules** — zmanim rules engine, weekly publishing, public page, PDF/JPG exports (client-accepted)
4. **Visual Messaging** — conversations as layer trees: draw replies on a picture, X-ray, moderation with tombstones + audit log
5. **Nail Salon** — customer self-booking, day-board lifecycle through payment, promotions, earnings/expenses/shopping bookkeeping
6. **Speed Dating** — events with an automatic round clock, block-aware rotation, privacy-preserving mutual-match reveal (video pending VPS)
0. **Sample** — the living template new modules are copied from

## Running locally

Prerequisites (already installed on the dev machine): Node 24+, pnpm, Docker Desktop, git.

1. **Start Docker Desktop** (whale icon in system tray must be running).
2. Open a terminal in this folder and run **`pnpm dev`** — or double-click **`scripts\start-dev.bat`**.
   It starts local Supabase in Docker if needed, writes the `.env` files, and launches the web app + worker. First output shows the resolved config; wait for Next.js to print `Ready`.
3. Open **http://localhost:3000** → you land on the **login page**.

Demo logins (created by `pnpm seed`; all password `password123` locally — the full cast and testing itinerary live in [docs/11](docs/11-walkthrough-testing-script.md)):

| Email | What you'll see after login |
|---|---|
| `owner@demo.local` | Dashboard (no orgs) + **Owner Console** link in the header — create orgs, toggle modules, add members |
| `alice@demo.local` | Dashboard showing **Demo Org A** with the **Demo Module** button — click it to see the entitlement-gated module page |
| `bob@demo.local` | Dashboard showing **Demo Org B** with no modules — proving entitlements are per-org |

Other local URLs: Supabase Studio (database GUI) at http://127.0.0.1:54323 · Mailpit (catches all auth emails, e.g. magic links) at http://127.0.0.1:54324.

**Stopping:** `Ctrl+C` in the terminal stops web+worker; `pnpm stop` (or `scripts\stop-dev.bat`) stops the Supabase containers. If the database is ever in a weird state: `pnpm db:reset` re-applies migrations, then `pnpm seed` restores the demo data.
