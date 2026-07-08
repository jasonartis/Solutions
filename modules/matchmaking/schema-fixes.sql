-- Integration-review additions (2026-07-09 security review of the draft):
-- two gaps found before this becomes a real migration.

-- 1. mm_ensure_answer() is SECURITY DEFINER and therefore bypasses RLS
-- entirely — as drafted, it created an answer row for *any* authenticated
-- caller, silently skipping the role gate that mm_answers_insert_own
-- enforces for direct table writes (only 'single' may answer questions).
-- A matchmaker or a bare org member could have called the RPC and injected
-- a row into mm_answers. Add the same role check the INSERT policy uses.
create or replace function public.mm_ensure_answer(check_question_id uuid)
returns public.mm_answers
language plpgsql
security definer
set search_path = public
as $$
declare
  q public.mm_questions%rowtype;
  result public.mm_answers%rowtype;
begin
  select * into q from public.mm_questions
  where id = check_question_id and status = 'approved';
  if not found then
    raise exception 'Unknown or unapproved question %', check_question_id;
  end if;

  if not public.mm_is_single(q.org_id) then
    raise exception 'Only singles answer questions';
  end if;

  insert into public.mm_answers (org_id, question_id, user_id, position, care, dealbreaker, auto, share_with_match)
  values (
    q.org_id,
    q.id,
    auth.uid(),
    coalesce((q.admin_locks ->> 'answer')::int, floor((array_length(q.scale_labels, 1) - 1) / 2.0)::int),
    coalesce((q.admin_locks ->> 'care')::int, 0),
    coalesce((q.admin_locks ->> 'dealbreaker')::boolean, false),
    true,
    false
  )
  on conflict (question_id, user_id) do nothing
  returning * into result;

  if result.id is null then
    select * into result from public.mm_answers
    where question_id = check_question_id and user_id = auth.uid();
  end if;

  return result;
end;
$$;

-- 2. mm_answers_update_own only checked `user_id = auth.uid()` — it did not
-- stop a single from repointing their own row at a *different* question via
-- UPDATE (question_id isn't otherwise protected), which would corrupt the
-- "one row per (question, user)" invariant the scoring engine and the unique
-- constraint both assume. Pin question_id/user_id to their existing values
-- for non-staff, same technique as cls_pin_submission_columns in the
-- classroom exemplar.
--
-- Naming note: Postgres fires same-event BEFORE triggers in alphabetical
-- order by trigger name. This one is named to sort BEFORE
-- "mm_answers_before_write" so question_id is reverted first — otherwise
-- before_write would derive org_id/locks from the client's attempted
-- (wrong) question_id, and only question_id itself would get reverted after,
-- leaving org_id/position/care computed against the wrong question.
create function public.mm_pin_answer_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.mm_can_manage(old.org_id) then
    new.question_id := old.question_id;
    new.user_id := old.user_id;
  end if;
  return new;
end;
$$;

create trigger mm_answers_a_pin_identity before update on public.mm_answers
  for each row execute function public.mm_pin_answer_identity();
