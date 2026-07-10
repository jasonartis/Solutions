'use server'

import { revalidatePath } from 'next/cache'
import { DERIVED_SCOPE_PLACEHOLDER as PLACEHOLDER } from '@platform/core'
import { createClient } from '@/lib/supabase/server'

// Nail-salon operational actions. RLS (sal_can_operate / sal_is_worker) plus
// the sal_pin_appointment lifecycle trigger are the enforcement layer; these
// actions just shape input. org_id/location_id are derived by scope triggers,
// so callers send only the FK ids.

function fail(error: { message: string } | null, what: string) {
  if (error) throw new Error(`${what}: ${error.message}`)
}

async function resolveOrgId(supabase: Awaited<ReturnType<typeof createClient>>, orgSlug: string) {
  const { data: org } = await supabase.from('orgs').select('id').eq('slug', orgSlug).single()
  if (!org) throw new Error('Org not found')
  return org.id as string
}

// Operator books an appointment. scheduled_end is derived from the service's
// approx_duration_minutes so the day board and slot math don't recompute it.
export async function bookAppointment(orgSlug: string, locationId: string, formData: FormData) {
  const customerId = String(formData.get('customerId') ?? '')
  const serviceId = String(formData.get('serviceId') ?? '')
  const workerId = String(formData.get('workerId') ?? '') || null
  const startRaw = String(formData.get('start') ?? '').trim()
  if (!customerId || !serviceId || !startRaw) throw new Error('Customer, service, and time are required')

  const supabase = await createClient()
  const { data: svc } = await supabase
    .from('sal_services')
    .select('approx_duration_minutes')
    .eq('id', serviceId)
    .single()
  const start = new Date(startRaw)
  const end = new Date(start.getTime() + (svc?.approx_duration_minutes ?? 30) * 60000)

  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase.from('sal_appointments').insert({
    org_id: PLACEHOLDER, // derived by trigger
    location_id: locationId,
    customer_id: customerId,
    service_id: serviceId,
    worker_id: workerId,
    scheduled_start: start.toISOString(),
    scheduled_end: end.toISOString(),
    state: 'booked',
    booked_by: user?.id ?? null,
  })
  fail(error, 'Booking failed')
  revalidatePath(`/o/${orgSlug}/m/nail-salon`)
}

// Walk-in quick-add: create a login-less customer and immediately book them.
export async function walkInAdd(orgSlug: string, locationId: string, formData: FormData) {
  const name = String(formData.get('name') ?? '').trim()
  const serviceId = String(formData.get('serviceId') ?? '')
  const workerId = String(formData.get('workerId') ?? '') || null
  if (!name || !serviceId) throw new Error('Name and service are required')

  const supabase = await createClient()
  const { data: cust, error: custErr } = await supabase
    .from('sal_customers')
    .insert({ org_id: PLACEHOLDER, location_id: locationId, full_name: name })
    .select('id')
    .single()
  fail(custErr, 'Walk-in customer failed')

  const { data: svc } = await supabase
    .from('sal_services')
    .select('approx_duration_minutes')
    .eq('id', serviceId)
    .single()
  const start = new Date()
  const end = new Date(start.getTime() + (svc?.approx_duration_minutes ?? 30) * 60000)
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase.from('sal_appointments').insert({
    org_id: PLACEHOLDER,
    location_id: locationId,
    customer_id: cust!.id,
    service_id: serviceId,
    worker_id: workerId,
    scheduled_start: start.toISOString(),
    scheduled_end: end.toISOString(),
    state: 'checked_in', // walk-ins are physically present
    booked_by: user?.id ?? null,
  })
  fail(error, 'Walk-in booking failed')
  revalidatePath(`/o/${orgSlug}/m/nail-salon`)
}

// Advance an appointment's state. The sal_pin_appointment trigger enforces
// which transitions each role may make; this just submits the requested one.
export async function setAppointmentState(orgSlug: string, appointmentId: string, state: string) {
  const supabase = await createClient()
  const patch: Record<string, unknown> = { state }
  if (state === 'cancelled') patch.cancelled_at = new Date().toISOString()
  const { error } = await supabase.from('sal_appointments').update(patch).eq('id', appointmentId)
  fail(error, `Set state ${state} failed`)
  revalidatePath(`/o/${orgSlug}/m/nail-salon`)
}

