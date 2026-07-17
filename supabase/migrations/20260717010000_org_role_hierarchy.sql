-- Org role hierarchy: superadmin > owner > admin > member (2026-07-17).
--
-- Founder decision (testing round): the three org roles should form a real
-- RANK ladder, not the flat "owner=admin" model they've been until now.
-- "Superadmin adds an owner, an owner adds admins, admins add members; every
-- level can control all levels BELOW them." Concretely: a caller may
-- create/change/remove an org_members seat only if the caller strictly
-- outranks BOTH the seat's current role and its target role.
--
-- Ranks: superadmin = 4 (a profiles flag, not an org role), owner = 3,
-- admin = 2, member = 1. So:
--   * only a superadmin can create/manage an OWNER seat (4 > 3);
--   * an owner can create/manage admins and members, but not other owners;
--   * an admin can create/manage members only — NOT other admins/owners, and
--     cannot promote anyone TO admin (that's an owner action);
--   * a member manages no one.
--
-- This SUBSUMES two earlier guards, cleanly:
--   * The self-seat guard (20260716030000): you never strictly outrank your
--     OWN seat (equal rank), so self-demote/remove is blocked automatically —
--     dropped below to avoid a redundant second guard.
--   * The founder's "can an admin touch another admin?" open question — no,
--     equal rank, the hierarchy answers it.
-- The last-admin-standing guard (20260712010000) is KEPT: it's orthogonal
-- (guards the zero-owner/admin FLOOR, incl. against superadmin actions) and
-- composes with this one.
--
-- NOT changed: is_org_admin() still means owner-OR-admin, so both keep full
-- ORG management (settings, module-role grants, etc.) — the hierarchy governs
-- only who-manages-whom in org_members, per the founder's "admins keep full
-- powers" call. The RLS write policy (org_members_write_org_admin) is
-- likewise unchanged; it gates "may attempt a write" (owner/admin), and this
-- trigger tightens it to the rank rule.

-- Numeric rank of an org role string. Unknown/NULL -> 0 (below member).
create function public.org_role_rank(role text)
returns integer
language sql
immutable
as $$
  select case role
    when 'owner' then 3
    when 'admin' then 2
    when 'member' then 1
    else 0
  end;
$$;

-- The CALLER's effective rank in a given org: superadmin -> 4; otherwise the
-- rank of their own committed org_members seat (0 if they aren't a member).
-- security definer so it can read org_members regardless of the caller's RLS.
create function public.org_caller_rank(check_org_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.is_superadmin() then 4
    else coalesce(
      (select public.org_role_rank(role)
         from public.org_members
        where org_id = check_org_id and user_id = auth.uid()),
      0)
  end;
$$;

-- The enforcement. BEFORE INSERT/UPDATE/DELETE so the caller gets a clear
-- error rather than a silent RLS no-op. Service role (auth.uid() is null —
-- the worker/seed, trusted, filters by org itself) and superadmin bypass.
create function public.org_members_guard_hierarchy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_rank integer;
begin
  -- Service role (no JWT) and superadmin are exempt.
  if auth.uid() is null or public.is_superadmin() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'INSERT' then
    caller_rank := public.org_caller_rank(new.org_id);
    if caller_rank <= public.org_role_rank(new.role) then
      raise exception 'You can only add someone at a role below your own (% cannot grant %)',
        caller_rank, new.role;
    end if;
    return new;
  elsif tg_op = 'UPDATE' then
    caller_rank := public.org_caller_rank(old.org_id);
    -- Must strictly outrank the seat as it stands to touch it at all.
    if caller_rank <= public.org_role_rank(old.role) then
      raise exception 'You cannot manage a member whose role is at or above your own';
    end if;
    -- Cannot re-point/move a seat to a different user or org.
    if new.user_id <> old.user_id or new.org_id <> old.org_id then
      raise exception 'A membership row cannot be reassigned to a different user or organization';
    end if;
    -- Cannot promote anyone to your own level or above.
    if caller_rank <= public.org_role_rank(new.role) then
      raise exception 'You cannot promote someone to a role at or above your own';
    end if;
    return new;
  else -- DELETE
    caller_rank := public.org_caller_rank(old.org_id);
    if caller_rank <= public.org_role_rank(old.role) then
      raise exception 'You cannot remove a member whose role is at or above your own';
    end if;
    return old;
  end if;
end;
$$;

create trigger org_members_guard_hierarchy
  before insert or update or delete on public.org_members
  for each row execute function public.org_members_guard_hierarchy();

-- Drop the self-seat guard — fully subsumed (you never outrank your own seat).
drop trigger org_members_guard_self_admin on public.org_members;
drop function public.org_members_guard_self_admin();
