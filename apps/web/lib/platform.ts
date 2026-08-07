import { notFound } from 'next/navigation'
import { moduleRegistry } from '@platform/core'
import { createClient } from '@/lib/supabase/server'
import { getPendingInvites, type PendingInvite } from '@/lib/org-members'

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
    // Only ACCEPTED memberships become dashboard cards; pending invites are
    // surfaced separately by getPendingOrgInvites() (they can't even join to
    // orgs here — orgs RLS refuses a pending invitee the org row).
    supabase.from('org_members').select('role, orgs(id, name, slug)').eq('user_id', user.id).eq('status', 'active'),
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

// The caller's pending org invites (slice 3) for the dashboard invite cards.
// Empty for almost everyone; one row per not-yet-accepted invitation.
export async function getPendingOrgInvites(): Promise<PendingInvite[]> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return []
  return getPendingInvites(supabase)
}

// The caller's org-level role for one org by slug (founder feedback,
// 2026-07-11: "once you click in you lose sight of your role" — the
// dashboard card showed it, but nothing inside the org did). Used by the
// org-scoped layout to keep a persistent "Org Name · ROLE" banner visible
// on every page inside that org, not just the dashboard.
export async function getMyOrgRole(orgSlug: string): Promise<{ orgName: string; role: string } | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data } = await supabase
    .from('org_members')
    .select('role, orgs!inner(name, slug)')
    .eq('orgs.slug', orgSlug)
    .eq('user_id', user.id)
    .eq('status', 'active')
    .maybeSingle()
  if (!data) return null
  const org = data.orgs as unknown as { name: string; slug: string }
  return { orgName: org.name, role: data.role }
}

// The org-level (not module-level) analogue of requireOrgModule
// (lib/module-gate.ts): resolve the org by slug, 404 if the caller isn't an
// org owner/admin (is_org_admin() — RLS's own tenancy check, restated here
// so the page fails with a clear 404 rather than an empty/broken render).
// Used by the org self-management page (docs/03 "Control hierarchy" level 2).
export async function requireOrgAdmin(orgSlug: string) {
  const supabase = await createClient()

  const { data: org } = await supabase.from('orgs').select('id, name, slug').eq('slug', orgSlug).single()
  if (!org) notFound()

  const { data: isAdmin } = await supabase.rpc('is_org_admin', { check_org_id: org.id })
  if (!isAdmin) notFound()

  return { supabase, org }
}

/**
 * PROOF THAT `requireSuperadmin()` ACTUALLY RAN — the token half of
 * `RenderAuthority` (lib/view-as.ts).
 *
 * `declare const` means this symbol has NO runtime value ANYWHERE, including in
 * this file, so a `SuperadminGate` cannot be written as an object literal at
 * all. The single `as` cast inside `requireSuperadmin()` below is the only
 * place in the codebase one can come from, and it sits directly under the
 * `is_superadmin` check it attests to.
 *
 * WHY (adversarial review finding 2, 2026-08-06): `RenderAuthority`'s superadmin
 * arm used to be the bare literal `{ kind: 'platform-superadmin' }`. The
 * mandatory `kind` closed the ACCIDENTAL bypass — no defaulting boolean can give
 * a caller edge-bypassing authority by omission — but NAMING a gate is not
 * PASSING one: any future server action or script could type that literal and
 * call `renderSurface()` having checked nothing, and it would type-check.
 * docs/13 asked for a union no caller can invoke without naming the gate it
 * passed; this is what makes the naming load-bearing.
 *
 * It is a compile-time control, not a runtime one — `as never` still defeats it,
 * and it is not trying to stop that. What it stops is the plausible accident: a
 * new call site that copies the literal out of this page without noticing that
 * the check is what the literal was standing for.
 */
declare const superadminGate: unique symbol
export type SuperadminGate = { readonly [superadminGate]: true }

/**
 * The Owner Console gate: 404 unless the caller is the platform superadmin.
 *
 * Shared because there are now several superadmin-only pages, and the check was
 * previously copy-pasted inline in each console action.
 *
 * WHAT THIS GATE IS, AND IS NOT (docs/03 #19). It is a UI gate, not a security
 * boundary, and the console surfaces are built so that this is safe: every
 * query they run is issued on the caller's OWN RLS-enforced client, so it is
 * one the caller could already make against PostgREST directly. Bypassing this
 * check therefore grants nothing. That property holds only while no console
 * surface calls a SECURITY DEFINER function or a service-role client — the
 * moment one does, this becomes the only thing standing between a user and data
 * RLS would have refused, which is exactly what docs/03 #18 forbids.
 */
export async function requireSuperadmin() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) notFound()

  const { data: profile } = await supabase
    .from('profiles')
    .select('is_superadmin')
    .eq('user_id', user.id)
    .single()
  if (!profile?.is_superadmin) notFound()

  // THE ONE MINT of a SuperadminGate on the platform. Every line above is the
  // check this token attests to; `notFound()` never returns, so reaching here
  // IS the proof. Keep the cast here — moving it anywhere else would turn the
  // token back into something a caller can fabricate.
  const gate = {} as SuperadminGate

  return { supabase, userId: user.id, gate }
}

export async function getProfile() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile } = await supabase
    .from('profiles')
    .select('user_id, email, display_name, is_superadmin, settings')
    .eq('user_id', user.id)
    .single()
  return profile
}
