-- =============================================================================
-- Visual messaging: (A) a seat requires the MODULE ROLE, and (B) nobody,
-- managers included, can credit a row to someone else. Every org.
--
-- (A) docs/19's founder decision 1 (2026-09-11): "FULL SYMMETRY. A seat
-- requires the module role that justifies it — no per-module exceptions."
-- 20260915010000 applied it to matchmaking, nail salon and classroom; visual
-- messaging was never included. Its seat predicates checked only
-- is_org_member, so a person whose visual-messaging grant was REVOKED but who
-- stayed in the org kept reading, posting, reacting, moderating and
-- administering every conversation they held a seat in.
--
--   The fix ADDS vm_is_module_member(m.org_id) beside is_org_member(m.org_id)
--   in the five seat predicates — it does NOT replace it. vm_is_module_member
--   is true for a superadmin in ANY org (via is_org_admin -> is_superadmin), so
--   a replacement would have WIDENED a superadmin's reach to seats in orgs they
--   do not belong to. Kept both: strictly narrower.
--
--   "Holds the visual-messaging role" gets ONE definition,
--   vm_user_is_module_member(org, user), used for the caller
--   (vm_is_module_member, now a thin wrapper — body-equivalent to before) AND
--   for third parties (the last-admin floor). docs/03 #29: a caller-relative
--   helper cannot answer about someone else; docs/03 #31: the two halves of
--   one guard must share one definition.
--
--   Covered: vm_can_post, vm_can_react, vm_is_conv_member, vm_can_moderate,
--   vm_is_conv_admin (and through them every vm_ policy and the three
--   vm-images storage policies), the two inline CREATOR arms
--   (vm_conversations_select's created_by arm; vm_members_insert's re-seat
--   arm), and vm_seat_holds_admin_floor, so a role-less admin seat no longer
--   holds the floor open for the only effective admin (the 20260922030000
--   class, one dimension further).
--
-- (B) Managers (vm_can_manage: org owner/admin, or the vm `admin` role) could
--   put another person's name on a row:
--     - INSERT: vm_reactions_insert_manage, vm_layers_insert_manage and
--       vm_conversations_insert_manage checked only vm_can_manage(org_id), never
--       user_id / author_id / created_by. Now each also requires = auth.uid().
--       The app always credits the signed-in user on all three inserts.
--     - UPDATE: vm_layers_before_write, vm_pin_conversation and vm_pin_flag
--       all RETURN EARLY for a manager before pinning anything, and nothing
--       pinned vm_reactions.user_id at all. New pins, for EVERYONE:
--       vm_layers.author_id and tombstoned_by/at (server-stamped when
--       `tombstoned` flips), vm_reactions.user_id + layer_id (moving a reaction
--       to another layer is the same forgery), vm_conversations.created_by,
--       vm_flags.reporter_user_id and reviewed_by/at (server-stamped when
--       `state` flips — before, with state unchanged anyone with UPDATE could
--       write any reviewer, and reviewed_at could be backdated).
--     - vm_flags_insert_manage gains reporter_user_id = auth.uid() too
--       (found by adversarial review B, with the tombstone and review stamps).
--
-- ONE BEHAVIOUR CHANGE, recorded (review A): a member whose vm role is revoked
-- can no longer SELF-BLOCK a conversation — vm_members_scope (non-definer)
-- cannot resolve a conversation they can no longer read, and raises. They can
-- still DELETE their own seat to leave. Consistent with "no role, no
-- conversation"; the self-block guarantee now rests on the role too.
--   Service role (seed, worker) bypasses RLS; the new pins are BEFORE UPDATE
--   triggers and DO apply to it, which is intended: no job re-credits a row.
--
--   SIDE EFFECT, deliberate: vm_pin_conversation now lets a nested UPDATE
--   (pg_trigger_depth() > 1) through untouched. The ONLY nested update of
--   vm_conversations is the created_by FK's ON DELETE SET NULL (measured: no
--   function issues `update public.vm_conversations`), which the old pin
--   reverted — so deleting an auth.users row that had created a conversation
--   ABORTED (CLAUDE.md's open "deletion landmine (2)", docs/20 §30). Closed.
--
-- Measured BEFORE writing (scripts/prod-verify-vm-module-role.mts [M]): see
-- the module-4 spec's 2026-10-15 entry for the would-lose-access counts.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- A1. One definition of "holds the visual-messaging role", for anyone.
--     Body-equivalent to the old vm_is_module_member for the caller:
--       has_module_role(member)  = active org member AND unscoped `member` grant
--       vm_can_manage            = is_org_admin (superadmin, or active
--                                  owner/admin) OR has_module_role(admin)
--       has_module_role(moderator)
-- ---------------------------------------------------------------------------
create function public.vm_user_is_module_member(check_org_id uuid, check_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1 from public.org_members om
      where om.org_id = check_org_id
        and om.user_id = check_user_id
        and om.status = 'active'
        and (
          om.role in ('owner', 'admin')
          or exists (
            select 1 from public.module_roles r
            where r.org_id = check_org_id
              and r.user_id = check_user_id
              and r.module_key = 'visual-messaging'
              and r.role in ('member', 'moderator', 'admin')
              and r.scope_ref is null
          )
        )
    )
    or coalesce(
      (select up.is_superadmin from public.user_private up where up.user_id = check_user_id),
      false
    );
$$;

-- Internal: answers about ANY user, so no api role may call it (it would be a
-- role-census oracle). Definers that call it run as their owner.
revoke all on function public.vm_user_is_module_member(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.vm_is_module_member(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.vm_user_is_module_member(check_org_id, auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- A2. The five seat predicates: + vm_is_module_member(m.org_id). Everything
--     else restated verbatim from the deployed bodies.
-- ---------------------------------------------------------------------------
create or replace function public.vm_can_post(check_conversation_id uuid)
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
      and m.role in ('participant', 'conversation_moderator', 'admin')
      and public.is_org_member(m.org_id)
      and public.vm_is_module_member(m.org_id)
  );
$$;

create or replace function public.vm_can_react(check_conversation_id uuid)
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
      and public.vm_is_module_member(m.org_id)
  );
$$;

create or replace function public.vm_is_conv_member(check_conversation_id uuid)
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
      and public.is_org_member(m.org_id)
      and public.vm_is_module_member(m.org_id)
  )
  or exists (
    select 1 from public.vm_conversations c
    where c.id = check_conversation_id
      and public.vm_can_moderate_org(c.org_id)
  );
$$;

create or replace function public.vm_can_moderate(check_conversation_id uuid)
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
      and m.role in ('conversation_moderator', 'admin')
      and public.is_org_member(m.org_id)
      and public.vm_is_module_member(m.org_id)
  )
  or exists (
    select 1 from public.vm_conversations c
    where c.id = check_conversation_id
      and public.vm_can_moderate_org(c.org_id)
  );
