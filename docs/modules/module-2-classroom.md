# Module 2: Classroom (key: `classroom`, prefix `cls_`)

## Problem & context

Online classroom replacing the founder's mature Google Sheets/Drive/Apps Script solution. Multiple classes: some entirely different material, some the same material with a different cohort/term.

## Course vs. Class (decided 2026-07-06)

- **Course** = reusable material: lectures, homework specs, videos, survey templates.
- **Class** = an instance: term, roster, GA assignment, calendar, gradebook, announcements, peer-review matrices. Materials are *published into* a class with instance-specific dates; "same material, new semester" = new class from course, schedule shifts to new term dates.

## Roles

- **Student** — sees Lectures, Homework, Class Videos, Grades (own only), Peer Review, Announcements, Survey.
- **GA (graduate assistant)** — sees everything students see but cannot submit homework; personalized instruction documents (with their name); grading queues; grade submission.
- **Professor/Instructor** — many classes; uploads everything; roster management; moves homework through workflow states; controls the master gradebook and all visibility.

## Content areas

- **Lectures:** downloadable folders including lecture code.
- **Class Videos:** watch-only streaming, not downloadable. v1 = embed existing Google Drive view-only Zoom recordings exactly as the founder stores them today (zero migration). Upgrade path if Drive chafes: Mux/Cloudflare Stream with signed URLs. (True download-prevention is DRM-grade and out of scope; signed streaming stops all but determined engineers.)
- **Homework:** PDF spec per homework; students upload completed work — actual files (zip or multi-file: everything needed to run) — and may re-upload until the deadline. Supported/rendered types: `.R`, `.py`, `.js`, `.html`, Jupyter `.ipynb` (cells + outputs). This **replaces** the old copy-code-into-a-Google-Doc step entirely.
- **Grades:** each student sees only their own view of the gradebook, and only what's flipped visible.
- **Announcements:** long-running per-class document, professor posts/edits.
- **Survey:** students answer privately; per-question results optionally visible to the class; students see new/unanswered indicators.
- **Peer Review:** see below.

## Visibility windows & retention (decided 2026-07-06)

