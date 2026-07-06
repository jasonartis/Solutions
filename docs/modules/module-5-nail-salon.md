# Module 5: Nail Salon (key: `nail-salon`, prefix `sal_`)

## Problem & context

Salon management: booking, in-appointment workflow, billing, light bookkeeping. v1 targets a single salon, but the data model is **org → locations** from day one (decided 2026-07-06) so chains cost a config change, not a migration.

## Roles

Admin (full override, all module areas, user/role management) · Manager · Cashier · Nail worker · Customer.

## Customer

- Books: **service + time required, preferred worker optional** (decided: middle ground — algorithm/manager fills the rest).
- Sees price preview at booking, own history (visits, expenses), receipts in their login.

## Worker

- Sees own schedule; taps next appointment → expands to customer + full care details; calls the customer by name.
- Mid-appointment: checklist, checking off items as accomplished; **minor adjustments** allowed (preferred name, add/subtract care items); **major changes need a manager**.
- Taps **Complete** → appointment locks; moves to next customer.

## Cashier

- Bill generated from work actually done; applies/sees **potential promotions** for this customer; marks paid; prints receipt.
- **Walk-in quick-add** (three taps, no online-booking flow).

## Manager (decided 2026-07-06, includes founder-approved additions)

- Price overrides; customer & worker schedule changes; worker↔customer assignment + **assignment algorithms**; store hours; per-treatment availability; online signup schedules; customer online access.
- **Day view**: live board of all chairs/workers — who's with whom, running late, idle, next up.
- **Service catalog** (manager or admin): name, price, **approximate duration** (drives slot sizing; same for all workers — decided).
- **Reporting**: revenue by day/service/worker; no-show rates; utilization.
- **Policies**: no-show/late-cancel rules, deposits, waitlist handling.
- **Promotions authoring** (cashier surfaces them; manager creates them — by visit count, spend, lapsed customers).
- **Voids/refunds** on locked bills — manager-level escape hatch, audit-trailed.
- Worker time-off & shift management (drives bookable slots).
- **Bookkeeping (decided 2026-07-06):** earnings ledger (fed automatically by paid bills), expenses log with categories, **shopping lists** (to-buy → purchased → becomes an expense entry).

## Appointment lifecycle

State machine: `booked → checked-in → in-progress → complete(locked) → billed → paid` (+ `no-show`, `cancelled`). State drives every role's view.

## Payments & receipts (decided 2026-07-06)

- **Record-keeping, not processing:** cards run on the salon's existing external machine; the app computes the bill, records payment method, prints receipt.
- Receipts: regular printer (print-CSS), **email**, and in-app history. **SMS = documented future option** (Twilio).
- **Card processing = documented future upgrade:** bill/payment rows carry `payment_method` + external-reference fields from day one so Stripe (or similar) plugs in without remodeling.

## Out of v1 (decided)

Tips and worker commissions (noted for future payroll-adjacent work).

## Primitives used

Scheduling/availability (owner), workflow state machines, ledger/expenses (owner), settings+locks, notifications, audit log, reporting/dashboards, email.

## Future enhancements

Card processing (Stripe); SMS receipts/reminders; tips & commissions; multi-location rollout; inventory management (beyond shopping lists).
