// Nail-salon walkthroughs (docs/03 user-walkthrough decision). UPDATE RULE:
// a UI change updates the matching steps here in the same commit.
import type { ModuleHelp } from '@platform/core'

export const nailSalonHelp: ModuleHelp = {
  moduleKey: 'nail-salon',
  guides: [
    {
      role: 'customer',
      title: 'Customer — book appointments and see your visits',
      body: `
1. From the Dashboard, click **Nail Salon** on your organization's card.
2. **Book an appointment**: pick a service (prices shown), optionally a
   preferred worker (or leave "Any worker"), choose a date and time, click
   **Book**.
3. **Your appointments** lists your visits, newest first, each with its
   service and status (booked, complete, paid, …).
4. A *booked* appointment has a **Cancel** button until the salon checks
   you in.
5. **Export data** (Dashboard) downloads your own record and visit history.
`,
    },
    {
      role: 'worker',
      title: 'Worker — run your chairs',
      body: `
1. Open **Nail Salon**. **Your chairs today** lists only the appointments
   assigned to you, in time order, with the customer's name and service.
2. When the front desk checks a customer in, your row shows **Start** — click
   it when you begin.
3. When you finish, click **Complete**. The appointment locks and moves to
   billing; you're on to the next chair.
`,
    },
    {
      role: 'cashier',
      title: 'Cashier — day board, walk-ins, and billing',
      body: `
## The day board

1. Open **Nail Salon**. **Today's board** shows every appointment: time,
   customer, service, worker, and state.
2. Work the lifecycle from the Action column: **Check in** when the customer
   arrives → the worker takes **Start/Complete** → then you **Bill**.
3. **No-show** marks a booked/checked-in appointment that never happened.

## Billing

4. When an appointment shows **Bill**, click it — a bill generates from the
   service's price.
5. Pick the payment method (cash/card/other) and click **Mark paid (…)**.
   The row shows *paid*; the sale feeds the books automatically.

## Walk-ins (three taps)

6. In **Walk-in quick-add**: type the customer's name, pick the service
   (and optionally a worker), click **Add walk-in** — they appear on the
   board already checked in.

## Booking ahead

7. In **Book appointment**: pick customer, service, optionally a worker,
   set the date/time, click **Book**.
`,
    },
    {
      role: 'manager',
      title: 'Manager — catalog, promotions, and the books',
      staff: true,
      body: `
Everything the cashier does, plus the back office at **Nail Salon → Manage**.

## The summary cards

1. **Net revenue** totals the earnings ledger (sales minus refunds);
   **Total expenses** and **Net profit** cover all-time spending and the
   difference; **Revenue by worker** splits sales.

## Service catalog

2. Add a service with name, price, and duration (drives slot sizing) —
   **Add service**. **Deactivate** hides one from booking without deleting.
   **Top services** (just below) ranks every service by revenue billed and
   how many times it's been sold.

## Promotions

3. Create one under **Promotions**: name, kind (visit count / total spend /
   lapsed customer), the threshold (visits, dollars, or days), and the
   discount (% or $). Toggle with **Deactivate/Reactivate**. Cashiers
   surface these at billing.

## Expenses & shopping list

4. **Log expense**: category, description, amount. **By category** (above
   the log) totals all-time spending per category, so you can see where
   the money's going at a glance.
5. **Shopping list**: add items to buy; when purchased, type the ACTUAL
   paid amount next to the item and click **Purchased** — a linked expense
   is created automatically. **Cancel** drops an item.

## Worker schedules

6. **Worker schedules** (bottom of Manage): set each worker's weekly hours,
   one text box per day in \`HH:MM-HH:MM\` form (e.g. \`09:00-13:00,
   14:00-18:00\` for a lunch break; leave a day blank if they don't work
   it). Until you set a schedule for a worker, they can be booked any
   time — setting any day is what turns the restriction on.
7. **Time off**: add a start/end and optional reason; **Remove** clears it.
   A customer or the front desk can no longer book that worker during a
   time-off window — booking with **Any worker** still works (there's no
   auto-assignment yet, so an unassigned booking has nobody's schedule to
   check).
`,
    },
  ],
}
