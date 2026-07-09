-- Submission retention (founder decisions, 2026-07-09 — module 2 spec):
-- never deleted; after a per-class date, submissions are hidden from students
-- AND GAs (professor/org-admin retain access); the professor may re-reveal a
-- single submission with its own expiration. Nothing is destructive: hiding is
-- an RLS-time computation over dates, so it is reversible by definition.

alter table public.cls_classes add column submissions_hidden_from date;
alter table public.cls_submissions add column visible_override_until timestamptz;

-- Hidden = the class's hide date has arrived AND no per-item reveal is open.
-- NOTE on docs/03 #15 (self-referential lookups vs INSERT..RETURNING): this
-- function does query cls_submissions itself, but its failure mode is safe —
-- for a row invisible to the statement snapshot it returns FALSE ("not
-- hidden"), which PASSES the policy, so a student's own INSERT..RETURNING
-- still works. A helper whose TRUE grants access must never be written this way.
create function public.cls_submission_hidden(check_submission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.cls_submissions s
    join public.cls_classes c on c.id = s.class_id
    where s.id = check_submission_id
      and c.submissions_hidden_from is not null
      and now() >= c.submissions_hidden_from
      and (s.visible_override_until is null or now() > s.visible_override_until)
  );
$$;

-- Table read: professor/org-admin always; GA, the owning student, and peer
-- reviewers only while not hidden.
drop policy cls_submissions_select on public.cls_submissions;
create policy cls_submissions_select on public.cls_submissions
  for select using (
    public.cls_can_manage(org_id)
    or (
      (public.cls_is_ga(org_id) or student_id = auth.uid() or public.cls_reviews_submission(id))
      and not public.cls_submission_hidden(id)
    )
  );

-- Files mirror the parent submission's visibility.
drop policy cls_submission_files_select on public.cls_submission_files;
create policy cls_submission_files_select on public.cls_submission_files
  for select using (
    public.cls_can_manage(org_id)
    or (
      (
        public.cls_is_ga(org_id)
        or public.cls_owns_submission(submission_id)
        or public.cls_reviews_submission(submission_id)
      )
      and not public.cls_submission_hidden(submission_id)
    )
  );

-- Storage downloads mirror it too — hiding that leaves the files fetchable
-- by path would be UI-deep only, which docs/03 forbids.
drop policy cls_submissions_storage_read on storage.objects;
create policy cls_submissions_storage_read on storage.objects
  for select using (
    bucket_id = 'cls-submissions'
    and (
      public.cls_can_manage(((storage.foldername(name))[1])::uuid)
      or (
        (
          public.cls_is_ga(((storage.foldername(name))[1])::uuid)
          or public.cls_owns_submission(((storage.foldername(name))[3])::uuid)
          or public.cls_reviews_submission(((storage.foldername(name))[3])::uuid)
        )
        and not public.cls_submission_hidden(((storage.foldername(name))[3])::uuid)
      )
    )
  );

-- The per-item reveal is professor-set only: pin it for non-staff (extends the
-- existing immutability trigger, which already pins homework_id/student_id).
create or replace function public.cls_pin_submission_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.cls_can_manage(old.org_id) then
    new.homework_id := old.homework_id;
    new.student_id := old.student_id;
    new.visible_override_until := old.visible_override_until;
  end if;
  return new;
end;
$$;
