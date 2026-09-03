// Per-module view-as declarations (docs/15 §8.1 points 5, 9, 11).
//
// EVERY module in the registry declares one, because the rank-differential
// completeness check is only a check if it is platform-wide: a module that
// could opt out by not declaring would be exactly the silent hole the
// 2026-07-30 amendment exists to close.
//
// WHICH MODULES HAVE EDGES ON (build decision 2026-07-30; nail-salon added
// 2026-08-04, speed-dating 2026-08-28, both after their own surface review):
//   classroom    — ON. §11 sequencing puts classroom first, §8's own tab sketch is
//                  classroom, it holds the one pair the spec left explicitly open
//                  (professor -> student), and it is the only module with real
//                  SCOPED grants in the seed, so scope intersection is exercisable.
//   nail-salon   — ON for the five staff-to-staff pairs (mode 1 on all five, mode 2
//                  on the two into `worker`); all four customer pairs OFF and
//                  re-confirmed. Reviewed 2026-08-04 — see the block above that
//                  declaration for the finding that decided every pair.
//   speed-dating — ON for the three staff-to-staff pairs (mode 1 on all three; mode
//                  2 off on every one — staff reach here is rank/scope-narrowed,
//                  never person-narrowed, unlike nail-salon's `worker`). All three
//                  pairs into `participant` stay permanently OFF (§8.1 point 7's
//                  end-user ban). Reviewed 2026-08-28 — see the block above that
//                  declaration.
//   The rank-0 vocabularies (matchmaking, synagogue-schedules, visual-messaging) —
//   every pair explicitly OFF (they have none to turn on until rank-mapped).
//
// The line is principled, not arbitrary: §8.1 point 9 says a position's surface
// classification is "decided in each module's security review." An edge may
// therefore only be ON in a module that has HAD that review — classroom in slice
// 5, nail-salon 2026-08-04, speed-dating 2026-08-28. Turning one on is flipping
// booleans, writing the surfaces, and one `create or replace` of
// `module_view_as_edge()` — never inventing a mechanism (neither nail-salon's nor
// speed-dating's review needed a new one, and each says so where it came closest).
//
// A pleasant consequence of ranks being what they are today: only classroom
// (2 pairs), nail-salon (9) and speed-dating (6) have ANY rank-differential
// pairs at all. The other five vocabularies are entirely rank 0 in SQL's
// `module_position_rank()`, so they require no entries — and the moment anyone
// rank-maps matchmaking / synagogue-schedules / visual-messaging (the
// "optional, undone" work in CLAUDE.md), the build breaks until every
// newly-implied pair is consciously answered. That is the amendment working.

import { declareViewAs, type ViewAsDeclaration } from './view-as'

