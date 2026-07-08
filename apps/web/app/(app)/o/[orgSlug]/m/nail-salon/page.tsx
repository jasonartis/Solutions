import Link from 'next/link'
import { requireOrgModule } from '@/lib/module-gate'
import {
  bookAppointment,
  createBillForAppointment,
  markBillPaid,
  setAppointmentState,
  walkInAdd,
} from './actions'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'
const btnCls = 'rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700'
const linkBtn = 'text-xs text-blue-600 hover:underline'

type Appt = {
  id: string
  state: string
  scheduled_start: string
  worker_id: string | null
  customer: { full_name: string } | null
  service: { name: string; price: number } | null
}
type Bill = { id: string; appointment_id: string; state: string; total: number }

// Module 5 (Nail Salon) — role-adaptive operational console.
//   operator (cashier/manager/admin) → today's day board + book + walk-in + billing
//   worker                           → own schedule with check-in/start/complete
//   customer                         → own appointments
export default async function NailSalonPage(props: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await props.params
  const { supabase, org } = await requireOrgModule(orgSlug, 'nail-salon')

  const [{ data: canOperate }, { data: isWorker }, { data: canManage }] = await Promise.all([
    supabase.rpc('sal_can_operate', { check_org_id: org.id }),
    supabase.rpc('sal_is_worker', { check_org_id: org.id }),
    supabase.rpc('sal_can_manage', { check_org_id: org.id }),
  ])

  // One location in v1; the day board is scoped to it.
  const { data: location } = await supabase
    .from('sal_locations')
    .select('id, name')
    .eq('org_id', org.id)
    .order('created_at')
    .limit(1)
    .maybeSingle()

  const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <div className="mb-6 flex items-baseline gap-4">
        <h1 className="text-2xl font-semibold">Nail Salon{location ? ` — ${location.name}` : ''}</h1>
        {canManage && (
          <Link href={`/o/${orgSlug}/m/nail-salon/manage`} className="text-sm text-blue-600 hover:underline">
            Manage
          </Link>
        )}
      </div>

      {!location && <p className="text-gray-500">No location configured yet.</p>}

      {location && canOperate && (
        <OperatorConsole orgSlug={orgSlug} orgId={org.id} locationId={location.id} timeFmt={timeFmt} />
      )}
      {location && !canOperate && isWorker && (
        <WorkerConsole orgSlug={orgSlug} orgId={org.id} timeFmt={timeFmt} />
      )}
      {location && !canOperate && !isWorker && (
        <CustomerConsole orgId={org.id} timeFmt={timeFmt} />
      )}
    </div>
  )
}

function todayRange() {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  return { start: start.toISOString(), end: end.toISOString() }
}

