-- Module 0: Sample (key: 'sample', prefix smp_) — THE LIVING TEMPLATE.
-- Not a client module: it exists so that starting module 7+ is "copy this
-- folder, rename the prefix, follow the comments." It exercises every
-- convention in docs/03 with the minimum surface that still proves each one:
--
--   smp_projects — a ROOT table (no parent): org_id is client-supplied and the
--                  RLS write gate ties it to an org the caller manages.
--   smp_items    — a CHILD table: org_id/project scope derived server-side by
--                  a scope-sync trigger; member-writable with a pin trigger.
--
-- Roles: 'manager' (module staff) and 'member'. Every convention is labeled
-- with its docs/03 number. When a new convention is extracted, UPDATE THIS
-- FILE in the same pass (docs/03 composition decision, 2026-07-09).
--
-- Relies on platform objects that already exist:
--   public.is_superadmin(), public.is_org_member(), public.set_updated_at()  (core)
--   public.has_module_role(org, module_key, role)                            (module 3)
--   public.is_org_admin(org)                                                 (extraction pass 2)

-- ---------------------------------------------------------------------------
-- Tables (convention: prefix, org_id NOT NULL -> orgs, RLS on EVERY table)
-- ---------------------------------------------------------------------------

create table public.smp_projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.smp_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  project_id uuid not null references public.smp_projects (id) on delete cascade,
  author_id uuid not null references auth.users (id) on delete cascade,
  body text not null,
  done boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index smp_items_project_idx on public.smp_items (project_id);

-- updated_at via the shared trigger fn (never hand-rolled).
create trigger smp_projects_updated_at before update on public.smp_projects
  for each row execute function public.set_updated_at();
create trigger smp_items_updated_at before update on public.smp_items
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Grants FIRST (docs/03 #1: CLI migrations do NOT inherit API-role grants).
-- ---------------------------------------------------------------------------

grant select, insert, update, delete
  on public.smp_projects, public.smp_items
  to authenticated, service_role;

alter table public.smp_projects enable row level security;
alter table public.smp_items enable row level security;

-- ---------------------------------------------------------------------------
-- Role helper (docs/03 #9: the org-admin tail lives ONLY in is_org_admin();
-- module staff-checks delegate to it and add their module roles).
-- ---------------------------------------------------------------------------

create function public.smp_can_manage(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_admin(check_org_id)
      or public.has_module_role(check_org_id, 'sample', 'manager');
$$;

create function public.smp_is_member(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_module_role(check_org_id, 'sample', 'member')
      or public.smp_can_manage(check_org_id);
$$;

-- ---------------------------------------------------------------------------
-- Scope-sync trigger (docs/03 #10): the CHILD derives org_id from its parent
-- server-side — a client can never misfile a row cross-org via a bogus org_id.
-- Root tables (smp_projects) skip this; their RLS write gate is the guard.
-- ---------------------------------------------------------------------------

create function public.smp_sync_from_project()
returns trigger
language plpgsql
as $$
begin
  select p.org_id into new.org_id
  from public.smp_projects p where p.id = new.project_id;
  if new.org_id is null then
    raise exception 'Unknown project %', new.project_id;
  end if;
  return new;
end;
$$;

create trigger smp_items_scope before insert or update on public.smp_items
  for each row execute function public.smp_sync_from_project();

-- ---------------------------------------------------------------------------
-- Pin trigger (docs/03 #11): RLS is row-level; column rules need a BEFORE
-- UPDATE trigger. A member may only edit body/done on their OWN item —
-- author_id/project_id are pinned back to OLD for non-staff.
-- NAMING GOTCHA (docs/03 #11): same-event triggers fire alphabetically; the
-- pin must sort BEFORE the scope trigger ("..._a_pin" < "..._scope") so a
-- tampered project_id is reverted before org_id derives from it.
-- ---------------------------------------------------------------------------

create function public.smp_pin_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.smp_can_manage(old.org_id) then
    new.project_id := old.project_id;
    new.author_id := old.author_id;
  end if;
  return new;
end;
$$;

create trigger smp_items_a_pin before update on public.smp_items
  for each row execute function public.smp_pin_item();

-- ---------------------------------------------------------------------------
-- Policies. Staff blanket write + explicit member carve-outs.
-- ---------------------------------------------------------------------------

create policy smp_projects_write_staff on public.smp_projects
  for all using (public.smp_can_manage(org_id))
  with check (public.smp_can_manage(org_id));

create policy smp_projects_select_member on public.smp_projects
  for select using (public.smp_is_member(org_id));

create policy smp_items_write_staff on public.smp_items
  for all using (public.smp_can_manage(org_id))
  with check (public.smp_can_manage(org_id));

create policy smp_items_select_member on public.smp_items
  for select using (public.smp_is_member(org_id));

-- Member inserts their own items (docs/03 #15: a table's OWN policies use
-- DIRECT column checks — author_id = auth.uid() — never a definer lookup into
-- the same table, which breaks INSERT ... RETURNING).
create policy smp_items_insert_own on public.smp_items
  for insert with check (
    author_id = auth.uid() and public.smp_is_member(org_id)
  );

create policy smp_items_update_own on public.smp_items
  for update using (author_id = auth.uid())
  with check (author_id = auth.uid());