// ---------------------------------------------------------------------------
// Classroom — the module this slice actually builds and reviews.
// Ranks: professor 2 (Entity Lead) > ga 1 = student 1 (peers, docs/15 §5).
// Two rank-differential pairs; ga/student need no entry.
// ---------------------------------------------------------------------------
export const classroomViewAs = declareViewAs({
  positions: { professor: 2, ga: 1, student: 1 },

  edges: {
    professor: {
      ga: {
        mode1: true,
        mode2: true,
        // Settled in §8 itself: "professor -> GA exists".
        note:
          'Confirmed in docs/15 §8. A GA\'s surface is duty output — the grading queue and ' +
          'the grades they entered — and the professor already reads all of it inside their ' +
          'scope, so neither mode widens anything. Mode 2 is what makes the per-GA narrowing ' +
          'visible: cls_grades is scoped to source=ga AND graded_by=<target>, which the ' +
          "professor's own ambient query would never show separated out.",
      },
      student: {
        mode1: true,
        mode2: true,
        // THE PAIR THE SPEC LEFT OPEN (§8.1 point 11, 2026-07-30). Answered here.
        note:
          'RESOLVED ON at build time, 2026-07-30 — the pair docs/15 §8.1 point 11 left ' +
          'explicitly undecided. ON because a student\'s role surface is almost entirely the ' +
          "professor's own duty output reflected back (publication windows, announcements, " +
          'homework, published grades), and "what does my student actually see?" is the ' +
          'single most common classroom support question — the reason §8 sketched a Student ' +
          'tab in the first place. Neither mode widens: every declared table is already ' +
          'professor-readable within their scope. The genuinely personal parts are kept off ' +
          'the surface instead of the pair being closed wholesale — survey answers and ' +
          'peer-review comment authorship are excluded, cls_review_assignments omits ' +
          'submission_id so the reviewer->reviewee direction cannot be walked, and retention ' +
          'hiding is reproduced (the professor is exempt from it, so without that the view ' +
          'would be falsely permissive). FOUNDER: this is the one pair the spec asked to be ' +
          'consciously decided rather than assumed — confirm or flip it.',
      },
    },
  },

  scopeEntity: { table: 'cls_classes', idColumn: 'id', nodeColumn: 'scope_node_id' },

  surfaces: {
    ga: {
      label: 'GA',
      summary:
        'Grading queue and the grades this GA entered. A GA sees only their OWN ga-source ' +
        'grade cells (20260712020000) — not other GAs\' entries, not instructor or final scores.',
      role: [
        {
          table: 'cls_classes',
          label: 'Classes in reach',
          columns: ['id', 'name', 'term'],
          subjectColumn: null,
          scopeColumn: 'id',
        },
        {
          table: 'cls_class_members',
          label: 'Roster',
          columns: ['id', 'class_id', 'user_id', 'role', 'preferred_first_name', 'preferred_last_name'],
          subjectColumn: null, // class-wide: the same roster for every GA
          scopeColumn: 'class_id',
        },
        {
          table: 'cls_homeworks',
          label: 'Homework',
          columns: ['id', 'class_id', 'title', 'due_at'],
          subjectColumn: null,
          scopeColumn: 'class_id',
          orderBy: { column: 'due_at', ascending: true },
        },
        {
          table: 'cls_submissions',
          label: 'Submissions to grade',
          columns: ['id', 'class_id', 'homework_id', 'student_id', 'state', 'submitted_at', 'visible_override_until'],
          subjectColumn: null, // a GA grades everyone in scope, not one person
          scopeColumn: 'class_id',
          hiddenWhen: {
            scopeCutoffColumn: 'submissions_hidden_from',
            overrideUntilColumn: 'visible_override_until',
          },
          orderBy: { column: 'submitted_at', ascending: false },
          limit: 100,
        },
        {
          table: 'cls_submission_files',
          label: 'Attached submission files',
          columns: ['id', 'class_id', 'submission_id', 'file_name', 'storage_path', 'size_bytes'],
          // Same shape as cls_submissions just above: a GA sees every submission's
          // files in scope, not one student's.
          subjectColumn: null,
          scopeColumn: 'class_id',
          caveat:
            'Moved here 2026-09-03 from `excluded`, now that the grading console ' +
            '(ui/manage/grading/[homeworkId]/page.tsx) actually fetches and shows these ' +
            "(as signed download links, matching the peer-review page's existing pattern) — " +
            'previously RLS-readable but never queried by any real page, which is why it used ' +
            'to be excluded rather than role.',
        },
        {
          table: 'cls_grades',
          label: 'Grades this GA entered',
          columns: [
            'id', 'class_id', 'student_id', 'homework_id', 'exam_id',
            'source', 'score', 'detail', 'graded_by', 'is_final', 'visible',
          ],
          // The GA surface is defined BY the grader, so that is who a row is about.
          subjectColumn: 'graded_by',
          scopeColumn: 'class_id',
          filter: [{ column: 'source', eq: 'ga' }],
          caveat:
            '`detail` added 2026-08-28 (coverage review): the exam-grading console ' +
            '(modules/classroom/ui/manage/exams/[examId]/page.tsx) reads it for the ' +
            "per-subproblem score breakdown (`{problems: {...}}`) — was missing from this " +
            'allow-list even though the column was already readable.',
        },
        {
          table: 'cls_review_comments',
          label: 'Review comments this GA wrote',
          columns: [
            'id', 'class_id', 'submission_id', 'author_id',
            'file_path', 'line_start', 'line_end', 'body', 'created_at',
          ],
          subjectColumn: 'author_id',
          scopeColumn: 'class_id',
          caveat:
            'Restricted to comments the target GA authored — this is that GA\'s own work, ' +
            'which is what the tab is for. Note separately that a GA can read EVERY review ' +
            'comment in scope, author_id included (the cls_is_ga_class arm of ' +
            'cls_review_comments_select). That sits awkwardly with the founder\'s 2026-08-02 ' +
            'statement that peer review is anonymous from the GA — flagged as a pre-existing ' +
            'RLS question, not something view-as creates or can fix.',
        },
        {
          table: 'cls_announcements',
          label: 'Announcements',
          columns: ['id', 'class_id', 'body', 'posted_at'],
          subjectColumn: null,
          scopeColumn: 'class_id',
          orderBy: { column: 'posted_at', ascending: false },
          limit: 20,
        },
        // Four entries below added 2026-08-28, closing the coverage-ratchet gap
        // (packages/db/src/view-as-coverage.test.ts's KNOWN_GAPS baseline). Each
        // is grounded in a REAL page a GA actually visits — modules/classroom/ui/
        // page.tsx (the shared classes/publications/surveys landing page every
        // class member sees) or ui/manage/exams/[examId]/page.tsx (the exam
        // grading console) — not inferred from RLS alone.
        {
          table: 'cls_publications',
          label: 'Published materials',
          columns: ['id', 'class_id', 'material_id', 'visible_from', 'visible_until'],
          embed: [{ alias: 'material', table: 'cls_materials', columns: ['id', 'title', 'kind'] }],
          subjectColumn: null,
          scopeColumn: 'class_id',
          // Deliberately NOT `visibilityWindow`, unlike the identical-looking
          // entry on the student surface below — see the caveat.
          caveat:
            'Same query as the student landing page (ui/page.tsx), but NOT badged with ' +
            "`visibilityWindow` the way the student entry is: cls_materials_select's " +
            '`cls_is_ga_course` arm grants a GA unconditional read regardless of the ' +
            "publication's visibility window (it is an OR alongside the window check), so a " +
            "GA's embed never comes back null for an unpublished-to-students material — there " +
            'is nothing to badge "hidden until X" for a GA the way there is for a student.',
        },
        {
          table: 'cls_exams',
          label: 'Exams',
          columns: ['id', 'class_id', 'title', 'structure'],
          subjectColumn: null,
          scopeColumn: 'class_id',
          caveat:
            '`structure` is `{label, points}[]` — the problem/point breakdown the exam-grading ' +
            'console uses to size the score-entry form, not an answer key, so it is safe on ' +
            "this allow-list. A GA also encounters an exam's `title` via the shared landing " +
            "page's grades embed, but this section is the fuller, real GA-specific usage.",
        },
        {
          table: 'cls_exam_papers',
          label: 'Exam scans to grade',
          columns: ['id', 'class_id', 'exam_id', 'student_id', 'storage_path'],
          // A GA reads every student's scans for an exam they GA for, not one
          // person's — same shape as "Submissions to grade" above.
          subjectColumn: null,
          scopeColumn: 'class_id',
          caveat: 'Row existence + storage path only, mirroring the exam-grading console.',
        },
        {
          table: 'cls_surveys',
          label: 'Surveys',
          columns: ['id', 'class_id', 'question', 'results_visible'],
          subjectColumn: null,
          scopeColumn: 'class_id',
          orderBy: { column: 'sort', ascending: true },
          caveat:
            'Definitions only. A GA has no read arm on individual answers ' +
            '(`cls_survey_answers`, declared `unreadableByPosition` below) and sees results only ' +
            'via the `cls_survey_results` aggregate definer, not a raw table.',
        },
      ],
      // Nothing in classroom is RLS-unreadable to a professor in scope — the
      // module has no sd_notes analogue. Recorded as an empty list rather than
      // silently omitted, because "no true personal layer here" is itself the
      // finding (docs/15 2026-07-30 build entry).
      // Nothing on the GA surface is RLS-hidden from a professor in scope, so
      // there is no personal layer here in §8.1 point 1's strict sense.
      personal: [],
      excluded: [
        {
          table: 'cls_courses',
          why:
            'A GA CAN read this (`cls_is_ga_course`, confirmed 2026-08-28) — both ui/page.tsx ' +
            "and the exam-grading console query `cls_courses` (`.select('id').limit(1)`) purely " +
            'as an internal staff/GA-detection probe. No course field is ever rendered; the GA ' +
            'console has no course-browsing view at all, only the classes a GA is assigned to.',
        },
      ],
      // Absent because the GA cannot read them, not because we declined to
      // render them — a different claim from `excluded`, about a different
      // reader, and separately test-enforced (a real GA is asserted unable to
      // read these). Recorded so that a future policy change adding a GA arm
      // becomes a conscious surface decision rather than a silent widening.
      unreadableByPosition: [
        {
          table: 'cls_review_assignments',
          why:
            'cls_review_assignments_select has never carried a cls_is_ga arm in any version — ' +
            'only the professor and the reviewer themselves can read the peer-review matrix.',
        },
        {
          table: 'cls_survey_answers',
          why:
            'No GA arm on cls_survey_answers_select either; a GA only ever sees counts via ' +
            'the cls_survey_results aggregate.',
        },
      ],
    },

    student: {
      label: 'Student',
      summary:
        'What this student can actually see: which materials are inside their visibility ' +
        'window, their own submissions, and only grades that are final AND published.',
      role: [
        {
          table: 'cls_classes',
          label: 'Enrolled classes',
          columns: ['id', 'name', 'term'],
          subjectColumn: null,
          scopeColumn: 'id',
        },
        {
          table: 'cls_class_members',
          label: 'Their roster row',
          columns: ['id', 'class_id', 'user_id', 'role', 'preferred_first_name', 'preferred_last_name'],
          subjectColumn: 'user_id',
          scopeColumn: 'class_id',
        },
        {
          table: 'cls_publications',
          label: 'Published materials',
          columns: ['id', 'class_id', 'material_id', 'visible_from', 'visible_until'],
          embed: [{ alias: 'material', table: 'cls_materials', columns: ['id', 'title', 'kind'] }],
          subjectColumn: null,
          scopeColumn: 'class_id',
          visibilityWindow: { fromColumn: 'visible_from', untilColumn: 'visible_until' },
        },
        {
          table: 'cls_announcements',
          label: 'Announcements',
          columns: ['id', 'class_id', 'body', 'posted_at'],
          subjectColumn: null,
          scopeColumn: 'class_id',
          orderBy: { column: 'posted_at', ascending: false },
          limit: 20,
        },
        {
          table: 'cls_homeworks',
          label: 'Homework',
          columns: ['id', 'class_id', 'title', 'due_at'],
          subjectColumn: null,
          scopeColumn: 'class_id',
          orderBy: { column: 'due_at', ascending: true },
        },
        {
          table: 'cls_submissions',
          label: 'Their submissions, and the peer-review comments on each',
          columns: ['id', 'class_id', 'homework_id', 'student_id', 'state', 'submitted_at', 'visible_override_until'],
          // THE HOP-FILTER, and the reason the comments live here rather than in
          // a section of their own (adversarial review finding 1, 2026-08-06).
          //
          // `cls_review_comments` was a standalone role table with
          // `subjectColumn: null`, directly under a comment saying the rows are
          // ABOUT the student as reviewee — which is the contradiction. The
          // subject column names a person ON THE ROW, and a comment names its
          // AUTHOR, not its reviewee; the reviewee is one hop away through
          // `submission_id`. With no hop mechanism the entry fell back to "not
          // per-person", so a student's tab rendered EVERY student's peer-review
          // comments in the class, badged like a class-wide announcement. That is
          // docs/03 #18's falsely-permissive failure: no data crossed a tenancy
          // boundary (the professor already reads every comment in their course,
          // and only the view-as surface reads the raw table — the live student
          // page goes through the definer below), but the tab's claim to show
          // what the STUDENT sees was false.
          //
          // Embedding under the submission mirrors
          // `cls_comments_for_my_submission()` condition for condition — it is
          // `join cls_submissions s on s.id = c.submission_id where s.student_id
          // = auth.uid()`, and the parent's `subjectColumn: 'student_id'` is
          // exactly that join. Not `excluded`: the student genuinely is meant to
          // see their own (founder, 2026-08-02 — the comments, never the peer
          // grades). Retention comes along for free, since a submission the
          // student can no longer see takes its comments with it.
          embed: [
            {
              alias: 'peer_review_comments',
              table: 'cls_review_comments',
              columns: ['id', 'author_id', 'file_path', 'line_start', 'line_end', 'body', 'created_at'],
            },
            // Added 2026-08-28 (coverage review): the SAME hop problem as the
            // comments embed above — `cls_submission_files` names its person
            // through `submission_id`, not a direct user-id column, so it can
            // only be expressed as an embed here, never a standalone section.
            // Confirmed against the real query in TWO pages: the student's own
            // homework page (ui/homework/[homeworkId]/page.tsx, own submission)
            // and the peer-review page (ui/review/[assignmentId]/page.tsx,
            // reviewing someone else's) both select the same columns.
            {
              alias: 'files',
              table: 'cls_submission_files',
              columns: ['id', 'file_name', 'storage_path', 'size_bytes'],
            },
          ],
          subjectColumn: 'student_id',
          scopeColumn: 'class_id',
          hiddenWhen: {
            scopeCutoffColumn: 'submissions_hidden_from',
            overrideUntilColumn: 'visible_override_until',
          },
          caveat:
            'The comments are shown WITH author_id, which is deliberately more than the ' +
            'student sees: the live student page calls cls_comments_for_my_submission(), a ' +
            'definer whose return type has no author column at all, because anonymity runs ' +
            'from other students and the GA — not from the professor, who runs the process ' +
            '(founder, 2026-08-02). The row SET is the same as that function returns. Being ' +
            'a to-many embed it renders as JSON in one cell rather than as its own table ' +
            '(the formatCell array-branch limitation noted for the salon surfaces); the ' +
            'alternative was leaving it a section that showed the whole class.',
        },
        {
          table: 'cls_grades',
          label: 'Grades they can see',
          columns: [
            'id', 'class_id', 'student_id', 'homework_id', 'exam_id',
            'source', 'score', 'is_final', 'visible',
          ],
          // Added 2026-08-28: the live landing page (ui/page.tsx) embeds
          // `exam:cls_exams(title)` alongside this exact query. `title` only —
          // never `structure` — since a student has no legitimate use for the
          // problem/point breakdown the way a GA grading the exam does.
          embed: [{ alias: 'exam', table: 'cls_exams', columns: ['title'] }],
          subjectColumn: 'student_id',
          scopeColumn: 'class_id',
          // Mirrors the student's own RLS arm exactly: is_final AND visible.
          filter: [
            { column: 'is_final', eq: true },
            { column: 'visible', eq: true },
          ],
          caveat:
            'Deliberately the published set only. Draft and instructor-source cells the ' +
            'professor can see are not part of what the student sees.',
        },
        {
          table: 'cls_surveys',
          label: 'Surveys',
          columns: ['id', 'class_id', 'question', 'results_visible'],
          subjectColumn: null,
          scopeColumn: 'class_id',
          orderBy: { column: 'sort', ascending: true },
          caveat:
            'Added 2026-08-28 (coverage review) — definitions only, from the same shared ' +
            'landing-page query GA reads (ui/page.tsx). A student\'s own answer comes from ' +
            'cls_survey_answers (not part of this table, already correctly outside this list); ' +
            'aggregate results, when the professor has flipped a survey visible, come via the ' +
            'cls_survey_results definer, not a raw table.',
        },
        {
          table: 'cls_review_assignments',
          label: 'Peer reviews assigned to them',
          columns: [
            'id', 'class_id', 'homework_id', 'reviewer_id', 'submission_id',
            'grade', 'grade_submitted_at', 'locked',
          ],
          subjectColumn: 'reviewer_id',
          scopeColumn: 'class_id',
          caveat:
            'Includes submission_id — which submission this student is reviewing. Founder, ' +
            '2026-08-02: peer review is anonymous from other STUDENTS and from the GA, not ' +
            'from the professor, who runs the process and already reads the whole matrix.',
        },
        // cls_review_comments WAS a standalone role table here. It is now an
        // embed under cls_submissions above — see the long note there. Two claims
        // its caveat made are also dead and are recorded as corrections rather
        // than quietly deleted, because both were repeated elsewhere: the definer
        // `cls_comments_for_my_submission` is NOT callerless (the student
        // homework page has called it since 2026-08-03), and a student-facing
        // view of peer feedback therefore DOES exist. The 2026-07-29 ACL sweep's
        // "dead function" list was true when written and stale by the time this
        // surface quoted it.
        {
          table: 'cls_exam_papers',
          label: 'Their exam scans',
          columns: ['id', 'class_id', 'exam_id', 'student_id', 'created_at'],
          subjectColumn: 'student_id',
          scopeColumn: 'class_id',
          caveat: 'Row existence only — the scan itself lives in storage and is not fetched here.',
        },
      ],
      personal: [],
      excluded: [
        {
          table: 'cls_survey_answers',
          why:
            'A survey answer is entered as oneself, and the module already exposes the ' +
            'staff-facing signal as counts via cls_survey_results — the exact ' +
            'aggregate-definer pattern §8.1 point 1 names. NOT marked personal: a professor ' +
            'CAN read the raw rows in scope (the cls_can_manage_class arm of ' +
            'cls_survey_answers_select), and §8.1 point 1 makes "personal" mean ' +
            'RLS-unreadable, so calling it that would be the spec violation it warns about. ' +
            'This is a product exclusion over data the professor reads ambiently either way.',
        },
        // cls_review_comments was EXCLUDED here in the first draft, reasoning
        // that showing author_id would deanonymize peer reviewers. FOUNDER
        // CORRECTION, 2026-08-02: peer-review anonymity runs from other
        // STUDENTS and from the GA — never from the professor, who runs the
        // process and already reads the whole matrix. It is now on the role
        // surface above, with author_id. Recorded because the first version
        // was wrong about WHO the anonymity protects against, not about the
        // mechanism — and the same mistake is easy to repeat per module.
      ],
      unreadableByPosition: [
        {
          table: 'cls_courses',
          why:
            'cls_courses_select_staff has no student arm at all — students never see the ' +
            'course layer, only the classes they are enrolled in.',
        },
      ],
    },
  },
})

