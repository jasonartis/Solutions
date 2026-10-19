-- INSERT PINS, OTHER MODULES (2026-10-17).
--
-- THE CLASS OF BUG. Several tables protect a column on UPDATE with a BEFORE
-- UPDATE `*_pin_*` trigger, but the same column is freely client-supplied on
-- INSERT, because those pin triggers fire on UPDATE only and the INSERT
-- policies check ownership/membership, not column values. A platform-wide
-- adversarial review reproduced eight cases as a plain signed-in user. Speed
-- dating (`sd_`) is fixed separately and is deliberately untouched here.
--
-- THE MECHANISM, one BEFORE INSERT trigger per table, each a NEW function. No
-- existing function is replaced (two of these tables belong to modules other
-- sessions are editing right now; adding a trigger cannot resurrect an old
-- body of theirs).
--
--   * TRUSTED CALLERS ARE UNTOUCHED: `auth.uid() is null` means no JWT — the
--     seed, the worker's service role, migrations, and the pending-invite
--     appliers (20261016010000/20261018020000), which clear the caller's
--     identity precisely to take this path. `anon` holds no grant on any of
--     these tables, so a null uid cannot be an attacker over the API. This is
--     the same discriminator `vm_invite_pending` already uses.
--   * STAFF KEEP THEIR ABILITIES where a staff insert is a real thing, using
--     the predicate the table's own staff policy uses (named per guard).
--   * ORDER IS DELIBERATE. Triggers of one timing fire in name order. Every
--     guard that tests a staff predicate is named `<table>_zz_insert_guard`,
--     so it fires AFTER the `<table>_scope` trigger that re-derives org_id /
--     class_id from the parent row — the guard therefore judges the SAME
--     org/class the RLS WITH CHECK will judge, never a client-supplied one.
--     The one guard that DERIVES a column (survey answers) is named
--     `..._a_...` so it fires BEFORE the scope trigger, which then derives
--     org_id from the corrected class_id.
--   * Coerce, don't raise, for columns with a single correct server value
--     (the pin triggers' own style); RAISE where there is no correct value to
--     coerce to (a file path that points elsewhere; a job kind the caller may
--     not queue).
--
-- PER TABLE (the reviewer's finding -> what this does):
--   1. cls_submissions: visible_override_until (pinned on UPDATE) was
--      settable on INSERT, defeating the class retention hide
--      (cls_submission_hidden). Non-managers: visible_override_until, and
--      storage_prefix -> null (no app code writes or reads it; file locations
--      live on cls_submission_files.storage_path, bound below);
--      submitted_at/created_at -> now().
--   2. cls_submission_files: storage_path must be
--      <org_id>/<class_id>/<submission_id>/<file> — exactly the shape the app
--      uploads (modules/classroom/ui/homework/[homeworkId]/actions.ts) and
--      the storage policies key on (foldername[1] = org, [3] = submission).
--   3. vm_layers: tombstoned/tombstoned_by/tombstoned_at/created_at forced
--      for every JWT caller (no app path inserts a removed layer); frozen
--      forced false below the org manage tier (vm_can_manage — the tier the
--      UPDATE path of vm_layers_before_write exempts).
--   4. vm_flags: state 'open', reviewed_by/at null, created_at now(), for
--      every JWT caller — a review is only ever recorded by vm_pin_flag.
--   5. sal_appointments: below the location's operators
--      (sal_can_operate_location, the tier sal_pin_appointment exempts):
--      booked_by := the caller, checklist '[]', created_at now(),
--      cancelled_at/cancel_reason null.
--   6. mm_questions: below mm_can_manage: admin_locks '{}', approved_by/at
--      null, created_at now(). (The approve action overwrites approved_by/at
--      but NEVER touches admin_locks, so a proposer's forged locks would have
--      survived approval.)
--   7. job_requests: status 'pending', result/error null, created_at now();
--      and each KIND is restricted to who may queue it. Only one kind exists
--      ('synagogue-schedules.render', queued by makers); an unknown kind from
--      a JWT caller is refused, so a new kind must be classified here.
--   8. cls_survey_answers: class_id is DERIVED from the survey (INSERT and
--      UPDATE), so an answer cannot be filed under another class.
--
-- THE UPDATE-SIDE MIRROR (added to this same, unpushed migration 2026-10-19).
-- For every column forced on INSERT above, the UPDATE side was swept for a
-- non-staff path that could still write it. Tables with NO non-staff UPDATE
-- policy need nothing (cls_submission_files, mm_questions, job_requests:
-- staff-only or none). The gaps found, all closed below:
--   * cls_submissions (cls_submissions_update_own, a student): submitted_at,
--     storage_prefix and created_at were free. cls_pin_submission_columns is
--     REBUILT from its latest body (20260709080000 — verified equal to the
--     deployed md5 before editing) with those three added; nothing removed.
--   * cls_survey_answers (cls_survey_answers_update_own): survey_id was free,
--     and that policy's WITH CHECK is only user_id = auth.uid() — so a student
--     could MOVE an answer onto a survey of a class they are not in (the class
--     derivation then followed it there). survey_id/user_id/created_at pinned
--     for non-staff by a trigger named `_0_` so it fires BEFORE the `_a_`
--     derivation (which then derives from the pinned survey).
--   * vm_layers (author, moderator) and vm_flags (moderator): created_at free.
--     Pinned below the org manage tier.
--   * sal_appointments (customer, worker): created_at free; cancelled_at and
--     cancel_reason free. Below operators: created_at pinned; cancelled_at is
--     stamped now() on the transition INTO 'cancelled' and otherwise pinned;
--     cancel_reason may only change on that transition.
-- All UPDATE guards are NEW trigger functions except the classroom pin; each
-- keeps the `pg_trigger_depth() > 1` escape so a referential action (an FK's
-- SET NULL is a real UPDATE) is never blocked or rewritten.
-- sal_appointments.notes stays client-writable by design (the worker's own
-- notes; no app screen renders appointment notes as staff authority).
--
-- NO DATA IS TOUCHED. Everything below is catalog-only; the assertion block
-- reads only the catalog, so this applies to an empty database (CI's state).

-- 1. cls_submissions ---------------------------------------------------------
create function public.cls_guard_submission_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new; -- trusted path: seed, worker, migrations
  end if;
  -- The staff policy's own predicate (cls_submissions_write_staff). org_id
  -- and class_id were just re-derived from the homework by
  -- cls_submissions_scope, which fires first.
  if public.cls_can_manage_class(new.org_id, new.class_id) then
    return new;
  end if;
  new.visible_override_until := null;
  new.storage_prefix := null;
  new.submitted_at := now();
  new.created_at := now();
  return new;
end;
$$;

create trigger cls_submissions_zz_insert_guard
  before insert on public.cls_submissions
  for each row execute function public.cls_guard_submission_insert();

-- 2. cls_submission_files ----------------------------------------------------
create function public.cls_guard_submission_file_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if public.cls_can_manage_class(new.org_id, new.class_id) then
    return new;
  end if;
  -- <org>/<class>/<submission>/<file>, org/class as re-derived by
  -- cls_submission_files_scope. A 4th, non-empty segment must exist.
  if split_part(new.storage_path, '/', 1) is distinct from new.org_id::text
     or split_part(new.storage_path, '/', 2) is distinct from new.class_id::text
     or split_part(new.storage_path, '/', 3) is distinct from new.submission_id::text
     or split_part(new.storage_path, '/', 4) = ''
     -- no traversal or degenerate segment anywhere in the path
     or exists (select 1 from unnest(string_to_array(new.storage_path, '/')) as seg
                 where seg in ('', '.', '..'))
  then
    raise exception 'File path does not belong to this submission'
      using errcode = '42501';
  end if;
  new.created_at := now();
  return new;
end;
$$;

create trigger cls_submission_files_zz_insert_guard
  before insert on public.cls_submission_files
  for each row execute function public.cls_guard_submission_file_insert();

-- 3. vm_layers ---------------------------------------------------------------
create function public.vm_guard_layer_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  -- A layer is born live; removal is only ever recorded through the UPDATE
  -- path (vm_layers_before_write / vm_layers_pin_credit stamp it).
  new.tombstoned := false;
  new.tombstoned_by := null;
  new.tombstoned_at := null;
  new.created_at := now();
  -- org_id was derived from the conversation by vm_layers_scope (fires first).
  if not public.vm_can_manage(new.org_id) then
    new.frozen := false;
  end if;
  return new;
end;
$$;

create trigger vm_layers_zz_insert_guard
  before insert on public.vm_layers
  for each row execute function public.vm_guard_layer_insert();

-- 4. vm_flags ----------------------------------------------------------------
create function public.vm_guard_flag_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  new.state := 'open';
  new.reviewed_by := null;
  new.reviewed_at := null;
  new.created_at := now();
  return new;
end;
$$;

create trigger vm_flags_zz_insert_guard
  before insert on public.vm_flags
  for each row execute function public.vm_guard_flag_insert();

-- 5. sal_appointments --------------------------------------------------------
create function public.sal_guard_appointment_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  -- Operators of THIS location (managers + cashiers) book for anyone, walk-ins
  -- included. org_id was derived from the location by sal_appointments_scope.
  if public.sal_can_operate_location(new.org_id, new.location_id) then
    return new;
  end if;
  new.booked_by := auth.uid();
  new.checklist := '[]'::jsonb;
  new.cancelled_at := null;
  new.cancel_reason := null;
  new.created_at := now();
  return new;
end;
$$;

create trigger sal_appointments_zz_insert_guard
  before insert on public.sal_appointments
  for each row execute function public.sal_guard_appointment_insert();

-- 6. mm_questions ------------------------------------------------------------
create function public.mm_guard_question_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  -- Admin-authored questions (mm_questions_write_staff) are approved and
  -- locked at creation by design (modules/matchmaking/ui/manage/actions.ts).
  if public.mm_can_manage(new.org_id) then
    return new;
  end if;
  new.admin_locks := '{}'::jsonb;
  new.approved_by := null;
  new.approved_at := null;
  new.created_at := now();
  return new;
end;
$$;

create trigger mm_questions_zz_insert_guard
  before insert on public.mm_questions
  for each row execute function public.mm_guard_question_insert();

-- 7. job_requests ------------------------------------------------------------
create function public.job_requests_guard_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  -- Lifecycle columns belong to the worker.
  new.status := 'pending';
  new.result := null;
  new.error := null;
  new.created_at := now();
  -- Who may queue each kind. Unknown kinds are refused: a new kind must be
  -- classified here when it is added (the worker would only mark it errored,
  -- but a queue anyone in the org can fill is not a queue we want).
  if new.kind = 'synagogue-schedules.render' then
    if not public.syn_can_write(new.org_id) then
      raise exception 'Only a schedule maker may request an export'
        using errcode = '42501';
    end if;
  else
    raise exception 'Unknown job kind %', new.kind
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger job_requests_zz_insert_guard
  before insert on public.job_requests
  for each row execute function public.job_requests_guard_insert();

-- 8. cls_survey_answers ------------------------------------------------------
-- Fires for EVERY caller (trusted ones included): it is a consistency rule,
-- not a privilege. SECURITY DEFINER so it never depends on the caller's read
-- access to cls_surveys; the insert/update policies then judge the derived
-- class (cls_is_class_member / cls_can_manage_class).
create function public.cls_survey_answer_class_from_survey()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare survey_class uuid;
begin
  select s.class_id into survey_class from public.cls_surveys s where s.id = new.survey_id;
  if survey_class is null then
    raise exception 'Unknown survey %', new.survey_id;
  end if;
  new.class_id := survey_class;
  return new;
end;
$$;

-- `_a_` sorts before `cls_survey_answers_scope`, which then derives org_id
-- from the corrected class_id.
create trigger cls_survey_answers_a_class_from_survey
  before insert or update on public.cls_survey_answers
  for each row execute function public.cls_survey_answer_class_from_survey();

-- 9. UPDATE-side mirror -------------------------------------------------------

-- 9a. cls_submissions: rebuilt from 20260709080000's body; three pins added,
-- and the exemption narrowed from cls_can_manage(org) — true for a rank-2
-- grant ANYWHERE in the org, e.g. a student who is professor of a DIFFERENT
-- class — to cls_can_manage_class, the predicate cls_submissions_write_staff
-- itself uses. A class-B professor is just a student in class A.
create or replace function public.cls_pin_submission_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.cls_can_manage_class(old.org_id, old.class_id) then
    new.homework_id := old.homework_id;
    new.student_id := old.student_id;
    new.visible_override_until := old.visible_override_until;
    -- 20261017030000: the mirror of the INSERT guard.
    new.submitted_at := old.submitted_at;
    new.storage_prefix := old.storage_prefix;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

-- 9b. cls_survey_answers: an answer stays on its survey.
create function public.cls_pin_survey_answer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return new; -- referential action
  end if;
  if public.cls_can_manage_class(old.org_id, old.class_id) then
    return new;
  end if;
  new.survey_id := old.survey_id;
  new.user_id := old.user_id;
  new.created_at := old.created_at;
  return new;
end;
$$;

-- `_0_` sorts before `_a_class_from_survey` (and `_scope`), so the derivation
-- sees the PINNED survey_id.
create trigger cls_survey_answers_0_pin
  before update on public.cls_survey_answers
  for each row execute function public.cls_pin_survey_answer();

-- 9c. vm_layers: created_at below the org manage tier.
create function public.vm_pin_layer_created_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return new; -- counter bumps from vm_layers_before_write; referential actions
  end if;
  if public.vm_can_manage(old.org_id) then
    return new;
  end if;
  new.created_at := old.created_at;
  return new;
end;
$$;

create trigger vm_layers_zz_update_pin
  before update on public.vm_layers
  for each row execute function public.vm_pin_layer_created_at();

-- 9d. vm_flags: created_at below the org manage tier (moderators triage).
create function public.vm_pin_flag_created_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;
  if public.vm_can_manage(old.org_id) then
    return new;
  end if;
  new.created_at := old.created_at;
  return new;
end;
$$;

create trigger vm_flags_zz_update_pin
  before update on public.vm_flags
  for each row execute function public.vm_pin_flag_created_at();

-- 9e. sal_appointments: below operators (customers, workers). Fires after
-- sal_appointments_pin, which has already refused illegal transitions.
create function public.sal_pin_appointment_stamps()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;
  if public.sal_can_operate_location(old.org_id, old.location_id) then
    return new;
  end if;
  new.created_at := old.created_at;
  if new.state = 'cancelled' and old.state is distinct from 'cancelled' then
    new.cancelled_at := now(); -- server-stamped; the reason is the caller's
  else
    new.cancelled_at := old.cancelled_at;
    new.cancel_reason := old.cancel_reason;
  end if;
  return new;
end;
$$;

create trigger sal_appointments_zz_update_pin
  before update on public.sal_appointments
  for each row execute function public.sal_pin_appointment_stamps();

-- 10. Re-review follow-ups (2026-10-19) ---------------------------------------

-- 10a. cls_review_assignments: the reviewer pin had the same org-wide
-- exemption, so a reviewer who manages ANOTHER class could re-point their own
-- assignment's submission_id at any submission (cls_reviews_submission then
-- grants its files). Rebuilt from 20260708010000's body (the only definition;
-- equal to the deployed md5) with the class-level predicate.
create or replace function public.cls_pin_assignment_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.cls_can_manage_class(old.org_id, old.class_id) then
    new.homework_id := old.homework_id;
    new.reviewer_id := old.reviewer_id;
    new.submission_id := old.submission_id;
    new.locked := old.locked;
  end if;
  return new;
end;
$$;

-- 10b. cls_grades: same shape. Rebuilt from 20260712020000's body (the only
-- definition; equal to the deployed md5). Not exploitable today — the GA
-- write policy's WITH CHECK already demands graded_by = auth.uid() — but the
-- pin must not depend on that.
create or replace function public.cls_pin_grade_author()
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
  elsif not public.cls_can_manage_class(old.org_id, old.class_id) then
    new.graded_by := old.graded_by;
  end if;
  return new;
