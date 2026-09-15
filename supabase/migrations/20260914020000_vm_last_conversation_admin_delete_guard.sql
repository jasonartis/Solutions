-- Visual messaging: the sole conversation admin can no longer LEAVE and orphan
-- the conversation (2026-09-14). docs/20 §8.2.
--
-- THE GAP, verified live before writing this. `vm_pin_member` already refuses
-- to let the last admin be demoted or banned away:
--
--     if old.role = 'admin' and (new.role <> 'admin' or new.status <> 'active')
--     then ... raise exception 'A conversation must keep at least one admin';
--
-- but it is bound BEFORE UPDATE only. `vm_conversation_members` carried exactly
-- three triggers before this migration — `_updated_at` (BEFORE UPDATE),
-- `vm_members_a_pin` (BEFORE UPDATE) and `vm_members_scope` (BEFORE INSERT OR
-- UPDATE). **None of them fires on DELETE**, while `vm_members_delete_self`
-- (`user_id = auth.uid()`) happily permits the self-DELETE. So the one
-- transition the pin exists to prevent is reachable by simply leaving instead
-- of demoting.
--
-- What that leaves behind: a conversation with layers, images and participants
-- and nobody who can add a member, remove one, or moderate it. `vm_is_conv_admin`
-- returns false for everyone, so `vm_members_insert`, `vm_members_update_admin`,
-- `vm_members_delete_admin`, `vm_conversations_update_admin` and
-- `vm_conversations_delete_admin` all close permanently. Only a vm module
-- manager can repair it.
--
-- FOUNDER MODEL (2026-09-08): transfer adminship before leaving, as Google Docs
-- requires. In a 1:1 the only transferee is the other person, so the honest
-- alternatives there are transfer-to-them or delete the conversation — which is
-- why the error names both.
--
-- ============================================================================
-- THE CASCADE TRAP — and the reason this file does not simply copy the org one
-- ============================================================================
-- `org_members_guard_last_admin` is the obvious template and it has a live bug
-- this migration must not inherit. `org_members.org_id` references
-- `orgs(id) ON DELETE CASCADE`, so deleting an org cascades into its seats,
-- fires that BEFORE DELETE guard for the last owner, and raises. **Deleting an
-- org is therefore impossible today.** Demonstrated on a throwaway org inside a
-- rolled-back transaction, 2026-09-14:
--
--     insert into orgs ... ; insert into org_members (... 'owner','active');
--     delete from orgs where slug='cascade-probe-tmp';
--     ERROR:  An org must keep at least one owner or admin
--     CONTEXT: ... "DELETE FROM ONLY public.org_members WHERE $1 = org_id"
--
-- Nobody has hit it because there is no delete-an-org surface (the same reason
-- the `deleteUser` landmine in docs/21 has not fired). Recorded in docs/20 §29;
-- NOT fixed here, because "should deleting an org be possible" is a product
-- question and this migration is about conversations.
--
-- `vm_conversation_members.conversation_id` references
-- `vm_conversations(id) ON DELETE CASCADE` — the identical shape. So this guard
-- opens with an explicit cascade escape: if the parent conversation is already
-- gone, the seats are going with it and there is no conversation left to keep
-- administrable. Asserted by a test that deletes a conversation whose only
-- admin seat is present, which fails without the escape.
--
-- WHAT THIS DELIBERATELY MIRRORS from `vm_pin_member`, so the DELETE path and
-- the UPDATE path cannot drift apart:
--   * the SAME definition of the seat that matters — `role = 'admin'` AND
--     `status = 'active'`, compared by `id <> old.id` (the seat's own PK).
--   * the SAME manager escape — `vm_can_manage(old.org_id)` returns early. A vm
--     module admin or org admin may already demote the last conversation admin
--     through the pin's first branch; refusing them the DELETE would be a new
--     and inconsistent restriction, and they are the ones who repair an
--     orphaned conversation.
--   * the SAME error text, so a caller cannot tell which path refused it.
--
-- KNOWN GAP, inherited deliberately and NOT introduced here: the floor counts
-- `role = 'admin' AND status = 'active'` with no `is_org_member(org_id)`
-- conjunct, so after `20260910040000` a seat whose holder has LEFT THE ORG —
-- and therefore confers no authority at all — still holds the floor open. The
-- effective last admin can then leave and orphan the conversation anyway.
-- `vm_pin_member`'s predicate has the identical gap, so the two paths stay
-- drift-free; closing it belongs with docs/19's module-role half, where the
-- same class is already tracked. Recorded rather than silently left.
--
-- WHAT IT DOES NOT CHANGE: a non-admin seat still leaves freely
-- (`vm_members_delete_self` is untouched), self-block is untouched (that is an
-- UPDATE and never reaches here), and `vm_members_delete_admin` still lets a
-- conversation admin remove OTHER people — including, correctly, refusing to
-- remove the last admin, which this same guard now also covers.

create or replace function public.vm_guard_last_conversation_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- (1) CASCADE ESCAPE, covering ALL THREE cascade paths into this table.
  -- `vm_conversation_members` is the child of three ON DELETE CASCADE foreign
  -- keys, not one: conversation_id -> vm_conversations, org_id -> orgs, and
  -- user_id -> auth.users. Any of them can delete a seat as a side effect, and
  -- none of them is a member choosing to leave.
  --
  -- MEASURED, not assumed (2026-09-14): a direct DELETE runs at
  -- pg_trigger_depth() = 1, an FK cascade at 2. Demonstrated with a temporary
  -- probe trigger inside a rolled-back transaction. `vm_pin_member` already
  -- opens with this same test, so the DELETE path and the UPDATE path now share
  -- one idiom.
  --
  -- An earlier draft tested `not exists (select 1 from vm_conversations ...)`
  -- instead. The adversarial review killed it: that covers only the
  -- conversation cascade. Deleting a USER would still have raised, because
  -- vm_conversations.created_by is ON DELETE SET NULL (so the conversation
  -- survives) while the seat cascades — reproducing, one foreign key over, the
  -- exact org_members bug this file's header exists to avoid. That matters
  -- because docs/21 is an ACTIVE plan to build account deletion and /privacy
  -- already promises it.
  --
  -- Safe to be this broad: no function in `public` deletes from this table
  -- (verified by regex over pg_proc.prosrc, with a control proving the regex
  -- finds the three functions that DO delete elsewhere), so depth > 1 here can
  -- only be a foreign-key cascade.
  if pg_trigger_depth() > 1 then
    return old;
  end if;

  -- (2) MANAGER ESCAPE, mirroring vm_pin_member's first branch verbatim.
  if public.vm_can_manage(old.org_id) then
    return old;
  end if;

  -- (3) Only an ACTIVE ADMIN seat can be the one keeping the conversation
  -- administrable. A participant, viewer, moderator or banned seat leaves
  -- freely, exactly as before.
  if old.role <> 'admin' or old.status <> 'active' then
    return old;
  end if;

  -- (4) The floor itself. Identical predicate to vm_pin_member's, including
  -- `id <> old.id` rather than a user comparison, so the two paths cannot drift.
  if not exists (
    select 1 from public.vm_conversation_members
    where conversation_id = old.conversation_id
      and role = 'admin'
      and status = 'active'
      and id <> old.id
  ) then
    raise exception 'A conversation must keep at least one admin';
  end if;

  return old;
end;
$$;

-- Named to sort AFTER `vm_members_a_pin` for readability only — the pin is
-- UPDATE-only so the two never fire on the same event.
drop trigger if exists vm_members_b_last_admin on public.vm_conversation_members;
create trigger vm_members_b_last_admin
  before delete on public.vm_conversation_members
  for each row execute function public.vm_guard_last_conversation_admin();

-- docs/03 convention #1: state the full intended ACL rather than relying on
-- defaults, which diverge between local and prod. A trigger function is never
-- called directly.
revoke execute on function public.vm_guard_last_conversation_admin() from public, anon, authenticated;

-- Assert the trigger is BOUND and ENABLED, not merely defined — the gap
-- scripts/prod-verify-seat-authority.mts was written to catch.
do $$
declare
  bound integer;
begin
  select count(*) into bound
  from pg_trigger
  where tgrelid = 'public.vm_conversation_members'::regclass
    and tgname = 'vm_members_b_last_admin'
    and not tgisinternal
    and tgenabled = 'O';

  if bound <> 1 then
    raise exception 'vm_members_b_last_admin is not bound and enabled (found %)', bound;
  end if;
end $$;
