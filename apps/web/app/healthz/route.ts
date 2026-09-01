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
  const { error } = await supabase.rpc('syn_public_weeks', { p_org_slug: 'demo-shul' })

  return NextResponse.json(
    {
      ok: !error,
      checkedAt: new Date().toISOString(),
      ...(error ? { error: error.message } : {}),
    },
    {
      status: error ? 503 : 200,
      headers: { 'Cache-Control': 'no-store' },
    },
  )
}
