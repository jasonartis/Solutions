-- Slice 3 (user model): ORG-LEVEL INVITE-ACCEPT (2026-07-27).
--
-- Standing decision (docs/15 §6, 2026-07-17; hardening §4.1 + Fable review
-- §6): being ADDED to an org no longer makes you a live member. Every add by a
-- signed-in user creates a PENDING invite; the invited user sees it as a
-- greyed-out card on their dashboard and becomes a real member only when THEY
-- accept. This is the most tenancy-sensitive change to date because it edits
-- is_org_member() — the predicate the entire platform's RLS leans on — so it
-- runs the full docs/03 #12 rhythm (draft -> adversarial review -> live verify
-- as real users -> RLS suite -> docs).
--
-- THE DAY-ZERO LEAK (Fable review, binding): "pending" is meaningless unless
-- EVERY membership predicate honors it. A status column that only is_org_member
-- reads would still leak a pending invitee through the two siblings that read
-- org_members directly — shares_org_with() (the profiles email-directory read)
-- and org_caller_rank() (the org hierarchy) — and through is_org_admin(). So
-- ALL FOUR are patched here to require status = 'active'.
--
-- THE "PENDING USER ACTS" HOLE (this review + adversarial review): reads are
-- not the only surface. A pending invitee who has ALSO been granted a module
-- role could still satisfy a module capability gate. is_org_admin is now
-- active-gated, but the many predicates that read module_roles for auth.uid()
-- were not. EVERY such predicate is gated here on active org membership:
--   * step 4  — the generic + global readers: has_module_role,
--     module_caller_covers_rank, module_caller_covers_role.
--   * step 4b — the COARSE + SHARED readers the scope migrations (slice 2b)
--     redefined to read module_roles directly (so a SCOPED staffer reached the
--     console): the shared module_roles WRITE path (module_caller_can_manage_seat,
--     module_has_manager_grant) and the coarse per-module gates (cls_can_manage,
--     cls_is_ga, cls_is_class_member, sal_can_manage/operate/is_worker,
--     sd_can_organize/staff_event). The classroom coarse gates back the Storage
--     buckets (student PII) + course insert; the shared write path let a pending
--     "manager" staff OTHER users. All closed. The precise per-row functions
--     already delegate to the step-4 generics, so they inherit the gate.
-- Together this delivers, at the point of use, the long-deferred "a module_roles
-- grant implies (active) org membership" invariant (docs/15): a grant confers
-- nothing until its holder is an accepted member.
--
-- CONSENT: an admin can create/cancel/re-role a pending invite (rank-governed),
-- but can NEVER force it to 'active' on the invitee's behalf — only the invited
-- user, via org_accept_invite(), flips their own seat to active. A superadmin
-- keeps the platform escape hatch.
--
-- Forward-only, additive. `create or replace` restates each function's full
-- definer + search_path attributes (they are not inherited) and preserves the
-- existing EXECUTE grants; the two NEW rpc functions state their full ACL
-- explicitly (docs/03 #1 + the prod/local grant-divergence gotcha in CLAUDE.md).

-- ---------------------------------------------------------------------------
-- 1. Schema: status + audit columns on org_members.
--    Existing rows are all real, accepted members -> the ADD fills them with
--    'active'. Only THEN do we flip the column default to 'pending', so every
--    FUTURE insert fails closed to an invite unless a trusted path (seed /
--    service-role) sets 'active' explicitly. invited_by/at/accepted_at are
--    audit; invited_by is load-bearing for org_accept_invite's revalidation.
-- ---------------------------------------------------------------------------
alter table public.org_members
  add column status text not null default 'active' check (status in ('pending', 'active')),
  add column invited_by uuid references auth.users (id) on delete set null,
  add column invited_at timestamptz not null default now(),
  add column accepted_at timestamptz;

alter table public.org_members alter column status set default 'pending';

-- Cheap probe for "any pending invite for this user" (dashboard) and for the
-- last-admin / revalidation existence checks that now filter on status.
create index org_members_status_idx on public.org_members (user_id, status);

-- Per-profile preference store. Currently holds ONE key, the superadmin's
-- default for console member-adds: settings.superadminDefaultAddActive (bool) —
-- whether their "add member" defaults to immediately-active vs a pending invite
-- (founder decision 2026-07-27). A user may update only their OWN settings
-- (the existing profiles_update_own policy scopes the row; the column grant
-- opens settings alongside display_name). Harmless for non-superadmins (unread).
alter table public.profiles add column settings jsonb not null default '{}'::jsonb;
grant update (settings) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- 2. is_org_member(): active only. The whole slice hinges on this line.
-- ---------------------------------------------------------------------------
create or replace function public.is_org_member(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.org_members
    where org_id = check_org_id
      and user_id = auth.uid()
      and status = 'active'
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. Sibling membership predicates that read org_members directly -> active.
-- ---------------------------------------------------------------------------
-- shares_org_with(): BOTH the caller and the target must be active members of
-- a common org. A pending invitee neither sees co-members' profiles nor is
-- seen by them.
create or replace function public.shares_org_with(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.org_members mine
    join public.org_members theirs on theirs.org_id = mine.org_id
    where mine.user_id = auth.uid()
      and mine.status = 'active'
      and theirs.user_id = target_user
      and theirs.status = 'active'
  );
$$;

-- org_caller_rank(): a pending seat confers NO rank (coalesces to 0), so a
-- pending owner/admin invite grants no hierarchy authority pre-acceptance.
create or replace function public.org_caller_rank(check_org_id uuid)
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
        where org_id = check_org_id
          and user_id = auth.uid()
          and status = 'active'),
      0)
  end;
