-- Export controls (founder decision, 2026-07-09): each level can shut off the
-- export option for the levels below — e.g. a professor disables the student
-- hat, or just the class-materials data set. Settings live in
-- org_modules.settings.export ({disabledHats, disabledSets}); writes go
-- through a definer RPC gated on the MODULE's manage tier (a professor is not
-- necessarily an org admin, and org_modules is org-admin-write otherwise).
--
-- module_can_manage() is the first platform-level "is module staff?"
-- dispatcher — explicit per-module case, extended when a module is added
-- (the sample template's SPEC reminds).

create function public.module_can_manage(check_org_id uuid, check_module_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case check_module_key
    when 'classroom' then public.cls_can_manage(check_org_id)
    when 'matchmaking' then public.mm_can_manage(check_org_id)
    when 'nail-salon' then public.sal_can_manage(check_org_id)
    when 'speed-dating' then public.sd_can_manage(check_org_id)
    when 'sample' then public.smp_can_manage(check_org_id)
    -- module 3 predates the _can_manage convention; its staff role is 'maker'.
    when 'synagogue-schedules' then
      public.is_org_admin(check_org_id)
      or public.has_module_role(check_org_id, 'synagogue-schedules', 'maker')
    else public.is_org_admin(check_org_id)
  end;
$$;

grant execute on function public.module_can_manage(uuid, text) to authenticated;

create function public.set_export_settings(
  check_org_id uuid,
  check_module_key text,
  disabled_hats text[],
  disabled_sets text[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Definer bypasses RLS: re-check the gate internally (docs/03 #13).
  if not public.module_can_manage(check_org_id, check_module_key) then
    raise exception 'Only module staff may change export controls';
  end if;

  update public.org_modules
  set settings = jsonb_set(
    coalesce(settings, '{}'::jsonb),
    '{export}',
    jsonb_build_object(
      'disabledHats', to_jsonb(coalesce(disabled_hats, '{}')),
      'disabledSets', to_jsonb(coalesce(disabled_sets, '{}'))
    )
  )
  where org_id = check_org_id and module_key = check_module_key;

  if not found then
    raise exception 'Module % is not configured for this org', check_module_key;
  end if;
end;
$$;

grant execute on function public.set_export_settings(uuid, text, text[], text[]) to authenticated;