async function OperatorConsole(props: {
  orgSlug: string
  orgId: string
  locationId: string
  timeFmt: Intl.DateTimeFormat
}) {
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  const { start, end } = todayRange()

  const [{ data: appts }, { data: services }, { data: customers }, { data: workers }] = await Promise.all([
    supabase
      .from('sal_appointments')
      .select('id, state, scheduled_start, worker_id, customer:sal_customers(full_name), service:sal_services(name, price)')
      .eq('location_id', props.locationId)
      .gte('scheduled_start', start)
      .lt('scheduled_start', end)
      .order('scheduled_start'),
    supabase.from('sal_services').select('id, name, price').eq('location_id', props.locationId).eq('active', true).order('sort'),
    supabase.from('sal_customers').select('id, full_name').eq('location_id', props.locationId).order('full_name'),
    supabase.from('sal_worker_profiles').select('user_id, display_name').eq('location_id', props.locationId).eq('active', true),
  ])
  const apptRows = (appts ?? []) as unknown as Appt[]
  const apptIds = apptRows.map((a) => a.id)
  const { data: bills } = apptIds.length
    ? await supabase.from('sal_bills').select('id, appointment_id, state, total').in('appointment_id', apptIds)
    : { data: [] as Bill[] }
  const billByAppt = new Map((bills ?? []).map((b) => [b.appointment_id, b as Bill]))
  const workerName = new Map((workers ?? []).map((w) => [w.user_id, w.display_name]))

  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-3 text-lg font-medium">Today&apos;s board</h2>
        {apptRows.length === 0 ? (
          <p className="text-sm text-gray-500">No appointments today.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="py-2 pr-3">Time</th>
                <th className="py-2 pr-3">Customer</th>
                <th className="py-2 pr-3">Service</th>
                <th className="py-2 pr-3">Worker</th>
                <th className="py-2 pr-3">State</th>
                <th className="py-2 pr-3">Action</th>
              </tr>
            </thead>
            <tbody>
              {apptRows.map((a) => {
                const bill = billByAppt.get(a.id)
                return (
                  <tr key={a.id} className="border-b border-gray-100">
                    <td className="py-2 pr-3">{props.timeFmt.format(new Date(a.scheduled_start))}</td>
                    <td className="py-2 pr-3">{a.customer?.full_name ?? '—'}</td>
                    <td className="py-2 pr-3">{a.service?.name ?? '—'}</td>
                    <td className="py-2 pr-3 text-gray-500">{a.worker_id ? workerName.get(a.worker_id) ?? '—' : 'unassigned'}</td>
                    <td className="py-2 pr-3 text-xs uppercase text-gray-400">{a.state.replace('_', ' ')}</td>
                    <td className="py-2 pr-3">
                      <div className="flex flex-wrap items-center gap-2">
                        {a.state === 'booked' && (
                          <form action={setAppointmentState.bind(null, props.orgSlug, a.id, 'checked_in')}>
                            <button className={linkBtn}>Check in</button>
                          </form>
                        )}
                        {a.state === 'checked_in' && (
                          <form action={setAppointmentState.bind(null, props.orgSlug, a.id, 'in_progress')}>
                            <button className={linkBtn}>Start</button>
                          </form>
                        )}
                        {a.state === 'in_progress' && (
                          <form action={setAppointmentState.bind(null, props.orgSlug, a.id, 'complete')}>
                            <button className={linkBtn}>Complete</button>
                          </form>
                        )}
                        {a.state === 'complete' && !bill && (
                          <form action={createBillForAppointment.bind(null, props.orgSlug, a.id)}>
                            <button className={linkBtn}>Bill</button>
                          </form>
                        )}
                        {bill && bill.state === 'open' && (
                          <form
                            action={markBillPaid.bind(null, props.orgSlug, bill.id, a.id)}
                            className="flex items-center gap-1"
                          >
                            <select name="method" className={inputCls} defaultValue="card">
                              <option value="cash">Cash</option>
                              <option value="card">Card</option>
                              <option value="other">Other</option>
                            </select>
                            <button className={linkBtn}>Mark paid (${Number(bill.total).toFixed(0)})</button>
                          </form>
                        )}
                        {bill && bill.state === 'paid' && <span className="text-xs text-green-600">paid</span>}
                        {['booked', 'checked_in'].includes(a.state) && (
                          <form action={setAppointmentState.bind(null, props.orgSlug, a.id, 'no_show')}>
                            <button className="text-xs text-gray-400 hover:underline">No-show</button>
                          </form>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        <div className="rounded-lg border border-gray-200 bg-white p-5">
          <h3 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">Book appointment</h3>
          <form action={bookAppointment.bind(null, props.orgSlug, props.locationId)} className="space-y-2">
            <select name="customerId" required className={`${inputCls} w-full`} defaultValue="">
              <option value="" disabled>Customer…</option>
              {(customers ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.full_name}</option>
              ))}
            </select>
            <select name="serviceId" required className={`${inputCls} w-full`} defaultValue="">
              <option value="" disabled>Service…</option>
              {(services ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.name} (${Number(s.price).toFixed(0)})</option>
              ))}
            </select>
            <select name="workerId" className={`${inputCls} w-full`} defaultValue="">
              <option value="">Any worker</option>
              {(workers ?? []).map((w) => (
                <option key={w.user_id} value={w.user_id}>{w.display_name}</option>
              ))}
            </select>
            <input name="start" type="datetime-local" required className={`${inputCls} w-full`} />
            <button className={btnCls}>Book</button>
          </form>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-5">
          <h3 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">Walk-in quick-add</h3>
          <form action={walkInAdd.bind(null, props.orgSlug, props.locationId)} className="space-y-2">
            <input name="name" required placeholder="Customer name" className={`${inputCls} w-full`} />
            <select name="serviceId" required className={`${inputCls} w-full`} defaultValue="">
              <option value="" disabled>Service…</option>
              {(services ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.name} (${Number(s.price).toFixed(0)})</option>
              ))}
            </select>
            <select name="workerId" className={`${inputCls} w-full`} defaultValue="">
              <option value="">Any worker</option>
              {(workers ?? []).map((w) => (
                <option key={w.user_id} value={w.user_id}>{w.display_name}</option>
              ))}
            </select>
            <button className={btnCls}>Add walk-in</button>
          </form>
        </div>
      </section>
    </div>
  )
}

async function WorkerConsole(props: { orgSlug: string; orgId: string; timeFmt: Intl.DateTimeFormat }) {
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  const { start, end } = todayRange()

  // RLS shows a worker only appointments assigned to them.
  const { data: appts } = await supabase
    .from('sal_appointments')
    .select('id, state, scheduled_start, customer:sal_customers(full_name), service:sal_services(name)')
    .gte('scheduled_start', start)
    .lt('scheduled_start', end)
    .order('scheduled_start')
  const rows = (appts ?? []) as unknown as Appt[]

  return (
    <section>
      <h2 className="mb-3 text-lg font-medium">Your chairs today</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500">No appointments assigned to you today.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((a) => (
            <li key={a.id} className="flex items-center justify-between rounded border border-gray-200 bg-white px-4 py-3">
              <span>
                <span className="text-gray-400">{props.timeFmt.format(new Date(a.scheduled_start))}</span>{' '}
                <span className="font-medium">{a.customer?.full_name}</span> · {a.service?.name}
                <span className="ml-2 text-xs uppercase text-gray-400">{a.state.replace('_', ' ')}</span>
              </span>
              <span className="flex gap-2">
                {a.state === 'checked_in' && (
                  <form action={setAppointmentState.bind(null, props.orgSlug, a.id, 'in_progress')}>
                    <button className={linkBtn}>Start</button>
                  </form>
                )}
                {a.state === 'in_progress' && (
                  <form action={setAppointmentState.bind(null, props.orgSlug, a.id, 'complete')}>
                    <button className={linkBtn}>Complete</button>
                  </form>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

async function CustomerConsole(props: { orgId: string; timeFmt: Intl.DateTimeFormat }) {
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  // RLS shows a customer only their own appointments.
  const { data: appts } = await supabase
    .from('sal_appointments')
    .select('id, state, scheduled_start, service:sal_services(name, price)')
    .order('scheduled_start', { ascending: false })
    .limit(20)
  const rows = (appts ?? []) as unknown as Appt[]

  const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return (
    <section>
      <h2 className="mb-3 text-lg font-medium">Your appointments</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500">You have no appointments yet.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {rows.map((a) => (
            <li key={a.id} className="flex justify-between rounded border border-gray-100 bg-white px-3 py-2">
              <span>{dateFmt.format(new Date(a.scheduled_start))} · {a.service?.name}</span>
              <span className="text-xs uppercase text-gray-400">{a.state.replace('_', ' ')}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