$$;

create or replace function public.vm_is_conv_admin(check_conversation_id uuid)
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
      and m.role = 'admin'
      and public.is_org_member(m.org_id)
      and public.vm_is_module_member(m.org_id)
  )
  or exists (
    select 1 from public.vm_conversations c
    where c.id = check_conversation_id
      and public.vm_can_manage(c.org_id)
  );
$$;

-- ---------------------------------------------------------------------------
-- A3. The last-admin floor counts only seats whose holder still holds the
--     module role. Restated from 20260922030000 + the one conjunct.
-- ---------------------------------------------------------------------------
create or replace function public.vm_seat_holds_admin_floor(check_member_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.vm_conversation_members m
    where m.id = check_member_id
      and m.role = 'admin'
      and m.status = 'active'
      and exists (
        select 1
        from public.org_members om
        where om.org_id = m.org_id
          and om.user_id = m.user_id
          and om.status = 'active'
      )
      and public.vm_user_is_module_member(m.org_id, m.user_id)
  );
$$;

-- ---------------------------------------------------------------------------
-- A4. The two inline creator arms.
-- ---------------------------------------------------------------------------
drop policy vm_conversations_select on public.vm_conversations;
create policy vm_conversations_select on public.vm_conversations
  for select using (
    (created_by = auth.uid() and public.vm_is_module_member(org_id))
    or public.vm_is_conv_member(id)
  );

-- org_id on the seat is re-derived from the conversation by the BEFORE INSERT
-- scope trigger, so WITH CHECK judges the conversation's real org.
drop policy vm_members_insert on public.vm_conversation_members;
create policy vm_members_insert on public.vm_conversation_members
  for insert with check (
    public.vm_is_conv_admin(conversation_id)
    or (
      user_id = auth.uid()
      and role = 'admin'
      and status = 'active'
      and public.vm_created_conversation(conversation_id)
      and public.vm_is_module_member(org_id)
    )
  );

-- ---------------------------------------------------------------------------
-- B1. Manager INSERT arms: credited to yourself only.
-- ---------------------------------------------------------------------------
drop policy vm_reactions_insert_manage on public.vm_reactions;
create policy vm_reactions_insert_manage on public.vm_reactions
  for insert with check (user_id = auth.uid() and public.vm_can_manage(org_id));

