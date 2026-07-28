'use server'

import { revalidatePath } from 'next/cache'
import { DERIVED_SCOPE_PLACEHOLDER } from '@platform/core'
import { createClient } from '@/lib/supabase/server'

// Professor/staff actions. RLS (cls_can_manage) is the enforcement layer;
// scope-sync triggers derive org_id from the class, so only class_id is sent.

function fail(error: { message: string } | null, what: string) {
  if (error) throw new Error(`${what}: ${error.message}`)
}

// Founder feedback (2026-07-12): "if Alice can add projects in Sample
// Module, shouldn't she be able to add classes in Classroom?" — cls_courses/
// cls_classes already had full staff RLS write access (cls_can_manage, the
// generic staff-write policy loop) and cls_classes already had a scope-sync
// trigger deriving org_id from course_id — this was purely a missing
// action + form, no migration needed.
export async function createCourse(orgSlug: string, formData: FormData) {
  const name = String(formData.get('name') ?? '').trim()
  if (!name) throw new Error('Course name is required')

  const supabase = await createClient()
  const { data: org } = await supabase.from('orgs').select('id').eq('slug', orgSlug).single()
  if (!org) throw new Error('Org not found')

  const { error } = await supabase.from('cls_courses').insert({ org_id: org.id, name })
  fail(error, 'Create course failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/manage`)
}

// Enrollment (user model slice 2b, 2026-07-24). Enrollment is now a SCOPED
// module_roles grant (role @ the class's scope node) — the single source of
// enrollment authority; `cls_is_class_member` and every per-row policy read it
// via scope coverage. The `cls_class_members` row is kept in sync purely as a
// name/badge store (it no longer drives authority), so the two can never
// disagree (the testing-round items 29–30 split). Both writes go through this
// one action.
//
// Authority is enforced by RLS + the module_roles hierarchy guard: a professor
// (Lead) may enroll students/GAs whose scope their grant covers, but cannot
// mint another professor (co-instructor) — that needs a Coordinator/admin. An
// org admin bypasses the ladder. The target must already be an org member.
export async function enrollClassMember(orgSlug: string, classId: string, formData: FormData) {
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  const role = String(formData.get('role') ?? 'student')
  if (!email) throw new Error('Email is required')
  if (!['student', 'ga', 'professor'].includes(role)) throw new Error('Unknown role')

  const supabase = await createClient()
  const { data: profile } = await supabase.from('profiles').select('user_id').eq('email', email).maybeSingle()
  if (!profile) {
    throw new Error(`No user found with email ${email} in this organization — add them as an org member first`)
  }

  // The class's scope node — the grant is pinned to it. Readable to any staff
  // who can manage the class (cls_classes_select policy).
  const { data: klass } = await supabase
    .from('cls_classes')
    .select('org_id, scope_node_id')
    .eq('id', classId)
    .single()
  if (!klass?.scope_node_id) throw new Error('Class has no scope node')

  // The target must be a member of THIS org (review Note 4): the email lookup
  // above resolves anyone sharing ANY org with the caller, so verify org
  // membership before minting a classroom grant — otherwise a non-member could
  // be enrolled and read class content via the grant-based RLS. (Readable to
  // the caller: org_members_select_member lets any org member read the roster.)
  const { data: member } = await supabase
    .from('org_members')
    .select('user_id')
    .eq('org_id', klass.org_id)
    .eq('user_id', profile.user_id)
    .eq('status', 'active')
    .maybeSingle()
  if (!member) {
    throw new Error(`No user found with email ${email} in this organization — add them as an org member first (and they must have accepted the invite)`)
  }

  // One role per (user, class): drop any prior grant at this class node, then
  // grant the chosen role. Runs as the caller under the guard, so a professor
  // changing a co-instructor's seat is correctly rejected (only admin/coord).
  await supabase
    .from('module_roles')
    .delete()
    .eq('org_id', klass.org_id)
    .eq('module_key', 'classroom')
    .eq('user_id', profile.user_id)
    .eq('scope_ref', klass.scope_node_id)
  const { error: grantErr } = await supabase.from('module_roles').insert({
    org_id: klass.org_id,
    user_id: profile.user_id,
    module_key: 'classroom',
    role,
    scope_ref: klass.scope_node_id,
  })
  fail(grantErr, 'Enroll failed')

  // Name/badge store (authority already granted above).
  const { error } = await supabase.from('cls_class_members').upsert(
    {
      org_id: DERIVED_SCOPE_PLACEHOLDER, // derived by cls_class_members_scope trigger from class_id
      class_id: classId,
      user_id: profile.user_id,
      role,
    },
    { onConflict: 'class_id,user_id' },
  )
  fail(error, 'Enroll (roster) failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/manage`)
}

export async function removeClassMember(orgSlug: string, classId: string, userId: string) {
  const supabase = await createClient()
  const { data: klass } = await supabase.from('cls_classes').select('org_id, scope_node_id').eq('id', classId).single()
  if (klass?.scope_node_id) {
    // Revoke the scoped enrollment grant (the authority) …
    const { error: grantErr } = await supabase
      .from('module_roles')
      .delete()
      .eq('org_id', klass.org_id)
      .eq('module_key', 'classroom')
      .eq('user_id', userId)
      .eq('scope_ref', klass.scope_node_id)
    fail(grantErr, 'Remove from class (grant) failed')
  }
  // … and the name/badge row.
  const { error } = await supabase.from('cls_class_members').delete().eq('class_id', classId).eq('user_id', userId)
  fail(error, 'Remove from class failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/manage`)
}

export async function createClass(orgSlug: string, courseId: string, formData: FormData) {
  const name = String(formData.get('name') ?? '').trim()
  const term = String(formData.get('term') ?? '').trim()
  if (!name) throw new Error('Class name is required')

  const supabase = await createClient()
  const { error } = await supabase.from('cls_classes').insert({
    org_id: DERIVED_SCOPE_PLACEHOLDER, // derived by cls_classes_scope trigger from course_id
    course_id: courseId,
    name,
    term: term || null,
  })
  fail(error, 'Create class failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/manage`)
  revalidatePath(`/o/${orgSlug}/m/classroom`)
}

export async function postAnnouncement(orgSlug: string, classId: string, formData: FormData) {
  const body = String(formData.get('body') ?? '').trim()
  if (!body) throw new Error('Announcement text is required')

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { error } = await supabase.from('cls_announcements').insert({
    // org_id is derived by the scope-sync trigger; a placeholder satisfies NOT NULL pre-trigger.
    org_id: DERIVED_SCOPE_PLACEHOLDER,
    class_id: classId,
    author_id: user?.id ?? null,
    body,
  })
  fail(error, 'Post announcement failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/manage`)
  revalidatePath(`/o/${orgSlug}/m/classroom`)
}

export async function createHomework(orgSlug: string, classId: string, formData: FormData) {
  const title = String(formData.get('title') ?? '').trim()
  if (!title) throw new Error('Title is required')
  const dueAt = String(formData.get('dueAt') ?? '').trim()

  const supabase = await createClient()
  const { error } = await supabase.from('cls_homeworks').insert({
    org_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
    class_id: classId,
    title,
    due_at: dueAt ? new Date(dueAt).toISOString() : null,
  })
  fail(error, 'Create homework failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/manage`)
  revalidatePath(`/o/${orgSlug}/m/classroom`)
}

// Structure syntax: "1a:10, 1b:5, 2:20" -> [{label:'1a',points:10}, ...].
// The label:points list defines the grading granularity (spec: exams graded
// by problem/subproblem).
export async function createExam(orgSlug: string, classId: string, formData: FormData) {
  const title = String(formData.get('title') ?? '').trim()
  const structureRaw = String(formData.get('structure') ?? '').trim()
  if (!title) throw new Error('Title is required')

  const structure = structureRaw
    ? structureRaw.split(',').map((part) => {
        const [label, points] = part.split(':').map((s) => s.trim())
        const pts = Number(points)
        if (!label || Number.isNaN(pts) || pts <= 0) {
          throw new Error(`Invalid problem "${part}" — use label:points, e.g. 1a:10`)
        }
        return { label, points: pts }
      })
    : []

  const supabase = await createClient()
  const { error } = await supabase.from('cls_exams').insert({
    org_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
    class_id: classId,
    title,
    structure,
  })
  fail(error, 'Create exam failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/manage`)
}

export async function createSurvey(orgSlug: string, classId: string, formData: FormData) {
  const question = String(formData.get('question') ?? '').trim()
  if (!question) throw new Error('Survey question is required')

  const supabase = await createClient()
  const { error } = await supabase.from('cls_surveys').insert({
    org_id: DERIVED_SCOPE_PLACEHOLDER, // derived by trigger
    class_id: classId,
    question,
  })
  fail(error, 'Create survey failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/manage`)
  revalidatePath(`/o/${orgSlug}/m/classroom`)
}

// Per-class retention (founder decision 2026-07-09): from this date,
// submissions hide from students AND GAs; the professor keeps access and can
// re-reveal single items with an expiration (grading console). Empty = never.
export async function setSubmissionsHiddenFrom(orgSlug: string, classId: string, formData: FormData) {
  const raw = String(formData.get('hiddenFrom') ?? '').trim()
  const supabase = await createClient()
  const { error } = await supabase
    .from('cls_classes')
    .update({ submissions_hidden_from: raw || null })
    .eq('id', classId)
  fail(error, 'Set retention date failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/manage`)
}

export async function setSurveyResultsVisible(orgSlug: string, surveyId: string, visible: boolean) {
  const supabase = await createClient()
  const { error } = await supabase
    .from('cls_surveys')
    .update({ results_visible: visible })
    .eq('id', surveyId)
  fail(error, 'Update survey failed')
  revalidatePath(`/o/${orgSlug}/m/classroom/manage`)
  revalidatePath(`/o/${orgSlug}/m/classroom`)
}