end;
$$;

-- 10c. cls_review_comments: no pin existed. cls_review_comments_update_own's
-- WITH CHECK is only author_id = auth.uid(), so an author could MOVE a comment
-- onto any submission (the scope trigger then re-derived its class). UPDATE
-- pin named `_0_` so it fires BEFORE cls_review_comments_scope; INSERT guard
-- `_zz_` after it.
create function public.cls_pin_review_comment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;
  if public.cls_can_manage_class(old.org_id, old.class_id) then
    return new;
  end if;
  new.submission_id := old.submission_id;
  new.author_id := old.author_id;
  new.created_at := old.created_at;
  return new;
end;
$$;

create trigger cls_review_comments_0_pin
  before update on public.cls_review_comments
  for each row execute function public.cls_pin_review_comment();

create function public.cls_guard_review_comment_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if public.cls_can_manage_class(new.org_id, new.class_id) then
    return new;
  end if;
  new.created_at := now();
  return new;
end;
$$;

create trigger cls_review_comments_zz_insert_guard
  before insert on public.cls_review_comments
  for each row execute function public.cls_guard_review_comment_insert();

-- 10d. created_at on INSERT, below each table's staff tier. No app path
-- supplies created_at on any of these (searched modules/, apps/web, seed).
create function public.smp_guard_item_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or public.smp_can_manage(new.org_id) then
    return new;
  end if;
  new.created_at := now();
  return new;
