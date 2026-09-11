-- Visual messaging: a member may BLOCK THEMSELVES from a conversation, and an
-- admin cannot undo it by re-adding them (2026-09-10).
--
-- THE GAP. `vm_members_delete_self` already lets anyone LEAVE a conversation,
-- but leaving only deletes the seat row — and `vm_members_insert` lets a
-- conversation admin insert a fresh one immediately. So a member being harassed
-- can leave and be re-added, indefinitely, with no recourse. The mechanism that
-- WOULD stop it already exists: `status = 'banned'` is checked by every access
-- predicate and is deliberately preserved across re-invites (that is why
-- ban-for-cause keeps the row instead of deleting it). A member simply cannot
-- reach it: `vm_pin_member`'s self-service branch pins `new.status :=
-- old.status`, so the only self-update permitted is `last_seen_at`.
--
-- Recorded as owed since 2026-09-04 in docs/16 P1-3's "still open in the same
-- area" note — "permitting a self-UPDATE to status='banned' only is the
-- cheapest real mitigation" — and queued to the ad-hoc-groups build, which has
-- now been redesigned three times without shipping it. It is being taken out of
-- that queue precisely because it does not depend on any of it.
--
-- IT IS THE ONLY USER-LEVEL BLOCK ON THE PLATFORM. There is no user-level ban
-- and no rate limit anywhere (docs/16 P1-6), so until an abuse story exists
-- this is the whole of a member's self-defence.
--
-- WHAT THIS CHANGES, precisely: one branch of one trigger. The self-service
-- branch now permits exactly ONE status transition — 'active' -> 'banned', by
-- the seat holder, on their own row — and pins everything else exactly as
-- before.
--
-- WHAT IT DELIBERATELY DOES NOT CHANGE:
--   * NO SELF-UNBAN. 'banned' -> 'active' is still pinned, so a member cannot
--     lift their own block; only a conversation admin can (`vm_members_update_admin`).
--     That asymmetry is the point: the block must outlive the admin's wish to
--     undo it, or it is not a block.
--   * NO SELF-PROMOTION. `new.role := old.role` is unchanged and still runs
--     first, so nothing here lets a member change their own role.
--   * NO NEW POLICY. `vm_members_update_self` (`user_id = auth.uid()` on both
--     USING and WITH CHECK) already permits the UPDATE; the trigger was the only
--     thing preventing it. Adding a policy would have widened the surface for no
--     reason.
--   * THE LAST-ADMIN GUARD STILL BINDS. A conversation ADMIN self-banning takes
--     the `vm_is_conv_admin` branch ABOVE this one, where the existing
--     last-admin-standing check fires (`old.role = 'admin' and new.status <>
--     'active'`). So the sole admin of a conversation still cannot ban
--     themselves out of it and orphan it. Verified against the live body before
--     writing this.
--
-- CONSEQUENCE WORTH KNOWING: after self-banning, every vm predicate filters the
-- seat out (`status = 'active'` is required by vm_is_conv_member / vm_can_post /
-- vm_can_moderate / vm_is_conv_admin), so the conversation disappears for them
-- and an admin re-adding them hits the `unique (conversation_id, user_id)`
-- constraint rather than reviving access.
--
-- Forward-only, additive: one `create or replace`. The function keeps its
-- existing trigger binding (`vm_members_a_pin`, BEFORE UPDATE), its definer
-- attributes and its EXECUTE ACL, none of which `create or replace` disturbs.
-- Every attribute is restated because a replace does NOT inherit them.

create or replace function public.vm_pin_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 or public.vm_can_manage(old.org_id) then
    return new;
  end if;

  new.conversation_id := old.conversation_id;
  new.user_id := old.user_id;
  new.invited_by := old.invited_by;

  if public.vm_is_conv_admin(old.conversation_id) then
    -- Last-admin-standing: the seat keeping a conversation administrable
    -- cannot be demoted or banned away. Unchanged — and note this branch is
    -- reached BEFORE the self-service one, so an admin who self-bans is still
    -- caught here rather than by the new carve-out below.
    if old.role = 'admin' and (new.role <> 'admin' or new.status <> 'active') then
      if not exists (
        select 1 from public.vm_conversation_members
        where conversation_id = old.conversation_id
          and role = 'admin' and status = 'active' and id <> old.id
      ) then
        raise exception 'A conversation must keep at least one admin';
      end if;
    end if;
    return new;
  end if;

  -- Self-service: last_seen_at, plus ONE new transition — SELF-BLOCK.
  -- A member may set their OWN active seat to 'banned' and nothing else. The
  -- role pin runs unconditionally; the status pin now runs for every transition
  -- EXCEPT active -> banned, so self-unban ('banned' -> 'active') and every
  -- other value remain pinned to the stored row exactly as before.
  new.role := old.role;
  if not (old.status = 'active' and new.status = 'banned') then
    new.status := old.status;
  end if;
  return new;
end;
$$;
