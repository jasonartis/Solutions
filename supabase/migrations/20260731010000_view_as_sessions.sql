-- User-model slice 5 — VIEW-AS (docs/15 §8 + §8.1). The database half.
--
-- This migration is deliberately SMALL, and that is the design, not a shortcut.
-- §8.1's keystone (point 1) is that view-as NEVER widens RLS: it re-renders
-- rows the caller's own policies already return. So there is no new read path
-- here — no SECURITY DEFINER surface reader, no target_user-parameterized
-- function. docs/15's 2026-07-30 decisions entry explicitly REJECTED an
-- RLS-bypassing read path for this feature ("would remove RLS as a backstop
-- against a bad surface declaration for no demonstrated need"), and that
-- rejection is what keeps this file to one table and one guard.
--
-- What DOES need the database is §8.1 point 6: every mode-2 ("see what Smith
-- sees") session start is logged append-only from v1 — actor, target grant,
-- timestamp. Not the later audit upgrade; a security requirement.
--
-- THE LOG ROW *IS* THE SESSION. The app stores this row's id in an HttpOnly
-- cookie and every impersonated render requires it. There is deliberately no
-- way to render mode 2 without first creating a row here, so "logged" is a
-- structural property rather than a call the app is trusted to remember to
-- make. Sessions end by EXPIRY, never by an UPDATE — which is what lets the
-- table stay genuinely append-only (no ended_at column to write).
--
-- ACL (docs/03 #1 and #17 — state the FULL intended ACL, never rely on
-- omission): `revoke all` first, then grant exactly SELECT+INSERT to
-- `authenticated` and SELECT to `service_role`. Omitting a grant is NOT the
-- same as revoking one — on PROD, `ALTER DEFAULT PRIVILEGES FOR ROLE postgres`
-- still auto-grants the full set on every newly created table, and that drift
-- is a KNOWN-OPEN item (docs/15, 2026-07-29 deferral 2; Supabase removes the
-- legacy behaviour 2026-10-30). Without the explicit revoke this table would
-- ship to prod with `authenticated` holding UPDATE, DELETE and the whole-table
-- wipe privilege — the one privilege RLS provably does not gate — so any
-- signed-in user could erase the platform's whole impersonation audit trail.
-- (Phrased that way on purpose: CI's destructive-migration guard greps for the
-- literal word followed by whitespace, in comments too, and adding
-- DESTRUCTIVE-CHANGE-APPROVED here would be a lie — this migration creates a
-- table, touches no rows and drops nothing. docs/03 #17 records the same
-- rewording precedent from the 2026-07-29 ACL sweep.)

create table public.view_as_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  module_key text not null,
  -- FK behaviour is `set null`, NOT cascade — copied deliberately from
  -- vm_moderation_log (20260709100000), the platform's existing audit log. A
  -- security log must outlive the things it describes: with cascade, deleting a
  -- departed user, or an org admin tidying up a course node (an ordinary,
  -- permitted `module_scope_nodes` delete), would silently erase the history of
  -- who impersonated whom. §8.1 point 6 makes this log a security requirement,
  -- and a log a routine admin action can quietly empty does not meet that bar.
  -- The columns are nullable only so `set null` is legal; the guard below
  -- refuses to write a row with a null actor, so no live session lacks one.
  actor_user_id uuid references auth.users (id) on delete set null,
  -- The target is a (person, position, scope) GRANT TRIPLE, never a bare
  -- person (§8.1 point 4): Smith-as-GA must not leak Smith's student-hat
  -- surface. All three columns together identify what was viewed.
  target_user_id uuid references auth.users (id) on delete set null,
  target_role text not null,
  target_scope_ref uuid references public.module_scope_nodes (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes'
);

create index view_as_sessions_actor_idx on public.view_as_sessions (actor_user_id, created_at desc);
create index view_as_sessions_org_idx on public.view_as_sessions (org_id, module_key, created_at desc);

-- Tables created in CLI migrations do NOT inherit Supabase's default API-role
-- grants (2026-07-06 gotcha) — and prod's default privileges over-grant. So:
-- revoke everything, then grant exactly what is needed. No UPDATE, no DELETE,
-- no TRUNCATE, to anyone: that is the append-only enforcement at the privilege
-- layer, which holds even if a policy is later added by mistake.
revoke all privileges on public.view_as_sessions from public, anon, authenticated;
grant select, insert on public.view_as_sessions to authenticated;
grant select on public.view_as_sessions to service_role;

alter table public.view_as_sessions enable row level security;

-- ---------------------------------------------------------------------------
-- The declared edge table, mirrored into SQL.
--
-- The authoritative declaration is TypeScript (§8.1 point 5: edges are CODE,
-- static, immutable at runtime, never tenant-writable). But the app layer
-- cannot be the ONLY gate: `authenticated` can reach this table through
-- PostgREST directly, and the design makes the log row the thing a renderer
-- trusts. Without this function a speed-dating organizer could insert a
-- session row naming a PARTICIPANT — a pair the manifest bans permanently —
-- because rank 2 > rank 0 and the scope covers. The structural floor alone is
-- not the policy.
--
-- So the ON pairs live here too, as an IMMUTABLE hardcoded function in exactly
-- the shape of `module_position_rank()` — code in a migration, not a
-- tenant-writable table (docs/15 §4.1 item 5). Fail-closed: anything not
-- named is FALSE. An RLS-suite test asserts this function agrees with the
-- TypeScript edge map for EVERY ordered pair in every module, so the two
-- cannot drift — the same parity discipline the rank table gets.
--
-- This mirrors mode 2 only. Mode 1 ("as if I held that position") is the
-- caller's own authority filtered down, creates no session and touches no
-- other person's identity, so it has nothing to enforce here.
-- ---------------------------------------------------------------------------
create function public.module_view_as_edge(module_key text, from_role text, to_role text)
returns boolean
language sql
immutable
as $$
  select coalesce(
    case module_key
      when 'classroom' then case from_role
        when 'professor' then case to_role
          when 'ga' then true       -- docs/15 §8: professor -> GA is confirmed
          when 'student' then true  -- resolved ON at build time, 2026-07-30
          else null end
        else null end
      -- Every other module: no pair is ON. nail-salon and speed-dating have
      -- their pairs enumerated and explicitly off in the manifest pending each
      -- module's own view-as surface security review (§8.1 point 9); speed
      -- dating's incoming-to-participant pairs are off permanently (point 7).
      else null
    end,
    false  -- fail closed
  );
$$;

revoke all privileges on function public.module_view_as_edge(text, text, text) from public, anon;
grant execute on function public.module_view_as_edge(text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The guard. Server-stamps identity/time and enforces the SQL-side floor under
-- the manifest's edge table.
--
-- ONE grant held by the actor must satisfy all three conditions at once: it
-- STRICTLY OUTRANKS the target grant, its scope COVERS the target's, and the
-- pair is a DECLARED ON edge. So an equal-rank pair (GA -> student), an upward
-- pair, a cross-scope pair, a target grant that does not exist, and a pair the
-- manifest bans are every one of them refused in the database, independently of
-- whatever the app layer believes. Rank ordering comes from
-- module_position_rank() and the edge table from module_view_as_edge() — the
-- same immutable-config-in-a-migration shape the hierarchy guard already uses.
--
-- Requiring all three of ONE grant matters: a caller holding two grants must
-- not be able to borrow the rank of one and the declared edge of another.
--
-- FOUNDER RULE, 2026-08-02: **org position does not enable view-as; module
-- position does.** So there is deliberately NO is_org_admin() arm here, unlike
-- every other module gate on the platform (docs/03 #9), which all begin
-- `is_org_admin(org) OR ...`. Org MEMBERSHIP remains a precondition — checked
-- above — but org RANK (owner/admin/superadmin) confers nothing.
--
-- This is the direction docs/15 §2.2 and §9 already set, where the
-- is_org_admin coupling is named as legacy to unwind; a brand-new
-- impersonation surface should not add a fresh instance of it. Note the rule
-- adds deliberation, not prevention: the module_roles hierarchy guard exempts
-- org admins (20260720010000:399), so an owner may grant themselves the seat
-- freely — it just becomes an explicit, recorded act rather than an ambient
-- power. Reading the session log IS still open to org admins (the policy
-- below): overseeing impersonation inside your own org is auditing, not
-- view-as.
-- ---------------------------------------------------------------------------
create function public.view_as_guard_session()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_rank integer;
begin
  -- Identity and timing are the server's, always (§8.1 point 2's spirit: no
  -- forged identity anywhere in this feature).
  new.actor_user_id := auth.uid();
  new.created_at := now();
  new.expires_at := now() + interval '30 minutes';

  if new.actor_user_id is null then
    raise exception 'view-as: not signed in';
  end if;

  if not public.is_org_member(new.org_id) then
    raise exception 'view-as: not an active member of this org';
  end if;

  if new.actor_user_id = new.target_user_id then
    raise exception 'view-as: cannot view as yourself (that is mode 1, which needs no session)';
  end if;

  -- The target must be a grant that actually exists, in THIS org and module.
  -- `is not distinct from` so a global target (scope_ref null) matches totally
  -- rather than dropping to NULL (§4.1 item 4's null-semantics rule).
  if not exists (
    select 1
    from public.module_roles g
    where g.org_id = new.org_id
      and g.module_key = new.module_key
      and g.user_id = new.target_user_id
      and g.role = new.target_role
      and g.scope_ref is not distinct from new.target_scope_ref
  ) then
    raise exception 'view-as: no such grant to view as';
  end if;

  target_rank := public.module_position_rank(new.module_key, new.target_role);

  if not exists (
    select 1
    from public.module_roles a
    where a.org_id = new.org_id
      and a.module_key = new.module_key
      and a.user_id = new.actor_user_id
      and public.module_position_rank(new.module_key, a.role) > target_rank
      and public.module_scope_covers(a.scope_ref, new.target_scope_ref)
      and public.module_view_as_edge(new.module_key, a.role, new.target_role)
  ) then
    raise exception 'view-as: no grant of yours outranks, covers, and declares an edge to this target';
  end if;

  return new;
end;
$$;

create trigger view_as_sessions_guard
  before insert on public.view_as_sessions
  for each row execute function public.view_as_guard_session();

-- APPEND-ONLY IS ENFORCED BY THE GRANT LAYER, NOT A TRIGGER — and that is a
-- deliberate correction, not laziness.
--
-- A `before update or delete ... raise exception` trigger was written here
-- first. It is wrong, and the second adversarial review proved it live:
-- Postgres implements `ON DELETE SET NULL` as a real UPDATE on the referencing
-- table, which fires that table's own BEFORE UPDATE triggers. So the moment a
-- scope node or a user had EVER been named in a session, that node/user could
-- never be deleted again — the FK action hit the trigger and aborted the whole
-- delete. `org_id`'s cascade had the same problem for deleting an org. The
-- trigger did not make the log outlive what it describes; it made what it
-- describes undeletable, which is worse and would have broken account erasure
-- and ordinary course reorganisation.
--
-- vm_moderation_log (20260709100000), the audit log this table is modelled on,
-- has no such trigger for exactly this reason: `authenticated` simply holds no
-- UPDATE or DELETE grant, so an api-role write is refused at the privilege
-- layer with 42501 before RLS is even consulted, while internal FK actions —
-- which run as the system, not as an api role — still work. The revoke/grant
-- block above is the enforcement. docs/03 #17's whole point is that the grant
-- layer is the gate for "may this role touch the object at all".

-- ---------------------------------------------------------------------------
-- RLS. Insert pinned to the caller (defence in depth beside the guard trigger,
-- the same division of labour as org_members_write_org_admin — docs/15 §4.1
-- item 6). No UPDATE or DELETE policy exists, on purpose — and with no grant
-- either, an api-role write is refused at the privilege layer regardless.
--
-- Reads: the actor sees their own sessions, and org admins see the org's — a
-- security log nobody can review is not a control. The TARGET deliberately has
-- no read arm in v1: §8.1 point 6 makes notifying targets "a per-module product
-- decision", and adding it later is a policy, not a redesign.
-- ---------------------------------------------------------------------------
create policy view_as_sessions_insert_actor on public.view_as_sessions
  for insert to authenticated
  with check (actor_user_id = auth.uid() and public.is_org_member(org_id));

create policy view_as_sessions_select_actor on public.view_as_sessions
  for select to authenticated
  using (actor_user_id = auth.uid());

create policy view_as_sessions_select_org_admin on public.view_as_sessions
  for select to authenticated
  using (public.is_org_admin(org_id));

-- Trigger functions hold no api-role EXECUTE (docs/03 #17; EXECUTE is checked
-- at `create trigger` time, not fire time — established empirically 2026-07-29).
revoke execute on function public.view_as_guard_session() from public, anon, authenticated;