// Generate a bill from the appointment's service and mark the appointment
// billed. One bill per appointment (unique) — safe to call once.
export async function createBillForAppointment(orgSlug: string, appointmentId: string) {
  const supabase = await createClient()
  const { data: appt } = await supabase
    .from('sal_appointments')
    .select('id, service_id, service:sal_services(name, price)')
    .eq('id', appointmentId)
    .single()
  if (!appt) throw new Error('Appointment not found')
  const service = appt.service as unknown as { name: string; price: number } | null
  const price = Number(service?.price ?? 0)

  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { data: bill, error: billErr } = await supabase
    .from('sal_bills')
    .insert({
      org_id: PLACEHOLDER,
      location_id: PLACEHOLDER,
      appointment_id: appointmentId,
      subtotal: price,
      total: price,
      created_by: user?.id ?? null,
    })
    .select('id')
    .single()
  fail(billErr, 'Create bill failed')

  const { error: itemErr } = await supabase.from('sal_bill_items').insert({
    org_id: PLACEHOLDER,
    location_id: PLACEHOLDER,
    bill_id: bill!.id,
    service_id: appt.service_id,
    description: service?.name ?? 'Service',
    quantity: 1,
    unit_price: price,
    line_total: price,
  })
  fail(itemErr, 'Add bill item failed')

  await supabase.from('sal_appointments').update({ state: 'billed' }).eq('id', appointmentId)
  revalidatePath(`/o/${orgSlug}/m/nail-salon`)
}

// Record payment method + mark paid (sal_guard_bill stamps paid_by/paid_at and
// the sal_feed_earnings trigger writes the earnings-ledger row). Also advances
// the appointment to paid.
export async function markBillPaid(orgSlug: string, billId: string, appointmentId: string, formData: FormData) {
  const method = String(formData.get('method') ?? 'cash')
  const supabase = await createClient()
  const { error } = await supabase
    .from('sal_bills')
    .update({ state: 'paid', payment_method: method })
    .eq('id', billId)
  fail(error, 'Mark paid failed')
  await supabase.from('sal_appointments').update({ state: 'paid' }).eq('id', appointmentId)
  revalidatePath(`/o/${orgSlug}/m/nail-salon`)
}

// Customer self-booking (spec: service + time required, preferred worker
// optional). RLS's sal_appointments_insert_customer policy proves the caller
// owns the customer record and forces state='booked'; the pin trigger keeps
// later edits to cancel-only.
export async function customerBookAppointment(orgSlug: string, formData: FormData) {
  const serviceId = String(formData.get('serviceId') ?? '')
  const workerId = String(formData.get('workerId') ?? '') || null
  const startRaw = String(formData.get('start') ?? '').trim()
  if (!serviceId || !startRaw) throw new Error('Service and time are required')

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')

  // The caller's own customer record supplies the location.
  const { data: me } = await supabase
    .from('sal_customers')
    .select('id, location_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()
  if (!me) throw new Error('No customer record — ask the salon to set you up')

  const { data: svc } = await supabase
    .from('sal_services')
    .select('approx_duration_minutes')
    .eq('id', serviceId)
    .single()
  const start = new Date(startRaw)
  const end = new Date(start.getTime() + (svc?.approx_duration_minutes ?? 30) * 60000)

  const { error } = await supabase.from('sal_appointments').insert({
    org_id: PLACEHOLDER, // derived by trigger
    location_id: me.location_id,
    customer_id: me.id,
    service_id: serviceId,
    worker_id: workerId,
    scheduled_start: start.toISOString(),
    scheduled_end: end.toISOString(),
    state: 'booked',
    booked_by: user.id,
  })
  fail(error, 'Booking failed')
  revalidatePath(`/o/${orgSlug}/m/nail-salon`)
}