drop policy vm_layers_insert_manage on public.vm_layers;
create policy vm_layers_insert_manage on public.vm_layers
  for insert with check (author_id = auth.uid() and public.vm_can_manage(org_id));

drop policy vm_conversations_insert_manage on public.vm_conversations;
create policy vm_conversations_insert_manage on public.vm_conversations
  for insert with check (created_by = auth.uid() and public.vm_can_manage(org_id));

-- ---------------------------------------------------------------------------
-- B2. UPDATE pins that hold for managers too.
-- ---------------------------------------------------------------------------
-- vm_layers: a separate trigger rather than restating vm_layers_before_write
-- (whose manager escape returns before every pin). Named `a_` so it fires
-- before vm_layers_scope. Pins, for everyone:
--   * author_id — never changes.
--   * tombstoned_by / tombstoned_at — server-stamped from the caller when
--     `tombstoned` flips (exactly what vm_tombstone_layer / vm_restore_layer
--     write), otherwise kept. Review B: a manager could set tombstoned_by to
--     anyone without tombstoning anything.
-- A nested update (depth > 1) passes untouched: tombstoned_by's FK is
-- ON DELETE SET NULL, and the child_count bumps from vm_layers_before_write
-- are internal. A user's own statement (and any RPC's) is depth 1.
create function public.vm_layers_pin_credit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;
  new.author_id := old.author_id;
  if new.tombstoned is distinct from old.tombstoned then
    if new.tombstoned then
      new.tombstoned_by := auth.uid();
      new.tombstoned_at := now();
    else
      new.tombstoned_by := null;
      new.tombstoned_at := null;
    end if;
  else
    new.tombstoned_by := old.tombstoned_by;
    new.tombstoned_at := old.tombstoned_at;
  end if;
  return new;
end;
$$;
revoke all on function public.vm_layers_pin_credit() from public, anon, authenticated, service_role;
create trigger vm_layers_a_pin_credit
  before update on public.vm_layers
  for each row execute function public.vm_layers_pin_credit();

-- vm_flags (review B): the manager INSERT arm never checked the reporter, and
-- vm_pin_flag's manager escape returned before pinning reporter_user_id. Also,
-- for everyone, reviewed_by/reviewed_at were only stamped when `state`
-- changed — with state unchanged a client-supplied reviewer passed — and a
-- client could backdate reviewed_at (coalesce(new.reviewed_at, now())).
-- Now: reporter pinned for everyone; review stamp = (auth.uid(), now()) when
-- state changes, otherwise kept. Restated in full; the non-manager pins are
-- unchanged. depth > 1: reviewed_by's FK is ON DELETE SET NULL.
drop policy vm_flags_insert_manage on public.vm_flags;
create policy vm_flags_insert_manage on public.vm_flags
  for insert with check (reporter_user_id = auth.uid() and public.vm_can_manage(org_id));

create or replace function public.vm_pin_flag()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return new; -- referential action: the reviewer's account was deleted (SET NULL)
  end if;
  new.reporter_user_id := old.reporter_user_id;
  if new.state is distinct from old.state then
    new.reviewed_by := auth.uid();
    new.reviewed_at := now();
  else
    new.reviewed_by := old.reviewed_by;
    new.reviewed_at := old.reviewed_at;
  end if;
  if public.vm_can_manage(old.org_id) then
    return new;
  end if;
  new.layer_id := old.layer_id;
  new.conversation_id := old.conversation_id;
  new.detail := old.detail;
  new.reason := old.reason;
  return new;
end;
$$;

-- vm_reactions: user_id and layer_id never change (vm_reactions_scope then
-- re-derives conversation_id/org_id from the pinned layer). Both FKs are
-- ON DELETE CASCADE.
create function public.vm_reactions_pin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.user_id := old.user_id;
  new.layer_id := old.layer_id;
  return new;
end;
$$;
revoke all on function public.vm_reactions_pin() from public, anon, authenticated, service_role;
create trigger vm_reactions_a_pin
  before update on public.vm_reactions
  for each row execute function public.vm_reactions_pin();

