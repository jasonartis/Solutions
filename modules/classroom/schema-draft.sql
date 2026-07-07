-- Module 2: Classroom (prefix cls_). Spec: docs/modules/module-2-classroom.md
-- DRAFT for review — becomes supabase/migrations/<ts>_classroom.sql at
-- integration time. Patterns copied from 20260707030000_synagogue_schedules.sql:
-- explicit grants (CLI migrations do NOT inherit API-role grants), RLS on every
-- table, security-definer helpers, DO-loop for uniform policies.
--
-- Relies on platform objects that already exist:
--   public.is_superadmin(), public.is_org_member(), public.set_updated_at()  (core migration)
--   public.has_module_role(org, module_key, role)                            (module 3 migration)
--
-- Org-level module config (per-class retention defaults, Google Group id for
-- roster-sync, default reviews-per-student) lives in org_modules.settings for
-- module_key 'classroom' — no ad-hoc config table.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Course = reusable material container (lectures, homework specs, videos).
create table public.cls_courses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Class = an instance of a course: term, roster, calendar, gradebook.
-- "Same material, new semester" = new class row pointing at the same course.
create table public.cls_classes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  course_id uuid not null references public.cls_courses (id) on delete cascade,
  name text not null,
  term text,
  timezone text not null default 'America/New_York',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Roster. role is the per-class role; kept up to date by the
-- classroom.roster-sync job (Google Group reconcile). Students set their
-- preferred names on first login via cls_set_preferred_name() below.
create table public.cls_class_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  class_id uuid not null references public.cls_classes (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('student', 'ga', 'professor')),
  preferred_first_name text,
  preferred_last_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (class_id, user_id)
);

-- Reusable material owned by a course. Exactly one of storage_path (uploaded
-- file/folder in the cls-materials bucket) or url (e.g. Drive view-only video
-- embed) is normally set; both nullable so a title-only placeholder is legal.
create table public.cls_materials (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  course_id uuid not null references public.cls_courses (id) on delete cascade,
  kind text not null check (kind in ('lecture', 'homework_spec', 'video', 'document')),
  title text not null,
  storage_path text,
  url text,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Publishing a material into a class, with the instance-specific visibility
-- window (spec: every shared item carries optional visible_from/visible_until).
-- retention: 'hide' = hidden from students after the window but retained for
-- the professor; 'purge' = true-delete, executed by the retention.sweep cron.
create table public.cls_publications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  class_id uuid not null references public.cls_classes (id) on delete cascade,
  material_id uuid not null references public.cls_materials (id) on delete cascade,
  visible_from timestamptz,
  visible_until timestamptz,
  retention text not null default 'hide' check (retention in ('hide', 'purge')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (class_id, material_id)
);

create table public.cls_homeworks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  class_id uuid not null references public.cls_classes (id) on delete cascade,
  title text not null,
  spec_material_id uuid references public.cls_materials (id) on delete set null,
  due_at timestamptz,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per (homework, student). The workflow state machine from the spec:
-- submitted → ga_grading → peer_review → done, moved by the professor.
-- Files live under storage_prefix in the cls-submissions bucket; students may
-- re-upload until the deadline (enforced in the policies below).
create table public.cls_submissions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  homework_id uuid not null references public.cls_homeworks (id) on delete cascade,
  class_id uuid not null references public.cls_classes (id) on delete cascade,
  student_id uuid not null references auth.users (id) on delete cascade,
  state text not null default 'submitted'
    check (state in ('submitted', 'ga_grading', 'peer_review', 'done')),
  submitted_at timestamptz not null default now(),
  storage_prefix text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (homework_id, student_id)
);

create table public.cls_submission_files (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  submission_id uuid not null references public.cls_submissions (id) on delete cascade,
  class_id uuid not null references public.cls_classes (id) on delete cascade,
  file_name text not null,
  storage_path text not null,
  size_bytes bigint,
  created_at timestamptz not null default now()
);

-- Exams are taken on paper; structure jsonb describes problems/subproblems
-- (grading granularity), set by the instructor, Zod-validated in the module.
create table public.cls_exams (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  class_id uuid not null references public.cls_classes (id) on delete cascade,
  title text not null,
  structure jsonb not null default '[]'::jsonb,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Instructor-uploaded scans (possibly several files per student per exam).
create table public.cls_exam_papers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  exam_id uuid not null references public.cls_exams (id) on delete cascade,
  class_id uuid not null references public.cls_classes (id) on delete cascade,
  student_id uuid not null references auth.users (id) on delete cascade,
  storage_path text not null,
  created_at timestamptz not null default now()
);

