# Operations

## Environments

| Env | Purpose | Infra |
|---|---|---|
| **local** | all development and testing | Docker: supabase CLI stack, Mailpit, (Jitsi when needed); `pnpm dev` |
| **preview** | per-PR review builds | Vercel preview deployments, pointed at a Supabase *branch/staging* project — never prod data |
| **prod** | real clients | Supabase cloud + Vercel + worker VPS (Phase B+) |

A dedicated staging project is added when the first real client is live; before that, previews + local suffice.

## Deploy pipeline (GitHub Actions)

1. PR: typecheck, lint, unit tests, build, Playwright e2e against a fresh local-style Supabase in CI; Vercel preview.
2. Merge to `main`: apply migrations to prod (`supabase db push` / drizzle migrate — forward-only, already exercised locally), deploy web (Vercel), deploy worker (Coolify webhook on the VPS, Phase B+).
3. Rollback strategy: web/worker roll back by redeploying the previous build; **migrations don't roll back** — write additive migrations (new column, backfill, switch, drop later) so old code tolerates the new schema during deploys.

## Secrets

- Local: `.env.local` per app, git-ignored; `.env.example` kept current and committed.
- CI: GitHub Actions secrets. Cloud: Vercel/Coolify env vars, Supabase dashboard.
- Never in code, never in migrations, never in docs. Service-role key only in the worker and CI migration step.

## Backups

- **Phase A/B (free tier):** nightly `backup.dump` job — `pg_dump` from the worker (or GitHub Actions schedule before the VPS exists) to a private storage bucket **plus** a second location (Backblaze B2 free tier) — a backup living only next to the database it backs up is half a backup. Storage bucket files (uploads) synced weekly to B2.
- **Phase C:** Supabase Pro adds managed daily backups + PITR; keep the independent B2 dump anyway.
- **Restore drill:** before the first real client's data exists, and quarterly after: restore latest dump into local Supabase, boot the app against it, verify. An untested backup is a hope, not a backup.

## Monitoring

- Sentry (web + worker), alert on new error types.
- UptimeRobot: prod URL + worker heartbeat endpoint (worker writes a heartbeat row / serves `/healthz`).
- pg-boss dead-letter review: failed jobs surface in the platform-owner console.
- Weekly: check Supabase usage dashboard against free-tier limits (DB size, storage, MAUs) — limit surprises are the main free-tier risk.

## Cost phases (decided 2026-07-06)

| Phase | Trigger | Monthly cost | Components |
|---|---|---|---|
| A — build | now | **$0** | Supabase free, Vercel Hobby, GitHub free, Sentry/UptimeRobot free, myzmanim free acct |
| B — first users | worker needed in cloud (module 3 live) | **~$10–20** | + Hetzner/DO VPS (worker, Coolify, backups) |
| C — revenue | paying clients (Vercel Hobby is non-commercial) and/or backup needs | **~$55–75** | + Vercel Pro $20 *or* app moves to VPS ($0 extra); + Supabase Pro $25; + domain ~$15/yr |
| D — module 6 live | speed-dating events running | **+~$20–40** | + Jitsi VPS (can suspend between events) |

Every phase boundary is a documented decision point, not an automatic upgrade. The self-hosted exit ramp (everything onto one larger VPS via Coolify + self-hosted Supabase, ~$30–50 flat) remains available throughout if managed costs ever outpace value.

## Routine maintenance

- Dependency updates: monthly Renovate/Dependabot batch, merged when CI is green; security advisories immediately.
- Supabase/Postgres version upgrades: follow Supabase notices; test on local stack first.
- VPS (Phase B+): Coolify manages containers; OS unattended-upgrades on; SSH by key only.
- Audit log + Sentry review: skim weekly while small.

## Outside contributors (hired help) — decided 2026-07-06

Question considered: should we use dascher.base-style separate repos per module so a contractor can be given access to only part of the platform? **Decision: stay monorepo; scope contractors by permission and process, not repo boundaries.** GitHub read access is all-or-nothing per repo, so multi-repo is the only way to make code *unreadable* — but it would tax our core strategy (atomic extraction passes across modules + platform, one CI, AI-friendly single tree) on every single change.

Contractor protections, in order of importance:

1. **No production anything.** Secrets aren't in git; contractors get local dev (seeded data) and at most staging. Client data never reaches them.
2. **Blast radius = their module folder** by architecture (modules can't import modules; platform changes go through `packages/platform` PRs).
3. **CODEOWNERS + branch protection:** PR-only to main, founder review required, CI green required; their module folder can list them as co-owner, everything else requires the founder.
4. **Confidential engagements (exception path):** develop that module in a temporary private repo against a stubbed platform interface; founder merges into the monorepo. Use per sensitive case only.
5. **Revisit trigger:** a real team forms or a module becomes its own product → extract that module to its own repo then (easy later; costly to pre-pay).

## Support model

Clients message admins in-app (conversations primitive) — that's the support channel. Each engagement's subscription includes support; track time spent per org (even roughly) to know when a module's maintenance outweighs its revenue.
