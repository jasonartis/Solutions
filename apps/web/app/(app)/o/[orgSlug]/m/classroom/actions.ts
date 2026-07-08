'use server'

import { revalidatePath } from 'next/cache'
import { DERIVED_SCOPE_PLACEHOLDER } from '@platform/core'
import { createClient } from '@/lib/supabase/server'

// Student-facing classroom actions (the landing page).

export async function answerSurvey(orgSlug: string, surveyId: string, classId: string, formData: FormData) {
  const answer = String(formData.get('answer') ?? '').trim()
  if (!answer) throw new Error('An answer is required')

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')

  // One answer per (survey, user): update in place if they already responded.
  const { data: existing } = await supabase
    .from('cls_survey_answers')
    .select('id')
    .eq('survey_id', surveyId)
    .eq('user_id', user.id)
    .maybeSingle()

  const { error } = existing
    ? await supabase.from('cls_survey_answers').update({ answer }).eq('id', existing.id)
    : await supabase.from('cls_survey_answers').insert({
        org_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
        class_id: classId,
        survey_id: surveyId,
        user_id: user.id,
        answer,
      })
  if (error) throw new Error(`Submit answer failed: ${error.message}`)
  revalidatePath(`/o/${orgSlug}/m/classroom`)
}