-- Peer-review matrix rows, generated by the classroom.peer-review-assign job
-- (assignPeerReviews in src/peer-review.ts), professor-editable until locked.
-- grade = the reviewer's peer grade for this submission; the gradebook 'peer'
-- row is the aggregate (avg) computed when the round closes.
create table public.cls_review_assignments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  homework_id uuid not null references public.cls_homeworks (id) on delete cascade,
  class_id uuid not null references public.cls_classes (id) on delete cascade,
  reviewer_id uuid not null references auth.users (id) on delete cascade,
  submission_id uuid not null references public.cls_submissions (id) on delete cascade,
  locked boolean not null default false,
  grade numeric,
  grade_submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (homework_id, reviewer_id, submission_id)
);

-- Line-anchored comments on rendered code (GitHub-PR style). line_start/line_end
-- null = a whole-file comment. Anonymous both directions for students: the UI
-- never shows author_id, and the student-facing read goes through a definer
-- function/view that strips author_id at integration time (see policy note).
create table public.cls_review_comments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  submission_id uuid not null references public.cls_submissions (id) on delete cascade,
  class_id uuid not null references public.cls_classes (id) on delete cascade,
  author_id uuid not null references auth.users (id) on delete cascade,
  file_path text not null,
  line_start integer,
  line_end integer,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Structured gradebook (spec: per assignment/exam columns GA / Peer /
-- Instructor / Combination / Override; Final = the row flagged is_final).
-- Exactly one of homework_id/exam_id per row. detail holds per-problem
-- breakdowns (exam grading) and provenance (audit trail).
create table public.cls_grades (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  class_id uuid not null references public.cls_classes (id) on delete cascade,
  homework_id uuid references public.cls_homeworks (id) on delete cascade,
  exam_id uuid references public.cls_exams (id) on delete cascade,
  student_id uuid not null references auth.users (id) on delete cascade,
  source text not null check (source in ('ga', 'peer', 'instructor', 'combination', 'override')),
  score numeric,
  detail jsonb not null default '{}'::jsonb,
  is_final boolean not null default false,
  visible boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cls_grades_one_target check ((homework_id is null) <> (exam_id is null))
);

-- Unique per (class, homework-or-exam, student, source). Plain UNIQUE can't
-- span the two nullable target columns, so a coalesced expression index
-- (homework/exam ids are uuids — no cross-collision).
create unique index cls_grades_target_unique
  on public.cls_grades (class_id, student_id, source, coalesce(homework_id, exam_id));

-- Long-running per-class announcements document: professor posts/edits entries.
create table public.cls_announcements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  class_id uuid not null references public.cls_classes (id) on delete cascade,
  author_id uuid references auth.users (id) on delete set null,
  body text not null,
  posted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Surveys: students answer privately; per-question results optionally visible
