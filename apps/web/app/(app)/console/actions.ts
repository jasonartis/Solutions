'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getModule, moduleRegistry } from '@platform/core'
import { createClient } from '@/lib/supabase/server'
import { blockingRows, type OrgDeleteImpactRow } from '@/lib/org-delete'
import {
  changeMemberRole,
  inviteOrgMember,
  removeModuleRole,
  removeOrgMember,
  resolveEmailToUserId,
  upsertModuleRole,
} from '@/lib/org-members'
import { parseSynagogueSettingsForm } from '@/lib/synagogue-settings'

// Owner-console server actions. RLS already restricts writes on these tables
// to superadmins, but each action also verifies explicitly so failures are
// clear errors rather than silently-empty writes.
async function requireSuperadmin() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')

  // `is_superadmin` moved to `public.user_private` with the email slice
  // (docs/22 §21); `is_superadmin()` is and always was the RLS authority.
  const { data: isSuperadmin } = await supabase.rpc('is_superadmin')
  if (!isSuperadmin) throw new Error('Not authorized')
  return supabase
}

/** The ONE slug normaliser. createOrg and renameOrg must agree: an org created
 *  one way and renamed the other could otherwise end up with a slug the router
 *  cannot match.
 *
 *  The last two rules are NEW (2026-09-28) and change createOrg's behaviour
 *  slightly, deliberately. The old rule mapped every run of invalid characters
 *  to a dash and stopped, so `Slug Probe NEW!!` became `slug-probe-new-` — a
 *  trailing dash nobody wants, which only became visible once addresses were
 *  editable and could be seen being produced. Leading/trailing dashes are
 *  stripped and runs collapsed; `!!!` (which used to yield `---`) now yields
 *  the empty string and is caught by assertUsableSlug. */
function normalizeSlug(raw: FormDataEntryValue | null): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

function assertUsableSlug(slug: string) {
  if (!slug || !/[a-z0-9]/.test(slug)) {
    throw new Error('Slug must contain at least one letter or number')
  }
}

export async function createOrg(formData: FormData) {
  const supabase = await requireSuperadmin()
  const name = String(formData.get('name') ?? '').trim()
  const slug = normalizeSlug(formData.get('slug'))
  if (!name) throw new Error('Name and slug are required')
  assertUsableSlug(slug)

  const { error } = await supabase.from('orgs').insert({ name, slug })
  if (error) {
    // Same expected-refusal reasoning as renameOrg below (docs/03 #22).
    if (error.code === '23505') {
      redirect(
        `/console?error=${encodeURIComponent(
          `An organization already uses the address "${slug}", so nothing was created.`,
        )}`,
      )
    }
    throw new Error(error.message)
  }
  revalidatePath('/console')
}

// Founder feedback (2026-07-16): no way anywhere to rename an org — surfaced
// while explaining that the "Solutions" org is really Pozna's real client
// (slug `pozne`), just misleadingly named.
//
// ⚠ THAT DECISION IS REVERSED (2026-09-28, founder). The original rule was
// "slug is deliberately NOT editable here — it's baked into the public
// schedule URL (/s/pozne) and anything else already linking to it; renaming
// that would break existing links."
//
// WHY IT CHANGED, recorded rather than silently flipped. The founder raised it
// himself: `orgs.id` is the identity and `slug` is only a unique label —
// verified that `orgs.slug` is the ONLY slug column in the database, so no
// other table holds a copy and no data can be orphaned by changing it. The
// original concern is real but it is REVERSIBLE: change the slug back and the
// links work again. Forbidding it permanently made a typo'd slug unfixable
// forever, which is the worse failure. So it warns loudly instead of refusing
// — the same principle applied to deleteOrg below, which DOES refuse, because
// that one is not reversible.
export async function renameOrg(orgId: string, formData: FormData) {
  const supabase = await requireSuperadmin()
  const name = String(formData.get('name') ?? '').trim()
  if (!name) throw new Error('Name is required')

  const patch: { name: string; slug?: string } = { name }

  // The slug field is optional: a form that omits it renames only the name,
  // exactly as before this change.
  const rawSlug = formData.get('slug')
  if (rawSlug !== null && String(rawSlug).trim() !== '') {
    const slug = normalizeSlug(rawSlug)
    assertUsableSlug(slug)
    patch.slug = slug
  }

  const { error } = await supabase.from('orgs').update(patch).eq('id', orgId)
  if (error) {
    // 23505 = unique_violation on orgs_slug_key. Typing an address someone else
    // already has is an EXPECTED refusal, not a crash — and docs/03 #22 is
    // explicit that THROWING from a server action for an expected refusal gets
    // the message redacted, so the user would see nothing useful. Verified in a
    // browser: the thrown version surfaced no text at all. Redirect with the
    // reason instead, exactly as deleteOrg does.
    if (error.code === '23505') {
      redirect(
        `/console?error=${encodeURIComponent(
          `Another organization already uses the address "${patch.slug}", so nothing was changed.`,
        )}`,
      )
    }
    throw new Error(error.message)
  }
  revalidatePath('/console')
}

