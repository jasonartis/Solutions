'use server'

import { revalidatePath } from 'next/cache'
import { DERIVED_SCOPE_PLACEHOLDER as PLACEHOLDER } from '@platform/core'
import { createClient } from '@/lib/supabase/server'

// Manager back-office actions: service catalog, promotions, bookkeeping.
// RLS enforces tiers — catalog/promotions are sal_can_manage (blanket manage
// policy), expenses/shopping are sal_can_operate. org_id derives from the
// location via scope-sync triggers.

function fail(error: { message: string } | null, what: string) {
  if (error) throw new Error(`${what}: ${error.message}`)
}

export async function createService(orgSlug: string, locationId: string, formData: FormData) {
  const name = String(formData.get('name') ?? '').trim()
  const price = Number(formData.get('price'))
  const duration = Number(formData.get('duration'))
  if (!name || Number.isNaN(price) || Number.isNaN(duration) || duration <= 0) {
    throw new Error('Name, price, and duration are required')
  }

  const supabase = await createClient()
  const { error } = await supabase.from('sal_services').insert({
    org_id: PLACEHOLDER, // derived by trigger
    location_id: locationId,
    name,
    price,
    approx_duration_minutes: duration,
  })
  fail(error, 'Create service failed')
  revalidatePath(`/o/${orgSlug}/m/nail-salon/manage`)
  revalidatePath(`/o/${orgSlug}/m/nail-salon`)
}

export async function setServiceActive(orgSlug: string, serviceId: string, active: boolean) {
  const supabase = await createClient()
  const { error } = await supabase.from('sal_services').update({ active }).eq('id', serviceId)
  fail(error, 'Update service failed')
  revalidatePath(`/o/${orgSlug}/m/nail-salon/manage`)
  revalidatePath(`/o/${orgSlug}/m/nail-salon`)
}

export async function createPromotion(orgSlug: string, locationId: string, formData: FormData) {
  const name = String(formData.get('name') ?? '').trim()
  const kind = String(formData.get('kind') ?? 'visit_count')
  const threshold = Number(formData.get('threshold'))
  const discountType = String(formData.get('discountType') ?? 'percent')
  const discountValue = Number(formData.get('discountValue'))
  if (!name || Number.isNaN(discountValue)) throw new Error('Name and discount are required')

  const supabase = await createClient()
  const { error } = await supabase.from('sal_promotions').insert({
    org_id: PLACEHOLDER, // derived by trigger
    location_id: locationId,
    name,
    kind,
    threshold: kind === 'lapsed' ? null : threshold || null,
    lapsed_days: kind === 'lapsed' ? threshold || null : null,
    discount_type: discountType,
    discount_value: discountValue,
  })
  fail(error, 'Create promotion failed')
  revalidatePath(`/o/${orgSlug}/m/nail-salon/manage`)
}

export async function setPromotionActive(orgSlug: string, promotionId: string, active: boolean) {
  const supabase = await createClient()
  const { error } = await supabase.from('sal_promotions').update({ active }).eq('id', promotionId)
  fail(error, 'Update promotion failed')
  revalidatePath(`/o/${orgSlug}/m/nail-salon/manage`)
}

export async function addExpense(orgSlug: string, locationId: string, formData: FormData) {
  const category = String(formData.get('category') ?? '').trim()
  const description = String(formData.get('description') ?? '').trim() || null
  const amount = Number(formData.get('amount'))
  if (!category || Number.isNaN(amount) || amount < 0) throw new Error('Category and amount are required')

  const supabase = await createClient()
  const { error } = await supabase.from('sal_expenses').insert({
    org_id: PLACEHOLDER, // derived by trigger
    location_id: locationId,
    category,
    description,
    amount,
  })
  fail(error, 'Add expense failed')
  revalidatePath(`/o/${orgSlug}/m/nail-salon/manage`)
}

export async function addShoppingItem(orgSlug: string, locationId: string, formData: FormData) {
  const item = String(formData.get('item') ?? '').trim()
  const estimated = Number(formData.get('estimated'))
  if (!item) throw new Error('Item is required')

  const supabase = await createClient()
  const { error } = await supabase.from('sal_shopping_list').insert({
    org_id: PLACEHOLDER, // derived by trigger
    location_id: locationId,
    item,
    estimated_cost: Number.isNaN(estimated) ? null : estimated,
  })
  fail(error, 'Add shopping item failed')
  revalidatePath(`/o/${orgSlug}/m/nail-salon/manage`)
}

// Mark purchased with the ACTUAL paid cost: creates the expense entry and
// links both directions (spec: to-buy -> purchased -> becomes an expense).
export async function purchaseShoppingItem(orgSlug: string, itemId: string, formData: FormData) {
  const cost = Number(formData.get('cost'))
  if (Number.isNaN(cost) || cost < 0) throw new Error('Actual cost is required')

  const supabase = await createClient()
  const { data: item } = await supabase
    .from('sal_shopping_list')
    .select('id, location_id, item, status')
    .eq('id', itemId)
    .single()
  if (!item) throw new Error('Item not found')
  if (item.status !== 'to_buy') throw new Error('Item is not pending purchase')

  const { data: expense, error: expErr } = await supabase
    .from('sal_expenses')
    .insert({
      org_id: PLACEHOLDER, // derived by trigger
      location_id: item.location_id,
      category: 'supplies',
      description: item.item,
      amount: cost,
      source_shopping_item_id: item.id,
    })
    .select('id')
    .single()
  fail(expErr, 'Create expense failed')

  const { error } = await supabase
    .from('sal_shopping_list')
    .update({ status: 'purchased', purchased_at: new Date().toISOString(), expense_id: expense!.id })
    .eq('id', itemId)
  fail(error, 'Mark purchased failed')
  revalidatePath(`/o/${orgSlug}/m/nail-salon/manage`)
}

export async function cancelShoppingItem(orgSlug: string, itemId: string) {
  const supabase = await createClient()
  const { error } = await supabase
    .from('sal_shopping_list')
    .update({ status: 'cancelled' })
    .eq('id', itemId)
  fail(error, 'Cancel item failed')
  revalidatePath(`/o/${orgSlug}/m/nail-salon/manage`)
}
