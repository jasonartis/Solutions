# Costs — ideas for later (NOT built, NOT decided)

> Written 2026-11-10 (Sonnet) from the founder's "any other ideas?" question. Nothing here is started; the founder
> initiates each one. Items marked **migration** go through the docs/03 #12 rhythm (Opus-tier).

## Founder decisions so far

- **Payments (2026-11-10): start BY HAND** — invoice clients yourself, click "mark paid". No card processing (Stripe adds
  ~3% and a compliance burden). Revisit when there are enough clients that chasing payments by hand hurts.
- Pricing structure (2026-11-09): base fee per organisation + credits for AI calls and video minutes. Built in `/console/costs`.

## A. Tracking and forecasting costs

| # | Idea | What it does | Needs |
|---|---|---|---|
| A1 | **Actuals ledger** | Record what each vendor really billed each month (reads docs/28's vendor accounts); page shows model vs actual and the gap | migration |
| A2 | **Variance alert** | Badge when a bill is >20% over forecast | A1 |
| A3 | **Saved named scenarios** | Keep "10 clients, 2 modules" etc. in the database instead of this browser only | migration |
| A4 | **Dashboard badges** | On the superadmin home: stale prices (>90 days), over-forecast, a free plan nearing its limit | A1, the home dashboard in module-9 spec §H |
| A5 | **Quarterly price re-fetch** | A scheduled agent re-reads vendor prices, lists what changed, founder approves; refreshes the `checked` dates | scheduled agent |
| A6 | **Cost per client** | Each org's share of the fixed floor plus its own AI/video use — shows unprofitable clients | usage counters per org |
| A7 | **Run-out date** | Months of cash the current spend covers | founder enters balance |
| A8 | **Plan-limit warnings** | Alert before a free-plan limit forces a surprise upgrade | vendor usage numbers |
| A9 | **Measured replaces assumed** | After a real client's first month, replace `assumptions.md` numbers with measured ones | a real client |
| A10 | **Resilience costs** | Fold docs/28 Part B standby/evacuation costs into the model | docs/costs/resilience.md |

## B. Client payments and lateness (receivables) — by hand first

Per client organisation: agreed base fee and billing day; invoices (amount, due date, paid date); status paid / due soon /
late N days / written off; a "mark paid" button; optional reminder emails (day 1, 7, 14 after due — needs the custom SMTP
blocker cleared, docs/18 item 7); dashboard badge "3 clients late, $450 outstanding"; a monthly "collected vs expected"
line beside the cost forecast. Card processing is a later, separate decision.

## C. Open questions

1. Build A1 and B as ONE migration (both hang off the vendor accounts / org tables)? See the 2026-11-10 chat answer.
2. Where does a client's agreed fee live — on the org row, or a separate contract table (so price changes keep history)?
3. Do clients see their own invoices in the app, or is it superadmin-only at first?
