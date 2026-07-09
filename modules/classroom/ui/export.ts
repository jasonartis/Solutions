// Classroom export manifest (data-export primitive, docs/03). Every fetch
// runs AS the caller under RLS — RLS is the ceiling; each fetch defines the
// hat's intended slice (e.g. "my submissions" filters to the caller even for
// a professor deliberately exporting with the student hat).
import type { ExportDb, ExportContext, ModuleExport } from '@platform/core'

async function rows(query: any): Promise<Record<string, unknown>[]> {
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return data ?? []
}

export const classroomExport: ModuleExport = {
  moduleKey: 'classroom',
  hats: [
    { key: 'professor', label: 'Professor (full class data)' },
    { key: 'ga', label: 'GA (grading data)' },
    { key: 'student', label: 'Student (my own data)' },
  ],
  async myHats(db: ExportDb, ctx: ExportContext) {
    const hats: string[] = []
    const { data: manage } = await db.rpc('cls_can_manage', { check_org_id: ctx.orgId })
    const { data: ga } = await db.rpc('cls_is_ga', { check_org_id: ctx.orgId })
    if (manage) hats.push('professor')
    if (manage || ga) hats.push('ga')
    hats.push('student') // everyone can export their own slice
    return hats
  },
  dataSets: [
    {
      key: 'my-submissions',
      label: 'My homework submissions',
      hats: ['student'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('cls_submissions')
            .select('id, state, submitted_at, homework:cls_homeworks(title), class:cls_classes(name)')
            .eq('org_id', ctx.orgId)
            .eq('student_id', ctx.userId),
        ),
    },
    {
      key: 'my-grades',
      label: 'My grades (final, visible)',
      hats: ['student'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('cls_grades')
            .select('score, source, homework:cls_homeworks(title), exam:cls_exams(title), class:cls_classes(name)')
            .eq('org_id', ctx.orgId)
            .eq('student_id', ctx.userId)
            .eq('is_final', true)
            .eq('visible', true),
        ),
    },
    {
      // Founder Q (2026-07-09): a student's export MAY include class materials
      // published to them — it's what they can see — governed by the
      // professor's export controls (disable this set or the whole hat).
      // RLS already limits rows to open-window publications for students.
      key: 'class-materials',
      label: 'Class materials published to me',
      hats: ['student', 'ga'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('cls_materials')
            .select('title, kind, url, course:cls_courses(name)')
            .eq('org_id', ctx.orgId),
        ),
    },
    {
      key: 'grading-queue',
      label: 'Submissions & grades (grading view)',
      hats: ['professor', 'ga'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('cls_grades')
            .select('student_id, score, source, is_final, visible, homework:cls_homeworks(title), exam:cls_exams(title)')
            .eq('org_id', ctx.orgId),
        ),
    },
    {
      key: 'full-gradebook',
      label: 'Full gradebook + rosters',
      hats: ['professor'],
      fetch: async (db, ctx) => {
        const members = await rows(
          db
            .from('cls_class_members')
            .select('user_id, role, preferred_first_name, preferred_last_name, class:cls_classes(name)')
            .eq('org_id', ctx.orgId),
        )
        return members
      },
    },
    {
      key: 'course-materials',
      label: 'Course materials & publications',
      hats: ['professor'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('cls_materials')
            .select('title, kind, url, storage_path, course:cls_courses(name)')
            .eq('org_id', ctx.orgId),
        ),
    },
  ],
}
