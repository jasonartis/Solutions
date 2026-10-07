-- =============================================================================
-- visual-messaging: accept-first conversation seats, in EVERY org
-- =============================================================================
-- FOUNDER EXPECTATION (CLAUDE.md, queued 2026-09-04/10): "invited to a chat ->
-- accept or decline, never auto-joined", everywhere. Until now addMember
-- inserted an ACTIVE seat directly, so being added to a conversation meant
-- being in it, with its content readable, before you had said yes.
--
-- THE SHAPE (recorded as cheap when queued, and it is):
--   * a third seat status, 'pending'. Every vm_ access predicate already
--     filters POSITIVELY on status = 'active' (vm_is_conv_member,
--     vm_is_conv_admin, vm_can_post, vm_can_moderate, and the admin floor via
--     vm_seat_holds_admin_floor), so a pending seat confers NOTHING with no
--     change to any of them. The assertion block below and the RLS tests
--     check that rather than trust it.
--
-- WHAT THIS MIGRATION ADDS:
--   1. 'pending' in the status CHECK.
--   2. vm_members_c_invite (BEFORE INSERT): a seat created FOR SOMEONE ELSE is
--      forced to 'pending' and server-stamps invited_by. Enforced in the
--      database, not in addMember, because docs/03 hard rule 6 — the app layer
--      is not a gate; any conversation admin (or org manager) could otherwise
--      insert status='active' through the API directly.
--      Exceptions, each deliberate:
--        - your OWN seat (user_id = auth.uid()): the creator's bootstrap admin
--          seat and vm_join_conversation's deep-link viewer seat are both the
--          person choosing to be there — that IS consent.
--        - status 'banned' is left alone: a moderator pre-banning someone must
--          not have that silently turned into an invitation.
--        - no JWT (service role, seed, migrations): no "someone else" to
--          protect, and the worker/seed must be able to write real state.
--   3. vm_pin_member gains a CONSENT block, placed BEFORE the manager escape so
--      it binds org admins too:
--        - only the seat holder may ACCEPT (pending -> active);
--        - any OTHER caller moving a non-active seat to active (an admin
--          "unbanning") gets a PENDING seat instead — an unban is a re-invite.
--          Found by adversarial review: insert 'banned' then update to
--          'active' was a two-call forced join, and it is also how an admin
--          could silently undo a SELF-block (that half predates this
--          migration). The table cannot tell a moderation ban from a
--          self-block, so both now need the person's own yes;
--        - nobody may re-point a seat at a different person OR a different
--          conversation (the manager escape previously allowed both — the
--          conversation half was also found by review: an org owner could
--          carry an active seat from conversation A into B).
--      The self-service branch gains one transition: pending -> active.
--   4. vm_accept_conversation_invite(conversation) — SECURITY DEFINER, because
--      a pending invitee CANNOT update their own seat directly: the
--      non-definer scope trigger vm_members_scope re-reads vm_conversations
--      under the caller's RLS on every UPDATE, and a pending invitee cannot see
--      the conversation yet (that is the point), so it raises 'Unknown
--      conversation'. Same mechanism CLAUDE.md records for self-unban.
--   5. vm_my_pending_invites(org) — SECURITY DEFINER, returns the caller's OWN
--      pending invitations in that org with just enough to decide: the
--      conversation title and who invited them. Not the content.
--
-- DECLINE needs no new mechanism: vm_members_delete_self already lets a holder
-- delete their own row, DELETE does not fire the scope trigger, and a pending
-- seat never holds the admin floor, so vm_members_b_last_admin releases it.
-- Deleting (rather than marking 'declined') matches LEAVE, so a later re-invite
-- works, and keeps addMember's deliberate 23505 silence meaningful (a row
-- exists only for active, pending or self-blocked seats).
--
-- NOT CHANGED: existing ACTIVE seats stay active (no retroactive pending —
-- prod has 0 conversations, and re-asking people already in a conversation
-- would be a behaviour change nobody asked for).
-- =============================================================================

