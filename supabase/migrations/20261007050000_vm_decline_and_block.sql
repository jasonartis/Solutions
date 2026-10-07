-- =============================================================================
-- Decline-and-block for conversation invitations (visual messaging), every org.
-- Founder decision 2026-10-07: option A — the block is PER CONVERSATION. A
-- per-PERSON block ("this inviter can never invite me to anything") is
-- recorded as a future enhancement in the module-4 spec, not built here.
--
-- THE GAP (recorded open by 20261007030000): Decline deletes the pending seat,
-- so nothing remembers the "no" and re-invites are unlimited. The spec said
-- the only way out was "accept, then self-block". Re-reading the code showed
-- that does not work either, for two reasons:
--   1. 20261007030000 turned an admin's banned -> active into a PENDING
--      re-invite. The table cannot tell a moderation ban from a self-block,
--      so a self-blocked person could be re-invited the same way, forever.
--   2. vm_members_delete_admin lets an admin DELETE the banned row, after
--      which an ordinary invite succeeds. Any block stored on the seat row is
--      erasable by the very people it is against.
--
-- WHAT THIS ADDS
--   1. vm_conversation_members.self_blocked — true only when the seat's OWN
--      HOLDER moved it to 'banned'. Server-maintained: never client-supplied.
--   2. vm_guard_self_block(), one function bound BEFORE INSERT, UPDATE and
--      DELETE (docs/03 #31: every half of one rule shares one definition):
--        INSERT  — self_blocked is forced false (a block cannot be forged).
--        UPDATE  — on a self-blocked seat, nobody but the holder may change
--                  status or invited_by. SILENTLY: the row keeps its values,
--                  no error, so the attempt does not confirm to the blocked-
--                  against admin that this was a self-block (the same reason
--                  addMember swallows 23505). Otherwise the marker is
--                  recomputed from the FINAL row: banned AND (already self-
--                  blocked OR the holder is the one banning).
--        DELETE  — a self-blocked seat may be deleted only by its holder
--                  (that is "unblock"); anyone else's delete is SILENTLY
--                  skipped. A MODERATION ban may no longer be deleted by the
--                  banned person (see "ALSO FIXED").
--      Runs after vm_pin_member (name sorts after vm_members_a_pin), so it sees
--      the pin's final values — including the pin turning an admin "unban"
--      into a pending re-invite, which it then reverts for a self-blocked seat.
--   3. vm_pin_member restated: the self-service branch gains pending -> banned.
--   4. vm_decline_and_block_invite(conversation) — SECURITY DEFINER, for the
--      same reason as vm_accept_conversation_invite: a pending invitee cannot
--      UPDATE their own seat directly, because the non-definer scope trigger
--      cannot resolve a conversation they cannot see.
--
-- ALSO FIXED (pre-existing, found while designing this): a person banned BY A
-- MODERATOR could delete their own seat (vm_members_delete_self has no status
-- condition), erasing the ban — and vm_join_conversation's ban check is a row
-- lookup, so they could then rejoin an open conversation by link. The original
-- migration's own comment says "deleting drops the re-join block"; nothing
-- stopped the banned person doing it. Now refused, loudly — a banned person
-- already knows they are banned, so the error leaks nothing.
--
-- UNCHANGED: cascades (pg_trigger_depth() > 1 — org/user/conversation delete)
-- pass straight through; the service role (no JWT) writes real state freely;
-- a moderation ban is still lifted by an admin exactly as before (as a pending
-- re-invite, 20261007030000); plain Decline still deletes and allows re-invite.
--
-- NOT BUILT, recorded: an "unblock" UI. The SQL path exists (the holder
-- deletes their own self-blocked seat), but no screen lists a person's blocks.
--
-- VISIBILITY, stated: self_blocked is readable wherever the seat row is —
-- by the holder and by ACTIVE members of the conversation (vm_members_select).
-- A conversation admin could already infer a self-block (a banned row no
-- moderator created), so this makes explicit what was inferable, and it is no
-- wider than the status column beside it.
--
-- Existing banned rows default to self_blocked = false. Prod holds 0
-- conversations (measured 2026-10-07), so there is nothing to backfill there.
-- =============================================================================

alter table public.vm_conversation_members
  add column self_blocked boolean not null default false;

-- ---------------------------------------------------------------------------
-- 2. The block guard.
-- ---------------------------------------------------------------------------
create function public.vm_guard_self_block()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Referential actions (depth 2: org, user or conversation cascades, and the
  -- invited_by SET NULL) and the service role (no JWT) are never a person
  -- trying to get around a block.
  if pg_trigger_depth() > 1 or auth.uid() is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'INSERT' then
    new.self_blocked := false;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if old.self_blocked and old.user_id <> auth.uid() then
      -- Someone else touching a person's own block: it stands, silently.
      new.status := old.status;
      new.invited_by := old.invited_by;
      new.self_blocked := true;
      return new;
    end if;
    new.self_blocked := new.status = 'banned'
      and (old.self_blocked or (old.status <> 'banned' and old.user_id = auth.uid()));
    return new;
  end if;

  -- DELETE
  if old.status <> 'banned' then
    return old;
  end if;
  if old.self_blocked then
    -- The holder deleting their own block is "unblock". Nobody else may
    -- erase it; skipped silently (returning null skips this row only).
    if old.user_id = auth.uid() then
      return old;
    end if;
    return null;
  end if;
  -- A moderation ban: lifting it is the moderators' call, not the banned
  -- person's.
  if old.user_id = auth.uid() then
    raise exception 'You cannot remove a ban from this conversation';
  end if;
  return old;
end;
$$;

revoke all on function public.vm_guard_self_block() from public, anon, authenticated, service_role;

-- Sorts after vm_members_a_pin / vm_members_b_last_admin / vm_members_c_invite
-- and before vm_members_scope.
create trigger vm_members_d_self_block
  before insert or update or delete on public.vm_conversation_members
  for each row execute function public.vm_guard_self_block();

-- ---------------------------------------------------------------------------
-- 3. vm_pin_member — restated from 20261007030000 in full. CHANGED: the
--    self-service branch gains pending -> banned (decline-and-block).
--    Everything else is unchanged.
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
      -- (A SELF-blocked seat is then reverted by vm_guard_self_block.)
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

  -- Self-service: last_seen_at, plus exactly THREE status transitions:
  --   active  -> banned  (self-block, 20260910030000)
  --   pending -> active  (accept an invitation, 20261007030000)
  --   pending -> banned  (decline and block, 20261007050000)
  -- The role pin runs unconditionally, so accepting cannot promote.
  new.role := old.role;
  if not (
    (old.status = 'active' and new.status = 'banned')
    or (old.status = 'pending' and new.status = 'active')
    or (old.status = 'pending' and new.status = 'banned')
  ) then
    new.status := old.status;
  end if;
  return new;
end;
$$;

revoke all on function public.vm_pin_member() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Decline and block.
-- ---------------------------------------------------------------------------
create function public.vm_decline_and_block_invite(check_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- No org-membership condition, unlike accept: blocking only ever removes
  -- access, so it is safe for anyone holding the invitation.
  update public.vm_conversation_members
     set status = 'banned'
   where conversation_id = check_conversation_id
     and user_id = auth.uid()
     and status = 'pending';
  if not found then
    raise exception 'No pending invitation to this conversation';
  end if;
  -- Asserted, not assumed: the triggers must have let it land as a self-block.
  if not exists (
    select 1 from public.vm_conversation_members
    where conversation_id = check_conversation_id
      and user_id = auth.uid()
      and status = 'banned'
      and self_blocked
  ) then
    raise exception 'Decline and block did not take effect';
  end if;
end;
$$;

revoke all on function public.vm_decline_and_block_invite(uuid) from public, anon, authenticated, service_role;
grant execute on function public.vm_decline_and_block_invite(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Apply-time assertions — catalog only, so they pass on an EMPTY database.
-- -----------------------------------------------------------------------------
do $$
declare
  body text;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'vm_conversation_members'
      and column_name = 'self_blocked' and is_nullable = 'NO'
  ) then
    raise exception 'vm_conversation_members.self_blocked is missing or nullable';
  end if;

  if (
    select count(*) from pg_trigger
    where tgrelid = 'public.vm_conversation_members'::regclass
      and tgname = 'vm_members_d_self_block' and tgenabled <> 'D'
      -- BEFORE (2) | ROW (1) | INSERT (4) | DELETE (8) | UPDATE (16)
      and (tgtype & (1 | 2 | 4 | 8 | 16)) = (1 | 2 | 4 | 8 | 16)
  ) <> 1 then
    raise exception 'vm_members_d_self_block is not bound BEFORE INSERT/UPDATE/DELETE FOR EACH ROW and enabled';
  end if;

  select coalesce(pg_get_functiondef('public.vm_pin_member'::regproc), '') into body;
  if body not like '%(old.status = ''pending'' and new.status = ''banned'')%'
     or body not like '%Only the invited person can accept%' then
    raise exception 'vm_pin_member lacks the decline-and-block transition or the consent block';
  end if;

  if has_function_privilege('anon', 'public.vm_decline_and_block_invite(uuid)', 'execute') then
    raise exception 'anon can execute vm_decline_and_block_invite';
  end if;
  if not has_function_privilege('authenticated', 'public.vm_decline_and_block_invite(uuid)', 'execute') then
    raise exception 'authenticated cannot execute vm_decline_and_block_invite';
  end if;
  if has_function_privilege('authenticated', 'public.vm_guard_self_block()', 'execute') then
    raise exception 'authenticated can execute the trigger function vm_guard_self_block';
  end if;
end $$;
