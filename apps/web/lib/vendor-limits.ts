// Vendor free-tier limits the Owner Console's Limits tile watches (founder's watch
// list, 2026-11-10: active people per month, database size, storage, and the
// 25-people-a-month video cap). Every number here was READ from the vendor's own page
// on the date shown — do not edit one from memory; re-fetch the page and change the
// date with it. Prices and these limits drift (docs/costs README "re-fetch before
// budgeting").

export type VendorLimit = { value: number; unit: string; source: string; checked: string }

export const VENDOR_LIMITS = {
  // Supabase Free plan — https://supabase.com/pricing, read 2026-11-12 (Sonnet).
  // The page lists: 50,000 monthly active users, 500 MB database, 1 GB file storage,
  // 5 GB egress, projects paused after 1 week of inactivity, 2 active projects.
  supabaseMau: { value: 50_000, unit: 'monthly active users', source: 'https://supabase.com/pricing', checked: '2026-11-12' },
  supabaseDbMb: { value: 500, unit: 'MB database', source: 'https://supabase.com/pricing', checked: '2026-11-12' },
  supabaseStorageGb: { value: 1, unit: 'GB file storage', source: 'https://supabase.com/pricing', checked: '2026-11-12' },
  // 8x8 JaaS Developer plan: 25 monthly active users free. NOT re-fetched on 2026-11-12:
  // the figure is the one already recorded in docs/02 "Video" and cost-model.ts
  // (`jaasOver` note, source https://cpaas.8x8.com/en/pricing/jitsi-as-a-service-pricing/).
  jaasFreeMau: {
    value: 25,
    unit: 'video people a month',
    source: 'docs/02 "Video"; https://cpaas.8x8.com/en/pricing/jitsi-as-a-service-pricing/',
    checked: '2026-10-02 (docs/02), not re-fetched 2026-11-12',
  },
} as const satisfies Record<string, VendorLimit>

// Vercel Hobby, read 2026-11-12 from https://vercel.com/docs/limits/fair-use-guidelines
// ("Typical monthly usage guidelines"): 100 GB Fast Data Transfer, 1,000,000 function
// invocations, 10 GB Fast Origin Transfer, 4 hours Active CPU, 360 GB-hrs Provisioned
// Memory. Same page: "Hobby teams are restricted to non-commercial personal use only"
// — a paying client means Pro, a plan question not a usage one. NOT on the tile: none
// of these is on the founder's watch list and none is measurable from our own tables
// (Vercel's usage page is the only source). Recorded here so the next session need not
// re-fetch it for a budget.

// How a figure compares with its limit.
export type LimitLevel = 'ok' | 'near' | 'over'

/** 80% of a limit or more is "near"; past 100% is "over". */
export function limitLevel(used: number, cap: number): LimitLevel {
  if (used > cap) return 'over'
  if (used >= cap * 0.8) return 'near'
  return 'ok'
}
