# Module: Classroom (key: `classroom`, prefix `cls_`)

**The specification lives at [docs/modules/module-2-classroom.md](../../docs/modules/module-2-classroom.md)** — every client decision is recorded there, dated. This file only records choices made while drafting the scaffold.

> Status: DRAFT scaffold for review (2026-07-07). `schema-draft.sql` is not yet a
> migration; the manifest is not yet registered in `packages/platform/src/modules.ts`.

## Build-time notes (schema draft decisions)

- **Peer grades live on `cls_review_assignments.grade`** (one per reviewer × submission), not as individual `cls_grades` rows. The gradebook's `peer` row is the aggregate (avg of the 3), computed by the worker when a round closes — keeps `cls_grades` unique per (class, target, student, source).
- **`cls_grades` targets exactly one of homework/exam**: check constraint `(homework_id is null) <> (exam_id is null)` plus a coalesced unique index `(class_id, student_id, source, coalesce(homework_id, exam_id))`, since a plain UNIQUE can't span two nullable columns.
- **Visibility windows are enforced in RLS, not just UI**: a student can select a `cls_materials` row only while a `cls_publications` row into one of their classes has its window open. One publication per (class, material) — republishing = editing the window.
- **Students never see `cls_courses` rows** — they reach content via publications → materials; the course container is staff/GA-only.
- **Column-level student writes go through definer functions**: `cls_set_preferred_name()` (roster self-service) now; peer-grade submission and review-comment reads need the same treatment at integration (RLS is row-level, and `cls_review_comments.author_id` must be stripped for reviewer anonymity — flagged inline in the draft).
- **Deadline + workflow freeze in RLS**: students may insert/update submissions and files only via `cls_submission_open()` (own row, state still `submitted`, `due_at` not passed); the professor moving state to `ga_grading` freezes the submission without extra code.

## Ambiguities resolved in the draft (revisit at integration)

- `cls_exam_papers` has **no** unique (exam, student) — a scan may span multiple files/uploads.
- Announcements modeled as **rows in a per-class stream** (`posted_at`, editable) rather than one big document — matches "professor posts/edits" and gives per-item timestamps.
- GAs can read everything class-scoped (grading queues span classes they assist) via the org-wide module role `ga`; per-class GA assignment is also representable in `cls_class_members.role = 'ga'` for roster/UI purposes.
- Publication rows themselves are member-readable (they contain only ids/dates); only the material content is window-gated.
