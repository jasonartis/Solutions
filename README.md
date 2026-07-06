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
| [docs/modules/](docs/modules/) | Full specification for each module (1–6) |

## Modules specified so far

1. **Make-a-Match** — matchmaking platform (singles, matchmakers, admins; slider-based compatibility scoring)
2. **Classroom** — online course management (students, GAs, professors; submissions, peer review, gradebook)
3. **Synagogue Schedules** — zmanim-driven schedule builder with rules engine and multi-format export
4. **Visual Messaging** — layered image-annotation conversations (tree-structured transparent reply layers)
5. **Nail Salon** — booking, appointment workflow, billing, light bookkeeping
6. **Speed Dating** — live video events with timed round-robin rotation (Jitsi)

## Quickstart (once M0 exists)

```
pnpm install
supabase start        # local Postgres/auth/storage/realtime in Docker
pnpm dev              # Next.js app + worker
```

Prerequisites on Windows: Node LTS, pnpm, Docker Desktop (WSL2 backend), Supabase CLI, git.