export async function toggleModule(orgId: string, moduleKey: string, enable: boolean) {
  if (!moduleRegistry.some((m) => m.key === moduleKey)) throw new Error('Unknown module')
  const supabase = await requireSuperadmin()

  const { error } = await supabase
    .from('org_modules')
    .upsert({ org_id: orgId, module_key: moduleKey, enabled: enable })
  if (error) throw new Error(error.message)
  revalidatePath('/console')
}

export async function addMember(orgId: string, formData: FormData) {
  const supabase = await requireSuperadmin()
  const email = String(formData.get('email') ?? '').trim()
  const role = String(formData.get('role') ?? 'member')
  // Superadmin-only choice (guard-enforced): add immediately-active vs a pending
  // invite. The checkbox posts 'immediate' only when ticked.
  const immediate = formData.get('immediate') != null
  if (!orgId || !email) throw new Error('Org and email are required')

  const found = await resolveEmailToUserId(supabase, orgId, email)
  if (!found) throw new Error(`No user found with email ${email} — they must sign up first`)

  await inviteOrgMember(supabase, orgId, found.userId, role, immediate ? 'active' : 'pending')
  revalidatePath('/console')
}

// Persist the superadmin's default for "add member" (immediately-active vs
// pending invite). Stored on their own private row; only their own is writable.
export async function setAddMemberDefault(formData: FormData) {
  const supabase = await requireSuperadmin()
  const active = formData.get('defaultActive') != null
  // `settings` moved off `profiles` (docs/22 §21). Read-modify-write through the
  // two definers, which only ever touch `auth.uid()`'s own row — there is no
  // parameter on either that could name another user.
  const { data: privateRows } = await supabase.rpc('current_user_private')
  const current = ((privateRows as { settings: unknown }[] | null)?.[0]?.settings ?? {}) as Record<string, unknown>
  const settings = { ...current, superadminDefaultAddActive: active }
  const { error } = await supabase.rpc('set_current_user_settings', { new_settings: settings })
  if (error) throw new Error(error.message)
  revalidatePath('/console')
}

export async function changeRole(orgId: string, formData: FormData) {
  const supabase = await requireSuperadmin()
  const userId = String(formData.get('userId') ?? '')
  const role = String(formData.get('role') ?? '')
  if (!orgId || !userId || !role) throw new Error('Org, member, and role are required')

  await changeMemberRole(supabase, orgId, userId, role)
  revalidatePath('/console')
}

export async function removeMember(orgId: string, userId: string) {
  const supabase = await requireSuperadmin()
  await removeOrgMember(supabase, orgId, userId)
  revalidatePath('/console')
}

export async function addModuleRole(orgId: string, formData: FormData) {
  const supabase = await requireSuperadmin()
  const userId = String(formData.get('userId') ?? '')
  const moduleKey = String(formData.get('moduleKey') ?? '')
  const role = String(formData.get('role') ?? '')
  if (!userId || !moduleKey || !role) throw new Error('Member, module, and role are required')

  const manifest = getModule(moduleKey)
  if (!manifest || !manifest.roles.includes(role)) throw new Error('Unknown module role')

  await upsertModuleRole(supabase, orgId, userId, moduleKey, role)
  revalidatePath('/console')
}

export async function removeModuleRoleAction(orgId: string, userId: string, moduleKey: string, role: string) {
  const supabase = await requireSuperadmin()
  await removeModuleRole(supabase, orgId, userId, moduleKey, role)
  revalidatePath('/console')
}

// Founder feedback (2026-07-12): synagogue-schedules' location settings
// (address/timezone/myzmanim id) were seed-only, no UI anywhere to view or
// edit them. No migration needed — org_modules.settings is already a jsonb
// column the superadmin write policy fully covers (the same path
// toggleModule already uses); this is purely a missing form.
export async function updateSynagogueSettings(orgId: string, formData: FormData) {
  const supabase = await requireSuperadmin()
  const settings = parseSynagogueSettingsForm(formData)

  const { error } = await supabase
    .from('org_modules')
    .update({ settings })
    .eq('org_id', orgId)
    .eq('module_key', 'synagogue-schedules')
  if (error) throw new Error(error.message)
  revalidatePath('/console')
}

// ---------------------------------------------------------------------------
// Deleting an org (2026-09-28, migration 20260928010000)
// ---------------------------------------------------------------------------
// THE NEED (docs/18 item 8): undoing an onboarding mistake — wrong slug, wrong
// client — previously required a session with direct database access, because
// the console had no delete affordance at all.
//
// WHY THIS REFUSES RATHER THAN WARNS, unlike renameOrg above. Deleting an org
// cascades across 67 tables and there is no rehearsed way back: backups are a
// nightly whole-database dump, and extracting one tenant out of it and
// re-inserting it into live production has never been done. A slug change is
// reversible; this is not. So the rule is the one WhatsApp uses for groups —
// you cannot delete it until it is empty — rather than Slack's "type your
// password and it is gone forever".
//
// SETUP IS NOT CONTENT. A brand-new org legitimately has rows in org_members,
// org_modules and module_roles the moment you configure it; refusing on those
// would make the feature useless for the exact case it exists for. Anything
// else with rows is a real person's real data and blocks the delete.
/** What would deleting this org do? Superadmin-only; the function enforces that
 *  itself and raises on an unknown org id rather than returning an empty list. */
