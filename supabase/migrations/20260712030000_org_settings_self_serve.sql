-- Item 2 (founder, 2026-07-12): module settings (e.g. a synagogue's
-- address/timezone/myzmanim id, stored in org_modules.settings) should be
-- editable by the org's own owner/admin — "whoever fills in the synagogue
-- info should enter this" — not only the platform superadmin. But module
-- ENABLEMENT (org_modules.enabled — WHICH modules an org may use) must stay
-- superadmin-only, per the founder's standing decision.
--
-- These two live in the same row, so the guard is column-level, which RLS
-- alone can't express: add an org-admin UPDATE policy, then a BEFORE UPDATE
-- trigger that pins enabled/org_id/module_key for any non-superadmin caller —
-- so an org admin's update can only ever change `settings`. INSERT and DELETE
-- (creating/removing an entitlement) get NO new policy, so they remain
-- superadmin-only; an org admin cannot grant their own org a new module.
--
-- Additive: the existing org_modules_write_superadmin (`for all`) policy is
-- untouched and still gives superadmins full control including enable/disable.

create policy org_modules_update_org_admin on public.org_modules
  for update using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

create function public.org_modules_pin_enablement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- A superadmin may change anything (that's how toggleModule enables a
  -- module). Everyone else — including an org owner/admin editing settings —
  -- is pinned to the stored enablement/identity, leaving only `settings`
  -- (and timestamps) actually mutable. This is the privilege-escalation
  -- guard: without it, an org admin could self-enable a module by sending
  -- `enabled: true` alongside a settings edit, which the row-level policy
  -- above would otherwise permit.
  if not public.is_superadmin() then
    new.enabled := old.enabled;
    new.org_id := old.org_id;
    new.module_key := old.module_key;
  end if;
  return new;
end;
$$;

create trigger org_modules_pin_enablement before update on public.org_modules
  for each row execute function public.org_modules_pin_enablement();
