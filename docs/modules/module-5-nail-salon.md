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

**Remaining for module 5 (2026-07-09 snapshot, since superseded — see below):** all UI, the shopping-list→expense app action, the assignment-algorithm + reminder worker jobs, the `sal-receipts` storage bucket. Availability/slot math stays in-module until a second module needs a scheduling primitive.

## UI + operational spine shipped (2026-07-09/10)

Day board, booking (operator + customer self-book), worker chair view,
cashier billing, manager back office (catalog/promotions/expenses/shopping→
expense) all shipped — see the CLAUDE.md state log for 2026-07-09/10. Module 5
became usable end-to-end.

## Reporting expansion (2026-07-11)

Manage console gains **Net profit** (revenue − all-time expenses), **Top
services** (billed revenue + count per service, from `sal_bill_items`), and
**expenses by category** (all-time totals). Also fixed a real accuracy bug:
the old "Expenses (recent)" tile silently summed only the last 20 rows (the
same capped query used for the activity log), under-reporting total spend for
any salon with more history — renamed "Total expenses", now sums the full
set. Pure read-only addition, chosen deliberately while the founder's live
testing round was in progress (no new writes, nothing touching booking).

**Still remaining:** the shopping-list→expense app action was already
built; genuinely open items are the assignment-algorithm + reminder worker
jobs, the `sal-receipts` storage bucket, and **per-worker availability
windows** — `sal_worker_profiles.weekly_schedule` and `sal_worker_time_off`
have schema, RLS, and a security review (2026-07-09) but **no UI at all**,
and nothing in the booking flow checks a worker's schedule or time-off
before confirming an appointment. Deliberately deferred (not a quick slice —
needs a JSON shape designed for `weekly_schedule` mirroring
`sal_locations.store_hours`, a manager editor for it, a time-off entry UI,
and real availability-checking logic wired into booking) for a quieter
moment than an active testing round, since a mistake here could wrongly
block or wrongly allow a real booking.

## Worker availability windows shipped (2026-07-16)

