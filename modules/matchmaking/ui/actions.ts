'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

// Single's own-answer actions. RLS (mm_answers_update_own + the lock/identity
// triggers) is the enforcement layer; a single supplies only the unlocked
// fields, and the trigger overwrites any admin-locked ones defensively.

export async function saveAnswer(orgSlug: string, questionId: string, formData: FormData) {
  const position = Number(formData.get('position'))
  const care = Number(formData.get('care'))
  const dealbreaker = formData.get('dealbreaker') === 'on'
  const shareWithMatch = formData.get('share') === 'on'
  if (Number.isNaN(position) || Number.isNaN(care)) throw new Error('Invalid answer')

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')

  const { error } = await supabase
    .from('mm_answers')
    .update({
      position,
      care,
      dealbreaker,
      share_with_match: shareWithMatch,
      auto: false, // an explicit save is a "touched" answer
    })
    .eq('question_id', questionId)
    .eq('user_id', user.id)
  if (error) throw new Error(`Save answer failed: ${error.message}`)

  // The mm_mark_pairs_stale trigger flags this user's pair rows; the matches
  // list shows them as pending until an admin (or the future worker) recomputes.
  revalidatePath(`/o/${orgSlug}/m/matchmaking`)
}

// Mutual-agreement → introduction flow (founder item 3, 2026-07-12). Interest
// is directional and private to its author: RLS's insert policy only allows
// expressing your OWN interest in a real non-excluded scored match, and the
// select policy never exposes incoming interest — the other side learns of it
// only when it becomes mutual (via the mm_mutual_matches definer function).

export async function expressInterest(orgSlug: string, orgId: string, targetUserId: string) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')

  const { error } = await supabase
    .from('mm_interests')
    .insert({ org_id: orgId, user_id: user.id, target_user_id: targetUserId })
  // A double-click hits the (org, user, target) unique constraint — already
  // interested is the state the caller wanted, not an error.
  if (error && !/duplicate|unique/i.test(error.message)) {
    throw new Error(`Express interest failed: ${error.message}`)
  }
  revalidatePath(`/o/${orgSlug}/m/matchmaking`)
}

export async function withdrawInterest(orgSlug: string, orgId: string, targetUserId: string) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')

  // Withdrawing before the other side agrees means the pair never became
  // mutual — nothing was ever revealed to anyone.
  const { error } = await supabase
    .from('mm_interests')
    .delete()
    .eq('org_id', orgId)
    .eq('user_id', user.id)
    .eq('target_user_id', targetUserId)
  if (error) throw new Error(`Withdraw failed: ${error.message}`)
  revalidatePath(`/o/${orgSlug}/m/matchmaking`)
}
