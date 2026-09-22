-- Visual messaging: the last-admin floor now counts only seats that actually
-- CONFER adminship (2026-09-22). docs/19's STILL-OPEN item 2.
--
-- THE GAP. `vm_pin_member` (BEFORE UPDATE) and
-- `vm_guard_last_conversation_admin` (BEFORE DELETE, 20260914020000) both
-- decide whether a conversation keeps an admin with the identical predicate:
--
--     where conversation_id = old.conversation_id
--       and role = 'admin' and status = 'active' and id <> old.id
--
-- Since `20260910040000` a module roster row confers NOTHING once its holder
-- stops being an active org member — `vm_is_conv_admin` gained
-- `is_org_member(m.org_id)`, so such a seat cannot read the conversation, let
-- alone administer it. But the floor above never learned that. It still counts
-- the dead seat.
--
-- THE CONCRETE FAILURE, spelled out because the predicate alone does not convey
-- it. A conversation has two admins, Alice and Bob. Bob leaves the org. Bob's
-- seat now confers nothing. Alice is the only person who can actually
-- administer the conversation — and because the floor still counts Bob, Alice
-- is permitted to leave. What is left behind is a conversation whose sole
-- remaining "admin" cannot administer it: nobody can add a member, remove one,
-- rename it or moderate it, and only a vm module manager can repair it.
-- **The guard that exists precisely to prevent orphaning is what permits it.**
--
-- 20260914020000's own header recorded this as a KNOWN GAP inherited
-- deliberately, so that the DELETE path and the UPDATE path would not drift
-- apart while it stood. This migration closes it in both, at once.
--
-- ============================================================================
-- MEASURED FIRST, because this guard now fires MORE often
-- ============================================================================
-- Every previous migration in docs/19's remediation took access AWAY from
-- seats that should not have had it. This one takes away an ABILITY — someone
-- who can leave a conversation today may not be able to afterwards. That is a
-- user-visible behaviour change, which is why it is its own migration.
--
-- Pre-flight, `scripts/prod-verify-seat-authority-orphans.mts` [4] FLOOR
-- dimension, run against PROD 2026-09-22 (5 control checks passed, 0 failed):
--
--     vm_conversations                   0
--     vm_conversation_members            0
--     active ADMIN seats                 0
--
-- **ZERO. And the script says so as "VACUOUS", not as "zero affected"** — the
-- honest reading is that production has no visual-messaging data at all, so
-- nobody can be affected because nobody is using the feature yet, NOT that the
-- new predicate was proven harmless against real rows. The seed creates no
-- conversations either (`seed.ts` deletes them and makes none), so the same is
-- true locally. The behavioural proof therefore lives entirely in
-- `rls.test.ts`, which builds its own conversations — see the tests added
-- alongside this file, including a CONTROL that the pre-fix predicate WOULD
-- have counted the orphaned seat, so the new tests cannot pass vacuously.
--
-- ============================================================================
-- WHY `is_org_member()` CANNOT BE USED HERE — the trap that shapes this file
-- ============================================================================
-- `is_org_member(check_org_id)` answers **about the CALLER** (`auth.uid()`,
-- 20260727010000:81-94). The floor asks about OTHER PEOPLE: "does some seat
-- other than this one belong to someone who is still in the org?" The caller's
-- own membership is not the question, and there is no two-argument membership
-- helper anywhere in the schema (searched: `shares_org_with` is also
-- caller-relative; nothing else takes a user).
--
-- This is exactly docs/22 §23.4's lesson (1) in a new place: `is_superadmin()`
-- could not absorb `org_accept_invite`'s call site for the same reason — a
-- helper that only answers about the caller cannot answer about a third party.
-- So the membership test below is written against the SEAT's own `user_id` and
-- the SEAT's own `org_id`, matching how every conjunct in `20260910040000` was
-- written (`and public.is_org_member(a.org_id)` on the row's own org column).
--
-- ============================================================================
-- ONE DEFINITION, TWO CALL SITES — why a helper instead of a second copy
-- ============================================================================
-- The two functions today hold BYTE-IDENTICAL copies of the floor, and
-- 20260914020000's header explains that as deliberate: "the SAME definition of
-- the seat that matters ... so the two paths cannot drift." The copies did not
-- drift — and that is the point: **they were identically WRONG, and the defect
-- had to be fixed twice.** Copying is what makes a predicate expensive to
-- correct, not what makes it safe.
--
-- So the semantic definition — *what makes a seat count toward the floor* —
-- moves into ONE function, `vm_seat_holds_admin_floor(member_id)`, and both
-- triggers call it. What remains duplicated is only the two-line scaffolding
-- ("same conversation, not this row"), which carries no meaning that can rot.
--
-- The helper is used by BOTH call sites the moment it is created, so it is an
-- extraction, not a speculative primitive (CLAUDE.md's standing rule).
--
-- ============================================================================
-- THE SYMMETRY THAT IS EASY TO MISS — step 3 and step 4 must agree
-- ============================================================================
-- Each guard asks TWO questions, and both are about "is this seat a
-- floor-holder?":
--
--   (3) is the seat being removed/demoted one of the seats holding the floor?
--       If not, let it go — a participant, viewer or banned seat leaves freely.
--   (4) is there ANOTHER seat holding the floor? If not, refuse.
--
-- Fixing only (4) would leave the two halves using DIFFERENT definitions of the
-- same phrase inside one function — the precise failure this migration exists
-- to repair, reintroduced one line lower. Both now call the same helper.
--
-- It also matters behaviourally, and only on the DELETE path. `vm_members_delete_self`
-- is a bare `user_id = auth.uid()` with no org conjunct (verified against
-- pg_policy), so an ORPHANED admin can still reach this trigger to delete their
-- own dead seat. With (3) left unfixed they would be newly REFUSED — trapped
-- holding a seat that grants them nothing, in a conversation they cannot even
-- read. And that refusal would be pure friction: under the new predicate an
-- orphaned seat does not count toward the floor, so removing it can never take
-- the floor from 1 to 0. **Running the floor check on a non-counting seat can
-- only ever produce a spurious refusal**, which is why (3) is not a new
-- carve-out but the removal of a check that this migration makes vacuous.
--
-- On the UPDATE path the same change is ALMOST a no-op, and the exception is
-- named here rather than rounded off (found by adversarial review, 2026-09-22;
-- an earlier draft of this header claimed a flat "no-op" and was wrong).
--
-- The ORG-MEMBERSHIP half genuinely cannot bite there: reaching the floor in
-- `vm_pin_member` requires `vm_is_conv_admin`, which since 20260904010000
-- already requires the CALLER's own active org membership, so whoever gets that
-- far is themselves another effective admin.
--
-- But the helper also folds in `status = 'active'` on the seat BEING CHANGED,
-- where the old branch test was `old.role = 'admin'` alone. So a BANNED seat
-- that still carries `role = 'admin'` used to enter the floor check and no
-- longer does. Benign, for exactly the step-(3) reason above: such a seat never
-- satisfied `vm_is_conv_admin` either, so it never counted toward the floor,
-- and running the floor check on a seat that does not count could only ever
-- refuse spuriously. Asserted by a test rather than left to this paragraph.
--
-- ============================================================================
-- A MULTI-ROW DELETE, AND THE VOLATILITY THIS QUIETLY DEPENDS ON
-- ============================================================================
-- `vm_members_delete_admin` is row-unbounded, so one statement can remove
-- several seats: `delete from vm_conversation_members where conversation_id = X`.
-- The guard must still refuse, and it does — a row-level BEFORE trigger sees
-- the rows the same outer command has already processed, so the second admin
-- seat's check finds no surviving floor-holder and raises. Measured, not
-- assumed (probe + an RLS test, 2026-09-22).
--
-- **But that visibility is a property of the CALLING function's volatility, not
-- of the helper's** (adversarial review, 2026-09-22 — this was not obvious and
-- is the kind of thing that rots silently). Both triggers are plpgsql and
-- default VOLATILE, so each SQL statement inside them takes a fresh snapshot
-- after a CommandCounterIncrement, and the helper's `stable` simply inherits
-- it. If either trigger function were ever marked `stable` as a tidy-up, prior
-- rows' deletions would become invisible and a single multi-row DELETE would
-- silently orphan a conversation — no error, no test failure anywhere else.
-- Section 4 below therefore ASSERTS both are volatile, so that tidy-up fails
-- loudly instead.
--
-- ============================================================================
-- WHAT THIS DOES **NOT** FIX, stated so it is not mistaken for closed
-- ============================================================================
-- Nothing fires on `org_members` DELETE. So a conversation can still arrive at
-- zero effective admins the moment its SOLE admin leaves the org — this guard
-- governs seat writes, not org departures, and no trigger anywhere walks the
-- module rosters when a membership ends (docs/19's central finding: nothing has
-- a foreign key to `org_members`). Repair stays what it always was: a vm module
-- manager or org admin, via the manage escape.
--
-- What changes is honesty. Before, the floor CONCEALED that state by counting
-- the dead seat, and cheerfully let the last real admin walk out on top of it.
-- Now the conversation is visibly adminless and the guard stops making it
-- worse. Closing the remaining half means reacting to org departure itself,
-- which is docs/21's account-deletion/departed-user territory, not this file's.
--
-- ============================================================================
-- WHAT THIS DELIBERATELY DOES NOT CHANGE
-- ============================================================================
--   * SELF-BLOCK IS UNTOUCHED (20260910030000). `vm_pin_member`'s self-service
--     branch — the role pin, and the single 'active' -> 'banned' carve-out that
--     is the platform's ONLY user-level block — is restated below verbatim.
--     docs/03 #23 and 20260914010000's header both warn against "tidying" this
--     function; in particular it stays `security definer` with its existing
--     trigger binding, and nothing about the status pin moves.
--   * THE CASCADE ESCAPES ARE UNTOUCHED. Both functions keep
--     `pg_trigger_depth() > 1` as their first test. `vm_conversation_members`
--     is the child of three ON DELETE CASCADE foreign keys (conversation, org,
--     user) and none of those is a member choosing to leave; docs/21's account
--     deletion plan depends on this holding.
--   * THE MANAGER ESCAPE IS UNTOUCHED. `vm_can_manage(old.org_id)` still
--     returns early in both. A vm module manager or org admin is who REPAIRS an
--     orphaned conversation, so they must never be blocked by this guard.
--   * NO POLICY CHANGES. No grants, no new tables, no RLS edits.
--   * THE ERROR TEXT IS UNCHANGED, so a caller still cannot tell which of the
--     two paths refused it.
--
-- Forward-only and additive: one new function plus two `create or replace`.
-- A replace does NOT inherit attributes, so every attribute of both existing
-- functions is restated in full (docs/03 convention #1).

-- ---------------------------------------------------------------------------
-- 1. The single definition of a seat that holds the admin floor.
-- ---------------------------------------------------------------------------
-- A seat counts if and only if it is an ACTIVE ADMIN seat **whose holder is
-- still an active member of the org that seat belongs to**. That last clause is
-- the whole of this migration.
--
-- Deliberately NOT written with `is_org_member()`: that helper answers about
-- the CALLER, and this question is about the seat's holder. See the header.
--
-- `security definer` because it reads `org_members` and
-- `vm_conversation_members` on behalf of trigger functions that are themselves
-- definers; `stable` because it is a pure read within one statement.
create or replace function public.vm_seat_holds_admin_floor(check_member_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.vm_conversation_members m
    where m.id = check_member_id
      and m.role = 'admin'
      and m.status = 'active'
      and exists (
        select 1
        from public.org_members om
        where om.org_id = m.org_id
          and om.user_id = m.user_id
          and om.status = 'active'
      )
  );
$$;

-- docs/03 convention #1: state the full intended ACL rather than relying on
-- defaults, which DIVERGE between local and prod. Only the two definer trigger
-- functions call this, and a SECURITY DEFINER executes its body as its OWNER
-- (postgres), so EXECUTE is checked against postgres and no api role needs it.
--
-- `service_role` IS IN THIS LIST DELIBERATELY, and it is the half that local
-- cannot catch. Postgres grants EXECUTE to PUBLIC at CREATE, and on PROD
-- `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` ALSO grants it directly to
-- anon/authenticated/service_role — which `revoke ... from public` does not
-- remove. Local has no such default, so revoking only the first three looks
-- perfectly closed here and leaves the helper open to service_role on prod.
-- Measured, not theorised: `prod-verify-migration.ts` shows prod's existing
-- `vm_guard_last_conversation_admin` holding `service_role=yes` for exactly
-- this reason, because 20260914020000 revoked only three roles.
--
-- The two TRIGGER functions' own ACLs are restated below unchanged rather than
-- tightened: a trigger function cannot be usefully invoked directly, so their
-- residual service_role grant is inert, and narrowing a shipped ACL is not this
-- migration's business.
revoke execute on function public.vm_seat_holds_admin_floor(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The UPDATE path — vm_pin_member.
-- ---------------------------------------------------------------------------
-- Restated in full from 20260910030000. The ONLY change is the floor check in
-- the conversation-admin branch, which now asks the helper twice instead of
-- testing `old.role` and counting raw rows. Everything else — the depth escape,
-- the manage escape, the three column pins, the role pin and the self-block
-- carve-out — is byte-for-byte the behaviour that was there before.
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
    -- cannot be demoted or banned away. Unchanged in intent — and note this
    -- branch is reached BEFORE the self-service one, so an admin who self-bans
    -- is still caught here rather than by the carve-out below.
    --
    -- CHANGED 2026-09-22: "the seat keeping a conversation administrable" now
    -- means a seat that actually confers adminship. `vm_seat_holds_admin_floor`
    -- subsumes the former `old.role = 'admin'` test and adds the org-membership
    -- requirement; the transition half (`new` is no longer an active admin) is
    -- unchanged.
    if public.vm_seat_holds_admin_floor(old.id)
       and (new.role <> 'admin' or new.status <> 'active') then
      if not exists (
        select 1 from public.vm_conversation_members m
        where m.conversation_id = old.conversation_id
          and m.id <> old.id
          and public.vm_seat_holds_admin_floor(m.id)
      ) then
        raise exception 'A conversation must keep at least one admin';
      end if;
    end if;
    return new;
  end if;

  -- Self-service: last_seen_at, plus ONE transition — SELF-BLOCK.
  -- A member may set their OWN active seat to 'banned' and nothing else. The
  -- role pin runs unconditionally; the status pin runs for every transition
  -- EXCEPT active -> banned, so self-unban ('banned' -> 'active') and every
  -- other value remain pinned to the stored row exactly as before.
  -- UNCHANGED by this migration (20260910030000) — restated because
  -- `create or replace` rewrites the whole body.
  new.role := old.role;
  if not (old.status = 'active' and new.status = 'banned') then
    new.status := old.status;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The DELETE path — vm_guard_last_conversation_admin.
-- ---------------------------------------------------------------------------
-- Restated in full from 20260914020000, whose header documents each escape at
-- length; the comments here are kept short on purpose so the two files do not
-- grow two divergent explanations of the same three escapes.
create or replace function public.vm_guard_last_conversation_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- (1) CASCADE ESCAPE, covering all three ON DELETE CASCADE parents of this
  -- table: conversation_id -> vm_conversations, org_id -> orgs, and
  -- user_id -> auth.users. A direct DELETE runs at pg_trigger_depth() = 1, a
  -- referential action at 2 — measured, not assumed (20260914020000).
  -- Unchanged.
  --
  -- Naming `auth.users` here is deliberate and load-bearing twice: it is the
  -- parent docs/21's account-deletion plan actually walks, and it is why this
  -- function sits in `profiles-public-columns.test.ts`'s COMMENT_MATCHES_ONLY
  -- list. `prosrc` matches COMMENTS, so shortening this line to "user" makes
  -- that allow-list entry go stale and the email ratchet fail — which is
  -- exactly what happened to a draft of this migration.
  if pg_trigger_depth() > 1 then
    return old;
  end if;

  -- (2) MANAGER ESCAPE, mirroring vm_pin_member's first branch. Unchanged.
  if public.vm_can_manage(old.org_id) then
    return old;
  end if;

  -- (3) Is the seat being deleted one that holds the floor at all?
  --
  -- CHANGED 2026-09-22: was `old.role <> 'admin' or old.status <> 'active'`.
  -- It now uses the same definition as (4), so an ORPHANED admin seat — which
  -- confers nothing and does not count toward the floor — is released rather
  -- than trapped. Removing a seat that does not count can never take the floor
  -- from 1 to 0, so this check would otherwise only ever refuse spuriously.
  if not public.vm_seat_holds_admin_floor(old.id) then
    return old;
  end if;

  -- (4) The floor itself. Identical shape to vm_pin_member's, including
  -- `id <> old.id` rather than a user comparison, and now identical in MEANING
  -- too because both call the same helper.
  if not exists (
    select 1 from public.vm_conversation_members m
    where m.conversation_id = old.conversation_id
      and m.id <> old.id
      and public.vm_seat_holds_admin_floor(m.id)
  ) then
    raise exception 'A conversation must keep at least one admin';
  end if;

  return old;
end;
$$;

revoke execute on function public.vm_guard_last_conversation_admin() from public, anon, authenticated;
revoke execute on function public.vm_pin_member() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Assert both triggers are still BOUND and ENABLED, not merely defined.
-- ---------------------------------------------------------------------------
-- `create or replace function` does not disturb a trigger binding, so this is
-- belt-and-braces — but it is the exact gap
-- `scripts/prod-verify-seat-authority.mts` exists to catch, and a guard that is
-- defined but unbound is indistinguishable from a working one at the catalog
-- level. Both are checked because this migration edits both.
do $$
declare
  bound integer;
  volatile_guards integer;
begin
  select count(*) into bound
  from pg_trigger
  where tgrelid = 'public.vm_conversation_members'::regclass
    and tgname in ('vm_members_a_pin', 'vm_members_b_last_admin')
    and not tgisinternal
    and tgenabled = 'O';

  if bound <> 2 then
    raise exception 'expected 2 bound+enabled floor triggers on vm_conversation_members, found %', bound;
  end if;

  -- Both trigger functions MUST stay VOLATILE. See the multi-row DELETE
  -- section in the header: marking either `stable` would stop its internal
  -- queries from seeing rows the same statement has already deleted, and a
  -- single multi-row DELETE would then orphan a conversation silently. This
  -- assertion exists so that change fails here instead of in production.
  select count(*) into volatile_guards
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('vm_pin_member', 'vm_guard_last_conversation_admin')
    and p.provolatile = 'v';

  if volatile_guards <> 2 then
    raise exception
      'vm_pin_member and vm_guard_last_conversation_admin must both be VOLATILE (found % volatile) — a STABLE guard cannot see in-statement deletes',
      volatile_guards;
  end if;
end $$;
