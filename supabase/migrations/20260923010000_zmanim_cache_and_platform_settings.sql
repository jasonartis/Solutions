-- Zmanim cache, the call log behind it, and a global settings store (2026-09-23).
-- Design, founder decisions and the authority split: docs/23.
--
-- WHY. The synagogue module calls myzmanim once per date PER PAGE RENDER — 7
-- serial paid calls for a cold week view, with no persistence beyond a
-- per-process Map that dies with each serverless instance. The member page, the
-- public page and the export job each pay it separately. `getDay` accepts an
-- InputDate of "current date +/- 1 year" and there is NO bulk endpoint, so a
-- year is 365 single calls per location — which is exactly why holding a year
-- locally is worth doing: even temporary API access converts into a year of data.
--
-- PROD TODAY: two synagogue orgs, BOTH on location 'US11210'. So the shared
-- per-location cache halves the calls before any prefetch exists.
--
-- ===========================================================================
-- 1. syn_zmanim_cache.times -> payload  (founder decision 1: STORE RAW)
-- ===========================================================================
-- The table has existed since the module's FIRST migration (20260707030000)
-- with the comment "one myzmanim call per (location, date), shared across orgs"
-- and has NEVER been read or written by any code. Its `times` column was meant
-- for the PARSED times.
--
-- Founder decision 1 changes what it holds: the WHOLE response. The response
-- carries `Place` (20 fields) and `Time` (42: DafYomi, DateJewish, Parsha,
-- Holiday, Omer, the Is* flags) alongside `Zman` (89) — all in the same paid
-- call, and all currently discarded by the connector. Storing raw means adding
-- Daf Yomi to a schedule later costs no refetch.
--
-- SAFE BECAUSE IT IS EMPTY, asserted rather than assumed: measured 0 rows on
-- PROD and 0 locally on 2026-09-23. The assertion below is not ceremony — a row
-- written under the OLD meaning would be a parsed-times map masquerading as a
-- raw response, and every reader would misinterpret it. If it ever DOES trip,
-- note the recovery path is a NEW migration: docs/03 #28 forbids editing this
-- one once pushed.
do $$
declare
  n integer;
begin
  select count(*) into n from public.syn_zmanim_cache;
  if n <> 0 then
    raise exception
      'syn_zmanim_cache holds % row(s); they are PARSED TIMES under the old meaning and cannot be reinterpreted as raw payloads — migrate or delete them deliberately first', n;
  end if;
end $$;

alter table public.syn_zmanim_cache rename column times to payload;

comment on table public.syn_zmanim_cache is
  'One RAW myzmanim getDay response per (location, date, source). Shared across '
  'orgs — keyed by location, never by org, and contains no org data. Written by '
  'the worker only. NEVER cache a failed response: see docs/23 section 5.';

comment on column public.syn_zmanim_cache.payload is
  'The whole API response, unparsed (founder decision 1, docs/23). Place/Time/Zman '
  'all arrive in the same paid call, so parsing it down on the way in would throw '
  'away data we already bought.';

-- ===========================================================================
-- 2. platform_settings — global, superadmin-only key/value
-- ===========================================================================
-- Founder decisions 5 and 7 need a switch that is not per-org and not per-user,
-- and NO global settings store exists: settings live only on `orgs`,
-- `org_modules` and `user_private`.
--
-- DELIBERATELY a plain key/value table and NOT a "batched API framework".
-- `job_requests` + pg-boss already are the batching mechanism; a second one
-- would be speculation (CLAUDE.md: never build platform primitives
-- speculatively). A key/value table is one table, and the next global switch
-- costs a ROW rather than a migration. Keys are namespaced, e.g.
-- 'zmanim.prefetch'.
--
-- READING THE VALUE: always `value ->> 'k' = 'true'`, NEVER
-- `(value -> 'k')::boolean`. The cast raises 22023 on a JSON string and aborts
-- the WHOLE query — a trap this repo has already hit on an unconstrained
-- settings blob (docs/22 section 23.4 item 3).
create table public.platform_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

