-- =============================================================================
-- mm_assignment_covers_me: drop the parameter it never read
-- =============================================================================
-- WHY (docs/24 §6b.1 item 3, found by the census slice's adversarial review):
-- the function was declared
--     mm_assignment_covers_me(check_matchmaker_id, check_target_group_id,
--                             check_target_user_id)
-- and its body has NEVER referenced check_matchmaker_id — not in
-- 20260709020000, not in 20260910040000, not in 20260915010000 (verified in
-- the deployed body). So mm_assignments_select's second arm READ as a
-- matchmaker check and was really "any assignment row that targets me, or a
-- group I am a single in". That outcome is the intended one (a single learns
-- who their own matchmaker is), so nothing leaked — but a SECURITY DEFINER in
-- an RLS policy whose signature lies is exactly what the next reader trusts.
--
-- WHAT CHANGES: the signature only. The body is byte-for-byte the
-- 20260915010000 body (own-target arm deliberately ungated per docs/19 §6,
-- group arm gated on is_org_member + mm_is_single). BEHAVIOUR IS UNCHANGED:
-- same rows readable by the same callers. The name is kept on purpose — "the
-- assignment covers me" is accurate once the misleading argument is gone, and
-- three prod-verify scripts and the RLS suite look the function up by name.
--
-- ORDER MATTERS: the policy depends on the 3-arg function, so create the
-- 2-arg overload, repoint the policy, THEN drop the 3-arg one (a plain drop,
-- never CASCADE — if anything else still depended on it we want this
-- migration to fail, not to silently drop that thing too).
-- =============================================================================

create function public.mm_assignment_covers_me(
  check_target_group_id uuid,
  check_target_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select check_target_user_id = auth.uid()
      or (
        check_target_group_id is not null
        and exists (
          select 1 from public.mm_group_members gm
          where gm.group_id = check_target_group_id
            and gm.user_id = auth.uid()
            and public.is_org_member(gm.org_id)
            and public.mm_is_single(gm.org_id)
        )
      );
$$;

comment on function public.mm_assignment_covers_me(uuid, uuid) is
  'True when an mm_matchmaker_assignments row targets the caller directly, or targets a group the caller is an active single in. Takes NO matchmaker argument on purpose: it answers "does this assignment cover me", never "is this my matchmaker". The own-target arm is deliberately ungated (docs/19 §6).';

-- Full intended ACL, stated explicitly (docs/03 #1, #27): revoke from every
-- role first, then grant exactly who needs it. authenticated needs EXECUTE
-- because RLS evaluates the policy as the caller; service_role matches the
-- 3-arg function's grant from 20260728010000 (the worker reads as it).
revoke all on function public.mm_assignment_covers_me(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.mm_assignment_covers_me(uuid, uuid) to authenticated, service_role;

-- Same policy as 20260915010000 §1.3, with only the call changed.
drop policy if exists mm_assignments_select on public.mm_matchmaker_assignments;
create policy mm_assignments_select on public.mm_matchmaker_assignments
  for select using (
    (
      matchmaker_id = auth.uid()
      and public.is_org_member(org_id)
      and public.mm_is_matchmaker(org_id)
    )
    or public.mm_assignment_covers_me(target_group_id, target_user_id)
  );

drop function public.mm_assignment_covers_me(uuid, uuid, uuid);

-- -----------------------------------------------------------------------------
-- Apply-time assertions. Structural only — they must pass on an EMPTY database
-- (CI applies migrations before any seed; see CLAUDE.md, 20260928010000).
-- -----------------------------------------------------------------------------
do $$
declare
  n_overloads int;
  n_args int;
  pol text;
begin
  select count(*) into n_overloads
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'mm_assignment_covers_me';
  if n_overloads <> 1 then
    raise exception 'expected exactly one mm_assignment_covers_me, found %', n_overloads;
  end if;

  select p.pronargs into n_args
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'mm_assignment_covers_me';
  if n_args <> 2 then
    raise exception 'mm_assignment_covers_me should take 2 arguments, takes %', n_args;
  end if;

  select pg_get_expr(polqual, polrelid) into pol
  from pg_policy
  where polrelid = 'public.mm_matchmaker_assignments'::regclass
    and polname = 'mm_assignments_select';
  if pol is null then
    raise exception 'mm_assignments_select is missing';
  end if;
  if pol not ilike '%mm_assignment_covers_me(target_group_id, target_user_id)%' then
    raise exception 'mm_assignments_select does not call the 2-arg function: %', pol;
  end if;
  if pol ilike '%mm_assignment_covers_me(matchmaker_id%' then
    raise exception 'mm_assignments_select still passes matchmaker_id: %', pol;
  end if;

  if has_function_privilege('anon', 'public.mm_assignment_covers_me(uuid, uuid)', 'execute') then
    raise exception 'anon can execute mm_assignment_covers_me';
  end if;
  -- The positive half: RLS evaluates the policy AS the caller, so without
  -- this grant every authenticated read of mm_matchmaker_assignments 42501s.
  if not has_function_privilege('authenticated', 'public.mm_assignment_covers_me(uuid, uuid)', 'execute') then
    raise exception 'authenticated cannot execute mm_assignment_covers_me';
  end if;
end $$;