alter table public.vm_conversation_members
  drop constraint vm_conversation_members_status_check;
alter table public.vm_conversation_members
  add constraint vm_conversation_members_status_check
  check (status in ('active', 'banned', 'pending'));

-- ---------------------------------------------------------------------------
-- 2. A seat created for someone else is an INVITATION.
-- ---------------------------------------------------------------------------
create function public.vm_invite_pending()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and new.user_id <> auth.uid() then
    if new.status is distinct from 'banned' then
      new.status := 'pending';
    end if;
    -- Server-stamped, never client-supplied: the invitee is shown this name.
    new.invited_by := auth.uid();
  end if;
  return new;
end;
$$;

revoke all on function public.vm_invite_pending() from public, anon, authenticated, service_role;

-- Fires alphabetically after vm_members_a_pin (UPDATE only) and before
-- vm_members_scope; the order relative to the scope trigger does not matter,
-- as neither reads what the other writes.
create trigger vm_members_c_invite before insert on public.vm_conversation_members
  for each row execute function public.vm_invite_pending();

-- ---------------------------------------------------------------------------
-- 3. vm_pin_member — restated from 20260922030000 in full. ADDED: the consent
--    block, and pending -> active in the self-service branch. Everything else
--    (depth escape, manager escape, the three column pins, the admin floor,
--    the role pin, self-block) is unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.vm_pin_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  reinvite boolean := false;
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  -- CONSENT (20261007030000). Before the manager escape on purpose: an org
  -- admin may remove an invitation, but may not accept it on someone's behalf.
  -- No JWT = service role / seed, which may write real state.
  if auth.uid() is not null then
    if new.user_id is distinct from old.user_id then
      raise exception 'A seat cannot be moved to another person';
    end if;
    if new.conversation_id is distinct from old.conversation_id then
      raise exception 'A seat cannot be moved to another conversation';
    end if;
    if old.user_id <> auth.uid() and new.status = 'active' and old.status <> 'active' then
      if old.status = 'pending' then
        raise exception 'Only the invited person can accept an invitation';
      end if;
      -- banned -> active by someone else: an unban becomes a re-invitation.
      new.status := 'pending';
      reinvite := true;
    end if;
  end if;

  if public.vm_can_manage(old.org_id) then
    -- Stamped here and below, AFTER any client value: the invitee is shown
    -- this name, so it is never client-supplied.
    if reinvite then
      new.invited_by := auth.uid();
    end if;
    return new;
  end if;

  new.conversation_id := old.conversation_id;
  new.user_id := old.user_id;
  new.invited_by := case when reinvite then auth.uid() else old.invited_by end;

  if public.vm_is_conv_admin(old.conversation_id) then
    if public.vm_seat_holds_admin_floor(old.id)
       and (new.role <> 'admin' or new.status <> 'active') then
      if not exists (
        select 1 from public.vm_conversation_members m
        where m.conversation_id = old.conversation_id
          and m.id <> old.id
          and public.vm_seat_holds_admin_floor(m.id)
      ) then
        raise exception 'A conversation must keep at least one admin';
      end if;
    end if;
    return new;
  end if;

  -- Self-service: last_seen_at, plus exactly TWO status transitions:
  --   active  -> banned  (self-block, 20260910030000)
  --   pending -> active  (accept an invitation, 20261007030000)
  -- The role pin runs unconditionally, so accepting cannot promote.
  new.role := old.role;
  if not (
    (old.status = 'active' and new.status = 'banned')
    or (old.status = 'pending' and new.status = 'active')
  ) then
    new.status := old.status;
  end if;
  return new;
end;
$$;