-- NO `set_updated_at` TRIGGER HERE, and that is deliberate rather than an
-- oversight — every other table in this repo has one. `updated_by` references
-- auth.users ON DELETE SET NULL, and a foreign key's referential action is
-- implemented as a real UPDATE that FIRES the child's BEFORE triggers (the trap
-- recorded in CLAUDE.md, which has already made an org undeletable once). A
-- trigger here would therefore bump `updated_at` on unrelated rows whenever any
-- user is deleted, making the "auto-paused at <time>" reason line lie. Writes go
-- through platform_setting_merge() below, which sets the timestamp explicitly in
-- the same statement.
-- docs/03 #27 — REVOKE BEFORE GRANT. `pg_default_acl` differs by schema AND by
-- environment; assuming a CLI-created table inherits nothing is what let an
-- ordinary seeded user set his own is_superadmin in CI. State the whole ACL.
revoke all privileges on public.platform_settings from public, anon, authenticated, service_role;
-- `authenticated` needs the verbs so a superadmin can use the console as an
-- ordinary signed-in user; the RLS policy below is what actually restricts it,
-- and that dependency is the whole reason this grant is safe.
grant select, insert, update, delete on public.platform_settings to authenticated;
-- The worker reads the switch and WRITES it when the breaker auto-pauses.
grant select, insert, update on public.platform_settings to service_role;

alter table public.platform_settings enable row level security;

-- One `for all` policy, and the well-known trap is faced deliberately: a `for
-- all` policy's USING governs SELECT too (docs/15, docs/20 section 8.1). That is
-- CORRECT here — every verb on this table is superadmin-only, so there is no
-- second intent for the split to express. Splitting it would produce four
-- identical policies.
create policy platform_settings_superadmin on public.platform_settings
  for all using (public.is_superadmin()) with check (public.is_superadmin());

comment on table public.platform_settings is
  'Global, superadmin-only key/value settings that belong to no org and no user. '
  'Namespaced keys (e.g. zmanim.prefetch). NOT a batch framework — job_requests '
  'and pg-boss already fill that role. Read booleans with ->> , never a ::boolean cast.';