-- to the class (aggregated through a definer function at integration time —
-- raw answers stay owner-or-staff-only).
create table public.cls_surveys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  class_id uuid not null references public.cls_classes (id) on delete cascade,
  question text not null,
  results_visible boolean not null default false,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.cls_survey_answers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  survey_id uuid not null references public.cls_surveys (id) on delete cascade,
  class_id uuid not null references public.cls_classes (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  answer text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (survey_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Indexes (FK lookups on the hot paths)
-- ---------------------------------------------------------------------------

create index cls_classes_course_idx on public.cls_classes (course_id);
create index cls_class_members_class_idx on public.cls_class_members (class_id);
create index cls_class_members_user_idx on public.cls_class_members (user_id);
create index cls_materials_course_idx on public.cls_materials (course_id);
create index cls_publications_class_idx on public.cls_publications (class_id);
create index cls_publications_material_idx on public.cls_publications (material_id);
create index cls_homeworks_class_idx on public.cls_homeworks (class_id);
create index cls_submissions_homework_idx on public.cls_submissions (homework_id);
create index cls_submissions_student_idx on public.cls_submissions (student_id);
create index cls_submission_files_submission_idx on public.cls_submission_files (submission_id);
create index cls_exams_class_idx on public.cls_exams (class_id);
create index cls_exam_papers_exam_idx on public.cls_exam_papers (exam_id);
create index cls_review_assignments_homework_idx on public.cls_review_assignments (homework_id);
create index cls_review_assignments_reviewer_idx on public.cls_review_assignments (reviewer_id);
create index cls_review_assignments_submission_idx on public.cls_review_assignments (submission_id);
create index cls_review_comments_submission_idx on public.cls_review_comments (submission_id);
create index cls_grades_class_student_idx on public.cls_grades (class_id, student_id);
create index cls_announcements_class_idx on public.cls_announcements (class_id);
create index cls_surveys_class_idx on public.cls_surveys (class_id);
create index cls_survey_answers_survey_idx on public.cls_survey_answers (survey_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers (tables whose rows get edited)
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'cls_courses','cls_classes','cls_class_members','cls_materials',
    'cls_publications','cls_homeworks','cls_submissions','cls_exams',
    'cls_review_assignments','cls_review_comments','cls_grades',
    'cls_announcements','cls_surveys','cls_survey_answers']
  loop
    execute format(
      'create trigger %I_updated_at before update on public.%I
         for each row execute function public.set_updated_at();',
      t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Grants first (migrations do not inherit defaults — see core migration note).
-- RLS below restricts rows; the service_role (worker) bypasses RLS for jobs
-- (roster-sync, peer-review-assign, retention.sweep, peer-grade aggregation).
-- ---------------------------------------------------------------------------

grant select, insert, update, delete
  on public.cls_courses, public.cls_classes, public.cls_class_members,
     public.cls_materials, public.cls_publications, public.cls_homeworks,
     public.cls_submissions, public.cls_submission_files, public.cls_exams,
     public.cls_exam_papers, public.cls_review_assignments,
     public.cls_review_comments, public.cls_grades, public.cls_announcements,
     public.cls_surveys, public.cls_survey_answers
  to authenticated, service_role;

alter table public.cls_courses enable row level security;
alter table public.cls_classes enable row level security;
alter table public.cls_class_members enable row level security;
alter table public.cls_materials enable row level security;
alter table public.cls_publications enable row level security;
alter table public.cls_homeworks enable row level security;
alter table public.cls_submissions enable row level security;
alter table public.cls_submission_files enable row level security;
alter table public.cls_exams enable row level security;
alter table public.cls_exam_papers enable row level security;
alter table public.cls_review_assignments enable row level security;
alter table public.cls_review_comments enable row level security;
alter table public.cls_grades enable row level security;
alter table public.cls_announcements enable row level security;
alter table public.cls_surveys enable row level security;
alter table public.cls_survey_answers enable row level security;

-- ---------------------------------------------------------------------------
-- Role helpers (security definer: they read tables the caller may not).
-- ---------------------------------------------------------------------------

-- Staff = superadmin, module-role professor, or org owner/admin.
create function public.cls_can_manage(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_superadmin()
      or public.has_module_role(check_org_id, 'classroom', 'professor')
      or exists (
           select 1 from public.org_members
           where org_id = check_org_id
             and user_id = auth.uid()
             and role in ('owner', 'admin')
         );
$$;

create function public.cls_is_ga(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_module_role(check_org_id, 'classroom', 'ga');
$$;

-- Class-scoped read gate. Definer avoids RLS recursion on cls_class_members.
-- NOTE: class-scoped, not org-scoped — students of class A must not see
-- class B, even inside the same org.
create function public.cls_is_class_member(check_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.cls_class_members
    where class_id = check_class_id
      and user_id = auth.uid()
  );
$$;

-- The caller owns this submission.
create function public.cls_owns_submission(check_submission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.cls_submissions
    where id = check_submission_id
      and student_id = auth.uid()
  );
$$;

-- The caller is an assigned peer reviewer of this submission.
create function public.cls_reviews_submission(check_submission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.cls_review_assignments
    where submission_id = check_submission_id
      and reviewer_id = auth.uid()
  );
$$;

-- The caller owns this submission, it is still in 'submitted', and the
-- homework deadline has not passed — the window in which students may
-- add/replace/remove files (spec: re-upload until the deadline).
create function public.cls_submission_open(check_submission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.cls_submissions s
    join public.cls_homeworks h on h.id = s.homework_id
    where s.id = check_submission_id
      and s.student_id = auth.uid()
      and s.state = 'submitted'
      and (h.due_at is null or now() <= h.due_at)
  );
$$;

-- First-login self-service: set your own preferred names on your roster row.
-- Definer function instead of an UPDATE policy so students cannot touch any
-- other column (RLS is row-level; this needs column-level control).
create function public.cls_set_preferred_name(
  check_class_id uuid,
  first_name text,
  last_name text
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.cls_class_members
  set preferred_first_name = first_name,
      preferred_last_name = last_name,
      updated_at = now()
  where class_id = check_class_id
    and user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------

-- Uniform staff-write: professors (and org owners/admins/superadmin) have full
-- control of every module table. Student/GA carve-outs are added explicitly
-- per table below.
do $$
declare t text;
begin
  foreach t in array array[
    'cls_courses','cls_classes','cls_class_members','cls_materials',
    'cls_publications','cls_homeworks','cls_submissions','cls_submission_files',
    'cls_exams','cls_exam_papers','cls_review_assignments','cls_review_comments',
    'cls_grades','cls_announcements','cls_surveys','cls_survey_answers']
  loop
    execute format(
      'create policy %I_write_staff on public.%I for all
         using (public.cls_can_manage(org_id))
         with check (public.cls_can_manage(org_id));',
      t, t);
  end loop;
end $$;

-- Uniform class-member read for tables every member of the class may see.
-- (Deliberately NOT included: submissions/files/comments/assignments/grades/
-- answers/papers — those have per-row visibility below.)
do $$
declare t text;
begin
  foreach t in array array[
    'cls_class_members','cls_publications','cls_homeworks','cls_exams',
    'cls_announcements','cls_surveys']
  loop
    execute format(
      'create policy %I_select_member on public.%I for select
         using (public.cls_is_class_member(class_id)
                or public.cls_can_manage(org_id)
                or public.cls_is_ga(org_id));',
      t, t);
  end loop;
end $$;

-- cls_classes: same member read, but the class row IS the class (id, not class_id).
create policy cls_classes_select_member on public.cls_classes
  for select using (
    public.cls_is_class_member(id)
    or public.cls_can_manage(org_id)
    or public.cls_is_ga(org_id)
  );

-- cls_courses: staff/GA only. Students never need the course container —
-- they reach content through cls_publications → cls_materials.
create policy cls_courses_select_staff on public.cls_courses
  for select using (
    public.cls_can_manage(org_id) or public.cls_is_ga(org_id)
  );

-- cls_materials: staff/GA see all; a student sees a material only while it is
-- published into one of their classes with the visibility window open — the
-- hide/purge retention rule is thereby enforced at the RLS layer, not just UI.
create policy cls_materials_select on public.cls_materials
  for select using (
    public.cls_can_manage(org_id)
    or public.cls_is_ga(org_id)
    or exists (
         select 1 from public.cls_publications p
         where p.material_id = cls_materials.id
           and public.cls_is_class_member(p.class_id)
           and (p.visible_from is null or p.visible_from <= now())
           and (p.visible_until is null or now() < p.visible_until)
       )
  );

-- cls_submissions: staff/GA see all; students see their own; assigned peer
-- reviewers see the submissions they review (reviewee identity is hidden by
-- the UI/definer layer — the row itself must be readable to render the code).
create policy cls_submissions_select on public.cls_submissions
  for select using (
    public.cls_can_manage(org_id)
    or public.cls_is_ga(org_id)
    or student_id = auth.uid()
    or public.cls_reviews_submission(id)
  );

-- Students create their own submission row (one per homework — unique
-- constraint) while the deadline is open, and only in a class they belong to.
create policy cls_submissions_insert_own on public.cls_submissions
  for insert with check (
    student_id = auth.uid()
    and public.cls_is_class_member(class_id)
    and state = 'submitted'
    and exists (
          select 1 from public.cls_homeworks h
          where h.id = homework_id
            and h.class_id = cls_submissions.class_id
            and (h.due_at is null or now() <= h.due_at)
        )
  );

-- Re-upload until the deadline: students may touch their row only while it is
-- still 'submitted' (once the professor moves it to ga_grading it is frozen),
-- and cannot move it to any other state themselves (with check pins state).
create policy cls_submissions_update_own on public.cls_submissions
  for update using (
    student_id = auth.uid() and state = 'submitted'
  )
  with check (
    student_id = auth.uid()
    and state = 'submitted'
    and exists (
          select 1 from public.cls_homeworks h
          where h.id = homework_id
            and (h.due_at is null or now() <= h.due_at)
        )
  );

-- cls_submission_files: visibility mirrors the parent submission; students
-- may add/remove files only while their submission is open (deadline+state).
create policy cls_submission_files_select on public.cls_submission_files
  for select using (
    public.cls_can_manage(org_id)
    or public.cls_is_ga(org_id)
    or public.cls_owns_submission(submission_id)
    or public.cls_reviews_submission(submission_id)
  );

create policy cls_submission_files_insert_own on public.cls_submission_files
  for insert with check (public.cls_submission_open(submission_id));

create policy cls_submission_files_delete_own on public.cls_submission_files
  for delete using (public.cls_submission_open(submission_id));

-- cls_review_assignments: staff see the full matrix; a reviewer sees only
-- their own rows. NO class-member read — anonymity is both directions, so a
-- student must never learn who reviews them.
create policy cls_review_assignments_select on public.cls_review_assignments
  for select using (
    public.cls_can_manage(org_id) or reviewer_id = auth.uid()
  );

-- Reviewer submits/edits their peer grade while the round is unlocked.
-- INTEGRATION NOTE: RLS is row-level — this also permits editing other
-- columns of the row; pin homework_id/submission_id/reviewer_id/locked with a
-- BEFORE UPDATE trigger (or route writes through a definer function) at
-- integration time.
create policy cls_review_assignments_update_reviewer on public.cls_review_assignments
  for update using (reviewer_id = auth.uid() and locked = false)
  with check (reviewer_id = auth.uid() and locked = false);

-- cls_review_comments: staff/GA see all; authors see their own; the reviewed
-- student sees comments on their submission. INTEGRATION NOTE: rows carry
-- author_id, so the student-facing API must read via a definer function/view
-- that strips author_id to preserve reviewer anonymity — never select * to a
-- student client.
create policy cls_review_comments_select on public.cls_review_comments
  for select using (
    public.cls_can_manage(org_id)
    or public.cls_is_ga(org_id)
    or author_id = auth.uid()
    or public.cls_owns_submission(submission_id)
  );

-- Authors write their own comments; students only on submissions they were
-- assigned to review, GAs on anything in their org (grading feedback).
create policy cls_review_comments_insert_own on public.cls_review_comments
  for insert with check (
    author_id = auth.uid()
    and (public.cls_reviews_submission(submission_id) or public.cls_is_ga(org_id))
  );

create policy cls_review_comments_update_own on public.cls_review_comments
  for update using (author_id = auth.uid())
  with check (author_id = auth.uid());

create policy cls_review_comments_delete_own on public.cls_review_comments
  for delete using (author_id = auth.uid());

-- cls_grades: staff and GAs see every cell; a student sees ONLY their own
-- Final rows that have been flipped visible (spec: students see Final only,
-- and only once the assignment is made visible).
create policy cls_grades_select on public.cls_grades
  for select using (
    public.cls_can_manage(org_id)
    or public.cls_is_ga(org_id)
    or (student_id = auth.uid() and is_final and visible)
  );

-- GAs write only the GA column; everything else (peer aggregate, instructor,
-- combination, override, final/visible flags) is professor- or worker-written.
create policy cls_grades_write_ga on public.cls_grades
  for all using (public.cls_is_ga(org_id) and source = 'ga')
  with check (public.cls_is_ga(org_id) and source = 'ga');

-- cls_exam_papers: staff/GA (grading) plus the student's own scan.
create policy cls_exam_papers_select on public.cls_exam_papers
  for select using (
    public.cls_can_manage(org_id)
    or public.cls_is_ga(org_id)
    or student_id = auth.uid()
  );

-- cls_survey_answers: answers are private — owner and staff only. Class-wide
-- results (when cls_surveys.results_visible) are exposed as aggregates via a
-- definer function at integration time, never as raw rows.
create policy cls_survey_answers_select on public.cls_survey_answers
  for select using (
    public.cls_can_manage(org_id) or user_id = auth.uid()
  );

create policy cls_survey_answers_insert_own on public.cls_survey_answers
  for insert with check (
    user_id = auth.uid() and public.cls_is_class_member(class_id)
  );

create policy cls_survey_answers_update_own on public.cls_survey_answers
  for update using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Storage buckets (created at integration time alongside this migration):
--   cls-materials    — course content; worker/professor writes, reads follow
--                      cls_materials visibility via signed URLs
--   cls-submissions  — objects under <org_id>/<class_id>/<submission_id>/…
--   cls-exams        — instructor-uploaded scans
-- Bucket policies follow the syn-exports pattern (org-scoped foldername read);
-- kept out of this draft because storage.objects policies are shared platform
-- state, reviewed with the integration migration.
-- ---------------------------------------------------------------------------
