-- ADMIN FLOORS STOP COUNTING SOMEONE WHO IS LEAVING (docs/21 §7.10, review of
-- 2026-10-09).
--
-- THE BUG. Two guards keep a thing administrable by refusing to remove its last
-- admin: the org floor (`org_members_guard_last_admin`) and the module Director
-- floor (`module_roles_guard_last_director`). Each counted ANY active holder —
-- including a person in the 30-day grace period of an account deletion, or
-- removed from the platform by a superadmin.
--
-- Worked case: an org with admins A and B. B asks to delete their account (or
-- is removed). A then leaves the org or steps down to member — allowed, because
-- B still "holds" the floor. On day 30 the silhouette must revoke B's
-- membership, and that delete is refused: B is now the sole admin. The daily
-- job records `sole_admin` and fails for B every day, forever. B cannot fix it:
-- signing in cancels their own deletion, and a removed person cannot sign in at
-- all. Only a superadmin can unwedge it.
--
-- THE RULE, and it is the one `account_deletion_blockers` already applies
-- (20261007090000): someone who is leaving does not count as the one who stays.
-- `account_pending_departure(user)` is that test — true during a live grace
-- period, and always for a removal (20261008020000). So A's step-down is now
-- refused with the ordinary floor message while B is leaving, exactly as if B
-- were not there. If B cancels by signing in, B counts again.
--
-- WHAT IS DELIBERATELY NOT CHANGED
--   * The SILHOUETTE's own delete of B's seats still passes when a real admin
--     remains: B is excluded as `old.user_id`, and A is not leaving.
--   * The org cascade escape (20260928010000) is untouched and stays first.
--   * The Director floor's bypass for no-session/superadmin/org-admin callers is
--     untouched — those callers can already remove a Director outright.
--   * ⚠ THE CONVERSATION FLOOR (`vm_seat_holds_admin_floor`) IS DELIBERATELY
--     LEFT AS IT WAS. The first draft changed it too, and a regression review
--     (2026-10-09) showed why that is wrong. With a co-admin leaving, the
--     REMAINING conversation admin could no longer leave the conversation or
--     SELF-BLOCK (vm_pin_member) — and self-block is the platform's only
--     user-level block. The realistic case is a superadmin removing an abuser
--     who was co-admin: the person being protected would lose their way out.
--     And the wedge above does not apply there, because the silhouette never
--     touches conversation seats. The cost of leaving it alone is that a
--     conversation can end with no EFFECTIVE admin after day 30, which ordinary
--     org departure already causes and is accepted (docs/19).
--   * The org floor has no superadmin bypass, so a superadmin cannot directly
--     delete a departing sole admin's seat either. The way out of a wedge that
--     ALREADY exists (a removal skips the blocker check) is to promote a third
--     member to admin, or `account_cancel_deletion`.
--
-- Each function below is the CURRENT deployed body with one added conjunct,
-- marked "(20261009030000)". Bodies avoid the words that trip the email
-- ratchet (packages/db/src/profiles-public-columns.test.ts).

-- ---------------------------------------------------------------------------
-- 1. The org floor
-- ---------------------------------------------------------------------------
create or replace function public.org_members_guard_last_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  losing boolean;
begin
  -- THE ONLY NEW CLAUSE. Both halves are load-bearing: the depth test proves
  -- this is a referential action rather than someone's own DELETE (fail
  -- closed), and the parent-existence test proves it is the ORGS cascade
  -- rather than the auth.users one (which must still be refused).
  if tg_op = 'DELETE'
     and pg_trigger_depth() > 1
     and not exists (select 1 from public.orgs o where o.id = old.org_id)
  then
    return old;
  end if;

  -- A non-active seat never counted toward the admin floor.
  if old.status <> 'active' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- Only owner/admin rows can be the seat that keeps an org administrable.
  if old.role not in ('owner', 'admin') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    losing := true;
  else
    losing := (new.role not in ('owner', 'admin'))
           or (new.org_id <> old.org_id)
           or (new.user_id <> old.user_id)
           or (new.status <> 'active');
  end if;

  if losing and not exists (
    select 1 from public.org_members
    where org_id = old.org_id
      and role in ('owner', 'admin')
      and status = 'active'
      and user_id <> old.user_id
      -- (20261009030000) someone leaving the platform does not hold the floor
      and not public.account_pending_departure(user_id)
  ) then
    raise exception 'An org must keep at least one owner or admin';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The module Director floor
-- ---------------------------------------------------------------------------
create or replace function public.module_roles_guard_last_director()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  losing boolean;
begin
  if public.module_position_rank(old.module_key, old.role) < 4 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if auth.uid() is null
     or public.is_superadmin()
     or public.is_org_admin(old.org_id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    losing := true;
  else
    losing := public.module_position_rank(new.module_key, new.role) < 4
           or new.org_id <> old.org_id
           or new.module_key <> old.module_key
           or new.user_id <> old.user_id
           or (new.scope_ref is distinct from old.scope_ref);
  end if;
  if losing and not exists (
    select 1 from public.module_roles
    where org_id = old.org_id
      and module_key = old.module_key
      and public.module_position_rank(module_key, role) >= 4
      and user_id <> old.user_id
      -- (20261009030000) someone leaving the platform does not hold the floor
      and not public.account_pending_departure(user_id)
  ) then
    raise exception 'A module must keep at least one Director';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- `create or replace` keeps each function's existing ACL, so nothing is
-- re-granted here. Stated so a reader does not go looking for a missing
-- revoke: both are trigger functions and hold no api-role EXECUTE
-- (20260925010000). The assertion below on the untouched vm helper's ACL is a
-- tripwire, not a claim that this migration changes it.

-- ---------------------------------------------------------------------------
-- 4. Apply-time assertions (run on prod during db push, atomically)
-- ---------------------------------------------------------------------------
do $$
begin
  if (select prosrc from pg_proc where oid = 'public.org_members_guard_last_admin()'::regprocedure)
       !~ 'account_pending_departure' then
    raise exception 'assert: org floor does not ignore departing holders';
  end if;
  if (select prosrc from pg_proc where oid = 'public.module_roles_guard_last_director()'::regprocedure)
       !~ 'account_pending_departure' then
    raise exception 'assert: Director floor does not ignore departing holders';
  end if;
  -- The conversation floor must be UNCHANGED (see the header).
  if (select prosrc from pg_proc where oid = 'public.vm_seat_holds_admin_floor(uuid)'::regprocedure)
       ~ 'account_pending_departure' then
    raise exception 'assert: conversation floor was changed — it must keep counting a departing admin';
  end if;
  if has_function_privilege('authenticated', 'public.vm_seat_holds_admin_floor(uuid)', 'execute')
     or has_function_privilege('service_role', 'public.vm_seat_holds_admin_floor(uuid)', 'execute') then
    raise exception 'assert: vm_seat_holds_admin_floor gained an api-role grant';
  end if;
  -- Works on an EMPTY database (CI applies migrations before any seed).
  if public.account_pending_departure('00000000-0000-0000-0000-000000000000'::uuid) then
    raise exception 'assert: a nonexistent user reads as departing';
  end if;
end;
$$;
