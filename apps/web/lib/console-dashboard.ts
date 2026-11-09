// Owner Console home dashboard — server plumbing (module-9 spec §H: "one main
// superadmin dashboard … so he never misses a report inside 48 hours").
//
// READ-ONLY and built from tables that already exist; no migration. Every query
// runs on the CALLER's ordinary RLS-enforced client (same keystone as
// lib/zmanim-console.ts): the superadmin's existing read policies are the gate,
// and this file adds no new read path. Pending invites are only COUNTED — the
// addresses are never selected.
//
// Each section catches its own failure and reports `error`, so a broken source
// shows up as a grey "could not read" tile rather than blanking the dashboard
// (and never reads as a green "all clear" — the vacuity rule).

import type { SupabaseClient } from '@supabase/supabase-js'
import { getZmanimCoverage, getZmanimPrefetchSettings } from '@/lib/zmanim-console'

export type Severity = 'urgent' | 'attention' | 'ok' | 'idle'

/** One line of the priority list. */
export type PriorityItem = { severity: Exclude<Severity, 'ok' | 'idle'>; text: string; href: string }

export type DashboardTile = {
  key: string
  title: string
  href: string
  /** The big number; null when there is nothing meaningful to count. */
  count: number | null
  severity: Severity
  /** One line under the number. */
  detail: string
  /** Extra facts shown small, e.g. "3 unread · oldest waiting 4 days". */
  lines: string[]
}

export type Dashboard = { tiles: DashboardTile[]; priorities: PriorityItem[] }

const DAY = 24 * 3600 * 1000

function ago(ms: number): string {
  const hours = Math.floor(ms / 3600000)
  if (hours < 1) return 'under an hour'
  if (hours < 48) return `${hours} h`
  return `${Math.floor(hours / 24)} days`
}

function failedTile(key: string, title: string, href: string, what: string): DashboardTile {
  return { key, title, href, count: null, severity: 'idle', detail: `Could not read ${what}`, lines: [] }
}

// --- Feedback (docs/27) ------------------------------------------------------
async function feedbackSection(supabase: SupabaseClient, items: PriorityItem[]): Promise<DashboardTile> {
  const href = '/console/feedback'
  const { data, error } = await supabase
    .from('feedback_tickets')
    .select('status, last_user_message_at, staff_read_at')
    .in('status', ['new', 'open'])
    .limit(1000)
  if (error) return failedTile('feedback', 'Feedback', href, 'feedback')

  const rows = data ?? []
  const now = Date.now()
  const fresh = rows.filter((r) => r.status === 'new').length
  // Same "unread" rule as the feedback list: the person wrote after staff last looked.
  const waiting = rows
    .filter((r) => r.last_user_message_at !== null && (r.staff_read_at === null || r.last_user_message_at > r.staff_read_at))
    .map((r) => now - new Date(r.last_user_message_at as string).getTime())
  const oldest = waiting.length ? Math.max(...waiting) : 0

  let severity: Severity = rows.length === 0 ? 'ok' : 'attention'
  if (waiting.length && oldest > 3 * DAY) severity = 'urgent'
  if (waiting.length) {
    items.push({
      severity: oldest > 3 * DAY ? 'urgent' : 'attention',
      text: `${waiting.length} feedback message${waiting.length === 1 ? '' : 's'} unread — oldest waiting ${ago(oldest)}`,
      href,
    })
  } else if (fresh) {
    items.push({ severity: 'attention', text: `${fresh} new feedback ticket${fresh === 1 ? '' : 's'}`, href })
  }
  return {
    key: 'feedback',
    title: 'Feedback',
    href,
    count: rows.length,
    severity,
    detail: rows.length === 0 ? 'Nothing waiting' : 'new or open tickets',
    lines: rows.length ? [`${fresh} new`, `${waiting.length} with an unread reply${waiting.length ? ` · oldest ${ago(oldest)}` : ''}`] : [],
  }
}

// --- Account deletions (docs/21) --------------------------------------------
type Runner = { scheduled: boolean; active?: boolean; last_start?: string | null; last_status?: string | null } | null

async function deletionsSection(supabase: SupabaseClient, items: PriorityItem[]): Promise<DashboardTile> {
  const href = '/console/accounts'
  const [{ data, error }, { data: runner }] = await Promise.all([
    supabase.from('account_deletions').select('state, initiated_via, due_at, last_error').eq('state', 'departed'),
    supabase.rpc('account_deletion_runner_status'),
  ])
  if (error) return failedTile('deletions', 'Account deletions', href, 'account deletions')

  const rows = data ?? []
  const now = Date.now()
  const failing = rows.filter((r) => r.last_error).length
  const dueSoon = rows.filter((r) => !r.last_error && new Date(r.due_at).getTime() - now < 7 * DAY).length
  const removals = rows.filter((r) => r.initiated_via === 'removal').length

  // Same honesty check as the accounts page: nothing else watches pg_cron.
  const r = runner as Runner
  const last = r?.last_start ? new Date(r.last_start).getTime() : null
  const jobDown = !r?.scheduled || r.active === false || r.last_status === 'failed'
  const jobStale = last === null || now - last > 50 * 3600 * 1000

  const lines = [`${rows.length} pending`, `${dueSoon} due within 7 days`]
  if (removals) lines.push(`${removals} are removals`)
  if (failing) lines.push(`${failing} failing`)

  let severity: Severity = 'ok'
  if (dueSoon) severity = 'attention'
  if (failing || jobDown) severity = 'urgent'
  else if (jobStale && rows.length) severity = 'attention'

  if (failing) items.push({ severity: 'urgent', text: `${failing} account deletion${failing === 1 ? '' : 's'} could not complete`, href })
  if (jobDown) {
    items.push({ severity: 'urgent', text: 'The daily deletion job is not scheduled, switched off, or failed last run', href })
    lines.push('daily job NOT healthy')
  } else if (jobStale) {
    // Only worth a line when something is waiting on it.
    if (rows.length) items.push({ severity: 'attention', text: 'The daily deletion job has not run in over two days', href })
    lines.push(last === null ? 'daily job has never run' : 'daily job stale (2+ days)')
  }
  if (dueSoon) items.push({ severity: 'attention', text: `${dueSoon} deletion${dueSoon === 1 ? '' : 's'} due within 7 days`, href })

  return { key: 'deletions', title: 'Account deletions', href, count: rows.length, severity, detail: 'pending', lines }
}

