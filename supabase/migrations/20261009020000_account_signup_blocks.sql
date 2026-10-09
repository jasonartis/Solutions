-- =============================================================================
-- A removed person cannot sign up again with the same address — and the right
-- people can lift that, with the information and warnings to decide well.
-- Founder decision 2026-10-09. docs/21 §7.12.
--
-- THE GAP. A removal (20261008020000) bans sign-in at once, but day 30's
-- silhouette NULLs auth.users.email, freeing the address: the removed person
-- could sign up afresh on day 31.
--
-- DESIGN, after two adversarial design reviews (security; product/process) and
-- prior art (Supabase's Before User Created hook; hashed suppression lists,
-- GDPR Art. 17(3) / legitimate interest; Discord/Reddit/GitHub appeals):
--
--  1. account_signup_blocks — one row per removal, keyed by a FINGERPRINT of
--     the address (sha256 of a normalized form), never the address itself.
--     Never deleted: a lift is a state change, so the history survives
--     (re-removal after a lift is a NEW row, and the screen shows the old one).
--     RLS on, no policy, every grant revoked: only definers below touch it.
--  2. A removal now REQUIRES a category and a short factual note (10–500
--     chars). The unblocker needs something to judge by; the cap and the form's
--     guidance keep it from becoming a dossier about a deleted person.
--  3. ENFORCEMENT is a BEFORE INSERT OR UPDATE OF email, email_change trigger
--     on auth.users. The email-CHANGE path was the review's main finding: sign
--     up with any address, then change it to the blocked one through GoTrue's
--     API — a creation-only hook never sees that. The trigger needs no
--     dashboard setting, so it is live wherever the migration is.
--     CRITICALITY (docs/03 "Triggers on auth.users"): it RAISES only for a
--     real block. Any other error inside the check fails OPEN (signup proceeds)
--     — a defect in an abuse feature must not take down every signup on the
--     platform — and lock waits are bounded (lock_timeout 50ms).
--  4. The Before User Created HOOK (auth_before_user_created) only shapes the
--     MESSAGE: a blocked signup gets exactly what an already-registered
--     address gets (422 "User already registered"), so typing someone else's
--     address does not reveal that they were removed. Enabled in
--     supabase/config.toml locally; on PROD it is a dashboard switch
--     (Authentication → Hooks). Until it is on, the trigger still refuses —
--     with GoTrue's generic "Database error saving new user".
--  5. Lifting: superadmin only, with a required reason. Refused while the
--     removal is still in its grace period (the old account still holds the
--     address, so a lift would change nothing — "Undo removal" is the action
--     then). Undo removal lifts that removal's OWN block automatically.
--  6. Typing an address to look a block up is itself an oracle, so the lookup
--     function writes its own log row in the same call (cannot be skipped).
--  7. Existing pending removals are BACKFILLED (while their address still
--     exists), so nobody removed since 20261008020000 slips through.
--
-- RECORDED LIMITS (docs/21 §7.12): another address gets them in (inherent);
-- the fingerprint is unpeppered — a leaked backup lets someone test a guessed
-- address — and outlives the deletion, which /privacy must disclose;
-- non-ASCII/IDN addresses are not canonicalized; a second superadmin's
-- two-person rule waits for a second superadmin (docs/12 item 9's trigger).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The fingerprint. ONE definition for removal, hook, trigger and lookup
--    (docs/03 #31: two copies drift).
--    lower + trim; trailing dot on the domain dropped; googlemail.com ->
--    gmail.com; "+tag" dropped for EVERY domain (Gmail, Outlook, iCloud,
--    Fastmail, Proton… all deliver it to the same inbox; a false positive can
--    only hit the blocked person's own tags); dots dropped in a Gmail local part.
-- ---------------------------------------------------------------------------
create function public.account_email_fingerprint(addr text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  a text := lower(btrim(coalesce(addr, '')));
  local text;
  domain text;
begin
  if a = '' or position('@' in a) = 0 then
    return null;
  end if;
  local := split_part(a, '@', 1);
  domain := rtrim(substr(a, length(local) + 2), '.');
  if domain = 'googlemail.com' then
    domain := 'gmail.com';
  end if;
  local := split_part(local, '+', 1);
  if domain = 'gmail.com' then
    local := replace(local, '.', '');
  end if;
  return encode(sha256(convert_to(local || '@' || domain, 'UTF8')), 'hex');
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The table, and the lookup log.
-- ---------------------------------------------------------------------------
create table public.account_signup_blocks (
  id                uuid primary key default gen_random_uuid(),
  email_fingerprint text not null,
  user_id           uuid references auth.users (id) on delete set null,
  category          text not null check (category in
                      ('spam_or_fraud', 'abuse_or_harassment', 'org_request', 'legal', 'other')),
  note              text not null check (char_length(btrim(note)) between 10 and 500),
  created_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  lifted_at         timestamptz,
  lifted_by         uuid references auth.users (id) on delete set null,
  lift_reason       text,
  constraint account_signup_blocks_lift_shape check (
    (lifted_at is null and lifted_by is null and lift_reason is null)
 or (lifted_at is not null and lift_reason is not null and char_length(btrim(lift_reason)) between 10 and 500)
  )
);
comment on table public.account_signup_blocks is
  'Re-signup blocks for accounts removed from the platform (docs/21 §7.12). Fingerprint only, never the address. No API-role access; definers only.';
create index account_signup_blocks_active on public.account_signup_blocks (email_fingerprint) where lifted_at is null;
alter table public.account_signup_blocks enable row level security;
revoke all privileges on public.account_signup_blocks from public, anon, authenticated, service_role;

create table public.account_signup_block_lookups (
  id         uuid primary key default gen_random_uuid(),
  actor      uuid references auth.users (id) on delete set null,
  matched    integer not null,
  created_at timestamptz not null default now()
);
comment on table public.account_signup_block_lookups is
  'Every superadmin lookup of a signup block by typed address — written inside the lookup itself, so it cannot be skipped.';
alter table public.account_signup_block_lookups enable row level security;
revoke all privileges on public.account_signup_block_lookups from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Enforcement: the auth.users trigger.
-- ---------------------------------------------------------------------------
create function public.account_signup_block_guard()
returns trigger
language plpgsql
security definer
set search_path = public
set lock_timeout = '50ms'
as $$
declare
  v_blocked boolean := false;
begin
  -- Only when an address is being SET or CHANGED. GoTrue may rewrite unchanged
  -- columns; checking only real changes keeps sign-in off this path.
  if tg_op = 'UPDATE'
     and new.email is not distinct from old.email
     and new.email_change is not distinct from old.email_change then
    return new;
  end if;
  begin
    -- Check only the address(es) being SET: on an UPDATE, an unchanged
    -- current email is not re-judged (code review: re-checking it could stop an
    -- innocent account from changing its address).
    select exists (
      select 1 from public.account_signup_blocks b
      where b.lifted_at is null
        and b.email_fingerprint in (
              case when tg_op = 'INSERT' or new.email is distinct from old.email
                   then public.account_email_fingerprint(new.email) end,
              case when tg_op = 'INSERT' or new.email_change is distinct from old.email_change
                   then public.account_email_fingerprint(nullif(new.email_change, '')) end)
        -- The removed account itself still holds its address until day 30.
        and b.user_id is distinct from new.id
    ) into v_blocked;
  exception when others then
    v_blocked := false;   -- fail OPEN: see the header's CRITICALITY note
  end;
  if v_blocked then
    -- GoTrue's own wording for an address that is already taken, so the
    -- email-change path is not a 'was this person removed?' oracle either.
    -- (The response's error CODE still differs from GoTrue's — recorded in
    -- docs/21 §7.12: identical in the UI, distinguishable through the raw API.)
    raise exception 'A user with this email address has already been registered'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.account_signup_block_guard() from public, anon, authenticated, service_role;

create trigger account_signup_block_guard
  before insert or update of email, email_change on auth.users
  for each row execute function public.account_signup_block_guard();

-- ---------------------------------------------------------------------------
-- 4. The hook — the friendly, non-revealing message. Same shape as Supabase's
--    documented example; returns {} to allow.
-- ---------------------------------------------------------------------------
create function public.auth_before_user_created(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
set lock_timeout = '50ms'
as $$
declare
  v_fp text;
begin
  begin
    v_fp := public.account_email_fingerprint(event -> 'user' ->> 'email');
    if v_fp is not null and exists (
      select 1 from public.account_signup_blocks b
      where b.lifted_at is null and b.email_fingerprint = v_fp
    ) then
      -- Identical to an already-registered address: no "was removed" oracle.
      return jsonb_build_object('error', jsonb_build_object('http_code', 422, 'message', 'User already registered'));
    end if;
  exception when others then
    return '{}'::jsonb;   -- fail open; the trigger is the real gate
  end;
  return '{}'::jsonb;
end;
$$;
revoke all on function public.auth_before_user_created(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.auth_before_user_created(jsonb) to supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- 5. Removal now requires a category and note, and creates the block.
--    The one-argument version from 20261008020000 is DROPPED, not overloaded:
--    a removal without a reason must not remain callable.
-- ---------------------------------------------------------------------------
drop function public.account_remove_from_platform(text);

create function public.account_remove_from_platform(target_email text, category text, note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target uuid;
  v_count integer;
  v_email text;
  v_blockers jsonb;
  v_prior integer;
  v_due timestamptz := now() + interval '30 days';
begin
  if not public.is_superadmin() then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;
  if category is null or category not in ('spam_or_fraud', 'abuse_or_harassment', 'org_request', 'legal', 'other') then
    return jsonb_build_object('ok', false, 'reason', 'bad_category');
  end if;
  if char_length(btrim(coalesce(note, ''))) not between 10 and 500 then
    return jsonb_build_object('ok', false, 'reason', 'bad_note');
  end if;
  -- Count rather than trust a scalar: auth.users' address uniqueness is PARTIAL.
  select count(*), min(u.id::text)::uuid into v_count, v_target
  from auth.users u
  where lower(u.email) = lower(btrim(coalesce(target_email, '')));
  if v_count = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_such_user');
  elsif v_count > 1 then
    return jsonb_build_object('ok', false, 'reason', 'ambiguous_email');
  end if;
  if exists (select 1 from public.account_deletions where user_id = v_target and state = 'deleted') then
    return jsonb_build_object('ok', false, 'reason', 'already_deleted');
  end if;
  if exists (select 1 from public.user_private p where p.user_id = v_target and p.is_superadmin) then
    return jsonb_build_object('ok', false, 'reason', 'blocked', 'blockers', jsonb_build_array('superadmin'));
  end if;

  v_blockers := public.account_deletion_blockers(v_target);
  select u.email into v_email from auth.users u where u.id = v_target;
  -- History the console shows: how many times this address was blocked before.
  select count(*) into v_prior from public.account_signup_blocks
   where email_fingerprint = public.account_email_fingerprint(v_email);

  insert into public.account_deletions as d (user_id, state, initiated_via, requested_by, requested_at, due_at)
  values (v_target, 'departed', 'removal', auth.uid(), now(), v_due)
  on conflict (user_id) do update
    set state = 'departed',
        initiated_via = 'removal',
        requested_by = excluded.requested_by,
        requested_at = excluded.requested_at,
        due_at = excluded.due_at,
        cancelled_at = null,
        cancel_reason = null,
        last_error = null,
        last_attempt_at = null
    where d.state <> 'deleted';

  -- A repeat removal while one is already pending does not stack blocks.
  if not exists (select 1 from public.account_signup_blocks
                 where user_id = v_target and lifted_at is null) then
    insert into public.account_signup_blocks (email_fingerprint, user_id, category, note, created_by)
    values (public.account_email_fingerprint(v_email), v_target, category, btrim(note), auth.uid());
  end if;

  update auth.users set banned_until = now() + interval '100 years' where id = v_target;
  delete from auth.sessions where user_id = v_target;
  -- A refresh token with no session (an older GoTrue's rows) survives the
  -- session delete, and an unused magic link / OTP is still redeemable.
  delete from auth.refresh_tokens where user_id = v_target::text;
  delete from auth.one_time_tokens where user_id = v_target;

  return jsonb_build_object('ok', true, 'due_at', v_due, 'warnings', v_blockers, 'prior_blocks', v_prior);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Undo removal lifts that removal's OWN block (by user_id, never by
--    fingerprint — another removal of the same address is not this one).
--    Restated from 20261008020000; the block lift is the only change.
-- ---------------------------------------------------------------------------
create or replace function public.account_cancel_deletion(target uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_via text;
begin
  if not public.is_superadmin() then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;
  update public.account_deletions
     set state = 'cancelled', cancelled_at = now(), cancel_reason = 'superadmin'
   where user_id = target and state = 'departed'
  returning initiated_via into v_via;
  if v_via is null then
    return jsonb_build_object('ok', false, 'reason', 'not_pending');
  end if;
  -- The ban was this removal's; nothing else on the platform sets banned_until
  -- on a live account (the silhouette sets it only on day 30, and a row that
  -- reached day 30 is 'deleted', not 'departed').
  if v_via = 'removal' then
    update auth.users set banned_until = null where id = target;
    -- (20261009020000) and its re-signup block.
    update public.account_signup_blocks
       set lifted_at = now(), lifted_by = auth.uid(),
           lift_reason = 'Removal undone before the account was deleted.'
     where user_id = target and lifted_at is null;
  end if;
  return jsonb_build_object('ok', true, 'lifted_ban', v_via = 'removal');
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Lift — superadmin, required reason, refused during the grace period.
-- ---------------------------------------------------------------------------
create function public.account_lift_signup_block(block_id uuid, lift_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid;
  v_n integer;
begin
  if not public.is_superadmin() then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;
  if char_length(btrim(coalesce(lift_reason, ''))) not between 10 and 500 then
    return jsonb_build_object('ok', false, 'reason', 'bad_reason');
  end if;
  select b.user_id into v_user from public.account_signup_blocks b where b.id = block_id and b.lifted_at is null;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_active');
  end if;
  -- During the grace period the old account still holds the address, so a
  -- lift would change nothing; "Undo removal" is the right action then.
  if exists (select 1 from public.account_deletions d
             where d.user_id = v_user and d.state = 'departed' and d.initiated_via = 'removal') then
    return jsonb_build_object('ok', false, 'reason', 'still_pending');
  end if;
  update public.account_signup_blocks
     set lifted_at = now(), lifted_by = auth.uid(), lift_reason = btrim(account_lift_signup_block.lift_reason)
   where id = block_id and lifted_at is null;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', v_n > 0);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Superadmin reads. Neither returns the fingerprint or any address.
--    `times_blocked` = how many blocks (lifted or not) share this fingerprint:
--    a repeat removal shows as 2, 3…
-- ---------------------------------------------------------------------------
create function public.account_signup_blocks_list()
returns table (
  id uuid, user_id uuid, category text, note text, created_by uuid, created_at timestamptz,
  lifted_at timestamptz, lifted_by uuid, lift_reason text, account_state text, times_blocked integer
)
language sql
stable
security definer
set search_path = public
as $$
  select b.id, b.user_id, b.category, b.note, b.created_by, b.created_at,
         b.lifted_at, b.lifted_by, b.lift_reason,
         (select d.state from public.account_deletions d where d.user_id = b.user_id),
         (select count(*)::int from public.account_signup_blocks o where o.email_fingerprint = b.email_fingerprint)
  from public.account_signup_blocks b
  where public.is_superadmin()
  order by b.lifted_at is not null, b.created_at desc;
$$;

create function public.account_signup_block_lookup(target_email text)
returns setof uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
begin
  if not public.is_superadmin() then
    return;
  end if;
  select coalesce(array_agg(b.id order by b.created_at desc), '{}') into v_ids
  from public.account_signup_blocks b
  where b.email_fingerprint = public.account_email_fingerprint(target_email);
  insert into public.account_signup_block_lookups (actor, matched) values (auth.uid(), coalesce(array_length(v_ids, 1), 0));
  return query select unnest(v_ids);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Backfill: anyone removed since 20261008020000 gets a block while their
--    address still exists.
-- ---------------------------------------------------------------------------
insert into public.account_signup_blocks (email_fingerprint, user_id, category, note, created_by, created_at)
select public.account_email_fingerprint(u.email), d.user_id, 'other',
       'Removed before reasons were recorded (backfilled by 20261009020000).', d.requested_by, d.requested_at
from public.account_deletions d
join auth.users u on u.id = d.user_id
where d.state = 'departed' and d.initiated_via = 'removal' and u.email is not null
  and not exists (select 1 from public.account_signup_blocks b where b.user_id = d.user_id and b.lifted_at is null);

-- ---------------------------------------------------------------------------
-- 10. ACLs (docs/03 #1, #27: revoke from every role first, then grant).
-- ---------------------------------------------------------------------------
revoke all on function public.account_email_fingerprint(text) from public, anon, authenticated, service_role;
revoke all on function public.account_remove_from_platform(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.account_cancel_deletion(uuid) from public, anon, authenticated, service_role;
revoke all on function public.account_lift_signup_block(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.account_signup_blocks_list() from public, anon, authenticated, service_role;
revoke all on function public.account_signup_block_lookup(text) from public, anon, authenticated, service_role;
grant execute on function public.account_remove_from_platform(text, text, text) to authenticated;
grant execute on function public.account_cancel_deletion(uuid) to authenticated;
grant execute on function public.account_lift_signup_block(uuid, text) to authenticated;
grant execute on function public.account_signup_blocks_list() to authenticated;
grant execute on function public.account_signup_block_lookup(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 11. Apply-time assertions — catalog only, so they pass on an EMPTY database.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_trigger where tgrelid = 'auth.users'::regclass
                 and tgname = 'account_signup_block_guard' and tgenabled <> 'D') then
    raise exception 'assert: the signup block trigger is not bound and enabled on auth.users';
  end if;
  if has_table_privilege('authenticated', 'public.account_signup_blocks', 'select')
     or has_table_privilege('anon', 'public.account_signup_blocks', 'select')
     or has_table_privilege('service_role', 'public.account_signup_blocks', 'select') then
    raise exception 'assert: an API role can read account_signup_blocks';
  end if;
  if has_function_privilege('authenticated', 'public.auth_before_user_created(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.auth_before_user_created(jsonb)', 'execute')
     or not has_function_privilege('supabase_auth_admin', 'public.auth_before_user_created(jsonb)', 'execute') then
    raise exception 'assert: the signup hook ACL is wrong (an oracle, or GoTrue cannot call it)';
  end if;
  if has_function_privilege('authenticated', 'public.account_email_fingerprint(text)', 'execute') then
    raise exception 'assert: authenticated can compute fingerprints';
  end if;
  if to_regprocedure('public.account_remove_from_platform(text)') is not null then
    raise exception 'assert: the reason-less removal is still callable';
  end if;
  -- Fingerprint sanity, on literals (no data needed).
  if public.account_email_fingerprint('J.Doe+x@GoogleMail.com.') <> public.account_email_fingerprint('jdoe@gmail.com')
     or public.account_email_fingerprint('a+b@outlook.com') <> public.account_email_fingerprint('A@Outlook.com')
     or public.account_email_fingerprint('a.b@outlook.com') = public.account_email_fingerprint('ab@outlook.com') then
    raise exception 'assert: the fingerprint normalization is wrong';
  end if;
end $$;
