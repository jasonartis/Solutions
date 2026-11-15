-- REAL VIEW-AS — the superadmin sees a client's actual screen, rendered by the
-- same components, READ-ONLY (docs/13 "REAL VIEW-AS" → "THE DESIGN", 2026-11-12;
-- founder: the web server may hold the token-signing key; classroom first).
--
-- HOW IT WORKS (the app half is in apps/web/proxy.ts and lib/supabase/server.ts):
--   * The superadmin starts a view of one person in one org's module
--     (view_as_real_start). The proxy checks the session on every request
--     (view_as_real_check, as the superadmin's OWN session) and, only inside
--     /o/<org slug>/m/<module>, the server builds the page's database client
--     with a 5-minute token FOR THE PERSON, carrying a `view_as` claim. The
--     token never leaves the server.
--   * This migration makes that claim READ-ONLY at the database, so no code
--     path — page, helper, definer, side-effect write — can change anything:
--       1. a PostgREST pre-request function puts every request whose token
--          carries `view_as` into a read-only transaction (Postgres then refuses
--          INSERT/UPDATE/DELETE everywhere, inside definers too, and a function
--          cannot switch it back after the first query);
--       2. Storage is a separate service the hook does not reach, so
--          storage.objects gets RESTRICTIVE write policies for the claim;
--       3. every table on a module's data-browser `neverReadable` list (today
--          only sd_notes) gets a RESTRICTIVE policy, so a viewed screen can never
--          show what the superadmin may not read (db test enforces the list);
--       4. every table of every module that is NOT allowed (all but cls_) gets
--          the same RESTRICTIVE policy, so the token reads nothing outside the
--          allowed module even though the person's RLS would let it.
--   * Reviewed 2026-11-12: Fable (docs/13 "FABLE REVIEW"), plus an app-code and
--     a SQL adversarial review — no blocker; every finding folded in here or in
--     the app (sequence grant, 4b, `to public`, initplan form, hook never raises).
--   * Every view and every viewed page is logged (two append-only tables,
--     superadmin-read-only, written only by the definers below).
--
-- WHO MAY BE VIEWED: an ACTIVE member of the org, in an org with the module ON,
-- never a superadmin, never oneself. MODULES ALLOWED: classroom only —
-- widening is a migration plus that module's own review (docs/13 Q3; speed-dating
-- and matchmaking end users stay banned, docs/15 §8.1 point 7).
--
-- ACLs: revoke before grant on everything (docs/03 #27).

-- ---------------------------------------------------------------------------
-- 1. is_view_as_request() — does this request's token carry the view_as mark?
-- ---------------------------------------------------------------------------
-- Used inside RLS policies, so the querying roles must be able to execute it.
-- It reveals only a fact about the caller's own token.
create or replace function public.is_view_as_request()
returns boolean
language sql
stable
set search_path = ''
as $$
  -- Never raises (the pre-request hook depends on that): claims that are not
  -- valid JSON, which PostgREST never sends, read as "not a view".
  select case
    when pg_catalog.pg_input_is_valid(coalesce(pg_catalog.current_setting('request.jwt.claims', true), ''), 'jsonb')
      then (pg_catalog.current_setting('request.jwt.claims', true)::jsonb) ? 'view_as'
    else false
  end;
$$;

revoke all on function public.is_view_as_request() from public, anon, authenticated, service_role;
grant execute on function public.is_view_as_request() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The read-only gate: PostgREST's pre-request function
-- ---------------------------------------------------------------------------
-- PostgREST calls this at the start of EVERY API request, after switching to
-- the request's role and setting its claims. It must never fail for an
-- ordinary request (a failure here would take the whole API down), so it does
-- one cheap check and nothing else; is_view_as_request() never raises.
-- `transaction_read_only` may be switched ON at any point in a transaction; it
-- is switching it OFF after the first query that Postgres refuses.
create or replace function public.view_as_pre_request()
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  if public.is_view_as_request() then
    perform pg_catalog.set_config('transaction_read_only', 'on', true);
  end if;
end;
-- NO exception handler here, on purpose: a plpgsql EXCEPTION block runs as a
-- subtransaction, and leaving it reverts the set_config above — the gate would
-- silently be OFF (caught by real-view-as.test.ts, 2026-11-12). The function
-- cannot raise because is_view_as_request() cannot (it validates the JSON first).
$$;

revoke all on function public.view_as_pre_request() from public, anon, authenticated, service_role;
grant execute on function public.view_as_pre_request() to anon, authenticated, service_role;

alter role authenticator set pgrst.db_pre_request = 'public.view_as_pre_request';
notify pgrst, 'reload config';

-- ---------------------------------------------------------------------------
-- 3. Storage: no writes with a view_as token (the hook does not run there)
-- ---------------------------------------------------------------------------
-- `to public` (every role), not just authenticated: the server always mints
-- role=authenticated, but the policy should not depend on that (SQL review).
create policy view_as_no_insert on storage.objects
  as restrictive for insert to public
  with check (not (select public.is_view_as_request()));
create policy view_as_no_update on storage.objects
  as restrictive for update to public
  using (not (select public.is_view_as_request()))
  with check (not (select public.is_view_as_request()));
create policy view_as_no_delete on storage.objects
  as restrictive for delete to public
  using (not (select public.is_view_as_request()));

-- ---------------------------------------------------------------------------
-- 4. neverReadable tables stay dark to a viewed screen
-- ---------------------------------------------------------------------------
-- sd_notes: the author's private notes, with NO staff arm anywhere, not even
-- the superadmin's (data-browser neverReadable). A real view of the author would
-- otherwise show them. storage-usage/real-view-as db tests assert every
-- neverReadable table carries a policy named `<table>_no_view_as`.
create policy sd_notes_no_view_as on public.sd_notes
  as restrictive for all to public
  using (not (select public.is_view_as_request()))
  with check (not (select public.is_view_as_request()));

-- ---------------------------------------------------------------------------
-- 4b. Only the allowed module is readable at all (SQL review, 2026-11-12)
-- ---------------------------------------------------------------------------
-- The token reads through the PERSON's RLS, which reaches every module they
-- use, while the app only renders classroom pages. So the database, not just
-- the page code, keeps the other modules dark: every table of every module
-- that is NOT allowed (today: all but classroom's cls_) gets a RESTRICTIVE
-- `<table>_no_view_as`. Speed-dating interest marks, match lists and chat
-- messages stay unreadable to a viewed screen even if a page tried.
-- Tables created later are caught by real-view-as.test.ts, which fails for any
-- module table outside the allowed modules without this policy. Allowing a new
-- module = dropping its tables' policies in that module's own migration.
do $$
declare
  t text;
begin
  for t in
    select c.relname from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname ~ '^(mm|syn|vm|sal|sd|smp)_'
      and c.relname <> 'sd_notes'
    order by c.relname
  loop
    execute pg_catalog.format(
      'create policy %I on public.%I as restrictive for all to public '
      || 'using (not (select public.is_view_as_request())) with check (not (select public.is_view_as_request()))',
      t || '_no_view_as', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. The log: sessions and the pages viewed in them
-- ---------------------------------------------------------------------------
-- Foreign keys are `set null` (not cascade), like view_as_sessions: a security
-- log must outlive the people and orgs it names. Nothing updates these tables
-- except view_as_real_start/end closing a session (ended_at), so `set null`
-- firing an UPDATE meets no trigger.
create table public.view_as_real_sessions (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users (id) on delete set null,
  target_user_id uuid references auth.users (id) on delete set null,
  org_id uuid references public.orgs (id) on delete set null,
  module_key text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes',
  ended_at timestamptz
);
create index view_as_real_sessions_actor_idx on public.view_as_real_sessions (actor_user_id, created_at desc);
create index view_as_real_sessions_target_idx on public.view_as_real_sessions (target_user_id, created_at desc);
create index view_as_real_sessions_org_idx on public.view_as_real_sessions (org_id, created_at desc);

create table public.view_as_real_page_views (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.view_as_real_sessions (id) on delete cascade,
  path text not null check (char_length(path) <= 500),
  viewed_at timestamptz not null default now()
);
create index view_as_real_page_views_session_idx on public.view_as_real_page_views (session_id, viewed_at);

alter table public.view_as_real_sessions enable row level security;
alter table public.view_as_real_page_views enable row level security;

create policy view_as_real_sessions_select on public.view_as_real_sessions
  for select to authenticated using (public.is_superadmin());
create policy view_as_real_page_views_select on public.view_as_real_page_views
  for select to authenticated using (public.is_superadmin());

revoke all on public.view_as_real_sessions from public, anon, authenticated, service_role;
revoke all on public.view_as_real_page_views from public, anon, authenticated, service_role;
grant select on public.view_as_real_sessions to authenticated;
grant select on public.view_as_real_page_views to authenticated;
-- The identity column's sequence gets prod's default grants too (UPDATE would
-- allow setval, which could make every page-view insert fail). Nobody needs it:
-- the definer that inserts runs as the owner.
revoke all on sequence public.view_as_real_page_views_id_seq from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. view_as_real_start(target, org, module) — superadmin only
-- ---------------------------------------------------------------------------
-- Closes any view this superadmin still has open (one at a time), then opens a
-- new one for 30 minutes. Every refusal reads the same for a caller who is not
-- the superadmin ("Not allowed"); the superadmin gets the specific reason.
create or replace function public.view_as_real_start(p_target uuid, p_org uuid, p_module text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null or not public.is_superadmin() or public.is_view_as_request() then
    raise exception 'Not allowed';
  end if;
  if p_module is distinct from 'classroom' then
    raise exception 'Real view-as is not available for this module';
  end if;
  if p_target is null or p_target = auth.uid() then
    raise exception 'Choose someone else to view';
  end if;
  if exists (select 1 from public.user_private u where u.user_id = p_target and u.is_superadmin) then
    raise exception 'A superadmin cannot be viewed';
  end if;
  if not exists (
    select 1 from public.org_modules m
    where m.org_id = p_org and m.module_key = p_module and m.enabled
  ) then
    raise exception 'That organization does not have this module on';
  end if;
  if not exists (
    select 1 from public.org_members m
    where m.org_id = p_org and m.user_id = p_target and coalesce(m.status, 'active') = 'active'
  ) then
    raise exception 'That person is not an active member of this organization';
  end if;

  update public.view_as_real_sessions
  set ended_at = pg_catalog.now()
  where actor_user_id = auth.uid() and ended_at is null;

  insert into public.view_as_real_sessions (actor_user_id, target_user_id, org_id, module_key)
  values (auth.uid(), p_target, p_org, p_module)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. view_as_real_check(session, path, log) — superadmin only; the proxy calls
--    it on every request while the view cookie is set
-- ---------------------------------------------------------------------------
-- Returns ONE row when the session is this superadmin's, open, unexpired, and
-- its person is still an active non-superadmin member of an org that still has
-- the module on; otherwise NO row (the proxy then drops the view). `in_scope`
-- says whether `p_path` is inside /o/<slug>/m/<module>; only then is the page
-- logged (when p_log) and only then does the app render as the person.
create or replace function public.view_as_real_check(p_session uuid, p_path text, p_log boolean)
returns table (
  target_user_id uuid,
  target_name text,
  org_id uuid,
  org_slug text,
  org_name text,
  module_key text,
  expires_at timestamptz,
  in_scope boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  s record;
  v_prefix text;
  v_in boolean;
begin
  if auth.uid() is null or not public.is_superadmin() or public.is_view_as_request() then
    return;
  end if;
  select vs.id, vs.target_user_id, vs.org_id, vs.module_key, vs.expires_at, o.slug, o.name
    into s
  from public.view_as_real_sessions vs
  join public.orgs o on o.id = vs.org_id
  where vs.id = p_session
    and vs.actor_user_id = auth.uid()
    and vs.ended_at is null
    and vs.expires_at > pg_catalog.now()
    and vs.target_user_id is not null
    and not exists (select 1 from public.user_private u where u.user_id = vs.target_user_id and u.is_superadmin)
    and exists (select 1 from public.org_members m
                where m.org_id = vs.org_id and m.user_id = vs.target_user_id
                  and coalesce(m.status, 'active') = 'active')
    and exists (select 1 from public.org_modules m
                where m.org_id = vs.org_id and m.module_key = vs.module_key and m.enabled);
  if not found then
    return;
  end if;

  v_prefix := '/o/' || s.slug || '/m/' || s.module_key;
  v_in := p_path = v_prefix or pg_catalog.starts_with(p_path, v_prefix || '/');
  if v_in and coalesce(p_log, false) then
    insert into public.view_as_real_page_views (session_id, path)
    values (s.id, pg_catalog.left(p_path, 500));
  end if;

  return query
    select s.target_user_id,
           (select p.display_name from public.profiles p where p.user_id = s.target_user_id),
           s.org_id, s.slug::text, s.name::text, s.module_key, s.expires_at, v_in;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. view_as_real_end(session) — superadmin only; ends their own open view
-- ---------------------------------------------------------------------------
create or replace function public.view_as_real_end(p_session uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_superadmin() or public.is_view_as_request() then
    raise exception 'Not allowed';
  end if;
  update public.view_as_real_sessions
  set ended_at = pg_catalog.now()
  where id = p_session and actor_user_id = auth.uid() and ended_at is null;
end;
$$;

revoke all on function public.view_as_real_start(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.view_as_real_check(uuid, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.view_as_real_end(uuid) from public, anon, authenticated, service_role;
grant execute on function public.view_as_real_start(uuid, uuid, text) to authenticated;
grant execute on function public.view_as_real_check(uuid, text, boolean) to authenticated;
grant execute on function public.view_as_real_end(uuid) to authenticated;
