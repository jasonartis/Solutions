# Cost model — monthly and yearly, by module, at 10 / 1k / 100k / 10M / 1B users

> **BUILT 2026-11-09 (Sonnet).** Prices re-checked on the web the same day ([price-sheet.md](price-sheet.md)); usage
> assumptions in [assumptions.md](assumptions.md). **The tables below are GENERATED** from
> `packages/platform/src/cost-model.ts` by `node node_modules/tsx/dist/cli.mjs scripts/print-cost-model.mts` — the Owner
> Console page `/console/costs` runs the very same code, so page and doc cannot disagree. To change a number, change it in
> the model file, run the script, and paste the output between the markers at the bottom. Staff, legal and compliance
> costs are **not** included anywhere.

## The five things worth knowing

1. **The platform is a fixed floor plus pennies.** A paying client costs about **$70–100 a month before a single user
   signs in** (Vercel Pro $20, Supabase Pro $25, worker server ~$23, Sentry $26 from 1k users). After that a typical user
   costs **well under a cent a month** in database, files and hosting. A flat price per organisation fits the cost
   shape; a price per user does not, until the user count is large.
2. **Only two things scale with people: AI and live video.** At 100k users the Claude API (~$207/mo at three Sonnet calls
   per AI user per month), file storage (~$179) and video bridges (~$160) are the three biggest lines. At 10M and 1B AI and
   video are still two of the top four. Price them **per use** (a credit, a per-event fee), not inside a flat plan. Haiku instead of Sonnet cuts the AI
   line ~20× (switch it on the page).
3. **Files and images, not the database, become the bill.** Supabase charges $0.09/GB to download a file; Cloudflare R2
   charges nothing. The model moves files to R2 at 50k users. At 1B users object storage is the largest
   infrastructure line (~$1.2M/mo); the CDN line looks small (~$280k) only because it assumes a $0.004/GB negotiated rate —
   at CloudFront's list $0.085/GB the same traffic would be ~$5.9M/mo. **The egress deal is the biggest single lever at that size.**
4. **The setup changes twice, not continuously** — at roughly 50k–300k users (files to R2, point-in-time recovery, bigger
   database, realtime moved off) and again at roughly 5M (leave Supabase and Vercel: sharded Postgres, own containers, CDN
   contract, an infrastructure team). Between those points cost is a straight line; at each point there is a project, not just
   a bigger bill. See "Where the setup has to change" below.
5. **Above 10M the numbers are order-of-magnitude.** Real bills there are decided by negotiated deals and engineering
   choices. The 1B row is a planning floor, not a quote.

## Method (short)

users → monthly active users (30%) → each module's users (adoption %) → monthly **flows** (requests, emails, egress GB,
realtime messages, video minutes, AI calls) and year-end **stocks** (database GB, file GB, after 12 months) → priced
against the architecture that size needs → each line split across modules by that module's share of the line's driver
(fixed plans follow traffic). **Loaded** cost includes a module's share of the fixed plans; **marginal** cost is only the
usage-driven lines. Price between marginal (you lose money below it) and loaded (you cover the fixed plans) plus margin.

## Where the setup has to change

| Size | What changes | Why |
|---|---|---|
| **10** | Nothing new. Free tiers ($0) are for non-commercial use; a paying client means Vercel Pro + Supabase Pro + one worker server + Resend. | Vercel Hobby forbids commercial use; Supabase Free pauses after a week idle; built-in email is 2/hour. |
| **1,000** | Same stack. Sentry paid; video on JaaS until ~30–45 video users, then a Jitsi box. | Still no reason to leave managed services. |
| **100,000** | Files move to Cloudflare R2; point-in-time recovery ($100); database compute Medium → Large/XL; realtime connections pass the 500 included; Resend Scale; self-hosted video bridges. | File downloads and database size are now real money; one bad hour of data loss is not acceptable. |
| **10,000,000** | **Leave Supabase and Vercel.** Sharded Postgres (by org — every table already carries `org_id`), own app containers behind a load balancer, self-run auth, CDN contract, SES email, search/queues/cache, real observability — and an infrastructure team. | One database instance (largest add-on 16XL, ~$3,730/mo) cannot carry it; auth MAU billing alone is ~$9.4k/mo; Vercel bandwidth ($0.15/GB) and Supabase egress ($0.09/GB) are the largest lines. |
| **1,000,000,000** | Independent regional **cells** (each a full stack for a slice of users) plus a thin global routing/sign-in layer; own network edge or multi-CDN; photo/video storage as its own tiered product; purpose-built media servers for live video. | One region cannot serve the planet; egress price per GB and storage retention policy dominate everything else. |