- Every shared item carries optional `visible_from` / `visible_until`.
- **Hide vs purge:** default is hidden-from-students but retained for the professor (grade disputes, integrity cases); optional true-delete per item type. Example policy: homework submissions hide 2 weeks after semester end (so they aren't shared with next cohort).
- Per-class defaults with per-item overrides. Enforced by the `retention.sweep` cron job.

## Homework workflow

State machine per (student, homework): submitted → GA grading → peer review, moved by the professor. State + role drive what every folder view shows (GA's "homeworks to grade" tree: homework# → student → files).

## Peer review (decided 2026-07-06)

- Each student reviews **3** peers per homework (count professor-configurable), spread evenly across all homeworks all semester; never self; minimize repeat pairings; balance reviews-received.
- Professor sees the full assignment matrix (per homework + cumulative), can regenerate or hand-edit before locking a round (`classroom.peer-review-assign` job).
- Anonymous **both directions** for students.
- Reviewers leave **line-anchored comments** on rendered code (GitHub-PR style) and submit a peer grade.
- Professor dashboard: GA grade vs peer grade(s) side-by-side per submission with discrepancy highlighting — a check on GA grading quality.

## Gradebook (decided 2026-07-06)

Structured (not a spreadsheet clone). Per assignment/exam, columns: **GA**, **Peer** (avg of the 3), **Instructor**, **Combination** (per-assignment formula, e.g. `0.2*peer + 0.8*GA`), **Override** (e.g., zero for cheating). **Final** = per-assignment pointer to whichever column counts. Students see Final only, and only once that assignment is made visible. Every cell keeps provenance (audit trail).

## Exams

Taken on paper; instructor uploads scans; GAs grade in-app at whole / per-problem / per-subproblem granularity (structure set by instructor per exam); grades flow into the gradebook. Students never submit exams online.

## Roster (decided 2026-07-06)

Registrar live-updates a Google Group (emails only). `classroom.roster-sync` job reads the group via Google API, reconciles (adds new, flags drops). On first login each student enters preferred first/last name — preserves the "called by the name they like" benefit of the current Sheets flow.

## Primitives used

Files/storage (owner), workflow state machines (owner), visibility windows (owner), Google connector (owner), gradebook, code rendering + line comments, surveys, notifications, email.

## Future enhancements

Managed video streaming; general Sheets data importer; in-app exam-taking (explicitly not planned, just not foreclosed).

## Retention sweep built (2026-07-09) + open question

The `classroom.retention-sweep` worker job runs daily (04:00): publications
with `retention='purge'` whose window has closed are deleted, and the
underlying file is removed from storage once no other publication references
the material — the material's library row stays in the course so the professor
retains the record. 'hide' needs no sweep (RLS already hides expired
publications from students while the professor keeps access). Verified live:
expired-purge file deleted, still-referenced file survived.

**OPEN QUESTION (founder = the module 2 client):** the spec's example policy
— "homework submissions hide 2 weeks after semester end" — needs a
semester-end date, which `cls_classes` doesn't carry, plus a decision on
hide-vs-purge for submission files. When you want this: (1) does a class get
an `ends_on` date, (2) should swept submissions be hidden (recoverable) or
purged (files deleted), (3) per-class override or one org-wide default?

## Submission retention decided (founder, 2026-07-09)

Answers to the open question above:
- **Never deleted** unless explicitly requested — no purge path for submissions.
- After the class's retention window, submissions are **hidden from students AND
  GAs** (professor/org-admin retain access).
- The professor may **manually re-reveal one item at a time**, each reveal with
  its own expiration.
- Policy is **per class**.

**Built (2026-07-09, `20260709080000_classroom_submission_retention.sql`) —
this section was stale until 2026-07-12, describing a "next slice" that had
already shipped:** `cls_classes.submissions_hidden_from` (date) and
`cls_submissions.visible_override_until` (timestamptz) exist; visibility is
an RLS-time computation (`cls_submissions`/`cls_submission_files`/
`storage.objects` select policies), never a destructive sweep — matching
"never deleted" exactly. UI: the professor sets the per-class hide date from
Manage (`setSubmissionsHiddenFrom`, `modules/classroom/ui/manage/page.tsx`)
and re-reveals one submission at a time with its own expiration from the
grading console (`setRevealUntil`, `modules/classroom/ui/manage/grading/
[homeworkId]/actions.ts`, columns pinned to professor-only via
`cls_pin_submission_columns`). Verified live 8/8 at the time.

**Grades-export decision (founder, 2026-07-09):** the authorship rule stands with
no exception — students cannot export grades about them (professor/GA-entered).

## GA grade visibility (founder, 2026-07-12; built 2026-07-12, UI 2026-07-16)

Founder rule from the testing round: **"a GA must not see any grade — or any
calculated grade — they did not enter themselves."** Previously the
`cls_grades_select` policy gave any GA (`cls_is_ga`) a blanket read on every
grade row in the org: other GAs' grades, instructor grades, peer aggregates,
computed combinations, published finals. (The per-reviewer peer matrix in
`cls_review_assignments` was already GA-invisible.)

Migration `20260712020000_classroom_ga_grade_visibility.sql`:
- `cls_grades.graded_by` (who entered the row) + `cls_pin_grade_author`
  trigger: a GA's insert is stamped `graded_by = auth.uid()`; non-staff can
  never reassign authorship on update.
- `cls_grades_select` rewritten: a GA reads ONLY `source='ga' AND
  graded_by = auth.uid()`. Professors/org-admins (`cls_can_manage`) keep full
  visibility — the combination/finalize/publish logic runs as the professor
  and is unaffected. Students unchanged (own final+visible row only).
- `cls_grades_write_ga` tightened to rows attributed to the caller.

Live-verified 5/5 as real users (GA sees none of the professor's rows, sees
exactly their own insert, cannot spoof authorship).

UI (2026-07-16): the Manage console's gate — which an earlier commit had
narrowed to `cls_can_manage`, accidentally locking GAs out entirely — is now
staff-OR-GA, with every create/config form (courses, classes, homework,
exams, surveys, announcements, retention, Materials link) wrapped in
professor-only `canManage`. The grading console hides the **Peer reviews**
and **Final** columns and all workflow buttons from non-professors, matching
what RLS returns. GA walkthrough guide updated to say "you see only the
grades you entered yourself." e2e: GA reaches Manage + grading with no
professor controls or peer/final columns visible.

## Future enhancement: course/class ownership transfer (2026-07-16, not built)

Founder asked whether transferring ownership of a course/class to another
professor would be hard to add later — same question asked about Visual
Messaging's conversation admin (see that module's spec for the fuller
answer; the shape is identical here). Not architecturally hard: professor
status could be a per-class role transfer (offer + accept, not silent
reassignment) once `cls_class_members`'s per-class role is actually wired
into authorization (see the 2026-07-16 professor-scoping discussion below —
this enhancement is naturally sequenced after that work, not before it,
since there's no per-class "ownership" to transfer until scoping exists).
Parked as a future enhancement, not scoped further.

## Professor role scoping — real finding + founder's parallel (2026-07-16, still OPEN, don't build)

Founder asked whether "professor" should scope to the specific courses they
teach rather than being able to edit every course in the org, after
observing this firsthand in testing. Confirmed by reading the code: today
`cls_can_manage` checks only the org-wide `module_roles` grant — a professor
really can edit every course in the org, with no course-level restriction.

**Real, useful architectural finding**: the schema already has a per-class
role column (`cls_class_members.role`, holding student/ga/professor scoped
to ONE class) that was apparently designed with this scoping in mind, but
`cls_can_manage` never actually consults it — the two systems (org-wide
grant vs. per-class role) are completely disconnected today. This also
explains a separate founder-reported bug: a user's per-class role BADGE
(shown on the Classes list) reads from this same disconnected table, so
granting someone "professor" via the org-wide module role never updated
what badge they saw.

**Founder's own parallel, confirmed accurate**: Visual Messaging already
proves this exact pattern works — a conversation's admin is a role stored
PER CONVERSATION (`vm_conversation_members.role`), not an org-wide grant.
Classroom's per-class role column is structurally the same shape, just never
wired up. This means building real per-course professor scoping is applying
an already-proven pattern to a table that already has the right shape, not
inventing something new — meaningfully lower risk than starting from
scratch, though still real RLS/authorization work (`cls_can_manage` would
need to become course-aware) needing an Opus session if pursued. Not
decided; not built.

## View-as: positions, edges, and surfaces (user-model slice 5 — BUILT 2026-07-31)

Classroom is the first module with view-as turned on (docs/15 §8, §8.1). Its
ladder is `professor` (2, Entity Lead) over `ga` (1) and `student` (1) — **GA
and student are peers, not a hierarchy** (docs/15 §5) — so exactly two ordered
pairs carry a rank gap and therefore need an explicit on/off answer.

**professor → GA: ON, both modes.** Already settled in docs/15 §8. A GA's
surface is duty output (the grading queue, the grades they entered) and the
professor reads all of it inside their scope, so neither mode widens anything.
Mode 2 earns its keep here: `cls_grades` is narrowed to `source='ga' AND
graded_by = <the GA>` (the 20260712020000 rule), which the professor's own
ambient query never shows separated out — "what has Gabe actually graded?" is
answerable only through the tab.

**professor → student: ON, both modes — the pair docs/15 §8.1 point 11 left
explicitly undecided, now consciously answered.** A student's role surface is
almost entirely the professor's own duty output reflected back: publication
windows, announcements, homework, published grades. "What does my student
actually see?" is the most common classroom support question and the reason §8
sketched a Student tab at all. Nothing widens — every declared table is already
professor-readable in scope. Rather than closing the pair wholesale, the
genuinely sensitive parts are kept off the surface:

- `cls_survey_answers` — **excluded**. Entered as oneself, and the module
  already exposes the staff signal as counts via `cls_survey_results`.
- `cls_review_comments` — **excluded**. The raw row carries `author_id`;
  reviewer anonymity is enforced only by the app routing the reviewee through
  `cls_comments_for_my_submission`, which strips it. Rendering the table would
  deanonymize peer reviewers to whoever holds the tab.
- `cls_review_assignments` — included but **`submission_id` omitted**: that is
  the reviewer→reviewee direction, and it is not needed to show a student their
  own assignment list.
- `cls_grades` — filtered to `is_final AND visible`, byte-for-byte the
  student's own RLS arm. Draft and instructor-source cells stay invisible.
- Submission **retention hiding is reproduced** in the renderer. The professor
  is exempt from `cls_submission_hidden`; without reproducing it, a professor
  debugging "why can't Charlie see his old submission?" would see the row and
  conclude nothing was wrong.

**A finding worth recording: classroom has NO personal layer in the strict
sense.** docs/15 §8.1 point 1 defines "personal" as RLS-*unreadable* to higher
positions and calls a personal marking on a staff-readable table a spec
violation. Classroom has no `sd_notes` analogue — a professor reads every
`cls_*` table inside their scope. So the two exclusions above are recorded as
`excluded` (product decision over ambiently-readable data), not `personal`, and
the RLS suite asserts both halves: personal entries must be unreadable,
excluded entries must be readable. If a future migration made survey answers
staff-unreadable, the entry should be reclassified — the test is what forces
that question.

**FOUNDER CONFIRMATION WANTED** on professor → student. The spec deliberately
left it open so it would get a real answer at build time rather than being
assumed; this is that answer, and flipping either mode is a one-line change to
`classroomViewAs` in `packages/platform/src/view-as-modules.ts` plus the
matching arm of `module_view_as_edge()`.

### Peer-review anonymity — who it protects against (founder, 2026-08-02)

Correcting the view-as entry above, which had this wrong on first pass.
**Peer review is anonymous from other STUDENTS and from the GA. It is not
anonymous from the professor**, who runs the process. So in the professor's
view-as-a-student surface, `cls_review_comments` is shown WITH `author_id`, and
`cls_review_assignments` keeps `submission_id` (which submission this student is
reviewing). Both are deliberately more than the student themselves sees — the
student's own path goes through `cls_comments_for_my_submission`, which strips
the author. The earlier draft excluded both; that was wrong about *who* the
anonymity protects against, not about the mechanism.

**Resolved same day, founder 2026-08-02 — the asymmetry is INTENDED, not a bug.**
Reading the policies raised what looked like a contradiction: `cls_review_comments_select`
carries a `cls_is_ga_class` arm (`20260724010000:588-595`), so a GA reads every review
comment in scope including `author_id`, while `cls_review_assignments_select` has never had
a GA arm at all. Founder: **that is correct.** A GA sees the peer-review *substance* (the
comment text, and who wrote it) but not the peer *marks* — the grade lives on
`cls_review_assignments`, which they cannot read, and `cls_grades` shows a GA only their own
`source='ga'` cells. So "anonymous from the GA" means anonymous in the *grading* sense, not
a blanket bar. No change needed; recorded so a future reader does not "fix" it.

### Students must see comments on their own homework, but never peer grades (founder, 2026-08-02)

**The rule.** A student sees the *comments* written on their own submission.
A student never sees the *grades* their peers gave them.

**Current state: the rule is already enforced in the database; the student-facing
page is simply missing.** Found while confirming slice 5's surfaces.

| | Today | Matches the rule? |
|---|---|---|
| Comments on their own submission | RLS **allows** it — `cls_review_comments_select` carries a `cls_owns_submission(submission_id)` arm (`20260724010000:588-595`). `cls_comments_for_my_submission()` exists to serve exactly this, author-stripped. **But nothing calls it and no page renders it**, so in practice the student sees nothing. | Policy yes, **UI no — the gap** |
| Peer grades given *to* them | RLS **refuses** it — `cls_review_assignments_select` is `cls_can_manage_class OR reviewer_id = auth.uid()`, so a reviewee cannot read the row their grade lives on. | **Yes, already correct** |
| Grades they gave *as* a reviewer | Visible (their own `reviewer_id` rows). | Yes |

So this is a **UI-only build**: a section on the student's homework page calling
`cls_comments_for_my_submission(submission_id)`, which returns
`id, file_path, line_start, line_end, body, created_at` and deliberately omits
`author_id`. No migration, no policy change, and **no grant work either**: the
2026-07-29 ACL sweep listed this among its three provably-dead functions but
still re-granted EXECUTE to `authenticated`
(`20260728010000_acl_hardening.sql:80`), so it is callable today. The definer
was written for this page and has been sitting unused since `20260708010000`.

**Sequencing note:** peer review is arguably incomplete without this — the
feature produces feedback nobody receives. Worth pairing with any next classroom
pass. Sonnet-tier work: one page section, one RPC call, one e2e test, plus the
one-line grant restore.

**Built (2026-08-03).** No migration, no grant change — `cls_comments_for_my_submission`
already carried the correct `s.student_id = auth.uid()` filter and the ACL sweep had
already left its `authenticated` grant in place (`20260728010000_acl_hardening.sql:80`);
this was a pure UI gap. `modules/classroom/ui/homework/[homeworkId]/page.tsx` now calls
the RPC whenever a submission exists and renders a "Peer review comments" section
(file path + line range + body, no author) below the submission uploader. Extended the
existing grading-workflow e2e (`apps/web/e2e/platform.spec.ts:319`) rather than adding a
new test: after Charlie's review comment ("Nice work!") lands on Dana's submission and
Dana's grades are checked, the test now also opens Dana's homework page and asserts the
comment is visible with no "Charlie" text anywhere on the page. One locator wrinkle: Dana
has her own peer-review assignment linking to the same homework title (a different href),
so the click had to scope by `a[href*="/classroom/homework/"]` rather than link text alone
— the same ambiguity the original Charlie-side test had already worked around for the
review-route link. Verified: `pnpm typecheck` 9/9, the extended test in isolation, and a
full clean `db:reset` → seed → e2e suite run — 37/37 passed, including the two previously-flaky
speed-dating tests (docs/build-plan's open flake items are about test *ordering* sensitivity,
not this change) — all via Playwright driving a real browser against the real local stack
(no manual click-through session was done this pass).
