// The platform cost model (docs/costs). PURE: no I/O, no framework imports, so the
// superadmin page (apps/web/app/(app)/console/costs), the markdown generator
// (scripts/print-cost-model.mts) and the sanity test (packages/db) all run the
// SAME numbers. Change a price or an assumption HERE, then regenerate the docs.
//
// Shape: usage assumptions -> monthly FLOWS (requests, emails, egress ...) and
// year-end STOCKS (database GB, file GB) -> priced line items for the
// architecture that tier needs -> per-module allocation -> per-user cost.
//
// Every price carries its source and the date it was checked (PRICES). A price
// whose `confidence` is not 'verified' is a third-party figure or our own
// assumption — the page and docs show that, never hide it.

export type Confidence = 'verified' | 'third-party' | 'assumption'

export interface PriceFact {
  vendor: string
  item: string
  value: number
  unit: string
  checked: string // ISO date
  source: string
  confidence: Confidence
  note?: string
}

const CHECKED = '2026-11-09'

// Keyed so model code reads P.supabaseProBase.value, and the price sheet is generated from the same object.
export const PRICES = {
  // ---- Supabase (pricing page) ----
  supabaseProBase: { vendor: 'Supabase', item: 'Pro plan base', value: 25, unit: '$/month', checked: CHECKED, source: 'https://supabase.com/pricing', confidence: 'verified' },
  supabaseMauIncluded: { vendor: 'Supabase', item: 'Pro: auth MAU included', value: 100_000, unit: 'MAU', checked: CHECKED, source: 'https://supabase.com/pricing', confidence: 'verified' },
  supabaseMauOver: { vendor: 'Supabase', item: 'Pro: auth MAU overage', value: 0.00325, unit: '$/MAU', checked: CHECKED, source: 'https://supabase.com/pricing', confidence: 'verified' },
  supabaseDbIncluded: { vendor: 'Supabase', item: 'Pro: database size included', value: 8, unit: 'GB', checked: CHECKED, source: 'https://supabase.com/pricing', confidence: 'verified' },
  supabaseDbOver: { vendor: 'Supabase', item: 'Pro: database size overage', value: 0.125, unit: '$/GB-month', checked: CHECKED, source: 'https://supabase.com/pricing', confidence: 'verified' },
  supabaseStorageIncluded: { vendor: 'Supabase', item: 'Pro: file storage included', value: 100, unit: 'GB', checked: CHECKED, source: 'https://supabase.com/pricing', confidence: 'verified' },
  supabaseStorageOver: { vendor: 'Supabase', item: 'Pro: file storage overage', value: 0.0213, unit: '$/GB-month', checked: CHECKED, source: 'https://supabase.com/pricing', confidence: 'verified' },
  supabaseEgressIncluded: { vendor: 'Supabase', item: 'Pro: egress included', value: 250, unit: 'GB/month', checked: CHECKED, source: 'https://supabase.com/pricing', confidence: 'verified' },
  supabaseEgressOver: { vendor: 'Supabase', item: 'Pro: egress overage', value: 0.09, unit: '$/GB', checked: CHECKED, source: 'https://supabase.com/pricing', confidence: 'verified' },
  supabaseRealtimeConnIncluded: { vendor: 'Supabase', item: 'Pro: realtime concurrent connections included', value: 500, unit: 'connections', checked: CHECKED, source: 'https://supabase.com/pricing', confidence: 'verified' },
  supabaseRealtimeConnOver: { vendor: 'Supabase', item: 'Pro: realtime connections overage', value: 10, unit: '$/1,000 connections', checked: CHECKED, source: 'https://supabase.com/pricing', confidence: 'verified' },
  supabaseRealtimeMsgIncluded: { vendor: 'Supabase', item: 'Pro: realtime messages included', value: 5, unit: 'million/month', checked: CHECKED, source: 'https://supabase.com/pricing', confidence: 'verified' },
  supabaseRealtimeMsgOver: { vendor: 'Supabase', item: 'Pro: realtime messages overage', value: 2.5, unit: '$/million', checked: CHECKED, source: 'https://supabase.com/pricing', confidence: 'verified' },
  supabaseComputeCredit: { vendor: 'Supabase', item: 'Pro: compute credit (covers one Micro)', value: 10, unit: '$/month', checked: CHECKED, source: 'https://supabase.com/pricing', confidence: 'verified' },
  supabasePitr: { vendor: 'Supabase', item: 'Point-in-time recovery add-on (7 days)', value: 100, unit: '$/month', checked: CHECKED, source: 'https://supabase.com/pricing', confidence: 'verified' },
  // ---- Vercel ----
  vercelProSeat: { vendor: 'Vercel', item: 'Pro: per developer seat', value: 20, unit: '$/month', checked: CHECKED, source: 'https://vercel.com/pricing', confidence: 'verified', note: 'Hobby is "personal, non-commercial use" only.' },
  vercelBandwidthIncluded: { vendor: 'Vercel', item: 'Pro: bandwidth included', value: 1000, unit: 'GB/month', checked: CHECKED, source: 'https://vercel.com/pricing', confidence: 'verified' },
  vercelBandwidthOver: { vendor: 'Vercel', item: 'Pro: bandwidth overage (from)', value: 0.15, unit: '$/GB', checked: CHECKED, source: 'https://vercel.com/pricing', confidence: 'verified' },
  vercelCpuHour: { vendor: 'Vercel', item: 'Functions: active CPU (from)', value: 0.128, unit: '$/CPU-hour', checked: CHECKED, source: 'https://vercel.com/pricing', confidence: 'verified' },
  vercelMemGbHour: { vendor: 'Vercel', item: 'Functions: provisioned memory (from)', value: 0.0106, unit: '$/GB-hour', checked: CHECKED, source: 'https://vercel.com/pricing', confidence: 'verified' },
  vercelInvocationsPerM: { vendor: 'Vercel', item: 'Functions: invocations (from)', value: 0.6, unit: '$/million', checked: CHECKED, source: 'https://vercel.com/pricing', confidence: 'verified' },
  // ---- Cloudflare R2 / Backblaze B2 ----
  r2Storage: { vendor: 'Cloudflare R2', item: 'Standard storage', value: 0.015, unit: '$/GB-month', checked: CHECKED, source: 'https://developers.cloudflare.com/r2/pricing/', confidence: 'verified', note: 'Egress is free. 10 GB free tier ignored.' },
  r2ClassB: { vendor: 'Cloudflare R2', item: 'Class B (read) operations', value: 0.36, unit: '$/million', checked: CHECKED, source: 'https://developers.cloudflare.com/r2/pricing/', confidence: 'verified' },
  b2Storage: { vendor: 'Backblaze B2', item: 'Storage', value: 6.95, unit: '$/TB-month', checked: CHECKED, source: 'https://www.backblaze.com/cloud-storage/pricing', confidence: 'verified', note: 'Free egress up to 3x stored data; transactions free.' },
  // ---- Video ----
  jaasBasic: { vendor: '8x8 JaaS', item: 'Basic plan (300 MAU)', value: 99, unit: '$/month', checked: CHECKED, source: 'https://cpaas.8x8.com/en/pricing/jitsi-as-a-service-pricing/', confidence: 'verified' },
  jaasStandard: { vendor: '8x8 JaaS', item: 'Standard plan (1,500 MAU)', value: 499, unit: '$/month', checked: CHECKED, source: 'https://cpaas.8x8.com/en/pricing/jitsi-as-a-service-pricing/', confidence: 'verified' },
  jaasBusiness: { vendor: '8x8 JaaS', item: 'Business plan (3,000 MAU)', value: 999, unit: '$/month', checked: CHECKED, source: 'https://cpaas.8x8.com/en/pricing/jitsi-as-a-service-pricing/', confidence: 'verified' },
  jaasOver: { vendor: '8x8 JaaS', item: 'Overage above a plan\'s MAU', value: 0.99, unit: '$/MAU', checked: CHECKED, source: 'https://cpaas.8x8.com/en/pricing/jitsi-as-a-service-pricing/', confidence: 'verified', note: 'Developer plan: 25 MAU free. One third-party guide says $0.35/MAU; 8x8\'s own page says $0.99.' },
  hetznerEuBox: { vendor: 'Hetzner', item: 'CPX42-class video bridge / big worker (8 vCPU, 16 GB, EU)', value: 69.99, unit: '€/month', checked: CHECKED, source: 'https://www.hetzner.com/cloud/regular-performance/', confidence: 'verified', note: '20 TB traffic included, €1.00/TB over (EU).' },
  hetznerWorkerBox: { vendor: 'Hetzner', item: 'CPX22 (2 vCPU, 4 GB, EU) — the worker VPS', value: 19.99, unit: '€/month', checked: CHECKED, source: 'https://www.hetzner.com/cloud/regular-performance/', confidence: 'verified' },
  hetznerTrafficTb: { vendor: 'Hetzner', item: 'Extra traffic (EU/US)', value: 1.0, unit: '€/TB', checked: CHECKED, source: 'https://www.hetzner.com/cloud/regular-performance/', confidence: 'verified' },
  eurUsd: { vendor: 'FX', item: 'EUR to USD', value: 1.14, unit: '$ per €', checked: CHECKED, source: 'derived: Hetzner CPX11 €17.99 = $20.49 in docs/02', confidence: 'assumption', note: 'Edit if your card rate differs.' },
  // ---- Email ----
  resendPro: { vendor: 'Resend', item: 'Pro (50,000 emails)', value: 20, unit: '$/month', checked: CHECKED, source: 'https://resend.com/pricing', confidence: 'verified', note: 'Free plan: 3,000/month and 100/day.' },
  resendPro100k: { vendor: 'Resend', item: 'Pro (100,000 emails)', value: 35, unit: '$/month', checked: CHECKED, source: 'https://resend.com/pricing', confidence: 'verified' },
  resendScale: { vendor: 'Resend', item: 'Scale (100,000 emails, no daily cap)', value: 90, unit: '$/month', checked: CHECKED, source: 'https://resend.com/pricing', confidence: 'verified' },
  resendOverPerK: { vendor: 'Resend', item: 'Overage', value: 0.9, unit: '$/1,000 emails', checked: CHECKED, source: 'https://resend.com/pricing', confidence: 'verified', note: 'Falls to $0.46/1,000 on the 2.5M-email tier ($1,150/month).' },
  sesPerK: { vendor: 'AWS SES', item: 'Outbound email', value: 0.1, unit: '$/1,000 emails', checked: CHECKED, source: 'from memory of aws.amazon.com/ses/pricing — NOT re-fetched', confidence: 'assumption' },
  // ---- AI ----
  aiSonnetIn: { vendor: 'Anthropic', item: 'Sonnet 5.5 input', value: 2, unit: '$/million tokens', checked: CHECKED, source: 'https://claude.com/pricing', confidence: 'verified' },
  aiSonnetOut: { vendor: 'Anthropic', item: 'Sonnet 5.5 output', value: 10, unit: '$/million tokens', checked: CHECKED, source: 'https://claude.com/pricing', confidence: 'verified' },
  aiHaikuIn: { vendor: 'Anthropic', item: 'Haiku 5.5 input (≤100K context)', value: 0.1, unit: '$/million tokens', checked: CHECKED, source: 'https://claude.com/pricing', confidence: 'verified' },
  aiHaikuOut: { vendor: 'Anthropic', item: 'Haiku 5.5 output (≤100K context)', value: 0.5, unit: '$/million tokens', checked: CHECKED, source: 'https://claude.com/pricing', confidence: 'verified', note: 'Batch processing is 50% off; not assumed.' },
  // ---- Big-scale infrastructure (third-party / assumption) ----
  rdsR6g4xlMultiAzHour: { vendor: 'AWS RDS', item: 'PostgreSQL db.r6g.4xlarge Multi-AZ (us-east-1)', value: 3.6, unit: '$/hour', checked: CHECKED, source: 'https://sparecores.com/database/aws/db.r6g.4xlarge', confidence: 'third-party', note: 'AWS\'s own page would not render the table; confirm on aws.amazon.com/rds/postgresql/pricing before budgeting.' },
  rdsStorageGb: { vendor: 'AWS RDS', item: 'gp3 storage', value: 0.115, unit: '$/GB-month', checked: CHECKED, source: 'from memory of the RDS pricing page — NOT re-fetched', confidence: 'assumption' },
  cdnPerGbList: { vendor: 'AWS CloudFront', item: 'Data transfer out, first 10 TB (US)', value: 0.085, unit: '$/GB', checked: CHECKED, source: 'from memory of the CloudFront pricing page — NOT re-fetched', confidence: 'assumption' },
  cdnPerGb10M: { vendor: 'CDN (negotiated)', item: 'Egress at petabytes/month with a commit', value: 0.03, unit: '$/GB', checked: CHECKED, source: 'our assumption: a committed-spend discount; get quotes', confidence: 'assumption' },
  cdnPerGb1B: { vendor: 'CDN / own network (negotiated)', item: 'Egress at ~100+ PB/month, multi-CDN or own peering', value: 0.004, unit: '$/GB', checked: CHECKED, source: 'our assumption; real deals are bespoke', confidence: 'assumption' },
  containerPerMReq: { vendor: 'Own containers', item: 'App compute per million requests (all-in)', value: 0.3, unit: '$/million', checked: CHECKED, source: 'our assumption: ~1 vCPU-second per 1,000 requests at ~$0.04/vCPU-hour, plus headroom', confidence: 'assumption' },
  queuesAndSearchFlat: { vendor: 'Own platform team tooling', item: 'Monitoring, logging, on-call tooling, per month at 10M users', value: 8000, unit: '$/month', checked: CHECKED, source: 'our assumption', confidence: 'assumption' },
  // ---- Small fixed ----
  domain: { vendor: 'Domain', item: 'Domain name', value: 15, unit: '$/year', checked: CHECKED, source: 'docs/05', confidence: 'assumption' },
  sentryTeam: { vendor: 'Sentry', item: 'Team plan', value: 26, unit: '$/month', checked: CHECKED, source: 'from memory of sentry.io/pricing — NOT re-fetched', confidence: 'assumption' },
} as const satisfies Record<string, PriceFact>

