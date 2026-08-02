// Per-module view-as declarations (docs/15 §8.1 points 5, 9, 11).
//
// EVERY module in the registry declares one, because the rank-differential
// completeness check is only a check if it is platform-wide: a module that
// could opt out by not declaring would be exactly the silent hole the
// 2026-07-30 amendment exists to close.
//
// WHICH MODULES HAVE EDGES ON (build decision, 2026-07-30):
//   classroom  — ON. §11 sequencing puts classroom first, §8's own tab sketch is
//                classroom, it holds the one pair the spec left explicitly open
//                (professor -> student), and it is the only module with real
//                SCOPED grants in the seed, so scope intersection is exercisable.
//   everything else — every pair explicitly OFF.
//
// The line is principled, not arbitrary: §8.1 point 9 says a position's surface
// classification is "decided in each module's security review." An edge may
// therefore only be ON in a module that has HAD that review. Classroom gets it
// in this slice; nail-salon and speed-dating are the obvious next candidates
// and their pairs are already enumerated below, so turning one on later is
// flipping booleans and writing a surface, never inventing a mechanism.
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
          table: 'cls_grades',
          label: 'Grades this GA entered',
          columns: [
            'id', 'class_id', 'student_id', 'homework_id', 'exam_id',
            'source', 'score', 'graded_by', 'is_final', 'visible',
          ],
          // The GA surface is defined BY the grader, so that is who a row is about.
          subjectColumn: 'graded_by',
          scopeColumn: 'class_id',
          filter: [{ column: 'source', eq: 'ga' }],
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
      ],
      // Nothing in classroom is RLS-unreadable to a professor in scope — the
      // module has no sd_notes analogue. Recorded as an empty list rather than
      // silently omitted, because "no true personal layer here" is itself the
      // finding (docs/15 2026-07-30 build entry).
      // Nothing on the GA surface is RLS-hidden from a professor in scope, so
      // there is no personal layer here in §8.1 point 1's strict sense.
      personal: [],
      excluded: [],
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
          label: 'Their submissions',
          columns: ['id', 'class_id', 'homework_id', 'student_id', 'state', 'submitted_at', 'visible_override_until'],
          subjectColumn: 'student_id',
          scopeColumn: 'class_id',
          hiddenWhen: {
            scopeCutoffColumn: 'submissions_hidden_from',
            overrideUntilColumn: 'visible_override_until',
          },
        },
        {
          table: 'cls_grades',
          label: 'Grades they can see',
          columns: [
            'id', 'class_id', 'student_id', 'homework_id', 'exam_id',
            'source', 'score', 'is_final', 'visible',
          ],
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
        {
          table: 'cls_review_comments',
          label: 'Peer-review comments on their work',
          columns: [
            'id', 'class_id', 'submission_id', 'author_id',
            'file_path', 'line_start', 'line_end', 'body', 'created_at',
          ],
          // The rows are ABOUT the student as the reviewee, so the surface keys
          // on the submission's owner rather than on author_id.
          subjectColumn: null,
          scopeColumn: 'class_id',
          caveat:
            'Deliberately MORE than the student sees — the reviewer\'s name is shown because ' +
            'anonymity runs from other students and the GA, not from the professor (founder, ' +
            '2026-08-02). Note what the student actually sees today is NOTHING: no ' +
            'student-facing view of peer feedback exists, and the anonymizing definer ' +
            'cls_comments_for_my_submission has no callers (it is one of the dead functions ' +
            'the 2026-07-29 ACL sweep listed). So this tab shows the professor feedback the ' +
            'student cannot currently reach at all.',
        },
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
// Every pair OFF: the module has not had its view-as surface security review.
// ---------------------------------------------------------------------------
const SALON_AWAITS_REVIEW =
  'OFF pending nail-salon\'s own view-as surface security review (docs/15 §8.1 point 9). ' +
  'Not a judgement that the pair is unsafe — the staff-facing ones look straightforward, ' +
  'since a manager already reads their location\'s appointments, bills and time-off — but an ' +
  'edge may only be switched on for a module whose surfaces have been classified table by ' +
  'table. Nail-salon is the obvious next candidate.'

const SALON_CUSTOMER =
  'OFF. A customer\'s surface is their own appointment and billing history — data they enter ' +
  'and receive as themselves, not duty output. Staff already read the operational rows they ' +
  'need at their own location; nothing about running a salon requires wearing a named ' +
  'customer\'s identity. Revisit only with a concrete need and its own review.'

export const nailSalonViewAs = declareViewAs({
  positions: { admin: 3, manager: 2, cashier: 1, worker: 1, customer: 0 },
  edges: {
    admin: {
      manager: { mode1: false, mode2: false, note: SALON_AWAITS_REVIEW },
      cashier: { mode1: false, mode2: false, note: SALON_AWAITS_REVIEW },
      worker: { mode1: false, mode2: false, note: SALON_AWAITS_REVIEW },
      customer: { mode1: false, mode2: false, note: SALON_CUSTOMER },
    },
    manager: {
      cashier: { mode1: false, mode2: false, note: SALON_AWAITS_REVIEW },
      worker: { mode1: false, mode2: false, note: SALON_AWAITS_REVIEW },
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
})

// ---------------------------------------------------------------------------
// Speed dating — ranks admin 3 > organizer 2 > host 1 > participant 0.
// Six rank-differential pairs. Every incoming pair to `participant` is OFF,
// which is how §8.1 point 7's `viewAs: none` end-user ban is expressed under
// the amendment — point 11 subsumes the flag as a special case rather than
// keeping a second mechanism.
// ---------------------------------------------------------------------------
const SD_PARTICIPANT_BAN =
  'OFF permanently, not pending review — this is §8.1 point 7\'s end-user impersonation ban ' +
  'expressed as pairs. sd_interest is a one-sided secret whose RLS deliberately gives the ' +
  'rated person no read path at all, so rejection is indistinguishable from indecision; ' +
  'sd_matches hides an unrevealed match from both parties until the organizer reveals it; ' +
  'sd_notes is author-only with no staff arm anywhere. A participant tab would either be ' +
  'empty of everything that matters or would put a third party\'s one-sided secret on a ' +
  'staff screen. Changing this needs a dated founder decision, not a build-time judgement.'

const SD_AWAITS_REVIEW =
  'OFF pending speed-dating\'s own view-as surface security review (docs/15 §8.1 point 9). ' +
  'Staff-to-staff and plausible — but note a host deliberately CANNOT read sd_interest or ' +
  'sd_matches (20260709050000: "matching data is sensitive; host\'s domain is lobby/reports"), ' +
  'so an organizer tab rendered for a host must respect an exclusion the organizer\'s own ' +
  'ambient reach does not impose. That is exactly the kind of thing a surface review settles.'

export const speedDatingViewAs = declareViewAs({
  positions: { admin: 3, organizer: 2, host: 1, participant: 0 },
  edges: {
    admin: {
      organizer: { mode1: false, mode2: false, note: SD_AWAITS_REVIEW },
      host: { mode1: false, mode2: false, note: SD_AWAITS_REVIEW },
      participant: { mode1: false, mode2: false, note: SD_PARTICIPANT_BAN },
    },
    organizer: {
      host: { mode1: false, mode2: false, note: SD_AWAITS_REVIEW },
      participant: { mode1: false, mode2: false, note: SD_PARTICIPANT_BAN },
    },
    host: {
      participant: { mode1: false, mode2: false, note: SD_PARTICIPANT_BAN },
    },
  },
  scopeEntity: { table: 'sd_events', idColumn: 'id', nodeColumn: 'scope_node_id' },
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
