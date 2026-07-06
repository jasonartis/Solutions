-- Core platform schema: identity, orgs, entitlements, module roles.
-- Tenancy rules (docs/01): every module table carries org_id + RLS.
-- These core tables are the platform's own; their RLS is defined here and
-- is the model for every module migration that follows.

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles — one row per auth user
-- ---------------------------------------------------------------------------
create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text unique,
  display_name text,
  is_superadmin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Auto-create a profile when a user signs up.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, email, display_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'display_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- orgs and membership
-- ---------------------------------------------------------------------------
create table public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger orgs_updated_at
  before update on public.orgs
  for each row execute function public.set_updated_at();

create table public.org_members (
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table public.org_modules (
  org_id uuid not null references public.orgs (id) on delete cascade,
  module_key text not null,
  enabled boolean not null default true,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (org_id, module_key)
);

create table public.module_roles (
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  module_key text not null,
  role text not null,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id, module_key, role)
);

create index org_members_user_idx on public.org_members (user_id);
create index module_roles_user_idx on public.module_roles (user_id);

-- ---------------------------------------------------------------------------
-- RLS helper functions
-- security definer so policies on org_members can consult org_members
-- without recursing into their own RLS.
-- ---------------------------------------------------------------------------
create function public.is_superadmin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select is_superadmin from public.profiles where user_id = auth.uid()),
    false
  );
$$;

create function public.is_org_member(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.org_members
    where org_id = check_org_id and user_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
-- Base grants
-- Tables created in CLI migrations do NOT inherit Supabase's default grants,
-- so every migration must grant explicitly (learned 2026-07-06). RLS then
-- restricts which rows those grants can touch.
-- ---------------------------------------------------------------------------
grant select, insert, update, delete
  on public.profiles, public.orgs, public.org_members, public.org_modules, public.module_roles
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS policies
-- Reads: org members (and superadmin). Writes: superadmin only in M0 —
-- org-level self-administration arrives with the first real module.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.orgs enable row level security;
alter table public.org_members enable row level security;
alter table public.org_modules enable row level security;
alter table public.module_roles enable row level security;

create policy profiles_select_own on public.profiles
  for select using (user_id = auth.uid() or public.is_superadmin());

create policy profiles_update_own on public.profiles
  for update using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Users may edit their display name, nothing else (notably not is_superadmin).
revoke update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;

create policy orgs_select_member on public.orgs
  for select using (public.is_org_member(id) or public.is_superadmin());

create policy orgs_write_superadmin on public.orgs
  for all using (public.is_superadmin())
  with check (public.is_superadmin());

create policy org_members_select_member on public.org_members
  for select using (public.is_org_member(org_id) or public.is_superadmin());

create policy org_members_write_superadmin on public.org_members
  for all using (public.is_superadmin())
  with check (public.is_superadmin());

create policy org_modules_select_member on public.org_modules
  for select using (public.is_org_member(org_id) or public.is_superadmin());

create policy org_modules_write_superadmin on public.org_modules
  for all using (public.is_superadmin())
  with check (public.is_superadmin());

create policy module_roles_select_member on public.module_roles
  for select using (public.is_org_member(org_id) or public.is_superadmin());

create policy module_roles_write_superadmin on public.module_roles
  for all using (public.is_superadmin())
  with check (public.is_superadmin());
