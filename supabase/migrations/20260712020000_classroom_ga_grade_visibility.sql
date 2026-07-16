-- Item 1 (founder, 2026-07-12): "The GA should not see any grades or any
-- calculated grades they themselves did not enter." Previously
-- cls_grades_select granted every GA (`cls_is_ga`) a blanket read on EVERY
-- cls_grades row in the org — so a GA saw other GAs' grades, the professor's
-- instructor grades, the peer aggregate, the computed combination, and the
-- published final. (The per-reviewer peer matrix in cls_review_assignments is
-- already GA-invisible — its select policy is `cls_can_manage OR
-- reviewer_id = auth.uid()`, no `cls_is_ga` — so the leak was cls_grades only.)
--
-- Fix: cls_grades gains `graded_by` (who entered the row). A GA may now read
-- ONLY source='ga' rows they personally entered. Professors/org-admins
-- (cls_can_manage) keep full visibility, so the combination/finalize/publish
-- logic — which runs as the professor — is completely unaffected. Students are
-- unchanged (own final+visible row only).
--
-- No change to the one-ga-row-per-submission model: the grading model has each
-- GA grade a DISTINCT submission and the professor's combination reads a single
-- source='ga' score per student. `graded_by` is attribution + a visibility key,
-- not a widening of the unique index.

alter table public.cls_grades
  add column graded_by uuid references auth.users (id) on delete set null;

-- Attribution + immutability. On INSERT, a source='ga' row with no explicit
-- author is stamped with the caller (auth.uid()) — so a GA's own grade is
-- always attributed to them, and the RLS WITH CHECK below (evaluated AFTER
-- this BEFORE-trigger) then confirms graded_by = auth.uid(). On UPDATE, a
-- non-staff caller can never reassign authorship (pinned to the old value);
-- staff may correct it. Order-independent: the INSERT branch never reads
-- org_id (so it doesn't matter that the scope trigger runs later), and the
-- UPDATE branch reads old.org_id, which is already the stored real value.
create function public.cls_pin_grade_author()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.source = 'ga' and new.graded_by is null then
      new.graded_by := auth.uid();
    end if;
  elsif not public.cls_can_manage(old.org_id) then
    new.graded_by := old.graded_by;
  end if;
  return new;
end;
$$;

create trigger cls_grades_pin_author before insert or update on public.cls_grades
  for each row execute function public.cls_pin_grade_author();

-- Rewrite the SELECT policy: a GA sees only their own GA-entered rows.
drop policy cls_grades_select on public.cls_grades;
create policy cls_grades_select on public.cls_grades
  for select using (
    public.cls_can_manage(org_id)
    or (public.cls_is_ga(org_id) and source = 'ga' and graded_by = auth.uid())
    or (student_id = auth.uid() and is_final and visible)
  );

-- Tighten the GA write policy so a GA can only write rows attributed to
-- themselves (was: any source='ga' row). Professors keep the separate
-- cls_grades_write_staff (`for all` on cls_can_manage) — unchanged.
drop policy cls_grades_write_ga on public.cls_grades;
create policy cls_grades_write_ga on public.cls_grades
  for all using (public.cls_is_ga(org_id) and source = 'ga' and graded_by = auth.uid())
  with check (public.cls_is_ga(org_id) and source = 'ga' and graded_by = auth.uid());
