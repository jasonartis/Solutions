// Classroom export manifest (data-export primitive, docs/03).
//
// PRINCIPLE (founder correction, 2026-07-09): the export slice is defined by
// AUTHORSHIP, not visibility — you export what YOU entered (so entering data
// never risks losing it), plus minimal context metadata (class/homework
// names). What the professor/GA let a student SEE (published materials,
// revealed grades) is NOT the student's to export. Staff hats export the
// domain they operate — the professor's gradebook is the professor's work.
// RLS remains the hard ceiling (fetches run AS the caller) but is not the
// definition of the slice.
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
    { key: 'ga', label: 'GA (my grading work)' },
    { key: 'student', label: 'Student (what I entered)' },
  ],
  async myHats(db: ExportDb, ctx: ExportContext) {
    const hats: string[] = []
    const { data: manage } = await db.rpc('cls_can_manage', { check_org_id: ctx.orgId })
    const { data: ga } = await db.rpc('cls_is_ga', { check_org_id: ctx.orgId })
    if (manage) hats.push('professor')
    if (manage || ga) hats.push('ga')
    hats.push('student') // everyone may export their own contributions
    return hats
  },
  dataSets: [
    // --- Student hat: only what the student authored (+ name metadata) -----
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
      key: 'my-submission-files',
      label: 'My uploaded files (names)',
      description: 'file list; the files themselves are a later option',
      hats: ['student'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('cls_submission_files')
            .select('file_name, created_at, submission:cls_submissions!inner(student_id, homework:cls_homeworks(title))')
            .eq('org_id', ctx.orgId)
            .eq('submission.student_id', ctx.userId),
        ),
    },
    {
      key: 'my-review-comments',
      label: 'Peer-review comments I wrote',
      hats: ['student'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('cls_review_comments')
            .select('body, file_path, created_at')
            .eq('org_id', ctx.orgId)
            .eq('author_id', ctx.userId),
        ),
    },
    {
      key: 'my-survey-answers',
      label: 'My survey answers',
      hats: ['student'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('cls_survey_answers')
            .select('answer, created_at, survey:cls_surveys(question), class:cls_classes(name)')
            .eq('org_id', ctx.orgId)
            .eq('user_id', ctx.userId),
        ),
    },
    // NOTE (deliberate omissions per the authorship principle): grades are
    // professor/GA-entered — ABOUT the student, not BY them — so they are not
    // in the student hat; likewise published materials are the professor's
    // content. Flagged with the founder in case grades-about-me should be an
    // exception later.

    // --- GA hat: the grading work THEY entered ------------------------------
    {
      key: 'my-ga-grades',
      label: 'GA grades I entered',
      hats: ['ga'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('cls_grades')
            .select('student_id, score, detail, homework:cls_homeworks(title), exam:cls_exams(title)')
            .eq('org_id', ctx.orgId)
            .eq('source', 'ga'),
        ),
    },

    // --- Professor hat: the domain they operate -----------------------------
    {
      key: 'full-gradebook',
      label: 'Full gradebook',
      hats: ['professor'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('cls_grades')
            .select('student_id, score, source, is_final, visible, homework:cls_homeworks(title), exam:cls_exams(title)')
            .eq('org_id', ctx.orgId),
        ),
    },
    {
      key: 'rosters',
      label: 'Class rosters',
      hats: ['professor'],
      fetch: (db, ctx) =>
        rows(
          db
            .from('cls_class_members')
            .select('user_id, role, preferred_first_name, preferred_last_name, class:cls_classes(name)')
            .eq('org_id', ctx.orgId),
        ),
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