The architecture rows in the tables come from `architectureFor(users)`: managed below 5M registered users, self-run to 300M,
multi-region above. The exact switch points are judgement calls (the doc says "roughly"); the model lets you type any user
count on the page and watch the plan change.

## What this does NOT include (read before using the numbers)

- **People.** At 10M a platform needs an infrastructure team; at 1B, hundreds of engineers. Salaries dwarf every line here.
- Payment-processor fees (typically ~3% of revenue), taxes, legal/compliance (the module-9 photo legal items are a real
  cost), customer support, marketing, or the founder's time.
- Staging environments, load-test runs, disaster-recovery standby sites. **Standby and drill costs are now PLANNED in
  [resilience.md](resilience.md)** (docs/28 Part B, 2026-11-09): cold ≈ $1.50–5/mo now, warm ≈ $25–28/mo from the first
  paying client (founder chose exactly that, docs/28 B.7 Q1). They join this model when they start costing money.
- Volume discounts above the first tier of any vendor (assumed none, except the two CDN rates marked assumption).
- Any module not yet built (7, 8) and module 9 (photos) is the planned design, not measured.

## Pricing ideas this model supports (not decisions — the founder's call, 2026-11-09)

- **Price the floor per organisation, usage on top.** Cost to carry one client's org is ~$70–100/mo of fixed plans spread over
  every client; marginal cost per active user is cents. A per-org subscription covers the floor; per-use credits cover AI and
  video.
- **Use the "Cost and price by type of user" table on the page** to test it: add a user type (modules ticked), set the margin
  slider, read the price/user/month that earns it at the size you expect.
- **Per active vs per registered user**: costs follow active users (30% assumed). A price per registered user should be the
  per-active price × your real active ratio — measure it from the engagement console (docs/17).
- **Re-run at the real numbers.** Every default usage figure is an assumption. When the first real client has run for a month, replace
  the module usage numbers with measured ones (Supabase usage dashboard, Vercel usage, Resend sent count, JaaS MAU).

## Generated tables

<!-- BEGIN GENERATED (scripts/print-cost-model.mts) -->

## Totals

| Registered users | Active (30%) | Monthly | Yearly | Per registered user / month | Architecture |
|---:|---:|---:|---:|---:|---|
| 10 | 3 | $69.07 | $829 | $6.91 | Managed services: Supabase + Vercel + a worker box |
| 1k | 300 | $98.25 | $1,179 | $0.10 | Managed services: Supabase + Vercel + a worker box |
| 100k | 30k | $958 | $11,493 | $0.01 | Managed services: Supabase + Vercel + a worker box |
| 10M | 3M | $106,046 | $1,272,553 | $0.01 | Self-run: sharded Postgres, own containers, CDN |
| 1B | 300M | $7,172,106 | $86,065,273 | $0.01 | Multi-region cells, own network edge |

## Cost by module (monthly)

| Module | 10 | 1k | 100k | 10M | 1B |
|---|---:|---:|---:|---:|---:|
| Platform core (sign-in, profile, orgs) | $33.19 | $45.88 | $131 | $12,331 | $755,886 |
| Make-a-Match | $6.64 | $9.21 | $36.16 | $2,959 | $184,878 |
| Classroom | $9.96 | $13.91 | $109 | $12,527 | $648,739 |
| Synagogue Schedules | $2.21 | $3.05 | $4.74 | $754 | $38,411 |
| Visual Messaging | $6.64 | $9.68 | $228 | $25,087 | $1,317,071 |
| Nail Salon | $3.32 | $4.64 | $32.24 | $2,053 | $138,061 |
| Speed Dating | $1.11 | $1.54 | $168 | $18,824 | $1,662,581 |
| Photos (module 9, planned) | $5.53 | $7.67 | $39.36 | $10,638 | $344,993 |
| AI features (résumé builder etc.) | $0.46 | $2.68 | $209 | $20,873 | $2,081,485 |

## Cost per ACTIVE user using that module (monthly)

