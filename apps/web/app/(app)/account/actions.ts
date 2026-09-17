'use server'

import { revalidatePath } from 'next/cache'
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
