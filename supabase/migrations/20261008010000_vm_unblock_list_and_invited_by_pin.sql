-- =============================================================================
-- Visual messaging: the two items left open by 20261007050000, every org.
--
--   1. vm_my_blocked_conversations(org) — SECURITY DEFINER, returns the
--      caller's OWN self-blocked seats in that org with the conversation title,
--      so the module page can list them with an Unblock button. A definer for
--      the same reason as vm_my_pending_invites: a banned seat cannot read its
--      conversation, so the title is otherwise unreachable. Unblocking needs no
--      new mechanism: the holder deletes their own self-blocked seat, which
--      vm_guard_self_block already allows (and only for the holder).
--      Only self_blocked seats are listed — a MODERATION ban is not the
--      person's to lift, and is not listed.
--
--   2. invited_by is server-stamped on EVERY path. Two paths still let a
--      client write it (recorded open by 20261007030000 and 20261007050000):
--        a. vm_pin_member's MANAGER ESCAPE returned early without pinning it,
--           so an org manager could set any seat's invited_by on an ordinary
--           update (e.g. a role change) — making an invitation appear to come
--           from someone else, since vm_my_pending_invites shows that name.
--           Now pinned there exactly as on the non-manager path: old value,
--           or auth.uid() for a re-invite.
--        b. vm_invite_pending stamped it only for seats created for someone
--           ELSE, so your own seat (creator bootstrap) kept whatever the client
--           sent. Nobody is shown that value today, but "invited by" on a seat
--           nobody invited is false data; now forced null.
--      The service role (no JWT) is unchanged on both paths — seed and worker
--      write real state.
--
-- Both functions are restated in FULL; everything not named above is
-- unchanged (diff against 20261007050000 and 20261007030000).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. My self-blocked conversations in one org.
-- ---------------------------------------------------------------------------
create function public.vm_my_blocked_conversations(check_org_id uuid)
returns table (conversation_id uuid, title text, blocked_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select m.conversation_id, c.title, m.updated_at
  from public.vm_conversation_members m
  join public.vm_conversations c on c.id = m.conversation_id
  where m.user_id = auth.uid()
    and m.status = 'banned'
    and m.self_blocked
    and m.org_id = check_org_id
    and public.is_org_member(check_org_id)
  order by m.updated_at desc;
$$;

revoke all on function public.vm_my_blocked_conversations(uuid) from public, anon, authenticated, service_role;
grant execute on function public.vm_my_blocked_conversations(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2b. vm_invite_pending — restated from 20261007030000. CHANGED: your own
--     seat gets invited_by = null.
-- ---------------------------------------------------------------------------
create or replace function public.vm_invite_pending()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    if new.user_id <> auth.uid() then
      if new.status is distinct from 'banned' then
        new.status := 'pending';
      end if;
      -- Server-stamped, never client-supplied: the invitee is shown this name.
      new.invited_by := auth.uid();
    else
      -- Your own seat: nobody invited you (20261008010000).
      new.invited_by := null;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.vm_invite_pending() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2a. vm_pin_member — restated from 20261007050000. CHANGED: the manager
--     escape pins invited_by.
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
    -- Pinned here too (20261008010000), AFTER any client value: the invitee
    -- is shown this name, so it is never client-supplied — not even by an
    -- org manager. Old value, or the re-inviter.
    new.invited_by := case when reinvite then auth.uid() else old.invited_by end;
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

-- -----------------------------------------------------------------------------
-- Apply-time assertions — catalog only, so they pass on an EMPTY database.
-- -----------------------------------------------------------------------------
do $$
declare
  body text;
begin
  select coalesce(pg_get_functiondef('public.vm_pin_member'::regproc), '') into body;
  if body not like '%Pinned here too (20261008010000)%'
     or body not like '%Only the invited person can accept%'
     or body not like '%(old.status = ''pending'' and new.status = ''banned'')%' then
    raise exception 'vm_pin_member lacks the manager invited_by pin, the consent block, or decline-and-block';
  end if;

  select coalesce(pg_get_functiondef('public.vm_invite_pending'::regproc), '') into body;
  if body not like '%nobody invited you%' then
    raise exception 'vm_invite_pending does not null invited_by on an own seat';
  end if;

  if has_function_privilege('anon', 'public.vm_my_blocked_conversations(uuid)', 'execute') then
    raise exception 'anon can execute vm_my_blocked_conversations';
  end if;
  if not has_function_privilege('authenticated', 'public.vm_my_blocked_conversations(uuid)', 'execute') then
    raise exception 'authenticated cannot execute vm_my_blocked_conversations';
  end if;
end $$;
