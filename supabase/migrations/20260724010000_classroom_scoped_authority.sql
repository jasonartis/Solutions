-- User model slice 2b — classroom scope-awareness + enrollment as scoped grants
-- (docs/15 §11 slice 2, decision log 2026-07-24). Builds on 2a (20260723010000,
-- multiple scoped grants per user/role).
--
-- WHAT CHANGES
--   * cls_courses / cls_classes gain scope_node_id → a module_scope_nodes tree
--     (course = root node, class = child). New rows get nodes via BEFORE-INSERT
--     definer triggers; existing rows are backfilled.
--   * module_position_rank becomes per-module: classroom professor=2 (Lead),
--     ga=1, student=1 (GA & student are PEERS — founder call). Generic tier
--     vocab still resolves via fallback for every module.
--   * module_has_manager_grant's coarse RLS write gate drops rank>=3 → rank>=2
--     so a professor (Lead) can enroll students/GAs in their OWN scope; the
--     hierarchy guard still does the fine-grained rank+scope enforcement
--     (resolves docs/15 N2). Inert for the 6 other modules (their roles rank 0).
--   * cls_can_manage/cls_is_ga are redefined COARSE ("classroom staff/GA
--     anywhere in this org, at any scope") — used only by the storage policies
--     and the manage-page entry gate. New PRECISE per-row functions
--     cls_can_manage_class/_course + cls_is_ga_class/_course check scope
--     coverage; every per-row DB policy is rewritten onto them.
--   * cls_is_class_member reads module_roles (a classroom grant covering the
--     class node) instead of the cls_class_members roster — so enrollment
--     authority has ONE source (the scoped grant). The roster table survives as
--     a name/badge store only (the two-systems split, items 29–30, is gone).
--   * Existing GLOBAL professor/GA grants stay global (org-wide staff = the
--     intended meaning of a global grant → covers everything, unchanged).
--     Existing STUDENT rosters migrate to SCOPED student grants at the class
--     node; the flat global student grants are removed (a "module-wide student"
--     is meaningless and would over-expose via the grant-based membership).
--
-- SCOPE MODEL: module_scope_covers(grant.scope_ref, node) — a GLOBAL grant
-- (scope_ref null) covers every node (module_scope_covers(null,·)=true) so
-- global professors are unchanged; a course-scoped grant covers the course node
-- AND its class children; a class-scoped grant covers just that class.
--
-- COARSE-FUNCTION CONSUMERS (review Finding 3 — accurate list): the coarse
-- cls_can_manage(org)/cls_is_ga(org) now mean "classroom staff/GA anywhere in
-- this org, at any scope". They are used by:
--   * storage.objects policies (cls-submissions/materials/exams) — the bucket
--     path encodes org_id, not class, so storage stays ORG-scoped. A scoped
--     professor could fetch another class's file BY PATH; but the DB rows that
--     expose those paths are class-scoped, so paths aren't discoverable through
--     the app. KNOWN LIMITATION — true per-class storage scoping is a follow-on.
--   * the manage-page ENTRY gate — a scoped professor may enter the console;
--     every row they then see is filtered by the scope-precise RLS below, so
--     coarse entry leaks nothing.
--   * the two BEFORE-UPDATE pin triggers (cls_pin_submission_columns /
--     cls_pin_grade_author) — they only decide column immutability for rows the
--     scope-precise USING clause already authorized, so no widening.
-- The two HIGHER-authority consumers that the coarse redefinition would have
-- wrongly widened — export controls (module_can_manage) and cross-class survey
-- aggregates (cls_survey_results) — are tightened below so a class-scoped
-- professor gets NO org-wide reach through them.

-- ===========================================================================
-- 1. Scope nodes for courses/classes
-- ===========================================================================
alter table public.cls_courses add column scope_node_id uuid references public.module_scope_nodes (id) on delete set null;
alter table public.cls_classes add column scope_node_id uuid references public.module_scope_nodes (id) on delete set null;
-- ON DELETE SET NULL (not cascade): deleting a scope node must never silently
-- delete a course/class. A null node degrades safely (only global grants +
-- org admins manage it); backfill + triggers keep it populated in practice.

-- Node creation for NEW rows. Definer so a scoped professor (who may create a
-- class in their scope) can mint the node without holding module_scope_nodes'
-- org-admin write policy. Order-independent: derives org from the parent
-- row/course, not from a sibling scope-sync trigger.
-- The node id is TRIGGER-OWNED: any client-supplied new.scope_node_id is
-- ignored (overwritten) so a caller can never file a course/class under a
-- foreign or arbitrary node (slice-1 "client values ignored" principle, item 7;
-- security review Finding 5).
create function public.cls_create_course_node()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare nid uuid;
begin
  insert into public.module_scope_nodes (org_id, module_key, name, node_type)
  values (new.org_id, 'classroom', new.name, 'course')
  returning id into nid;
  new.scope_node_id := nid;
  return new;
end;
$$;

create function public.cls_create_class_node()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare parent_node uuid; parent_org uuid; nid uuid;
begin
  select scope_node_id, org_id into parent_node, parent_org
    from public.cls_courses where id = new.course_id;
  if parent_node is null then
    raise exception 'cls_classes: course % has no scope node', new.course_id;
  end if;
  insert into public.module_scope_nodes (org_id, module_key, parent_id, name, node_type)
  values (parent_org, 'classroom', parent_node, new.name, 'class')
  returning id into nid;
  new.scope_node_id := nid;
  return new;
end;
$$;

create trigger cls_courses_node before insert on public.cls_courses
  for each row execute function public.cls_create_course_node();
create trigger cls_classes_node before insert on public.cls_classes
  for each row execute function public.cls_create_class_node();

-- Backfill existing courses/classes into the node tree.
do $$
declare c record; cl record; cnode uuid; clnode uuid;
begin
  for c in select id, org_id, name from public.cls_courses where scope_node_id is null loop
    insert into public.module_scope_nodes (org_id, module_key, name, node_type)
    values (c.org_id, 'classroom', c.name, 'course') returning id into cnode;
    update public.cls_courses set scope_node_id = cnode where id = c.id;
    for cl in select id, org_id, name from public.cls_classes where course_id = c.id and scope_node_id is null loop
      insert into public.module_scope_nodes (org_id, module_key, parent_id, name, node_type)
      values (cl.org_id, 'classroom', cnode, cl.name, 'class') returning id into clnode;
      update public.cls_classes set scope_node_id = clnode where id = cl.id;
    end loop;
  end loop;
end $$;

-- ===========================================================================
-- 2. Per-module rank mapping + gate lowering (repoint the slice-1 guard callers)
-- ===========================================================================
-- 2-arg, per-module. Falls back to the generic tier vocabulary (the existing
-- 1-arg function) so every module keeps director/coordinator/lead/position.
-- IMMUTABLE, migration-owned config (docs/15 §4.1 item 5) — never a tenant table.
create function public.module_position_rank(module_key text, role text)
returns integer
language sql
immutable
as $$
  select coalesce(
    case module_key
      when 'classroom' then case role
        when 'professor' then 2   -- Entity Lead: runs a course/class
        when 'ga' then 1          -- entity position (peer of student)
        when 'student' then 1     -- entity position (peer of GA)
        else null end
      -- future modules add their vocabulary blocks here
      else null
    end,
    public.module_position_rank(role)  -- generic tier fallback (director/coordinator/lead/position)
  );
$$;

grant execute on function public.module_position_rank(text, text) to authenticated, service_role;

-- Repoint the three slice-1 guard helpers onto the per-module rank. Bodies are
-- otherwise identical to 20260720010000 (+ the 2026-07-22 branch-B rank-3 pin).
create or replace function public.module_caller_can_manage_seat(
  check_org_id uuid,
  check_module_key text,
  seat_role text,
  seat_scope uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.module_roles g
    where g.org_id = check_org_id
      and g.module_key = check_module_key
      and g.user_id = auth.uid()
      and (
        -- Branch A: strictly outrank + scope coverage.
        (public.module_position_rank(check_module_key, g.role) > public.module_position_rank(check_module_key, seat_role)
           and public.module_scope_covers(g.scope_ref, seat_scope))
        -- Branch B: same position, Coordinator tier (rank 3) only, strict containment.
        or (g.role = seat_role
           and public.module_position_rank(check_module_key, seat_role) = 3
           and public.module_scope_strictly_contains(g.scope_ref, seat_scope))
      )
  );
$$;

-- Lower the coarse write gate to Lead (rank 2) so a professor can enroll
-- students/GAs in their own scope; the guard trigger enforces the exact rule.
create or replace function public.module_has_manager_grant(check_org_id uuid, check_module_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.module_roles
    where org_id = check_org_id
      and module_key = check_module_key
      and user_id = auth.uid()
      and public.module_position_rank(check_module_key, role) >= 2
  );
$$;

create or replace function public.module_roles_guard_last_director()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  losing boolean;
begin
  if public.module_position_rank(old.module_key, old.role) < 4 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if auth.uid() is null
     or public.is_superadmin()
     or public.is_org_admin(old.org_id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    losing := true;
  else
    losing := public.module_position_rank(new.module_key, new.role) < 4
           or new.org_id <> old.org_id
           or new.module_key <> old.module_key
           or new.user_id <> old.user_id
           or (new.scope_ref is distinct from old.scope_ref);
  end if;
  if losing and not exists (
    select 1 from public.module_roles
    where org_id = old.org_id
      and module_key = old.module_key
      and public.module_position_rank(module_key, role) >= 4
      and user_id <> old.user_id
  ) then
    raise exception 'A module must keep at least one Director';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- ===========================================================================
-- 3. Classroom authority functions
-- ===========================================================================
-- COARSE (any-scope): "is the caller classroom staff / a GA ANYWHERE in this
-- org". Used ONLY by the storage policies and the manage-page entry gate. NOT
-- for per-row DB access (that must be scope-precise, below). Redefined off
-- module_roles directly (not has_module_role, which is global-only) so a SCOPED
-- professor still reaches storage + the console.
create or replace function public.cls_can_manage(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_admin(check_org_id)
      or exists (
           select 1 from public.module_roles g
           where g.org_id = check_org_id
             and g.module_key = 'classroom'
             and g.user_id = auth.uid()
             and public.module_position_rank('classroom', g.role) >= 2
         );
$$;

create or replace function public.cls_is_ga(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.module_roles g
    where g.org_id = check_org_id
      and g.module_key = 'classroom'
      and g.user_id = auth.uid()
      and g.role = 'ga'
  );
$$;

-- PRECISE: does the caller hold a classroom grant (Lead+ / GA) whose scope
-- COVERS this specific class/course node? Global grant covers everything.
create function public.cls_can_manage_class(check_org_id uuid, check_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_admin(check_org_id)
      or exists (
           select 1
           from public.module_roles g
           join public.cls_classes c on c.id = check_class_id
           where g.org_id = check_org_id
             and g.module_key = 'classroom'
             and g.user_id = auth.uid()
             and public.module_position_rank('classroom', g.role) >= 2
             and public.module_scope_covers(g.scope_ref, c.scope_node_id)
         );
$$;

create function public.cls_can_manage_course(check_org_id uuid, check_course_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_admin(check_org_id)
      or exists (
           select 1
           from public.module_roles g
           join public.cls_courses c on c.id = check_course_id
           where g.org_id = check_org_id
             and g.module_key = 'classroom'
             and g.user_id = auth.uid()
             and public.module_position_rank('classroom', g.role) >= 2
             and public.module_scope_covers(g.scope_ref, c.scope_node_id)
         );
$$;

create function public.cls_is_ga_class(check_org_id uuid, check_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.module_roles g
    join public.cls_classes c on c.id = check_class_id
    where g.org_id = check_org_id
      and g.module_key = 'classroom'
      and g.user_id = auth.uid()
      and g.role = 'ga'
      and public.module_scope_covers(g.scope_ref, c.scope_node_id)
  );
$$;

create function public.cls_is_ga_course(check_org_id uuid, check_course_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.module_roles g
    join public.cls_courses c on c.id = check_course_id
    where g.org_id = check_org_id
      and g.module_key = 'classroom'
      and g.user_id = auth.uid()
      and g.role = 'ga'
      and public.module_scope_covers(g.scope_ref, c.scope_node_id)
  );
$$;

-- Class membership now = a classroom grant (student/ga/professor) whose scope
-- COVERS the class node — the scoped grant is the single source of enrollment
-- truth. (Replaces the cls_class_members roster read; the roster survives as a
-- name/badge store only.) Definer to avoid RLS recursion, as before.
create or replace function public.cls_is_class_member(check_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.module_roles g
    join public.cls_classes c on c.id = check_class_id
    where g.org_id = c.org_id
      and g.module_key = 'classroom'
      and g.user_id = auth.uid()
      -- A GLOBAL grant does NOT confer class "membership" (a module-wide
      -- 'student' would otherwise be a member of every class — review Finding
      -- 2). Global staff (professor/GA) are covered by the cls_can_manage_class
      -- / cls_is_ga_class arms wherever this is used, so requiring a scoped
      -- grant here loses nothing legitimate and closes the footgun.
      and g.scope_ref is not null
      and public.module_scope_covers(g.scope_ref, c.scope_node_id)
  );
$$;

grant execute on function public.cls_can_manage_class(uuid, uuid) to authenticated, service_role;
grant execute on function public.cls_can_manage_course(uuid, uuid) to authenticated, service_role;
grant execute on function public.cls_is_ga_class(uuid, uuid) to authenticated, service_role;
grant execute on function public.cls_is_ga_course(uuid, uuid) to authenticated, service_role;

-- Two consumers of the COARSE cls_can_manage were widened to scoped professors
-- by its redefinition (review Finding 3). Both are higher-authority than
-- storage/console-entry and must NOT grant a class-scoped professor org-wide
-- reach, so tighten them here:
--   (a) Export controls are a module-WIDE setting (org_modules.settings, not
--       per-class), so gate on admin OR a module-GLOBAL professor
--       (has_module_role is global-only) — exactly the pre-2b semantics; a
--       class-scoped professor cannot toggle org-wide export controls.
create or replace function public.module_can_manage(check_org_id uuid, check_module_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case check_module_key
    when 'classroom' then
      public.is_org_admin(check_org_id)
      or public.has_module_role(check_org_id, 'classroom', 'professor')
    when 'matchmaking' then public.mm_can_manage(check_org_id)
    when 'nail-salon' then public.sal_can_manage(check_org_id)
    when 'speed-dating' then public.sd_can_manage(check_org_id)
    when 'sample' then public.smp_can_manage(check_org_id)
    when 'synagogue-schedules' then
      public.is_org_admin(check_org_id)
      or public.has_module_role(check_org_id, 'synagogue-schedules', 'maker')
    else public.is_org_admin(check_org_id)
  end;
$$;

--   (b) Survey aggregates are per-class, so gate the staff arm on managing THAT
--       class, not any class org-wide.
create or replace function public.cls_survey_results(check_survey_id uuid)
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
    and (public.cls_is_class_member(s.class_id) or public.cls_can_manage_class(s.org_id, s.class_id))
  group by a.answer
  order by votes desc, a.answer;
$$;

-- ===========================================================================
-- 4. Rewrite per-row DB policies onto the scope-precise functions.
--    Storage policies are deliberately NOT touched (stay coarse/org-scoped —
--    see KNOWN LIMITATION in the header).
-- ===========================================================================

-- 4a. Staff-write: drop all 16, recreate scope-precise.
do $$
declare t text;
begin
  foreach t in array array[
    'cls_courses','cls_classes','cls_class_members','cls_materials',
    'cls_publications','cls_homeworks','cls_submissions','cls_submission_files',
    'cls_exams','cls_exam_papers','cls_review_assignments','cls_review_comments',
    'cls_grades','cls_announcements','cls_surveys','cls_survey_answers']
  loop
    execute format('drop policy %I_write_staff on public.%I;', t, t);
  end loop;
  -- 13 class_id-based tables.
  foreach t in array array[
    'cls_class_members','cls_publications','cls_homeworks','cls_submissions',
    'cls_submission_files','cls_exams','cls_exam_papers','cls_review_assignments',
    'cls_review_comments','cls_grades','cls_announcements','cls_surveys','cls_survey_answers']
  loop
    execute format(
      'create policy %I_write_staff on public.%I for all
         using (public.cls_can_manage_class(org_id, class_id))
         with check (public.cls_can_manage_class(org_id, class_id));',
      t, t);
  end loop;
end $$;

-- cls_classes: INSERT gate covers the PARENT COURSE (via course_id, which
-- exists) — the new class's OWN node isn't visible to the statement snapshot,
-- so a self-referential check on `id` would wrongly fail for non-admins
-- (docs/03 #15; review Finding 1). UPDATE/DELETE use the class node (the row
-- exists, so the self-join resolves).
create policy cls_classes_insert_staff on public.cls_classes
  for insert with check (public.cls_can_manage_course(org_id, course_id));
create policy cls_classes_update_staff on public.cls_classes
  for update using (public.cls_can_manage_class(org_id, id))
             with check (public.cls_can_manage_class(org_id, id));
create policy cls_classes_delete_staff on public.cls_classes
  for delete using (public.cls_can_manage_class(org_id, id));

-- cls_courses: INSERT can't check the not-yet-created course node either, so
-- gate creation on COARSE classroom staff (admin or a Lead+ grant); the node is
-- minted by the BEFORE-INSERT trigger. UPDATE/DELETE use the course node.
create policy cls_courses_insert_staff on public.cls_courses
  for insert with check (public.cls_can_manage(org_id));
create policy cls_courses_update_staff on public.cls_courses
  for update using (public.cls_can_manage_course(org_id, id))
             with check (public.cls_can_manage_course(org_id, id));
create policy cls_courses_delete_staff on public.cls_courses
  for delete using (public.cls_can_manage_course(org_id, id));

-- cls_materials: course-level (course_id references an existing course, no
-- self-reference issue).
create policy cls_materials_write_staff on public.cls_materials
  for all using (public.cls_can_manage_course(org_id, course_id))
          with check (public.cls_can_manage_course(org_id, course_id));

-- 4b. Class-member read loop (6 tables), scope-precise.
do $$
declare t text;
begin
  foreach t in array array[
    'cls_class_members','cls_publications','cls_homeworks','cls_exams',
    'cls_announcements','cls_surveys']
  loop
    execute format('drop policy %I_select_member on public.%I;', t, t);
    execute format(
      'create policy %I_select_member on public.%I for select
         using (public.cls_is_class_member(class_id)
                or public.cls_can_manage_class(org_id, class_id)
                or public.cls_is_ga_class(org_id, class_id));',
      t, t);
  end loop;
end $$;

-- 4c. Individual read/write policies.
drop policy cls_classes_select_member on public.cls_classes;
create policy cls_classes_select_member on public.cls_classes
  for select using (
    public.cls_is_class_member(id)
    or public.cls_can_manage_class(org_id, id)
    or public.cls_is_ga_class(org_id, id)
  );

drop policy cls_courses_select_staff on public.cls_courses;
create policy cls_courses_select_staff on public.cls_courses
  for select using (
    public.cls_can_manage_course(org_id, id) or public.cls_is_ga_course(org_id, id)
  );

drop policy cls_materials_select on public.cls_materials;
create policy cls_materials_select on public.cls_materials
  for select using (
    public.cls_can_manage_course(org_id, course_id)
    or public.cls_is_ga_course(org_id, course_id)
    or exists (
         select 1 from public.cls_publications p
         where p.material_id = cls_materials.id
           and public.cls_is_class_member(p.class_id)
           and (p.visible_from is null or p.visible_from <= now())
           and (p.visible_until is null or now() < p.visible_until)
       )
  );

drop policy cls_submissions_select on public.cls_submissions;
create policy cls_submissions_select on public.cls_submissions
  for select using (
    public.cls_can_manage_class(org_id, class_id)
    or (
      (public.cls_is_ga_class(org_id, class_id) or student_id = auth.uid() or public.cls_reviews_submission(id))
      and not public.cls_submission_hidden(id)
    )
  );

drop policy cls_submission_files_select on public.cls_submission_files;
create policy cls_submission_files_select on public.cls_submission_files
  for select using (
    public.cls_can_manage_class(org_id, class_id)
    or (
      (
        public.cls_is_ga_class(org_id, class_id)
        or public.cls_owns_submission(submission_id)
        or public.cls_reviews_submission(submission_id)
      )
      and not public.cls_submission_hidden(submission_id)
    )
  );

drop policy cls_review_assignments_select on public.cls_review_assignments;
create policy cls_review_assignments_select on public.cls_review_assignments
  for select using (
    public.cls_can_manage_class(org_id, class_id) or reviewer_id = auth.uid()
  );

drop policy cls_review_comments_select on public.cls_review_comments;
create policy cls_review_comments_select on public.cls_review_comments
  for select using (
    public.cls_can_manage_class(org_id, class_id)
    or public.cls_is_ga_class(org_id, class_id)
    or author_id = auth.uid()
    or public.cls_owns_submission(submission_id)
  );

drop policy cls_review_comments_insert_own on public.cls_review_comments;
create policy cls_review_comments_insert_own on public.cls_review_comments
  for insert with check (
    author_id = auth.uid()
    and (public.cls_reviews_submission(submission_id) or public.cls_is_ga_class(org_id, class_id))
  );

drop policy cls_grades_select on public.cls_grades;
create policy cls_grades_select on public.cls_grades
  for select using (
    public.cls_can_manage_class(org_id, class_id)
    or (public.cls_is_ga_class(org_id, class_id) and source = 'ga' and graded_by = auth.uid())
    or (student_id = auth.uid() and is_final and visible)
  );

drop policy cls_grades_write_ga on public.cls_grades;
create policy cls_grades_write_ga on public.cls_grades
  for all using (public.cls_is_ga_class(org_id, class_id) and source = 'ga' and graded_by = auth.uid())
  with check (public.cls_is_ga_class(org_id, class_id) and source = 'ga' and graded_by = auth.uid());

drop policy cls_exam_papers_select on public.cls_exam_papers;
create policy cls_exam_papers_select on public.cls_exam_papers
  for select using (
    public.cls_can_manage_class(org_id, class_id)
    or public.cls_is_ga_class(org_id, class_id)
    or student_id = auth.uid()
  );

drop policy cls_survey_answers_select on public.cls_survey_answers;
create policy cls_survey_answers_select on public.cls_survey_answers
  for select using (
    public.cls_can_manage_class(org_id, class_id) or user_id = auth.uid()
  );

-- ===========================================================================
-- 5. Data migration — enrollment becomes scoped grants.
--    Student rosters → scoped student grants at the class node; flat global
--    student grants removed. Professor/GA global grants KEPT global (org-wide
--    staff). Runs as the migration role (auth.uid() null) → guard bypass.
-- ===========================================================================
do $$
declare m record;
begin
  for m in
    select cm.user_id, cm.org_id, cl.scope_node_id
    from public.cls_class_members cm
    join public.cls_classes cl on cl.id = cm.class_id
    where cm.role = 'student' and cl.scope_node_id is not null
  loop
    insert into public.module_roles (org_id, user_id, module_key, role, scope_ref)
    values (m.org_id, m.user_id, 'classroom', 'student', m.scope_node_id)
    on conflict (org_id, user_id, module_key, role, scope_ref) do nothing;
  end loop;
  -- A "module-wide student" is meaningless and would over-expose via the
  -- grant-based cls_is_class_member; scoped grants above replace them.
  delete from public.module_roles
   where module_key = 'classroom' and role = 'student' and scope_ref is null;
end $$;
