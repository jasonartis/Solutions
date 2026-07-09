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
