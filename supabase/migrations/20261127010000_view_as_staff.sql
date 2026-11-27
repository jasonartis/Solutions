-- ===========================================================================
-- STAFF "View as" — org staff see a person's REAL screen, trimmed to their area
-- docs/13 "STAFF VIEW AS" (DESIGN, THREE-WAY REVIEW, FOUNDER ANSWERS 2026-11-26)
-- ===========================================================================
--
-- A classroom professor (or a nail-salon admin/manager) opens "View as" on a
-- person from inside one org. Every page under /o/<org>/m/<module in the area>
-- then renders AS that person, with the same token, read-only hook, proxy and
-- storage policies as the superadmin's view (20261116010000, 20261125010000).
-- Nothing in the four write layers changes. What is new is ONE question the
-- database asks of every row, grant and role check during such a view:
-- "is this inside the viewer's AREA?"
--
-- THE AREA (computed live on every call, never stored): the (module, person
-- scope, viewer scope) triples where
--   * the viewer holds a grant in the org that she did NOT give herself
--     (founder 2026-11-26 answer 5: granted_by is distinct from the viewer;
--     a NULL granted_by — every seat created before this migration, by the
--     service role, or by an invite on the inviter's behalf — counts), that
--   * strictly outranks a grant of the person, covers its scope, and is a
--     declared mode-2 edge (module_view_as_edge: classroom professor -> ga /
--     student; nail-salon admin/manager -> worker) — the 2026-08-02 rule
--     reused unchanged, founder answer 2; and
--   * the person holds NO grant in that module ranked >= that viewer grant
--     (review R1: "make Olivia my student" cannot reach a more powerful person).
--
-- A STAFF SESSION IS LIVE only while (re-checked on every call, review S1):
-- kind = 'staff', org set, module null, not ended, not expired; the viewer
-- and the person are both ACTIVE members of the org; the person is not an org
-- owner/admin, not a superadmin, not deleted/departed/banned; the area is
-- not empty. A staff session never satisfies a platform (superadmin) branch
-- and vice versa: every branch tests `kind` (review S3/R3).
--
-- WHAT THIS MIGRATION DOES
--   1. view_as_real_sessions.kind; org admins of the org read its staff rows
--      (founder answer 1A: the row is the permanent record; never pruned).
--   2. module_roles.granted_by is SERVER-STAMPED from now on (answer 5 needs
--      it; the app never set it, so every existing row is NULL).
--   3. The staff functions: view_as_staff_area, view_as_staff_live,
--      view_as_staff_current, view_as_staff_node_ok, view_as_staff_start,
--      view_as_staff_targets.
--   4. view_as_may_read(org, module): the platform branch now also requires
--      kind = 'platform'; a staff branch admits a module in the area.
--      view_as_may_read_in(org, module, node): the same plus the row's scope
--      node. view_as_grant_visible(org, module, scope): a person's grant is
--      visible during a staff view only inside the area.
--   5. Row-level area policies (RESTRICTIVE) on every cls_ and sal_ table, the
--      only modules with mode-2 edges; module_roles trimmed to the area;
--      feedback_tickets/feedback_messages dark to a staff view (review R6).
--   6. The org-wide role booleans pages call (cls_can_manage, cls_is_ga,
--      sal_can_manage, sal_can_operate, sal_is_worker, has_module_role,
--      module_has_manager_grant) see only the person's in-area grants during
--      a staff view (review R5: a scoped professor must not learn that the
--      person is a GA in another class). Bodies otherwise UNCHANGED.
--   7. cls_comments_for_my_submission / cls_survey_results check the area.
--   8. view_as_real_check: a staff branch (in scope = /o/<slug>/m/<module in
--      the area>); returns kind and the area's modules. view_as_real_end: the
--      session's own actor may end it (was superadmin-only).
--   (The 3-argument view_as_real_start is NOT dropped here — see section 9.)
--
-- NEVER-RAISE RULE (docs/12): in_view_as(), view_as_may_read*(),
-- view_as_grant_visible() sit in RLS policies of every request. None of them
-- may raise; every claim is validated (pg_input_is_valid) before a cast.
-- Performance: during an ORDINARY request each policy short-circuits on
-- `(select not public.in_view_as())`, evaluated once per query.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Sessions: kind; org admins read their org's staff sessions
-- ---------------------------------------------------------------------------
alter table public.view_as_real_sessions
  add column kind text not null default 'platform';
alter table public.view_as_real_sessions
  add constraint view_as_real_sessions_kind_check check (kind in ('platform', 'staff'));
-- A staff row always names its org and never a module (the area is computed).
alter table public.view_as_real_sessions
  add constraint view_as_real_sessions_staff_shape
  check (kind <> 'staff' or (module_key is null));

-- (view_as_real_sessions_org_idx on (org_id, created_at desc) exists since 20261116010000.)

-- The existing superadmin-only read stays; this adds the org's own admins for
-- STAFF rows of their org (founder 2026-11-26 answer 1A). is_org_admin() is
-- true for a superadmin too, which the existing policy already covers.
create policy view_as_real_sessions_select_org_admin on public.view_as_real_sessions
  for select to authenticated
  using (kind = 'staff' and org_id is not null and public.is_org_admin(org_id));

-- ---------------------------------------------------------------------------
-- 2. module_roles.granted_by — stamped by the server from now on
-- ---------------------------------------------------------------------------
-- For a signed-in caller (auth.uid() set) the column is ALWAYS the caller on
-- insert, and on an update that changes who/what/where the seat is. With no
-- caller identity (service role, migrations, and the pending-invite applier,
-- which blanks the claims to write on the INVITER's behalf and passes
-- granted_by = the inviter) the given value is kept.
create function public.module_roles_stamp_granted_by()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.granted_by := auth.uid();
  elsif new.user_id is distinct from old.user_id
     or new.org_id is distinct from old.org_id
     or new.module_key is distinct from old.module_key
     or new.role is distinct from old.role
     or new.scope_ref is distinct from old.scope_ref then
    new.granted_by := auth.uid();
  elsif new.granted_by is null and old.granted_by is not null
        and not exists (select 1 from auth.users u where u.id = old.granted_by) then
    -- The grantor's account is being deleted: the FK's ON DELETE SET NULL runs
    -- as this UPDATE. Let it through (review LOW); clearing is allowed ONLY then.
    null;
  else
    new.granted_by := old.granted_by;
  end if;
  return new;
end;
$$;

revoke all on function public.module_roles_stamp_granted_by() from public, anon, authenticated, service_role;

create trigger module_roles_stamp_granted_by
  before insert or update on public.module_roles
  for each row execute function public.module_roles_stamp_granted_by();

-- ---------------------------------------------------------------------------
-- 3. The staff functions
-- ---------------------------------------------------------------------------

-- 3a. The area for (org, viewer, person). Plain SQL, no grants: it is only
--     ever called from the definers below, as their owner.
create function public.view_as_staff_area(p_org uuid, p_actor uuid, p_target uuid)
returns table (module_key text, person_scope uuid, viewer_scope uuid)
language sql
stable
set search_path = ''
as $$
  select distinct gp.module_key, gp.scope_ref, gv.scope_ref
  from public.module_roles gp
  join public.module_roles gv
    on gv.org_id = gp.org_id
   and gv.module_key = gp.module_key
   and gv.user_id = p_actor
  where gp.org_id = p_org
    and gp.user_id = p_target
    and p_actor is distinct from p_target
    -- Answer 5: a seat the viewer gave herself never enables View as.
    and gv.granted_by is distinct from p_actor
    and public.module_position_rank(gv.module_key, gv.role) > public.module_position_rank(gp.module_key, gp.role)
    and public.module_scope_covers(gv.scope_ref, gp.scope_ref)
    and public.module_view_as_edge(gp.module_key, gv.role, gp.role)
    and exists (select 1 from public.org_modules om
                where om.org_id = p_org and om.module_key = gp.module_key and om.enabled)
    -- R1: the person holds nothing in this module as high as this viewer seat.
    and not exists (
      select 1 from public.module_roles gx
      where gx.org_id = p_org
        and gx.user_id = p_target
        and gx.module_key = gp.module_key
        and public.module_position_rank(gx.module_key, gx.role)
            >= public.module_position_rank(gv.module_key, gv.role)
    );
$$;

revoke all on function public.view_as_staff_area(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- 3b. Is this staff session live right now? Every condition is re-read.
create function public.view_as_staff_live(p_session uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select true
    from public.view_as_real_sessions vs
    where vs.id = p_session
      and vs.kind = 'staff'
      and vs.org_id is not null
      and vs.module_key is null
      and vs.ended_at is null
      and vs.expires_at > pg_catalog.now()
      and vs.actor_user_id is not null
      and vs.target_user_id is not null
      and vs.actor_user_id <> vs.target_user_id
      -- Both ACTIVE members of the org.
      and exists (select 1 from public.org_members m
                  where m.org_id = vs.org_id and m.user_id = vs.actor_user_id
                    and coalesce(m.status, 'active') = 'active')
      and exists (select 1 from public.org_members m
                  where m.org_id = vs.org_id and m.user_id = vs.target_user_id
                    and coalesce(m.status, 'active') = 'active'
                    and m.role not in ('owner', 'admin'))
      -- The person: never a superadmin; a live account.
      and not exists (select 1 from public.user_private u
                      where u.user_id = vs.target_user_id and u.is_superadmin)
      and exists (select 1 from auth.users u
                  where u.id = vs.target_user_id
                    and u.deleted_at is null
                    and (u.banned_until is null or u.banned_until <= pg_catalog.now()))
      and not public.account_has_left(vs.target_user_id)
      -- The viewer: a live account.
      and exists (select 1 from auth.users u
                  where u.id = vs.actor_user_id
                    and u.deleted_at is null
                    and (u.banned_until is null or u.banned_until <= pg_catalog.now()))
      and not public.account_has_left(vs.actor_user_id)
      -- The person holds no MANAGER-tier seat (rank >= 2) in ANY module of the
      -- org (review S1, the cross-module half): staff powers elsewhere would run
      -- through definers that never meet the area policies.
      and not exists (select 1 from public.module_roles x
                      where x.org_id = vs.org_id and x.user_id = vs.target_user_id
                        and public.module_position_rank(x.module_key, x.role) >= 2)
      -- A non-empty area.
      and exists (select 1 from public.view_as_staff_area(vs.org_id, vs.actor_user_id, vs.target_user_id))
  ), false);
$$;

revoke all on function public.view_as_staff_live(uuid) from public, anon, authenticated, service_role;

-- 3c. The staff session THIS request carries (its view_as claim), if live.
--     Never raises: every claim is validated before the cast. A context whose
--     claims were blanked (some definers do) has no session: fail closed.
create function public.view_as_staff_current()
returns table (session_id uuid, org_id uuid, actor_user_id uuid, target_user_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with c as (
    select case
      when pg_catalog.pg_input_is_valid(coalesce(pg_catalog.current_setting('request.jwt.claims', true), ''), 'jsonb')
        then pg_catalog.current_setting('request.jwt.claims', true)::jsonb
    end as j
  ), k as (
    select
      case when pg_catalog.pg_input_is_valid(coalesce(c.j #>> '{view_as,session}', ''), 'uuid')
        then (c.j #>> '{view_as,session}')::uuid end as sid,
      case when pg_catalog.pg_input_is_valid(coalesce(c.j ->> 'sub', ''), 'uuid')
        then (c.j ->> 'sub')::uuid end as sub
    from c
  )
  select vs.id, vs.org_id, vs.actor_user_id, vs.target_user_id
  from k
  join public.view_as_real_sessions vs on vs.id = k.sid
  where vs.kind = 'staff'
    and vs.target_user_id = k.sub
    and public.view_as_staff_live(vs.id);
$$;

revoke all on function public.view_as_staff_current() from public, anon, authenticated, service_role;

-- 3d. The current request's view, worked out ONCE per request (review: per-row
--     re-evaluation cost ~8 ms a row and hit the 8 s statement timeout near
--     1,000 rows). The answer is cached in a transaction-local setting keyed by
--     a hash of the claims and the transaction's start time, so it can never be
--     reused by another request (PostgREST: one request = one transaction), and
--     a ROLLBACK TO SAVEPOINT discards it like any setting. Never raises: the
--     only casts are on values this function itself wrote.
--     TRUST: the cached value is believed. Only raw SQL can write sp.view_as_now
--     today (no API-callable function calls set_config with caller input —
--     final review 2026-11-26 checked). A future function that lets an API
--     caller set an arbitrary setting would let them forge a view answer:
--     never write one (docs/12).
--     Returns NULL for an ordinary request; otherwise
--       {"platform": bool, "org": <staff session org or null>,
--        "area": [{"m": module, "p": person scope, "v": viewer scope}, …]}
create function public.view_as_now()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_cached text;
  v_out jsonb;
  v_platform boolean;
  v_org uuid;
  v_area jsonb;
begin
  if not public.in_view_as() then
    return null;
  end if;
  v_key := pg_catalog.md5(coalesce(pg_catalog.current_setting('request.jwt.claims', true), '')
                          || '|' || pg_catalog.transaction_timestamp()::text);
  v_cached := pg_catalog.current_setting('sp.view_as_now', true);
  if v_cached is not null and pg_catalog.left(v_cached, 33) = v_key || '|' then
    return pg_catalog.substr(v_cached, 34)::jsonb;
  end if;

  v_platform := public.view_as_platform_live();
  select s.org_id,
         coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                     'm', a.module_key, 'p', a.person_scope, 'v', a.viewer_scope))
                   from public.view_as_staff_area(s.org_id, s.actor_user_id, s.target_user_id) a), '[]'::jsonb)
    into v_org, v_area
  from public.view_as_staff_current() s
  limit 1;

  v_out := pg_catalog.jsonb_build_object('platform', v_platform, 'org', v_org, 'area', coalesce(v_area, '[]'::jsonb));
  perform pg_catalog.set_config('sp.view_as_now', v_key || '|' || v_out::text, true);
  return v_out;