const P = Object.fromEntries(Object.entries(PRICES).map(([k, v]) => [k, v.value])) as { [K in keyof typeof PRICES]: number }

// ---------------------------------------------------------------------------
// Usage assumptions (docs/costs/assumptions.md says the same, in words)
// ---------------------------------------------------------------------------

export type Driver = 'requests' | 'dbMb' | 'storageGb' | 'egressGb' | 'emails' | 'realtimeMsgs' | 'videoMin' | 'aiCalls'
export const DRIVERS: Driver[] = ['requests', 'dbMb', 'storageGb', 'egressGb', 'emails', 'realtimeMsgs', 'videoMin', 'aiCalls']

/** What ONE active user of a module causes in ONE month. dbMb and storageGb are permanent growth. */
export type Usage = Record<Driver, number>
const u = (x: Partial<Usage>): Usage => ({ requests: 0, dbMb: 0, storageGb: 0, egressGb: 0, emails: 0, realtimeMsgs: 0, videoMin: 0, aiCalls: 0, ...x })

export interface ModuleAssumption {
  key: string
  name: string
  /** Share of monthly active users who use this module in a month. */
  adoption: number
  usage: Usage
  why: string
}

export const CORE_KEY = 'core'

export const DEFAULT_MODULES: ModuleAssumption[] = [
  { key: CORE_KEY, name: 'Platform core (sign-in, profile, orgs)', adoption: 1, usage: u({ requests: 150, dbMb: 0.2, egressGb: 0.005, emails: 1 }), why: 'Every active user: sessions, page loads, a sign-in or notice email.' },
  { key: 'matchmaking', name: 'Make-a-Match', adoption: 0.15, usage: u({ requests: 200, dbMb: 0.5, egressGb: 0.02, emails: 2, realtimeMsgs: 100 }), why: 'Questions, answers, match lists, chat with matchmakers.' },
  { key: 'classroom', name: 'Classroom', adoption: 0.15, usage: u({ requests: 300, dbMb: 1, storageGb: 0.05, egressGb: 0.3, emails: 5 }), why: 'Lectures, homework files, grades, announcements.' },
  { key: 'synagogue-schedules', name: 'Synagogue Schedules', adoption: 0.5, usage: u({ requests: 20, egressGb: 0.002 }), why: 'Mostly public schedule page views; tiny per person, many people.' },
  { key: 'visual-messaging', name: 'Visual Messaging', adoption: 0.2, usage: u({ requests: 150, dbMb: 2, storageGb: 0.1, egressGb: 0.5, emails: 1, realtimeMsgs: 100 }), why: 'Photo threads and drawn layers; image-heavy.' },
  { key: 'nail-salon', name: 'Nail Salon', adoption: 0.15, usage: u({ requests: 100, dbMb: 0.5, egressGb: 0.02, emails: 4 }), why: 'Bookings, reminders, receipts.' },
  { key: 'speed-dating', name: 'Speed Dating', adoption: 0.05, usage: u({ requests: 100, dbMb: 0.3, egressGb: 0.02, emails: 3, realtimeMsgs: 300, videoMin: 45 }), why: 'An event or two a month: about 45 minutes of live video per active dater.' },
  { key: 'photos', name: 'Photos (module 9, planned)', adoption: 0.25, usage: u({ requests: 100, dbMb: 0.1, storageGb: 0.015, egressGb: 0.3, emails: 0 }), why: '10 uploads of ~1.5 MB, about 100 views of ~0.25 MB, per active user.' },
  { key: 'ai', name: 'AI features (résumé builder etc.)', adoption: 0.1, usage: u({ requests: 20, dbMb: 0.05, aiCalls: 3 }), why: 'Three AI calls per active AI user per month.' },
]

