'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { CREDENTIAL_STORES, DATE_KINDS, IF_LOST, SIGN_IN_METHODS } from '@/lib/vendor-accounts'

// Vendor accounts page writes (docs/28 Part A). RLS restricts every vendor_*
// table to the superadmin; these actions check too, so a refusal is a clear
// message rather than a silently-empty write.
//
// Expected refusals (a duplicate service name, text the database refuses as
// secret-shaped) come back as ?error=… on the page, never as a throw: a thrown
// server-action message is redacted in production (docs/03 #22).

const PAGE = '/console/vendors'

function fail(message: string): never {
  redirect(`${PAGE}?error=${encodeURIComponent(message)}`)
}

async function requireSuperadmin() {
  const supabase = await createClient()
  const { data: isSuperadmin } = await supabase.rpc('is_superadmin')
  if (!isSuperadmin) fail('Only the platform owner can change vendor accounts.')
  return supabase
}

/** The database's own refusal, in words the founder can act on. */
function explain(error: { code?: string; message: string }): string {
  if (error.code === '23514' && error.message.includes('never stores passwords or keys')) return error.message
  if (error.code === '23505') return 'That already exists.'
  if (error.code === '23514') return `The database refused a value: ${error.message}`
  return error.message
}

const text = (fd: FormData, key: string): string | null => {
  const v = String(fd.get(key) ?? '').trim()
  return v === '' ? null : v
}

function oneOf<T extends Record<string, string>>(map: T, v: string | null, fallback: keyof T): keyof T {
  return v !== null && v in map ? (v as keyof T) : fallback
}

export async function saveVendorAccount(accountId: string | null, fd: FormData) {
  const supabase = await requireSuperadmin()
  const service = text(fd, 'service')
  if (!service) fail('A service name is required.')
  const cost = text(fd, 'monthly_cost_usd')
  if (cost !== null && !/^\d+(\.\d{1,2})?$/.test(cost)) fail('Monthly cost must be a number like 20 or 19.99.')
  const every = text(fd, 'check_every_days')
  if (every !== null && !/^\d{1,3}$/.test(every)) fail('"Check every" must be a whole number of days, or blank.')

  const row = {
    service,
    status: oneOf({ active: '', planned: '', closed: '' }, text(fd, 'status'), 'active'),
    used_for: text(fd, 'used_for'),
    if_lost: oneOf(IF_LOST, text(fd, 'if_lost'), 'unclassified'),
    breaks_if_lost: text(fd, 'breaks_if_lost'),
    part_b_ref: text(fd, 'part_b_ref'),
    sign_in_url: text(fd, 'sign_in_url'),
    sign_in_method: oneOf(SIGN_IN_METHODS, text(fd, 'sign_in_method'), 'unknown'),
    owner_login: text(fd, 'owner_login'),
    two_step: oneOf({ on: '', off: '', unknown: '' }, text(fd, 'two_step'), 'unknown'),
    plan: text(fd, 'plan'),
    monthly_cost_usd: cost === null ? null : Number(cost),
    paid_how: text(fd, 'paid_how'),
    last_paid_on: text(fd, 'last_paid_on'),
    next_charge_on: text(fd, 'next_charge_on'),
    payment_status: oneOf({ ok: '', failing: '', free: '', unknown: '' }, text(fd, 'payment_status'), 'unknown'),
    check_every_days: every === null ? null : Number(every),
    notes: text(fd, 'notes'),
    updated_at: new Date().toISOString(),
  }
  const { error } = accountId
    ? await supabase.from('vendor_accounts').update(row).eq('id', accountId)
    : await supabase.from('vendor_accounts').insert(row)
  if (error) fail(explain(error))
  revalidatePath(PAGE)
  revalidatePath('/console')
}

/** "Done today" on a recurring chore (docs/28 B.8, the monthly offsite copy). */
export async function markVendorDone(accountId: string) {
  const supabase = await requireSuperadmin()
  const { error } = await supabase
    .from('vendor_accounts')
    .update({ last_done_on: new Date().toISOString().slice(0, 10), updated_at: new Date().toISOString() })
    .eq('id', accountId)
  if (error) fail(explain(error))
  revalidatePath(PAGE)
  revalidatePath('/console')
}

export async function addVendorDate(accountId: string, fd: FormData) {
  const supabase = await requireSuperadmin()
  const label = text(fd, 'label')
  if (!label) fail('Say what the date is for.')
  const { error } = await supabase.from('vendor_account_dates').insert({
    account_id: accountId,
    kind: oneOf(DATE_KINDS, text(fd, 'kind'), 'other'),
    label,
    due_on: text(fd, 'due_on'),
  })
  if (error) fail(explain(error))
  revalidatePath(PAGE)
  revalidatePath('/console')
}

/** Mark a date handled (key rotated, renewed) — or reopen it. */
export async function setVendorDateDone(dateId: string, done: boolean) {
  const supabase = await requireSuperadmin()
  const { error } = await supabase
    .from('vendor_account_dates')
    .update({ done_on: done ? new Date().toISOString().slice(0, 10) : null })
    .eq('id', dateId)
  if (error) fail(explain(error))
  revalidatePath(PAGE)
  revalidatePath('/console')
}

export async function deleteVendorDate(dateId: string) {
  const supabase = await requireSuperadmin()
  const { error } = await supabase.from('vendor_account_dates').delete().eq('id', dateId)
  if (error) fail(explain(error))
  revalidatePath(PAGE)
  revalidatePath('/console')
}

export async function addVendorCredential(accountId: string, fd: FormData) {
  const supabase = await requireSuperadmin()
  const store = oneOf(CREDENTIAL_STORES, text(fd, 'store'), 'password_manager')
  const name = text(fd, 'name')
  const { error } = await supabase.from('vendor_account_credentials').insert({ account_id: accountId, store, name })
  if (error) {
    // The name CHECK is the "never a value" rule; say so plainly.
    if (error.code === '23514' && !error.message.includes('never stores')) {
      fail(
        'Record only the NAME, in capitals with underscores (like B2_APP_KEY) — never the value. ' +
          'A file, GitHub secret or Vercel variable needs a name; a password manager or the vendor dashboard can be left blank.',
      )
    }
    fail(explain(error))
  }
  revalidatePath(PAGE)
}

export async function deleteVendorCredential(credentialId: string) {
  const supabase = await requireSuperadmin()
  const { error } = await supabase.from('vendor_account_credentials').delete().eq('id', credentialId)
  if (error) fail(explain(error))
  revalidatePath(PAGE)
}