// --- Things expiring ----------------------------------------------------------
async function expiringSection(supabase: SupabaseClient, items: PriorityItem[]): Promise<DashboardTile> {
  const href = '/console'
  const lines: string[] = []
  let severity: Severity = 'ok'
  let count = 0
  const bump = (s: Severity) => {
    if (s === 'urgent' || (s === 'attention' && severity !== 'urgent')) severity = s
  }

  // 1. Open invitations about to lapse (COUNT only — no addresses are read).
  const soon = new Date(Date.now() + 3 * DAY).toISOString()
  const { count: invites, error: invErr } = await supabase
    .from('pending_invites')
    .select('id', { count: 'exact', head: true })
    .gt('expires_at', new Date().toISOString())
    .lt('expires_at', soon)
  if (invErr) lines.push('invitations: could not read')
  else if (invites) {
    count += invites
    lines.push(`${invites} invitation${invites === 1 ? '' : 's'} lapse within 3 days`)
    bump('attention')
    items.push({ severity: 'attention', text: `${invites} open invitation${invites === 1 ? '' : 's'} lapse within 3 days`, href })
  }

  // 2. Zmanim cache runway: how soon does a configured location run out of cached days?
  try {
    const settings = await getZmanimPrefetchSettings(supabase)
    const coverage = await getZmanimCoverage(supabase, settings.horizonDays)
    const today = new Date().toISOString().slice(0, 10)
    const gaps = coverage
      .filter((c) => c.firstGapISO !== null)
      .map((c) => ({ c, days: Math.round((new Date(c.firstGapISO as string).getTime() - new Date(today).getTime()) / DAY) }))
    const near = gaps.filter((g) => g.days <= 30)
    if (near.length) {
      const worst = Math.min(...near.map((g) => g.days))
      const sev = worst <= 7 ? 'urgent' : 'attention'
      count += near.length
      bump(sev)
      lines.push(`zmanim: ${near.length} location${near.length === 1 ? '' : 's'} run out within ${worst <= 0 ? 'now' : `${worst} days`}`)
      items.push({
        severity: sev,
        text: `Zmanim cache runs out in ${Math.max(worst, 0)} days for ${near.length} location${near.length === 1 ? '' : 's'}`,
        href: '/console/zmanim',
      })
    } else if (coverage.length) {
      lines.push('zmanim: covered beyond 30 days')
    }
  } catch {
    lines.push('zmanim: could not read')
  }

  return {
    key: 'expiring',
    title: 'Expiring soon',
    href,
    count,
    severity,
    detail: count === 0 ? 'Nothing running out' : 'things running out',
    lines,
  }
}

// --- Content reports (module 9 — not built) -----------------------------------
// There is no report table yet. This tile exists so the 48-hour TAKE IT DOWN
// obligation has a place to land; when the Report content page ships, replace
// this with a count of open reports and an "oldest waiting" age, red past 24 h
// and urgent as the 48 h deadline nears (module-9 spec §H).
function reportsSection(): DashboardTile {
  return {
    key: 'reports',
    title: 'Content reports',
    href: '/console',
    count: null,
    severity: 'idle',
    detail: 'Not built yet',
    lines: ['Will show open reports and the oldest one’s age against the 48-hour limit'],
  }
}

export async function getDashboard(supabase: SupabaseClient): Promise<Dashboard> {
  const items: PriorityItem[] = []
  const [reports, feedback, deletions, expiring] = [
    reportsSection(),
    ...(await Promise.all([
      feedbackSection(supabase, items).catch(() => failedTile('feedback', 'Feedback', '/console/feedback', 'feedback')),
      deletionsSection(supabase, items).catch(() => failedTile('deletions', 'Account deletions', '/console/accounts', 'account deletions')),
      expiringSection(supabase, items).catch(() => failedTile('expiring', 'Expiring soon', '/console', 'expiry data')),
    ])),
  ]
  // Urgent first; the sort is stable so sources keep their own order within a level.
  const rank = { urgent: 0, attention: 1 } as const
  items.sort((a, b) => rank[a.severity] - rank[b.severity])
  return { tiles: [reports, feedback, deletions, expiring], priorities: items }
}
