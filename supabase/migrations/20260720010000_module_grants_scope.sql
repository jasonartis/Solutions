-- Module grants generalization — slice 1 (docs/15 §11 slice 1, 2026-07-20).
--
-- Generalizes flat, org-wide `module_roles` into SCOPED grants: a grant is
-- (user, position, scope), where scope points at a node of a per-module entity
-- tree (null = global = the whole module). Ports the org role-hierarchy guard
-- (20260717010000) onto module grants with the added scope dimension, per the
-- two-branch rule in docs/15 §4.
--
-- ===========================================================================
-- PURELY ADDITIVE — this is the load-bearing property of the whole slice.
-- ===========================================================================
--   * Every existing module_roles row is GLOBAL (scope_ref defaults to null),
--     so it behaves EXACTLY as today.
--   * has_module_role() is hardened to match ONLY global grants, so a future
--     scoped grant can never leak global authority through the legacy,
--     scope-blind policies of the 7 shipped modules.
--   * The generic rank table maps ONLY the generic tier vocabulary
--     (director/coordinator/lead/position). Every real module role string
--     (professor, ga, cashier, single, maker, …) stays UNMAPPED → rank 0 →
--     invisible to the new ladder. Slice 2 maps each module's vocabulary.
--   * The new guard trigger BYPASSES the rank rules for exactly the parties
--     who can write module_roles today — service role, superadmin, org
--     owner/admin — so no existing write path changes. The ladder only
--     constrains NON-admin module staff, who could not write module_roles at
--     all until now. The new capability is granted by an additive RLS policy.
--
-- ===========================================================================
-- docs/15 §4.1 hardening commitments (independent Fable red-team) — slice 1
-- items are REQUIRED acceptance criteria, mapped to where each is enforced:
--   1. UPDATE checks caller coverage of BOTH old AND new scope/position
--      -> module_roles_guard_hierarchy UPDATE branch (two can_manage checks).
--   2. Scope-node tenancy validation (node exists; org_id+module_key match),
--      UNCONDITIONAL (never inside the bypass)
--      -> module_roles_guard_hierarchy step (1).
--   3. scope_ref FK is ON DELETE CASCADE (never SET NULL)
--      -> the alter table below. Node ids never reused; coverage is id-path.
--   4. Null/global comparisons are TOTAL predicates (no bare <> three-valued
--      NULL slip) -> module_scope_covers / module_scope_strictly_contains use
--      explicit IS NULL cases; re-point pins use IS DISTINCT FROM.
--   5. Rank mapping is immutable, migration-owned config
--      -> module_position_rank() is IMMUTABLE SQL, not a table.
--   6. RLS write policies alongside the trigger (WITH CHECK pins org)
--      -> module_roles_{insert,update,delete}_module_manager + the trigger,
--      mirroring org_members_write_org_admin's division of labor.
--   7. Tree path is trigger-computed (client values ignored); coverage is an
--      indexed prefix match, not per-row recursion
--      -> module_scope_nodes_set_path + module_scope_nodes_path_idx.
--   8. Node re-parenting is a guarded/audited op — DEFERRED to slice 2 and
--      BLOCKED here: parent_id/org_id/module_key/id are immutable after insert
--      -> module_scope_nodes_set_path UPDATE branch raises on any change.
--   9. Last-Director-standing covers delete/demote/user-repoint/scope-change,
--      counted per (org, module_key), and must NOT block the org escape hatch
--      -> module_roles_guard_last_director (org admins/superadmin exempt).

