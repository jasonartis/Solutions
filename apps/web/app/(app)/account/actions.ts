'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

// Your own display name. Added with the email slice (docs/22 §11 step 1):
// once `profiles.email` is gone, `display_name` is the ONLY label a co-member
// ever sees, so it cannot stay a write-once field set at signup. The column
// grant for this has existed since 20260706120000 (`grant update (display_name)
// on public.profiles to authenticated`) and nothing had ever used it.
//
// Runs as the caller. `profiles_update_own` (USING and WITH CHECK both
// `user_id = auth.uid()`) is the real gate; the eq() below is not a bound.
export async function setDisplayName(formData: FormData) {
  const displayName = String(formData.get('displayName') ?? '').trim()
  if (!displayName) return { ok: false as const, reason: 'A display name is required.' }
  if (displayName.length > 80) return { ok: false as const, reason: 'Display name must be 80 characters or fewer.' }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, reason: 'Not signed in.' }

  const { error } = await supabase.from('profiles').update({ display_name: displayName }).eq('user_id', user.id)
  // docs/03 #22: return a reason, never throw — a thrown message from a Server
  // Action is REDACTED in production.
  if (error) return { ok: false as const, reason: error.message }

  revalidatePath('/account')
  revalidatePath('/dashboard')
  return { ok: true as const }
}

// DELETE MY ACCOUNT (docs/21 §7.9, migration 20261007090000).
//
// This only STARTS the 30-day grace period. Nothing is removed today: the
// account is signed out everywhere, and signing back in before the date
// cancels it. The irreversible step runs later, from a daily database job.
//
// The typed confirmation is the person's own email address, and it is checked
// INSIDE the database function, not here — so calling the RPC directly cannot
// skip it. Refusals come back as values (docs/03 #22).
const DELETION_REASONS: Record<string, string> = {
  confirmation_mismatch: 'That is not the email address on this account, so nothing was changed.',
  blocked: 'Your account cannot be deleted yet — see above.',
  already_deleted: 'This account has already been deleted.',
  not_signed_in: 'Not signed in.',
}

export async function requestAccountDeletion(formData: FormData) {
  const confirmEmail = String(formData.get('confirmEmail') ?? '').trim()
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('account_request_deletion', { confirm_email: confirmEmail })
  if (error) return { ok: false as const, reason: error.message }
  const result = data as { ok: boolean; reason?: string; due_at?: string }
  if (!result.ok) {
    return { ok: false as const, reason: DELETION_REASONS[result.reason ?? ''] ?? 'Something went wrong; nothing was changed.' }
  }
  // The database already deleted every session; this clears this browser's
  // cookies so the page does not keep showing a signed-in state for up to an
  // hour on a token that is still technically valid.
  await supabase.auth.signOut({ scope: 'local' })
  const due = result.due_at ? result.due_at.slice(0, 10) : ''
  redirect(`/login?deletion=scheduled&due=${encodeURIComponent(due)}`)
}
