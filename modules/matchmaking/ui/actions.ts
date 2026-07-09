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
