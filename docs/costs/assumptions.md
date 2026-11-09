# Assumptions — usage per user, stated once

> **2026-11-09. EVERY number here is a guess until measured.** They live in code as `DEFAULT_MODULES` / `DEFAULT_GLOBALS` in
> `packages/platform/src/cost-model.ts`; this file says the same thing in words. The Owner Console page (`/console/costs`)
> lets you change the share of users per module, the active-user ratio, the AI model and months of retention and see the result
> at once. **Replace these with measured values after the first real client's first month** (Supabase usage dashboard, Vercel
> usage, Resend sent count, JaaS MAU report, the engagement console of docs/17).

## Global

| Assumption | Value | Why |
|---|---|---|
| Active users per month ÷ registered | 30% | Typical for community/utility apps; **measure** from docs/17. |
| Retention at which database and files are priced | 12 months of growth | Storage is a stock; this is "the bill after one year". |
| Peak traffic ÷ average | 5× | Events and Friday-before-Shabbat clustering. |
| Share of video users on a call at the busiest moment | 20% | Events cluster in a few evenings. |
| Jitsi participants per 8-vCPU bridge | 150 | **Unmeasured** — run one real event and read the bridge's CPU. |
| Video bytes sent per participant-minute | 11.25 MB (~1.5 Mbit/s) | Standard Jitsi 720p-ish. |
| AI call size | 4,000 tokens in, 1,500 out | One résumé-style generation. Sonnet 5.5 by default. |
| Database queries per request | 4 | Self-run tiers only. |
| Queries per second per Multi-AZ r6g.4xlarge primary | 6,000 | Self-run tiers only; **load-test**. |
| Application CPU per request on Vercel | 50 ms active CPU, 100 ms × 0.25 GB memory | Next.js server component render. |
| Bytes through the app per request | 30 KB | HTML/JSON, not files. |
| Realtime peak connections | 2% of active users | Chat open at once. |

## Per active user of a module, per month

| Module (share of active users) | Requests | DB growth | File growth | Download | Emails | Realtime msgs | Video | AI calls |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Platform core (100%) | 150 | 0.2 MB | – | 5 MB | 1 | – | – | – |
| Make-a-Match (15%) | 200 | 0.5 MB | – | 20 MB | 2 | 100 | – | – |
| Classroom (15%) | 300 | 1 MB | 50 MB | 300 MB | 5 | – | – | – |
| Synagogue Schedules (50%) | 20 | – | – | 2 MB | – | – | – | – |
| Visual Messaging (20%) | 150 | 2 MB | 100 MB | 500 MB | 1 | 100 | – | – |
| Nail Salon (15%) | 100 | 0.5 MB | – | 20 MB | 4 | – | – | – |
| Speed Dating (5%) | 100 | 0.3 MB | – | 20 MB | 3 | 300 | 45 min | – |
| Photos, module 9 planned (25%) | 100 | 0.1 MB | 15 MB | 300 MB | – | – | – | – |
| AI features (10%) | 20 | 0.05 MB | – | – | – | – | – | 3 |

Photos follows module-9 spec §D's design (resized uploads of ~1.5 MB; ~100 views of ~0.25 MB). Synagogue schedules is the
module with anonymous public viewers: they cost almost nothing each, which is why 50% adoption is cheap.

## Fixed items

Domain $15/yr; Sentry Team from 1,000 users; one worker server per 50k active users; backups = 14 nightly compressed dumps
(30% of database size) + one copy of files on Backblaze B2.

## What each assumption could break

- **Classroom and Visual Messaging downloads (300–500 MB/user/month)** are the largest egress drivers. If lectures are mostly
  external links (YouTube), classroom egress is near zero.
- **Video bridge capacity** moves the speed-dating line one-for-one.
- **AI calls per user** moves the AI line one-for-one; it is the only line that grows with *engagement* rather than *headcount*.
- **Active ratio** moves everything priced per active user (auth MAU, requests, AI, video) but not database/file stock.