// ---------------------------------------------------------------------------
// Nail salon — ranks admin 3 > manager 2 > (cashier 1 = worker 1) > customer 0.
// Nine rank-differential pairs; cashier/worker are peers and need no entry.
//
// SURFACE SECURITY REVIEW DONE 2026-08-04 (§8.1 point 9), the review docs/03 #18
// says an edge may only be switched on after. All nine pairs are answered below
// with a note each, and the twelve sal_ tables are classified table by table for
// each of the three positions that gained an ON edge.
//
// THE FINDING THAT SHAPED EVERY ANSWER. In this module RLS narrows by LOCATION
// for manager and cashier, and by PERSON for worker:
//   * `sal_can_manage_location` / `sal_can_operate_location` (20260726010000) ask
//     only "does your grant's scope cover this location" — so every row one
//     cashier reads is readable by every other cashier at the same location, and
//     likewise for managers.
//   * a worker's arms are `sal_appointments.worker_id = auth.uid()`, their own
//     `sal_worker_time_off` (through their profile), and `sal_worker_sees_customer`
//     — only the customers they are actually booked with.
// So mode 1 ("see it as if I held that position") is meaningful for all three,
// because each position has a genuinely different REACH; mode 2 ("see what Smith
// sees") has a per-person referent only for `worker`. That is why five pairs are
// mode-1-only and two are full. The distinction is not a hedge — it is what §8.1
// point 3's definition of mode 2 ("rows ABOUT the target") resolves to here.
//
// EMBED COLUMNS ARE ALIASED TO `name` ON PURPOSE. `formatCell` (shared with the
// data browser) collapses an embedded object to its `title` or `name` key and
// falls back to raw JSON, so `sal_customers(full_name)` would render as
// `{"full_name":"Charlie C"}` and a two-column embed would silently drop its
// second column from the screen while still being declared. PostgREST's own
// column aliasing (`name:full_name`) fixes both: the declaration lists exactly
// what is rendered, and it renders as a name. This is why classroom's embeds
// select `title` — same constraint, met by luck there rather than by choice.
// CAVEAT the aliasing trick does NOT cover: a to-MANY embed (the `time_off`
// rows under a worker profile) arrives as an ARRAY, which `formatCell` renders
// as raw `JSON.stringify` — every declared column shows, but as JSON rather than
// as a cell. Legible enough for a date range, and nothing leaks (both viewers of
// those surfaces read the table), but it is why only the to-one embeds are
// aliased. A `formatCell` array branch would be the fix, and it is shared with
// the data browser, so it is a platform change rather than a salon one.
//
// ONE MECHANISM GAP, RECORDED NOT PAPERED OVER. `SurfaceTable.subjectColumn` is a
// column on the table holding a user id, so a table that reaches its person
// through a child row cannot be subject-filtered (`sal_worker_time_off` links via
// `worker_profile_id`; `sal_customers` is reachable only through an appointment).
// Both are handled honestly here — time-off as an embed under the profile it
// belongs to, the customer's name as an embed on the appointment, exactly as the
// worker's own console renders it — so nothing needed a new mechanism. The data
// browser hit the same wall and answered it with `PersonVia.then` (docs/03 #19);
// if a future salon surface needs a standalone hop-filtered section, that is the
// shape to copy, and it is a platform change with its own review.
// ---------------------------------------------------------------------------

const SALON_NARROWING =
  'Nail-salon RLS narrows by LOCATION for manager/cashier and by PERSON for worker (see the ' +
  'block comment above), so mode 1 is meaningful for every staff position while mode 2 has a ' +
  'per-person referent only for worker.'

// Every pair into `customer` — re-decided in this review rather than inherited.
const SALON_CUSTOMER =
  'OFF, and CONFIRMED off by the 2026-08-04 surface review rather than carried over. The ' +
  'original product reason stands: a customer\'s surface is their own appointment and billing ' +
  'history — received as themselves, not duty output — and nothing about running a salon needs ' +
  'a staffer wearing a named customer\'s identity, since operators already read every ' +
  'operational row at their location. The review adds three findings that make the pair wrong ' +
  'on mechanics too, not merely unnecessary. (1) IDENTITY KEY MISMATCH: a mode-2 target is a ' +
  '(person, position, scope) GRANT triple, but customer read access keys on ' +
  '`sal_customers.user_id` (`sal_owns_customer` / `sal_owns_bill`), never on the ' +
  '`module_roles` customer grant — the grant is decorative for RLS here, so the picker would ' +
  'list the wrong population and a grant-holder with no `sal_customers` row would render an ' +
  'empty surface that looks like a bug. (2) WALK-INS ARE THE MAJORITY: `sal_customers.user_id` ' +
  'is nullable and most rows are login-less walk-ins (module-5 spec, and the data-browser ' +
  'finding of 2026-08-03), so this could never be the general answer to "what does my customer ' +
  'see" — only an answer for the minority who signed up. (3) For worker -> customer ' +
  'SPECIFICALLY the surface would also be strictly poorer than an operator\'s: a worker cannot ' +
  'read `sal_bills` or `sal_bill_items` at all (both are `sal_can_operate_location` or ' +
  '`sal_owns_bill`), so the billing half — the part a customer most often asks about — would ' +
  'be blank for exactly the viewer least able to explain it. The tool that DOES answer "what ' +
  'do we hold about this customer" is the per-person data browser (docs/03 #19), which is a ' +
  'different question by design. Changing this needs a dated founder decision, not a ' +
  'build-time judgement.'