export interface Globals {
  /** Share of registered users active in a month. */
  mauRatio: number
  /** Months of permanent growth held at the point we price (database, files). */
  retentionMonths: number
  /** One AI call's tokens. */
  aiTokensIn: number
  aiTokensOut: number
  aiModel: 'sonnet' | 'haiku'
  /** Peak-to-average traffic. */
  peakFactor: number
  /** Share of video MAU on a call at the busiest moment (events cluster). */
  videoPeakShare: number
  /** Concurrent Jitsi participants one 8-vCPU bridge carries (assumption — measure it). */
  participantsPerBridge: number
  /** Megabytes the bridge sends per participant-minute (~1.5 Mbit/s). */
  videoMbPerMin: number
}

export const DEFAULT_GLOBALS: Globals = {
  mauRatio: 0.3,
  retentionMonths: 12,
  aiTokensIn: 4000,
  aiTokensOut: 1500,
  aiModel: 'sonnet',
  peakFactor: 5,
  videoPeakShare: 0.2,
  participantsPerBridge: 150,
  videoMbPerMin: 11.25,
}

export const TIERS = [10, 1_000, 100_000, 10_000_000, 1_000_000_000] as const

// ---------------------------------------------------------------------------
// Flows and stocks
// ---------------------------------------------------------------------------

