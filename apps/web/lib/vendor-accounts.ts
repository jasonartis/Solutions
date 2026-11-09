// Vendor accounts (docs/28 Part A) — shared by /console/vendors and the Owner
// Console dashboard tile. Reads run on the caller's RLS client: the four
// vendor_* tables are superadmin-only (migration 20261113010000), so this file
// adds no read path of its own.
//
// The page never holds a password or key. The database enforces that (no value
// column, a NAME-only credentials table, and a trigger that refuses secret-shaped
// text); nothing here relies on the form being well behaved.

import type { SupabaseClient } from '@supabase/supabase-js'

export type VendorAccount = {
  id: string
  service: string
  status: 'active' | 'planned' | 'closed'
  used_for: string | null
  if_lost: 'platform_down' | 'feature_down' | 'invisible' | 'unclassified'
  breaks_if_lost: string | null
  /** Its evacuation plan in docs/28 Part B, e.g. 'B.3-1'. */
  part_b_ref: string | null
  sign_in_url: string | null
  sign_in_method: 'email_password' | 'google' | 'github' | 'other' | 'unknown'
  owner_login: string | null
  two_step: 'on' | 'off' | 'unknown'
  plan: string | null
  monthly_cost_usd: number | null
  paid_how: string | null
  last_paid_on: string | null
  next_charge_on: string | null
  payment_status: 'ok' | 'failing' | 'free' | 'unknown'
  /** A recurring chore (docs/28 B.8): flagged once more than this many days pass since last_done_on. */
  check_every_days: number | null
  last_done_on: string | null
  notes: string | null
  updated_at: string
}

export type VendorDate = {
  id: string
  account_id: string
  kind: 'trial_end' | 'key_expiry' | 'renewal' | 'other'
  label: string
  due_on: string | null
  done_on: string | null
}

export type VendorCredential = { id: string; account_id: string; store: CredentialStore; name: string | null }

export type VendorOpen = { account_id: string; opened_at: string }

export const CREDENTIAL_STORES = {
  env_deploy: '.env.deploy',
  env_accounts: '.env.accounts',
  env_local: '.env.local',
  github_secret: 'GitHub secret',
  vercel_env: 'Vercel environment variable',
  password_manager: 'password manager',
  vendor_dashboard: "the vendor's own dashboard",
} as const
export type CredentialStore = keyof typeof CREDENTIAL_STORES

export const IF_LOST = {
  platform_down: 'Platform down',
  feature_down: 'Feature down',
  invisible: 'Invisible to users',
  unclassified: 'Not classified yet',
} as const

export const SIGN_IN_METHODS = {
  email_password: 'Email and password',
  google: 'Sign in with Google',
  github: 'Sign in with GitHub',
  other: 'Other',
  unknown: 'Not recorded',
} as const

export const DATE_KINDS = {
  trial_end: 'Trial ends',
  key_expiry: 'Key or token expires',
  renewal: 'Renewal',
  other: 'Other',
} as const

/** docs/28 Part B, on GitHub (the repo is public; the page links rather than copies). */
export const PART_B_URL =
  'https://github.com/jasonartis/Solutions/blob/master/docs/28-vendor-accounts-and-evacuation-plans.md#part-b--dependency-review-and-evacuation-plans'

export type VendorData = {
  accounts: VendorAccount[]
  dates: VendorDate[]
  credentials: VendorCredential[]
  opens: VendorOpen[]
}

/** Everything the page and the dashboard need. Throws if any read fails, so a
 *  broken read never renders as "nothing due" (the vacuity rule). */
