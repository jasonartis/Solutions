-- ---------------------------------------------------------------------------
-- Integration-review additions (2026-07-07 security review of the draft):
-- scope-sync triggers derive org_id/class_id from the parent chain so
-- client-supplied values can never misfile a row into another org/class,
-- and immutability triggers pin structural columns on student-writable rows.
-- ---------------------------------------------------------------------------

-- Derive class_id/org_id from the parent homework.
create function public.cls_sync_from_homework()
returns trigger
language plpgsql
as $$
begin
  select h.class_id, h.org_id into new.class_id, new.org_id
  from public.cls_homeworks h where h.id = new.homework_id;
  if new.class_id is null then
    raise exception 'Unknown homework %', new.homework_id;
  end if;
  return new;
end;
$$;

-- Derive class_id/org_id from the parent submission.
create function public.cls_sync_from_submission()
returns trigger
language plpgsql
as $$
begin
  select s.class_id, s.org_id into new.class_id, new.org_id
  from public.cls_submissions s where s.id = new.submission_id;
  if new.class_id is null then
    raise exception 'Unknown submission %', new.submission_id;
  end if;
  return new;
end;
$$;

-- Derive org_id from the class (tables that carry class_id directly).
create function public.cls_sync_from_class()
returns trigger
language plpgsql
as $$
begin
  select c.org_id into new.org_id
  from public.cls_classes c where c.id = new.class_id;
  if new.org_id is null then
    raise exception 'Unknown class %', new.class_id;
  end if;
  return new;
end;
$$;

-- Derive org_id from the course.
create function public.cls_sync_from_course()
returns trigger
language plpgsql
as $$
begin
  select c.org_id into new.org_id
  from public.cls_courses c where c.id = new.course_id;
  if new.org_id is null then
    raise exception 'Unknown course %', new.course_id;
  end if;
  return new;
end;
$$;

-- Derive class_id/org_id from the parent exam.
create function public.cls_sync_from_exam()
returns trigger
language plpgsql
as $$
begin
  select e.class_id, e.org_id into new.class_id, new.org_id
  from public.cls_exams e where e.id = new.exam_id;
  if new.class_id is null then
    raise exception 'Unknown exam %', new.exam_id;
  end if;
  return new;
end;
$$;

create trigger cls_classes_scope before insert or update on public.cls_classes
  for each row execute function public.cls_sync_from_course();
create trigger cls_materials_scope before insert or update on public.cls_materials
  for each row execute function public.cls_sync_from_course();
create trigger cls_publications_scope before insert or update on public.cls_publications
  for each row execute function public.cls_sync_from_class();
create trigger cls_class_members_scope before insert or update on public.cls_class_members
  for each row execute function public.cls_sync_from_class();
create trigger cls_homeworks_scope before insert or update on public.cls_homeworks
  for each row execute function public.cls_sync_from_class();
create trigger cls_exams_scope before insert or update on public.cls_exams
  for each row execute function public.cls_sync_from_class();
create trigger cls_announcements_scope before insert or update on public.cls_announcements
  for each row execute function public.cls_sync_from_class();
create trigger cls_surveys_scope before insert or update on public.cls_surveys
  for each row execute function public.cls_sync_from_class();
create trigger cls_grades_scope before insert or update on public.cls_grades
  for each row execute function public.cls_sync_from_class();
create trigger cls_survey_answers_scope before insert or update on public.cls_survey_answers
  for each row execute function public.cls_sync_from_class();
create trigger cls_submissions_scope before insert or update on public.cls_submissions
  for each row execute function public.cls_sync_from_homework();
create trigger cls_review_assignments_scope before insert or update on public.cls_review_assignments
  for each row execute function public.cls_sync_from_homework();
create trigger cls_submission_files_scope before insert or update on public.cls_submission_files
  for each row execute function public.cls_sync_from_submission();
create trigger cls_review_comments_scope before insert or update on public.cls_review_comments
  for each row execute function public.cls_sync_from_submission();
create trigger cls_exam_papers_scope before insert or update on public.cls_exam_papers
  for each row execute function public.cls_sync_from_exam();