| Module | 10 | 1k | 100k | 10M | 1B |
|---|---:|---:|---:|---:|---:|
| Platform core (sign-in, profile, orgs) | $11.06 | $0.15 | $0.00 | $0.00 | $0.00 |
| Make-a-Match | $14.75 | $0.20 | $0.01 | $0.01 | $0.00 |
| Classroom | $22.13 | $0.31 | $0.02 | $0.03 | $0.01 |
| Synagogue Schedules | $1.48 | $0.02 | $0.00 | $0.00 | $0.00 |
| Visual Messaging | $11.07 | $0.16 | $0.04 | $0.04 | $0.02 |
| Nail Salon | $7.38 | $0.10 | $0.01 | $0.00 | $0.00 |
| Speed Dating | $7.38 | $0.10 | $0.11 | $0.13 | $0.11 |
| Photos (module 9, planned) | $7.38 | $0.10 | $0.01 | $0.01 | $0.00 |
| AI features (résumé builder etc.) | $1.54 | $0.09 | $0.07 | $0.07 | $0.07 |

## Marginal cost per ACTIVE user (usage-driven lines only, no share of fixed plans)

| Module | 10 | 1k | 100k | 10M | 1B |
|---|---:|---:|---:|---:|---:|
| Platform core (sign-in, profile, orgs) | $0.00 | $0.00 | $0.00 | $0.00 | $0.00 |
| Make-a-Match | $0.00 | $0.00 | $0.00 | $0.00 | $0.00 |
| Classroom | $0.00 | $0.00 | $0.02 | $0.02 | $0.01 |
| Synagogue Schedules | $0.00 | $0.00 | $0.00 | $0.00 | $0.00 |
| Visual Messaging | $0.01 | $0.01 | $0.03 | $0.04 | $0.02 |
| Nail Salon | $0.00 | $0.00 | $0.00 | $0.00 | $0.00 |
| Speed Dating | $0.00 | $0.00 | $0.11 | $0.12 | $0.11 |
| Photos (module 9, planned) | $0.00 | $0.00 | $0.00 | $0.01 | $0.00 |
| AI features (résumé builder etc.) | $0.07 | $0.07 | $0.07 | $0.07 | $0.07 |

## Staying managed vs the recommended architecture (platform infrastructure only: database, auth, hosting, files)

| Users | Recommended | Same load on Supabase + Vercel list prices (lower bound) |
|---|---:|---:|
| 10 | $45.00 | $55.00 |
| 1k | $45.27 | $55.50 |
| 100k | $418 | $1,013 |
| 10M | $53,771 | $110,602 |
| 1B | $2,742,033 | $10,736,008 |

## Line items per tier

### 10 users — Managed services: Supabase + Vercel + a worker box

| Group | Line | Monthly | Confidence |
|---|---|---:|---|
| AI | Claude API (Sonnet 5.5), 1 calls | $0.02 | verified |
| Video | JaaS (0 video MAU) | $0.00 | verified |
| Email | Resend Free (3,000/month, 100/day — fine only before real use), 9 emails | $0.00 | verified |
| Hosting | Vercel Pro (1 developer seat) | $20.00 | verified |
| Hosting | Vercel functions + bandwidth beyond the plan | $0.00 | assumption |
| Database & auth | Supabase Pro base | $25.00 | verified |
| Database & auth | Supabase compute: Micro | $0.00 | assumption |
| Files | Supabase Storage: 1.1 GB, egress 1 GB | $0.00 | verified |
| Worker & backups | Worker VPS × 1 | $22.79 | verified |
| Worker & backups | Encrypted backups on B2 | $0.01 | verified |
| Other | Domain | $1.25 | assumption |
| | **Total** | **$69.07** | |

### 1k users — Managed services: Supabase + Vercel + a worker box

| Group | Line | Monthly | Confidence |
|---|---|---:|---|
| AI | Claude API (Sonnet 5.5), 90 calls | $2.07 | verified |
| Video | JaaS (15 video MAU) | $0.00 | verified |
| Email | Resend Free (3,000/month, 100/day — fine only before real use), 900 emails | $0.00 | verified |
| Hosting | Vercel Pro (1 developer seat) | $20.00 | verified |
| Hosting | Vercel functions + bandwidth beyond the plan | $0.00 | assumption |
| Database & auth | Supabase Pro base | $25.00 | verified |
| Database & auth | Supabase compute: Micro | $0.00 | assumption |
| Files | Supabase Storage: 112.5 GB, egress 70 GB | $0.27 | verified |
| Worker & backups | Worker VPS × 1 | $22.79 | verified |
| Worker & backups | Encrypted backups on B2 | $0.88 | verified |
| Other | Domain | $1.25 | assumption |
| Other | Sentry Team | $26.00 | assumption |
| | **Total** | **$98.25** | |

