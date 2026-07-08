-- Platform extraction pass (docs/04): the "who is an org-level admin" check —
-- superadmin OR an org owner/admin — was copy-pasted verbatim into every
-- module's <prefix>_can_manage (cls/mm/sal). That's a security-critical rule
-- duplicated N times: if it ever changes (e.g. a new org-level staff role), it
-- must not drift between modules. Factor it into ONE audited platform helper
-- and refactor the module functions onto it.
--
-- Forward-only and transparent: the module functions keep their exact
-- signatures, so every RLS policy that references cls_can_manage /
-- mm_can_manage / sal_can_manage is unaffected — only their bodies change to
-- delegate. `create or replace` restates the full definer + search_path
-- attributes (they are not inherited).

create function public.is_org_admin(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_superadmin()
      or exists (
           select 1 from public.org_members
           where org_id = check_org_id
             and user_id = auth.uid()
             and role in ('owner', 'admin')
         );
$$;

grant execute on function public.is_org_admin(uuid) to authenticated;

-- Refactor the three module staff-checks onto the shared helper. Behaviour is
-- identical to before; the org-admin tail now lives in is_org_admin().

create or replace function public.cls_can_manage(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_admin(check_org_id)
      or public.has_module_role(check_org_id, 'classroom', 'professor');
$$;

create or replace function public.mm_can_manage(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_admin(check_org_id)
      or public.has_module_role(check_org_id, 'matchmaking', 'admin');
$$;

create or replace function public.sal_can_manage(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_admin(check_org_id)
      or public.has_module_role(check_org_id, 'nail-salon', 'admin')
      or public.has_module_role(check_org_id, 'nail-salon', 'manager');
$$;
