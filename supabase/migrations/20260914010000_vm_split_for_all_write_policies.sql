-- Visual messaging: split the five `for all` write policies so their USING
-- clause stops granting SELECT (2026-09-14).
--
-- THE TRAP, not a live leak. `20260709100000` created five policies in a loop:
--
--   create policy <t>_write_manage on public.<t> for all
--     using (public.vm_can_manage(org_id))
--     with check (public.vm_can_manage(org_id));
--
-- A `for all` policy applies to EVERY command including SELECT, so each of
-- those USING clauses is also a read arm — the lesson this platform recorded on
-- 2026-08-06 (docs/15) and which has now bitten two separate designs in
-- docs/20.
--
-- MEASURED BEFORE WRITING THIS, because the finding was originally scored HIGH
-- and that was wrong (docs/20 §26). The read arm grants NOTHING today:
--
--   vm_can_manage(org)       = is_org_admin(org)
--                           or has_module_role(org,'visual-messaging','admin')
--   vm_can_moderate_org(org) = vm_can_manage(org)
--                           or has_module_role(org,'visual-messaging','moderator')
--   vm_is_conv_member(conv)  = <an active seat on that conversation>
--                           or vm_can_moderate_org(<that conversation's org>)
--
-- and all five SELECT policies route through that second arm:
--   vm_conversations_select        created_by = auth.uid() OR vm_is_conv_member(id)
--   vm_conversation_members_select user_id    = auth.uid() OR vm_is_conv_member(conversation_id)
--   vm_layers_select               vm_is_conv_member(conversation_id)
--   vm_reactions_select            vm_is_conv_member(conversation_id)
--   vm_flags_select                reporter_user_id = auth.uid() OR vm_can_moderate(conversation_id)
--
-- `vm_can_manage` is a strict SUBSET of `vm_can_moderate_org`, so every
-- principal the `for all` policies admit is ALREADY admitted by the dedicated
-- SELECT policy. Org-wide moderation read is DELIBERATE and lives in
-- vm_is_conv_member's second arm — it is not leaking through the write policy.
--
-- SO WHY DO THIS AT ALL: because it is a trap waiting for the next change. The
-- better privacy answer for moderation (docs/20 §13.3 option b — a moderator
-- reads a conversation only while it carries an OPEN FLAG) is still on the
-- table. Narrowing vm_is_conv_member's moderation arm while these five policies
-- stand would leave the org-wide read fully alive and the narrowing VACUOUS,
-- with its tests passing. That is exactly how docs/20's v1 and v2 failed. This
-- migration makes that future narrowing mean what it says.
--
-- WHAT CHANGES: every write authority is preserved verbatim. But "only the
-- redundant read arm goes" UNDERSTATES it, and the adversarial review was right
-- to say so: PostgreSQL applies SELECT policies to an UPDATE/DELETE whose WHERE
-- or RETURNING touches table columns, and PostgREST always emits a WHERE. So
-- after this migration a manager's UPDATE and DELETE **depend on** the
-- redundancy above rather than merely coexisting with it. The redundancy is
-- proven, so nothing breaks today — but it is now load-bearing for writes, not
-- just reads.
--
-- ONE OBSERVABLE EDGE, documented rather than silently changed. A manager
-- INSERTing a vm_conversations row with `created_by <> auth.uid()` AND asking
-- for the row back (RETURNING / PostgREST representation) succeeded before via
-- the `for all` USING reading org_id off the NEW row, and will now fail 42501 —
-- `created_by = auth.uid()` is false and vm_is_conv_member() cannot see the
-- uncommitted row. Unreachable from today's UI (actions.ts:79 always sets
-- created_by to the caller). NOT "fixed" by adding a created_by conjunct to the
-- new insert policy: that would NARROW manager authority, and this migration's
-- whole claim is that it changes none.
--
-- ============================================================================
-- FORWARD HAZARD — READ THIS BEFORE NARROWING MODERATION (docs/20 §13.3 option b)
-- ============================================================================
-- This migration exists to make that narrowing meaningful. It also makes it
-- MORE dangerous, and the two facts must travel together.
--
-- `vm_members_scope` (BEFORE INSERT OR UPDATE on vm_conversation_members) runs
-- `vm_sync_from_conversation`, which is **NOT security definer** — it reads
-- vm_conversations under the CALLER's RLS. Today a manager satisfies
-- vm_conversations_select TWO ways: this `for all` USING, and
-- vm_is_conv_member's moderation arm. **This migration removes one of them.**
--
-- So if vm_is_conv_member's moderation arm is later narrowed to flagged
-- conversations only, a manager writing to vm_conversation_members will fail
-- with `Unknown conversation` — including addMember's path — because the scope
-- trigger can no longer resolve the parent. THE NARROWING MUST RETAIN A
-- `vm_can_manage` DISJUNCT, or be preceded by a separate decision about that
-- trigger.
--
-- DO NOT "FIX" THAT BY MAKING vm_sync_from_conversation SECURITY DEFINER.
-- CLAUDE.md (2026-09-11) records that self-block's ACTUAL guarantee — a banned
-- member cannot touch their own seat row at all — rests on precisely this
-- trigger being non-definer and vm_conversations_select ceasing to match them.
-- The migration header of 20260910030000 describes a different mechanism (the
-- status pin) and is wrong about it. Making this trigger definer would silently
-- remove the real enforcement behind the platform's ONLY user-level block.
--
-- WHAT THIS DELIBERATELY DOES NOT TOUCH:
--   * `vm_moderation_log.vm_modlog_select` also consumes vm_can_manage, but it
--     is a genuine `for select` policy — vm_can_manage is CORRECTLY a read gate
--     there. Left exactly as is.
--   * The narrower per-command policies that already exist on three of these
--     tables (vm_members_update_admin, vm_members_delete_admin,
--     vm_layers_update_moderate, vm_layers_delete_admin, vm_layers_delete_author,
--     vm_flags_update_moderate, vm_conversations_update_admin,
--     vm_conversations_delete_admin, vm_reactions_delete_own, ...). Policies are
--     OR-ed, so the new siblings ADD to those rather than replacing them.
--   * The six functions that consume vm_can_manage (vm_pin_conversation,
--     vm_pin_flag, vm_layers_before_write, vm_pin_member, vm_can_moderate_org,
--     vm_is_conv_admin). None is touched. vm_pin_member in particular carries
--     the self-block carve-out shipped in 20260910030000.
--
-- SIBLING SWEEP, recorded because the omission is the recurring failure here:
-- this same `for all` shape exists on **58 module policies across all six
-- modules** (cls_*_write_staff, mm_*_write_staff, sal_*_write_manage/_operate,
-- sd_*_write_organize, syn_*_write_maker). This migration fixes ONLY the five
-- visual-messaging ones, because those are the only five whose read arm has
-- been PROVEN redundant against their SELECT policy. Several of the others are
-- NOT obviously redundant — mm_groups_select_assigned and
-- mm_group_members_select_assigned have no mm_can_manage disjunct at all, so
-- splitting those would likely REVOKE a matchmaking admin's real read access.
-- Do not batch them. Each needs the same per-table proof this one carries.
-- Full analysis: docs/20 §27.

