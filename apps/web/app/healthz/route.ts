import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Uncacheable by design (docs/18 item 1): a cached result would report the
// last good check forever and stop touching the database, losing both the
// alerting and the keep-alive purpose. Route Handlers aren't cached by
// default in this Next version, but state it explicitly rather than rely on
// that default surviving a future config change.
export const dynamic = 'force-dynamic'

// The 2026-07-28 ACL sweep left `anon` holding no table grants in `public` —
// only EXECUTE on the two security-definer RPCs apps/web/app/s/[orgSlug]
// itself calls (supabase/migrations/20260728010000_acl_hardening.sql).
// Reusing that same RPC against `demo-shul` (kept permanently seeded and
// published for exactly this reason — packages/db/src/seed.ts) proves a
// real RLS-safe database round-trip without a new grant or migration.
export async function GET() {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('syn_public_weeks', { p_org_slug: 'demo-shul' })

  // A missing `demo-shul` org comes back as `data: null, error: null` (the
  // RPC ran fine, it just found nothing) — the same shape a genuine outage
  // of the RLS/grant path can't produce, but one that would still mean the
  // probe stopped proving anything. Treat it as unhealthy too.
  const healthy = !error && !!data
  const reason = error ? error.message : !data ? 'demo-shul RPC returned no data' : undefined

  return NextResponse.json(
    {
      ok: healthy,
      checkedAt: new Date().toISOString(),
      ...(reason ? { error: reason } : {}),
    },
    {
      status: healthy ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    },
  )
}