export async function getOrgDeleteImpact(orgId: string): Promise<OrgDeleteImpactRow[]> {
  const supabase = await requireSuperadmin()
  const { data, error } = await supabase.rpc('org_delete_impact', { check_org_id: orgId })
  if (error) throw new Error(error.message)
  return ((data ?? []) as OrgDeleteImpactRow[]).map((r) => ({ ...r, row_count: Number(r.row_count) }))
}

export async function deleteOrg(orgId: string, formData: FormData) {
  const supabase = await requireSuperadmin()

  const { data: org, error: readErr } = await supabase
    .from('orgs')
    .select('id, slug')
    .eq('id', orgId)
    .maybeSingle()
  if (readErr) throw new Error(readErr.message)
  if (!org) throw new Error('That organization no longer exists')

  // Typed confirmation, GitHub-style. Checked BEFORE the impact query so a
  // mistyped slug never reaches the destructive path at all.
  const typed = String(formData.get('confirmSlug') ?? '').trim()
  if (typed !== org.slug) {
    redirect(`/console/orgs/${orgId}/delete?error=${encodeURIComponent('That did not match the address, so nothing was deleted.')}`)
  }

  // Re-checked at submit time, not just at render time: the page the operator
  // is looking at may be minutes old, and something may have been created in
  // the org since it rendered.
  const impact = await getOrgDeleteImpact(orgId)
  const blocking = blockingRows(impact)
  if (blocking.length > 0) {
    const summary = blocking.map((r) => `${r.table_name} (${r.row_count})`).join(', ')
    redirect(
      `/console/orgs/${orgId}/delete?error=${encodeURIComponent(
        `This organization now holds data that would be destroyed: ${summary}. Nothing was deleted.`,
      )}`,
    )
  }

  const { error } = await supabase.from('orgs').delete().eq('id', orgId)
  if (error) throw new Error(error.message)
  revalidatePath('/console')
  redirect('/console')
}

// ACCOUNT DELETION (docs/21 §7.9, migration 20261007090000) — the superadmin
// half, for a deletion request that arrived by email. Like the self-serve
// button it only STARTS the 30-day grace period; the person is signed out
// everywhere and can cancel by signing back in. Refusals come back through the
// page's ?error / ?notice params (docs/03 #22).
const ACCOUNT_DELETION_REASONS: Record<string, string> = {
  no_such_user: 'No account uses that email address.',
  ambiguous_email: 'More than one account matches that address; nothing was changed.',
  already_deleted: 'That account has already been deleted.',
  not_authorized: 'Not authorized.',
  not_pending: 'That deletion is no longer pending, so there was nothing to cancel.',
}

function describeBlockers(blockers: string[] | undefined): string {
  return (blockers ?? [])
    .map((b) =>
      b === 'superadmin'
        ? 'it is a platform owner account'
        : b.startsWith('sole_admin:')
          ? `they are the only administrator of ${b.slice('sole_admin:'.length)}`
          : b.startsWith('sole_director:')
            ? `they are the only Director of ${b.slice('sole_director:'.length)}`
            : b,
    )
    .join('; ')
}

export async function requestAccountDeletionFor(formData: FormData) {
  const supabase = await requireSuperadmin()
  const email = String(formData.get('email') ?? '').trim()
  const { data, error } = await supabase.rpc('account_request_deletion_for_email', { target_email: email })
  if (error) redirect(`/console/accounts?error=${encodeURIComponent(error.message)}`)
  const r = data as { ok: boolean; reason?: string; blockers?: string[]; due_at?: string }
  if (!r.ok) {
    const msg =
      r.reason === 'blocked'
        ? `Not started: ${describeBlockers(r.blockers)}. Resolve that first.`
        : (ACCOUNT_DELETION_REASONS[r.reason ?? ''] ?? 'Nothing was changed.')
    redirect(`/console/accounts?error=${encodeURIComponent(msg)}`)
  }
  revalidatePath('/console/accounts')
  redirect(
    `/console/accounts?notice=${encodeURIComponent(
      `Deletion started for ${email}. It completes on ${r.due_at?.slice(0, 10)} unless they sign in before then.`,
    )}`,
  )
}

export async function cancelAccountDeletion(userId: string) {
  const supabase = await requireSuperadmin()
  const { data, error } = await supabase.rpc('account_cancel_deletion', { target: userId })
  if (error) redirect(`/console/accounts?error=${encodeURIComponent(error.message)}`)
  const r = data as { ok: boolean; reason?: string }
  if (!r.ok) redirect(`/console/accounts?error=${encodeURIComponent(ACCOUNT_DELETION_REASONS[r.reason ?? ''] ?? 'Nothing was changed.')}`)
  revalidatePath('/console/accounts')
  redirect(`/console/accounts?notice=${encodeURIComponent('Deletion cancelled.')}`)
}
