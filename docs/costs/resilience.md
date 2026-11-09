# Resilience costs — standby, backups and drills (docs/28 Part B)

> **PLANNED 2026-11-09, not built and not in `cost-model.ts` yet.** These are the costs of the protection levels in
> [docs/28 Part B](../28-vendor-accounts-and-evacuation-plans.md) (B.5). **Founder chose (B.7 Q1, 2026-11-09): Cold now,
> Warm from the first paying client.** When those lines start costing money, add them to `packages/platform/src/cost-model.ts` and regenerate, so the page and the doc keep showing the
> same numbers. Prices marked **sheet** are in [price-sheet.md](price-sheet.md) (checked 2026-11-09). Prices marked
> **assumption** were not checked on the web: check them before buying.

## Cold (recommended now): nothing runs in standby, copies kept elsewhere, drills run on throwaway servers

| Line | Cost | Source |
|---|---|---|
| Domain we own (R1); **deferred to the first customer** (founder, docs/28 B.7 Q3) | ~$15/yr ≈ $1.25/mo, from then | sheet ("Domain") |
| Storage files copied nightly to B2 (F1) | cents at today's size; $6.95/TB-month | sheet (B2) |
| Second email provider on standby (Amazon SES) | ~$0 at our volume; $0.10 per 1,000 emails if used | sheet (SES) |
| Second git host mirror (GitLab / Codeberg free) | $0 | assumption |
| Offsite snapshots (docs/28 B.8): existing USB stick + ~300 MB on a free cloud-drive tier | $0 | assumption (free tiers: Google 15 GB, OneDrive 5 GB) |
| Password manager (B.3-7) | $0 (free tier) to ~$10–40/yr | assumption |
| Drills on hourly-billed Hetzner servers (B.6): ~6 drills/yr × a few hours | under $5/yr | assumption (hourly billing; monthly prices in sheet: CPX22 €19.99, CPX42 €69.99) |
| **Ongoing total** | **≈ $1.50–5/mo** | |
| One-off: two hardware security keys for two-step verification (optional) | ~$100 once | assumption |

## Warm (recommended from the first paying client): adds a standby server restored each night

| Line | Cost | Source |
|---|---|---|
| Everything in Cold | ≈ $1.50–5/mo | above |
| One Hetzner CPX22-class server: self-hosted Supabase restored nightly, plus the app ready to serve | ~$22.79/mo | sheet (CPX22 €19.99 × 1.14) |
| **Ongoing total** | **≈ $25–28/mo** | |

The worker server the cost model already counts (~$22.79) is too small to also hold a standby database and the app. A
single bigger server for both is possible; its price is not checked.

**Not resilience, already in the cost model:** Supabase Pro ($25, brings Supabase's own daily backups), Vercel Pro ($20),
point-in-time recovery ($100, at ~100k users: it protects against our own mistakes, not against losing Supabase).

## Hot (not recommended at this size)

Supabase cannot keep a live copy at another provider for us. Automatic failover means running our own replicated
database, which the cost model puts at its self-run switch (~5M users). No figure here on purpose; it belongs to that
architecture's lines in [cost-model.md](cost-model.md).
