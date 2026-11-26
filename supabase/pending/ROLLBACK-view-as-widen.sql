-- Not a migration. To roll B back, copy this into supabase/migrations/ with a NEW
-- version later than every applied one.
--
-- ROLLBACK for supabase/migrations/20261126010000_view_as_widen.sql (migration B):
-- puts back the 20261116010000 §4b policies ("no view token reads this module
-- table at all"), same names, and 20261125010000's mm_ensure_answer (NULL to
-- every view). sd_notes_no_view_as is untouched by both B and this file.

do $$
declare
  r record;
  v_n integer := 0;
begin
  for r in
    select c.relname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_policy p on p.polrelid = c.oid and p.polname = c.relname || '_no_view_as'
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname ~ '^(mm|syn|vm|sal|sd|smp)_'
      and c.relname <> 'sd_notes'
    order by c.relname
  loop
    execute pg_catalog.format('drop policy %I on public.%I', r.relname || '_no_view_as', r.relname);
    execute pg_catalog.format(
      'create policy %I on public.%I as restrictive for all to public '
      || 'using (not (select public.is_view_as_request())) with check (not (select public.is_view_as_request()))',
      r.relname || '_no_view_as', r.relname);
    v_n := v_n + 1;
  end loop;
  -- Every module table (but sd_notes) must have had one: 45 locally on
  -- 2026-11-24 (docs call it '46'; count it, don't trust it).
  if v_n < 40 or exists (
    select 1 from pg_catalog.pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and c.relname ~ '^(mm|syn|vm|sal|sd|smp)_' and c.relname <> 'sd_notes'
      and not exists (select 1 from pg_catalog.pg_policy p
                      where p.polrelid = c.oid and p.polname = c.relname || '_no_view_as')) then
    raise exception 'view_as_widen rollback: a module table without its policy (restored %)', v_n;
  end if;
end;
$$;

-- mm_ensure_answer back to migration A's version (dark to every view).
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

  if public.in_view_as() then
    -- A definer reads past mm_answers_no_view_as, so it applies the table rule
    -- itself (review 2026-11-24, MEDIUM: it used to return the stored row to
    -- ANY view, v1 included). Under this migration every view token is dark on
    -- mm_ tables, so: nothing, and no write. Migration B
    -- (supabase/migrations/20261126010000_view_as_widen.sql) re-creates this
    -- function with the widened branch (view_as_may_read, then the stored row or
    -- the unsaved default).
    return null;
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

revoke all on function public.mm_ensure_answer(uuid) from public, anon, authenticated, service_role;
grant execute on function public.mm_ensure_answer(uuid) to authenticated, service_role;
