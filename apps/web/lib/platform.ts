import { moduleRegistry } from '@platform/core'
import { createClient } from '@/lib/supabase/server'

export type OrgWithModules = {
  id: string
  name: string
  slug: string
  role: string
  modules: { key: string; name: string }[]
}

// Everything the shell needs: the user's orgs and, per org, the enabled
// modules that actually exist in the registry. RLS already scopes both
// queries to the caller's memberships.
export async function getOrgsWithModules(): Promise<OrgWithModules[]> {
  const supabase = await createClient()

  const { data: memberships } = await supabase
    .from('org_members')
    .select('role, orgs(id, name, slug)')
  if (!memberships || memberships.length === 0) return []

  const { data: entitlements } = await supabase
    .from('org_modules')
    .select('org_id, module_key')
    .eq('enabled', true)

  return memberships.flatMap((m) => {
    const org = m.orgs as unknown as { id: string; name: string; slug: string } | null
    if (!org) return []
    const modules = (entitlements ?? [])
      .filter((e) => e.org_id === org.id)
      .flatMap((e) => {
        const manifest = moduleRegistry.find((mod) => mod.key === e.module_key)
        return manifest ? [{ key: manifest.key, name: manifest.name }] : []
      })
    return [{ id: org.id, name: org.name, slug: org.slug, role: m.role, modules }]
  })
}

export async function getProfile() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile } = await supabase
    .from('profiles')
    .select('user_id, email, display_name, is_superadmin')
    .eq('user_id', user.id)
    .single()
  return profile
}
