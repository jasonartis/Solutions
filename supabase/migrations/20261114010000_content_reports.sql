-- CONTENT REPORTS — the platform legal slice's public removal route
-- (module-9 spec §B1 TAKE IT DOWN Act, §H(c) wording v2, built 2026-11-09).
--
-- Anyone, signed in or NOT, can report content from the public /report page:
-- where they saw it, a reason, optional details, their email, and an accuracy
-- confirmation. The requester is usually not a member, and the route is
-- operated by the superadmin — never an org admin, who may be the person who
-- posted it (§B1).
--
-- WHO READS WHAT:
--   * the superadmin reads every report (RLS policy, is_superadmin());
--   * NOBODY ELSE — not the reporter (a report holds no account link), not an
--     org admin, not anon.
--
-- WRITES go only through SECURITY DEFINER functions; the table grants SELECT
-- to authenticated (filtered to the superadmin by RLS) and nothing to anon
-- (revoke-before-grant, docs/03 #27):
--   content_report_submit(token, client_hint, where_seen, reason, details, email, accurate, signature, nonconsent)
--       EXECUTE for anon + authenticated, but useless without the token (below).
--       Returns NOTHING, so a caller learns no id and cannot probe or count.
--   content_report_set_status(id, status, note)
--       superadmin only; every other caller gets "Report not found".
--   content_report_intake_status()
--       superadmin only: is intake configured, and how many reports / refusals
--       in the last 24 hours (the dashboard reads this).
--
-- ABUSE — the only write path on the platform open to the anonymous internet.
-- Both adversarial reviews (2026-11-09) showed that with the anon key, which
-- every browser holds, a direct RPC caller could exhaust a database-only
-- daily cap with made-up emails and close the legal removal route for
-- everyone, or burn a known victim's per-email quota. So:
--   * THE SERVER IS THE ONLY CALLER. submit requires a server-only token whose
--     SHA-256 sits in content_report_intake_config, which no API role can read.
--     Only the Next.js server action holds the token (env CONTENT_REPORT_TOKEN;
--     it is not the service-role key and grants nothing else — docs/03 #14).
--   * The server passes a hint for the visitor's real address (Vercel's
--     x-real-ip). The database stores only sha256(salt || hint), salted with
--     the stored token hash, in content_report_intake, kept 24 hours. At most
--     5 reports per address per rolling 24 hours.
--   * At most 500 reports platform-wide per rolling 24 hours: a storage
--     ceiling, reached only by a flood from 100+ addresses. Refusals are
--     counted (intake rows with accepted = false) and the dashboard turns
--     urgent as the ceiling nears, so a flood is SEEN; the refusal message on
--     /report gives the contact email as the fallback route.
--   * Every field is capped in characters AND bytes (multi-byte text cannot
--     multiply the stored size).
--   * Input is validated and an UNLOCKED pre-check runs before the advisory
--     lock, so invalid or over-cap calls fail fast instead of queueing on the
--     lock while holding a pooled connection.
--
-- WHAT IS NOT STORED: no account id, raw IP address or browser details. The
-- reporter's email is the only identity, and they chose to give it. It is
-- not linked to any account, so account deletion (docs/21) does not touch it.
-- RETENTION: reports are kept — no DELETE grant to any API role, the
-- superadmin included. A retention period for closed reports is an open
-- founder item (module-9 spec §B, docs/21).
--
-- Times are clock_timestamp(), as in 20261106010000 (feedback).

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.content_reports (
  id uuid primary key default gen_random_uuid(),
  where_seen text not null
    check (char_length(where_seen) between 1 and 1000 and octet_length(where_seen) <= 4000 and where_seen ~ '\S'),
  reason text not null
    check (reason in ('without_permission', 'intimate', 'minor', 'copyright', 'other')),
  details text
    check (details is null or (char_length(details) between 1 and 2000 and octet_length(details) <= 8000 and details ~ '\S')),
  reporter_email text not null
    check (char_length(reporter_email) <= 254 and reporter_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  -- The "information I've given is accurate" box. Always true; kept as the record.
  attested_accurate boolean not null check (attested_accurate),
  -- TAKE IT DOWN Act §3(a)(1)(B) (checked against the enrolled text 2026-11-10):
  -- a valid removal request for an intimate image carries (i) a physical or
  -- ELECTRONIC SIGNATURE of the person shown or someone authorised to act for
  -- them, and (iii) a brief good-faith statement that it is not consensual.
  -- So for reason 'intimate' both are REQUIRED (the typed name is the
  -- electronic signature); for every other reason both stay empty.
  signature_name text
    check (signature_name is null or (char_length(signature_name) between 1 and 200 and octet_length(signature_name) <= 800 and signature_name ~ '\S')),
  attested_nonconsent boolean not null default false,
  constraint content_reports_intimate_signed check (
    case when reason = 'intimate' then signature_name is not null and attested_nonconsent
         else signature_name is null and not attested_nonconsent end
  ),
  status text not null default 'new'
    check (status in ('new', 'reviewing', 'actioned', 'dismissed')),
  staff_note text check (staff_note is null or char_length(staff_note) <= 4000),
  -- The LAST status change (overwritten each time).
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  -- closed_at: set while the report is closed (actioned or dismissed), cleared
  -- if reopened. first_closed_at is never cleared: the 48-hour measurement
  -- (created_at → first close) survives a reopen.
  closed_at timestamptz,
  first_closed_at timestamptz,
  created_at timestamptz not null default now()
);
create index content_reports_open_idx on public.content_reports (status, created_at);
create index content_reports_created_idx on public.content_reports (created_at desc);

-- One row: the SHA-256 (hex) of the server's token. Definers only.
create table public.content_report_intake_config (
  id boolean primary key default true check (id),
  token_sha256 text not null check (token_sha256 ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now()
);

-- Rate-limit ledger: salted address hashes, kept 24 hours (pruned by submit
-- itself). Definers only.
create table public.content_report_intake (
  id bigint generated always as identity primary key,
  client_hash text not null,
  accepted boolean not null,
  created_at timestamptz not null default now()
);
create index content_report_intake_client_idx on public.content_report_intake (client_hash, created_at);
create index content_report_intake_created_idx on public.content_report_intake (created_at);

revoke all privileges on public.content_reports from public, anon, authenticated, service_role;
revoke all privileges on public.content_report_intake_config from public, anon, authenticated, service_role;
revoke all privileges on public.content_report_intake from public, anon, authenticated, service_role;
grant select on public.content_reports to authenticated;

alter table public.content_reports enable row level security;
alter table public.content_report_intake_config enable row level security;
alter table public.content_report_intake enable row level security;

create policy content_reports_select_superadmin on public.content_reports
  for select to authenticated
  using (public.is_superadmin());
-- The two intake tables have NO policy: no API role can read them.

-- ---------------------------------------------------------------------------
-- 2. content_report_submit — called by the Next.js server action only
-- ---------------------------------------------------------------------------
create or replace function public.content_report_submit(
  p_token text, p_client_hint text,
  p_where_seen text, p_reason text, p_details text, p_email text, p_accurate boolean,
  p_signature text, p_nonconsent boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_salt text;
  v_client text;
  v_where text := regexp_replace(coalesce(p_where_seen, ''), '^\s+|\s+$', '', 'g');
  v_details text := nullif(regexp_replace(coalesce(p_details, ''), '^\s+|\s+$', '', 'g'), '');
  v_email text := lower(regexp_replace(coalesce(p_email, ''), '^\s+|\s+$', '', 'g'));
  v_signature text := nullif(regexp_replace(coalesce(p_signature, ''), '^\s+|\s+$', '', 'g'), '');
begin
  -- 1. The token. Same message for a wrong token and unconfigured intake.
  select token_sha256 into v_salt from public.content_report_intake_config;
  if v_salt is null or p_token is null
     or encode(sha256(convert_to(p_token, 'UTF8')), 'hex') <> v_salt then
    raise exception 'Report intake unavailable';
  end if;

  -- 2. Validate (plain messages, never a raw CHECK violation — docs/03 #22).
  if p_accurate is distinct from true
     or char_length(v_where) not between 1 and 1000 or octet_length(v_where) > 4000
     or p_reason is null or p_reason not in ('without_permission', 'intimate', 'minor', 'copyright', 'other')
     or (v_details is not null and (char_length(v_details) > 2000 or octet_length(v_details) > 8000))
     or char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Invalid report';
  end if;
  -- An intimate-image report needs the signature and the good-faith statement
  -- (TAKE IT DOWN Act §3(a)(1)(B)); any other reason stores neither.
  if p_reason = 'intimate' then
    if v_signature is null or char_length(v_signature) > 200 or octet_length(v_signature) > 800
       or p_nonconsent is distinct from true then
      raise exception 'Invalid report';
    end if;
  else
    v_signature := null;
  end if;

  v_client := encode(sha256(convert_to(v_salt || '|' || left(coalesce(p_client_hint, 'unknown'), 100), 'UTF8')), 'hex');

  -- 3. Unlocked pre-check: a flood fails fast without queueing on the lock.
  if (select count(*) from public.content_report_intake
      where client_hash = v_client and accepted and created_at > clock_timestamp() - interval '24 hours') >= 5
     or (select count(*) from public.content_reports
         where created_at > clock_timestamp() - interval '24 hours') >= 500 then
    raise exception 'Too many reports right now';
  end if;

  -- 4. Serialise the real count so concurrent calls cannot race past a cap.
  perform pg_advisory_xact_lock(hashtext('public.content_report_submit'));
  if (select count(*) from public.content_report_intake
      where client_hash = v_client and accepted and created_at > clock_timestamp() - interval '24 hours') >= 5
     or (select count(*) from public.content_reports
         where created_at > clock_timestamp() - interval '24 hours') >= 500 then
    raise exception 'Too many reports right now';
  end if;

  delete from public.content_report_intake where created_at < clock_timestamp() - interval '24 hours';
  insert into public.content_report_intake (client_hash, accepted, created_at) values (v_client, true, clock_timestamp());
  insert into public.content_reports
    (where_seen, reason, details, reporter_email, attested_accurate, signature_name, attested_nonconsent, created_at)
  values (v_where, p_reason, v_details, v_email, true, v_signature, p_reason = 'intimate', clock_timestamp());
end;
$$;

-- A refusal raises, and the exception rolls back anything submit wrote, so
-- submit cannot count its own refusals. The server action records one with
-- content_report_note_refusal below, in a SEPARATE call, after a
-- 'Too many reports' refusal.

-- ---------------------------------------------------------------------------
-- 3. content_report_note_refusal — server action only (same token)
-- ---------------------------------------------------------------------------
create or replace function public.content_report_note_refusal(p_token text, p_client_hint text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_salt text;
begin
  select token_sha256 into v_salt from public.content_report_intake_config;
  if v_salt is null or p_token is null
     or encode(sha256(convert_to(p_token, 'UTF8')), 'hex') <> v_salt then
    raise exception 'Report intake unavailable';
  end if;
  -- Bounded: at most one refusal row per address per minute.
  if exists (
    select 1 from public.content_report_intake
    where client_hash = encode(sha256(convert_to(v_salt || '|' || left(coalesce(p_client_hint, 'unknown'), 100), 'UTF8')), 'hex')
      and not accepted and created_at > clock_timestamp() - interval '1 minute'
  ) then
    return;
  end if;
  insert into public.content_report_intake (client_hash, accepted, created_at)
  values (encode(sha256(convert_to(v_salt || '|' || left(coalesce(p_client_hint, 'unknown'), 100), 'UTF8')), 'hex'),
          false, clock_timestamp());
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. content_report_set_status — superadmin only
-- ---------------------------------------------------------------------------
create or replace function public.content_report_set_status(p_id uuid, p_status text, p_note text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_superadmin() then
    raise exception 'Report not found';
  end if;
  if p_status is null or p_status not in ('new', 'reviewing', 'actioned', 'dismissed') then
    raise exception 'Unknown status';
  end if;
  update public.content_reports
  set status = p_status,
      -- null leaves the note as it is; '' clears it.
      staff_note = case when p_note is null then staff_note else nullif(btrim(p_note), '') end,
      reviewed_by = auth.uid(),
      reviewed_at = clock_timestamp(),
      closed_at = case when p_status in ('actioned', 'dismissed') then coalesce(closed_at, clock_timestamp()) else null end,
      first_closed_at = case when p_status in ('actioned', 'dismissed') then coalesce(first_closed_at, clock_timestamp()) else first_closed_at end
  where id = p_id;
  if not found then
    raise exception 'Report not found';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. content_report_intake_status — superadmin only (dashboard)
-- ---------------------------------------------------------------------------
create or replace function public.content_report_intake_status()
returns table (configured boolean, accepted_24h bigint, refused_24h bigint, daily_cap integer)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_superadmin() then
    raise exception 'Not allowed';
  end if;
  return query select
    exists (select 1 from public.content_report_intake_config),
    (select count(*) from public.content_reports where created_at > clock_timestamp() - interval '24 hours'),
    (select count(*) from public.content_report_intake where not accepted and created_at > clock_timestamp() - interval '24 hours'),
    500;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Function ACLs — stated in full (prod's default privileges grant EXECUTE
--    to anon/authenticated/service_role on every new function).
-- ---------------------------------------------------------------------------
revoke all on function public.content_report_submit(text, text, text, text, text, text, boolean, text, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.content_report_note_refusal(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.content_report_set_status(uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.content_report_intake_status()
  from public, anon, authenticated, service_role;
-- The server action calls as the visitor: anon when signed out, authenticated
-- when signed in. The token is the gate, not the role.
grant execute on function public.content_report_submit(text, text, text, text, text, text, boolean, text, boolean) to anon, authenticated;
grant execute on function public.content_report_note_refusal(text, text) to anon, authenticated;
grant execute on function public.content_report_set_status(uuid, text, text) to authenticated;
grant execute on function public.content_report_intake_status() to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Catalog-only assertions (safe on an empty database).
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  f text;
  fn record;
begin
  foreach t in array array['content_reports', 'content_report_intake_config', 'content_report_intake'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception '% must have RLS enabled', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select')
       or has_table_privilege('anon', 'public.' || t, 'insert') then
      raise exception 'anon can reach % directly', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'insert')
       or has_table_privilege('authenticated', 'public.' || t, 'update')
       or has_table_privilege('authenticated', 'public.' || t, 'delete')
       or has_table_privilege('authenticated', 'public.' || t, 'truncate') then
      raise exception 'authenticated can write % directly', t;
    end if;
    if has_table_privilege('service_role', 'public.' || t, 'select') then
      raise exception 'service_role can read %', t;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.content_report_intake_config', 'select')
     or has_table_privilege('authenticated', 'public.content_report_intake', 'select') then
    raise exception 'authenticated can read an intake table';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'content_reports') <> 1
     or exists (select 1 from pg_policies where schemaname = 'public'
                and tablename in ('content_report_intake_config', 'content_report_intake')) then
    raise exception 'content reports must carry exactly one policy, and the intake tables none';
  end if;

  foreach f in array array[
    'content_report_submit(text, text, text, text, text, text, boolean, text, boolean)',
    'content_report_note_refusal(text, text)',
    'content_report_set_status(uuid, text, text)',
    'content_report_intake_status()'
  ] loop
    select p.prosecdef, p.proconfig, p.proacl::text as acl into fn
    from pg_proc p where p.oid = ('public.' || f)::regprocedure;
    if not fn.prosecdef then raise exception '% must be SECURITY DEFINER', f; end if;
    if not ('search_path=public' = any (fn.proconfig)) then raise exception '% lost its pinned search_path', f; end if;
    if fn.acl ~ 'service_role=' or fn.acl ~ '(^|[{,])=X' then
      raise exception '% grants EXECUTE to service_role or PUBLIC: %', f, fn.acl;
    end if;
    if fn.acl !~ 'authenticated=X' then raise exception '% is not callable by authenticated', f; end if;
    -- anon may call only the two token-gated intake functions.
    if (fn.acl ~ 'anon=X') <> (f like 'content_report_submit%' or f like 'content_report_note_refusal%') then
      raise exception '% has the wrong anon EXECUTE: %', f, fn.acl;
    end if;
  end loop;
end $$;