export interface Flows {
  users: number
  mau: number
  /** Per module: monthly flow of each driver (permanent growth ones are the MONTHLY growth). */
  byModule: Record<string, Usage>
  moduleUsers: Record<string, number>
  total: Usage
  /** Year-end (retentionMonths) stocks, in GB. */
  dbGb: number
  fileGb: number
}

export function computeFlows(users: number, modules: ModuleAssumption[], g: Globals): Flows {
  const mau = users * g.mauRatio
  const byModule: Record<string, Usage> = {}
  const moduleUsers: Record<string, number> = {}
  const total = u({})
  for (const m of modules) {
    const n = mau * m.adoption
    moduleUsers[m.key] = n
    const f = u({})
    for (const d of DRIVERS) {
      f[d] = n * m.usage[d]
      total[d] += f[d]
    }
    byModule[m.key] = f
  }
  return {
    users,
    mau,
    byModule,
    moduleUsers,
    total,
    dbGb: (total.dbMb * g.retentionMonths) / 1024,
    fileGb: total.storageGb * g.retentionMonths,
  }
}

// ---------------------------------------------------------------------------
// Priced line items
// ---------------------------------------------------------------------------

export interface LineItem {
  group: string
  label: string
  /** $ per month. */
  monthly: number
  /** Which driver's per-module share this cost is split by (fixed infrastructure follows requests). */
  basis: Driver
  /** true = a step or flat cost that exists whatever one more user does (plans, seats, boxes, shards). */
  fixed: boolean
  note?: string
  confidence: Confidence
}

export type Architecture = 'managed' | 'self-run' | 'multi-region'

