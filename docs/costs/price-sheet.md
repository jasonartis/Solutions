# Price sheet — every vendor price the cost model uses

> **Checked 2026-11-09.** Generated from `PRICES` in `packages/platform/src/cost-model.ts` (same object the
> `/console/costs` page shows). Prices drift: re-read each vendor page, edit the value and `checked` date in the model file,
> and regenerate (`node node_modules/tsx/dist/cli.mjs scripts/print-cost-model.mts --prices`).
>
> **Confidence:** `verified` = read from the vendor's own page on the date shown · `third-party` = from a comparison
> site because the vendor's page would not render the figure · `assumption` = ours, or recalled from memory and NOT re-fetched.
> The model's results carry these labels line by line.

## Conflicts and gaps found while checking (2026-11-09)

| Item | Finding | What the model uses |
|---|---|---|
| JaaS overage | 8x8's own pricing page says **$0.99 per MAU** above a plan; one third-party guide says $0.35. | $0.99 (the vendor's own page; matches docs/02). |
| Hetzner US vs EU | US servers include 1–5 TB traffic, EU 20 TB (Hetzner cut US allowances in Dec 2024); CX plans carry "currently not available"; June 2026 price rise applies to new orders. | EU CPX22/CPX42 list prices; extra traffic €1.00/TB. Existing servers keep old prices (per Hetzner statements reported by third parties). |
| Hetzner currency | Page lists EUR; docs/02's "$20.49" for CPX11 ≈ €17.99 × 1.14. | €→$ 1.14 (assumption, editable in the model). |
| AWS RDS | AWS's page would not render the instance table. ~$1.80/h single-AZ, ~$3.60/h Multi-AZ for db.r6g.4xlarge comes from a third-party aggregator. | $3.60/h, labelled third-party. **Confirm on aws.amazon.com/rds before budgeting at 10M+.** |
| CloudFront, SES, RDS storage, Sentry | Not re-fetched this session (page would not render or not attempted). | Recalled values, labelled assumption. |
| Supabase read replicas | Not listed on the pricing page fetched. | Not priced; the self-run architecture assumes a replica at +50% of a primary. |
| Cloudflare R2 | Free tier (10 GB, 1M Class A, 10M Class B) ignored — immaterial past a handful of users. | List prices. |

## The prices