export const nailSalonViewAs = declareViewAs({
  positions: { admin: 3, manager: 2, cashier: 1, worker: 1, customer: 0 },
  edges: {
    admin: {
      manager: {
        mode1: true,
        mode2: false,
        note:
          'MODE 1 ON, MODE 2 OFF (review 2026-08-04). ' +
          SALON_NARROWING +
          ' Mode 1 earns its place even though admin and manager satisfy the SAME read ' +
          'predicate (both are rank >= 2, so `sal_can_manage_location` is true for both): the ' +
          'tab is how an admin answers "what does a manager see?" — including the answers that ' +
          'are absences, like "yes, revenue: `sal_earnings_ledger` is manage-tier, which is ' +
          'exactly what the cashier tab shows a manager does NOT share". It widens nothing by ' +
          'construction. Mode 2 is off because a manager surface has no per-person column worth ' +
          'keying on. Seven sal_ columns can name a manager and all seven are authorship ' +
          'stamps: `created_by` on expenses / promotions / shopping_list / bills, ' +
          '`sal_appointments.booked_by`, and `sal_bills.paid_by`. The strongest counterexample ' +
          'is the pair this note used to omit — `sal_bills.voided_by` and `refunded_by` are the ' +
          'only columns in the module that can name a MANAGER AND NOBODY ELSE, since ' +
          '`sal_guard_bill` raises unless `sal_can_manage_location` and then stamps them ' +
          'unconditionally. It changes nothing: keying the tab on a void stamp would show the ' +
          'handful of bills this manager reversed and hide the location\'s entire book, which a ' +
          'manager reads in full. Every one of the seven UNDER-shows the tab the same way. ' +
          'Rendering the ' +
          'surface unfiltered would be honest but is not mode 2 — point 3 defines mode 2 as ' +
          'rows ABOUT the target — and `viewAsCompleteness()` refuses mode 2 on a surface with ' +
          'no per-person table, which is the structure saying the same thing. What an admin ' +
          'actually wants here (one named manager\'s LOCATION-scoped console) is the third ' +
          'Owner-Console mode the founder already specified on 2026-08-03 — "this position\'s ' +
          'surface with no person filter" — and it belongs there, not mislabelled as a person ' +
          'view. FOUNDER: this is the pair to push back on if you want a person view anyway.',
      },
      cashier: {
        mode1: true,
        mode2: false,
        note:
          'MODE 1 ON, MODE 2 OFF (review 2026-08-04). ' +
          SALON_NARROWING +
          ' This is the highest-value tab in the module: it is how an admin or manager answers ' +
          '"can my cashier see the takings?" and the answer is NO — `sal_earnings_ledger` is ' +
          'the one salon table gated on `sal_can_manage_location` rather than ' +
          '`sal_can_operate_location`, so it is declared `unreadableByPosition` on the cashier ' +
          'surface and the RLS suite asserts a real cashier gets nothing from it. Everything ' +
          'else operate-tier (appointments, customers, bills, bill items, promotions, expenses, ' +
          'shopping list, time-off) IS shared with a manager, which is the other half of the ' +
          'answer. Mode 2 off for the same reason as admin -> manager: a cashier\'s reach is ' +
          'location-wide, so no row is about the cashier as a person — and note ' +
          '`sal_bills.paid_by` is only a WEAK stamp, `coalesce(new.paid_by, auth.uid())`, so a ' +
          'client may supply it; narrowing to it would both trust client input and hide the rest ' +
          'of the bills that cashier genuinely reads.',
      },
      worker: {
        mode1: true,
        mode2: true,
        note:
          'BOTH MODES ON (review 2026-08-04) — the one salon position where a person view is ' +
          'honest. ' +
          SALON_NARROWING +
          ' A worker\'s surface is per-person all the way down: their assigned appointments ' +
          '(`worker_id = auth.uid()`), their own time-off, and only the customers they are ' +
          'booked with, so "what does Dana see on her chair view?" has a real answer that ' +
          'differs from every other worker\'s. Neither mode widens: every table on the surface ' +
          'is readable within the locations the viewer governs (asserted in the RLS suite as a ' +
          'real non-org-admin MANAGER; admin transfers because `sal_can_manage_location` gates ' +
          'on rank >= 2 — and since 2026-08-05 the seed also carries a real salon admin, frank, ' +
          'so an e2e renders the Manager tab as one), and the SIX tables a ' +
          'worker cannot reach at all — bills, bill items, earnings, promotions, expenses, ' +
          'shopping list — are declared ' +
          '`unreadableByPosition`, not silently omitted, so an admin reading the tab is told ' +
          'that a worker cannot see the money side rather than left to infer it from an empty ' +
          'page. The one genuinely surprising fact the surface makes visible: a worker cannot ' +
          'read `sal_earnings_ledger` even though its `worker_id` column names them, so a ' +
          'worker cannot see the revenue attributed to their own chair.',
      },
      customer: { mode1: false, mode2: false, note: SALON_CUSTOMER },
    },
    manager: {
      cashier: {
        mode1: true,
        mode2: false,
        note:
          'MODE 1 ON, MODE 2 OFF (review 2026-08-04) — same reasoning as admin -> cashier, ' +
          'which this pair should be read with. One addition specific to a manager viewer: a ' +
          'LOCATION-SCOPED manager\'s tab is intersected with the scope they govern (§8.1 point ' +
          '10 and `resolveScope`), so a manager who runs one store of a chain sees that ' +
          'store\'s cashier surface and is told the view is partial. That intersection is the ' +
          'reason this pair is safe to enable for a scoped manager and not only for a global ' +
          'one.',
      },
      worker: {
        mode1: true,
        mode2: true,
        note:
          'BOTH MODES ON (review 2026-08-04) — same reasoning as admin -> worker, and the pair ' +
          'that actually gets used: the person who fields "why is my schedule empty?" is the ' +
          'manager of the store, not the chain admin. The mode-2 session is refused unless the ' +
          'manager\'s own grant COVERS the worker\'s grant scope (`view_as_guard_session`, ' +
          'duplicated in `targetsFor`), so a manager cannot open a person view on a worker at ' +
          'a location they do not run.',
      },
      customer: { mode1: false, mode2: false, note: SALON_CUSTOMER },
    },
    cashier: {
      customer: { mode1: false, mode2: false, note: SALON_CUSTOMER },
    },
    worker: {
      customer: { mode1: false, mode2: false, note: SALON_CUSTOMER },
    },
  },

  scopeEntity: { table: 'sal_locations', idColumn: 'id', nodeColumn: 'scope_node_id' },

  // -------------------------------------------------------------------------
  // Surfaces. All three positions below account for ALL TWELVE sal_ tables —
  // as a role section, as an embed under the row it belongs to, as an
  // `excluded` product decision, or as `unreadableByPosition` — because §8.1
  // point 9's "explicit, per table" is only a real classification if nothing
  // falls off the list unremarked.
  //
  // THIS ACCOUNTING IS NOW MACHINE-ENFORCED (2026-08-28) —
  // packages/db/src/view-as-coverage.test.ts enumerates every module's real
  // tables from `pg_catalog` (including tables reachable only through an
  // `embed`) and fails the build if a future migration (a `sal_tips`, say)
  // leaves any surface silently incomplete. `viewAsCompleteness()` above still
  // only checks a declaration's INTERNAL consistency (no table in two lists,
  // etc.) — the coverage test is the one that checks against the database.
  // Nail-salon has zero gaps under it; classroom (whose surfaces predated this
  // rigor) was brought to the same bar the same day — see the coverage test's
  // own header comment for what was found and fixed.
  //
  // COLUMN-LEVEL exclusions are prose, and that is a live API gap. Every one made
  // below (`sal_customers.notes`, appointment `notes`/`checklist`, the bill reason
  // columns, cashier promotions' `created_by`) sits on a table that IS on the role
  // surface — and the overlap check forbids one table in both `role` and
  // `excluded`, so `ExcludedFromSurface.columns` cannot express any of them. The
  // consequence to be honest about: `excluded: []` on the manager and cashier
  // surfaces means "no whole table is withheld", not "nothing is withheld".
  //
  // `personal` is EMPTY for every position, and that emptiness is a finding,
  // not an omission: nail-salon has no `sd_notes` analogue. There is no salon
  // table a manager or admin cannot read within the locations they govern —
  // `sal_customers.notes` is staff-authored care detail readable by the whole
  // operate tier, and the module's one privacy-preserving definer
  // (`sal_worker_has_time_off`) exists to keep detail from CUSTOMERS, not from
  // staff. Calling anything here `personal` would be the spec violation §8.1
  // point 1 warns about.
  // -------------------------------------------------------------------------
  surfaces: {
    manager: {
      label: 'Manager',
      summary:
        'A manager\'s whole back office at the locations they run: the day board, customers, ' +
        'bills, the service catalog and promotions, worker schedules, and — the part that ' +
        'distinguishes them from a cashier — the earnings ledger. Nothing here is per-person: ' +
        'a manager\'s reach is defined by which locations their grant covers, so this tab shows ' +
        'the locations YOU govern.',
      role: [
        {
          table: 'sal_locations',
          label: 'Locations in reach',
          columns: ['id', 'name', 'address', 'timezone', 'store_hours', 'active'],
          subjectColumn: null,
          scopeColumn: 'id',
        },
        {
          table: 'sal_appointments',
          label: 'Appointment book (the day board)',
          columns: [
            'id', 'location_id', 'scheduled_start', 'scheduled_end', 'state',
            'worker_id', 'customer_id', 'service_id', 'booked_by', 'cancelled_at',
          ],
          embed: [
            { alias: 'customer', table: 'sal_customers', columns: ['name:full_name'] },
            { alias: 'service', table: 'sal_services', columns: ['name'] },
          ],
          subjectColumn: null, // location-wide: the same board for every manager of that store
          scopeColumn: 'location_id',
          orderBy: { column: 'scheduled_start', ascending: false },
          limit: 100,
          caveat:
            'The free-text `notes` column and the per-appointment `checklist` are left off the ' +
            'allow-list as noise, not for confidentiality — a manager reads both ambiently ' +
            'either way. They ARE on the worker surface, where the checklist is the worker\'s ' +
            'own working record.',
        },
        {
          table: 'sal_customers',
          label: 'Customers at these locations',
          columns: ['id', 'location_id', 'full_name', 'phone', 'email', 'user_id', 'created_at'],
          subjectColumn: null,
          scopeColumn: 'location_id',
          orderBy: { column: 'created_at', ascending: false },
          limit: 100,
          caveat:
            '`notes` is deliberately off the allow-list: it is staff-authored free text about a ' +
            'named person ("difficult about cuticles"), the manager reads it ambiently either ' +
            'way, and no view-as question needs it on screen. A column-level product exclusion, ' +
            'recorded here because the allow-list is the only place view-as can express one. ' +
            '`phone`/`email` DO stay, and the line is deliberate rather than inconsistent: they ' +
            'are operational contact details the customer supplied and the position uses daily ' +
            '(the spec has the cashier editing them), so a customer list without them would ' +
            'misrepresent what a manager sees — whereas `notes` is staff commentary ABOUT the ' +
            'person, which nothing on this tab needs. Note also `user_id` is null for walk-ins, ' +
            'who are the majority (spec, 2026-08-03).',
        },
        {
          table: 'sal_bills',
          label: 'Bills',
          columns: [
            'id', 'location_id', 'appointment_id', 'state', 'subtotal', 'discount_total',
            'total', 'promotion_id', 'payment_method', 'paid_at', 'paid_by',
            'voided_by', 'refunded_by', 'refund_amount', 'created_by',
          ],
          subjectColumn: null,
          scopeColumn: 'location_id',
          limit: 100,
          caveat:
            'Void/refund are the manager\'s audit-trailed escape hatch (`sal_guard_bill`), so ' +
            'the WHO stamps are on the surface; `voided_at`/`refunded_at` and the two reason ' +
            'columns are off the allow-list as noise, which means this section shows who ' +
            'reversed a bill but not when or why. `sal_bills` carries no customer column at all — the ' +
            'billed person is two hops away through the appointment (spec, 2026-08-03) — which ' +
            'is why the customer name is rendered on the appointment section instead.',
        },
        {
          table: 'sal_bill_items',
          label: 'Bill line items',
          columns: ['id', 'location_id', 'bill_id', 'service_id', 'description', 'quantity', 'unit_price', 'line_total'],
          subjectColumn: null,
          scopeColumn: 'location_id',
          limit: 200,
        },
        {
          table: 'sal_services',
          label: 'Service catalog',
          columns: ['id', 'location_id', 'name', 'price', 'approx_duration_minutes', 'active', 'sort'],
          subjectColumn: null,
          scopeColumn: 'location_id',
          orderBy: { column: 'sort', ascending: true },
        },
        {
          table: 'sal_promotions',
          label: 'Promotions',
          columns: [
            'id', 'location_id', 'name', 'kind', 'threshold', 'lapsed_days',
            'discount_type', 'discount_value', 'active', 'starts_on', 'ends_on', 'created_by',
          ],
          subjectColumn: null,
          scopeColumn: 'location_id',
          caveat:
            'Manager-authored, cashier-surfaced (spec) — and operate-tier readable, so this ' +
            'section appears on the cashier surface too. It is NOT customer-readable.',
        },
        {
          table: 'sal_worker_profiles',
          label: 'Workers, schedules and time off',
          columns: ['id', 'location_id', 'user_id', 'display_name', 'weekly_schedule', 'skills', 'active'],
          embed: [
            { alias: 'time_off', table: 'sal_worker_time_off', columns: ['starts_at', 'ends_at', 'reason'] },
          ],
          subjectColumn: null,
          scopeColumn: 'location_id',
          caveat:
            '`sal_worker_time_off` is rendered as an embed under the profile it belongs to ' +
            'rather than as its own section, because it names its person through ' +
            '`worker_profile_id` and `subjectColumn` can only key on a user-id column. Under a ' +
            'profile the hop is already made, so the rows are the right ones in both modes. It ' +
            'is therefore ON this surface, not excluded — the manager and cashier tiers both ' +
            'read it (`sal_worker_time_off_select`), and `reason` can say "medical leave", ' +
            'which is exactly why customers get the yes/no definer instead ' +
            '(`sal_worker_has_time_off`, 20260716010000).',
        },
        {
          table: 'sal_earnings_ledger',
          label: 'Earnings ledger (revenue)',
          columns: ['id', 'location_id', 'kind', 'amount', 'occurred_at', 'worker_id', 'bill_id', 'appointment_id'],
          subjectColumn: null,
          scopeColumn: 'location_id',
          orderBy: { column: 'occurred_at', ascending: false },
          limit: 100,
          caveat:
            'THE section that distinguishes this surface from the cashier\'s: ' +
            '`sal_earnings_ledger_select_manage` is `sal_can_manage_location`, with no operate ' +
            'arm and no worker arm — so a cashier sees none of it, and neither does the worker ' +
            'whose chair earned it, despite the `worker_id` column naming them. Fed ' +
            'automatically by paid bills (`sal_feed_earnings`). NOT append-only, whatever the ' +
            'schema comment aspires to: the blanket `sal_earnings_ledger_write_manage` policy is ' +
            '`for all` and the table carries a full DML grant, so manage tier can correct or ' +
            'delete a row (the base migration says so out loud — "manager corrections via the ' +
            'blanket policy"). This is a REPORT, not an audit log; `view_as_sessions` is what ' +
            'append-only looks like when it is enforced (no UPDATE/DELETE grant at all).',
        },
        {
          table: 'sal_expenses',
          label: 'Expenses',
          columns: ['id', 'location_id', 'category', 'description', 'amount', 'spent_at', 'source_shopping_item_id', 'created_by'],
          subjectColumn: null,
          scopeColumn: 'location_id',
          orderBy: { column: 'spent_at', ascending: false },
          limit: 100,
        },
        {
          table: 'sal_shopping_list',
          label: 'Shopping list',
          columns: ['id', 'location_id', 'item', 'quantity', 'estimated_cost', 'status', 'purchased_at', 'expense_id'],
          subjectColumn: null,
          scopeColumn: 'location_id',
          limit: 100,
        },
      ],
      personal: [],
      excluded: [],
      // A manager reads all twelve tables inside the locations their grant
      // covers, so this list is empty — and that is the finding the tab exists
      // to convey when read next to the cashier and worker tabs.
      unreadableByPosition: [],
    },

    cashier: {
      label: 'Cashier',
      summary:
        'The front desk: today\'s board, walk-ins and customers, bills and line items, the ' +
        'catalog, promotions, worker schedules, and the bookkeeping they help keep. A cashier ' +
        'sees the same operational rows as a manager at the same location, with ONE exception — ' +
        'the earnings ledger, which is manage-tier only. Because no person is named (mode 1 ' +
        'only), this tab spans every location YOU govern: where cashiers are each scoped to one ' +
        'store, it is wider than any single cashier\'s view, and the row counts are yours.',
      role: [
        {
          table: 'sal_locations',
          label: 'Locations in reach',
          columns: ['id', 'name', 'address', 'timezone', 'store_hours', 'active'],
          subjectColumn: null,
          scopeColumn: 'id',
        },
        {
          table: 'sal_appointments',
          label: 'Appointment book (the day board)',
          columns: [
            'id', 'location_id', 'scheduled_start', 'scheduled_end', 'state',
            'worker_id', 'customer_id', 'service_id', 'booked_by', 'cancelled_at',
          ],
          embed: [
            { alias: 'customer', table: 'sal_customers', columns: ['name:full_name'] },
            { alias: 'service', table: 'sal_services', columns: ['name'] },
          ],
          subjectColumn: null,
          scopeColumn: 'location_id',
          orderBy: { column: 'scheduled_start', ascending: false },
          limit: 100,
        },
        {
          table: 'sal_customers',
          label: 'Customers at these locations',
          columns: ['id', 'location_id', 'full_name', 'phone', 'email', 'user_id', 'created_at'],
          subjectColumn: null,
          scopeColumn: 'location_id',
          orderBy: { column: 'created_at', ascending: false },
          limit: 100,
          caveat:
            '`notes` is off the allow-list for the same reason as on the manager surface — a ' +
            'column-level product exclusion over data the whole operate tier reads ambiently. ' +
            'The cashier\'s own three-tap walk-in quick-add writes rows here (spec).',
        },
        {
          table: 'sal_bills',
          label: 'Bills',
          columns: [
            'id', 'location_id', 'appointment_id', 'state', 'subtotal', 'discount_total',
            'total', 'promotion_id', 'payment_method', 'paid_at', 'paid_by', 'created_by',
          ],
          subjectColumn: null,
          scopeColumn: 'location_id',
          limit: 100,
          caveat:
            'The void/refund stamps are off THIS allow-list on purpose: a cashier cannot make ' +
            'either transition (`sal_guard_bill` raises unless `sal_can_manage_location`), and ' +
            'once a bill is paid its monetary columns are pinned against them. They can read a ' +
            'voided bill\'s row, so this is a presentation choice, not a claim about reach — ' +
            'the escape hatch belongs on the manager tab, where the person who can pull it is.',
        },
        {
          table: 'sal_bill_items',
          label: 'Bill line items',
          columns: ['id', 'location_id', 'bill_id', 'service_id', 'description', 'quantity', 'unit_price', 'line_total'],
          subjectColumn: null,
          scopeColumn: 'location_id',
          limit: 200,
        },
        {
          table: 'sal_services',
          label: 'Service catalog',
          columns: ['id', 'location_id', 'name', 'price', 'approx_duration_minutes', 'active', 'sort'],
          subjectColumn: null,
          scopeColumn: 'location_id',
          orderBy: { column: 'sort', ascending: true },
          caveat:
            'Read-only for a cashier in practice: `sal_services` has no operate write policy, ' +
            'only `sal_services_write_manage`. The catalog drives the price preview and the ' +
            'default bill line.',
        },
        {
          table: 'sal_promotions',
          label: 'Promotions to offer',
          columns: [
            'id', 'location_id', 'name', 'kind', 'threshold', 'lapsed_days',
            'discount_type', 'discount_value', 'active', 'starts_on', 'ends_on',
          ],
          subjectColumn: null,
          scopeColumn: 'location_id',
          caveat:
            'Operate-tier read (`sal_promotions_select_operate`) — this is the cashier surfacing ' +
            'a promotion the manager authored. `created_by` is off the allow-list here because ' +
            'who authored it is a manager-side fact.',
        },
        {
          table: 'sal_worker_profiles',
          label: 'Workers, schedules and time off',
          columns: ['id', 'location_id', 'user_id', 'display_name', 'weekly_schedule', 'skills', 'active'],
          embed: [
            { alias: 'time_off', table: 'sal_worker_time_off', columns: ['starts_at', 'ends_at', 'reason'] },
          ],
          subjectColumn: null,
          scopeColumn: 'location_id',
          caveat:
            'A cashier books on a customer\'s behalf, so they read the schedules and the ' +
            'time-off rows that make a slot unbookable — `sal_worker_time_off_select` grants ' +
            'the whole operate tier, and that read is what makes availability enforcement work ' +
            'on the counter path (20260716010000). Embedded under the profile because the table ' +
            'names its person through `worker_profile_id`.',
        },
        {
          table: 'sal_expenses',
          label: 'Expenses',
          columns: ['id', 'location_id', 'category', 'description', 'amount', 'spent_at', 'created_by'],
          subjectColumn: null,
          scopeColumn: 'location_id',
          orderBy: { column: 'spent_at', ascending: false },
          limit: 100,
          caveat:
            'Operate-tier, deliberately: "cashiers commonly log purchases / tick shopping ' +
            'items" (20260709030000). Expenses are NOT revenue — a cashier can see what the ' +
            'salon spent and not what it took, which is the module\'s clearest asymmetric ' +
            'read and worth seeing stated on this tab.',
        },
        {
          table: 'sal_shopping_list',
          label: 'Shopping list',
          columns: ['id', 'location_id', 'item', 'quantity', 'estimated_cost', 'status', 'purchased_at', 'expense_id'],
          subjectColumn: null,
          scopeColumn: 'location_id',
          limit: 100,
        },
      ],
      personal: [],
      excluded: [],
      unreadableByPosition: [
        {
          table: 'sal_earnings_ledger',
          why:
            'The single most useful fact on this tab. `sal_earnings_ledger_select_manage` is ' +
            '`sal_can_manage_location(org_id, location_id)` — rank >= 2 or org admin — and ' +
            'there has never been an operate arm, so a cashier reads no revenue at all: not ' +
            'totals, not a single sale row, not the refund reversals. A manager reading this ' +
            'tab beside their own is looking at exactly the difference between the two ' +
            'positions.',
        },
      ],
    },

    worker: {
      label: 'Nail worker',
      summary:
        'What a nail worker actually sees: their own assigned appointments with the customer ' +
        'named, their own schedule and time off, and the service catalog. Not the money — a ' +
        'worker cannot read bills, expenses, or even the earnings rows attributed to their own ' +
        'chair.',
      role: [
        {
          table: 'sal_locations',
          label: 'Locations',
          columns: ['id', 'name', 'address', 'timezone', 'store_hours', 'active'],
          subjectColumn: null,
          scopeColumn: 'id',
          caveat:
            'The worker\'s own reach here is WIDER than this section: ' +
            '`sal_locations_select_member` is org-member-wide, so a worker can read every store ' +
            'in the org and its hours, not just the one they have a profile at (the founder ' +
            'chose org-wide catalog reads deliberately, 20260726010000 §4). What renders is ' +
            'narrowed to the locations in reach by §8.1 point 10\'s scope intersection — ours, ' +
            'not RLS\'s. Stated so the narrowing is never mistaken for a policy; note also that ' +
            'a salon module with a scopeEntity CANNOT declare a section unfiltered, because ' +
            '`viewAsCompleteness()` refuses `scopeColumn: null` when an entity tree exists.',
        },
        {
          table: 'sal_worker_profiles',
          label: 'Their profile, schedule and time off',
          columns: ['id', 'location_id', 'user_id', 'display_name', 'weekly_schedule', 'skills', 'active'],
          embed: [
            { alias: 'time_off', table: 'sal_worker_time_off', columns: ['starts_at', 'ends_at', 'reason'] },
          ],
          // The profile IS the person here, so the surface keys on it and the
          // embedded time-off rows come back already narrowed to them.
          subjectColumn: 'user_id',
          scopeColumn: 'location_id',
          caveat:
            'NARROWED TO THE TARGET ON PURPOSE, and the narrowing is ours, not RLS\'s: ' +
            '`sal_worker_profiles_select_member` lets any org member read EVERY worker profile ' +
            'and weekly schedule in the org, so a worker can in fact see their colleagues\' ' +
            'hours. Their own schedule is what the tab is for, and a colleague roster would ' +
            'bury it — but the wider reach is stated here so the narrowing is never mistaken ' +
            'for a policy. The embedded `sal_worker_time_off` rows, by contrast, are narrow in ' +
            'RLS too: a worker reads only time-off rows on their own profile.',
        },
        {
          table: 'sal_appointments',
          label: 'Their appointments (the chair view)',
          columns: [
            'id', 'location_id', 'scheduled_start', 'scheduled_end', 'state',
            'worker_id', 'customer_id', 'service_id', 'checklist', 'notes',
          ],
          embed: [
            { alias: 'customer', table: 'sal_customers', columns: ['name:full_name'] },
            { alias: 'service', table: 'sal_services', columns: ['name'] },
          ],
          subjectColumn: 'worker_id',
          scopeColumn: 'location_id',
          orderBy: { column: 'scheduled_start', ascending: false },
          limit: 100,
          caveat:
            'Mirrors `sal_appointments_select`\'s worker arm exactly (`worker_id = auth.uid()`), ' +
            'including every state — a worker keeps reading an appointment after it locks at ' +
            '`complete`, they just cannot write it (`sal_pin_appointment`). `checklist` and ' +
            '`notes` are on this surface because they are the worker\'s own mid-appointment ' +
            'record. An "Any worker" booking has `worker_id` null and so appears on nobody\'s ' +
            'chair view — correct, and the reason the assignment algorithm is still an open ' +
            'module item.',
        },
        {
          table: 'sal_services',
          label: 'Service catalog',
          columns: ['id', 'location_id', 'name', 'price', 'approx_duration_minutes', 'active', 'sort'],
          subjectColumn: null,
          scopeColumn: 'location_id',
          orderBy: { column: 'sort', ascending: true },
          caveat:
            'Org-member readable, so a worker can see prices and durations across the org even ' +
            'though their own console only ever names the service on a chair. On the surface ' +
            'because duration is what sizes their slot and price is what the customer was ' +
            'quoted. Like the location section above, what RENDERS is scope-intersected to the ' +
            'locations in reach, so it is narrower than the worker\'s actual org-wide reach.',
        },
      ],
      personal: [],
      excluded: [
        {
          table: 'sal_customers',
          why:
            'No standalone customer section, by decision. A worker\'s reach is narrower than a ' +
            'section could honestly express: `sal_customers_select` gives them only ' +
            '`sal_worker_sees_customer(id)` — customers they have an appointment with — and ' +
            '`subjectColumn` keys on a user-id column, so there is no way to say "customers ' +
            'reachable through the target\'s appointments". Rendering it unfiltered would show ' +
            'every customer at the location and be FALSELY PERMISSIVE, which is the one failure ' +
            'mode a mode-2 tab must not have. Instead the customer\'s `full_name` is embedded on ' +
            'the appointment above — RLS-filtered independently, and exactly how the worker\'s ' +
            'own console renders it. Marked `excluded` and not `personal` because the VIEWER (an ' +
            'admin or manager) reads the table perfectly well; also note the worker reads the ' +
            'customer\'s `phone`, `email` and care `notes` through that same row, which this ' +
            'surface does not render.',
        },
      ],
      unreadableByPosition: [
        {
          table: 'sal_bills',
          why:
            '`sal_bills_select` is `sal_can_operate_location(org_id, location_id) or ' +
            'sal_owns_bill(id)` — an operate arm and a customer-ownership arm, and no worker ' +
            'arm in any version. A worker never sees what the appointment they performed was ' +
            'billed at.',
        },
        {
          table: 'sal_bill_items',
          why:
            '`sal_bill_items_select` mirrors the bill policy exactly ' +
            '(`sal_can_operate_location or sal_owns_bill(bill_id)`), so the line items are ' +
            'closed to a worker for the same reason the bill is.',
        },
        {
          table: 'sal_earnings_ledger',
          why:
            'Manage-tier only (`sal_can_manage_location`), which means a worker cannot read ' +
            'the revenue rows that carry their OWN `worker_id`. Deliberate — the ledger is ' +
            'reporting, and tips/commissions are explicitly out of v1 — but it is the fact on ' +
            'this surface most likely to surprise, so it is recorded rather than left as an ' +
            'absence.',
        },
        {
          table: 'sal_promotions',
          why:
            '`sal_promotions_select_operate` is operate-tier, with no member arm and no worker ' +
            'arm: promotions are surfaced by the cashier at billing, and a worker never sees ' +
            'the discount structure.',
        },
        {
          table: 'sal_expenses',
          why:
            '`sal_expenses_select_operate` is operate-tier only. Back-office bookkeeping is ' +
            'closed to the chair.',
        },
        {
          table: 'sal_shopping_list',
          why:
            '`sal_shopping_list_select_operate` is operate-tier only — so a worker cannot even ' +
            'read what supplies have been ordered, let alone add to the list. Recorded because ' +
            'this is the one entry a client might reasonably want changed, and it should change ' +
            'by adding a policy arm and re-reviewing the surface, never by a UI tweak.',
        },
      ],
    },
  },
})

