-- Platform job-request contract (docs/01): the web app inserts a request row
-- as the user (RLS-checked), the worker (service role) picks it up, runs it,
-- and writes status/result back. The UI learns of completion via polling or
-- Realtime on this table.

create table public.job_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  requested_by uuid references auth.users (id) on delete set null,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'error')),
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger job_requests_updated_at
  before update on public.job_requests
  for each row execute function public.set_updated_at();

create index job_requests_pending_idx on public.job_requests (status, created_at);
create index job_requests_org_idx on public.job_requests (org_id, created_at desc);

grant select, insert on public.job_requests to authenticated;
grant select, insert, update, delete on public.job_requests to service_role;

alter table public.job_requests enable row level security;

create policy job_requests_select_member on public.job_requests
  for select using (public.is_org_member(org_id) or public.is_superadmin());

create policy job_requests_insert_member on public.job_requests
  for insert with check (
    public.is_org_member(org_id) and requested_by = auth.uid()
  );

-- ---------------------------------------------------------------------------
-- Storage bucket for module 3 exports. Objects live under <org_id>/<week>/...
-- Worker (service role) writes; org members read via signed URLs.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('syn-exports', 'syn-exports', false)
on conflict (id) do nothing;

create policy syn_exports_read_member on storage.objects
  for select using (
    bucket_id = 'syn-exports'
    and public.is_org_member(((storage.foldername(name))[1])::uuid)
  );