$$;

-- is_org_admin(): a pending owner/admin invite is not yet an admin.
create or replace function public.is_org_admin(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_superadmin()
      or exists (
           select 1 from public.org_members
           where org_id = check_org_id
             and user_id = auth.uid()
             and status = 'active'
             and role in ('owner', 'admin')
         );
$$;

-- ---------------------------------------------------------------------------
-- 4. Module capability predicates -> require active org membership.
--    All three read module_roles for auth.uid(); adding is_org_member(org)
--    means a grant held by a pending (or non-) member confers nothing. The
--    is_org_admin arm inside module_caller_covers_rank is already active-gated
--    (step 3), so only the module_roles arms need the extra conjunct.
-- ---------------------------------------------------------------------------
create or replace function public.has_module_role(check_org_id uuid, check_module_key text, check_role text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_member(check_org_id)
     and exists (
    select 1 from public.module_roles
    where org_id = check_org_id
      and module_key = check_module_key
      and role = check_role
      and user_id = auth.uid()
      and scope_ref is null
  );
$$;

create or replace function public.module_caller_covers_rank(
  check_org_id uuid,
  check_module_key text,
  check_node uuid,
  min_rank integer
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_admin(check_org_id)
      or (public.is_org_member(check_org_id) and check_node is not null and exists (
           select 1
           from public.module_roles g
           where g.org_id = check_org_id
             and g.module_key = check_module_key
             and g.user_id = auth.uid()
             and public.module_position_rank(check_module_key, g.role) >= min_rank
             and public.module_scope_covers(g.scope_ref, check_node)
         ));
$$;

create or replace function public.module_caller_covers_role(
  check_org_id uuid,
  check_module_key text,
  check_node uuid,
  check_role text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_member(check_org_id) and check_node is not null and exists (
    select 1
    from public.module_roles g
    where g.org_id = check_org_id
      and g.module_key = check_module_key
      and g.user_id = auth.uid()
      and g.role = check_role
      and public.module_scope_covers(g.scope_ref, check_node)
  );
$$;

-- syn_can_write: the ONE module manage-gate still carrying an INLINE
-- org_members owner/admin check (20260707030000) — the platform extraction
-- (20260709040000) only folded cls/mm/sal onto is_org_admin, and sd_can_manage
-- was folded later (20260709050000:1041), but synagogue's predates all of that
-- and was never refactored. Its inline check has no status filter, so a PENDING
-- owner/admin invite to a synagogue org would pass it and could INSERT schedule
-- rows (a write gate needs no SELECT). Fold it onto the now-active-gated
-- is_org_admin, exactly as the other five modules already are — behavior is
-- identical for real (active) members. This is the last inline org_members
-- reader; every other membership check flows through the predicates patched
-- above.
create or replace function public.syn_can_write(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_admin(check_org_id)
      or public.has_module_role(check_org_id, 'synagogue-schedules', 'maker');
$$;

-- ---------------------------------------------------------------------------
-- 4b. Coarse & shared module capability predicates that read module_roles
--     DIRECTLY (adversarial-review finding). The scope migrations (slice 2b,
--     20260724010000 / 20260726010000 / 20260726030000) redefined these to read
--     module_roles directly — NOT via has_module_role — so a SCOPED staffer
--     could still reach the coarse console/storage gates. Patching has_module_role
--     + the generics (step 4) therefore did NOT cover them, leaving a real
--     "PENDING USER ACTS" hole: a pending (or non-) member holding a module grant
--     could reach classroom Storage (student PII), insert courses, read class
--     content, and — via the SHARED module_roles write path — staff OTHER users.
--     Gate every module_roles arm on active org membership. The is_org_admin
--     arms are already active-gated (step 3); only the module_roles arms need the
--     conjunct. This finally delivers the "a module_roles grant implies (active)
--     org membership" invariant at the point of use, platform-wide.
-- ---------------------------------------------------------------------------

-- Shared (all modules): the module_roles WRITE authority (used by the
-- module_roles_*_module_manager policies + module_roles_guard_hierarchy) and the
-- coarse manager gate. A pending manager can no longer staff other users.
create or replace function public.module_caller_can_manage_seat(
  check_org_id uuid,
  check_module_key text,
  seat_role text,
  seat_scope uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_member(check_org_id) and exists (
    select 1
    from public.module_roles g
    where g.org_id = check_org_id
      and g.module_key = check_module_key
      and g.user_id = auth.uid()
      and (
        (public.module_position_rank(check_module_key, g.role) > public.module_position_rank(check_module_key, seat_role)
           and public.module_scope_covers(g.scope_ref, seat_scope))
        or (g.role = seat_role
           and public.module_position_rank(check_module_key, seat_role) = 3
           and public.module_scope_strictly_contains(g.scope_ref, seat_scope))
      )
  );
$$;

create or replace function public.module_has_manager_grant(check_org_id uuid, check_module_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_member(check_org_id) and exists (
    select 1 from public.module_roles
    where org_id = check_org_id
      and module_key = check_module_key
      and user_id = auth.uid()
      and public.module_position_rank(check_module_key, role) >= 2
  );
$$;

-- Classroom coarse gates (storage buckets + course insert + manage-page entry).
create or replace function public.cls_can_manage(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_admin(check_org_id)
      or (public.is_org_member(check_org_id) and exists (
           select 1 from public.module_roles g
           where g.org_id = check_org_id
             and g.module_key = 'classroom'
             and g.user_id = auth.uid()
             and public.module_position_rank('classroom', g.role) >= 2
         ));
$$;

create or replace function public.cls_is_ga(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_member(check_org_id) and exists (
    select 1 from public.module_roles g
    where g.org_id = check_org_id
      and g.module_key = 'classroom'
      and g.user_id = auth.uid()
      and g.role = 'ga'
  );
$$;

-- Class membership = a scoped classroom grant covering the class node. Gate on
-- active membership of the CLASS'S org (derived from the row, not an arg).
create or replace function public.cls_is_class_member(check_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.module_roles g
    join public.cls_classes c on c.id = check_class_id
    where g.org_id = c.org_id
      and g.module_key = 'classroom'
      and g.user_id = auth.uid()
      and g.scope_ref is not null
      and public.module_scope_covers(g.scope_ref, c.scope_node_id)
      and public.is_org_member(c.org_id)
  );
$$;

-- Nail-salon coarse gates (console entry; per-row policies use the precise
-- sal_can_*_location functions, already safe). sal_can_operate / sal_is_worker
-- gate their own module_roles arms; sal_can_operate's sal_can_manage arm is
-- gated by the redefinition above.
create or replace function public.sal_can_manage(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_admin(check_org_id)
      or (public.is_org_member(check_org_id) and exists (
           select 1 from public.module_roles g
           where g.org_id = check_org_id
             and g.module_key = 'nail-salon'
             and g.user_id = auth.uid()
             and public.module_position_rank('nail-salon', g.role) >= 2
         ));
$$;

create or replace function public.sal_can_operate(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.sal_can_manage(check_org_id)
      or (public.is_org_member(check_org_id) and exists (
           select 1 from public.module_roles g
           where g.org_id = check_org_id
             and g.module_key = 'nail-salon'
             and g.user_id = auth.uid()
             and g.role = 'cashier'
         ));
$$;

create or replace function public.sal_is_worker(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_member(check_org_id) and exists (
    select 1 from public.module_roles g
    where g.org_id = check_org_id
      and g.module_key = 'nail-salon'
      and g.user_id = auth.uid()
      and g.role = 'worker'
  );
$$;

-- Speed-dating coarse gates (console entry; per-row policies use the precise
-- sd_can_*_event functions, already safe).
create or replace function public.sd_can_organize(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_admin(check_org_id)
      or (public.is_org_member(check_org_id) and exists (
           select 1 from public.module_roles g
           where g.org_id = check_org_id
             and g.module_key = 'speed-dating'
             and g.user_id = auth.uid()
             and public.module_position_rank('speed-dating', g.role) >= 2
         ));
$$;

create or replace function public.sd_can_staff_event(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.sd_can_organize(check_org_id)
      or (public.is_org_member(check_org_id) and exists (
           select 1 from public.module_roles g
           where g.org_id = check_org_id
             and g.module_key = 'speed-dating'
             and g.user_id = auth.uid()
             and g.role = 'host'
         ));
$$;

-- ---------------------------------------------------------------------------
-- 5. RLS: a user may always SELECT and DELETE their OWN membership rows.
--    * select_self  — lets a pending invitee read their own invite row (the
--      member-scoped policies are is_org_member-gated, now active-only, so a
--      pending user is otherwise invisible even to themselves).
--    * delete_self  — the door for decline/leave; the hierarchy guard decides
--      WHICH self-deletes are actually permitted (pending or plain member).
--    Both are additive (OR-combine with the existing member/admin/superadmin
--    policies) and expose nothing beyond the caller's own rows.
-- ---------------------------------------------------------------------------
create policy org_members_select_self on public.org_members
  for select using (user_id = auth.uid());

create policy org_members_delete_self on public.org_members
  for delete using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 6. Hierarchy guard rewrite: same rank ladder as 20260717010000, plus the
--    slice-3 invite semantics. Order matters — the self-service carve-outs and
--    INSERT normalization run BEFORE the rank ladder.
-- ---------------------------------------------------------------------------
create or replace function public.org_members_guard_hierarchy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_rank integer;
begin
  -- (a) ACCEPT carve-out: the invited user flips their OWN pending seat to
  --     active, changing nothing else. Reachable ONLY via org_accept_invite()
  --     (a definer that bypasses RLS and revalidates first) — no RLS policy
  --     grants an invitee UPDATE on their own row, so a raw client cannot take
  --     this path. Sits ahead of the rank ladder, which would otherwise block
  --     it (a pending seat's caller_rank is 0).
  if tg_op = 'UPDATE'
     and auth.uid() is not null
     and old.user_id = auth.uid()
     and old.status = 'pending'
     and new.status = 'active'
     and new.role = old.role
     and new.user_id = old.user_id
     and new.org_id = old.org_id
  then
    return new;
  end if;

  -- (b) DECLINE / LEAVE carve-out: a user may DELETE their OWN seat when it is
  --     a pending invite (decline) or a plain member seat (leave). Active
  --     owner/admin self-removal still falls through to the rank ladder and is
  --     blocked (ask a co-admin); the admin FLOOR is enforced separately by
  --     org_members_guard_last_admin.
  if tg_op = 'DELETE'
     and auth.uid() is not null
     and old.user_id = auth.uid()
     and (old.status = 'pending' or old.role = 'member')
  then
    return old;
  end if;

  -- INSERT normalization + the superadmin choice. Server-stamp the inviter
  -- (client-supplied invited_by is overwritten, no spoofing). An ORG ADMIN may
  -- only ever INVITE: their seat is forced to 'pending' regardless of input, so
  -- they can never mint a pre-accepted member. A SUPERADMIN (platform owner) is
  -- trusted to choose — the status they supply is honored: 'active' adds the
  -- member immediately (the escape hatch, no accept needed), 'pending' sends a
  -- normal invite; the column default is 'pending' so an unspecified superadmin
  -- add is still an invite. Founder decision 2026-07-27: "the superadmin should
  -- control everything." Service role (auth.uid() null — seed/worker) is
  -- untouched and sets status itself.
  if tg_op = 'INSERT' and auth.uid() is not null then
    new.invited_by := auth.uid();
    new.invited_at := now();
    if not public.is_superadmin() then
      new.status := 'pending';
    end if;
    new.accepted_at := case when new.status = 'active' then now() else null end;
  end if;

  -- Service role (no JWT) and superadmin bypass the rank ladder.
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
    -- Consent: an invite is activated only by its invitee (carve-out a above).
    -- No admin may force a pending seat to active on someone else's behalf.
    if old.status = 'pending' and new.status = 'active' then
      raise exception 'An invitation can only be activated by the invited user accepting it';
    end if;
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

-- ---------------------------------------------------------------------------
-- 7. Last-admin-standing guard: count ACTIVE owner/admins only, and never gate
--    a change to a non-active (pending) seat — a pending admin invite never
--    held the floor, so declining/cancelling it can't empty the org.
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
  ) then
    raise exception 'An org must keep at least one owner or admin';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. org_accept_invite(org): the ONLY path that flips a pending seat to active.
--    Verifies the caller owns a live pending invite, revalidates the invite is
--    still legitimate (its inviter is still authorized to have issued it), then
--    flips status + stamps accepted_at. The UPDATE fires the two guards above:
--    the hierarchy guard's accept carve-out permits it, and the last-admin
--    guard early-returns (old.status = 'pending').
-- ---------------------------------------------------------------------------
create function public.org_accept_invite(check_org_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  inv public.org_members%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select * into inv
  from public.org_members
  where org_id = check_org_id
    and user_id = auth.uid()
    and status = 'pending';

  if not found then
    raise exception 'No pending invitation to accept for this organization';
  end if;

  -- Revalidate: the inviter must STILL be authorized to have issued this invite
  -- — a platform superadmin, or an active member who still strictly outranks
  -- the invited role. Blocks a stale high-privilege invite from an inviter who
  -- has since been removed or demoted (docs/15 §4.1).
  if inv.invited_by is null
     or not (
       exists (
         select 1 from public.profiles p
         where p.user_id = inv.invited_by and p.is_superadmin
       )
       or exists (
         select 1 from public.org_members ib
         where ib.org_id = check_org_id
           and ib.user_id = inv.invited_by
           and ib.status = 'active'
           and public.org_role_rank(ib.role) > public.org_role_rank(inv.role)
       )
     )
  then
    raise exception 'This invitation is no longer valid — ask an admin to re-invite you';
  end if;

  update public.org_members
     set status = 'active', accepted_at = now()
   where org_id = check_org_id and user_id = auth.uid() and status = 'pending';
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. org_my_pending_invites(): the narrow, name-only definer for the dashboard
--    invite card. orgs_select_member (active-only) correctly refuses a pending
--    invitee the org's name, so this returns just the caller's OWN pending
--    invites joined to org name/slug — never any org data, never anyone else's
--    invites (docs/15 §6: "its own narrow definer path (name only), never a
--    widened policy").
-- ---------------------------------------------------------------------------
create function public.org_my_pending_invites()
returns table (org_id uuid, org_name text, org_slug text, invited_role text, invited_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select m.org_id, o.name, o.slug, m.role, m.invited_at
  from public.org_members m
  join public.orgs o on o.id = m.org_id
  where m.user_id = auth.uid()
    and m.status = 'pending';
$$;

-- org_member_profiles(org): the profiles (name/email) of an org's members —
-- ACTIVE and PENDING — for a caller who ADMINS that org. Needed because
-- shares_org_with is now active-only, so an org admin's normal profiles read no
-- longer surfaces a PENDING invitee's name/email — but the admin must see who
-- they invited to manage/cancel the invite (and they already know the email:
-- they typed it, and can resolve any email via org_find_user_by_email). This is
-- that one admin-scoped capability: a non-admin (or an admin passing an org they
-- don't run) gets zero rows. Used by the org members page in place of the broad
-- profiles query so pending rows render with a real identity.
create function public.org_member_profiles(check_org_id uuid)
returns table (user_id uuid, display_name text, email text)
language sql
stable
security definer
set search_path = public
as $$
  select p.user_id, p.display_name, p.email
  from public.profiles p
  join public.org_members m on m.user_id = p.user_id and m.org_id = check_org_id
  where public.is_org_admin(check_org_id);
$$;

-- ---------------------------------------------------------------------------
-- 10. ACLs for the NEW rpc functions. State the full intended ACL
--     explicitly (never rely on the PUBLIC default, which diverges local/prod).
--     Both are caller-keyed on auth.uid(), so anon has no business calling them.
-- ---------------------------------------------------------------------------
revoke execute on function public.org_accept_invite(uuid) from public, anon, authenticated;
grant execute on function public.org_accept_invite(uuid) to authenticated;

revoke execute on function public.org_my_pending_invites() from public, anon, authenticated;
grant execute on function public.org_my_pending_invites() to authenticated;

revoke execute on function public.org_member_profiles(uuid) from public, anon, authenticated;
grant execute on function public.org_member_profiles(uuid) to authenticated;