export async function getVendorData(supabase: SupabaseClient): Promise<VendorData> {
  const [a, d, c, o] = await Promise.all([
    supabase.from('vendor_accounts').select('*').order('service'),
    supabase.from('vendor_account_dates').select('id, account_id, kind, label, due_on, done_on').order('due_on', { nullsFirst: true }),
    supabase.from('vendor_account_credentials').select('id, account_id, store, name').order('store'),
    // The whole history is kept; the page shows the last open and a 90-day count.
    supabase.from('vendor_account_opens').select('account_id, opened_at').order('opened_at', { ascending: false }).limit(5000),
  ])
  const failed = [a, d, c, o].find((r) => r.error)
  if (failed?.error) throw new Error(failed.error.message)
  return {
    accounts: (a.data ?? []) as VendorAccount[],
    dates: (d.data ?? []) as VendorDate[],
    credentials: (c.data ?? []) as VendorCredential[],
    opens: (o.data ?? []) as VendorOpen[],
  }
}

const DAY = 24 * 3600 * 1000

/** Whole days from today (UTC) to an ISO date; negative = in the past. */
export function daysUntil(isoDate: string, now = Date.now()): number {
  const today = new Date(new Date(now).toISOString().slice(0, 10)).getTime()
  return Math.round((new Date(isoDate).getTime() - today) / DAY)
}

export type VendorIssue = {
  severity: 'urgent' | 'attention'
  accountId: string
  service: string
  text: string
}

/** The four badges docs/28 asks for, for ACTIVE accounts only:
 *   - a date due within 30 days (urgent within 7 days or already passed),
 *     and an expiry nobody recorded;
 *   - not opened in 90 days (or never) — or, for a recurring chore with
 *     check_every_days (docs/28 B.8), not done within that many days;
 *   - payment failing;
 *   - two-step verification off.
 *  "unknown" two-step is not flagged: the seed starts every account unknown,
 *  and the page shows it plainly. */
export function vendorIssues(data: VendorData, now = Date.now()): VendorIssue[] {
  const issues: VendorIssue[] = []
  const lastOpen = new Map<string, number>()
  for (const o of data.opens) {
    const t = new Date(o.opened_at).getTime()
    if (t > (lastOpen.get(o.account_id) ?? 0)) lastOpen.set(o.account_id, t)
  }
  for (const a of data.accounts) {
    if (a.status !== 'active') continue
    for (const d of data.dates) {
      if (d.account_id !== a.id || d.done_on) continue
      if (d.due_on === null) {
        issues.push({ severity: 'attention', accountId: a.id, service: a.service, text: `${a.service}: ${d.label} — date not recorded` })
        continue
      }
      const days = daysUntil(d.due_on, now)
      if (days > 30) continue
      const when = days < 0 ? `passed ${-days} day${days === -1 ? '' : 's'} ago` : days === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`
      issues.push({ severity: days <= 7 ? 'urgent' : 'attention', accountId: a.id, service: a.service, text: `${a.service}: ${d.label} — ${when}` })
    }
    if (a.payment_status === 'failing') {
      issues.push({ severity: 'urgent', accountId: a.id, service: a.service, text: `${a.service}: payment failing` })
    }
    if (a.two_step === 'off') {
      issues.push({ severity: 'urgent', accountId: a.id, service: a.service, text: `${a.service}: two-step verification is off` })
    }
    // A recurring chore is judged on "done", not on "last opened".
    if (a.check_every_days !== null) {
      const since = a.last_done_on === null ? null : -daysUntil(a.last_done_on, now)
      if (since === null || since > a.check_every_days) {
        issues.push({
          severity: 'attention',
          accountId: a.id,
          service: a.service,
          text: `${a.service}: ${since === null ? 'never done' : `not done in ${since} days`} (every ${a.check_every_days})`,
        })
      }
      continue
    }
    const last = lastOpen.get(a.id)
    if (last === undefined || now - last > 90 * DAY) {
      issues.push({
        severity: 'attention',
        accountId: a.id,
        service: a.service,
        text: `${a.service}: ${last === undefined ? 'never opened from this page' : `not opened in ${Math.floor((now - last) / DAY)} days`}`,
      })
    }
  }
  return issues
}