// ---------------------------------------------------------------------------
// Speed dating — ranks admin 3 > organizer 2 > host 1 > participant 0.
// Six rank-differential pairs. Every incoming pair to `participant` is OFF,
// which is how §8.1 point 7's `viewAs: none` end-user ban is expressed under
// the amendment — point 11 subsumes the flag as a special case rather than
// keeping a second mechanism.
//
// SURFACE SECURITY REVIEW DONE 2026-08-28 for the three remaining pairs
// (admin->organizer, admin->host, organizer->host). Verified against the
// CURRENT policies (`sd_interest_select`/`sd_matches_select` as rewritten by
// 20260726030000, not the base migration) and the live console
// (modules/speed-dating/ui/events/[eventId]/page.tsx), the same discipline as
// nail-salon's 2026-08-04 review.
//
// ONE JUDGEMENT LEFT DELIBERATELY BROAD, recorded so it reads as a choice: the
// column allow-lists below are wider than what the live console's own
// `.select()` calls fetch today (it never reads `profile`, and its report list
// omits `during_call`/`pairing_id`). They are kept at what the POSITION can
// legitimately read and would plausibly need, matching nail-salon's style,
// because the tab answers "what does this position see?" rather than "what does
// today's page happen to render." Trimming them to mirror the live UI literally
// is a defensible alternative a future reviewer may prefer — it would narrow,
// never widen, so it needs no migration.
// ---------------------------------------------------------------------------
const SD_PARTICIPANT_BAN =
  'OFF permanently, not pending review — this is §8.1 point 7\'s end-user view-as ban ' +
  'expressed as pairs. sd_interest is a one-sided secret whose RLS deliberately gives the ' +
  'rated person no read path at all, so rejection is indistinguishable from indecision; ' +
  'sd_matches hides an unrevealed match from both parties until the organizer reveals it; ' +
  'sd_notes is author-only with no staff arm anywhere. A participant tab would either be ' +
  'empty of everything that matters or would put a third party\'s one-sided secret on a ' +
  'staff screen. Changing this needs a dated founder decision, not a build-time judgement.'

