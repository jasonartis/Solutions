// Per-module data-browser declarations (docs/13, founder decision 2026-08-02).
//
// EVERY module declares one, for the same reason every module declares view-as:
// a check is only a check if nothing can opt out. Unlike view-as, though, the
// authority here is NOT anything written in TypeScript — it is the DATABASE
// CATALOG. `packages/db/src/data-browser-coverage.test.ts` reads every column
// in `public` that references `auth.users` / `profiles` and fails if any one of
// them is missing from a declaration below. A migration that adds a
// person-referencing column therefore breaks the test suite until someone
// decides what the browser should do with it.
//
// WHAT COUNTS AS A PERSON REFERENCE — read broadly, deliberately. A column
// saying the person DID something (`graded_by`, `created_by`, `invited_by`,
// `voided_by`) counts exactly as much as one saying a row is ABOUT them
// (`student_id`, `about_user_id`). Both are things the platform holds that name
// them, and "what do you hold about me?" does not distinguish. This is why the
// `omitted` lists below are nearly empty — almost nothing failed to qualify.
//
// INDIRECT LINKS ARE THE INTERESTING PART. Nine tables name a person only
// through a child row, and several of them (`sd_interest`, `sd_matches`,
// `sd_reports`, peer-review comments on your own submission) hold the most
// privacy-loaded rows on the platform while carrying NO person column at all. A
// catalog scan cannot find them, so each is a conscious `via` declaration here.
//
// WHERE THE LINE ON INDIRECT LINKS SITS. The coverage test's second tier lists
// every FK that reaches a person one hop away; the ones left undeclared are
// reported by that test on every run (don't trust a count written here — read
// the test output, which is the live number). The rule separating them from
// the ones declared below is: does the row
// say something ABOUT the person, or does it merely share a container with
// them? A flag on their layer, a comment on their submission, a line item on
// their bill, a report naming their participant row — all say something about
// them, and are declared. `sd_interest.event_id`, `vm_layers.conversation_id`
// and the rest only mean "this row and that person are in the same event or
// conversation", which is true of every row in it and answers nothing.
// Reactions and replies to a person's layer sit closest to the line and are
// deliberately OUT: ambient engagement, high volume, low signal — where a
// safety flag is none of those three.

import { declareDataBrowser, type DataBrowserDeclaration } from './data-browser'