Closed the gap flagged above — the module's last purely-buildable remaining
item (no infra/decision blocking it, unlike speed-dating's video or visual
messaging's group-model question). No migration: `sal_worker_profiles.
weekly_schedule` and `sal_worker_time_off` already had schema, RLS, and a
security review from 2026-07-09 — this was app-logic work the schema's own
INTEGRATION NOTE explicitly flagged as deferred ("slot-availability
enforcement is module logic to add at integration; RLS only proves ownership
+ org scoping").

**Design (`modules/nail-salon/ui/availability.ts`, pure functions, no
supabase-js dependency):** `weekly_schedule` mirrors `sal_locations.
store_hours`'s shape (`{"mon":[["09:00","17:00"]], ...}`). An EMPTY/unset
schedule means unrestricted — a worker with nothing configured can be booked
any time, so shipping this couldn't silently make every existing worker
(including the demo seed) unbookable. Once a manager sets ANY day, days left
blank mean "not working that day" — the natural reading of a weekly
schedule, and a deliberate choice over "unset days stay wildcard-open" (which
would make a partial schedule meaningless). Time-off is a simple absolute
overlap check against `starts_at`/`ends_at`. The enforcement is checked ONLY
when a customer/operator names a SPECIFIC worker — "Any worker" bookings
have no assignment engine yet (still explicitly deferred), so there's nobody
whose schedule to check.

**UI:** Manage console gains a **Worker schedules** section — one text
input per weekday (`HH:MM-HH:MM[, HH:MM-HH:MM]`, comma-separated ranges for
breaks, mirroring the exam problem-structure text-parsing convention from
module 2 rather than a heavier structured-input component), plus an add/
remove time-off list per worker. All writes stay manager-tier per the
schema's own note ("worker self-service time-off requests are NOT granted
here"). Enforcement wired into all three booking entry points (operator
book, walk-in, customer self-book) — booking a specific worker outside their
schedule or during time off now throws a clear error instead of silently
overbooking them.

**Still remaining:** the assignment-algorithm + reminder worker jobs (the
latter needs a notification/email primitive that doesn't exist anywhere on
the platform yet — deliberately NOT built speculatively for one module,
per the "extract when a second module needs it" rule) and the
`sal-receipts` storage bucket.

**Customer-path enforcement fixed (2026-07-16, Opus, `20260716010000`).**
The e2e test caught a real gap in the base feature before it shipped as
"working": availability enforcement worked for operate-tier bookers
(manager/cashier) but silently no-opped on the CUSTOMER self-booking path.
`customerBookAppointment` calls the same helper, but `sal_worker_time_off`'s
SELECT policy grants read only to operate-tier callers or the worker
themselves (deliberately — `reason` can hold "medical leave"), so a
customer's own RLS-scoped session saw zero time-off rows and the check passed
trivially. Confirmed by the test: booking Dana-during-time-off as charlie
(customer) wrongly succeeded; as alice (manager) it was correctly rejected —
proving the enforcement logic was right and only the customer read path was
blocked.

The fix (an Opus session, full docs/03 #12 rhythm): a `SECURITY DEFINER`
function `sal_worker_has_time_off(worker, location, window_start, window_end)
→ boolean` that answers ONLY the yes/no overlap question — never the rows,
`reason`, count, or dates — so a customer honors a worker's time off without
any detail leaking (the reveal-only-the-answer pattern of `mm_shared_answers`
/ `cls_material_storage_visible`, NOT a widening of the SELECT policy). The
overlap is only counted when the caller is a member of the org owning the
worker's location (`is_org_member(l.org_id)` inside the `EXISTS`), so a
non-member always gets `false` and cannot probe another tenant's workers.
All three booking paths now route the time-off check through it; the
weekly-schedule half stays in TS (every org member can read
`weekly_schedule`, so RLS never blocked it). Independently security-reviewed
(verdict SHIP AS-IS: no cross-tenant leak — the org is derived through the
worker's own profile/location chain, so an org-B worker can't be paired with
an org-A location to spoof membership), live-verified 4/4 as real users, and
covered by a tracked RLS test (non-member gets `false`) plus the e2e
(customer booking honored) — RLS 15/15, e2e still 31 (test extended, not
added).

## View-as surface review (2026-08-04) — edges ON for staff, OFF for customers

Module 5's own §8.1 point 9 review, the second module to have one (classroom was
first). All nine rank-differential pairs answered with a note each, surfaces
written for the three positions that gained an edge, and every one of the twelve
`sal_` tables classified for each of those positions. One migration
(`20260804010000`), one function, no schema change.

**What is ON.** Mode 1 for all five staff-to-staff pairs (admin → manager /
cashier / worker, manager → cashier / worker); mode 2 additionally for the two
pairs into `worker`. All four pairs into `customer` are OFF.

**Why the split — the fact about this module's RLS.** Salon policies narrow by
**location** for manager and cashier (`sal_can_manage_location` /
`sal_can_operate_location` ask only "does your grant cover this location") and by
**person** only for worker (`worker_id = auth.uid()`, own time-off,
`sal_worker_sees_customer`). So "what does *this* cashier see" has no per-person
answer — every cashier at a store reads the same rows — while "what does *this*
worker see" does. Mode 1 answers "what can the POSITION see", which is useful for
all three; mode 2 answers "what does this PERSON see", which is honest only for
worker. Full reasoning, and why the alternatives (filtering on `created_by` /
`paid_by`) would have UNDER-shown the tab, in docs/15's 2026-08-04 entry.

**Three facts about this module the review pinned down, each read off the policy
SQL rather than inferred from rank:**

- **A cashier cannot read one single revenue row.** `sal_earnings_ledger_select_manage`
  is the module's only manage-tier-read table, with no operate arm — yet the same
  cashier writes `sal_expenses` freely (deliberate, 20260709030000: "cashiers commonly
  log purchases"). Money out, not money in. This is the module's one genuinely
  asymmetric read (not its only one) and it is now stated on the cashier tab.
- **A worker cannot read the earnings rows that carry their own `worker_id`** — nor
  bills, bill items, promotions, expenses, or the shopping list. Six tables, declared
  `unreadableByPosition` so the absence is a stated fact rather than an empty section.
  Consistent with tips/commissions being out of v1, but worth knowing before anyone
  promises a worker an earnings screen.
- **A worker CAN read every colleague's profile and weekly schedule**, because
  `sal_worker_profiles_select_member` is org-member-wide (the founder's deliberate
  "customers see all stores" choice, 20260726010000 §4). The worker tab narrows to the
  target's own profile because their own schedule is what it is for — that narrowing is
  the tab's, not RLS's, and it says so.

**Customers stay OFF, re-decided rather than inherited.** Beyond the product reason
(a customer's history is received as themselves, not duty output), two mechanics from
this module make the pair wrong: customer read access keys on `sal_customers.user_id`,
never on the `module_roles` customer grant, so a mode-2 GRANT triple is the wrong key
entirely; and most customers are **login-less walk-ins** (see the data-browser finding
below), so this could never be the general answer to "what does my customer see". The
question "what do we hold about this customer" is the data browser's, by design.

**Verification:** RLS suite 90/90 (8 new salon tests), 36/36 live probes with zero
skips including a two-store scope-intersection probe, 2 new e2e tests, full
clean-seed e2e runs (see below). All SIX tables behind the seven "cannot read" claims are
**empty on a clean seed** (the seventh claim is the earnings ledger a second time, on the
other surface), so fixtures were built for all of them — otherwise every
assertion would have passed vacuously.

**Two limits of that verification — both CLOSED 2026-08-05 (founder-approved):**

- **The Manager tab had never been rendered in a browser**, because the seed had no salon
  `admin` and a manager holds no edge into their own position. It was verified at the data
  layer at the time (all 11 sections replayed as a temporarily self-granted admin, using the
  query shape `renderSurface` builds — all clean). Now **frank is the seeded salon admin** and
  an e2e opens the tab for real. He is a plain org MEMBER on purpose, so his reads go through
  the module ladder rather than short-circuiting on `is_org_admin()`. It could not be alice:
  she holds `manager`, and adding `admin` to her would make her Manager tab appear and
  silently invert the e2e assertion that it does not.
- **A clean seed left 6 of the manager tab's 11 sections empty** (bills, bill items,
  promotions, earnings, expenses, shopping list), so most of the back office read "Nothing
  here." and a correct empty section was indistinguishable from a broken one. The seed now
  carries **a completed, paid visit dated YESTERDAY** (so the day board, which queries today
  only, is untouched) plus a promotion, an expense and a shopping item. Two details worth
  keeping: the bill is inserted `open` and then UPDATED to `paid`, because `sal_feed_earnings`
  is an AFTER UPDATE trigger keyed on the transition — insert it as `paid` and the earnings
  ledger stays empty, which is the section the whole change exists to fill; and the seeded
  visit reuses Charlie and Dana, so it also gives the worker surface a second, older
  appointment to render.

## Data-browser findings (2026-08-03)

Building the per-person data browser (docs/13, docs/03 #19) surfaced two facts about this
module's schema that are worth recording here, because both are easy to re-derive wrongly.

- **`sal_bills` has no customer column.** The only link to the person who was billed is
  `appointment_id -> sal_appointments.customer_id -> sal_customers.user_id` — two hops. The
  four person columns it *does* carry (`created_by`, `paid_by`, `voided_by`, `refunded_by`)
  are all STAFF: `paid_by` is stamped `auth.uid()` by the trigger on the transition to paid,
  so it is whoever rang it up, not who handed over the money. Anything asking "what do we
  hold about this customer?" must walk the chain; a review caught the data browser showing a
  customer with a real account their appointments and **zero bills** because of this.
  `sal_bill_items` is one hop deeper again.
- **Walk-in customers are not findable by user account, and that is intended.**
  `sal_customers.user_id` is nullable and most rows identify a person by free-text
  `full_name`/`phone`/`email` only. Requiring an account was considered and rejected
  (founder, 2026-08-03) — it works against how a salon operates, where a walk-in gets served
  rather than onboarded. The clean fix, if this ever needs closing, is to let a salon **link**
  an existing walk-in record to an account when that person signs up (a one-time claim), not
  to demand one at the counter. Recorded as a known gap in the data browser's declaration.

  **2026-09-23 — safety analysis of the linking fix, PARKED, nothing built (Sonnet session,
  founder-directed design review).** Two modes were considered; the founder's own question
  ("is self-serve safe? does the same concern apply to staff-driven?") is what surfaced the
  real issue in both, so recording the reasoning, not just the conclusion.

  **Self-serve (customer claims their own walk-in row) is NOT safe as a bare
  type-your-phone-or-email-to-match flow** — a phone/email is knowable by someone who isn't
  the account holder (a coworker, family member, ex), so a naive match-and-claim is a real
  account-takeover vector onto someone else's appointment/notes/spend history. **The fix if
  this is ever built: match only against the caller's own Supabase-auth-VERIFIED signup
  email, never free-text input she types** — she's shown a candidate only when the walk-in
  row's email already equals the email her account proved ownership of at signup, so there's
  nothing to guess. **This also can't be built as pure app code**: `sal_customers`'s only
  UPDATE policy (`sal_customers_write_operate`) is staff-scoped
  (`sal_can_operate_location`) — an ordinary customer has no RLS grant to write this table at
  all today, linked or not. A real self-serve claim needs a new narrowly-scoped SECURITY
  DEFINER function doing the verified-email match and the write server-side. That's
  RLS/migration work (docs/03 #12 rhythm, Opus tier) — **parked here specifically so a
  future session picks up this design, not a weaker one**, when it's actually prioritized.

  **Staff-driven (a manager/cashier links an existing customer) needs no new SQL** — the
  existing `for all` policy already lets operating staff write `user_id` on any row at their
  location — but carries a real concern the founder asked about directly, worth separating
  into two kinds because they need different answers. **(a) Honest mismatch** (two Janes,
  a mistyped digit, a shared family email) — a staff visual driver's-license check
  genuinely helps here, confirming name-on-ID against name-on-file. **(b) A malicious
  staff member** — this is NOT stopped by an ID check (a bad actor doesn't need to lie about
  checking one, they just link it), and it is a DIFFERENT threat than staff simply reading
  customer data on shift, which they already can: linking makes a target's history
  **portable** — viewable from an account off-site, indefinitely, even after the staff
  member's shift or employment ends. **Explicitly do NOT have the app capture or store ID
  data** to "prove" a check happened — a stored license number/scan is a bigger privacy
  liability than the appointment history being protected; if a salon wants an ID-check step,
  it's an operational SOP outside the app, not a feature to build.
  **What the software CAN structurally enforce, if this is built:** restrict the picker to
  `user_id IS NULL` rows only (never let this flow re-point an already-linked row, even
  though the raw policy would technically permit it); log every link action (who linked what
  to what, when) for an audit trail; optionally narrow WHO can link to manager rank rather
  than any operating staff, which would need its own RLS change (separable Opus follow-on,
  not required for a first version).

  **2026-09-23 (cont.) — the audit-trail idea (founder: track who linked, when, and allow
  staff discretion to unlink if it's found wrong), worked through further.**
  **`activity_events` (the existing engagement-monitoring table, already migrated) does NOT
  fit and was deliberately not reused** — checked its actual columns
  (`org_id, module_key, action, scope_ref`, no field for a specific target row or account)
  and its access model (superadmin/hierarchy-gated reads, built to answer "is this org going
  quiet", not to let a cashier look up a specific past decision). Recording a link there would
  say "someone linked something at this salon on this date" — not enough to find or review
  the specific pair. **This still needs new SQL**: a small append-only log (actor, target
  `sal_customers.id`, target account, link/unlink, timestamp) — same shape the platform
  already uses for sensitive reversible actions (`superadmin_lookup_log`). Opus tier
  regardless of how small it looks (new table ⇒ docs/03 #27's revoke-before-grant rhythm
  applies).
  **On "unlink so prior-to-link data reverts but later real activity doesn't" — the
  mechanics make this two different features, not one.** Appointments/bills reference
  `sal_customers.id` directly, never the linked account — linking only points that SAME row's
  `user_id` at an account, so nothing about individual appointments is dated or moved. A plain
  unlink therefore reverts the row's WHOLE history, including anything genuinely hers that
  happened after a mistaken link. Getting precisely "only the pre-link data unlinks" needs
  SPLITTING the identity at the link timestamp — minting a fresh `sal_customers` row for her
  going forward and re-pointing every post-link appointment/bill/ledger row to it. That is
  real, separate data-migration logic (which tables, transactional safety, automated vs.
  manual), not a column flip — its own Opus-tier design question if ever wanted.
  **Recommendation (not decided, no code changed): build the simple version first** — full
  unlink (reverts the whole row) plus the log recording who/when/which-pair for both link and
  unlink. That already delivers both things actually asked for — accountability, and
  reversibility — and matches "allow the cashier... the discretion": if a customer genuinely
  had real visits after a bad link, staff re-links her correctly by hand afterward, a rare
  enough case that automating the split is likely solving for more than has actually happened.
  The log's value stands on its own even without the split: it gives the exact EXPOSURE WINDOW
  (`link_at` → `unlink_at`) for incident response, i.e. precisely what a wrongly-linked account
  could see and for how long.
  **Status: still parked, nothing built, no code changed.** The founder's 2026-08-03
  rejection of forced-account-at-intake stands unless revisited — this analysis doesn't
  change that call, it's here so a future decision to build either mode starts from the real
  risk, not a re-derivation of it.