end;
$$;

revoke all on function public.view_as_now() from public, anon, authenticated, service_role;

-- 3e. Pure checks against that answer (no table reads but the scope tree).
--     Module level: is `p_module` of `p_org` in the staff area?
create function public.view_as_area_has_module(p_now jsonb, p_org uuid, p_module text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    p_now ->> 'org' = p_org::text
    and exists (select 1 from pg_catalog.jsonb_array_elements(p_now -> 'area') e
                where e ->> 'm' = p_module),
    false);
$$;

--     Node level: a row's node is in the area when the viewer's seat covers it
--     AND it is under the person's in-area seat, or is an ANCESTOR of it (the
--     course of the person's class). A NULL node is in the area only for a
--     global person seat under a global viewer seat.
create function public.view_as_area_has_node(p_now jsonb, p_org uuid, p_module text, p_node uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    p_now ->> 'org' = p_org::text
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_now -> 'area') e
      cross join lateral (select (e ->> 'p')::uuid as ps, (e ->> 'v')::uuid as vs) x
      where e ->> 'm' = p_module
        and (
          (p_node is null and x.ps is null and x.vs is null)
          or (p_node is not null
              and public.module_scope_covers(x.vs, p_node)
              and (public.module_scope_covers(x.ps, p_node)
                   or public.module_scope_covers(p_node, x.ps)))
        )
    ),
    false);
