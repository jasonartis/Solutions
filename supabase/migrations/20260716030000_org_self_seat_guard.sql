-- An org owner/admin cannot demote or remove THEIR OWN seat (2026-07-16).
--
-- Founder feedback (testing round): logged in as an org admin, "removing
-- himself or demoting himself ... is probably not an ability he should be
-- able to have" — confirmed the founder wants this fixed. Today the org
-- self-management path (org_members_write_org_admin, 20260712010000) lets an
-- admin write any row in their org INCLUDING their own, so an admin could
-- accidentally demote or remove themselves. The existing
-- org_members_guard_last_admin trigger only stops the org from reaching ZERO
-- admins — it does nothing when a SECOND admin remains, so a two-admin org's
-- admin could still lock themselves out of management with one click.
--
-- This guard: a NON-SUPERADMIN caller cannot demote (role -> not owner/admin)
-- or delete their OWN owner/admin seat. The safe flows are preserved:
--   * Another owner/admin of the same org can remove/demote them (that row's
--     user_id <> auth.uid(), so this guard doesn't fire) — the intended
--     "ask a co-admin to let you leave" handoff.
--   * A superadmin can always do it via the Owner Console (is_superadmin()
--     exempt) — the platform-level escape hatch.
--   * Changing your own seat owner<->admin (both admin-tier, functionally
--     identical) is still allowed — only a demotion OUT of admin-tier or a
--     self-delete is blocked.
--   * A plain member leaving is unaffected (their role isn't owner/admin;
--     and org_members writes are admin-tier only anyway, so a member can't
--     reach this path).
--
-- DELIBERATELY NOT DONE (flagged back to the founder as a separate decision):
-- the founder also mused an admin shouldn't demote "any other admin." That
-- conflicts with the just-established model where owner and admin are
-- functionally identical (is_org_admin treats them the same) AND with org
-- self-management itself (an org admin managing their org needs to be able to
-- change other admins). Blocking admin-on-other-admin would mean only a
-- superadmin could ever demote an admin, breaking level-2 self-management.
-- So only the SELF case — unambiguously safe and clearly wanted — is guarded
-- here; the other-admin question stays open.
--
-- security definer so is_superadmin()'s profiles read isn't subject to the
-- caller's RLS. Fires BEFORE the row is written, so the caller gets this
-- clear error rather than a silent no-op or an RLS WITH CHECK ambiguity.
--
-- Re-point defense (security review, 2026-07-16): the guard also rejects an
-- UPDATE that keeps role in owner/admin but moves the caller's OWN seat to a
-- different user_id or org_id — otherwise a crafted request could
-- self-remove by re-pointing the row while dodging the demote/delete checks.
-- Mirrors org_members_guard_last_admin, which already treats a re-point as a
-- lost seat. Never a real UI action; purely defense-in-depth.
create function public.org_members_guard_self_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.user_id = auth.uid()
     and old.role in ('owner', 'admin')
     and not public.is_superadmin()
  then
    if tg_op = 'DELETE' then
      raise exception 'You cannot remove your own owner/admin seat — ask another owner or admin of this organization (or a platform admin) to do it';
    elsif new.role not in ('owner', 'admin') then
      raise exception 'You cannot demote your own owner/admin seat — ask another owner or admin of this organization (or a platform admin) to do it';
    elsif new.user_id <> old.user_id or new.org_id <> old.org_id then
      raise exception 'You cannot reassign your own owner/admin seat to a different user or organization';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger org_members_guard_self_admin
  before delete or update on public.org_members
  for each row execute function public.org_members_guard_self_admin();