-- ---------------------------------------------------------------------------
-- 1. module_scope_nodes — the per-module entity tree that scope_ref points at.
--    A node belongs to exactly one (org, module). Nesting is via parent_id;
--    a trigger-computed materialized `path` of node ids drives O(prefix)
--    ancestry coverage. Scopes are inherently module-local (docs/15 §3): a
--    node's parent must live in the same (org, module), enforced in the trigger.
-- ---------------------------------------------------------------------------
create table public.module_scope_nodes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  module_key text not null,
  parent_id uuid references public.module_scope_nodes (id) on delete cascade,
  name text not null,
  -- Optional free-text per-module label (department/course/class/location/…).
  -- Slice 1 does not interpret it; slice 2's per-module vocabulary will.
  node_type text,
  -- Materialized path of node ids, '<root>/<child>/…/<self>/'. TRIGGER-OWNED:
  -- any client value is overwritten on insert and pinned on update (item 7).
  path text not null default '',
  created_at timestamptz not null default now()
);

-- Tables created in CLI migrations do NOT inherit Supabase's default grants
-- (2026-07-06 gotcha) — grant explicitly; RLS then restricts the rows.
grant select, insert, update, delete on public.module_scope_nodes to authenticated, service_role;

create index module_scope_nodes_org_module_idx on public.module_scope_nodes (org_id, module_key);
-- Prefix-match index for ancestry coverage (item 7): text_pattern_ops so
-- `d.path like a.path || '%'` can use the index rather than scanning.
create index module_scope_nodes_path_idx on public.module_scope_nodes (path text_pattern_ops);

-- Trigger-computed path + structural immutability (items 7 & 8).
create function public.module_scope_nodes_set_path()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent_path text;
  parent_org uuid;
  parent_module text;
begin
  if tg_op = 'UPDATE' then
    -- Slice 1: the tree shape is immutable after insert. Re-parenting (which
    -- rewrites every permission answer beneath a node) is a guarded, audited
    -- operation deferred to slice 2 (docs/15 §4.1 item 8). Pin the structural
    -- columns and the computed path to their committed values; only `name`,
    -- `node_type` may change.
    if new.parent_id is distinct from old.parent_id
       or new.org_id is distinct from old.org_id
       or new.module_key is distinct from old.module_key
       or new.id is distinct from old.id then
      raise exception 'module_scope_nodes: re-parenting or re-keying a node is not supported yet (slice 2)';
    end if;
    new.path := old.path; -- the materialized path is never client-writable
    return new;
  end if;

  -- INSERT: compute the materialized path from the parent; ignore client path.
  if new.id is null then
    new.id := gen_random_uuid();
  end if;
  if new.parent_id is null then
    new.path := new.id::text || '/';
  else
    select path, org_id, module_key
      into parent_path, parent_org, parent_module
      from public.module_scope_nodes
      where id = new.parent_id;
    if parent_path is null then
      raise exception 'module_scope_nodes: parent % does not exist', new.parent_id;
    end if;
    -- Scopes are module-local (docs/15 §3 / §4.1 item 2): a node's parent must
    -- live in the same (org, module) tree, so every path stays within one tenant.
    if parent_org <> new.org_id or parent_module <> new.module_key then
      raise exception 'module_scope_nodes: parent belongs to a different org/module';
    end if;
    new.path := parent_path || new.id::text || '/';
  end if;
  return new;
end;
$$;

create trigger module_scope_nodes_set_path
  before insert or update on public.module_scope_nodes
  for each row execute function public.module_scope_nodes_set_path();

alter table public.module_scope_nodes enable row level security;

-- Reads: any org member (they may need to render the tree). Writes: org
-- owner/admin (they sit above every module ladder — §2.2). Slice 1
-- deliberately does NOT let a scoped coordinator create child nodes; that
-- scope-guarded node creation is slice-2 module-ladder work.
create policy module_scope_nodes_select_member on public.module_scope_nodes
  for select using (public.is_org_member(org_id) or public.is_superadmin());
create policy module_scope_nodes_write_org_admin on public.module_scope_nodes
  for all using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));

