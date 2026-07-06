# Technology Decisions

Every choice evaluated against: least cost, least maintenance, most expandable, local/cloud parity, open-source preference with managed convenience, and AI-assistant fluency (Claude Code / Copilot generate best code for mainstream stacks). Each entry lists the exit ramp — what we'd do if the choice stops fitting.

## Language: TypeScript

- **Why:** Type errors caught at build time matter double when AI writes much of the code and a part-time human reviews it. Copilot/Claude produce markedly better results with types. Adjacent to founder's Apps Script (JavaScript) background.
- **Style rule:** explicit over clever — plain functions, few generics, no exotic type gymnastics (docs/00 maintainership).
- Alternatives considered: plain JavaScript (rejected: loses AI+review leverage).

## Framework: Next.js (App Router)

- **Why:** one framework for UI + API routes; the largest ecosystem and training-data footprint (best AI fluency); deploys everywhere (Vercel, VPS, Cloudflare); first-class PWA support.
- Alternatives: SvelteKit (nicer, smaller ecosystem), Remix, plain Express+React (more assembly). All workable; Next.js wins on AI fluency and hiring.
- Exit ramp: it's React — components survive a framework move.

## Database: PostgreSQL (via Supabase)

- **Why Postgres:** the boring, correct default. RLS gives us tenancy enforcement in the database itself. JSON columns cover flexible module config. Handles timeseries, queues (pg-boss), and full-text search well enough to avoid extra databases for years.
- **Why Supabase as the Postgres host:** bundles auth, storage, realtime, and RLS tooling; generous free tier; **fully open-source and self-hostable** (the exit ramp is real: `supabase` docker-compose on a VPS); the CLI runs the identical stack locally in Docker — our local/cloud parity story.
- Alternatives: Neon (nice Postgres, no auth/storage bundle), RDS (cost/ops), self-hosted from day one (maintenance we don't want yet).
- Rejected: MongoDB (RLS story weak, relational fits every module), separate timeseries DB (add Timescale extension later only if sensor-heavy modules demand it).

## ORM: Drizzle

- **Why:** SQL-first and lightweight; generated migrations we can read; plays cleanly with RLS and Supabase; TypeScript-native types.
- Alternative: Prisma (heavier runtime, migration engine more magical). Either works; Drizzle chosen for transparency.

## Auth: Supabase Auth

- Email/password + magic links; Google OAuth optional per module audience (classroom students). JWT carries user id; org membership/roles resolved from our tables (never stored in the JWT — roles change without re-login).
- Exit ramp: Auth.js in front of the same Postgres.

## UI kit: Tailwind CSS + shadcn/ui

- **Why:** shadcn components are copied into `packages/ui` (we own the code, no dependency treadmill); Tailwind is the ecosystem default AI tools write fluently. Free, MIT.

## Job queue: pg-boss

- **Why:** queue lives in Postgres — zero extra infrastructure, transactional with app data, survives locally and in cloud identically. Retries, cron, priorities included. MIT license.
- Alternatives: Graphile Worker (also good, same family), BullMQ (needs Redis — rejected: extra service to run and pay for), host cron (no retries/observability).

## Realtime: Supabase Realtime + Socket.IO (module 6 only)

- Supabase Realtime (part of the stack, works locally) for DB-change UI updates and notification badges.
- Socket.IO in the worker for module 6's event orchestration — server-authoritative clock and room state don't map to DB-change streams. MIT, boring, well-documented.

## Video: Jitsi (self-hosted), behind a provider interface

- Decided 2026-07-06 (module 6 discussion). Open-source, self-hostable on one modest VPS (~$20–40/mo); P2P mode for 1:1 calls barely touches the server; embed via IFrame API or `lib-jitsi-meet` (we want lib-level control to wrap our own timer/notepad/rotation chrome around the video surface).
- **Provider interface** (`create room / issue join token / close room`) so swapping to managed (Daily, LiveKit, JaaS = 8x8-hosted Jitsi) is config, not rewrite.
- Ops honesty: self-hosting means TURN servers for restrictive networks, and upgrades. JaaS is the managed middle option if ops chafe.
- Local: `jitsi/docker-jitsi-meet` compose.

## Rendering/exports: Playwright (headless Chromium) + sharp

- HTML template → PDF (print CSS, margins) and JPG (screenshot at preset pixel dimensions); `sharp` for resize/B&W variants. Runs in the worker. All open-source.
- Alternatives: wkhtmltopdf (dated), @react-pdf (separate layout system to maintain — rejected; one HTML template serves screen and export).

## Hebrew calendar: @hebcal/core + myzmanim API

- `@hebcal/core` (open-source, local, free): Hebrew dates, holidays, Shabbat/Yom Tov overlap, parsha, Rosh Chodesh, fasts — powers all *conditions*; also computes zmanim as fallback.
- **myzmanim.com API** (founder has free account): primary *times* source, treated as authoritative by the audience; fetched and cached per address+date (connector primitive). Combination decided 2026-07-06.

## Canvas/drawing (module 4): Konva (react-konva) + perfect-freehand

- Konva: mature MIT canvas scene graph (layers, transforms, hit detection — fits the layer model exactly). perfect-freehand: the best open-source freehand stroke quality (pressure-simulated ink).
- **Rejected: tldraw** — excellent but its SDK license now requires a paid license/watermark for production; conflicts with least-cost.
- Storage as vector JSON per layer (decided in module 4 spec); worker rasterizes thumbnails via Konva-node or Playwright.

## Code display (module 2): Shiki + notebook renderer

- Shiki for syntax highlighting (`.R`, `.py`, `.js`, `.html` — TextMate grammars, MIT). Jupyter `.ipynb` is JSON — render cells/outputs with a small custom component (or `react-ipynb-renderer` as starting point). Line-anchored comments are our own data model (file, line range, comment thread).

## Email: provider-abstracted; Resend first, SES at scale; Mailpit locally

- Resend: 3k emails/month free, pleasant API. Amazon SES: ~$0.10/1k when volume grows. One `sendEmail()` abstraction so switching is config.
- Local: Mailpit container catches everything (no accidental real email from dev).

## Google integration: googleapis (official Node client) + service account

- Roster sync from Google Groups/Sheets (module 2), Drive view-only video embeds (module 2 v1), Sheets data migration for existing clients. Service-account credentials per integration, stored as secrets.

## Monitoring: Sentry (free tier) + UptimeRobot (free)

- Sentry for error tracking in web + worker; UptimeRobot pings prod + a worker heartbeat endpoint. Structured console logs (JSON) retained by the host. Enough until real scale.

## CI/CD: GitHub (private repo) + GitHub Actions

- Decided 2026-07-06. Push → Actions: typecheck, lint, tests, build; on main: apply migrations to cloud, deploy web + worker. Vercel auto-deploys previews per PR.

## Hosting (phased — decided 2026-07-06, "managed-first, VPS later")

- **Phase A (build, $0/mo):** Supabase free tier + Vercel Hobby. No worker deployment needed until module 3 nears completion (run worker locally during development).
- **Phase B (first real users, ~$10–20/mo):** add one small VPS (Hetzner CX22-class or DigitalOcean) running the worker via Docker + Coolify (open-source PaaS: git-push deploys, TLS, one dashboard). Supabase still free tier until limits.
- **Phase C (revenue / commercial use):** Vercel Hobby is **non-commercial** — decision point when clients pay: (a) Vercel Pro $20/mo (least effort), (b) move Next.js onto the VPS behind Coolify (least cost), or (c) Cloudflare Workers via OpenNext (generous free tier, allows commercial; most fiddly). Also Supabase Pro ($25/mo) when we want daily backups/PITR and higher limits. Jitsi VPS (+~$20/mo) only when module 6 ships.
- Rationale over alternatives recorded in docs/00 principle 5; full cost table in docs/05.

## Dev scripts: cross-platform Node (tsx), not .bat/.sh

- The dev-mode matrix (docs/01) is driven by TypeScript scripts run with `tsx`, so they work on Windows/Mac/Linux and are readable by the same tooling as the rest of the repo. Pattern (per-piece start/stop in each mode + named combination commands + layered env + masked config echo + guard rails + `--dry-run`) adopted from dascher.base's scripts folders — see docs/06.

## Future/parked

- **User-authored formulas**: if any module outgrows its structured rule builder (gradebook combinations, schedule time rules), the known-good design is dascher.base's calc-engine — HyperFormula evaluated server-side with custom function plugins and typed errors (docs/06). Don't hand-roll an expression evaluator past that point.
- **AI features** (natural-language querying, insight/report generation): implement behind a pluggable provider interface with an openai-compatible + mock provider, per dascher.base's insight-engine design (docs/06).
- **SMS** (receipts, alerts): Twilio when needed — abstraction slot exists, no build now.
- **Payments/card processing** (modules 5, 6 ticketing): Stripe when needed; bill/payment models carry `payment_method` + external-reference fields from day one so this plugs in without remodeling.
- **Managed video streaming** (module 2 class videos): Mux/Cloudflare Stream if Google Drive embeds ever chafe.
- **Timescale extension** if a future sensor-heavy module arrives.
- **Virus scanning of uploads** (ClamAV container) if untrusted-file exposure grows.