| Vendor | Item | Price | Unit | Checked | Confidence | Source / note |
|---|---|---:|---|---|---|---|
| Supabase | Pro plan base | 25 | $/month | 2026-11-09 | verified | https://supabase.com/pricing |
| Supabase | Pro: auth MAU included | 100000 | MAU | 2026-11-09 | verified | https://supabase.com/pricing |
| Supabase | Pro: auth MAU overage | 0.00325 | $/MAU | 2026-11-09 | verified | https://supabase.com/pricing |
| Supabase | Pro: database size included | 8 | GB | 2026-11-09 | verified | https://supabase.com/pricing |
| Supabase | Pro: database size overage | 0.125 | $/GB-month | 2026-11-09 | verified | https://supabase.com/pricing |
| Supabase | Pro: file storage included | 100 | GB | 2026-11-09 | verified | https://supabase.com/pricing |
| Supabase | Pro: file storage overage | 0.0213 | $/GB-month | 2026-11-09 | verified | https://supabase.com/pricing |
| Supabase | Pro: egress included | 250 | GB/month | 2026-11-09 | verified | https://supabase.com/pricing |
| Supabase | Pro: egress overage | 0.09 | $/GB | 2026-11-09 | verified | https://supabase.com/pricing |
| Supabase | Pro: realtime concurrent connections included | 500 | connections | 2026-11-09 | verified | https://supabase.com/pricing |
| Supabase | Pro: realtime connections overage | 10 | $/1,000 connections | 2026-11-09 | verified | https://supabase.com/pricing |
| Supabase | Pro: realtime messages included | 5 | million/month | 2026-11-09 | verified | https://supabase.com/pricing |
| Supabase | Pro: realtime messages overage | 2.5 | $/million | 2026-11-09 | verified | https://supabase.com/pricing |
| Supabase | Pro: compute credit (covers one Micro) | 10 | $/month | 2026-11-09 | verified | https://supabase.com/pricing |
| Supabase | Point-in-time recovery add-on (7 days) | 100 | $/month | 2026-11-09 | verified | https://supabase.com/pricing |
| Vercel | Pro: per developer seat | 20 | $/month | 2026-11-09 | verified | https://vercel.com/pricing — Hobby is "personal, non-commercial use" only. |
| Vercel | Pro: bandwidth included | 1000 | GB/month | 2026-11-09 | verified | https://vercel.com/pricing |
| Vercel | Pro: bandwidth overage (from) | 0.15 | $/GB | 2026-11-09 | verified | https://vercel.com/pricing |
| Vercel | Functions: active CPU (from) | 0.128 | $/CPU-hour | 2026-11-09 | verified | https://vercel.com/pricing |
| Vercel | Functions: provisioned memory (from) | 0.0106 | $/GB-hour | 2026-11-09 | verified | https://vercel.com/pricing |
| Vercel | Functions: invocations (from) | 0.6 | $/million | 2026-11-09 | verified | https://vercel.com/pricing |
| Cloudflare R2 | Standard storage | 0.015 | $/GB-month | 2026-11-09 | verified | https://developers.cloudflare.com/r2/pricing/ — Egress is free. 10 GB free tier ignored. |
| Cloudflare R2 | Class B (read) operations | 0.36 | $/million | 2026-11-09 | verified | https://developers.cloudflare.com/r2/pricing/ |
| Backblaze B2 | Storage | 6.95 | $/TB-month | 2026-11-09 | verified | https://www.backblaze.com/cloud-storage/pricing — Free egress up to 3x stored data; transactions free. |
| 8x8 JaaS | Basic plan (300 MAU) | 99 | $/month | 2026-11-09 | verified | https://cpaas.8x8.com/en/pricing/jitsi-as-a-service-pricing/ |
| 8x8 JaaS | Standard plan (1,500 MAU) | 499 | $/month | 2026-11-09 | verified | https://cpaas.8x8.com/en/pricing/jitsi-as-a-service-pricing/ |
| 8x8 JaaS | Business plan (3,000 MAU) | 999 | $/month | 2026-11-09 | verified | https://cpaas.8x8.com/en/pricing/jitsi-as-a-service-pricing/ |
| 8x8 JaaS | Overage above a plan's MAU | 0.99 | $/MAU | 2026-11-09 | verified | https://cpaas.8x8.com/en/pricing/jitsi-as-a-service-pricing/ — Developer plan: 25 MAU free. One third-party guide says $0.35/MAU; 8x8's own page says $0.99. |
| Hetzner | CPX42-class video bridge / big worker (8 vCPU, 16 GB, EU) | 69.99 | €/month | 2026-11-09 | verified | https://www.hetzner.com/cloud/regular-performance/ — 20 TB traffic included, €1.00/TB over (EU). |
| Hetzner | CPX22 (2 vCPU, 4 GB, EU) — the worker VPS | 19.99 | €/month | 2026-11-09 | verified | https://www.hetzner.com/cloud/regular-performance/ |
| Hetzner | Extra traffic (EU/US) | 1 | €/TB | 2026-11-09 | verified | https://www.hetzner.com/cloud/regular-performance/ |
| FX | EUR to USD | 1.14 | $ per € | 2026-11-09 | assumption | derived: Hetzner CPX11 €17.99 = $20.49 in docs/02 — Edit if your card rate differs. |
| Resend | Pro (50,000 emails) | 20 | $/month | 2026-11-09 | verified | https://resend.com/pricing — Free plan: 3,000/month and 100/day. |
| Resend | Pro (100,000 emails) | 35 | $/month | 2026-11-09 | verified | https://resend.com/pricing |
| Resend | Scale (100,000 emails, no daily cap) | 90 | $/month | 2026-11-09 | verified | https://resend.com/pricing |
| Resend | Overage | 0.9 | $/1,000 emails | 2026-11-09 | verified | https://resend.com/pricing — Falls to $0.46/1,000 on the 2.5M-email tier ($1,150/month). |
| AWS SES | Outbound email | 0.1 | $/1,000 emails | 2026-11-09 | assumption | from memory of aws.amazon.com/ses/pricing — NOT re-fetched |
| Anthropic | Sonnet 5.5 input | 2 | $/million tokens | 2026-11-09 | verified | https://claude.com/pricing |
| Anthropic | Sonnet 5.5 output | 10 | $/million tokens | 2026-11-09 | verified | https://claude.com/pricing |
| Anthropic | Haiku 5.5 input (≤100K context) | 0.1 | $/million tokens | 2026-11-09 | verified | https://claude.com/pricing |
| Anthropic | Haiku 5.5 output (≤100K context) | 0.5 | $/million tokens | 2026-11-09 | verified | https://claude.com/pricing — Batch processing is 50% off; not assumed. |
| AWS RDS | PostgreSQL db.r6g.4xlarge Multi-AZ (us-east-1) | 3.6 | $/hour | 2026-11-09 | third-party | https://sparecores.com/database/aws/db.r6g.4xlarge — AWS's own page would not render the table; confirm on aws.amazon.com/rds/postgresql/pricing before budgeting. |
| AWS RDS | gp3 storage | 0.115 | $/GB-month | 2026-11-09 | assumption | from memory of the RDS pricing page — NOT re-fetched |
| AWS CloudFront | Data transfer out, first 10 TB (US) | 0.085 | $/GB | 2026-11-09 | assumption | from memory of the CloudFront pricing page — NOT re-fetched |
| CDN (negotiated) | Egress at petabytes/month with a commit | 0.03 | $/GB | 2026-11-09 | assumption | our assumption: a committed-spend discount; get quotes |
| CDN / own network (negotiated) | Egress at ~100+ PB/month, multi-CDN or own peering | 0.004 | $/GB | 2026-11-09 | assumption | our assumption; real deals are bespoke |
| Own containers | App compute per million requests (all-in) | 0.3 | $/million | 2026-11-09 | assumption | our assumption: ~1 vCPU-second per 1,000 requests at ~$0.04/vCPU-hour, plus headroom |
| Own platform team tooling | Monitoring, logging, on-call tooling, per month at 10M users | 8000 | $/month | 2026-11-09 | assumption | our assumption |
| Domain | Domain name | 15 | $/year | 2026-11-09 | assumption | docs/05 |
| Sentry | Team plan | 26 | $/month | 2026-11-09 | assumption | from memory of sentry.io/pricing — NOT re-fetched |