// Shared reasoning for every ON pair below: staff reach here is RANK/SCOPE
// -narrowed (module_position_rank + module_scope_covers via
// sd_can_organize_event/sd_can_staff_event_of), never PERSON-narrowed — no
// sd_ column can name "the organizer" or "the host" without falling back to
// an authorship stamp (sd_events.created_by, sd_reports.reviewed_by) that
// would under-show the tab by hiding most of what the position reaches.
// Mirrors nail-salon's SALON_NARROWING/manage-tier reasoning, one rung down.
const SD_NOT_PERSON_FILTERABLE =
  'Mode 2 is off: this position\'s reach is rank/scope-gated (module_position_rank + ' +
  'module_scope_covers), never person-gated. The only columns naming this position are ' +
  'authorship stamps (sd_events.created_by, sd_reports.reviewed_by), and keying on either ' +
  'would UNDER-show the tab by hiding every event/report this holder did not personally ' +
  'create or review — which is most of what the position actually reaches.'

export const speedDatingViewAs = declareViewAs({
  positions: { admin: 3, organizer: 2, host: 1, participant: 0 },
  edges: {
    admin: {
      organizer: {
        mode1: true,
        mode2: false,
        note:
          'MODE 1 ON, MODE 2 OFF (review 2026-08-28). On the seven event-scoped tables gated by ' +
          'sd_can_organize_event/sd_can_staff_event_of (sd_events, sd_participants, sd_rounds, ' +
          'sd_pairings, sd_reports, sd_interest, sd_matches), admin (rank 3) and organizer ' +
          "(rank 2) both clear module_position_rank('speed-dating',·) >= 2, so within whatever " +
          'scope each grant covers they see identically-shaped rows — the same "same predicate, ' +
          'still worth a tab" case as nail-salon\'s admin -> manager. Where they diverge: ' +
          'sd_can_manage (is_org_admin(org) OR has_module_role(org,\'speed-dating\',\'admin\')) ' +
          'has never had an organizer arm, so sd_blocks (the block list\'s staff-read arm) and ' +
          'sd_bans (the platform-style ban list) are invisible to every organizer, however ' +
          'senior — exactly the absence mode 1 earns its place showing. ' +
          SD_NOT_PERSON_FILTERABLE +
          ' FOUNDER: flag if a person-scoped organizer view is wanted — it needs a different ' +
          'mode-2 definition, not something this review can turn on for free.',
      },
      host: {
        mode1: true,
        mode2: false,
        note:
          'MODE 1 ON, MODE 2 OFF (review 2026-08-28). Host is a genuinely NARROWER position, ' +
          'not the same predicate at smaller scope: sd_can_staff_event_of = ' +
          'sd_can_organize_event OR module_caller_covers_role(...,\'host\'), so host reads ' +
          'sd_events/sd_participants/sd_rounds/sd_pairings/sd_reports at the same ' +
          'scope-intersected breadth as an organizer — but sd_interest_select and ' +
          'sd_matches_select check ONLY sd_can_organize_event, with no staff/host arm in any ' +
          'version (20260709050000: "host is NOT granted interest read; matching data is ' +
          'sensitive, host\'s domain is lobby/reports"). A host has zero read path to either, ' +
          'declared unreadableByPosition — verified against the live console ' +
          '(modules/speed-dating/ui/events/[eventId]/page.tsx), whose staff-tier block never ' +
          'touches interests/matches, only the organizer-only block does. Same absence for ' +
          'sd_blocks/sd_bans (admin-only, no organizer OR host arm) and sd_notes (author-only, ' +
          'no staff arm ever). Speed-dating\'s version of nail-salon\'s admin -> worker pair. ' +
          SD_NOT_PERSON_FILTERABLE,
      },
      participant: { mode1: false, mode2: false, note: SD_PARTICIPANT_BAN },
    },
    organizer: {
      host: {
        mode1: true,
        mode2: false,
        note:
          'MODE 1 ON, MODE 2 OFF (review 2026-08-28) — the pair originally left pending exactly ' +
          'because an organizer\'s own ambient reach includes sd_interest/sd_matches (via ' +
          'sd_can_organize_event), which host categorically lacks (see admin -> host above). ' +
          'Rendering the HOST surface for an organizer caller needed no new machinery: the ' +
          'renderer only ever queries the tables on the TARGET position\'s declared surface, ' +
          'and host\'s surface omits sd_interest/sd_matches entirely (unreadableByPosition ' +
          'instead) — so an organizer viewing "as host" never touches either table, regardless ' +
          'of what the organizer\'s own client could read. Same excluded/unreadableByPosition ' +
          'discipline nail-salon\'s worker review established, one rung down the ladder. ' +
          'Everything host DOES read is a strict subset of what an organizer already reads at ' +
          'the same scope, so mode 1 widens nothing. ' +
          SD_NOT_PERSON_FILTERABLE,
      },
      participant: { mode1: false, mode2: false, note: SD_PARTICIPANT_BAN },
    },
    host: {
      participant: { mode1: false, mode2: false, note: SD_PARTICIPANT_BAN },
    },
  },

  scopeEntity: { table: 'sd_events', idColumn: 'id', nodeColumn: 'scope_node_id' },

  // ---------------------------------------------------------------------
  // Surfaces. Both positions below account for all TEN sd_ tables — role,
  // unreadableByPosition, personal, or excluded — none fall through.
  // `personal` is empty for both, and that emptiness is itself the finding:
  // speed-dating has no staff-personal layer (sd_notes is a PARTICIPANT
  // concept, not a staff one — it sits in unreadableByPosition, not
  // personal, because the POSITION has no read arm at all, a different claim
  // than personal would make about a table the VIEWER can partly reach).
  // ---------------------------------------------------------------------
  surfaces: {
    organizer: {
      label: 'Organizer',
      summary:
        'An organizer\'s whole live-console reach at the events their grant covers: full event ' +
        'setup and lifecycle, the roster (including audience/mentor observer seats), rounds and ' +
        'the pairing/rooms grid, and safety reports. Missing entirely: the org\'s block list and ' +
        'platform ban list (admin-only), every participant\'s private notepad (author-only, not ' +
        'even organizers), and — see the caveat below — a raw view of interest marks/matches.',
      role: [
        {
          table: 'sd_events',
          label: 'Events in reach',
          columns: [
            'id', 'name', 'description', 'scheduled_at', 'lobby_opens_at', 'state',
            'round_duration_seconds', 'break_duration_seconds', 'rounds_planned', 'format',
            'allow_repeat_pairings', 'resume_review_enabled', 'current_round_id',
            'created_by', 'created_at',
          ],
          subjectColumn: null,
          scopeColumn: 'id',
          orderBy: { column: 'scheduled_at', ascending: false },
          caveat:
            'No state filter — the staff arm of sd_events_select (sd_can_staff_event_of) sees ' +
            'every state including draft, unlike the participant arm which only shows ' +
            'open/running/complete/cancelled.',
        },
        {
          table: 'sd_participants',
          label: 'Roster (incl. audience/mentor seats)',
          columns: [
            'id', 'event_id', 'user_id', 'seat_type', 'pool_side', 'status',
            'checked_in', 'checked_in_at', 'mentee_participant_id',
            'allows_audience', 'allows_mentor', 'profile_card', 'created_at',
          ],
          subjectColumn: null,
          scopeColumn: 'event_id',
          caveat:
            'The full `profile` jsonb answer snapshot is left off the allow-list as noise — the ' +
            'live console (modules/speed-dating/ui/events/[eventId]/page.tsx) never selects it ' +
            'either, only the short profile_card blurb.',
        },
        {
          table: 'sd_rounds',
          label: 'Rounds',
          columns: ['id', 'event_id', 'round_number', 'state', 'starts_at', 'ends_at', 'break_ends_at'],
          subjectColumn: null,
          scopeColumn: 'event_id',
          orderBy: { column: 'round_number', ascending: true },
        },
        {
          table: 'sd_pairings',
          label: 'Rooms grid',
          columns: [
            'id', 'event_id', 'round_id', 'participant_a_id', 'participant_b_id',
            'room_ref', 'room_provider', 'created_at',
          ],
          subjectColumn: null,
          scopeColumn: 'event_id',
          caveat:
            'Connection status only, never video — there is no recording, ever, and no video ' +
            'column in the schema at all (product promise, 20260709050000 header). room_ref/' +
            'room_provider are currently always null in practice: the video-provider ' +
            'integration is deliberately not built yet.',
        },
        {
          table: 'sd_reports',
          label: 'Safety reports',
          columns: [
            'id', 'event_id', 'reporter_participant_id', 'reported_participant_id', 'pairing_id',
            'reason', 'detail', 'during_call', 'state', 'reviewed_by', 'reviewed_at', 'created_at',
          ],
          subjectColumn: null,
          scopeColumn: 'event_id',
          orderBy: { column: 'created_at', ascending: false },
          caveat:
            'reviewed_by/reviewed_at are triage stamps, not used as a subject column for the ' +
            'same under-showing reason as sd_events.created_by (see the pair notes above). ' +
            'reported_participant_id can be null (ON DELETE SET NULL) if the reported seat is ' +
            'later removed.',
        },
      ],
      personal: [],
      excluded: [
        {
          table: 'sd_interest',
          why:
            'An organizer CAN read this in full (sd_can_organize_event, no further ' +
            'restriction) — genuinely within their RLS reach and named as "post-event stats" in ' +
            'the module header. Excluded anyway: the live console ' +
            '(modules/speed-dating/ui/events/[eventId]/page.tsx) never renders a raw ' +
            'per-mark grid to any human, only an aggregate count, and the module\'s own design ' +
            'repeatedly treats this table as privacy-critical ("one-sided interest reveals ' +
            'nothing" — the same phrase justifies the permanent participant ban above). ' +
            'Rendering the raw table on an admin-facing tab would show MORE than what the real ' +
            'organizer console ever displays, which is the falsely-INFORMATIVE failure mode for ' +
            'a feature whose whole point is "show what this position actually sees" — so this ' +
            'follows the same excluded/noise discipline as e.g. sal_customers.notes, just for a ' +
            'sensitivity reason instead of a noise one. FOUNDER: if organizers are meant to work ' +
            'from raw interest data day to day (not just the aggregate the console shows today), ' +
            'this should flip to role instead — flagging rather than deciding unilaterally.',
        },
        {
          table: 'sd_matches',
          why:
            'Same reasoning and the same live-console fact as sd_interest above: an organizer ' +
            'can read every match row including unrevealed ones (sd_can_organize_event, no ' +
            'reveal-gate arm), but the console only ever shows a revealed/total count, never ' +
            'raw rows. Excluded for the identical reason. FOUNDER: same flag as sd_interest — ' +
            'revisit together if the console ever grows a raw matches view.',
        },
      ],
      unreadableByPosition: [
        {
          table: 'sd_blocks',
          why:
            'sd_blocks_select is blocker_user_id = auth.uid() OR sd_can_manage(org_id), and ' +
            'sd_can_manage is is_org_admin(org) OR has_module_role(org,\'speed-dating\',\'admin\') ' +
            '— no organizer arm in any version. An organizer never sees who blocked whom, ' +
            'however senior.',
        },
        {
          table: 'sd_bans',
          why:
            'sd_bans_all_manage is sd_can_manage(org_id) only, the same admin-only gate as ' +
            'sd_blocks (no organizer arm) — the platform ban list is invisible to every ' +
            'organizer.',
        },
        {
          table: 'sd_notes',
          why:
            'sd_notes_all_own is author_user_id = auth.uid() and is the ONLY policy on the ' +
            'table (for all) — explicitly excluded from the blanket organize-write policy by ' +
            'original design ("a personal notepad, not event data"). No staff arm has ever ' +
            'existed; an organizer cannot read a participant\'s private notes about anyone.',
        },
      ],
    },

    host: {
      label: 'Host',
      summary:
        'What a lobby/rooms host actually sees: the same roster, rounds and pairings grid as an ' +
        'organizer, plus safety-report triage — but never the interest marks or the match ' +
        'ledger (matching data is staff-restricted to organize tier only; host\'s domain is ' +
        'lobby/reports), and never the block list, ban list, or anyone\'s private notes.',
      role: [
        {
          table: 'sd_events',
          label: 'Events in reach',
          columns: [
            'id', 'name', 'description', 'scheduled_at', 'lobby_opens_at', 'state',
            'round_duration_seconds', 'break_duration_seconds', 'rounds_planned', 'format',
            'allow_repeat_pairings', 'resume_review_enabled', 'current_round_id',
            'created_by', 'created_at',
          ],
          subjectColumn: null,
          scopeColumn: 'id',
          orderBy: { column: 'scheduled_at', ascending: false },
          caveat:
            'Identical breadth to the organizer surface\'s sd_events section — ' +
            'sd_can_staff_event_of ORs in sd_can_organize_event, so a host sees every event ' +
            'state an organizer does.',
        },
        {
          table: 'sd_participants',
          label: 'Roster (incl. audience/mentor seats)',
          columns: [
            'id', 'event_id', 'user_id', 'seat_type', 'pool_side', 'status',
            'checked_in', 'checked_in_at', 'mentee_participant_id',
            'allows_audience', 'allows_mentor', 'profile_card', 'created_at',
          ],
          subjectColumn: null,
          scopeColumn: 'event_id',
          caveat:
            'Same read reach as organizer\'s roster section (sd_can_staff_event_of). A host\'s ' +
            'WRITE path is narrower (sd_pin_participant limits a host to flipping status -> ' +
            'removed on someone else\'s row) but that is a write restriction, not a read one, ' +
            'so it does not change this surface.',
        },
        {
          table: 'sd_rounds',
          label: 'Rounds',
          columns: ['id', 'event_id', 'round_number', 'state', 'starts_at', 'ends_at', 'break_ends_at'],
          subjectColumn: null,
          scopeColumn: 'event_id',
          orderBy: { column: 'round_number', ascending: true },
        },
        {
          table: 'sd_pairings',
          label: 'Rooms grid',
          columns: [
            'id', 'event_id', 'round_id', 'participant_a_id', 'participant_b_id',
            'room_ref', 'room_provider', 'created_at',
          ],
          subjectColumn: null,
          scopeColumn: 'event_id',
          caveat:
            'Connection status only, never video — same as the organizer surface; a host\'s ' +
            'reach here is identical to an organizer\'s (both via sd_can_staff_event_of).',
        },
        {
          table: 'sd_reports',
          label: 'Safety reports',
          columns: [
            'id', 'event_id', 'reporter_participant_id', 'reported_participant_id', 'pairing_id',
            'reason', 'detail', 'during_call', 'state', 'reviewed_by', 'reviewed_at', 'created_at',
          ],
          subjectColumn: null,
          scopeColumn: 'event_id',
          orderBy: { column: 'created_at', ascending: false },
          caveat:
            'This is host\'s core duty per the module comment ("handles reported rooms") — ' +
            'host gets its own sd_reports_update_staff policy (organize-write does not cover ' +
            'host) so it can triage state/review fields.',
        },
      ],
      personal: [],
      excluded: [],
      unreadableByPosition: [
        {
          table: 'sd_interest',
          why:
            'sd_interest_select checks ONLY sd_can_organize_event (20260726030000) — there has ' +
            'never been a staff_event/host arm, per the original 20260709050000 comment ("host ' +
            'is NOT granted interest read; matching data is sensitive, host\'s domain is lobby/' +
            'reports, not who-liked-whom"). A host has zero read path — verified against the ' +
            'live console, whose staff-tier block never references sd_interest at all.',
        },
        {
          table: 'sd_matches',
          why:
            'sd_matches_select checks ONLY sd_can_organize_event, same as sd_interest — a host ' +
            'cannot see that a match exists at all, revealed or not.',
        },
        {
          table: 'sd_blocks',
          why:
            'sd_can_manage (blocker_user_id = auth.uid() OR sd_can_manage(org_id)) has no ' +
            'organizer OR host arm — same absence as the organizer surface above.',
        },
        {
          table: 'sd_bans',
          why: 'sd_can_manage is admin-only — same absence as the organizer surface above.',
        },
        {
          table: 'sd_notes',
          why:
            'author_user_id = auth.uid() is the ONLY policy on the table, ever — no staff arm ' +
            'exists for organizer OR host.',
        },
      ],
    },
  },
})

