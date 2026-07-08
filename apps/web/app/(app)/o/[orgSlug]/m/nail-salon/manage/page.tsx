import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireOrgModule } from '@/lib/module-gate'
import {
  addExpense,
  addShoppingItem,
  cancelShoppingItem,
  createPromotion,
  createService,
  purchaseShoppingItem,
  setPromotionActive,
  setServiceActive,
} from './actions'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'
const btnCls = 'rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700'
const linkBtn = 'text-xs text-blue-600 hover:underline'

// Manager back-office: service catalog, promotions, earnings summary,
// expenses, shopping list. sal_can_manage gates the page (RLS decides).
export default async function SalonManagePage(props: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await props.params
  const { supabase, org } = await requireOrgModule(orgSlug, 'nail-salon')

  const { data: canManage } = await supabase.rpc('sal_can_manage', { check_org_id: org.id })
  if (!canManage) notFound()

  const { data: location } = await supabase
    .from('sal_locations')
    .select('id, name')
    .eq('org_id', org.id)
    .order('created_at')
    .limit(1)
    .maybeSingle()
  if (!location) notFound()

  const [{ data: services }, { data: promotions }, { data: earnings }, { data: expenses }, { data: shopping }, { data: workers }] =
    await Promise.all([
      supabase.from('sal_services').select('id, name, price, approx_duration_minutes, active').eq('location_id', location.id).order('sort'),
      supabase.from('sal_promotions').select('id, name, kind, threshold, lapsed_days, discount_type, discount_value, active').eq('location_id', location.id).order('created_at'),
      supabase.from('sal_earnings_ledger').select('kind, amount, worker_id, occurred_at').eq('location_id', location.id),
      supabase.from('sal_expenses').select('id, category, description, amount, spent_at').eq('location_id', location.id).order('spent_at', { ascending: false }).limit(20),
      supabase.from('sal_shopping_list').select('id, item, quantity, estimated_cost, status').eq('location_id', location.id).order('created_at', { ascending: false }).limit(30),
      supabase.from('sal_worker_profiles').select('user_id, display_name').eq('location_id', location.id),
    ])

  const revenue = (earnings ?? []).reduce((sum, e) => sum + Number(e.amount), 0)
  const spent = (expenses ?? []).reduce((sum, e) => sum + Number(e.amount), 0)
  const workerName = new Map((workers ?? []).map((w) => [w.user_id, w.display_name]))
  const byWorker = new Map<string, number>()
  for (const e of earnings ?? []) {
    if (!e.worker_id) continue
    byWorker.set(e.worker_id, (byWorker.get(e.worker_id) ?? 0) + Number(e.amount))
  }
  const fmtMoney = (n: number) => `$${n.toFixed(2)}`
  const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <div className="mb-6 flex items-baseline gap-4">
        <h1 className="text-2xl font-semibold">Salon — Manage</h1>
        <Link href={`/o/${orgSlug}/m/nail-salon`} className="text-sm text-blue-600 hover:underline">
          ← Day board
        </Link>
      </div>

      <section className="mb-8 grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-gray-500">Net revenue (ledger)</p>
          <p className="text-2xl font-semibold">{fmtMoney(revenue)}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-gray-500">Expenses (recent)</p>
          <p className="text-2xl font-semibold">{fmtMoney(spent)}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-gray-500">Revenue by worker</p>
          <ul className="text-sm text-gray-700">
            {[...byWorker.entries()].map(([id, amt]) => (
              <li key={id} className="flex justify-between">
                <span>{workerName.get(id) ?? id.slice(0, 8)}</span>
                <span>{fmtMoney(amt)}</span>
              </li>
            ))}
            {byWorker.size === 0 && <li className="text-gray-400">No paid bills yet.</li>}
          </ul>
        </div>
      </section>

      <section className="mb-8 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-3 text-lg font-medium">Service catalog</h2>
        <ul className="mb-4 space-y-1 text-sm">
          {(services ?? []).map((s) => (
            <li key={s.id} className="flex items-center justify-between">
              <span className={s.active ? '' : 'text-gray-400 line-through'}>
                {s.name} · {fmtMoney(Number(s.price))} · {s.approx_duration_minutes} min
              </span>
              <form action={setServiceActive.bind(null, orgSlug, s.id, !s.active)}>
                <button className={linkBtn}>{s.active ? 'Deactivate' : 'Reactivate'}</button>
              </form>
            </li>
          ))}
        </ul>
        <form action={createService.bind(null, orgSlug, location.id)} className="flex flex-wrap items-center gap-2">
          <input name="name" required placeholder="Service name" className={`${inputCls} min-w-48`} />
          <input name="price" required type="number" step="0.01" min="0" placeholder="Price" className={`${inputCls} w-24`} />
          <input name="duration" required type="number" min="5" placeholder="Minutes" className={`${inputCls} w-24`} />
          <button className={btnCls}>Add service</button>
        </form>
      </section>

      <section className="mb-8 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-3 text-lg font-medium">Promotions</h2>
        <ul className="mb-4 space-y-1 text-sm">
          {(promotions ?? []).map((p) => (
            <li key={p.id} className="flex items-center justify-between">
              <span className={p.active ? '' : 'text-gray-400 line-through'}>
                {p.name} — {p.kind === 'lapsed' ? `${p.lapsed_days}+ days lapsed` : `${p.kind.replace('_', ' ')} ≥ ${p.threshold}`}
                {' → '}
                {p.discount_type === 'percent' ? `${Number(p.discount_value)}% off` : `${fmtMoney(Number(p.discount_value))} off`}
              </span>
              <form action={setPromotionActive.bind(null, orgSlug, p.id, !p.active)}>
                <button className={linkBtn}>{p.active ? 'Deactivate' : 'Reactivate'}</button>
              </form>
            </li>
          ))}
          {(promotions ?? []).length === 0 && <li className="text-gray-400">No promotions yet.</li>}
        </ul>
        <form action={createPromotion.bind(null, orgSlug, location.id)} className="flex flex-wrap items-center gap-2">
          <input name="name" required placeholder="Promotion name" className={`${inputCls} min-w-40`} />
          <select name="kind" className={inputCls} defaultValue="visit_count">
            <option value="visit_count">By visit count</option>
            <option value="spend">By total spend</option>
            <option value="lapsed">Lapsed customer</option>
          </select>
          <input name="threshold" type="number" min="0" placeholder="Threshold / days" className={`${inputCls} w-32`} />
          <select name="discountType" className={inputCls} defaultValue="percent">
            <option value="percent">% off</option>
            <option value="amount">$ off</option>
          </select>
          <input name="discountValue" required type="number" step="0.01" min="0" placeholder="Value" className={`${inputCls} w-24`} />
          <button className={btnCls}>Add promotion</button>
        </form>
      </section>

      <section className="mb-8 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-3 text-lg font-medium">Expenses</h2>
        <ul className="mb-4 space-y-1 text-sm">
          {(expenses ?? []).map((e) => (
            <li key={e.id} className="flex justify-between">
              <span>
                <span className="text-gray-400">{dateFmt.format(new Date(e.spent_at))} · </span>
                <span className="uppercase text-xs text-gray-400">{e.category}</span> {e.description}
              </span>
              <span>{fmtMoney(Number(e.amount))}</span>
            </li>
          ))}
          {(expenses ?? []).length === 0 && <li className="text-gray-400">No expenses logged.</li>}
        </ul>
        <form action={addExpense.bind(null, orgSlug, location.id)} className="flex flex-wrap items-center gap-2">
          <input name="category" required placeholder="Category" className={`${inputCls} w-32`} />
          <input name="description" placeholder="Description" className={`${inputCls} min-w-48`} />
          <input name="amount" required type="number" step="0.01" min="0" placeholder="Amount" className={`${inputCls} w-24`} />
          <button className={btnCls}>Log expense</button>
        </form>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-3 text-lg font-medium">Shopping list</h2>
        <ul className="mb-4 space-y-2 text-sm">
          {(shopping ?? []).map((s) => (
            <li key={s.id} className="flex items-center justify-between">
              <span className={s.status !== 'to_buy' ? 'text-gray-400' : ''}>
                {s.item} ×{s.quantity}
                {s.estimated_cost !== null && <span className="text-gray-400"> (est. {fmtMoney(Number(s.estimated_cost))})</span>}
                <span className="ml-2 text-xs uppercase text-gray-400">{s.status.replace('_', ' ')}</span>
              </span>
              {s.status === 'to_buy' && (
                <span className="flex items-center gap-2">
                  <form action={purchaseShoppingItem.bind(null, orgSlug, s.id)} className="flex items-center gap-1">
                    <input name="cost" required type="number" step="0.01" min="0" placeholder="Paid" className={`${inputCls} w-20`} />
                    <button className={linkBtn}>Purchased</button>
                  </form>
                  <form action={cancelShoppingItem.bind(null, orgSlug, s.id)}>
                    <button className="text-xs text-gray-400 hover:underline">Cancel</button>
                  </form>
                </span>
              )}
            </li>
          ))}
          {(shopping ?? []).length === 0 && <li className="text-gray-400">Nothing on the list.</li>}
        </ul>
        <form action={addShoppingItem.bind(null, orgSlug, location.id)} className="flex flex-wrap items-center gap-2">
          <input name="item" required placeholder="Item to buy" className={`${inputCls} min-w-48`} />
          <input name="estimated" type="number" step="0.01" min="0" placeholder="Est. cost" className={`${inputCls} w-24`} />
          <button className={btnCls}>Add item</button>
        </form>
      </section>
    </div>
  )
}