export interface TierPlan {
  architecture: Architecture
  name: string
  lines: LineItem[]
  /** What the same load would cost if we stayed on Supabase+Vercel list prices (a LOWER bound at the big tiers). */
  staysManagedLowerBound: number
  /** This plan's database + auth + hosting + file lines only — the part comparable with staysManagedLowerBound. */
  platformInfraMonthly: number
  monthly: number
  yearly: number
  /** Plain-language "what changes at this size". */
  changes: string[]
  /** How far off this could be, honestly. */
  accuracy: string
}

export function architectureFor(users: number): Architecture {
  if (users < 5_000_000) return 'managed'
  if (users < 300_000_000) return 'self-run'
  return 'multi-region'
}

function computeTier(mau: number): { name: string; price: number } {
  // Supabase compute add-ons (price list: Micro $10 ... 16XL $3,730). Chosen by MAU; a rule of thumb, not a benchmark.
  const sizes: [number, string, number][] = [
    [3_000, 'Micro', 10],
    [10_000, 'Small', 15],
    [30_000, 'Medium', 60],
    [100_000, 'Large', 110],
    [250_000, 'XL', 210],
    [500_000, '2XL', 410],
    [1_000_000, '4XL', 960],
    [2_000_000, '8XL', 1870],
    [Infinity, '16XL', 3730],
  ]
  const s = sizes.find((x) => mau <= x[0])!
  return { name: s[1], price: s[2] }
}

function jaasMonthly(videoMau: number): number {
  if (videoMau <= 25) return 0
  const plans: [number, number][] = [[300, P.jaasBasic], [1500, P.jaasStandard], [3000, P.jaasBusiness]]
  const options = plans.map(([incl, price]) => price + Math.max(0, videoMau - incl) * P.jaasOver)
  options.push(Math.max(0, videoMau - 25) * P.jaasOver) // Developer plan + overage
  return Math.min(...options)
}

function emailMonthly(n: number): { price: number; label: string } {
  if (n <= 3000) return { price: 0, label: 'Resend Free (3,000/month, 100/day — fine only before real use)' }
  if (n <= 50_000) return { price: P.resendPro, label: 'Resend Pro' }
  if (n <= 100_000) return { price: P.resendPro100k, label: 'Resend Pro 100k' }
  if (n <= 2_500_000) return { price: P.resendScale + Math.max(0, n - 100_000) * (P.resendOverPerK / 1000), label: 'Resend Scale + overage' }
  return { price: (n / 1000) * P.sesPerK, label: 'AWS SES, our own sending domains' }
}

function aiPerCall(g: Globals): number {
  const inP = g.aiModel === 'sonnet' ? P.aiSonnetIn : P.aiHaikuIn
  const outP = g.aiModel === 'sonnet' ? P.aiSonnetOut : P.aiHaikuOut
  return (g.aiTokensIn * inP + g.aiTokensOut * outP) / 1e6
}