$$;

revoke all on function public.view_as_area_has_module(jsonb, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.view_as_area_has_node(jsonb, uuid, text, uuid) from public, anon, authenticated, service_role;

-- 3f. Node-level check for the current request (false when not a live staff view).
create function public.view_as_staff_node_ok(p_org uuid, p_module text, p_node uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select public.view_as_area_has_node(public.view_as_now(), p_org, p_module, p_node);
$$;

revoke all on function public.view_as_staff_node_ok(uuid, text, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. The shared rules
-- ---------------------------------------------------------------------------

-- 4a. Is the current view a LIVE PLATFORM (superadmin, whole-account) view?
--     Exactly 20261125010000's conjuncts, plus kind = 'platform'.
--     view_as_platform_live does the work; view_as_platform_ok is the cached answer.
create function public.view_as_platform_live()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with c as (
    select case
      when pg_catalog.pg_input_is_valid(coalesce(pg_catalog.current_setting('request.jwt.claims', true), ''), 'jsonb')
        then pg_catalog.current_setting('request.jwt.claims', true)::jsonb
    end as j
  ), k as (
    select
      case when pg_catalog.pg_input_is_valid(coalesce(c.j #>> '{view_as,session}', ''), 'uuid')
        then (c.j #>> '{view_as,session}')::uuid end as sid,
      case when pg_catalog.pg_input_is_valid(coalesce(c.j ->> 'sub', ''), 'uuid')
        then (c.j ->> 'sub')::uuid end as sub
    from c
  )
  select exists (
    select 1
    from k
    join public.view_as_real_sessions vs on vs.id = k.sid
    join public.user_private up on up.user_id = vs.actor_user_id and up.is_superadmin
    where vs.kind = 'platform'
      and vs.org_id is null
      and vs.module_key is null
      and vs.ended_at is null
      and vs.expires_at > pg_catalog.now()
      and vs.target_user_id = k.sub
      and not exists (select 1 from public.user_private t
                      where t.user_id = vs.target_user_id and t.is_superadmin)
      and exists (select 1 from auth.users u
                  where u.id = vs.target_user_id
                    and u.deleted_at is null
                    and (u.banned_until is null or u.banned_until <= pg_catalog.now()))
      and not public.account_has_left(vs.target_user_id)
  );
$$;

revoke all on function public.view_as_platform_live() from public, anon, authenticated, service_role;

create function public.view_as_platform_ok()
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select coalesce((public.view_as_now() ->> 'platform')::boolean, false);
$$;

revoke all on function public.view_as_platform_ok() from public, anon, authenticated, service_role;
grant execute on function public.view_as_platform_ok() to anon, authenticated, service_role;

-- 4b. view_as_may_read(org, module) — the rule in every module table's policy.
--     Ordinary request: true. Platform view: as before. Staff view: the org is
--     the session's and the module is in the area.
create or replace function public.view_as_may_read(p_org_id uuid, p_module text)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select case
    when not public.in_view_as() then true
    else coalesce((public.view_as_now() ->> 'platform')::boolean, false)
         or public.view_as_area_has_module(public.view_as_now(), p_org_id, p_module)
  end;
$$;

revoke all on function public.view_as_may_read(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.view_as_may_read(uuid, text) to anon, authenticated, service_role;

-- 4c. view_as_may_read_in(org, module, node) — the same, plus the row's node.
create function public.view_as_may_read_in(p_org_id uuid, p_module text, p_node uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select case
    when not public.in_view_as() then true
    else coalesce((public.view_as_now() ->> 'platform')::boolean, false)
         or public.view_as_area_has_node(public.view_as_now(), p_org_id, p_module, p_node)
  end;
$$;

revoke all on function public.view_as_may_read_in(uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.view_as_may_read_in(uuid, text, uuid) to anon, authenticated, service_role;

-- 4d. view_as_grant_visible(org, module, scope) — is this grant of the person
--     visible? Ordinary request / platform view: yes. Staff view: only when
--     its (module, scope) is in the area. Used by the module_roles policy and
--     inside the role booleans of section 6.
create function public.view_as_grant_visible(p_org_id uuid, p_module text, p_scope uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select public.view_as_may_read_in(p_org_id, p_module, p_scope);
$$;

revoke all on function public.view_as_grant_visible(uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.view_as_grant_visible(uuid, text, uuid) to anon, authenticated, service_role;

-- 4e. Is the current request a view that is NOT a live platform view (a staff
--     view, live or not)? For the "dark to a staff view" policies.
create function public.view_as_is_staff_view()
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select public.in_view_as() and not public.view_as_platform_ok();
$$;

revoke all on function public.view_as_is_staff_view() from public, anon, authenticated, service_role;
grant execute on function public.view_as_is_staff_view() to anon, authenticated, service_role;

-- 4e'. Platform rows by org (review: orgs, org_members, org_modules,
--     module_scope_nodes and profiles were not trimmed — 5 orgs / 24 members /
--     17 scope nodes under a view vs 1 / 4 / 2 for the viewer). Ordinary request
--     or platform view: true. Staff view: only the session's org.
create function public.view_as_org_ok(p_org_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select case
    when not public.in_view_as() then true
    else coalesce((public.view_as_now() ->> 'platform')::boolean, false)
         or coalesce(public.view_as_now() ->> 'org' = p_org_id::text, false)
  end;
$$;

--     A profile is visible to a staff view only when that person is an active
--     member of the session's org (the viewer is a member too, so she reads
--     these names herself).
create function public.view_as_profile_ok(p_user_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select case
    when not public.in_view_as() then true
    when coalesce((public.view_as_now() ->> 'platform')::boolean, false) then true
    else exists (
      select 1 from public.org_members m
      where m.user_id = p_user_id
        and m.org_id::text = public.view_as_now() ->> 'org'
        and coalesce(m.status, 'active') = 'active')
  end;
$$;

revoke all on function public.view_as_org_ok(uuid) from public, anon, authenticated, service_role;
revoke all on function public.view_as_profile_ok(uuid) from public, anon, authenticated, service_role;
grant execute on function public.view_as_org_ok(uuid) to anon, authenticated, service_role;
grant execute on function public.view_as_profile_ok(uuid) to anon, authenticated, service_role;

-- 4f. Scope-node lookups for the row policies. Definers, so a policy never
--     reads cls_classes/sal_locations through their own RLS (which would
--     recurse: "infinite recursion detected in policy").
create function public.cls_class_node(p_class_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.scope_node_id from public.cls_classes c where c.id = p_class_id and public.is_org_member(c.org_id);
$$;

create function public.cls_course_node(p_course_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.scope_node_id from public.cls_courses c where c.id = p_course_id and public.is_org_member(c.org_id);
$$;

create function public.sal_location_node(p_location_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select l.scope_node_id from public.sal_locations l where l.id = p_location_id and public.is_org_member(l.org_id);
$$;

revoke all on function public.cls_class_node(uuid) from public, anon, authenticated, service_role;
revoke all on function public.cls_course_node(uuid) from public, anon, authenticated, service_role;
revoke all on function public.sal_location_node(uuid) from public, anon, authenticated, service_role;
grant execute on function public.cls_class_node(uuid) to authenticated, service_role;
grant execute on function public.cls_course_node(uuid) to authenticated, service_role;
grant execute on function public.sal_location_node(uuid) to authenticated, service_role;

-- 4g. A material is also in the area when it is PUBLISHED to a class in the
--     area (a student reads materials through publications to his class; the
--     course node alone is covered only by a global viewer seat).
create function public.cls_material_in_area(p_material_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.cls_publications p
    where p.material_id = p_material_id
      and public.view_as_staff_node_ok(p.org_id, 'classroom', public.cls_class_node(p.class_id)));
$$;

revoke all on function public.cls_material_in_area(uuid) from public, anon, authenticated, service_role;
grant execute on function public.cls_material_in_area(uuid) to authenticated, service_role;

-- 4h. The in-area ids of one kind, for the CURRENT request (review: per-row
--     checks cost about 2 ms a row). Policies call this inside a scalar
--     sub-select, so Postgres runs it ONCE per query (an initplan) and each row
--     is then a plain "= any(array)" test. Limited to the session's org. NULL
--     when the request is not a live staff view (then no row matches; the
--     policies' other arms admit ordinary requests and the platform view).
create function public.view_as_area_ids(p_kind text)
returns uuid[]
language sql
volatile
security definer
set search_path = ''
as $$
  with n as (select public.view_as_now() as v)
  select case
    when (select v from n) is null or (select v from n) ->> 'org' is null then null
    when p_kind = 'class' then coalesce((
      select pg_catalog.array_agg(c.id) from public.cls_classes c, n
      where c.org_id::text = n.v ->> 'org'
        and public.view_as_area_has_node(n.v, c.org_id, 'classroom', c.scope_node_id)), '{}')
    when p_kind = 'course' then coalesce((
      select pg_catalog.array_agg(c.id) from public.cls_courses c, n
      where c.org_id::text = n.v ->> 'org'
        and public.view_as_area_has_node(n.v, c.org_id, 'classroom', c.scope_node_id)), '{}')
    when p_kind = 'material' then coalesce((
      select pg_catalog.array_agg(m.id) from public.cls_materials m, n
      where m.org_id::text = n.v ->> 'org'
        and (public.view_as_area_has_node(n.v, m.org_id, 'classroom', public.cls_course_node(m.course_id))
             or public.cls_material_in_area(m.id))), '{}')
    when p_kind = 'location' then coalesce((
      select pg_catalog.array_agg(l.id) from public.sal_locations l, n
      where l.org_id::text = n.v ->> 'org'
        and public.view_as_area_has_node(n.v, l.org_id, 'nail-salon', l.scope_node_id)), '{}')
    else '{}'
  end;
$$;

revoke all on function public.view_as_area_ids(text) from public, anon, authenticated, service_role;
grant execute on function public.view_as_area_ids(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Row-level area policies (RESTRICTIVE; every command — writes are already
--    impossible during a view, and an ordinary request passes at once)
-- ---------------------------------------------------------------------------
do $$
declare
  t record;
  v_node text;
  v_module text;
begin
  for t in
    select c.relname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and (c.relname like 'cls\_%' or c.relname like 'sal\_%')
    order by c.relname
  loop
    v_module := case when t.relname like 'cls\_%' then 'classroom' else 'nail-salon' end;
    -- The row's id column and the kind of in-area id list it must be in. The
    -- list comes from (select …), so it is computed ONCE per query.
    v_node := case
      when t.relname = 'cls_classes' then 'id = any (coalesce((select public.view_as_area_ids(''class'')), ''{}''::uuid[]))'
      when t.relname = 'cls_courses' then 'id = any (coalesce((select public.view_as_area_ids(''course'')), ''{}''::uuid[]))'
      when t.relname = 'cls_materials' then 'id = any (coalesce((select public.view_as_area_ids(''material'')), ''{}''::uuid[]))'
      when t.relname = 'sal_locations' then 'id = any (coalesce((select public.view_as_area_ids(''location'')), ''{}''::uuid[]))'
      when t.relname like 'cls\_%' then 'class_id = any (coalesce((select public.view_as_area_ids(''class'')), ''{}''::uuid[]))'
      else 'location_id = any (coalesce((select public.view_as_area_ids(''location'')), ''{}''::uuid[]))'
    end;
    execute pg_catalog.format(
      'create policy %I on public.%I as restrictive for all to public using (%s)',
      t.relname || '_staff_area', t.relname,
      '(select not public.in_view_as()) or (select public.view_as_platform_ok()) or ' || v_node);
  end loop;
end;
$$;

-- module_roles: the person's grants outside the area do not exist for a staff
-- view (the org home's "your role", the help page, the role booleans' tables).
create policy module_roles_staff_area on public.module_roles
  as restrictive for all to public
  using ((select not public.in_view_as()) or public.view_as_grant_visible(org_id, module_key, scope_ref));

-- Org-level shared rows: a staff view sees only the viewed org's (review HIGH:
-- under a view the person's token read 5 orgs, 24 memberships, 17 scope nodes
-- — other orgs' speed-dating event names among them — where the viewer reads
-- 1 / 4 / 2). Names: only members of the viewed org.
create policy orgs_staff_area on public.orgs
  as restrictive for all to public
  using ((select not public.in_view_as()) or public.view_as_org_ok(id));
create policy org_members_staff_area on public.org_members
  as restrictive for all to public
  using ((select not public.in_view_as()) or public.view_as_org_ok(org_id));
create policy org_modules_staff_area on public.org_modules
  as restrictive for all to public
  using ((select not public.in_view_as()) or public.view_as_org_ok(org_id));
create policy module_scope_nodes_staff_area on public.module_scope_nodes
  as restrictive for all to public
  using ((select not public.in_view_as()) or public.view_as_org_ok(org_id));
create policy profiles_staff_area on public.profiles
  as restrictive for all to public
  using ((select not public.in_view_as()) or public.view_as_profile_ok(user_id));

-- Feedback is author + superadmin only (docs/27): dark to a staff view (the
-- header's unread badge reads 0), unchanged for the superadmin's view.
create policy feedback_tickets_no_staff_view on public.feedback_tickets
  as restrictive for all to public
  using ((select not public.view_as_is_staff_view()));
create policy feedback_messages_no_staff_view on public.feedback_messages
  as restrictive for all to public
  using ((select not public.view_as_is_staff_view()));

-- FILES (test review HIGH, 2026-11-26): storage.objects read policies go through
-- definers (cls_owns_submission, cls_material_storage_visible, vm_is_conv_member,
-- is_org_member…) that never meet the row policies above, so a staff view could
-- read the person's files in another class, chat images and synagogue exports.
-- During a staff view a file is readable only when the ROW that names it is in
-- the area: a material (its course's node), an exam paper or a submission (its
-- class's node). Every other bucket is dark to a staff view. Ordinary requests
-- and the superadmin's view are unchanged.
create function public.view_as_storage_may_read(p_bucket text, p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not public.in_view_as()
      or public.view_as_platform_ok()
      or case p_bucket
           when 'cls-materials' then exists (
             select 1 from public.cls_materials m
             where m.storage_path = p_name
               and (public.view_as_staff_node_ok(m.org_id, 'classroom', public.cls_course_node(m.course_id))
                    or public.cls_material_in_area(m.id)))
           when 'cls-exams' then exists (
             select 1 from public.cls_exam_papers e
             where e.storage_path = p_name
               and public.view_as_staff_node_ok(e.org_id, 'classroom', public.cls_class_node(e.class_id)))
           when 'cls-submissions' then exists (
             select 1 from public.cls_submissions s
             where s.id = case
                     when pg_catalog.pg_input_is_valid(coalesce((storage.foldername(p_name))[3], ''), 'uuid')
                       then ((storage.foldername(p_name))[3])::uuid
                   end
               and public.view_as_staff_node_ok(s.org_id, 'classroom', public.cls_class_node(s.class_id)))
           else false
         end;
$$;

revoke all on function public.view_as_storage_may_read(text, text) from public, anon, authenticated, service_role;
grant execute on function public.view_as_storage_may_read(text, text) to anon, authenticated, service_role;

create policy view_as_staff_area_read on storage.objects
  as restrictive for select to public
  using ((select not public.in_view_as()) or public.view_as_storage_may_read(bucket_id, name));

-- ---------------------------------------------------------------------------
-- 6. The org-wide role booleans: only in-area grants count during a staff view
--    (each body is the live definition with ONE added conjunct)
-- ---------------------------------------------------------------------------
create or replace function public.cls_can_manage(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $$
  select public.is_org_admin(check_org_id)
      or (public.is_org_member(check_org_id) and exists (
           select 1 from public.module_roles g
           where g.org_id = check_org_id
             and g.module_key = 'classroom'
             and g.user_id = auth.uid()
             and public.module_position_rank('classroom', g.role) >= 2
             and ((select not public.in_view_as()) or public.view_as_grant_visible(g.org_id, g.module_key, g.scope_ref))
         ));
$$;

create or replace function public.cls_is_ga(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $$
  select public.is_org_member(check_org_id) and exists (
    select 1 from public.module_roles g
    where g.org_id = check_org_id
      and g.module_key = 'classroom'
      and g.user_id = auth.uid()
      and g.role = 'ga'
      and ((select not public.in_view_as()) or public.view_as_grant_visible(g.org_id, g.module_key, g.scope_ref))
  );
$$;

create or replace function public.has_module_role(check_org_id uuid, check_module_key text, check_role text)
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $$
  select public.is_org_member(check_org_id)
     and exists (
    select 1 from public.module_roles
    where org_id = check_org_id
      and module_key = check_module_key
      and role = check_role
      and user_id = auth.uid()
      and scope_ref is null
      and ((select not public.in_view_as()) or public.view_as_grant_visible(org_id, module_key, scope_ref))
  );
$$;

create or replace function public.module_has_manager_grant(check_org_id uuid, check_module_key text)
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $$
  select public.is_org_member(check_org_id) and exists (
    select 1 from public.module_roles
    where org_id = check_org_id
      and module_key = check_module_key
      and user_id = auth.uid()
      and public.module_position_rank(check_module_key, role) >= 2
      and ((select not public.in_view_as()) or public.view_as_grant_visible(org_id, module_key, scope_ref))
  );
$$;

create or replace function public.sal_can_manage(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $$
  select public.is_org_admin(check_org_id)
      or (public.is_org_member(check_org_id) and exists (
           select 1 from public.module_roles g
           where g.org_id = check_org_id
             and g.module_key = 'nail-salon'
             and g.user_id = auth.uid()
             and public.module_position_rank('nail-salon', g.role) >= 2
             and ((select not public.in_view_as()) or public.view_as_grant_visible(g.org_id, g.module_key, g.scope_ref))
         ));
$$;

create or replace function public.sal_can_operate(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $$
  select public.sal_can_manage(check_org_id)
      or (public.is_org_member(check_org_id) and exists (
           select 1 from public.module_roles g
           where g.org_id = check_org_id
             and g.module_key = 'nail-salon'
             and g.user_id = auth.uid()
             and g.role = 'cashier'
             and ((select not public.in_view_as()) or public.view_as_grant_visible(g.org_id, g.module_key, g.scope_ref))
         ));
$$;

create or replace function public.sal_is_worker(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $$
  select public.is_org_member(check_org_id) and exists (
    select 1 from public.module_roles g
    where g.org_id = check_org_id
      and g.module_key = 'nail-salon'
      and g.user_id = auth.uid()
      and g.role = 'worker'
      and ((select not public.in_view_as()) or public.view_as_grant_visible(g.org_id, g.module_key, g.scope_ref))
  );
$$;

-- CREATE OR REPLACE keeps the ACL; restated anyway (docs/03 #1) — exactly the
-- live grants read 2026-11-26: postgres, authenticated, service_role.
revoke all on function public.cls_can_manage(uuid) from public, anon, authenticated, service_role;
revoke all on function public.cls_is_ga(uuid) from public, anon, authenticated, service_role;
revoke all on function public.has_module_role(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.module_has_manager_grant(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.sal_can_manage(uuid) from public, anon, authenticated, service_role;
revoke all on function public.sal_can_operate(uuid) from public, anon, authenticated, service_role;
revoke all on function public.sal_is_worker(uuid) from public, anon, authenticated, service_role;
grant execute on function public.cls_can_manage(uuid) to authenticated, service_role;
grant execute on function public.cls_is_ga(uuid) to authenticated, service_role;
grant execute on function public.has_module_role(uuid, text, text) to authenticated, service_role;
grant execute on function public.module_has_manager_grant(uuid, text) to authenticated, service_role;
grant execute on function public.sal_can_manage(uuid) to authenticated, service_role;
grant execute on function public.sal_can_operate(uuid) to authenticated, service_role;
grant execute on function public.sal_is_worker(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. The two classroom definers pages call with an id (review R5)
-- ---------------------------------------------------------------------------
create or replace function public.cls_comments_for_my_submission(check_submission_id uuid)
returns table (id uuid, file_path text, line_start integer, line_end integer, body text, created_at timestamptz)
language sql
stable
security definer
set search_path = 'public'
as $$
  select c.id, c.file_path, c.line_start, c.line_end, c.body, c.created_at
  from public.cls_review_comments c
  join public.cls_submissions s on s.id = c.submission_id
  where c.submission_id = check_submission_id
    and s.student_id = auth.uid()
    and public.view_as_may_read_in(s.org_id, 'classroom', public.cls_class_node(s.class_id))
  order by c.file_path, c.line_start nulls first, c.created_at;
$$;

create or replace function public.cls_survey_results(check_survey_id uuid)
returns table (answer text, votes bigint)
language sql
stable
security definer
set search_path = 'public'
as $$
  select a.answer, count(*)::bigint as votes
  from public.cls_survey_answers a
  join public.cls_surveys s on s.id = a.survey_id
  where a.survey_id = check_survey_id
    and s.results_visible
    and (public.cls_is_class_member(s.class_id) or public.cls_can_manage_class(s.org_id, s.class_id))
    and public.view_as_may_read_in(s.org_id, 'classroom', public.cls_class_node(s.class_id))
  group by a.answer
  order by votes desc, a.answer;
$$;

revoke all on function public.cls_comments_for_my_submission(uuid) from public, anon, authenticated, service_role;
revoke all on function public.cls_survey_results(uuid) from public, anon, authenticated, service_role;
grant execute on function public.cls_comments_for_my_submission(uuid) to authenticated, service_role;
grant execute on function public.cls_survey_results(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. Start, list, check, end
-- ---------------------------------------------------------------------------

-- 8a. The people the caller may view in one module of one org (the picker).
create function public.view_as_staff_targets(p_org uuid, p_module text)
returns table (user_id uuid, display_name text, roles text[])
language sql
stable
security definer
set search_path = ''
as $$
  select m.user_id,
         p.display_name,
         -- Only the person's seats IN the caller's area (review: a scoped professor
         -- must not learn of a GA seat in another class).
         (select pg_catalog.array_agg(distinct g.role order by g.role)
          from public.module_roles g
          join public.view_as_staff_area(p_org, auth.uid(), m.user_id) a
            on a.module_key = g.module_key and a.person_scope is not distinct from g.scope_ref
          where g.org_id = p_org and g.user_id = m.user_id and g.module_key = p_module)
  from public.org_members m
  left join public.profiles p on p.user_id = m.user_id
  where auth.uid() is not null
    and not public.in_view_as()
    and m.org_id = p_org
    and m.user_id <> auth.uid()
    and coalesce(m.status, 'active') = 'active'
    and m.role not in ('owner', 'admin')
    and exists (select 1 from public.org_members me
                where me.org_id = p_org and me.user_id = auth.uid()
                  and coalesce(me.status, 'active') = 'active')
    and not exists (select 1 from public.user_private u where u.user_id = m.user_id and u.is_superadmin)
    and exists (select 1 from auth.users u
                where u.id = m.user_id and u.deleted_at is null
                  and (u.banned_until is null or u.banned_until <= pg_catalog.now()))
    and not public.account_has_left(m.user_id)
    and exists (select 1 from public.view_as_staff_area(p_org, auth.uid(), m.user_id) a
                where a.module_key = p_module)
  order by p.display_name nulls last;
$$;

revoke all on function public.view_as_staff_targets(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.view_as_staff_targets(uuid, text) to authenticated;

-- 8b. Start a staff view. Ends the caller's other open view (one at a time).
create function public.view_as_staff_start(p_org uuid, p_target uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null or public.in_view_as() then
    raise exception 'Not allowed';
  end if;
  if p_org is null or p_target is null or p_target = auth.uid() then
    raise exception 'Choose someone else to view';
  end if;

  update public.view_as_real_sessions
  set ended_at = pg_catalog.now()
  where actor_user_id = auth.uid() and ended_at is null;

  insert into public.view_as_real_sessions (actor_user_id, target_user_id, org_id, module_key, kind)
  values (auth.uid(), p_target, p_org, null, 'staff')
  returning id into v_id;

  -- One rule, the same one every request re-checks. A refusal rolls the
  -- insert (and the update above) back with the exception.
  if not public.view_as_staff_live(v_id) then
    raise exception 'You can''t view this person''s screen';
  end if;
  return v_id;
end;
$$;

revoke all on function public.view_as_staff_start(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.view_as_staff_start(uuid, uuid) to authenticated;

-- 8c. view_as_real_check — platform branches unchanged except `kind`; a staff
--     branch. Return type gains kind + area_modules, so drop and re-create
--     (one transaction: the live app never sees it missing).
drop function public.view_as_real_check(uuid, text, boolean);

create function public.view_as_real_check(p_session uuid, p_path text, p_log boolean)
returns table (
  target_user_id uuid,
  target_name text,
  org_id uuid,
  org_slug text,
  org_name text,
  module_key text,
  expires_at timestamptz,
  in_scope boolean,
  kind text,
  area_modules text[]
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  s record;
  v_prefix text;
  v_in boolean;
  v_modules text[];
begin
  if auth.uid() is null or public.is_view_as_request() then
    return;
  end if;

  select vs.id, vs.kind, vs.actor_user_id, vs.target_user_id, vs.org_id, vs.module_key, vs.expires_at, o.slug, o.name
    into s
  from public.view_as_real_sessions vs
  left join public.orgs o on o.id = vs.org_id
  where vs.id = p_session
    and vs.actor_user_id = auth.uid();
  if not found then
    return;
  end if;

  if s.kind = 'staff' then
    if s.slug is null or not public.view_as_staff_live(s.id) then
      return;
    end if;
    select pg_catalog.array_agg(distinct a.module_key order by a.module_key)
      into v_modules
    from public.view_as_staff_area(s.org_id, s.actor_user_id, s.target_user_id) a;
    -- Only the area's module pages of that org (review S4). Everything else —
    -- the org home, members, settings, export, help, other orgs, /dashboard —
    -- renders as the viewer herself.
    -- The module's own "View as" picker (/m/<module>/view-as…) stays the
    -- viewer's: she picks people there, so it must never render as the person.
    v_in := p_path is not null and exists (
      select 1 from pg_catalog.unnest(v_modules) as mk(m)
      where (p_path = '/o/' || s.slug || '/m/' || mk.m
             or pg_catalog.starts_with(p_path, '/o/' || s.slug || '/m/' || mk.m || '/'))
        and p_path <> '/o/' || s.slug || '/m/' || mk.m || '/view-as'
        and not pg_catalog.starts_with(p_path, '/o/' || s.slug || '/m/' || mk.m || '/view-as/')
    );
    return query
      select s.target_user_id,
             (select p.display_name from public.profiles p where p.user_id = s.target_user_id),
             s.org_id, s.slug::text, s.name::text, null::text, s.expires_at, coalesce(v_in, false),
             'staff'::text, v_modules;
    return;
  end if;

  -- PLATFORM (superadmin) sessions — 20261125010000's rule verbatim, plus kind.
  if s.kind is distinct from 'platform' or not public.is_superadmin() then
    return;
  end if;
  select vs.id, vs.target_user_id, vs.org_id, vs.module_key, vs.expires_at, o.slug, o.name
    into s
  from public.view_as_real_sessions vs
  left join public.orgs o on o.id = vs.org_id
  where vs.id = p_session
    and vs.kind = 'platform'
    and vs.actor_user_id = auth.uid()
    and vs.ended_at is null
    and vs.expires_at > pg_catalog.now()
    and vs.target_user_id is not null
    and not exists (select 1 from public.user_private u where u.user_id = vs.target_user_id and u.is_superadmin)
    and (
      (vs.org_id is not null
       and o.id is not null
       and exists (select 1 from public.org_members m
                   where m.org_id = vs.org_id and m.user_id = vs.target_user_id
                     and coalesce(m.status, 'active') = 'active')
       and exists (select 1 from public.org_modules m
                   where m.org_id = vs.org_id and m.module_key = vs.module_key and m.enabled))
      or
      (vs.org_id is null
       and vs.module_key is null
       and exists (select 1 from auth.users u
                   where u.id = vs.target_user_id
                     and u.deleted_at is null
                     and (u.banned_until is null or u.banned_until <= pg_catalog.now()))
       and not public.account_has_left(vs.target_user_id))
    );
  if not found then
    return;
  end if;

  if s.org_id is null then
    v_in := p_path is not null and (
      p_path in ('/dashboard', '/account', '/feedback')
      or pg_catalog.starts_with(p_path, '/dashboard/')
      or pg_catalog.starts_with(p_path, '/account/')
      or pg_catalog.starts_with(p_path, '/feedback/')
      or pg_catalog.starts_with(p_path, '/o/')
    );
  else
    v_prefix := '/o/' || s.slug || '/m/' || s.module_key;
    v_in := p_path = v_prefix or pg_catalog.starts_with(p_path, v_prefix || '/');
  end if;
  v_in := coalesce(v_in, false);
  if v_in and coalesce(p_log, false) then
    insert into public.view_as_real_page_views (session_id, path)
    values (s.id, pg_catalog.left(p_path, 500));
  end if;

  return query
    select s.target_user_id,
           (select p.display_name from public.profiles p where p.user_id = s.target_user_id),
           s.org_id, s.slug::text, s.name::text, s.module_key, s.expires_at, v_in,
           'platform'::text, null::text[];
end;
$$;

revoke all on function public.view_as_real_check(uuid, text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.view_as_real_check(uuid, text, boolean) to authenticated;

-- 8d. End a view: the session's own actor (superadmin or staff).
create or replace function public.view_as_real_end(p_session uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or public.is_view_as_request() then
    raise exception 'Not allowed';
  end if;
  update public.view_as_real_sessions
  set ended_at = pg_catalog.now()
  where id = p_session and actor_user_id = auth.uid() and ended_at is null;
end;
$$;

revoke all on function public.view_as_real_end(uuid) from public, anon, authenticated, service_role;
grant execute on function public.view_as_real_end(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. (NOT done here: dropping the 3-argument view_as_real_start. Five db test
--    files build their "org-scoped v1 session" controls with it; the cleanup
--    stays its own small follow-up, docs/13 "STAFF VIEW AS — AS BUILT".)
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 10. Catalog assertions (an EMPTY database passes: catalog only)
-- ---------------------------------------------------------------------------
do $$
declare
  v_missing text;
begin
  select pg_catalog.string_agg(c.relname, ', ')
    into v_missing
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and (c.relname like 'cls\_%' or c.relname like 'sal\_%')
    and not exists (select 1 from pg_catalog.pg_policy p
                    where p.polrelid = c.oid and p.polname = c.relname || '_staff_area'
                      and not p.polpermissive);
  if v_missing is not null then
    raise exception 'staff view: tables without a restrictive _staff_area policy: %', v_missing;
  end if;
end;
$$;
