import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

// The standard module-page gate (extraction pass, docs/04): resolve the org by
// slug, verify the module is enabled for it, 404 otherwise. RLS already hides
// orgs the caller isn't a member of, so a non-member and a nonexistent org are
// indistinguishable — exactly what we want.
//
// Usage (every module page):
//   const { supabase, org, settings } = await requireOrgModule(orgSlug, 'my-module')
export async function requireOrgModule(orgSlug: string, moduleKey: string) {
  const supabase = await createClient()

  const { data: org } = await supabase
    .from('orgs')
    .select('id, name, slug')
    .eq('slug', orgSlug)
    .single()
  if (!org) notFound()

  const { data: entitlement } = await supabase
    .from('org_modules')
    .select('enabled, settings')
    .eq('org_id', org.id)
    .eq('module_key', moduleKey)
    .single()
  if (!entitlement?.enabled) notFound()

  return {
    supabase,
    org,
    settings: (entitlement.settings ?? {}) as Record<string, unknown>,
  }
}