-- vm_conversations: created_by pinned for everyone at depth 1; a nested
-- update (the FK's ON DELETE SET NULL) passes untouched. Restated from the
-- deployed body; org_id stays a manager-only change, as before.
create or replace function public.vm_pin_conversation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return new; -- referential action: the creator's account was deleted (SET NULL)
  end if;
  new.created_by := old.created_by;
  if public.vm_can_manage(old.org_id) then
    return new;
  end if;
  new.org_id := old.org_id;
  return new; -- title/settings/frozen are the conv-admin's to change (RLS gates who)
end;
$$;

-- ---------------------------------------------------------------------------
-- Apply-time assertions. STRUCTURAL ONLY (CI applies this to an empty DB).
-- ---------------------------------------------------------------------------
-- Every lookup is guarded with `p is null or ...`: a missing row leaves p NULL,
-- and `NULL not like ...` is NULL, which would NOT raise (review B).
do $$
declare
  f text;
  p text;
  n int;
begin
  foreach f in array array['vm_can_post', 'vm_can_react', 'vm_is_conv_member', 'vm_can_moderate', 'vm_is_conv_admin'] loop
    select prosrc into p from pg_proc where proname = f and pronamespace = 'public'::regnamespace;
    if p is null or p not like '%is_org_member(m.org_id)%' or p not like '%vm_is_module_member(m.org_id)%' then
      raise exception '% lacks one of its two membership conjuncts', f;
    end if;
  end loop;

  select prosrc into p from pg_proc where proname = 'vm_seat_holds_admin_floor' and pronamespace = 'public'::regnamespace;
  if p is null or p not like '%vm_user_is_module_member(m.org_id, m.user_id)%' then
    raise exception 'vm_seat_holds_admin_floor lacks the module-role conjunct';
  end if;
  select prosrc into p from pg_proc where proname = 'vm_is_module_member' and pronamespace = 'public'::regnamespace;
  if p is null or p not like '%vm_user_is_module_member(check_org_id, auth.uid())%' then
    raise exception 'vm_is_module_member is not the wrapper';
  end if;

  select with_check into p from pg_policies where tablename = 'vm_reactions' and policyname = 'vm_reactions_insert_manage';
  if p is null or p not like '%user_id = auth.uid()%' then raise exception 'vm_reactions_insert_manage: %', p; end if;
  select with_check into p from pg_policies where tablename = 'vm_layers' and policyname = 'vm_layers_insert_manage';
  if p is null or p not like '%author_id = auth.uid()%' then raise exception 'vm_layers_insert_manage: %', p; end if;
  select with_check into p from pg_policies where tablename = 'vm_conversations' and policyname = 'vm_conversations_insert_manage';
  if p is null or p not like '%created_by = auth.uid()%' then raise exception 'vm_conversations_insert_manage: %', p; end if;
  select with_check into p from pg_policies where tablename = 'vm_flags' and policyname = 'vm_flags_insert_manage';
  if p is null or p not like '%reporter_user_id = auth.uid()%' then raise exception 'vm_flags_insert_manage: %', p; end if;

  select qual into p from pg_policies where tablename = 'vm_conversations' and policyname = 'vm_conversations_select';
  if p is null or p not like '%vm_is_module_member(org_id)%' then raise exception 'vm_conversations_select creator arm: %', p; end if;
  select with_check into p from pg_policies where tablename = 'vm_conversation_members' and policyname = 'vm_members_insert';
  if p is null or p not like '%vm_is_module_member(org_id)%' then raise exception 'vm_members_insert creator arm: %', p; end if;

  -- The pins run BEFORE their manager escapes.
  select prosrc into p from pg_proc where proname = 'vm_pin_flag' and pronamespace = 'public'::regnamespace;
  if p is null or position('new.reporter_user_id := old.reporter_user_id' in p) = 0
     or position('new.reporter_user_id := old.reporter_user_id' in p) > position('vm_can_manage' in p) then
    raise exception 'vm_pin_flag does not pin the reporter before the manager escape';
  end if;
  select prosrc into p from pg_proc where proname = 'vm_pin_conversation' and pronamespace = 'public'::regnamespace;
  if p is null or position('new.created_by := old.created_by' in p) = 0
     or position('new.created_by := old.created_by' in p) > position('vm_can_manage' in p) then
    raise exception 'vm_pin_conversation does not pin created_by before the manager escape';
  end if;

  select count(*) into n from pg_trigger
  where not tgisinternal and tgenabled <> 'D'
    and (tgrelid, tgname) in (('public.vm_layers'::regclass, 'vm_layers_a_pin_credit'),
                              ('public.vm_reactions'::regclass, 'vm_reactions_a_pin'));
  if n <> 2 then raise exception 'pin triggers bound: % of 2', n; end if;

  if has_function_privilege('authenticated', 'public.vm_user_is_module_member(uuid, uuid)', 'execute')
     or has_function_privilege('anon', 'public.vm_user_is_module_member(uuid, uuid)', 'execute') then
    raise exception 'vm_user_is_module_member is callable by an api role';
  end if;
  if not has_function_privilege('authenticated', 'public.vm_is_module_member(uuid)', 'execute') then
    raise exception 'authenticated lost EXECUTE on vm_is_module_member';
  end if;
end;
$$;