// ---------------------------------------------------------------------------
// Platform core — the tables that belong to no module. Always queried.
// ---------------------------------------------------------------------------
export const platformDataBrowser = declareDataBrowser({
  lookups: [
    {
      table: 'profiles',
      label: 'Identity',
      personColumns: ['user_id'],
      // The one table on the platform with no org_id: identity is global, and a
      // person exists before and outside any org. Bounded by RLS alone
      // (own row / shares_org_with / superadmin).
      orgColumn: null,
      limit: 1,
    },
    {
      table: 'org_members',
      label: 'Org memberships and invitations',
      personColumns: ['user_id', 'invited_by'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
    },
    {
      table: 'module_roles',
      label: 'Module positions granted',
      personColumns: ['user_id', 'granted_by'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
    },
    {
      table: 'job_requests',
      label: 'Background jobs they requested',
      personColumns: ['requested_by'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      limit: 50,
      note:
        'Operational queue state rather than domain data — included because a job request ' +
        'still records that this person asked the platform to do something, and when.',
    },
    {
      table: 'view_as_sessions',
      label: 'View-as sessions naming them',
      personColumns: ['actor_user_id', 'target_user_id'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      limit: 100,
      note:
        'Activity ABOUT the person, not data they entered: rows where they were viewed, and ' +
        'rows where they did the viewing. Note what is NOT here — the Owner Console\'s ' +
        'superadmin view-as is unlogged by founder decision, so it leaves no row to find.',
    },
  ],
  omitted: [],
  neverReadable: [],
})

// ---------------------------------------------------------------------------
// Classroom
// ---------------------------------------------------------------------------
export const classroomDataBrowser = declareDataBrowser({
  lookups: [
    {
      table: 'cls_class_members',
      label: 'Class enrolments',
      personColumns: ['user_id'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
    },
    {
      table: 'cls_submissions',
      label: 'Homework submissions',
      personColumns: ['student_id'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      note:
        'Retention hiding is NOT reproduced here, unlike view-as. This tool answers what the ' +
        'VIEWER holds, and a professor is exempt from the retention cutoff — reproducing it ' +
        'would under-report on purpose, which is the opposite of the question.',
    },
    {
      table: 'cls_submission_files',
      label: 'Files attached to their submissions',
      // No person column at all — every link is through the submission.
      personColumns: [],
      via: [
        {
          column: 'submission_id',
          lookupTable: 'cls_submissions',
          lookupIdColumn: 'id',
          lookupPersonColumns: ['student_id'],
        },
      ],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      note: 'Row metadata only — the file itself lives in storage and is not fetched.',
    },
    {
      table: 'cls_grades',
      label: 'Grades',
      personColumns: ['student_id', 'graded_by'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      note:
        'Both directions: grades awarded TO them and grades they entered as a grader. ' +
        'Unfiltered by is_final/visible — a student\'s own view is narrower, but this is ' +
        'what the VIEWER holds, which is the question this tool answers.',
    },
    {
      table: 'cls_exam_papers',
      label: 'Exam scans',
      personColumns: ['student_id'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
    },
    {
      table: 'cls_review_assignments',
      label: 'Peer reviews (as reviewer, and of their work)',
      personColumns: ['reviewer_id'],
      via: [
        {
          column: 'submission_id',
          lookupTable: 'cls_submissions',
          lookupIdColumn: 'id',
          lookupPersonColumns: ['student_id'],
        },
      ],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      note:
        'The via path is what makes this honest: a row where this person is the REVIEWEE ' +
        'names them nowhere — only their submission does. View-as deliberately shows the ' +
        'reviewer direction only; this tool is not view-as and shows both.',
    },
    {
      table: 'cls_review_comments',
      label: 'Peer-review comments (theirs, and on their work)',
      personColumns: ['author_id'],
      via: [
        {
          column: 'submission_id',
          lookupTable: 'cls_submissions',
          lookupIdColumn: 'id',
          lookupPersonColumns: ['student_id'],
        },
      ],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      note:
        'Includes author_id. Peer-review anonymity runs from other STUDENTS and from the GA, ' +
        'never from the professor (founder, 2026-08-02) — and RLS is the ceiling here either ' +
        'way, so a viewer who may not read the row gets nothing.',
    },
    {
      table: 'cls_survey_answers',
      label: 'Survey answers',
      personColumns: ['user_id'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      note:
        'Deliberately present, and the clearest illustration of how this tool differs from ' +
        'view-as: the student surface EXCLUDES these on purpose, because view-as asks what ' +
        'the student sees. This asks what the viewer holds, and a professor already reads ' +
        'them in scope.',
    },
    {
      table: 'cls_announcements',
      label: 'Announcements they posted',
      personColumns: ['author_id'],
      orgColumn: 'org_id',
      orderBy: { column: 'posted_at', ascending: false },
      limit: 50,
    },
  ],
  omitted: [],
  neverReadable: [],
})

// ---------------------------------------------------------------------------
// Matchmaking
// ---------------------------------------------------------------------------
export const matchmakingDataBrowser = declareDataBrowser({
  lookups: [
    {
      table: 'mm_answers',
      label: 'Answers given',
      personColumns: ['user_id'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      note:
        'Raw answers. The read gate is NARROWER than staff rank: mm_answers_select is ' +
        '`user_id = auth.uid() OR mm_matchmaker_can_see(org_id, user_id)`, and that helper ' +
        'requires a matching mm_matchmaker_assignments row for THIS single — there is no ' +
        'mm_can_manage arm on this table at all. So an org admin with no assignment gets ' +
        'nothing here, and an empty section does NOT mean the single has answered nothing. ' +
        '(An earlier version of this note claimed the opposite; corrected 2026-08-03 after ' +
        'review checked it against the policy.)',
    },
    {
      table: 'mm_group_members',
      label: 'Group memberships',
      personColumns: ['user_id'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
    },
    {
      table: 'mm_interests',
      label: 'Interest expressed, and interest in them',
      personColumns: ['user_id', 'target_user_id'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      note:
        'One-sided and invisible to matchmakers by policy (admin oversight only), and never ' +
        'visible to the target. RLS enforces that here unchanged — a matchmaker running this ' +
        'browser gets nothing back from this table.',
    },
    {
      table: 'mm_matchmaker_assignments',
      label: 'Matchmaker assignments',
      personColumns: ['matchmaker_id', 'target_user_id'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
    },
    {
      table: 'mm_pair_scores',
      label: 'Pair scores involving them',
      personColumns: ['user_a', 'user_b'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      limit: 200,
      note: 'Canonical order (user_a < user_b), so both columns must be matched to find a person.',
    },
    {
      table: 'mm_questions',
      label: 'Questions they submitted or approved',
      personColumns: ['submitted_by', 'approved_by'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
    },
  ],
  omitted: [],
  neverReadable: [],
})

// ---------------------------------------------------------------------------
// Nail salon
// ---------------------------------------------------------------------------
export const nailSalonDataBrowser = declareDataBrowser({
  lookups: [
    {
      table: 'sal_customers',
      label: 'Customer record',
      personColumns: ['user_id'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      note:
        'KNOWN GAP: user_id is nullable, and most salon customers are walk-ins identified only ' +
        'by free-text name/phone/email with no platform account. This browser keys on a user ' +
        'account, so those people cannot be looked up at all — they are invisible to it, not ' +
        'merely empty. Matching on the text columns was considered and left out of v1 because ' +
        'fuzzy identity matching can attach one person\'s records to another.',
    },
    {
      table: 'sal_worker_profiles',
      label: 'Worker profile',
      personColumns: ['user_id'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
    },
    {
      table: 'sal_worker_time_off',
      label: 'Time off',
      personColumns: [],
      via: [
        {
          column: 'worker_profile_id',
          lookupTable: 'sal_worker_profiles',
          lookupIdColumn: 'id',
          lookupPersonColumns: ['user_id'],
        },
      ],
      orgColumn: 'org_id',
      orderBy: { column: 'starts_at', ascending: false },
    },
    {
      table: 'sal_appointments',
      label: 'Appointments (as worker, booker, or customer)',
      personColumns: ['worker_id', 'booked_by'],
      via: [
        {
          column: 'customer_id',
          lookupTable: 'sal_customers',
          lookupIdColumn: 'id',
          lookupPersonColumns: ['user_id'],
        },
      ],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      limit: 200,
    },
    {
      table: 'sal_bills',
      label: 'Bills they handled',
      // All four name STAFF, not the customer: `paid_by` is stamped
      // `auth.uid()` by the trigger on the transition to paid, so it is
      // whoever rang it up at the till.
      personColumns: ['created_by', 'paid_by', 'voided_by', 'refunded_by'],
      via: [
        {
          // THE CUSTOMER PATH, and it takes two hops because sal_bills has no
          // customer column at all. Found by adversarial review: without this,
          // looking up a paying customer WITH an account showed their
          // appointments and zero bills — which reads as "we hold no billing
          // record for you", not as a broken link. Distinct from the walk-in
          // gap noted on sal_customers: that one is about people with no
          // account, this one hit people who have one.
          column: 'appointment_id',
          lookupTable: 'sal_appointments',
          lookupIdColumn: 'id',
          lookupPersonColumns: ['worker_id', 'booked_by'],
          then: {
            column: 'customer_id',
            lookupTable: 'sal_customers',
            lookupIdColumn: 'id',
            lookupPersonColumns: ['user_id'],
          },
        },
      ],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      limit: 200,
      note:
        'Both sides of a bill: the staff who created, took, voided or refunded it, and — through ' +
        'the appointment — the customer it was for.',
    },
    {
      table: 'sal_bill_items',
      label: 'What was on their bills',
      // No person column — the line items of a bill they paid or handled.
      personColumns: [],
      via: [
        {
          column: 'bill_id',
          lookupTable: 'sal_bills',
          lookupIdColumn: 'id',
          lookupPersonColumns: ['created_by', 'paid_by', 'voided_by', 'refunded_by'],
          // Three hops to the customer, for the same reason sal_bills needs
          // two — this is the deepest real path on the platform.
          then: {
            column: 'appointment_id',
            lookupTable: 'sal_appointments',
            lookupIdColumn: 'id',
            lookupPersonColumns: ['worker_id', 'booked_by'],
            then: {
              column: 'customer_id',
              lookupTable: 'sal_customers',
              lookupIdColumn: 'id',
              lookupPersonColumns: ['user_id'],
            },
          },
        },
      ],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      limit: 200,
      note:
        'Declared because the bill header alone answers "they paid $80" while the line items ' +
        'answer what they actually bought — which is the substance of what we hold.',
    },
    {
      table: 'sal_earnings_ledger',
      label: 'Earnings ledger',
      personColumns: ['worker_id'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      limit: 200,
      note: 'Append-only, trigger-fed — no user write path exists at all.',
    },
    {
      table: 'sal_expenses',
      label: 'Expenses they recorded',
      personColumns: ['created_by'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
    },
    {
      table: 'sal_promotions',
      label: 'Promotions they created',
      personColumns: ['created_by'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
    },
    {
      table: 'sal_shopping_list',
      label: 'Shopping-list entries they added',
      personColumns: ['created_by'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
    },
  ],
  omitted: [],
  neverReadable: [],
})

// ---------------------------------------------------------------------------
// Speed dating — the module where the indirect links carry the sensitive rows.
// ---------------------------------------------------------------------------
export const speedDatingDataBrowser = declareDataBrowser({
  lookups: [
    {
      table: 'sd_participants',
      label: 'Event registrations',
      personColumns: ['user_id'],
      via: [
        {
          column: 'mentee_participant_id',
          lookupTable: 'sd_participants',
          lookupIdColumn: 'id',
          lookupPersonColumns: ['user_id'],
        },
      ],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      note: 'The via path finds rows where this person is someone else\'s mentee.',
    },
    {
      table: 'sd_events',
      label: 'Events they created',
      personColumns: ['created_by'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
    },
    {
      table: 'sd_pairings',
      label: 'Round pairings',
      personColumns: [],
      via: [
        {
          column: 'participant_a_id',
          lookupTable: 'sd_participants',
          lookupIdColumn: 'id',
          lookupPersonColumns: ['user_id'],
        },
        {
          column: 'participant_b_id',
          lookupTable: 'sd_participants',
          lookupIdColumn: 'id',
          lookupPersonColumns: ['user_id'],
        },
      ],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      limit: 200,
      note: 'Room metadata only — calls are never recorded (product promise).',
    },
    {
      table: 'sd_interest',
      label: 'Interest marks involving them',
      personColumns: [],
      via: [
        {
          column: 'rater_participant_id',
          lookupTable: 'sd_participants',
          lookupIdColumn: 'id',
          lookupPersonColumns: ['user_id'],
        },
        {
          column: 'target_participant_id',
          lookupTable: 'sd_participants',
          lookupIdColumn: 'id',
          lookupPersonColumns: ['user_id'],
        },
      ],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      limit: 200,
      note:
        'A one-sided secret: the rated person has no read path ever, and a HOST cannot read ' +
        'this table either (matching data is the organizer\'s domain). RLS enforces both here ' +
        'unchanged — a host running this browser gets nothing back. Listed because the rows ' +
        'exist and an organizer legitimately holds them.',
    },
    {
      table: 'sd_matches',
      label: 'Matches involving them',
      personColumns: [],
      via: [
        {
          column: 'participant_a_id',
          lookupTable: 'sd_participants',
          lookupIdColumn: 'id',
          lookupPersonColumns: ['user_id'],
        },
        {
          column: 'participant_b_id',
          lookupTable: 'sd_participants',
          lookupIdColumn: 'id',
          lookupPersonColumns: ['user_id'],
        },
      ],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      note: 'Unrevealed matches are hidden from both parties by RLS; staff see them.',
    },
    {
      table: 'sd_reports',
      label: 'Safety reports involving them',
      personColumns: ['reviewed_by'],
      via: [
        {
          column: 'reporter_participant_id',
          lookupTable: 'sd_participants',
          lookupIdColumn: 'id',
          lookupPersonColumns: ['user_id'],
        },
        {
          column: 'reported_participant_id',
          lookupTable: 'sd_participants',
          lookupIdColumn: 'id',
          lookupPersonColumns: ['user_id'],
        },
      ],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      note: 'All three roles: who reported, who was reported, who reviewed it.',
    },
    {
      table: 'sd_blocks',
      label: 'Blocks',
      personColumns: ['blocker_user_id', 'blocked_user_id'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      note: 'The blocked person never sees the block; manage-tier reads it for safety review.',
    },
    {
      table: 'sd_bans',
      label: 'Bans',
      personColumns: ['banned_user_id', 'banned_by'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      note: 'Org-scoped, not platform-wide.',
    },
  ],
  omitted: [],
  neverReadable: [
    {
      table: 'sd_notes',
      columns: ['author_user_id', 'about_user_id'],
      why:
        'The strictest table on the platform: sd_notes_all_own is `author_user_id = auth.uid()` ' +
        'with NO staff arm anywhere — not organizer, not org owner, not the platform ' +
        'superadmin. Declared rather than silently returning nothing, because "we hold ' +
        'nothing" and "we hold notes nobody but their author may read" are different answers ' +
        'and this tool exists to give the true one. Making it readable would need a ' +
        'service-role read path, which breaks the keystone; the Supabase dashboard exists for ' +
        'that. Test-asserted: a superadmin really does get zero rows.',
    },
  ],
})

// ---------------------------------------------------------------------------
// Visual messaging
// ---------------------------------------------------------------------------
export const visualMessagingDataBrowser = declareDataBrowser({
  lookups: [
    {
      table: 'vm_conversation_members',
      label: 'Conversation memberships',
      personColumns: ['user_id', 'invited_by'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      note: 'A banned member keeps their row (it is what blocks re-joining), so bans show here.',
    },
    {
      table: 'vm_conversations',
      label: 'Conversations they started',
      personColumns: ['created_by'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
    },
    {
      table: 'vm_layers',
      label: 'Layers they drew, and layers they tombstoned',
      personColumns: ['author_id', 'tombstoned_by'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      limit: 200,
      note: 'A tombstoned layer keeps its row and slot; the content is blanked.',
    },
    {
      table: 'vm_reactions',
      label: 'Reactions',
      personColumns: ['user_id'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      limit: 200,
    },
    {
      table: 'vm_flags',
      label: 'Flags they raised or reviewed',
      personColumns: ['reporter_user_id', 'reviewed_by'],
      via: [
        {
          column: 'layer_id',
          lookupTable: 'vm_layers',
          lookupIdColumn: 'id',
          lookupPersonColumns: ['author_id'],
        },
      ],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      note:
        'All three roles: who raised the flag, who reviewed it, and — through the via path — ' +
        'whose layer was flagged. That third one is the reason the via exists: a flag names the ' +
        'LAYER, not its author, so without it "has anyone reported this person?" would answer ' +
        'no for someone with ten flags against them. A flagged author still cannot read their ' +
        'own flag (RLS is unchanged); a moderator running this browser can, which is the point.',
    },
    {
      table: 'vm_moderation_log',
      label: 'Moderation actions',
      personColumns: ['actor_user_id'],
      via: [
        {
          column: 'layer_id',
          lookupTable: 'vm_layers',
          lookupIdColumn: 'id',
          lookupPersonColumns: ['author_id'],
        },
      ],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
      limit: 100,
      note:
        'Both directions: moderation they performed, and moderation performed on their layers ' +
        '(the via path — the log names the layer, not its author). Append-only, and its FKs ' +
        'are `on delete set null` so the log outlives what it describes; a row whose layer has ' +
        'since been deleted therefore drops OUT of the via path, which is a real limit of ' +
        'this lookup, not a bug. Moderator-tier read only: `detail` can hold a tombstoned ' +
        'layer\'s original content.',
    },
  ],
  omitted: [],
  neverReadable: [],
})

// ---------------------------------------------------------------------------
// Sample module — the living template.
// ---------------------------------------------------------------------------
export const sampleDataBrowser = declareDataBrowser({
  lookups: [
    {
      table: 'smp_items',
      label: 'Items they authored',
      personColumns: ['author_id'],
      orgColumn: 'org_id',
      orderBy: { column: 'created_at', ascending: false },
    },
  ],
  omitted: [],
  neverReadable: [],
})

// ---------------------------------------------------------------------------
// Modules whose schema names no person at all. Declared empty rather than
// omitted, so the registry stays total and a future person column in either
// module fails the catalog test until someone declares it.
// ---------------------------------------------------------------------------
const EMPTY: DataBrowserDeclaration = declareDataBrowser({
  lookups: [],
  omitted: [],
  neverReadable: [],
})

export const synagogueSchedulesDataBrowser = EMPTY
export const stubDataBrowser = EMPTY

/** Every module declaration, for the platform-wide completeness assertions. */
export const dataBrowserDeclarations: Record<string, DataBrowserDeclaration> = {
  classroom: classroomDataBrowser,
  'nail-salon': nailSalonDataBrowser,
  'speed-dating': speedDatingDataBrowser,
  matchmaking: matchmakingDataBrowser,
  'synagogue-schedules': synagogueSchedulesDataBrowser,
  'visual-messaging': visualMessagingDataBrowser,
  sample: sampleDataBrowser,
  stub: stubDataBrowser,
}