-- ---------------------------------------------------------------------------
-- 2. Extend module_roles: scope_ref (null = global) + granted_by (audit).
--    scope_ref ON DELETE CASCADE (item 3): a grant dies with its node; never
--    SET NULL (that would silently promote a scoped seat to GLOBAL authority).
--    granted_by is an audit pointer only this slice (server-stamping + pinning
--    is slice 4) — SET NULL on granter deletion is fine, it bears no authority.
-- ---------------------------------------------------------------------------
alter table public.module_roles
  add column scope_ref uuid references public.module_scope_nodes (id) on delete cascade,
  add column granted_by uuid references auth.users (id) on delete set null;

create index module_roles_scope_ref_idx on public.module_roles (scope_ref);

-- ---------------------------------------------------------------------------
-- 3. Generic position-rank config (item 5). IMMUTABLE, migration-owned — never
--    a tenant-writable table. Slice 1 maps ONLY the generic tier vocabulary;
--    real module role strings stay unmapped (rank 0) → invisible to the ladder.
-- ---------------------------------------------------------------------------
create function public.module_position_rank(role text)
returns integer
language sql
immutable
as $$
  select case role
    when 'director' then 4     -- module top authority (appointed by org owner/admin)
    when 'coordinator' then 3  -- manages a slice; global or scoped subtree
    when 'lead' then 2         -- runs one entity
    when 'position' then 1     -- generic entity position (staff / end user)
    else 0                     -- unmapped (all shipped module roles, for now)
  end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Scope coverage / strict-containment — TOTAL predicates over nullable
