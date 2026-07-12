-- Org self-management (founder ask, 2026-07-12): let org owners/admins
-- self-serve TWO things inside their OWN org that were previously
-- superadmin-only —
--   1. membership of their org (org_members): add/remove members, change an
--      existing member's org role among ('owner','admin','member');
--   2. module-specific role grants (module_roles): e.g. mark someone a 'maker'
--      for the synagogue-schedules module.
--
-- DELIBERATELY UNCHANGED: org_modules (which modules an org may use) stays
-- superadmin-only forever — enabling a module for an org is a platform-owner
-- business decision, not something an org can grant itself. This migration
-- does NOT touch org_modules RLS at all.
--
-- ADDITIVE-OR reasoning: multiple PERMISSIVE policies for the same command on
-- the same table combine with OR in Postgres. So we ADD a new org-admin-scoped
-- policy alongside the existing *_write_superadmin policies (which we leave
-- completely untouched — not replaced, not dropped). The effective write
-- permission on each table becomes "superadmin OR org-admin-of-this-org",
-- which is exactly is_org_admin()'s definition — but we key the new policies
-- on is_org_admin(org_id) directly so intent is explicit and the superadmin
-- path keeps its own dedicated policy.
--
-- Base grants already exist from 20260706120000_core.sql
-- (select/insert/update/delete on org_members + module_roles to authenticated),
-- so no new table grants are needed here — RLS is the only thing widening.

-- ---------------------------------------------------------------------------
-- 1. org_members — org admins manage their own org's membership.
--    for all => covers INSERT/UPDATE/DELETE (SELECT already allowed to members
--    via org_members_select_member). An admin can only ever touch rows whose
--    org_id is one they administer, on both the USING (existing rows) and
--    WITH CHECK (post-image) sides, so they cannot move a member into or out of
--    an org they don't run.
-- ---------------------------------------------------------------------------
create policy org_members_write_org_admin on public.org_members
  for all using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

-- ---------------------------------------------------------------------------
-- 2. module_roles — org admins grant/revoke module roles within their org.
--    No last-anything guard is needed here (unlike org_members): a module_roles
--    row never changes a person's actual authority, because every module's
--    <prefix>_can_manage() delegates to is_org_admin(), which DOMINATES
--    module_roles regardless. Revoking a module role can only ever reduce an
--    operational hat, never orphan an org. So this is just the additive policy.
-- ---------------------------------------------------------------------------
create policy module_roles_write_org_admin on public.module_roles
  for all using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

-- ---------------------------------------------------------------------------
-- 3. Last-admin-standing guard on org_members.
--
-- Mirrors the vm_conversation_members guard (20260709100000, "last-admin-
-- standing"): an org must never be left with zero owner/admin, or it becomes
-- unadministrable (no one could ever add members or manage it again short of
-- superadmin intervention).
--
-- UNCONDITIONAL by design: it fires regardless of WHO makes the change —
-- including a superadmin acting directly. This matches how other absolute pins
-- in this codebase behave (simpler and safer than trying to exempt some
-- callers; a superadmin who truly needs to empty an org can drop the org, or
-- change roles in an order that never passes through zero admins).
--
-- It only guards DELETE and UPDATE. INSERTs are untouched, so bootstrapping the
-- very first member of a brand-new org is never blocked. security definer so
-- the "does another admin remain?" probe sees every org_members row regardless
-- of the acting caller's own RLS visibility.
--
-- "Losing" a seat = an old row that WAS an owner/admin for old.org_id ceasing
-- to contribute one: on DELETE, or on UPDATE that demotes it to 'member', OR
-- that re-points it to a different org/user (defensive — those columns aren't
-- pinned here, and moving the last admin's row elsewhere is the same hazard as
-- deleting it).
-- ---------------------------------------------------------------------------
create function public.org_members_guard_last_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  losing boolean;
begin
  -- Only owner/admin rows can be the seat that keeps an org administrable.
  if old.role not in ('owner', 'admin') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    losing := true;
  else
    losing := (new.role not in ('owner', 'admin'))
           or (new.org_id <> old.org_id)
           or (new.user_id <> old.user_id);
  end if;

  if losing and not exists (
    select 1 from public.org_members
    where org_id = old.org_id
      and role in ('owner', 'admin')
      and user_id <> old.user_id
  ) then
    raise exception 'An org must keep at least one owner or admin';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger org_members_guard_last_admin
  before delete or update on public.org_members
  for each row execute function public.org_members_guard_last_admin();

-- ---------------------------------------------------------------------------
-- 4. org_find_user_by_email — narrow email->user resolver for invites.
--
-- Org admins do NOT have broad read on profiles (only their own row +
-- co-members via profiles_select_shared_org, 20260708020000). To invite
-- someone who is NOT yet in their org they must be able to turn an email they
-- were given into a user_id. This definer function is that ONE capability and
-- nothing more: it returns a profiles row ONLY when the caller is an admin of
-- check_org_id AND only for an EXACT email match — no LIKE, no listing, no
-- enumeration. A non-admin (or an admin passing an org they don't run) gets
-- zero rows. An admin who guesses a wrong email gets zero rows, so it can't be
-- used to probe which emails exist beyond a precise hit the admin already knew.
-- ---------------------------------------------------------------------------
create function public.org_find_user_by_email(check_org_id uuid, target_email text)
returns table (user_id uuid, display_name text, email text)
language sql
stable
security definer
set search_path = public
as $$
  select p.user_id, p.display_name, p.email
  from public.profiles p
  where public.is_org_admin(check_org_id)
    and p.email = target_email;
$$;

grant execute on function public.org_find_user_by_email(uuid, text) to authenticated;
