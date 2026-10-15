-- =============================================================================
-- Visual messaging: a VIEWER may react. Founder decision 2026-10-14 (module-4
-- spec, "Founder decisions (2026-10-14)"): a reaction is not a post.
--
-- Before: vm_reactions_insert_own required vm_can_post, which admits only the
-- roles participant / conversation_moderator / admin. A viewer saw the heart
-- and laugh buttons, pressed one, and the insert was refused (42501).
--
-- After: vm_reactions_insert_own requires vm_can_react — the caller holds an
-- ACTIVE seat of ANY role in the reaction's conversation, is not self-blocked,
-- and is still a member of the seat's org. Exactly vm_can_post minus the role
-- list; every other conjunct is kept on purpose:
--
--   * status = 'active'   — a PENDING invitee has consented to nothing yet
--                           (20261007030000), and a BANNED seat (moderation
--                           ban or self-block) must not react.
--   * not self_blocked    — redundant TODAY: vm_pin_member forces
--                           self_blocked => status = 'banned' (20261007050000).
--                           Stated anyway so this guarantee does not rest on a
--                           trigger in another file (docs/19 2026-09-11: a
--                           guarantee that silently lives in a trigger is how
--                           a migration header ends up describing the wrong
--                           mechanism).
--   * is_org_member(org)  — the seat-authority conjunct (20260910040000,
--                           docs/03 #20): a seat alone is not authority; a
--                           person who left the org keeps no reach through
--                           a leftover roster row.
--
-- Why NOT vm_is_conv_member: it has a second arm, vm_can_moderate_org, that is
-- true for an org-level moderator with NO seat, or with a banned/self-blocked
-- seat. Reusing it would let a person who blocked a conversation still react
-- in it. Reacting is a seat-holder's act; managers keep their own separate
-- arm (vm_reactions_insert_manage), unchanged here.
--
-- Unchanged and relied on: vm_reactions_scope (vm_sync_from_layer, BEFORE
-- INSERT, security definer) overwrites conversation_id and org_id FROM THE
-- LAYER before WITH CHECK runs, so a client cannot point the check at a
-- conversation it belongs to while reacting to a layer in another one.
--
-- NOT changed, recorded as open in the module-4 spec 2026-10-14:
-- vm_reactions_insert_manage checks only vm_can_manage(org_id) and never
-- user_id, so an org/module admin can insert a reaction AS ANOTHER USER.
-- Pre-existing since 20260709100000; separate decision.
-- =============================================================================

create function public.vm_can_react(check_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.vm_conversation_members m
    where m.conversation_id = check_conversation_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and not m.self_blocked
      and public.is_org_member(m.org_id)
  );
$$;

revoke all on function public.vm_can_react(uuid) from public, anon, authenticated, service_role;
grant execute on function public.vm_can_react(uuid) to authenticated, service_role;

drop policy vm_reactions_insert_own on public.vm_reactions;
create policy vm_reactions_insert_own on public.vm_reactions
  for insert with check (
    user_id = auth.uid()
    and public.vm_can_react(conversation_id)
  );

-- ---------------------------------------------------------------------------
-- Apply-time assertions. STRUCTURAL ONLY — migrations run against an empty
-- database before any seed (CI), so nothing here may depend on rows.
-- ---------------------------------------------------------------------------
do $$
declare
  v_check text;
  v_count int;
begin
  select with_check into v_check
  from pg_policies
  where schemaname = 'public' and tablename = 'vm_reactions'
    and policyname = 'vm_reactions_insert_own';
  if v_check is null then
    raise exception 'vm_reactions_insert_own is missing';
  end if;
  if v_check not like '%vm_can_react(conversation_id)%'
     or v_check not like '%auth.uid()%' then
    raise exception 'vm_reactions_insert_own has an unexpected check: %', v_check;
  end if;
  if v_check like '%vm_can_post%' then
    raise exception 'vm_reactions_insert_own still requires vm_can_post: %', v_check;
  end if;

  -- Exactly two INSERT policies, as before: own + manage. A third would widen.
  select count(*) into v_count
  from pg_policies
  where schemaname = 'public' and tablename = 'vm_reactions' and cmd = 'INSERT';
  if v_count <> 2 then
    raise exception 'vm_reactions has % INSERT policies, expected 2', v_count;
  end if;

  if has_function_privilege('anon', 'public.vm_can_react(uuid)', 'execute') then
    raise exception 'anon can execute vm_can_react';
  end if;
  -- The policy runs as the caller, so authenticated must hold EXECUTE, and the
  -- helper must be a definer to read seats the caller's RLS may hide.
  if not has_function_privilege('authenticated', 'public.vm_can_react(uuid)', 'execute') then
    raise exception 'authenticated cannot execute vm_can_react';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.vm_can_react(uuid)'::regprocedure) then
    raise exception 'vm_can_react is not security definer';
  end if;
end;
$$;
