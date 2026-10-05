-- THE MODULE-ROLE CENSUS LEAK — narrow who may READ public.module_roles.
--
-- Found 2026-09-10 (docs/19 "ADJACENT, FOUND 2026-09-10"), blocked on rank-mapping
-- until `20260925030000`, specified in docs/24 §5.5, tracked as docs/20 §8.4.
--
-- THE LEAK, as it stood before this file:
--   module_roles_select_member :: SELECT :: (is_org_member(org_id) OR is_superadmin())
-- No module filter, no role filter, no self filter — so ANY active member of an org
-- read every module_roles row in it: user_id, module_key, role, scope_ref. Measured
-- live in `demo-match`: an ordinary member read all 6 rows, 4 of which hold `single`,
-- i.e. the membership of the dating pool.
--
-- THE REPLACEMENT, and why each arm is here:
--   user_id = auth.uid()        -- your own grants. Conjoined with is_org_member so
--                                  this is a pure NARROWING of the old policy and
--                                  never widens it for a non-member.
--   is_org_admin(org_id)        -- REQUIRED, and the reason is not obvious: org admins
--                                  hold module authority WITHOUT ever holding a
--                                  module_roles row. Verified across all five coarse
--                                  module gates -- is_org_admin() is the FIRST DISJUNCT
--                                  of cls_can_manage, sal_can_manage, mm_can_manage,
--                                  syn_can_write and vm_can_manage. (They differ in
--                                  their SECOND disjunct and the difference does not
--                                  matter here: mm_/syn_/vm_ call has_module_role,
--                                  while cls_/sal_ test module_position_rank >= 2
--                                  inline.) module_has_manager_grant does NOT consult
--                                  is_org_admin, so dropping this arm would strip an
--                                  org admin of the table while leaving their domain
--                                  authority intact. (docs/24 §1.6.)
--   module_has_manager_grant    -- rank >= 2 in THIS row's module. Per-row, so a
--                                  manager of one module reads that module's grants
--                                  and not another's. This is deliberately the SAME
--                                  predicate that already governs INSERT/UPDATE/DELETE
--                                  on this table: you may now read exactly the grants
--                                  you may already attempt to write.
--   is_superadmin()             -- deliberately REDUNDANT with is_org_admin()'s own
--                                  first disjunct. Kept literal because the Owner
--                                  Console reads this table through the superadmin's
--                                  ordinary RLS client, and that path should not
--                                  depend on an arm buried inside another function.
--
-- WHAT IS NOT CHANGED, AND WHY THAT IS NOT AN OVERSIGHT: module_roles_write_org_admin
-- and module_roles_write_superadmin are `for all`, so their USING governs SELECT too
-- (docs/20 §8.1). Both are left alone because both admit exactly the readers this
-- policy also admits — org admins and superadmins — so the effective read set is the
-- union of three identical-intent doors, not a hole. The effective set is what the
-- tests assert; asserting this one policy alone would be the §8.1 trap in miniature.
--
-- NO RECURSION, and it was demonstrated rather than assumed: module_has_manager_grant
-- reads module_roles and is now called from a module_roles SELECT policy. It is
-- SECURITY DEFINER, owned by postgres, and module_roles has relforcerowsecurity =
-- false (verified in pg_class), so the function's own read is not re-filtered. The
-- policy was exercised against real rows in a rolled-back transaction before this
-- file was written.
--
-- NO SQL PREDICATE'S ANSWER MOVES. 18 functions in `public` read module_roles and all
-- 18 are SECURITY DEFINER (control: 24 non-definer functions exist in `public`, so
-- that is a real property and not an empty catalog read). Only direct client reads
-- are affected.
--
-- THE POLICY IS RENAMED, not edited in place: "select_member" is no longer true of
-- it, and this repo's policy names carry the WHO (module_roles_write_org_admin,
-- profiles_select_shared_org). A name that lies is the stale-claim failure mode.

drop policy if exists module_roles_select_member on public.module_roles;

create policy module_roles_select_self_or_manager on public.module_roles
  for select using (
    (user_id = auth.uid() and public.is_org_member(org_id))
    or public.is_org_admin(org_id)
    or public.module_has_manager_grant(org_id, module_key)
    or public.is_superadmin()
  );

comment on policy module_roles_select_self_or_manager on public.module_roles is
  'Your own grants, plus every grant in a module you manage (rank >= 2), plus the '
  'whole org for an org admin, plus everything for a superadmin. Replaced '
  'module_roles_select_member (any member read the whole org) on 2026-10-02 — '
  'docs/19 ADJACENT, docs/24 §5.5, docs/20 §8.4.';

-- Catalog-only, so it is safe against the EMPTY database a migration actually meets
-- (CLAUDE.md 2026-09-28) while still being real evidence when this runs on prod.
do $$
begin
  if exists (
    select 1 from pg_policy
    where polrelid = 'public.module_roles'::regclass and polname = 'module_roles_select_member'
  ) then
    raise exception 'module_roles_select_member survived the drop';
  end if;
  if not exists (
    select 1 from pg_policy
    where polrelid = 'public.module_roles'::regclass and polname = 'module_roles_select_self_or_manager'
  ) then
    raise exception 'module_roles_select_self_or_manager was not created';
  end if;
  -- Exactly one SELECT-only policy on the table; a second would widen it invisibly.
  if (select count(*) from pg_policy where polrelid = 'public.module_roles'::regclass and polcmd = 'r') <> 1 then
    raise exception 'unexpected number of SELECT policies on module_roles';
  end if;
end $$;
