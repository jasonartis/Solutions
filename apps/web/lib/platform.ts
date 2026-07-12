import { moduleRegistry } from '@platform/core'
import { createClient } from '@/lib/supabase/server'

export type OrgWithModules = {
  id: string
  name: string
  slug: string
  role: string
  modules: { key: string; name: string; myRole: string | null }[]
}

// Everything the shell needs: the user's orgs and, per org, the enabled
// modules that actually exist in the registry. RLS already scopes both
// queries to the caller's memberships.
//
// myRole (founder feedback, 2026-07-11: "logging in as bob vs alice I did
// not see a distinction") is the caller's own module_roles role for that
// module (professor/GA/student, matchmaker/single/admin, etc.) — distinct
// from the org-level `role` above (owner/admin/member), which is the same
// for anyone who happens to be an org admin regardless of what they
// actually DO in each module.
export async function getOrgsWithModules(): Promise<OrgWithModules[]> {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return []

  // RLS lets members see ALL rows of their orgs (needed elsewhere) — the
  // dashboard wants only the caller's own memberships, one per org.
  const [{ data: memberships }, { data: entitlements }, { data: myModuleRoles }] = await Promise.all([
    supabase.from('org_members').select('role, orgs(id, name, slug)').eq('user_id', user.id),
    supabase.from('org_modules').select('org_id, module_key').eq('enabled', true),
    supabase.from('module_roles').select('org_id, module_key, role').eq('user_id', user.id),
  ])
  if (!memberships || memberships.length === 0) return []

  return memberships.flatMap((m) => {
    const org = m.orgs as unknown as { id: string; name: string; slug: string } | null
    if (!org) return []
    const modules = (entitlements ?? [])
      .filter((e) => e.org_id === org.id)
      .flatMap((e) => {
        const manifest = moduleRegistry.find((mod) => mod.key === e.module_key)
        if (!manifest) return []
        const myRoles = (myModuleRoles ?? [])
          .filter((r) => r.org_id === org.id && r.module_key === e.module_key)
          .map((r) => r.role)
        return [{ key: manifest.key, name: manifest.name, myRole: myRoles.length ? myRoles.join(' / ') : null }]
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
