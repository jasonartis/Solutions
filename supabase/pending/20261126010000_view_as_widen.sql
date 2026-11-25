-- WHOLE-ACCOUNT VIEW AS — migration B: the widening
-- (docs/13 "WHOLE-ACCOUNT VIEW AS — FOUR-WAY REVIEW …", revisions 1 and 11).
--
-- KEPT IN supabase/pending/ UNTIL migration A (20261125010000) is on prod AND the
-- app that uses whole-account sessions is deployed (Vercel READY). `migrate:prod`
-- applies every file in supabase/migrations/, so this file moves there only
-- when it is its turn. Its undo is supabase/pending/ROLLBACK-view-as-widen.sql
-- (re-creates the 20261116010000 §4b policies and A's mm_ensure_answer),
-- written before this applies.
--
-- WHAT IT DOES: each of the restrictive (45 locally; "46" in docs/13) `<table>_no_view_as` policies made by
-- 20261116010000 §4b ("no view token reads this table at all") is replaced, under
-- the SAME name, by the shared rule public.view_as_may_read(org_id, '<module>'):
-- an ordinary request reads as before; a view token reads the person's rows only
-- when its session is a superadmin's open WHOLE-ACCOUNT session. An org-scoped
-- (v1, classroom) view still reads nothing outside classroom.
--
-- sd_notes_no_view_as is NOT touched: private tables stay dark to every view
-- token for ever; their only reader is a definer through private_text()
-- (sd_my_notes). The db test asserts both halves.
--
-- ALSO (§2 below): mm_ensure_answer's view branch widens with the table — A
-- returns NULL to every view; B returns the stored row or the unsaved default
-- when view_as_may_read says so.
--
-- Policy form: `(select not public.in_view_as()) or public.view_as_may_read(…)`.
-- The first term is an initplan evaluated ONCE per query and is true for every
-- ordinary request, so the per-row definer call happens only under a view.
-- (The single-call form `(select view_as_may_read(org_id, …))` is a correlated
-- subplan run for EVERY row of EVERY request on every module table.)
-- syn_zmanim_cache / syn_zmanim_fetch_log have no org_id (shared location
-- cache): they pass null.
--
-- The loop covers exactly the tables that carry a `_no_view_as` policy today
-- (re-runnable: drop + create). An unknown prefix raises.

do $$
declare
  r record;
  v_module text;
  v_org text;
  v_rule text;
  v_n integer := 0;
begin
  for r in
    select c.oid, c.relname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_policy p on p.polrelid = c.oid and p.polname = c.relname || '_no_view_as'
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname ~ '^(mm|syn|vm|sal|sd|smp)_'
      and c.relname <> 'sd_notes'
    order by c.relname
  loop
    v_module := case pg_catalog.split_part(r.relname, '_', 1)
      when 'mm' then 'matchmaking'
      when 'syn' then 'synagogue-schedules'
      when 'vm' then 'visual-messaging'
      when 'sal' then 'nail-salon'
      when 'sd' then 'speed-dating'
      when 'smp' then 'sample'
    end;
    if v_module is null then
      raise exception 'view_as_widen: no module for %', r.relname;
    end if;
    v_org := case when exists (
        select 1 from pg_catalog.pg_attribute a
        where a.attrelid = r.oid and a.attname = 'org_id' and not a.attisdropped)
      then 'org_id' else 'null::uuid' end;
    v_rule := pg_catalog.format(
      '((select not public.in_view_as()) or public.view_as_may_read(%s, %L))', v_org, v_module);
    execute pg_catalog.format('drop policy %I on public.%I', r.relname || '_no_view_as', r.relname);
    execute pg_catalog.format(
      'create policy %I on public.%I as restrictive for all to public using %s with check %s',
      r.relname || '_no_view_as', r.relname, v_rule, v_rule);
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
    raise exception 'view_as_widen: a module table without its policy (replaced %)', v_n;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. mm_ensure_answer: the view branch widens with mm_answers' policy.
-- Identical to 20261125010000's except that branch.
-- ---------------------------------------------------------------------------
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
    -- A definer reads past mm_answers_no_view_as, so it applies the same rule
    -- the table now has: dark to an org-scoped (v1) view, a forged session, a
    -- banned/departed person (review 2026-11-24, MEDIUM).
    if not public.view_as_may_read(q.org_id, 'matchmaking') then
      return null;
    end if;
    -- The stored row, or the default the insert below would make (id null),
    -- written nowhere.
    select * into result from public.mm_answers
    where question_id = check_question_id and user_id = auth.uid();
    if not found then
      result.org_id := q.org_id;
      result.question_id := q.id;
      result.user_id := auth.uid();
      result.position := coalesce((q.admin_locks ->> 'answer')::int, floor((array_length(q.scale_labels, 1) - 1) / 2.0)::int);
      result.care := coalesce((q.admin_locks ->> 'care')::int, 0);
      result.dealbreaker := coalesce((q.admin_locks ->> 'dealbreaker')::boolean, false);
      result.auto := true;
      result.share_with_match := false;
    end if;
    return result;
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