revoke all on function public.vm_pin_member() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Accept.
-- ---------------------------------------------------------------------------
create function public.vm_accept_conversation_invite(check_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.vm_conversation_members
     set status = 'active'
   where conversation_id = check_conversation_id
     and user_id = auth.uid()
     and status = 'pending'
     and public.is_org_member(org_id)
     and public.vm_is_module_member(org_id);
  if not found then
    -- One message for "no invitation", "already accepted" and "you left the
    -- org": none of them is something to act on, and distinguishing them
    -- tells a caller nothing they need.
    raise exception 'No pending invitation to this conversation';
  end if;
end;
$$;

revoke all on function public.vm_accept_conversation_invite(uuid) from public, anon, authenticated, service_role;
grant execute on function public.vm_accept_conversation_invite(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. My pending invitations in one org.
--    Returns ONLY the caller's own pending seats, only while they are an
--    active member of that org (docs/19: a roster row is not authority on its
--    own), and only the title + inviter name — enough to decide, nothing of
--    the content. The inviter's display_name is already readable to a
--    co-member through profiles_select_shared_org; this does not widen that.
-- ---------------------------------------------------------------------------
create function public.vm_my_pending_invites(check_org_id uuid)
returns table (conversation_id uuid, title text, invited_by_name text, invited_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select m.conversation_id, c.title, p.display_name, m.created_at
  from public.vm_conversation_members m
  join public.vm_conversations c on c.id = m.conversation_id
  -- The inviter's name only while they are still an active member of this
  -- org: profiles_select_shared_org would not show it otherwise, and this
  -- must not be wider than that.
  left join public.profiles p
    on p.user_id = m.invited_by
   and exists (
     select 1 from public.org_members om
     where om.org_id = m.org_id and om.user_id = m.invited_by and om.status = 'active'
   )
  where m.user_id = auth.uid()
    and m.status = 'pending'
    and m.org_id = check_org_id
    and public.is_org_member(check_org_id)
  order by m.created_at desc;
$$;

revoke all on function public.vm_my_pending_invites(uuid) from public, anon, authenticated, service_role;
grant execute on function public.vm_my_pending_invites(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Apply-time assertions — catalog only, so they pass on an EMPTY database.
-- -----------------------------------------------------------------------------
do $$
declare
  chk text;
  body text;
begin
  select pg_get_constraintdef(oid) into chk from pg_constraint
  where conrelid = 'public.vm_conversation_members'::regclass and conname = 'vm_conversation_members_status_check';
  if coalesce(chk, '') not like '%''pending''%' then
    raise exception 'status check lacks pending: %', chk;
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.vm_conversation_members'::regclass
      and tgname = 'vm_members_c_invite' and tgenabled <> 'D'
  ) then
    raise exception 'vm_members_c_invite is not bound and enabled';
  end if;

  select coalesce(pg_get_functiondef('public.vm_pin_member'::regproc), '') into body;
  if body not like '%Only the invited person can accept%'
     or body not like '%cannot be moved to another conversation%'
     or body not like '%an unban becomes a re-invitation%' then
    raise exception 'vm_pin_member lacks part of the consent block';
  end if;

  -- Every access predicate must still require an ACTIVE seat — this is the
  -- whole reason a pending seat confers nothing. Asserted, not assumed.
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('vm_is_conv_member', 'vm_is_conv_admin', 'vm_can_post', 'vm_can_moderate', 'vm_seat_holds_admin_floor')) <> 5 then
    raise exception 'CONTROL: expected all five vm access predicates to exist';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('vm_is_conv_member', 'vm_is_conv_admin', 'vm_can_post', 'vm_can_moderate', 'vm_seat_holds_admin_floor')
      and pg_get_functiondef(p.oid) not like '%status = ''active''%'
  ) then
    raise exception 'a vm access predicate no longer requires status = active';
  end if;

  if has_function_privilege('anon', 'public.vm_accept_conversation_invite(uuid)', 'execute')
     or has_function_privilege('anon', 'public.vm_my_pending_invites(uuid)', 'execute') then
    raise exception 'anon can execute an invite function';
  end if;
  if not has_function_privilege('authenticated', 'public.vm_accept_conversation_invite(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.vm_my_pending_invites(uuid)', 'execute') then
    raise exception 'authenticated cannot execute an invite function';
  end if;
end $$;