### 100k users — Managed services: Supabase + Vercel + a worker box

| Group | Line | Monthly | Confidence |
|---|---|---:|---|
| AI | Claude API (Sonnet 5.5), 9,000 calls | $207 | verified |
| Video | Self-hosted Jitsi: 2 bridge box(es) | $160 | assumption |
| Email | Resend Pro 100k, 90,000 emails | $35.00 | verified |
| Hosting | Vercel Pro (1 developer seat) | $20.00 | verified |
| Hosting | Vercel functions + bandwidth beyond the plan | $2.95 | assumption |
| Database & auth | Supabase Pro base | $25.00 | verified |
| Database & auth | Supabase compute: Medium | $50.00 | assumption |
| Database & auth | Database size over 8 GB (332.2 GB) | $40.53 | verified |
| Database & auth | Point-in-time recovery add-on | $100 | verified |
| Database & auth | Realtime connections over 500 | $1.00 | verified |
| Files | Cloudflare R2: 11,250 GB, free egress | $179 | verified |
| Worker & backups | Worker VPS × 1 | $22.79 | verified |
| Worker & backups | Encrypted backups on B2 | $87.89 | verified |
| Other | Domain | $1.25 | assumption |
| Other | Sentry Team | $26.00 | assumption |
| | **Total** | **$958** | |

### 10M users — Self-run: sharded Postgres, own containers, CDN

| Group | Line | Monthly | Confidence |
|---|---|---:|---|
| AI | Claude API (Sonnet 5.5), 900,000 calls | $20,700 | verified |
| Video | Own Jitsi bridges: 200 boxes + bandwidth | $18,236 | assumption |
| Email | AWS SES, our own sending domains, 9,000,000 emails | $900 | assumption |
| Database | 2 Postgres shard(s) (db.r6g.4xlarge Multi-AZ + replica) | $7,884 | third-party |
| Database | Database storage 33,223 GB × 2 copies | $7,641 | assumption |
| Auth | Self-hosted auth service (containers, share of compute) | $120 | assumption |
| Hosting | App servers on containers | $281 | assumption |
| Files | Object storage 1,125,000 GB (R2-class) | $16,875 | assumption |
| Files | CDN egress 699,000 GB at $0.03/GB | $20,970 | assumption |
| Worker & backups | Job workers (pg-boss or successor) + backups | $4,439 | assumption |
| Other | Monitoring, logging, tooling | $8,000 | assumption |
| | **Total** | **$106,046** | |

### 1B users — Multi-region cells, own network edge

| Group | Line | Monthly | Confidence |
|---|---|---:|---|
| AI | Claude API (Sonnet 5.5), 90,000,000 calls | $2,070,000 | verified |
| Video | Own Jitsi bridges: 20,000 boxes + bandwidth | $1,626,147 | assumption |
| Email | AWS SES, our own sending domains, 900,000,000 emails | $90,000 | assumption |
| Database | 121 Postgres shard(s) (db.r6g.4xlarge Multi-AZ + replica) | $476,982 | third-party |
| Database | Database storage 3,322,266 GB × 2 copies | $764,121 | assumption |
| Auth | Self-hosted auth service (containers, share of compute) | $12,000 | assumption |
| Hosting | App servers on containers | $28,080 | assumption |
| Files | Object storage 112,500,000 GB (R2-class) | $1,181,250 | assumption |
| Files | CDN egress 69,900,000 GB at $0.004/GB | $279,600 | assumption |
| Worker & backups | Job workers (pg-boss or successor) + backups | $443,926 | assumption |
| Other | Monitoring, logging, tooling | $200,000 | assumption |
| | **Total** | **$7,172,106** | |

## Worked persona: a Single who uses Make-a-Match + Photos

| Users | Loaded cost / month | Marginal cost / month | Price at 40% margin | Price at 70% margin |
|---|---:|---:|---:|---:|
| 10 | $33.19 | $0.00 | $55.32 | $111 |
| 1k | $0.46 | $0.00 | $0.77 | $1.53 |
| 100k | $0.02 | $0.01 | $0.03 | $0.06 |
| 10M | $0.02 | $0.01 | $0.04 | $0.08 |
| 1B | $0.01 | $0.01 | $0.02 | $0.04 |

<!-- END GENERATED -->
