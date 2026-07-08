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

## Schema integrated (2026-07-09)

`sal_` tables live (`supabase/migrations/20260709030000_nail_salon.sql`, local + prod): `sal_locations`, `sal_services`, `sal_worker_profiles`, `sal_worker_time_off`, `sal_customers`, `sal_promotions`, `sal_appointments`, `sal_bills`, `sal_bill_items`, `sal_earnings_ledger`, `sal_expenses`, `sal_shopping_list`. Manifest registered (`packages/platform/src/modules.ts`) but **not enabled for any org** — schema only, no UI yet, so it stays dark. Drafted by a background agent, then hand security-reviewed (draft in `modules/nail-salon/schema-draft.sql`, fixes in `schema-fixes.sql`).

Key design choices: org→location on nearly every table (chain = config change, not migration); customers are not necessarily auth users (walk-ins get a login-less row, `user_id` set only on granted online access); workers = `module_roles('nail-salon','worker')` + a per-location `sal_worker_profiles` row, with `sal_appointments.worker_id` referencing `auth.users` directly so schedule RLS is a plain `worker_id = auth.uid()`; three RLS tiers (`sal_can_manage` ⊇ `sal_can_operate` ⊇ cashier, plus `sal_is_worker` and customer-owns-row); `sal_bills` carries `payment_method`/`external_processor`/`external_reference` from day one for a future Stripe plug-in (record-keeping only in v1); `sal_feed_earnings` auto-feeds the earnings ledger on paid/refunded.

Security-review fixes (verified live, 18/18 guard assertions): (1) `sal_pin_appointment` — operators keep full control; a worker may only tick checklist/notes and advance their own appointment along its lane (checked_in→in_progress→complete/no_show), every other column pinned and out-of-lane transitions rejected, and a completed row locks; a customer may only cancel their own still-booked appointment. Named to sort before the scope trigger so a bogus `location_id` is reverted before `org_id` is derived from it. (2) `sal_guard_bill` — void/refund require manager tier and stamp `voided_by/refunded_by` + timestamps server-side; once paid/void/refunded, monetary + payment columns and state are immutable to non-managers; paid metadata stamped server-side.

**Remaining for module 5:** all UI (booking flow + price preview, worker chair view with checklist, cashier billing + walk-in quick-add, manager day-board/catalog/promotions/reporting/bookkeeping), the shopping-list→expense app action, the assignment-algorithm + reminder worker jobs, and the `sal-receipts` storage bucket + policies. Availability/slot math stays in-module until a second module needs a scheduling primitive.
