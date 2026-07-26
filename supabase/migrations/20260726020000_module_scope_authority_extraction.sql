-- Platform extraction (docs/04 "extract on the second need"): classroom
-- (20260724010000) and nail-salon (20260726010000) both hand-rolled the same
-- scope-authority shape — "is_org_admin OR a grant in (org, module) of
-- sufficient RANK (or a specific ROLE) whose scope COVERS this entity's node".
-- Two modules = the second need, so factor that logic into TWO generic platform
-- primitives and refactor every per-module function onto them.
--
-- WHAT THIS BUYS: the authority LOGIC now lives in ONE place. Change how scope
-- authority works (e.g. a new tier, a coverage tweak) and it changes for every
-- module at once — the same "one guard, many modules" property the hierarchy
-- guard already has. Each module keeps only a TRIVIAL wrapper whose sole job is
-- to resolve its own entity id -> scope node (inherently per-module, since the
-- entity table differs) and delegate. A future module writes a one-liner.
--
-- BEHAVIOR-PRESERVING: this only `create or replace`s the SIX per-module
-- function BODIES; their signatures are unchanged, so every RLS policy and
-- trigger that calls them is untouched. The generic bodies reproduce the inline
-- logic exactly: same is_org_admin short-circuit (rank arm only), same
-- module_position_rank / role predicate, same module_scope_covers(grant_scope,
-- node) direction. The originals JOINed the entity table, so a NOT-FOUND entity
-- eliminated the row and the coverage test never ran (result = is_org_admin
-- only). We reproduce that with an explicit `check_node is not null` guard on
-- the grant arm — WITHOUT it a global grant (scope null) would wrongly cover a
-- null node (module_scope_covers(null,null)=true), diverging from the original
-- (equivalence review, 2026-07-26). In practice every RLS caller passes a real
-- FK node so scope_node_id is never null for an existing row; the guard makes
-- the missing-entity direct-call path fail closed for grants, exactly as before.
--
-- NOTE: the COARSE any-scope entry gates (cls_can_manage(org)/sal_can_manage(org)
-- etc.) are a separate, smaller pattern (no node) — left per-module for now;
-- generalizing them (module_caller_has_rank(org, module, min_rank)) is a future
-- tidy, not required here.

-- ---------------------------------------------------------------------------
-- Generic scope-authority primitives.
-- Definer so they read module_roles/scope regardless of caller RLS; they key on
-- auth.uid() (and is_org_admin, which also keys on auth.uid()), so an
-- unauthenticated caller fails closed. A null check_node means "entity not
-- found": module_scope_covers(scope, null) is true only for a global grant
-- (scope null) — matching the pre-extraction behavior of every wrapper.
-- ---------------------------------------------------------------------------
create function public.module_caller_covers_rank(
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
      or (check_node is not null and exists (
           select 1
           from public.module_roles g
           where g.org_id = check_org_id
             and g.module_key = check_module_key
             and g.user_id = auth.uid()
             and public.module_position_rank(check_module_key, g.role) >= min_rank
             and public.module_scope_covers(g.scope_ref, check_node)
         ));
$$;

-- Role-specific coverage (GA, cashier, …). No is_org_admin bundle — these arms
-- are always OR'd with a rank arm (which carries the admin short-circuit).
create function public.module_caller_covers_role(
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
  select check_node is not null and exists (
    select 1
    from public.module_roles g
    where g.org_id = check_org_id
      and g.module_key = check_module_key
      and g.user_id = auth.uid()
      and g.role = check_role
      and public.module_scope_covers(g.scope_ref, check_node)
  );
$$;

grant execute on function public.module_caller_covers_rank(uuid, text, uuid, integer) to authenticated, service_role;
grant execute on function public.module_caller_covers_role(uuid, text, uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Classroom: collapse onto the generics (entity -> node -> delegate).
-- ---------------------------------------------------------------------------
create or replace function public.cls_can_manage_class(check_org_id uuid, check_class_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.module_caller_covers_rank(check_org_id, 'classroom',
    (select scope_node_id from public.cls_classes where id = check_class_id), 2);
$$;

create or replace function public.cls_can_manage_course(check_org_id uuid, check_course_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.module_caller_covers_rank(check_org_id, 'classroom',
    (select scope_node_id from public.cls_courses where id = check_course_id), 2);
$$;

create or replace function public.cls_is_ga_class(check_org_id uuid, check_class_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.module_caller_covers_role(check_org_id, 'classroom',
    (select scope_node_id from public.cls_classes where id = check_class_id), 'ga');
$$;

create or replace function public.cls_is_ga_course(check_org_id uuid, check_course_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.module_caller_covers_role(check_org_id, 'classroom',
    (select scope_node_id from public.cls_courses where id = check_course_id), 'ga');
$$;

-- ---------------------------------------------------------------------------
-- Nail-salon: collapse onto the generics.
-- ---------------------------------------------------------------------------
create or replace function public.sal_can_manage_location(check_org_id uuid, check_location_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.module_caller_covers_rank(check_org_id, 'nail-salon',
    (select scope_node_id from public.sal_locations where id = check_location_id), 2);
$$;

create or replace function public.sal_can_operate_location(check_org_id uuid, check_location_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.sal_can_manage_location(check_org_id, check_location_id)
      or public.module_caller_covers_role(check_org_id, 'nail-salon',
           (select scope_node_id from public.sal_locations where id = check_location_id), 'cashier');
$$;
