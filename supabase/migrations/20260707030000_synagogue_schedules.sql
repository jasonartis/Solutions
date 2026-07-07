-- Module 3: Synagogue Schedules (prefix syn_). Spec: docs/modules/module-3.
-- Org settings (address/zip, lat/long, timezone, branding, israel flag) live
-- in org_modules.settings for module_key 'synagogue-schedules'.

-- Platform-level helper (first module role check; reused by every module).
create function public.has_module_role(check_org_id uuid, check_module_key text, check_role text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.module_roles
    where org_id = check_org_id
      and module_key = check_module_key
      and role = check_role
      and user_id = auth.uid()
  );
$$;

-- Schedule types: 'Weekday sheet' (Sun-Fri), 'Shabbat sheet', special sheets.
create table public.syn_schedule_types (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null,
  name_hebrew text,
  -- Which dates trigger this document: same condition grammar as lines.
  trigger_condition jsonb not null default '{}'::jsonb,
  -- 'week' = one document covering Sun-Fri; 'day' = one document per matching day.
  span text not null default 'week' check (span in ('week', 'day')),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.syn_sections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  schedule_type_id uuid not null references public.syn_schedule_types (id) on delete cascade,
  name text not null,
  name_hebrew text,
  visibility_condition jsonb not null default '{}'::jsonb,
  sort integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.syn_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  section_id uuid not null references public.syn_sections (id) on delete cascade,
  name text not null,
  name_hebrew text,
  -- LineRule JSON: { condition?, time } — validated by Zod in the module.
  rule jsonb not null,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Free-form additions for a specific week ("Coffee sponsored by John Doe").
create table public.syn_overrides (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  section_id uuid not null references public.syn_sections (id) on delete cascade,
  week_start date not null,
  text text,
  text_hebrew text,
  sort integer not null default 0,
  created_at timestamptz not null default now()
);

-- Named render presets: "Lobby screen" (large JPG), "WhatsApp" (small JPG),
-- "Print" (PDF, margins, B&W). "Export" runs all enabled.
create table public.syn_export_profiles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null,
  format text not null check (format in ('pdf', 'jpg')),
  width_px integer,
  margins_mm integer,
  grayscale boolean not null default false,
  enabled boolean not null default true,
  sort integer not null default 0,
  created_at timestamptz not null default now()
);

-- Which weeks viewers (including the public page) may see.
create table public.syn_published_weeks (
  org_id uuid not null references public.orgs (id) on delete cascade,
  week_start date not null,
  published boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (org_id, week_start)
);

-- Zmanim cache: one myzmanim call per (location, date), shared across orgs.
-- No org data inside; locked to service_role (worker) only.
create table public.syn_zmanim_cache (
  location_key text not null,
  date date not null,
  source text not null,
  times jsonb not null,
  fetched_at timestamptz not null default now(),
  primary key (location_key, date, source)
);

create index syn_sections_type_idx on public.syn_sections (schedule_type_id);
create index syn_lines_section_idx on public.syn_lines (section_id);
create index syn_overrides_week_idx on public.syn_overrides (org_id, week_start);

-- Grants first (migrations do not inherit defaults — see core migration note).
grant select, insert, update, delete
  on public.syn_schedule_types, public.syn_sections, public.syn_lines,
     public.syn_overrides, public.syn_export_profiles, public.syn_published_weeks
  to authenticated, service_role;
grant select, insert, update, delete on public.syn_zmanim_cache to service_role;

-- RLS: org members read; makers (module role) or org owners/admins write.
alter table public.syn_schedule_types enable row level security;
alter table public.syn_sections enable row level security;
alter table public.syn_lines enable row level security;
alter table public.syn_overrides enable row level security;
alter table public.syn_export_profiles enable row level security;
alter table public.syn_published_weeks enable row level security;
alter table public.syn_zmanim_cache enable row level security; -- no policies: service_role only

create function public.syn_can_write(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_superadmin()
      or public.has_module_role(check_org_id, 'synagogue-schedules', 'maker')
      or exists (
           select 1 from public.org_members
           where org_id = check_org_id
             and user_id = auth.uid()
             and role in ('owner', 'admin')
         );
$$;

do $$
declare t text;
begin
  foreach t in array array['syn_schedule_types','syn_sections','syn_lines','syn_overrides','syn_export_profiles','syn_published_weeks']
  loop
    execute format(
      'create policy %I_select_member on public.%I for select using (public.is_org_member(org_id) or public.is_superadmin());',
      t, t);
    execute format(
      'create policy %I_write_maker on public.%I for all using (public.syn_can_write(org_id)) with check (public.syn_can_write(org_id));',
      t, t);
  end loop;
end $$;
