# Costs — what the platform costs to run, by module and by scale

> **STATUS: STARTED 2026-11-04, model not built yet.** This folder exists so
> every cost fact lands in ONE place instead of being scattered across module
> specs. Next step: a session builds `cost-model.md` (below) from the facts
> already measured in the repo, re-verifying every price on the web.

## What the founder wants answered (2026-11-04)

- **What does it cost per month and per year**, all in: accounts, database,
  file/image storage, bandwidth, AI, video, email, hosting, backups.
- **By module**, so pricing can be set per module.
- **At every scale, up to WhatsApp/Facebook-sized user counts.** At the top
  end the answer is not "the same bill times a billion": managed services
  (Supabase, Vercel) stop being the right choice long before that, so the
  model must say where each tier's architecture changes, not just multiply.
- Used to work out a **pricing model** (still undecided).

## Planned files

| File | Holds |
|---|---|
| `cost-model.md` | the tables: fixed platform costs, per-module unit costs, totals per scale tier (10 / 1k / 100k / 10M / 1B users), monthly and yearly |
| `price-sheet.md` | every vendor price used, with source URL and the date it was checked — prices drift, so each figure carries its date |
| `assumptions.md` | usage per user per module (photos uploaded, AI calls, video minutes …), stated once so every table uses the same numbers |

## Cost facts already in the repo (re-verify before reuse)

| Fact | Where |
|---|---|
| Video: JaaS free up to 25 monthly active users; self-hosted Jitsi wins past ~32 MAU; Hetzner US entry $20.49 | docs/02 "Video", module-6 spec |
| Photos: Supabase free 1 GB / 5 GB egress / 50 MB file / pauses after 1 week; Pro $25 incl. 100 GB storage + 250 GB egress; R2 $0.015/GB no egress; B2 $6.95/TB; per-size table for 5k and 50k photos | module-9 spec §D (verified 2026-11-03) |
| Hosting cost phases (Vercel Hobby forbids commercial use → Pro $20) | docs/05 |
| Email: prod's built-in sender measured at 2 emails/hour; a mail provider is a go-live blocker | docs/18 item 7 |
| AI (résumé builder): three caps — platform stop, per org, per user — with a status bar per level; superadmin tree platform→org→module and platform→user→module | chat transcript `4ad1d135…` only (founder is resuming that chat) |
| GitHub Actions free because the repo is public | docs/12 item 3 |