-- SEEDED OFF, on purpose. Without a row the first-boot state is whatever the
-- worker happens to default to, and the myzmanim key is currently unauthorized
-- (docs/23 section 7) — so a sweep that defaulted ON would hammer a dead API
-- from the moment it deploys. The horizon, the per-run budget and founder
-- decision 7's pause-after-N-days all live in this row rather than in code, so
-- the superadmin UI can change them without a migration.
insert into public.platform_settings (key, value)
values (
  'zmanim.prefetch',
  jsonb_build_object(
    'enabled', false,
    'horizonDays', 365,
    'budgetPerRun', 40,
    'pauseAfterDays', 3,
    'pausedReason', 'never enabled — the myzmanim key is unauthorized (docs/23 section 7)'
  )
)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- platform_setting_merge() — the ONE write path for the console
-- ---------------------------------------------------------------------------
-- Two problems it solves, both of which a read-modify-write from the app would
-- reintroduce:
--   * CLOBBERING. The human switch and the circuit breaker write the SAME row
--     (founder decision 7 — deliberately one switch, one honest state). A
--     console that read the row, changed `enabled` and wrote the whole value
--     back would silently erase an auto-pause that happened in between. This
--     merges in a single statement.
--   * A STALE updated_at, since there is no trigger (see above).
create or replace function public.platform_setting_merge(setting_key text, patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  merged jsonb;
begin
  -- The definer bypasses RLS, so the authority test must be explicit. It asks
  -- about the CALLER, which is exactly what is_superadmin() answers (docs/03 #29).
  if not public.is_superadmin() then
    raise exception 'platform_settings is superadmin-only' using errcode = '42501';
  end if;

  insert into public.platform_settings as s (key, value, updated_at, updated_by)
  values (setting_key, patch, now(), auth.uid())
  on conflict (key) do update
    set value = s.value || excluded.value,
        updated_at = now(),
        updated_by = auth.uid()
  returning s.value into merged;

  return merged;
end;
$$;

revoke execute on function public.platform_setting_merge(text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.platform_setting_merge(text, jsonb) to authenticated;
-- The WORKER does not use this function: it runs as service_role, which is not
-- a superadmin and would be refused. It writes its auto-pause directly, and must
-- do so as a single `set value = value || ...` statement for the same reason.

-- ===========================================================================
-- 3. syn_zmanim_fetch_log — append-only record of every API call
-- ===========================================================================
-- `syn_zmanim_cache` records only what SUCCEEDED, so it cannot answer either
-- "has anything worked in 3 days?" (founder decision 7) or "what did this cost?"
-- (decision 9) — a failed call leaves no trace there at all. One append-only log
-- answers both, plus "what is wrong right now", which is what puts
-- NotAuthorizedSeeApiDashboardForDetails on the console in words instead of
-- leaving a superadmin to guess why coverage is zero.
--
-- `origin` IS LOAD-BEARING, NOT DECORATION — an adversarial review caught this.
-- Without it, a maker's manual "fetch my location" success writes ok = true and
-- therefore RESETS the breaker's `max(fetched_at) where ok`, so founder decision
-- 7's "3 days with no successful call" would silently never trigger while the
-- sweep was dead. The breaker must count only `origin = 'sweep'`. It is also
-- what makes decision 9's counter answer the question docs/23 section 3 actually
-- worries about: who spent the money — the sweep, a maker, or a full backfill.
create table public.syn_zmanim_fetch_log (
  id uuid primary key default gen_random_uuid(),
  location_key text not null,
  -- NOT NULL: every getDay call is for exactly one date, and a NULL would
  -- silently drop the row out of any coverage or count(distinct date) read.
  date date not null,
  origin text not null check (origin in ('sweep', 'maker', 'backfill')),
  requested_by uuid references auth.users(id) on delete set null,
  ok boolean not null,
  err_msg text,
  fetched_at timestamptz not null default now()
);

-- The breaker's query is `max(fetched_at) where origin='sweep' and ok`, so index
-- exactly that; the plain fetched_at index serves the month-to-date counter and
-- the "what is wrong right now" lookup.
create index syn_zmanim_fetch_log_at_idx on public.syn_zmanim_fetch_log (fetched_at desc);
create index syn_zmanim_fetch_log_breaker_idx
  on public.syn_zmanim_fetch_log (origin, ok, fetched_at desc);

revoke all privileges on public.syn_zmanim_fetch_log from public, anon, authenticated, service_role;
-- APPEND-ONLY IS ENFORCED BY THE GRANTS, not by a trigger. A
-- `before update or delete ... raise` trigger would make every row this table
-- ever referenced undeletable, because an FK's ON DELETE action is implemented
-- as a real UPDATE/DELETE and fires the child's BEFORE triggers — the trap
-- recorded in CLAUDE.md and the reason vm_moderation_log has no such trigger.
-- No UPDATE and no DELETE are granted to anyone, so an attempt is 42501.
grant select on public.syn_zmanim_fetch_log to authenticated;
grant select, insert on public.syn_zmanim_fetch_log to service_role;

alter table public.syn_zmanim_fetch_log enable row level security;

-- Superadmin READS. Nobody writes through the API roles — the worker writes as
-- service_role, which is not subject to RLS.
create policy syn_zmanim_fetch_log_select_superadmin on public.syn_zmanim_fetch_log
  for select using (public.is_superadmin());

comment on table public.syn_zmanim_fetch_log is
  'One row per myzmanim API call, success or failure. Feeds the 3-day circuit '
  'breaker (which counts origin=sweep ONLY), the month-to-date call counter, and '
  'the current-error line on the console. Append-only by GRANT (no update/delete '
  'to any role).';

-- ===========================================================================
-- 4. syn_zmanim_cached() — the read path for the app
-- ===========================================================================
-- The cache is service_role-only by design, and the hard rule is that the
-- service-role key lives in the worker. So the web app cannot read the table
-- directly; it reads through this definer instead. That keeps the table locked
-- exactly as its own comment promises and adds no new table grants.
--
-- IT RETURNS `source` AND `fetched_at`, not just the payload. Founder decision 3
-- — tell a maker when a schedule is running on fallback — is UNSERVEABLE from a
-- payload alone, and changing a function's signature later means a second
-- function plus a full ACL restatement, so it is done now (adversarial review,
-- 2026-09-23). For the same reason it does NOT hard-code `source = 'myzmanim'`:
-- that would make any other source invisible to the only read path there is.
-- The caller picks, and can see which it got.
--
-- GRANTED TO anon AS WELL AS authenticated, deliberately: the module's PUBLIC
-- schedule viewer (/s/<slug>) is anonymous by design and already renders these
-- very times on a public page, so this is not new exposure — it is the same
-- pattern as syn_public_weeks/syn_public_week (20260707120000:94-95), which are
-- also granted to anon. The rows contain no org data: a location key, a date,
-- and public astronomical/calendar values.
--
-- THE RANGE IS BOUNDED. An adversarial review noted that an unbounded range lets
-- anon dump the entire cache for any guessable location key in one call —
-- not a confidentiality breach (the data is public) but a scraping cost on data
-- we PAY for. 400 days is a year plus slack, which is more than the API's own
-- horizon, so no legitimate caller notices.
create or replace function public.syn_zmanim_cached(
  check_location_key text,
  from_day date,
  to_day date
)
returns table (zman_date date, zman_source text, zman_payload jsonb, zman_fetched_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if to_day < from_day then
    raise exception 'to_day (%) is before from_day (%)', to_day, from_day;
  end if;
  if to_day - from_day > 400 then
    raise exception 'range of % days is too wide; the API horizon is one year', to_day - from_day;
  end if;

  return query
    select c.date, c.source, c.payload, c.fetched_at
    from public.syn_zmanim_cache c
    where c.location_key = check_location_key
      and c.date between from_day and to_day
    order by c.date, c.source;
end;
$$;

-- docs/03 #1: state the whole ACL. Postgres grants EXECUTE to PUBLIC at CREATE,
-- and on PROD `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` ALSO grants it
-- directly to anon/authenticated/service_role — which `revoke ... from public`
-- does NOT remove, and which local has no equivalent of. So revoke all four,
-- then grant back exactly who needs it.
revoke execute on function public.syn_zmanim_cached(text, date, date)
  from public, anon, authenticated, service_role;
grant execute on function public.syn_zmanim_cached(text, date, date)
  to anon, authenticated, service_role;

-- ===========================================================================
-- 5. Assertions — prove the shape rather than trusting the statements above
-- ===========================================================================
do $$
declare
  n integer;
begin
  -- The rename actually happened, and nothing named `times` survives.
  select count(*) into n from information_schema.columns
  where table_schema = 'public' and table_name = 'syn_zmanim_cache' and column_name = 'payload';
  if n <> 1 then raise exception 'syn_zmanim_cache.payload is missing after the rename'; end if;

  select count(*) into n from information_schema.columns
  where table_schema = 'public' and table_name = 'syn_zmanim_cache' and column_name = 'times';
  if n <> 0 then raise exception 'syn_zmanim_cache.times still exists after the rename'; end if;

  -- Append-only really is enforced: no api role may UPDATE or DELETE the log.
  if has_table_privilege('authenticated', 'public.syn_zmanim_fetch_log', 'update')
     or has_table_privilege('authenticated', 'public.syn_zmanim_fetch_log', 'delete')
     or has_table_privilege('service_role', 'public.syn_zmanim_fetch_log', 'update')
     or has_table_privilege('service_role', 'public.syn_zmanim_fetch_log', 'delete') then
    raise exception 'syn_zmanim_fetch_log is not append-only — an api role holds update or delete';
  end if;

  -- anon holds nothing on either new table (the ACL-hardening invariant).
  if has_table_privilege('anon', 'public.platform_settings', 'select')
     or has_table_privilege('anon', 'public.syn_zmanim_fetch_log', 'select') then
    raise exception 'anon can read a new table — revoke did not take';
  end if;

  -- And the escalation shape docs/03 #27 exists for: authenticated must not be
  -- able to write the log at all, in any column.
  if has_table_privilege('authenticated', 'public.syn_zmanim_fetch_log', 'insert') then
    raise exception 'authenticated can insert into the append-only fetch log';
  end if;

  -- The seeded switch exists and is OFF. A sweep that shipped ON against the
  -- currently-unauthorized key would fail every run from the first deploy.
  if not exists (
    select 1 from public.platform_settings
    where key = 'zmanim.prefetch' and value ->> 'enabled' = 'false'
  ) then
    raise exception 'zmanim.prefetch is missing or not seeded OFF';
  end if;

  -- The breaker cannot be fooled by a maker's manual fetch: `origin` exists and
  -- is constrained, so a row that does not say where it came from is impossible.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'syn_zmanim_fetch_log'
      and column_name = 'origin' and is_nullable = 'NO'
  ) then
    raise exception 'syn_zmanim_fetch_log.origin is missing or nullable';
  end if;
end $$;
