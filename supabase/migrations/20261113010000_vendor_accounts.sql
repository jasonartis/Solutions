-- VENDOR ACCOUNTS PAGE (docs/28 Part A; founder 2026-11-09, built 2026-11-09).
--
-- One Owner Console page listing every outside account the platform depends on:
-- how to sign in, who owns it, two-step status, plan and payment, the dates that
-- must not be missed, WHERE its credentials are kept (by name), what breaks if it
-- is lost, and a click-through "last opened" history.
--
-- WHO READS AND WRITES: the superadmin, and nobody else. No org admin, no module
-- role, no anon, no service_role. Every table's single policy is is_superadmin().
--
-- THE PAGE MUST NEVER BE ABLE TO HOLD A PASSWORD OR KEY (founder, docs/28). Three
-- layers, each enforced by the database rather than the form:
--   1. There is no column for a secret. Credentials are recorded only as
--      (store, NAME) pairs in vendor_account_credentials, and NAME must look like an
--      environment-variable name (B2_APP_KEY) — never a value.
--   2. Every text value written to any of these tables passes
--      vendor_reject_secret_text(), a BEFORE INSERT/UPDATE trigger that reads the
--      row generically (to_jsonb), so a column added later is covered without anyone
--      remembering to. It rejects private-key blocks, JWTs, known vendor key
--      prefixes, user:password@ inside URLs, "password: x" / "key = x", long
--      key-shaped runs, and short password-shaped words (upper + lower + digit +
--      symbol in one word).
--   3. sign_in_url must be a plain https address with no user:password@, no
--      ?query and no #fragment — the places a link carries a token.
--   RESIDUAL, stated honestly (two independent reviews, 2026-11-09): text cannot
--   be told from a password when the password LOOKS like text — "the password is
--   hunter2", an all-lowercase "summer2026!", a short recovery code, a key typed
--   in spaced groups or split across two fields. Those pass. The page says so
--   beside every free-text box. Long keys from every vendor the reviewers tried
--   (Supabase, Stripe, Vercel, B2, JaaS, Sentry, AWS, PEM, JWT) are refused, and
--   so is a 40-character commit id (rephrase it).
--
-- WRITES: the superadmin writes the three description tables directly under RLS
-- (SELECT/INSERT/UPDATE; DELETE only on the two child lists, to fix typos). An
-- account is never deleted — it is marked 'closed', so its open history survives.
-- vendor_account_opens is APPEND-ONLY by grants (INSERT of account_id only; no
-- UPDATE/DELETE to any API role — CLAUDE.md: never an append-only trigger, which
-- would break ON DELETE actions). Who and when are column defaults the caller
-- cannot set (no column grant), and the policy pins opened_by = auth.uid().
--
-- ACCOUNT DELETION (docs/03 #35): vendor_account_opens.opened_by names the
-- superadmin who clicked. KEEP: an oversight record of a staff act, the same class
-- as superadmin_lookup_log — and, like it, ON DELETE SET NULL so a raw delete of
-- that account does not erase the history (the insert policy still requires
-- opened_by = auth.uid(), so a NULL can never be written through the API). No other column names a platform user (owner_login is
-- the vendor-side login, free text, not an account reference).
--
-- SEED: the rows at the end come from docs/14 and docs/28 Part B's starting
-- inventory (2026-11-09) and hold no secret — names of where credentials live, and
-- facts already in the public repo. Anything the repo does not know (costs, plans,
-- two-step status, most dates) is left blank or 'unknown' for the founder to fill.
-- They are plain rows: from here on the PAGE is the list, not docs/14.

-- ---------------------------------------------------------------------------
-- 1. The secret filter (pure; used only by the trigger below)
-- ---------------------------------------------------------------------------
-- Returns NULL when the text is clean, otherwise a short description of what it
-- looked like. Kept as one readable function so the founder can see exactly what
-- is refused.
create or replace function public.vendor_secret_reason(t text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  m text;
  w text;
begin
  if t is null or t = '' then
    return null;
  end if;

  if t ~ '-----BEGIN' then
    return 'a private key block';
  end if;
  if t ~ 'eyJ[A-Za-z0-9_-]{10,}' then
    return 'a signed token (JWT)';
  end if;
  if t ~ '\m(sk|pk|rk)_(live|test)_'
     or t ~ '\msk-[A-Za-z0-9_-]{16,}'
     or t ~ '\mgh[pousr]_[A-Za-z0-9]{20,}'
     or t ~ 'github_pat_'
     or t ~ '\mAKIA[0-9A-Z]{16}'
     or t ~ '\mxox[abprs]-'
     or t ~ '\mre_[A-Za-z0-9]{16,}'
     or t ~ '\mSG\.[A-Za-z0-9_-]{16,}' then
    return 'a vendor API key';
  end if;
  if t ~* '[a-z][a-z0-9+.-]*://[^/[:space:]:@]+:[^/[:space:]@]*@' then
    return 'a password inside a web address';
  end if;
  -- A credential in a link's query string (?access_token=…, &key=…).
  if t ~* '[?&][A-Za-z_]*(token|key|sig|code|secret|pass|auth)[A-Za-z_]*=[^&[:space:]]+' then
    return 'a key inside a web address';
  end if;

  -- "password: x", "api key = x", '"token": "x"'. The label is found
  -- case-insensitively, with letter-only boundaries so access_token counts.
  -- The VALUE decides: ordinary words pass ("Password: in 1Password",
  -- "Token: expires yearly", "PIN: unknown"), as does a variable NAME
  -- ("key: JAAS_PRIVATE_KEY", tested case-SENSITIVELY so "hunter2" is no name)
  -- and a file (".env.deploy"). A value of 4+ characters holding a digit or a
  -- symbol is refused.
  for m in select (regexp_matches(t,
      '(?:^|[^A-Za-z])(?:password|passwd|pwd|pw|pass|passcode|secret|api[ _-]?key|key|token|private[ _-]?key|pin)(?![A-Za-z])["'']?[[:space:]]*[:=][[:space:]]*["'']?([^[:space:]"'']+)',
      'gi'))[1] loop
    m := regexp_replace(m, '[.,;)]+$', '');
    if char_length(m) >= 4
       and m ~ '[^A-Za-z]'
       and m !~ '^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$'
       and m !~ '^\.' then
      return 'a password or key written after "password:" or "key ="';
    end if;
  end loop;

  -- Long key-shaped runs. (a) 20+ letters-and-digits with no break at all (hex
  -- keys, most API keys; also a 40-character commit id — rephrase those).
  -- (b) 24+ characters of key alphabet mixing lower, upper and digits (base64).
  -- (c) the same with '/' allowed, 30+ and no '-' or '.', for keys that carry a
  -- '/' (AWS). Paths like docs/28-vendor-accounts split on '-' and '.'. Exempt:
  -- UPPER_SNAKE variable names. UUIDs never match (a): their longest run is 12.
  for m in select (regexp_matches(t, '[A-Za-z0-9]{20,}', 'g'))[1] loop
    if m ~ '[0-9]' and m ~ '[A-Za-z]' then
      return 'something shaped like a key';
    end if;
  end loop;
  for m in select (regexp_matches(t, '[A-Za-z0-9+=_-]{24,}', 'g'))[1] loop
    if m ~ '[0-9]' and m ~ '[a-z]' and m ~ '[A-Z]'
       and m !~ '^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$' then
      return 'something shaped like a key';
    end if;
  end loop;
  for m in select (regexp_matches(t, '[A-Za-z0-9+/=]{30,}', 'g'))[1] loop
    if m ~ '[0-9]' and m ~ '[a-z]' and m ~ '[A-Z]' then
      return 'something shaped like a key';
    end if;
  end loop;

  -- Short password-shaped words: lower + upper + digit + a real symbol in ONE
  -- word of 8..64 characters. '-', '.' and '/' do not count as the symbol, so
  -- product names and paths pass (Pro-Plan2026, Ubuntu-24.04, S3-compatible).
  -- '@' counts unless the word is an email address. The symbol test runs on the
  -- RAW word, so a trailing ! or ? still counts (Summer2026!).
  foreach w in array regexp_split_to_array(t, '[[:space:]]+') loop
    -- Sentence punctuation and quotes around a word are not part of it.
    w := regexp_replace(w, '^[("'']+|[.,;:)"'']+$', '', 'g');
    if char_length(w) between 8 and 64
       and w ~ '[a-z]' and w ~ '[A-Z]' and w ~ '[0-9]'
       and (w ~ '[^A-Za-z0-9./@-]'
            or (w ~ '@' and w !~ '^[^@]+@[^@]+\.[A-Za-z]{2,}[.,;:)]*$')) then
      return 'something shaped like a password';
    end if;
  end loop;

  return null;
end;
$$;

-- The trigger: every string value in the new row, whatever its column. Keys named
-- id / *_id are uuids written by the server, not text the founder typed.
-- SECURITY DEFINER only so it may call vendor_secret_reason, whose EXECUTE is
-- revoked from every API role; a trigger function cannot be called directly, and
-- it reads nothing but NEW.
create or replace function public.vendor_reject_secret_text()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  kv record;
  why text;
begin
  for kv in select key, value from jsonb_each(to_jsonb(new)) loop
    continue when kv.key = 'id' or kv.key like '%\_id' escape '\';
    continue when jsonb_typeof(kv.value) <> 'string';
    why := public.vendor_secret_reason(kv.value #>> '{}');
    if why is not null then
      raise exception using
        errcode = 'check_violation',
        message = format('The %s field looks like %s. This page never stores passwords or keys: record only WHERE it is kept, by name.',
                         replace(kv.key, '_', ' '), why);
    end if;
  end loop;
  return new;
end;
$$;

revoke execute on function public.vendor_secret_reason(text) from public, anon, authenticated, service_role;
revoke execute on function public.vendor_reject_secret_text() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------
create table public.vendor_accounts (
  id uuid primary key default gen_random_uuid(),
  service text not null unique check (char_length(service) between 1 and 80),
  status text not null default 'active' check (status in ('active', 'planned', 'closed')),
  used_for text check (char_length(used_for) <= 500),
  -- docs/28 Part B's classification of losing it.
  if_lost text not null default 'unclassified'
    check (if_lost in ('platform_down', 'feature_down', 'invisible', 'unclassified')),
  breaks_if_lost text check (char_length(breaks_if_lost) <= 1000),
  -- Its evacuation plan in docs/28 Part B, e.g. 'B.3-1'.
  part_b_ref text check (part_b_ref is null or part_b_ref ~ '^B\.[0-9]+(-[0-9]+)?$'),
  -- A plain https address: no user:password@, no ?query, no #fragment.
  sign_in_url text check (
    sign_in_url is null
    or (char_length(sign_in_url) <= 300 and sign_in_url ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[^[:space:]?#@]*)?$')
  ),
  sign_in_method text not null default 'unknown'
    check (sign_in_method in ('email_password', 'google', 'github', 'other', 'unknown')),
  -- The vendor-side login that owns it (an email or user name) — not a platform account.
  owner_login text check (char_length(owner_login) <= 200),
  two_step text not null default 'unknown' check (two_step in ('on', 'off', 'unknown')),
  plan text check (char_length(plan) <= 100),
  monthly_cost_usd numeric(10, 2) check (monthly_cost_usd >= 0),
  paid_how text check (char_length(paid_how) <= 100),
  last_paid_on date,
  next_charge_on date,
  payment_status text not null default 'unknown' check (payment_status in ('ok', 'failing', 'free', 'unknown')),
  -- A recurring chore that is not a website visit (the monthly offsite snapshot
  -- copy, docs/28 B.8): "Done today" stamps last_done_on, and the dashboard flags
  -- it once more than check_every_days have passed. Such a row is judged on this,
  -- not on "last opened".
  check_every_days integer check (check_every_days between 1 and 366),
  last_done_on date,
  notes text check (char_length(notes) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Dates the founder must not miss: trial ends, key expiries, renewals. due_on NULL
-- means "this thing expires but nobody recorded when" (the SUPABASE_ACCESS_TOKEN
-- case) and is itself flagged. done_on closes the item (key rotated, renewed).
create table public.vendor_account_dates (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.vendor_accounts (id) on delete cascade,
  kind text not null check (kind in ('trial_end', 'key_expiry', 'renewal', 'other')),
  label text not null check (char_length(label) between 1 and 200),
  due_on date,
  done_on date,
  created_at timestamptz not null default now()
);
create index vendor_account_dates_account_idx on public.vendor_account_dates (account_id);

-- WHERE a credential lives, by NAME. There is deliberately no value column.
create table public.vendor_account_credentials (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.vendor_accounts (id) on delete cascade,
  store text not null check (store in (
    'env_deploy', 'env_accounts', 'env_local', 'github_secret', 'vercel_env', 'password_manager', 'vendor_dashboard'
  )),
  -- UPPER_SNAKE, at most 64 characters, no unbroken run longer than 14 (a key
  -- typed in capitals would be one long run).
  name text check (
    name is null
    or (char_length(name) <= 64
        and name ~ '^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$'
        and name !~ '[A-Z0-9]{15,}')
  ),
  -- A file or a secret store has many entries; say which one.
  check (name is not null or store in ('password_manager', 'vendor_dashboard')),
  unique (account_id, store, name),
  created_at timestamptz not null default now()
);
create index vendor_account_credentials_account_idx on public.vendor_account_credentials (account_id);

-- One row per click on "Open". Append-only by grants.
create table public.vendor_account_opens (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.vendor_accounts (id) on delete cascade,
  opened_by uuid default auth.uid() references auth.users (id) on delete set null,
  opened_at timestamptz not null default now()
);
create index vendor_account_opens_account_idx on public.vendor_account_opens (account_id, opened_at desc);

create trigger vendor_accounts_no_secrets before insert or update on public.vendor_accounts
  for each row execute function public.vendor_reject_secret_text();
create trigger vendor_account_dates_no_secrets before insert or update on public.vendor_account_dates
  for each row execute function public.vendor_reject_secret_text();
create trigger vendor_account_credentials_no_secrets before insert or update on public.vendor_account_credentials
  for each row execute function public.vendor_reject_secret_text();

-- Revoke before grant (docs/03 #27): prod's default privileges grant every API role
-- full rights on a new public table.
revoke all privileges on public.vendor_accounts from public, anon, authenticated, service_role;
revoke all privileges on public.vendor_account_dates from public, anon, authenticated, service_role;
revoke all privileges on public.vendor_account_credentials from public, anon, authenticated, service_role;
revoke all privileges on public.vendor_account_opens from public, anon, authenticated, service_role;
grant select, insert, update on public.vendor_accounts to authenticated;
grant select, insert, update, delete on public.vendor_account_dates to authenticated;
grant select, insert, update, delete on public.vendor_account_credentials to authenticated;
grant select on public.vendor_account_opens to authenticated;
grant insert (account_id) on public.vendor_account_opens to authenticated;

alter table public.vendor_accounts enable row level security;
alter table public.vendor_account_dates enable row level security;
alter table public.vendor_account_credentials enable row level security;
alter table public.vendor_account_opens enable row level security;

create policy vendor_accounts_superadmin on public.vendor_accounts
  for all to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());
create policy vendor_account_dates_superadmin on public.vendor_account_dates
  for all to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());
create policy vendor_account_credentials_superadmin on public.vendor_account_credentials
  for all to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());
-- SELECT and INSERT only; the grants above already deny UPDATE/DELETE.
create policy vendor_account_opens_select on public.vendor_account_opens
  for select to authenticated
  using (public.is_superadmin());
create policy vendor_account_opens_insert on public.vendor_account_opens
  for insert to authenticated
  with check (public.is_superadmin() and opened_by = auth.uid());

-- ---------------------------------------------------------------------------
-- 3. Seed (docs/14 + docs/28 Part B, 2026-11-09). No secrets — names only.
-- ---------------------------------------------------------------------------
insert into public.vendor_accounts (service, status, used_for, if_lost, breaks_if_lost, part_b_ref, sign_in_url, sign_in_method, owner_login, payment_status, notes) values
  ('Supabase', 'active', 'Production database, user sign-in and file storage (project solutions-platform-prod). Also sends sign-up, password and sign-in-link emails today.',
   'platform_down', 'Everything: nobody can sign in or use anything. The database can be restored from our backups, but uploaded files have NO backup (the dump holds their rows, not the files), and dashboard settings (sign-up hook, redirect addresses, email setup and templates) are not in the repo (docs/28 R3, R4).',
   'B.3-1', 'https://supabase.com/dashboard/sign-in', 'github', 'jasonartis', 'free',
   'Signs in with the platform''s GitHub account (founder, 2026-11-09), so losing GitHub also locks you out of Supabase. File storage: docs/28 B.3-2.'),
  ('Vercel', 'active', 'Runs the website at solutions-platform.vercel.app; deploys every green push to master.',
   'platform_down', 'The site goes down, and its address goes with it: we own no domain (docs/28 R1).',
   'B.3-3', 'https://vercel.com/login', 'google', null, 'free',
   'Signs in with Google, using a DIFFERENT Google account from the superadmin one (founder, 2026-11-09); see the row "Google account (Vercel sign-in)".'),
  ('GitHub', 'active', 'Source code, CI tests, deploys, deploy secrets and the nightly backup job (repo jasonartis/Solutions, public).',
   'invisible', 'Users notice nothing, but no fix can be tested or shipped, and the nightly backup stops. The code also lives on the founder''s PC.',
   'B.3-6', 'https://github.com/login', 'email_password', 'jasonartis', 'free', null),
  ('Google account', 'active', 'The platform email identity and the superadmin login. NOT the sign-in for Supabase (GitHub) or Vercel (a different Google account).',
   'invisible', 'Users keep working, but the founder loses the superadmin login to the platform. Whether it also opens GitHub is not recorded.',
   'B.3-7', 'https://accounts.google.com', 'email_password', 'jasonartisenergy@gmail.com', 'free', null),
  ('Google account (Vercel sign-in)', 'active', 'Signs into Vercel. A different Google account from the superadmin one (founder, 2026-11-09).',
   'invisible', 'The site keeps running, but the founder is locked out of Vercel: no settings change, domain move or rescue until access is recovered.',
   'B.3-7', 'https://accounts.google.com', 'email_password', null, 'free',
   'Which Google account this is has not been recorded yet: fill in "Owned by".'),
  ('JaaS (8x8)', 'active', 'Speed-dating video calls.',
   'feature_down', 'Speed-dating video stops. There is no self-hosted Jitsi server yet: the fallback is a build script, not a setting.',
   'B.3-5', 'https://jaas.8x8.vc', 'unknown', null, 'unknown', null),
  ('Backblaze B2', 'active', 'Off-site encrypted backups of the production database (created 2026-11-08, docs/12).',
   'invisible', 'Backups stop. Must never be lost together with the database, which is why it is a different company.',
   null, 'https://secure.backblaze.com/user_signin.htm', 'unknown', null, 'unknown',
   'The backups cannot be read without the offline private key. It is kept in a cloud document (which account is not recorded) and a paper copy at home is decided (docs/28 B.7 Q6, founder 2026-11-09). The same key opens the offsite snapshots (B.8).'),
  ('Sentry', 'active', 'Error reports from the web app.',
   'invisible', 'Errors stop being reported; users notice nothing.',
   null, 'https://sentry.io/auth/login/', 'unknown', null, 'free', null),
  ('UptimeRobot', 'active', 'Uptime checks on the live site; keeps the free database from pausing.',
   'invisible', 'No down alerts, and the free-tier database pauses after a week with no traffic.',
   null, 'https://dashboard.uptimerobot.com/login', 'email_password', null, 'free', null),
  ('myzmanim', 'active', 'Prayer times (zmanim) per synagogue address.',
   'feature_down', 'New zmanim stop; production serves from its cache until the cache runs out (docs/23).',
   null, 'https://myzmanim.com', 'email_password', null, 'unknown', null),
  ('Domain registrar', 'planned', 'A web address we own (docs/28 R1), at a different company from the host.', 'unclassified', null, null, null, 'unknown', null, 'unknown', null),
  ('Mail provider (Resend)', 'planned', 'Main sender for sign-up, password-reset and sign-in-link emails from our own domain (docs/28 R4).',
   'platform_down', 'Sign-in by emailed link stops, as do sign-up and password reset.', 'B.3-4', null, 'unknown', null, 'unknown', null),
  ('Mail standby (Amazon SES)', 'planned', 'Second mail provider, ready to take over from the main one (docs/28 R4).',
   'unclassified', null, 'B.3-4', null, 'unknown', null, 'unknown', null),
  ('Password manager', 'planned', 'Holds the founder''s passwords and recovery codes.', 'unclassified', null, null, null, 'unknown', null, 'unknown', null),
  ('Second git host (mirror)', 'planned', 'A copy of the code at a second company.', 'unclassified', null, 'B.3-6', null, 'unknown', null, 'unknown', null),
  ('VPS for the worker', 'planned', 'Runs the background worker all the time (today: the founder''s PC).', 'unclassified', null, null, null, 'unknown', null, 'unknown', null),
  ('AI provider', 'planned', 'The résumé builder.', 'unclassified', null, null, null, 'unknown', null, 'unknown', null);

-- The monthly offsite-snapshot reminder (docs/28 B.8, founder 2026-11-09). Planned
-- until the snapshot script exists; switch it to active then and the 30-day badge
-- starts.
insert into public.vendor_accounts (service, status, used_for, if_lost, breaks_if_lost, part_b_ref, sign_in_method, payment_status, check_every_days, notes) values
  ('Offsite snapshots (USB stick at home + cloud drive)', 'planned',
   'Monthly: copy the newest platform and credentials snapshot pair to the USB stick at home and to the cloud drive, keeping 3 pairs in each.',
   'invisible', 'If the laptop or its SSD is lost, unpushed work, the credential files and local dumps exist nowhere else.',
   'B.8', 'other', 'free', 30,
   'Press "Done today" after copying. Switch this to active once pnpm backup:snapshot is built.');

insert into public.vendor_account_credentials (account_id, store, name)
select a.id, c.store, c.name
from (values
  ('Supabase', 'env_accounts', 'SUPABASE_LOGIN_EMAIL'),
  ('Supabase', 'env_accounts', 'SUPABASE_PASSWORD'),
  ('Supabase', 'env_deploy', 'SUPABASE_ACCESS_TOKEN'),
  ('Supabase', 'env_deploy', 'SUPABASE_DB_PASSWORD'),
  ('Supabase', 'env_deploy', 'SUPABASE_SERVICE_ROLE_KEY'),
  ('Supabase', 'github_secret', 'PROD_SUPABASE_DB_PASSWORD'),
  ('Vercel', 'env_accounts', 'VERCEL_LOGIN_EMAIL'),
  ('Vercel', 'env_accounts', 'VERCEL_PASSWORD'),
  ('Vercel', 'env_deploy', 'VERCEL_TOKEN'),
  ('Vercel', 'github_secret', 'VERCEL_TOKEN'),
  ('GitHub', 'env_accounts', 'GITHUB_USERNAME'),
  ('GitHub', 'env_accounts', 'GITHUB_PASSWORD'),
  ('GitHub', 'env_accounts', 'GITHUB_PAT'),
  ('Google account', 'env_accounts', 'GOOGLE_ACCOUNT_EMAIL'),
  ('Google account', 'env_accounts', 'GOOGLE_ACCOUNT_PASSWORD'),
  ('JaaS (8x8)', 'env_deploy', 'JAAS_APP_ID'),
  ('JaaS (8x8)', 'env_deploy', 'JAAS_API_KEY_ID'),
  ('JaaS (8x8)', 'env_deploy', 'JAAS_PRIVATE_KEY'),
  ('Backblaze B2', 'github_secret', 'BACKBLAZE_KEY_ID'),
  ('Backblaze B2', 'github_secret', 'BACKBLAZE_APP_KEY'),
  ('Backblaze B2', 'env_deploy', 'BACKBLAZE_READ_KEY_ID'),
  ('Backblaze B2', 'env_deploy', 'BACKBLAZE_READ_APP_KEY'),
  ('Sentry', 'env_deploy', 'NEXT_PUBLIC_SENTRY_DSN'),
  ('UptimeRobot', 'env_accounts', 'UPTIMEROBOT_LOGIN_EMAIL'),
  ('UptimeRobot', 'env_accounts', 'UPTIMEROBOT_PASSWORD'),
  ('myzmanim', 'env_accounts', 'MYZMANIM_LOGIN_EMAIL'),
  ('myzmanim', 'env_accounts', 'MYZMANIM_PASSWORD'),
  ('myzmanim', 'env_deploy', 'MYZMANIM_USER'),
  ('myzmanim', 'env_deploy', 'MYZMANIM_KEY')
) as c(service, store, name)
join public.vendor_accounts a on a.service = c.service;

insert into public.vendor_account_dates (account_id, kind, label, due_on)
select a.id, d.kind, d.label, d.due_on::date
from (values
  ('myzmanim', 'trial_end', 'API key trial ended — check what production is serving (docs/23)', '2026-10-24'),
  ('Supabase', 'key_expiry', 'SUPABASE_ACCESS_TOKEN expiry — never recorded', null),
  ('Vercel', 'key_expiry', 'VERCEL_TOKEN expiry — never recorded', null),
  ('JaaS (8x8)', 'key_expiry', 'JaaS key expiry or renewal — never recorded', null)
) as d(service, kind, label, due_on)
join public.vendor_accounts a on a.service = d.service;

-- ---------------------------------------------------------------------------
-- 4. Catalog-only assertions (safe on an empty database), plus the filter's
--    own behaviour, which is pure and needs no rows.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['vendor_accounts', 'vendor_account_dates', 'vendor_account_credentials', 'vendor_account_opens'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception '% must have RLS enabled', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select')
       or has_table_privilege('anon', 'public.' || t, 'insert')
       or has_table_privilege('service_role', 'public.' || t, 'select') then
      raise exception 'anon or service_role holds a privilege on %', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'truncate') then
      raise exception 'authenticated holds the empty-the-table privilege on %', t;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.vendor_account_opens', 'update')
     or has_table_privilege('authenticated', 'public.vendor_account_opens', 'delete')
     or has_table_privilege('authenticated', 'public.vendor_accounts', 'delete')
     or has_column_privilege('authenticated', 'public.vendor_account_opens', 'opened_by', 'insert')
     or has_column_privilege('authenticated', 'public.vendor_account_opens', 'opened_at', 'insert') then
    raise exception 'vendor_account_opens must be append-only with server-set who/when, and accounts are never deleted';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename like 'vendor\_account%' escape '\') <> 5 then
    raise exception 'vendor tables must carry exactly five policies';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename like 'vendor\_account%' escape '\'
             and (coalesce(qual, '') !~ 'is_superadmin' and coalesce(with_check, '') !~ 'is_superadmin')) then
    raise exception 'every vendor policy must gate on is_superadmin()';
  end if;

  -- The filter: things it must refuse, and ordinary text it must let through.
  if public.vendor_secret_reason('-----BEGIN PRIVATE KEY-----') is null
     or public.vendor_secret_reason('token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9') is null
     or public.vendor_secret_reason('ghp_' || repeat('a1', 15)) is null
     or public.vendor_secret_reason('https://bob:hunter2@example.com') is null
     or public.vendor_secret_reason('password: hunter2') is null
     or public.vendor_secret_reason('api key = abc123') is null
     or public.vendor_secret_reason('k ' || md5('x')) is null
     or public.vendor_secret_reason('q3J8Zk+vB1xW9pL2mN7rT4yH6sD0fG5aC8eK1uI=') is null
     or public.vendor_secret_reason('Tr0ub4dor&3') is null
     -- The 2026-11-09 review's bypasses, each now refused.
     or public.vendor_secret_reason('Summer2026!') is null
     or public.vendor_secret_reason('P@ssw0rd1') is null
     or public.vendor_secret_reason('{"password": "hunter2xyz"}') is null
     or public.vendor_secret_reason('pw: abc123') is null
     or public.vendor_secret_reason('see https://x.example/a?access_token=abc123') is null
     or public.vendor_secret_reason('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY') is null then
    raise exception 'vendor_secret_reason lets a secret through';
  end if;
  if public.vendor_secret_reason('Kept in .env.deploy as JAAS_PRIVATE_KEY; rotate yearly.') is not null
     or public.vendor_secret_reason('key: JAAS_PRIVATE_KEY') is not null
     or public.vendor_secret_reason('Owner jasonartisenergy@gmail.com, see docs/28-vendor-accounts-and-evacuation-plans.md') is not null
     or public.vendor_secret_reason('shipping: free') is not null
     or public.vendor_secret_reason('NEXT_PUBLIC_SUPABASE_ANON_KEY and B2_APP_KEY') is not null
     or public.vendor_secret_reason('Renews 2026-12-01, $15/yr, card on file.') is not null
     or public.vendor_secret_reason(gen_random_uuid()::text) is not null
     -- The review's false positives, each now let through.
     or public.vendor_secret_reason('Password: in 1Password') is not null
     or public.vendor_secret_reason('Token: expires yearly. PIN: unknown. secret: none') is not null
     or public.vendor_secret_reason('API key: see .env.deploy') is not null
     or public.vendor_secret_reason('S3-compatible storage on the Pro-Plan2026 tier, Ubuntu-24.04, Visa-4242.') is not null
     or public.vendor_secret_reason('Contact Yarmish1@Example.com (billing).') is not null then
    raise exception 'vendor_secret_reason refuses ordinary text';
  end if;
end $$;
