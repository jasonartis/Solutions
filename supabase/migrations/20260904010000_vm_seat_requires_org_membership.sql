-- Visual messaging: a conversation SEAT no longer grants access on its own —
-- the seat holder must also be an active member of the conversation's ORG
-- (2026-09-04).
--
-- THE FINDING (found while designing ad-hoc groups; pre-existing, live):
-- `addMember` (modules/visual-messaging/ui/actions.ts) resolved an email to a
-- user_id and inserted a vm_conversation_members row WITHOUT checking that the
-- target belongs to the conversation's org — and the four vm_ access predicates
-- gate purely on the seat row, never on org membership. So a seat alone granted
-- PostgREST reads of vm_layers, vm_reactions, the whole roster, and the
-- vm-images storage prefix (its policy calls vm_is_conv_member), for a person
-- who is not in that org at all. requireOrgModule() 404s them in the UI, but
-- the UI is not the gate (docs/03 hard rule 6): every one of those reads is
-- reachable directly against the API with an ordinary session.
--
-- Blast radius today is bounded only by accident: the email lookup runs under
-- `profiles_select_shared_org`, so the caller can only NAME someone who already
-- shares SOME org with them. That is a bound on who can be targeted, not on
-- what the seat then exposes, and it is not a bound anyone designed.
--
-- CLASSROOM ALREADY DEFENDS THIS EXACT CLASS AND SAYS SO IN A COMMENT
-- (modules/classroom/ui/manage/actions.ts): "the email lookup above resolves
-- anyone sharing ANY org with the caller, so verify org membership before
-- minting a classroom grant — otherwise a non-member could be enrolled and read
-- class content via the grant-based RLS." Visual messaging never got the guard.
-- The app-side check is added in the same commit; this migration is the real
-- gate, because the app layer is not one.
--
-- WHY `m.org_id` AND NOT A JOIN TO vm_conversations: vm_conversation_members
-- carries its own org_id, and vm_sync_from_conversation (a BEFORE INSERT/UPDATE
-- scope-sync trigger, docs/03 #10) derives it from the parent conversation and
-- raises on an unknown one. So m.org_id IS the conversation's org, server-side
-- and unspoofable — the cheaper form is also the authoritative one.
--
-- WHY THE ORG TAILS ARE UNTOUCHED: the `vm_can_moderate_org` / `vm_can_manage`
-- arms resolve through has_module_role / is_org_admin, both of which have
-- required ACTIVE org membership since 20260727010000. Only the seat arms were
-- unguarded.
--
-- Forward-only, additive: four `create or replace`s, no schema change, no
-- backfill. Each restates its FULL definer + `set search_path` attributes
-- (they are NOT inherited by a replace) and preserves the existing EXECUTE
-- grants, which `create or replace` does not disturb — `authenticated` must
-- keep EXECUTE on all four because they are named in RLS policies and policy
-- expressions are permission-checked as the querying role (docs/03 #17).
--
-- Asserted by packages/db/src/rls.test.ts in the same commit: a user who
-- shares org A with the caller but is NOT a member of org B cannot be given a
-- working seat in an org-B conversation, and reads none of its layers — with a
-- non-emptiness control proving a real member DOES read them (the vacuity
-- rule), because "she sees nothing" is otherwise satisfied by an empty table.
--
-- KNOWN, DELIBERATE REMAINDER (not fixed here): vm_conversations_select still
-- has a `created_by = auth.uid()` arm, so someone who created a conversation
-- and was later removed from the org can still read that conversation ROW (its
-- title/frozen flag) though none of its content. That arm is load-bearing for
-- the creator's own INSERT ... RETURNING bootstrap (docs/03 #15) and removing
-- it needs its own review; recorded rather than silently changed.

-- ---------------------------------------------------------------------------
-- 1. vm_is_conv_member — gates ALL conversation-content reads.
-- ---------------------------------------------------------------------------
create or replace function public.vm_is_conv_member(check_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.vm_conversation_members m
    where m.conversation_id = check_conversation_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and public.is_org_member(m.org_id)
  )
  or exists (
    select 1 from public.vm_conversations c
    where c.id = check_conversation_id
      and public.vm_can_moderate_org(c.org_id)
  );
$$;

-- ---------------------------------------------------------------------------
-- 2. vm_can_post — may DRAW (active seat, not a read-only viewer).
-- ---------------------------------------------------------------------------
create or replace function public.vm_can_post(check_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.vm_conversation_members m
    where m.conversation_id = check_conversation_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role in ('participant', 'moderator', 'admin')
      and public.is_org_member(m.org_id)
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. vm_can_moderate — per-conversation moderator/admin seat, or org tier.
-- ---------------------------------------------------------------------------
create or replace function public.vm_can_moderate(check_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.vm_conversation_members m
    where m.conversation_id = check_conversation_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role in ('moderator', 'admin')
      and public.is_org_member(m.org_id)
  )
  or exists (
    select 1 from public.vm_conversations c
    where c.id = check_conversation_id
      and public.vm_can_moderate_org(c.org_id)
  );
$$;

-- ---------------------------------------------------------------------------
-- 4. vm_is_conv_admin — per-conversation admin seat, or the org manage tier.
-- ---------------------------------------------------------------------------
create or replace function public.vm_is_conv_admin(check_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.vm_conversation_members m
    where m.conversation_id = check_conversation_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role = 'admin'
      and public.is_org_member(m.org_id)
  )
  or exists (
    select 1 from public.vm_conversations c
    where c.id = check_conversation_id
      and public.vm_can_manage(c.org_id)
  );
$$;