do $$
declare
  t text;
begin
  foreach t in array array[
    'vm_conversations', 'vm_layers', 'vm_conversation_members',
    'vm_reactions', 'vm_flags']
  loop
    -- Drop the `for all` policy whose USING doubled as a read arm.
    execute format('drop policy if exists %I_write_manage on public.%I;', t, t);

    -- Drop the NEW names too, so a hand re-run after a partial apply is safe.
    -- `drop policy if exists` on the old name alone left this file unable to be
    -- re-run: the creates below would die on "policy already exists".
    execute format('drop policy if exists %I_insert_manage on public.%I;', t, t);
    execute format('drop policy if exists %I_update_manage on public.%I;', t, t);
    execute format('drop policy if exists %I_delete_manage on public.%I;', t, t);

    -- Re-create it as three per-command policies with identical authority.
    -- INSERT has no USING (there is no existing row to test); UPDATE keeps
    -- both clauses so a manager can neither reach a row outside their org nor
    -- move one into it; DELETE keeps USING only.
    execute format(
      'create policy %I_insert_manage on public.%I for insert
         with check (public.vm_can_manage(org_id));',
      t, t);

    execute format(
      'create policy %I_update_manage on public.%I for update
         using (public.vm_can_manage(org_id))
         with check (public.vm_can_manage(org_id));',
      t, t);

    execute format(
      'create policy %I_delete_manage on public.%I for delete
         using (public.vm_can_manage(org_id));',
      t, t);
  end loop;
end $$;

-- Assert the intent rather than trusting the loop: after this migration no
-- `cmd = ALL` policy may remain on any of the five tables, and each must carry
-- exactly the three new per-command policies. A silent no-op here would leave
-- the trap in place while the migration reports success.
do $$
declare
  leftover integer;
  created  integer;
begin
  select count(*) into leftover
  from pg_policies
  where schemaname = 'public'
    and tablename in ('vm_conversations', 'vm_layers', 'vm_conversation_members',
                      'vm_reactions', 'vm_flags')
    and cmd = 'ALL';

  if leftover <> 0 then
    raise exception 'vm split failed: % for-all policies still present', leftover;
  end if;

  select count(*) into created
  from pg_policies
  where schemaname = 'public'
    and tablename in ('vm_conversations', 'vm_layers', 'vm_conversation_members',
                      'vm_reactions', 'vm_flags')
    and policyname ~ '_(insert|update|delete)_manage$';

  if created <> 15 then
    raise exception 'vm split failed: expected 15 per-command policies, found %', created;
  end if;
end $$;