-- Immutability: non-staff may not re-point a submission at a different
-- homework/student (review finding: the update policy alone allowed it).
create function public.cls_pin_submission_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.cls_can_manage(old.org_id) then
    new.homework_id := old.homework_id;
    new.student_id := old.student_id;
  end if;
  return new;
end;
$$;

create trigger cls_submissions_pin before update on public.cls_submissions
  for each row execute function public.cls_pin_submission_columns();

-- Immutability: a reviewer may only change grade/grade_submitted_at on their
-- assignment row (agent's integration note, implemented).
create function public.cls_pin_assignment_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.cls_can_manage(old.org_id) then
    new.homework_id := old.homework_id;
    new.reviewer_id := old.reviewer_id;
    new.submission_id := old.submission_id;
    new.locked := old.locked;
  end if;
  return new;
end;
$$;

create trigger cls_review_assignments_pin before update on public.cls_review_assignments
  for each row execute function public.cls_pin_assignment_columns();

-- Reviewer anonymity (agent's integration note, implemented): the student-facing
-- read path for comments on THEIR submission strips author identity.
create function public.cls_comments_for_my_submission(check_submission_id uuid)
returns table (id uuid, file_path text, line_start integer, line_end integer, body text, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.file_path, c.line_start, c.line_end, c.body, c.created_at
  from public.cls_review_comments c
  join public.cls_submissions s on s.id = c.submission_id
  where c.submission_id = check_submission_id
    and s.student_id = auth.uid()
  order by c.file_path, c.line_start nulls first, c.created_at;
$$;

grant execute on function public.cls_comments_for_my_submission(uuid) to authenticated;

-- Survey aggregates (agent's integration note, implemented): class members see
-- counts per answer when the professor flips results_visible — never raw rows.
create function public.cls_survey_results(check_survey_id uuid)
returns table (answer text, votes bigint)
language sql
stable
security definer
set search_path = public
as $$
  select a.answer, count(*)::bigint as votes
  from public.cls_survey_answers a
  join public.cls_surveys s on s.id = a.survey_id
  where a.survey_id = check_survey_id
    and s.results_visible
    and (public.cls_is_class_member(s.class_id) or public.cls_can_manage(s.org_id))
  group by a.answer
  order by votes desc, a.answer;
$$;

grant execute on function public.cls_survey_results(uuid) to authenticated;

-- Storage: submissions bucket (uploads at integration are server-action mediated;
-- students read/write only within their own open submission's prefix
-- <org_id>/<class_id>/<submission_id>/...).
insert into storage.buckets (id, name, public)
values ('cls-submissions', 'cls-submissions', false)
on conflict (id) do nothing;

create policy cls_submissions_storage_read on storage.objects
  for select using (
    bucket_id = 'cls-submissions'
    and (
      public.cls_can_manage(((storage.foldername(name))[1])::uuid)
      or public.cls_is_ga(((storage.foldername(name))[1])::uuid)
      or public.cls_owns_submission(((storage.foldername(name))[3])::uuid)
      or public.cls_reviews_submission(((storage.foldername(name))[3])::uuid)
    )
  );

create policy cls_submissions_storage_write on storage.objects
  for insert with check (
    bucket_id = 'cls-submissions'
    and public.cls_submission_open(((storage.foldername(name))[3])::uuid)
  );

create policy cls_submissions_storage_delete on storage.objects
  for delete using (
    bucket_id = 'cls-submissions'
    and public.cls_submission_open(((storage.foldername(name))[3])::uuid)
  );

-- Materials + exam scans buckets: staff-written (server actions), member-read
-- via the same org-scoped prefix convention.
insert into storage.buckets (id, name, public)
values ('cls-materials', 'cls-materials', false), ('cls-exams', 'cls-exams', false)
on conflict (id) do nothing;

create policy cls_materials_storage_read on storage.objects
  for select using (
    bucket_id = 'cls-materials'
    and public.is_org_member(((storage.foldername(name))[1])::uuid)
  );

create policy cls_exams_storage_read on storage.objects
  for select using (
    bucket_id = 'cls-exams'
    and (
      public.cls_can_manage(((storage.foldername(name))[1])::uuid)
      or public.cls_is_ga(((storage.foldername(name))[1])::uuid)
    )
  );