export function planFor(users: number, modules: ModuleAssumption[], g: Globals): TierPlan {
  const f = computeFlows(users, modules, g)
  const arch = architectureFor(users)
  const lines: LineItem[] = []
  const eur = P.eurUsd
  const L = (group: string, label: string, monthly: number, basis: Driver, confidence: Confidence, note?: string, fixed = false) =>
    lines.push({ group, label, monthly, basis, confidence, note, fixed })

  const videoMau = f.moduleUsers['speed-dating'] ?? 0
  const peakVideo = videoMau * g.videoPeakShare
  const bridges = Math.max(0, Math.ceil(peakVideo / g.participantsPerBridge))
  const reqPerSec = f.total.requests / (30 * 86400)
  const peakRps = reqPerSec * g.peakFactor
  const videoEgressGb = f.total.videoMin * g.videoMbPerMin / 1000

  // --- AI: same at every size (priced per call; no scale discount assumed) ---
  L('AI', `Claude API (${g.aiModel === 'sonnet' ? 'Sonnet 5.5' : 'Haiku 5.5'}), ${Math.round(f.total.aiCalls).toLocaleString('en-US')} calls`, f.total.aiCalls * aiPerCall(g), 'aiCalls', 'verified', 'Tokens per call are an assumption; batch (−50%) and caching not assumed.')

  // --- Video ---
  if (arch === 'managed') {
    const jaas = jaasMonthly(videoMau)
    const selfHost = bridges * P.hetznerEuBox * eur
    if (videoMau > 0) {
      if (jaas <= selfHost || bridges === 0) L('Video', `JaaS (${Math.round(videoMau).toLocaleString('en-US')} video MAU)`, jaas, 'videoMin', 'verified', 'Cheaper than self-hosting at this size.')
      else L('Video', `Self-hosted Jitsi: ${bridges} bridge box(es)`, selfHost, 'videoMin', 'assumption', `Capacity of ${g.participantsPerBridge} participants per box is an assumption — measure it with a real event.`)
    }
  } else {
    const cdn = arch === 'self-run' ? P.cdnPerGb10M : P.cdnPerGb1B
    L('Video', `Own Jitsi bridges: ${bridges.toLocaleString('en-US')} boxes + bandwidth`, bridges * P.hetznerEuBox * eur + videoEgressGb * cdn, 'videoMin', 'assumption', 'Box price is Hetzner list; at this size you would buy hardware or bare metal and pay less.')
  }

  // --- Email ---
  if (f.total.emails > 0) {
    const e = emailMonthly(f.total.emails)
    L('Email', `${e.label}, ${Math.round(f.total.emails).toLocaleString('en-US')} emails`, e.price, 'emails', arch === 'managed' && f.total.emails <= 2_500_000 ? 'verified' : 'assumption')
  }

  if (arch === 'managed') {
    // --- App hosting: Vercel Pro, one developer seat; functions priced from list ---
    const invocations = (f.total.requests / 1e6) * P.vercelInvocationsPerM
    const cpuHours = (f.total.requests * 0.05) / 3600 // assume 50 ms active CPU per request
    const memGbHours = (f.total.requests * 0.25 * 0.1) / 3600 // 0.25 GB for ~100 ms
    const functions = invocations + cpuHours * P.vercelCpuHour + memGbHours * P.vercelMemGbHour
    const appEgressGb = (f.total.requests * 30) / 1e6 // ~30 KB per request through the app
    const bw = Math.max(0, appEgressGb - P.vercelBandwidthIncluded) * P.vercelBandwidthOver
    L('Hosting', 'Vercel Pro (1 developer seat)', P.vercelProSeat, 'requests', 'verified', 'Hobby forbids commercial use.', true)
    L('Hosting', 'Vercel functions + bandwidth beyond the plan', Math.max(0, functions - 20) + bw, 'requests', 'assumption', 'The Pro seat includes $20 of usage credit; 50 ms CPU and 100 ms memory per request are assumptions.')

    // --- Database/auth: Supabase Pro ---
    const c = computeTier(f.mau)
    const dbOver = Math.max(0, f.dbGb - P.supabaseDbIncluded) * P.supabaseDbOver
    const mauOver = Math.max(0, f.mau - P.supabaseMauIncluded) * P.supabaseMauOver
    // Files: Supabase storage below ~1 TB of files; Cloudflare R2 (free egress) beyond, because file egress is the bill.
    const useR2 = users >= 50_000
    const storageCost = useR2 ? f.fileGb * P.r2Storage + (f.total.egressGb * 4000 / 1e6) * P.r2ClassB : Math.max(0, f.fileGb - P.supabaseStorageIncluded) * P.supabaseStorageOver
    const egressOver = useR2 ? 0 : Math.max(0, f.total.egressGb - P.supabaseEgressIncluded) * P.supabaseEgressOver
    const peakConn = f.mau * 0.02
    const connOver = Math.max(0, peakConn - P.supabaseRealtimeConnIncluded) / 1000 * P.supabaseRealtimeConnOver
    const msgOver = Math.max(0, f.total.realtimeMsgs / 1e6 - P.supabaseRealtimeMsgIncluded) * P.supabaseRealtimeMsgOver
    L('Database & auth', 'Supabase Pro base', P.supabaseProBase, 'requests', 'verified', undefined, true)
    L('Database & auth', `Supabase compute: ${c.name}`, Math.max(0, c.price - P.supabaseComputeCredit), 'requests', 'assumption', `Size picked by a rule of thumb on MAU (${Math.round(f.mau).toLocaleString('en-US')}); $10 credit subtracted.`, true)
    if (mauOver > 0) L('Database & auth', 'Supabase auth MAU overage', mauOver, 'requests', 'verified')
    if (dbOver > 0) L('Database & auth', `Database size over 8 GB (${f.dbGb.toFixed(1)} GB)`, dbOver, 'dbMb', 'verified')
    if (users >= 100_000) L('Database & auth', 'Point-in-time recovery add-on', P.supabasePitr, 'dbMb', 'verified', 'Added at 100k: a real client relies on it.', true)
    if (connOver > 0) L('Database & auth', 'Realtime connections over 500', connOver, 'realtimeMsgs', 'verified')
    if (msgOver > 0) L('Database & auth', 'Realtime messages over 5M', msgOver, 'realtimeMsgs', 'verified')
    if (f.fileGb > 0 || f.total.egressGb > 0) L('Files', useR2 ? `Cloudflare R2: ${Math.round(f.fileGb).toLocaleString('en-US')} GB, free egress` : `Supabase Storage: ${f.fileGb.toFixed(1)} GB, egress ${Math.round(f.total.egressGb)} GB`, storageCost + egressOver, 'storageGb', 'verified')

    // --- Worker + backups + monitoring ---
    const workers = Math.max(1, Math.ceil(f.mau / 50_000))
    L('Worker & backups', `Worker VPS × ${workers}`, workers * P.hetznerWorkerBox * eur, 'requests', 'verified', undefined, true)
    const backupTb = (f.dbGb * 0.3 * 14 + f.fileGb) / 1000 // compressed dumps, 14 nightly
    L('Worker & backups', 'Encrypted backups on B2', Math.max(0, backupTb * P.b2Storage), 'dbMb', 'verified', '14 nightly compressed dumps (assumed 30% of size) + one copy of the files; B2 free egress covers restores.')
    L('Other', 'Domain', P.domain / 12, 'requests', 'assumption', undefined, true)
    if (users >= 1_000) L('Other', 'Sentry Team', P.sentryTeam, 'requests', 'assumption', undefined, true)
  } else {
    // --- Self-run: Postgres shards, containers, CDN, object storage ---
    const qps = peakRps * 4 // 4 queries per request (assumption)
    const shards = Math.max(1, Math.ceil(qps / 6000)) // 6,000 qps per Multi-AZ r6g.4xlarge primary (assumption)
    const perShard = P.rdsR6g4xlMultiAzHour * 730 * 1.5 // primary Multi-AZ + one read replica (+50%)
    L('Database', `${shards.toLocaleString('en-US')} Postgres shard(s) (db.r6g.4xlarge Multi-AZ + replica)`, shards * perShard, 'requests', 'third-party', `Peak ≈ ${Math.round(qps).toLocaleString('en-US')} queries/s at 4 queries per request, 6,000/s per primary — all assumptions; load-test before buying.`, true)
    L('Database', `Database storage ${Math.round(f.dbGb).toLocaleString('en-US')} GB × 2 copies`, f.dbGb * 2 * P.rdsStorageGb, 'dbMb', 'assumption')
    L('Auth', 'Self-hosted auth service (containers, share of compute)', (f.mau / 1e6) * 40, 'requests', 'assumption', '≈ $40 per million MAU of containers; replaces Supabase Auth MAU billing.', true)
    L('Hosting', 'App servers on containers', (f.total.requests / 1e6) * P.containerPerMReq, 'requests', 'assumption', 'Replaces Vercel: its bandwidth ($0.15/GB) and per-invocation pricing do not survive this volume.', true)
    const cdn = arch === 'self-run' ? P.cdnPerGb10M : P.cdnPerGb1B
    const egressForCdn = f.total.egressGb
    L('Files', `Object storage ${Math.round(f.fileGb).toLocaleString('en-US')} GB (R2-class)`, f.fileGb * P.r2Storage * (arch === 'multi-region' ? 0.7 : 1), 'storageGb', 'assumption', arch === 'multi-region' ? '30% volume discount assumed.' : undefined)
    L('Files', `CDN egress ${Math.round(egressForCdn).toLocaleString('en-US')} GB at $${cdn}/GB`, egressForCdn * cdn, 'egressGb', 'assumption', 'The biggest line at 1B users. Rate is a negotiated-deal assumption.')
    const backupTb = (f.dbGb * 0.3 * 14 + f.fileGb) / 1000 // compressed dumps, 14 nightly
    L('Worker & backups', 'Job workers (pg-boss or successor) + backups', (f.mau / 1e6) * 15 + backupTb * P.b2Storage * 0.5, 'requests', 'assumption', undefined, true)
    if (arch === 'self-run') L('Other', 'Monitoring, logging, tooling', P.queuesAndSearchFlat, 'requests', 'assumption', 'Plus people — NOT in these numbers. A 10M-user platform needs an infrastructure team.', true)
    else L('Other', 'Monitoring, logging, tooling', P.queuesAndSearchFlat * 25, 'requests', 'assumption', 'Plus people and multi-region networking — NOT in these numbers.', true)
  }

  const monthly = lines.reduce((s, l) => s + l.monthly, 0)

  // What staying on Supabase + Vercel list prices would cost: LOWER bound (one 16XL cannot carry the big tiers).
  const mauOverAll = Math.max(0, f.mau - P.supabaseMauIncluded) * P.supabaseMauOver
  const sbEgress = Math.max(0, f.total.egressGb - P.supabaseEgressIncluded) * P.supabaseEgressOver
  const sbStorage = Math.max(0, f.fileGb - P.supabaseStorageIncluded) * P.supabaseStorageOver
  const sbDb = Math.max(0, f.dbGb - P.supabaseDbIncluded) * P.supabaseDbOver
  const vercelBw = Math.max(0, (f.total.requests * 30) / 1e6 - P.vercelBandwidthIncluded) * P.vercelBandwidthOver
  const staysManagedLowerBound = P.supabaseProBase + computeTier(f.mau).price + mauOverAll + sbEgress + sbStorage + sbDb + vercelBw + (f.total.requests / 1e6) * 2.5 + P.vercelProSeat

  return {
    architecture: arch,
    name: ARCH_NAMES[arch],
    lines,
    staysManagedLowerBound,
    platformInfraMonthly: lines.filter((l) => ['Database', 'Database & auth', 'Auth', 'Hosting', 'Files'].includes(l.group)).reduce((t, l) => t + l.monthly, 0),
    monthly,
    yearly: monthly * 12,
    changes: CHANGES[arch](users),
    accuracy: ACCURACY[arch],
  }
}