--    scopes (item 4). null = global. Coverage walks node ids via the
--    materialized path prefix (ids never reused, item 3), never string equality
--    of arbitrary labels. Definer so they read the tree regardless of caller RLS.
-- ---------------------------------------------------------------------------
-- Does `ancestor` (a scope) COVER `descendant` (a scope)?  covers = self-or-under.
-- Fable re-review, 2026-07-20 (pre-push): NOT granted to `authenticated`
-- (below) — these are boolean-oracle definer functions with no membership
-- gate of their own (they only take two node ids, no org context to check
-- membership against). Called ONLY internally by module_caller_can_manage_seat
-- (itself security definer, so the internal call succeeds via ownership
-- regardless of grants) — never referenced by an RLS policy body or invoked
-- directly via .rpc() anywhere in the app/tests (verified by grep). Direct
-- client access would let any authenticated user learn a true ancestry fact
-- about two node ids they already hold, breaking this codebase's convention
-- that boolean-reveal definer functions still gate on org membership
-- (mm_shared_answers, sal_worker_has_time_off, sd_side_registered_count) —
-- low practical severity (needs pre-known UUIDs, which are themselves only
-- readable by org members) but an easy, worthwhile close.
create function public.module_scope_covers(ancestor uuid, descendant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when ancestor is null then true      -- global covers every scope
    when descendant is null then false   -- a node never covers global
    else exists (
      select 1
      from public.module_scope_nodes a
      join public.module_scope_nodes d on d.path like a.path || '%'
      where a.id = ancestor and d.id = descendant
    )
  end;
$$;

-- Does `ancestor` STRICTLY contain `descendant`? (proper subtree — not itself)
create function public.module_scope_strictly_contains(ancestor uuid, descendant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when ancestor is null and descendant is null then false  -- global vs global = peers
    when ancestor is null then true                          -- global strictly contains any node
    when descendant is null then false                       -- no node contains global
    else exists (
      select 1
      from public.module_scope_nodes a
      join public.module_scope_nodes d on d.path like a.path || '%'
      where a.id = ancestor and d.id = descendant and a.id <> d.id
    )
  end;
$$;

-- ---------------------------------------------------------------------------
-- 5. The authority test (docs/15 §4). The caller may create/change/remove a
--    seat (position=seat_role, scope=seat_scope) iff SOME grant they hold in
--    this (org, module) satisfies branch A OR branch B:
--      A. strictly OUTRANKS the seat AND covers its scope; OR
--      B. is the SAME position with the seat's scope STRICTLY INSIDE the grant's.
--    Branch B is what lets equal-rank coordinator chains nest (STEM→Math).
--    Definer so it reads the caller's grants regardless of RLS.
-- ---------------------------------------------------------------------------
create function public.module_caller_can_manage_seat(
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
  select exists (
    select 1
    from public.module_roles g
    where g.org_id = check_org_id
      and g.module_key = check_module_key
      and g.user_id = auth.uid()
      and (
        -- Branch A: strictly outrank + scope coverage.
        (public.module_position_rank(g.role) > public.module_position_rank(seat_role)
           and public.module_scope_covers(g.scope_ref, seat_scope))
        -- Branch B: same position + strict scope containment.
        or (g.role = seat_role
           and public.module_scope_strictly_contains(g.scope_ref, seat_scope))
      )
  );
$$;

-- Coarse "may attempt a module_roles write" gate for the RLS policy (item 6):
-- the caller holds a coordinator-or-higher grant in this (org, module). The
-- trigger then tightens to the exact rank/scope rule — the same policy+trigger
-- division of labor as org_members_write_org_admin.
create function public.module_has_manager_grant(check_org_id uuid, check_module_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.module_roles
    where org_id = check_org_id
      and module_key = check_module_key
      and user_id = auth.uid()
      and public.module_position_rank(role) >= 3
  );
$$;

grant execute on function public.module_position_rank(text) to authenticated, service_role;
-- module_scope_covers / module_scope_strictly_contains deliberately NOT
-- reachable by `authenticated` (see the comment above their definitions) —
-- and PostgreSQL grants EXECUTE to PUBLIC on every function by default at
-- CREATE time, so merely omitting an explicit `grant ... to authenticated`
-- changes NOTHING: PUBLIC already covers every role, including the fully
-- unauthenticated `anon` role. These two are the one pair in this migration
-- where that default actually matters — unlike every other definer function
-- in this codebase (which keys on auth.uid(), NULL for an anon caller, and
-- so fails closed regardless of the grant) these take two bare node ids with
-- NO identity check, so the implicit PUBLIC grant would let a fully
-- unauthenticated caller learn a true ancestry fact. Revoke PUBLIC
-- explicitly, then grant back only to service_role (harmless — needed for no
-- current caller, since owners always retain implicit rights on their own
-- functions for internal calls, but explicit for symmetry/documentation).
revoke execute on function public.module_scope_covers(uuid, uuid) from public;
revoke execute on function public.module_scope_strictly_contains(uuid, uuid) from public;
grant execute on function public.module_scope_covers(uuid, uuid) to service_role;
grant execute on function public.module_scope_strictly_contains(uuid, uuid) to service_role;
grant execute on function public.module_caller_can_manage_seat(uuid, text, text, uuid) to authenticated, service_role;
grant execute on function public.module_has_manager_grant(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. The guard. BEFORE INSERT/UPDATE/DELETE so the caller gets a clear error
--    rather than a silent RLS no-op — ported from org_members_guard_hierarchy.
-- ---------------------------------------------------------------------------
create function public.module_roles_guard_hierarchy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  node_org uuid;
  node_module text;
begin
  -- (1) UNCONDITIONAL scope-node tenancy validation (item 2). Runs for
  --     EVERYONE incl. the service role / superadmin / org admin: a scoped
  --     grant's node must exist and live in the grant's own (org, module). A
  --     cross-tenant scope pointer is a data-integrity breach no bypass may let
  --     through. Validated on the post-image (new.scope_ref).
  if tg_op in ('INSERT', 'UPDATE') and new.scope_ref is not null then
    select org_id, module_key into node_org, node_module
      from public.module_scope_nodes where id = new.scope_ref;
    if node_org is null then
      raise exception 'module_roles: scope node % does not exist', new.scope_ref;
    end if;
    if node_org <> new.org_id or node_module <> new.module_key then
      raise exception 'module_roles: scope node belongs to a different org/module (tenancy violation)';
    end if;
  end if;

  -- (1b) UNCONDITIONAL structural pin (Fable re-review, 2026-07-20, pre-push):
  --      org_id and module_key never move on UPDATE, for ANYONE — including
  --      an admin of both the old and new org. No legitimate operation needs
  --      this: the app's upsert path can only touch non-PK columns (it
  --      upserts on the full composite key), and the §2.2 Director-
  --      reassignment escape hatch only ever changes user_id. An earlier
  --      version of this guard pinned org_id/module_key only inside the
  --      NON-admin branch below (3), so an admin who happened to administer
  --      two orgs could move a grant's org_id between them via one UPDATE —
  --      not a privilege escalation (they already control both orgs; the
  --      same move is reachable via delete+insert) but a real gap between
  --      this migration's own stated intent and what it enforced. Closed
  --      here, unconditionally, before the admin bypass.
  if tg_op = 'UPDATE' and (new.org_id <> old.org_id or new.module_key <> old.module_key) then
    raise exception 'A module grant cannot be reassigned to a different org or module';
  end if;

  -- (2) Bypass the RANK rules for parties ABOVE every module ladder: the
  --     service role (auth.uid() null — seed/worker), a superadmin, and — the
  --     legacy coupling docs/15 §9 unwinds later — an org owner/admin, who
  --     appoints and may reassign the module Director at any time (§2.2 escape
  --     hatch). These are exactly the parties who can write module_roles TODAY,
  --     so this is what keeps the change purely additive.
  -- The admin bypass is evaluated on the row's EXISTING org for UPDATE/DELETE
  -- (old.org_id) and on the new org only for INSERT. Symmetric with the RLS
  -- USING clauses (which gate UPDATE/DELETE on the old row), so an admin of
  -- org B can never bypass by relabeling an org-A row to org B — moot anyway
  -- now that step (1b) pins org_id/module_key unconditionally for everyone.
  if auth.uid() is null
     or public.is_superadmin()
     or public.is_org_admin(case when tg_op = 'INSERT' then new.org_id else old.org_id end) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- (3) Non-admin module staff: the two-branch ladder rule.
  if tg_op = 'INSERT' then
    if new.user_id = auth.uid() then
      raise exception 'You cannot grant a module position to yourself';
    end if;
    if not public.module_caller_can_manage_seat(new.org_id, new.module_key, new.role, new.scope_ref) then
      raise exception 'You do not have authority to grant this position at this scope';
    end if;
    return new;

  elsif tg_op = 'UPDATE' then
    -- Own-seat block on EITHER side of a re-point.
    if old.user_id = auth.uid() or new.user_id = auth.uid() then
      raise exception 'You cannot change your own module seat';
    end if;
    -- A grant may never be moved to a different user (org_id/module_key are
    -- already pinned UNCONDITIONALLY in step (1b) above, for every caller).
    if new.user_id <> old.user_id then
      raise exception 'A module grant cannot be reassigned to a different user';
    end if;
    -- Re-point defense (item 1): the caller must have authority over BOTH the
    -- seat as it stands AND the seat it would become. Otherwise a Math
    -- coordinator re-points professor@Math101 to global and mints module-wide
    -- power — the 2026-07-16 org-guard re-point bug class, closed here too.
    if not public.module_caller_can_manage_seat(old.org_id, old.module_key, old.role, old.scope_ref) then
      raise exception 'You do not have authority over this seat as it currently stands';
    end if;
    if not public.module_caller_can_manage_seat(new.org_id, new.module_key, new.role, new.scope_ref) then
      raise exception 'You do not have authority to move this seat to that position/scope';
    end if;
    return new;

  else -- DELETE
    if old.user_id = auth.uid() then
      raise exception 'You cannot remove your own module seat';
    end if;
    if not public.module_caller_can_manage_seat(old.org_id, old.module_key, old.role, old.scope_ref) then
      raise exception 'You do not have authority to remove this position at this scope';
    end if;
    return old;
  end if;
end;
$$;

create trigger module_roles_guard_hierarchy
  before insert or update or delete on public.module_roles
  for each row execute function public.module_roles_guard_hierarchy();

-- ---------------------------------------------------------------------------
-- 7. Last-Director-standing (item 9). Mirrors org_members_guard_last_admin,
--    counted per (org, module_key). Unlike the org guard it EXEMPTS the org
--    escape-hatch parties (service role / superadmin / org owner/admin): they
--    may reassign or transiently empty the Director seat because they can
--    always re-appoint one — blocking them would break "the org never loses
--    control of its module" (§2.2). Among non-admins the rank rules already
--    forbid removing a Director (a peer can't touch a peer; own-seat is
--    blocked), so for slice 1 this guard is LATENT but correct and covers every
--    losing shape for when slice 2 puts real Director grants in non-admin hands.
-- ---------------------------------------------------------------------------
create function public.module_roles_guard_last_director()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  losing boolean;
begin
  -- Only a Director (top tier) row can be the seat that keeps a module headed.
  if public.module_position_rank(old.role) < 4 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- Escape-hatch parties are exempt (see header).
  if auth.uid() is null
     or public.is_superadmin()
     or public.is_org_admin(old.org_id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    losing := true;
  else -- UPDATE: any shape that stops this row being a Director of this (org, module)
    losing := public.module_position_rank(new.role) < 4
           or new.org_id <> old.org_id
           or new.module_key <> old.module_key
           or new.user_id <> old.user_id
           or (new.scope_ref is distinct from old.scope_ref);
  end if;

  if losing and not exists (
    select 1 from public.module_roles
    where org_id = old.org_id
      and module_key = old.module_key
      and public.module_position_rank(role) >= 4
      and user_id <> old.user_id
  ) then
    raise exception 'A module must keep at least one Director';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger module_roles_guard_last_director
  before delete or update on public.module_roles
  for each row execute function public.module_roles_guard_last_director();

-- ---------------------------------------------------------------------------
-- 8. Additive RLS write policies for non-admin module managers (item 6).
--    Split by command so SELECT stays member-only (never widened). The WITH
--    CHECK / USING pin every touched row to an (org, module) where the caller
--    holds a coordinator-or-higher grant; the trigger does the fine-grained
--    rank/scope enforcement. Purely additive: no shipped role maps to rank>=3,
--    so this grants nothing to any existing user today.
--    (The existing module_roles_write_superadmin / _write_org_admin policies
--    are untouched and still cover superadmin + org-admin writes.)
-- ---------------------------------------------------------------------------
create policy module_roles_insert_module_manager on public.module_roles
  for insert with check (public.module_has_manager_grant(org_id, module_key));
create policy module_roles_update_module_manager on public.module_roles
  for update using (public.module_has_manager_grant(org_id, module_key))
             with check (public.module_has_manager_grant(org_id, module_key));
create policy module_roles_delete_module_manager on public.module_roles
  for delete using (public.module_has_manager_grant(org_id, module_key));

-- ---------------------------------------------------------------------------
-- 9. Harden has_module_role: match ONLY global grants (scope_ref is null).
--    A scoped grant (professor@CS101) must NOT read as module-wide authority
--    through the legacy, scope-blind policies of the shipped modules. Every
--    existing grant is global, so today's behavior is byte-for-byte identical;
--    scoped grants stay invisible to legacy policies until each module's
--    slice-2 rewrite teaches its own policies to walk scope. `create or
--    replace` restates the full definer + search_path attributes (not inherited).
-- ---------------------------------------------------------------------------
create or replace function public.has_module_role(check_org_id uuid, check_module_key text, check_role text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.module_roles
    where org_id = check_org_id
      and module_key = check_module_key
      and role = check_role
      and user_id = auth.uid()
      and scope_ref is null
  );
$$;