// ---------------------------------------------------------------------------
// The five vocabularies SQL has not rank-mapped. `module_position_rank()`
// returns 0 for every one of these role strings, so there is no ordered pair
// with a rank gap and the completeness check requires no entries. Declaring
// them anyway keeps the check total over the registry — and makes the eventual
// rank-mapping of these modules break the build until each newly-implied pair
// is answered, which is the whole point of the 2026-07-30 amendment.
//
// Matchmaking specifically: §8.1 point 7's ban applies to `single`. Nothing to
// express yet (no pairs exist), so the ban is recorded here in prose and
// becomes real edge entries the moment matchmaking is rank-mapped.
// ---------------------------------------------------------------------------
export const matchmakingViewAs = declareViewAs({
  positions: { single: 0, matchmaker: 0, admin: 0 },
  edges: {},
})

export const synagogueSchedulesViewAs = declareViewAs({
  positions: { maker: 0, viewer: 0 },
  edges: {},
})

export const visualMessagingViewAs = declareViewAs({
  positions: { admin: 0, moderator: 0, member: 0 },
  edges: {},
})

export const sampleViewAs = declareViewAs({
  positions: { manager: 0, member: 0 },
  edges: {},
})

export const stubViewAs = declareViewAs({
  positions: { user: 0, admin: 0 },
  edges: {},
})

/** Every declaration, for the platform-wide completeness assertions. */
export const viewAsDeclarations: Record<string, ViewAsDeclaration> = {
  classroom: classroomViewAs,
  'nail-salon': nailSalonViewAs,
  'speed-dating': speedDatingViewAs,
  matchmaking: matchmakingViewAs,
  'synagogue-schedules': synagogueSchedulesViewAs,
  'visual-messaging': visualMessagingViewAs,
  sample: sampleViewAs,
  stub: stubViewAs,
}