const ARCH_NAMES: Record<Architecture, string> = {
  managed: 'Managed services: Supabase + Vercel + a worker box',
  'self-run': 'Self-run: sharded Postgres, own containers, CDN',
  'multi-region': 'Multi-region cells, own network edge',
}

const ACCURACY: Record<Architecture, string> = {
  managed: 'Within about ±30% on the lines marked verified; usage assumptions matter more than prices.',
  'self-run': 'Order of magnitude (could be 0.5×–2×). Staff cost is NOT included and is likely the larger number.',
  'multi-region': 'Order of magnitude only (0.3×–3×). Real costs here come from negotiated deals and engineering choices nobody can quote today.',
}

const CHANGES: Record<Architecture, (users: number) => string[]> = {
  managed: (users) =>
    users < 1_000
      ? [
          'Everything fits the cheapest paid stack. Vercel Hobby and Supabase Free cost $0 but forbid commercial use (Hobby) and pause after a week idle (Free), so a paying client means Vercel Pro + Supabase Pro.',
          'One small worker VPS runs exports and backups. Resend replaces the 2-emails/hour built-in sender.',
          'Video: JaaS is free to 25 monthly video users, then cheaper than a server up to ~30–45.',
        ]
      : users < 50_000
        ? [
            'Same architecture. Database compute is the first thing to grow (Micro → Small → Medium).',
            'Resend Pro for email; Sentry paid. Still no reason to leave Supabase or Vercel.',
            'Self-hosted video starts to beat JaaS above a few dozen video users.',
          ]
        : [
            'Files move off Supabase Storage to Cloudflare R2: file downloads (egress) become the bill and R2 does not charge for them.',
            'Point-in-time recovery becomes worth $100/month; database compute moves to Large/XL; add a read replica when reads dominate.',
            'Supabase Pro includes 100k auth MAU, so auth overage appears only above ~330k registered users at 30% active.',
            'Realtime connections pass the 500 included: add a per-1,000 charge, then consider moving chat off Realtime.',
            'Resend Scale (no daily cap); a dedicated sending IP once volume is steady.',
          ],
  'self-run': () => [
    'Supabase Pro tops out: one database instance (largest add-on is 16XL, about $3,730/month) cannot carry millions of active users, and auth MAU billing alone reaches five figures a month. Move Postgres to a managed cluster you control (RDS/Aurora or similar) and SHARD it — by org first, because every table already carries org_id.',
    'Vercel leaves: its bandwidth and invocation pricing become the largest line. Run the app on containers behind a load balancer.',
    'Auth moves to a self-run service (Supabase Auth is open source) or a dedicated identity vendor with negotiated MAU pricing.',
    'CDN contract with a commit; images resized once at upload, not per view. Email via your own sending domains on AWS SES.',
    'Search, queues, caches (Redis) and a real observability stack appear. This is also the size at which one person can no longer run the platform: budget an infrastructure team.',
  ],
  'multi-region': () => [
    'One region is no longer acceptable: users are on every continent, so the platform becomes independent CELLS (each a full stack serving a slice of users) in several regions, with a thin global layer for routing and sign-in.',
    'You own the edge: multi-CDN or direct peering/own network for downloads and video; egress price per GB is the single biggest lever on the bill.',
    'Photos/video storage is its own product: tiered storage, deduplication, aggressive resizing, and a retention policy (this alone can be the largest cost).',
    'Live video stops being hosted Jitsi: purpose-built media servers with regional placement, or a dedicated video vendor on an enterprise contract.',
    'The cost is dominated by decisions, not list prices: treat these figures as a floor for planning conversations, and get vendor quotes before relying on them. Staff and legal/compliance cost are excluded.',
  ],
}