end;
$$;

create trigger smp_items_zz_insert_guard
  before insert on public.smp_items
  for each row execute function public.smp_guard_item_insert();

create function public.vm_guard_reaction_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or public.vm_can_manage(new.org_id) then
    return new;
  end if;
  new.created_at := now();
  return new;
end;
$$;

create trigger vm_reactions_zz_insert_guard
  before insert on public.vm_reactions
  for each row execute function public.vm_guard_reaction_insert();

create function public.vm_guard_conversation_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or public.vm_can_manage(new.org_id) then
    return new;
  end if;
  new.created_at := now();
  return new;
end;
$$;

create trigger vm_conversations_zz_insert_guard
  before insert on public.vm_conversations
  for each row execute function public.vm_guard_conversation_insert();

-- ACL: trigger functions are never called directly; no role needs EXECUTE.
-- Full revoke (docs/03 #27): prod's default privileges grant EXECUTE to the
-- api roles at CREATE, and `revoke ... from public` alone does not remove it.
revoke all on function public.cls_guard_submission_insert() from public, anon, authenticated, service_role;
revoke all on function public.cls_guard_submission_file_insert() from public, anon, authenticated, service_role;
revoke all on function public.vm_guard_layer_insert() from public, anon, authenticated, service_role;
revoke all on function public.vm_guard_flag_insert() from public, anon, authenticated, service_role;
revoke all on function public.sal_guard_appointment_insert() from public, anon, authenticated, service_role;
revoke all on function public.mm_guard_question_insert() from public, anon, authenticated, service_role;
revoke all on function public.job_requests_guard_insert() from public, anon, authenticated, service_role;
revoke all on function public.cls_survey_answer_class_from_survey() from public, anon, authenticated, service_role;
revoke all on function public.cls_pin_submission_columns() from public, anon, authenticated, service_role;
revoke all on function public.cls_pin_survey_answer() from public, anon, authenticated, service_role;
revoke all on function public.vm_pin_layer_created_at() from public, anon, authenticated, service_role;
revoke all on function public.vm_pin_flag_created_at() from public, anon, authenticated, service_role;
revoke all on function public.sal_pin_appointment_stamps() from public, anon, authenticated, service_role;
revoke all on function public.cls_pin_assignment_columns() from public, anon, authenticated, service_role;
revoke all on function public.cls_pin_grade_author() from public, anon, authenticated, service_role;
revoke all on function public.cls_pin_review_comment() from public, anon, authenticated, service_role;
revoke all on function public.cls_guard_review_comment_insert() from public, anon, authenticated, service_role;
revoke all on function public.smp_guard_item_insert() from public, anon, authenticated, service_role;
revoke all on function public.vm_guard_reaction_insert() from public, anon, authenticated, service_role;
revoke all on function public.vm_guard_conversation_insert() from public, anon, authenticated, service_role;

-- Catalog-only assertions (no rows required): each trigger is bound, enabled,
-- BEFORE, row-level, fires in the intended position relative to its table's
-- scope trigger, and its function is SECURITY DEFINER with a pinned
-- search_path and no api-role EXECUTE.
do $$
declare
  spec record;
  trg record;
  fn record;
begin
  for spec in
    select * from (values
      ('cls_submissions',      'cls_submissions_zz_insert_guard',        'cls_guard_submission_insert',         'cls_submissions_scope',      true),
      ('cls_submission_files', 'cls_submission_files_zz_insert_guard',   'cls_guard_submission_file_insert',    'cls_submission_files_scope', true),
      ('vm_layers',            'vm_layers_zz_insert_guard',              'vm_guard_layer_insert',               'vm_layers_scope',            true),
      ('vm_flags',             'vm_flags_zz_insert_guard',               'vm_guard_flag_insert',                'vm_flags_scope',             true),
      ('sal_appointments',     'sal_appointments_zz_insert_guard',       'sal_guard_appointment_insert',        'sal_appointments_scope',     true),
      ('mm_questions',         'mm_questions_zz_insert_guard',           'mm_guard_question_insert',            null,                         true),
      ('job_requests',         'job_requests_zz_insert_guard',           'job_requests_guard_insert',           null,                         true),
      ('cls_survey_answers',   'cls_survey_answers_a_class_from_survey', 'cls_survey_answer_class_from_survey', 'cls_survey_answers_scope',   false),
      ('cls_review_comments',  'cls_review_comments_zz_insert_guard',    'cls_guard_review_comment_insert',     'cls_review_comments_scope',  true),
      ('smp_items',            'smp_items_zz_insert_guard',              'smp_guard_item_insert',               'smp_items_scope',            true),
      ('vm_reactions',         'vm_reactions_zz_insert_guard',           'vm_guard_reaction_insert',            'vm_reactions_scope',         true),
      ('vm_conversations',     'vm_conversations_zz_insert_guard',       'vm_guard_conversation_insert',        null,                         true)
    ) as v(tbl, tg, fname, scope_tg, after_scope)
  loop
    select t.tgenabled, t.tgtype, p.proname into trg
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_proc p on p.oid = t.tgfoid
     where n.nspname = 'public' and c.relname = spec.tbl and t.tgname = spec.tg and not t.tgisinternal;
    if not found then
      raise exception 'insert pins: trigger %.% missing', spec.tbl, spec.tg;
    end if;
    if trg.proname <> spec.fname then
      raise exception 'insert pins: % bound to % not %', spec.tg, trg.proname, spec.fname;
    end if;
    if trg.tgenabled <> 'O' then
      raise exception 'insert pins: % not enabled (%)', spec.tg, trg.tgenabled;
    end if;
    -- tgtype bits: 1 = ROW, 2 = BEFORE, 4 = INSERT.
    if (trg.tgtype & 1) = 0 or (trg.tgtype & 2) = 0 or (trg.tgtype & 4) = 0 then
      raise exception 'insert pins: % is not BEFORE INSERT FOR EACH ROW', spec.tg;
    end if;
    if spec.scope_tg is not null then
      if not exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                      where c.relname = spec.tbl and t.tgname = spec.scope_tg) then
        raise exception 'insert pins: scope trigger % missing', spec.scope_tg;
      end if;
      -- Postgres orders same-timing triggers by name, byte-wise: compare in "C".
      if spec.after_scope and not (spec.tg collate "C" > spec.scope_tg collate "C") then
        raise exception 'insert pins: % would fire before %', spec.tg, spec.scope_tg;
      end if;
      if not spec.after_scope and not (spec.tg collate "C" < spec.scope_tg collate "C") then
        raise exception 'insert pins: % would fire after %', spec.tg, spec.scope_tg;
      end if;
    end if;

    select p.prosecdef, p.proconfig, p.proacl into fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = spec.fname;
    if not fn.prosecdef then
      raise exception 'insert pins: % is not SECURITY DEFINER', spec.fname;
    end if;
    if fn.proconfig is null or not ('search_path=public' = any (fn.proconfig)) then
      raise exception 'insert pins: % has no pinned search_path', spec.fname;
    end if;
    if has_function_privilege('anon', format('public.%I()', spec.fname), 'execute')
       or has_function_privilege('authenticated', format('public.%I()', spec.fname), 'execute')
       or has_function_privilege('service_role', format('public.%I()', spec.fname), 'execute') then
      raise exception 'insert pins: an api role holds EXECUTE on %', spec.fname;
    end if;
  end loop;

  -- UPDATE-side mirror (section 9): bound, enabled, BEFORE UPDATE per row,
  -- ordered after (or, for the survey pin, before) the named trigger.
  for spec in
    select * from (values
      ('cls_submissions',    'cls_submissions_pin',             'cls_pin_submission_columns', null::text,                               true),
      ('cls_survey_answers', 'cls_survey_answers_0_pin',        'cls_pin_survey_answer',      'cls_survey_answers_a_class_from_survey', false),
      ('vm_layers',          'vm_layers_zz_update_pin',         'vm_pin_layer_created_at',    'vm_layers_scope',                        true),
      ('vm_flags',           'vm_flags_zz_update_pin',          'vm_pin_flag_created_at',     'vm_flags_a_pin',                         true),
      ('sal_appointments',   'sal_appointments_zz_update_pin',  'sal_pin_appointment_stamps', 'sal_appointments_pin',                   true),
      ('cls_review_assignments', 'cls_review_assignments_pin',  'cls_pin_assignment_columns', null,                                     true),
      ('cls_grades',         'cls_grades_pin_author',           'cls_pin_grade_author',       null,                                     true),
      ('cls_review_comments', 'cls_review_comments_0_pin',      'cls_pin_review_comment',     'cls_review_comments_scope',              false)
    ) as v(tbl, tg, fname, other_tg, after_other)
  loop
    select t.tgenabled, t.tgtype, p.proname into trg
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_proc p on p.oid = t.tgfoid
     where n.nspname = 'public' and c.relname = spec.tbl and t.tgname = spec.tg and not t.tgisinternal;
    if not found then
      raise exception 'update pins: trigger %.% missing', spec.tbl, spec.tg;
    end if;
    if trg.proname <> spec.fname or trg.tgenabled <> 'O' then
      raise exception 'update pins: % bound to % (enabled %)', spec.tg, trg.proname, trg.tgenabled;
    end if;
    -- tgtype bits: 1 = ROW, 2 = BEFORE, 16 = UPDATE.
    if (trg.tgtype & 1) = 0 or (trg.tgtype & 2) = 0 or (trg.tgtype & 16) = 0 then
      raise exception 'update pins: % is not BEFORE UPDATE FOR EACH ROW', spec.tg;
    end if;
    if spec.other_tg is not null then
      if not exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                      where c.relname = spec.tbl and t.tgname = spec.other_tg) then
        raise exception 'update pins: trigger % missing', spec.other_tg;
      end if;
      if spec.after_other and not (spec.tg collate "C" > spec.other_tg collate "C") then
        raise exception 'update pins: % would fire before %', spec.tg, spec.other_tg;
      end if;
      if not spec.after_other and not (spec.tg collate "C" < spec.other_tg collate "C") then
        raise exception 'update pins: % would fire after %', spec.tg, spec.other_tg;
      end if;
    end if;
    select p.prosecdef, p.proconfig, p.prosrc into fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = spec.fname;
    if not fn.prosecdef or fn.proconfig is null or not ('search_path=public' = any (fn.proconfig)) then
      raise exception 'update pins: % is not SECURITY DEFINER with a pinned search_path', spec.fname;
    end if;
    if has_function_privilege('anon', format('public.%I()', spec.fname), 'execute')
       or has_function_privilege('authenticated', format('public.%I()', spec.fname), 'execute')
       or has_function_privilege('service_role', format('public.%I()', spec.fname), 'execute') then
      raise exception 'update pins: an api role holds EXECUTE on %', spec.fname;
    end if;
  end loop;

  -- The rebuilt classroom pin kept its old pins AND gained the new ones.
  select p.prosrc into fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'cls_pin_submission_columns';
  if position('new.visible_override_until := old.visible_override_until' in fn.prosrc) = 0
     or position('new.homework_id := old.homework_id' in fn.prosrc) = 0
     or position('new.submitted_at := old.submitted_at' in fn.prosrc) = 0
     or position('new.storage_prefix := old.storage_prefix' in fn.prosrc) = 0 then
    raise exception 'update pins: cls_pin_submission_columns body is not the expected rebuild';
  end if;

  -- None of the classroom pins may exempt on the org-wide predicate any more.
  for spec in
    select unnest(array['cls_pin_submission_columns', 'cls_pin_assignment_columns', 'cls_pin_grade_author']) as fname
  loop
    select p.prosrc into fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = spec.fname;
    if position('cls_can_manage_class(old.org_id, old.class_id)' in fn.prosrc) = 0
       or position('cls_can_manage(old.org_id)' in fn.prosrc) > 0 then
      raise exception 'class pins: % still exempts org-wide', spec.fname;
    end if;
  end loop;
end;
$$;
