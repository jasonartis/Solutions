// Nail-salon export manifest — the module the founder's authorship example
// was about (docs/03): a cashier/worker may SEE customers all day to do the
// job, but visibility confers no export of client details. So:
//   customer  → their OWN record and transaction history (they are the party)
//   worker    → the work THEY performed (no customer personal details)
//   cashier   → the bills THEY processed (amounts/methods, no client details)
//   manager   → the business domain they operate (books, catalog, ledger)
import type { ExportDb, ExportContext, ModuleExport } from '@platform/core'

async function rows(query: any): Promise<Record<string, unknown>[]> {
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return data ?? []
}

export const nailSalonExport: ModuleExport = {
  moduleKey: 'nail-salon',
  hats: [
    { key: 'manager', label: 'Manager (business data)' },
    { key: 'cashier', label: 'Cashier (bills I processed)' },
    { key: 'worker', label: 'Worker (my work)' },
    { key: 'customer', label: 'Customer (my visits & bills)' },
  ],
  async myHats(db: ExportDb, ctx: ExportContext) {
    const hats: string[] = []
    const { data: manage } = await db.rpc('sal_can_manage', { check_org_id: ctx.orgId })
    const { data: operate } = await db.rpc('sal_can_operate', { check_org_id: ctx.orgId })
    const { data: worker } = await db.rpc('sal_is_worker', { check_org_id: ctx.orgId })
    const { data: customer } = await db.rpc('has_module_role', {
      check_org_id: ctx.orgId,
      check_module_key: 'nail-salon',
      check_role: 'customer',
    })
    if (manage) hats.push('manager')
    if (operate) hats.push('cashier')
    if (worker) hats.push('worker')
    if (customer) hats.push('customer')
    return hats
  },
  dataSets: [
    // --- Customer: their own record + transactions ---------------------------
    {
      key: 'my-customer-record',
      label: 'My customer record',
      hats: ['customer'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('sal_customers')
            .select('full_name, phone, email, notes, created_at')
            .eq('org_id', ctx.orgId)
            .eq('user_id', ctx.userId),
        ),
    },
    {
      key: 'my-appointments',
      label: 'My appointments & visit history',
      hats: ['customer'],
      fetch: async (db, ctx) => {
        const { data: mine } = await db
          .from('sal_customers')
          .select('id')
          .eq('org_id', ctx.orgId)
          .eq('user_id', ctx.userId)
        const ids = (mine ?? []).map((c: { id: string }) => c.id)
        if (ids.length === 0) return []
        return rows(
          db
            .from('sal_appointments')
            .select('scheduled_start, state, service:sal_services(name, price)')
            .in('customer_id', ids),
        )
      },
    },
    // --- Worker: the work they performed (no client personal details) --------
    {
      key: 'my-served-appointments',
      label: 'Appointments I served',
      description: 'dates, services, checklists — no customer details',
      hats: ['worker'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('sal_appointments')
            .select('scheduled_start, state, checklist, service:sal_services(name)')
            .eq('org_id', ctx.orgId)
            .eq('worker_id', ctx.userId),
        ),
    },
    // --- Cashier: the bills they processed (no client details) ---------------
    {
      key: 'my-processed-bills',
      label: 'Bills I created',
      description: 'amounts and methods — no customer details',
      hats: ['cashier'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('sal_bills')
            .select('state, subtotal, discount_total, total, payment_method, paid_at, created_at')
            .eq('org_id', ctx.orgId)
            .eq('created_by', ctx.userId),
        ),
    },
    // --- Manager: the business domain ----------------------------------------
    {
      key: 'service-catalog',
      label: 'Service catalog',
      hats: ['manager'],
      fetch: (db, ctx) =>
        rows(db.from('sal_services').select('name, price, approx_duration_minutes, active').eq('org_id', ctx.orgId)),
    },
    {
      key: 'earnings-ledger',
      label: 'Earnings ledger',
      hats: ['manager'],
      fetch: (db, ctx) =>
        rows(db.from('sal_earnings_ledger').select('kind, amount, occurred_at, worker_id').eq('org_id', ctx.orgId)),
    },
    {
      key: 'expenses',
      label: 'Expenses & shopping list',
      hats: ['manager'],
      fetch: async (db, ctx) => {
        const expenses = await rows(
          db.from('sal_expenses').select('category, description, amount, spent_at').eq('org_id', ctx.orgId),
        )
        return expenses
      },
    },
    {
      key: 'appointments-book',
      label: 'Full appointment book',
      hats: ['manager'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('sal_appointments')
            .select('scheduled_start, scheduled_end, state, customer:sal_customers(full_name), service:sal_services(name), worker_id')
            .eq('org_id', ctx.orgId),
        ),
    },
  ],
}