// ---------------------------------------------------------------------------
// Per-module allocation and per-user cost
// ---------------------------------------------------------------------------

export interface ModuleCost {
  key: string
  name: string
  /** Fully loaded: fixed lines split by the module's share of requests. */
  monthly: number
  /** Usage-driven lines only — what serving this module's users costs even if the fixed plans were free. */
  marginalMonthly: number
  users: number
  perUserMonthly: number
  perUserMarginalMonthly: number
}

/** Split every line item by the module's share of that line's driver. */
export function allocate(users: number, modules: ModuleAssumption[], g: Globals, plan: TierPlan): ModuleCost[] {
  const f = computeFlows(users, modules, g)
  return modules.map((m) => {
    let monthly = 0
    let marginalMonthly = 0
    for (const l of plan.lines) {
      const total = f.total[l.basis]
      if (total <= 0) continue
      const share = l.monthly * (f.byModule[m.key][l.basis] / total)
      monthly += share
      if (!l.fixed) marginalMonthly += share
    }
    const n = f.moduleUsers[m.key]
    return { key: m.key, name: m.name, monthly, marginalMonthly, users: n, perUserMonthly: n > 0 ? monthly / n : 0, perUserMarginalMonthly: n > 0 ? marginalMonthly / n : 0 }
  })
}

export interface PersonaCost {
  perUserMonthly: number
  perUserYearly: number
  /** Usage-driven part only (no share of fixed plans). */
  perUserMarginalMonthly: number
}

/** Cost to serve one active user who uses the chosen modules (core is always included). */
export function personaCost(costs: ModuleCost[], moduleKeys: string[]): PersonaCost {
  const keys = new Set([CORE_KEY, ...moduleKeys])
  const perUserMonthly = costs.filter((c) => keys.has(c.key)).reduce((s, c) => s + c.perUserMonthly, 0)
  const perUserMarginalMonthly = costs.filter((c) => keys.has(c.key)).reduce((s, c) => s + c.perUserMarginalMonthly, 0)
  return { perUserMonthly, perUserYearly: perUserMonthly * 12, perUserMarginalMonthly }
}

/** Price that earns `marginPct` margin on cost. 40 → price = cost / 0.6. */
export function priceForMargin(cost: number, marginPct: number): number {
  return marginPct >= 100 ? Infinity : cost / (1 - marginPct / 100)
}
