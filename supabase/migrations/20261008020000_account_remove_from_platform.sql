-- =============================================================================
-- "Remove from platform" — a superadmin can take someone off the platform
-- against their wishes. Founder decision 2026-10-08: "Super admins can't lack
-- that power to remove someone from the very start."
--
-- THE GAP. 20261007090000 gave the superadmin ONE action, built for a person
-- who ASKED by email to be deleted: it signs them out and starts the 30-day
-- grace, and SIGNING BACK IN CANCELS IT. So used against a harasser it did
-- nothing: he signs in the next day and is back, with nothing in his way.
--
-- WHAT A REMOVAL IS. Same row in account_deletions, initiated_via = 'removal':
--   * SIGN-IN IS BLOCKED IMMEDIATELY (auth.users.banned_until, the field the
--     day-30 silhouette already sets) and every session is deleted. An access
--     token already issued stays valid for its hour — a JWT cannot be revoked;
--     the self-serve path accepts the same thing.
--   * SIGNING IN CANNOT CANCEL IT. The ban stops new sign-ins, AND all three
--     places that derive "signed in since the request = cancelled" now opt a
--     removal out explicitly, so a stale or manually-lifted last_sign_in_at
--     cannot cancel one either: account_pending_departure,
--     account_deletion_resume, account_complete_due_deletions.
--   * ONLY A SUPERADMIN UNDOES IT (account_cancel_deletion), and undoing a
--     removal also lifts the ban.
--   * Day 30 runs the ordinary silhouette (account_complete_due_deletions).
--   * NOT REFUSED for the sole-admin / sole-Director blockers. Those exist to
--     stop someone ORPHANING an org by leaving; a removal is the platform
--     acting, and the urgent part (the ban) must not wait on org housekeeping.
--     The blockers are returned as a WARNING; if still true on day 30 the
--     silhouette fails visibly (last_error on the console, retried daily) —
--     the ban holds throughout. Removing a SUPERADMIN stays refused: that is
--     a deliberate demotion first, as before.
--   * Memberships are NOT revoked early. The person cannot act once signed out
--     and banned; revoking early would also have to record former_org_ids
--     first (account_silhouette does it in that order), which day 30 does.
--
-- Functions restated in FULL from 20261007090000, each change marked
-- "(20261008020000)". Nothing else in them changes.
-- =============================================================================

-- 1. The new initiator.
alter table public.account_deletions drop constraint account_deletions_initiated_via_check;
alter table public.account_deletions
  add constraint account_deletions_initiated_via_check
  check (initiated_via in ('self', 'superadmin', 'removal'));

-- ---------------------------------------------------------------------------
-- 2. The three "signing in cancels" derivations — a removal opts out.
-- ---------------------------------------------------------------------------
create or replace function public.account_pending_departure(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.account_deletions d
    join auth.users u on u.id = d.user_id
    where d.user_id = target
      and d.state = 'departed'
      and (d.initiated_via = 'removal'   -- (20261008020000) a sign-in never cancels a removal
           or u.last_sign_in_at is null
           or u.last_sign_in_at <= d.requested_at)
  );
$$;

create or replace function public.account_deletion_resume()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_n integer;
begin
  if v_uid is null then
    return jsonb_build_object('cancelled', false);
  end if;
  update public.account_deletions d
     set state = 'cancelled', cancelled_at = now(), cancel_reason = 'signed_in'
   where d.user_id = v_uid
     and d.state = 'departed'
     and d.initiated_via <> 'removal'   -- (20261008020000)
     and exists (
       select 1 from auth.users u
       where u.id = v_uid and u.last_sign_in_at > d.requested_at
     );
  get diagnostics v_n = row_count;
  return jsonb_build_object('cancelled', v_n > 0);
end;
$$;

create or replace function public.account_complete_due_deletions()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_deleted integer := 0;
  v_cancelled integer := 0;
  v_failed integer := 0;
begin
  -- See 20261007090000's header: one caller context, or a pin trigger silently reverts.
  if auth.uid() is not null then
    raise exception 'account_complete_due_deletions runs only from the scheduled job';
  end if;

  for r in
    select d.user_id, d.requested_at, d.initiated_via, u.last_sign_in_at
    from public.account_deletions d
    join auth.users u on u.id = d.user_id
    where d.state = 'departed' and d.due_at <= now()
    order by d.due_at
    for update of d skip locked
  loop
    if r.initiated_via <> 'removal'   -- (20261008020000)
       and r.last_sign_in_at is not null and r.last_sign_in_at > r.requested_at then
      update public.account_deletions
         set state = 'cancelled', cancelled_at = now(), cancel_reason = 'signed_in'
       where user_id = r.user_id;
      v_cancelled := v_cancelled + 1;
      continue;
    end if;

    begin
      perform public.account_silhouette(r.user_id);
      update public.account_deletions
         set state = 'deleted', deleted_at = now(), last_error = null, last_attempt_at = now()
       where user_id = r.user_id;
      v_deleted := v_deleted + 1;
    exception when others then
      -- The subtransaction rolled the partial silhouette back; record why and
      -- leave the row DEPARTED so the console shows it and the next run retries.
      update public.account_deletions
         set last_error = sqlerrm, last_attempt_at = now()
       where user_id = r.user_id;
      v_failed := v_failed + 1;
    end;
  end loop;

  return jsonb_build_object('deleted', v_deleted, 'cancelled', v_cancelled, 'failed', v_failed);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2b. account_begin_departure — restated from 20261007090000. CHANGED: a
--     pending REMOVAL is never overwritten. Without this, the removed person
--     could call account_request_deletion with their still-valid access token
--     (up to an hour) and turn the removal into a self-serve departure, which
--     signing in cancels; and a superadmin's "at request" action would turn it
--     into one whose cancel no longer lifts the ban.
-- ---------------------------------------------------------------------------
create or replace function public.account_begin_departure(target uuid, via text, actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_blockers jsonb;
  v_due timestamptz := now() + interval '30 days';
begin
  if exists (select 1 from public.account_deletions where user_id = target and state = 'deleted') then
    return jsonb_build_object('ok', false, 'reason', 'already_deleted');
  end if;
  -- (20261008020000)
  if exists (select 1 from public.account_deletions
             where user_id = target and state = 'departed' and initiated_via = 'removal') then
    return jsonb_build_object('ok', false, 'reason', 'removed');
  end if;

  v_blockers := public.account_deletion_blockers(target);
  if jsonb_array_length(v_blockers) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'blocked', 'blockers', v_blockers);
  end if;

  insert into public.account_deletions as d (user_id, state, initiated_via, requested_by, requested_at, due_at)
  values (target, 'departed', via, actor, now(), v_due)
  on conflict (user_id) do update
    set state = 'departed',
        initiated_via = excluded.initiated_via,
        requested_by = excluded.requested_by,
        requested_at = excluded.requested_at,
        due_at = excluded.due_at,
        cancelled_at = null,
        cancel_reason = null,
        last_error = null,
        last_attempt_at = null
    where d.state <> 'deleted'
      and not (d.state = 'departed' and d.initiated_via = 'removal');   -- (20261008020000) belt and braces

  -- SIGN OUT EVERYWHERE. Refresh tokens cascade from sessions. This is what
  -- makes "signed in since the request" mean a real, new sign-in: without it,
  -- a live refresh token would keep someone using the app for 30 days without
  -- ever advancing last_sign_in_at, and they would be deleted mid-use. An
  -- access token already issued stays valid until it expires (jwt_expiry,
  -- 1 hour) — accepted: the state is reversible.
  delete from auth.sessions where user_id = target;

  return jsonb_build_object('ok', true, 'due_at', v_due);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Superadmin undo — undoing a REMOVAL also lifts the sign-in block.
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
  -- (20261008020000) The ban was this removal's; nothing else on the platform
  -- sets banned_until on a live account (the silhouette sets it only on day 30,
  -- and a row that reached day 30 is 'deleted', not 'departed').
  if v_via = 'removal' then
    update auth.users set banned_until = null where id = target;
  end if;
  return jsonb_build_object('ok', true, 'lifted_ban', v_via = 'removal');
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Remove from platform.
-- ---------------------------------------------------------------------------
create function public.account_remove_from_platform(target_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target uuid;
  v_count integer;
  v_blockers jsonb;
  v_due timestamptz := now() + interval '30 days';
begin
  if not public.is_superadmin() then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;
  -- Same resolution as account_request_deletion_for_email: the address's
  -- uniqueness in auth.users is PARTIAL, so count rather than trust a scalar.
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
  -- A superadmin (including the caller) is never removed as a side effect.
  if exists (select 1 from public.user_private p where p.user_id = v_target and p.is_superadmin) then
    return jsonb_build_object('ok', false, 'reason', 'blocked', 'blockers', jsonb_build_array('superadmin'));
  end if;

  -- Org/module blockers are a WARNING here, not a refusal (see header).
  v_blockers := public.account_deletion_blockers(v_target);

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

  -- Block sign-in NOW, and sign out everywhere. Same ban length the day-30
  -- silhouette uses, so GoTrue reads it the same way.
  update auth.users set banned_until = now() + interval '100 years' where id = v_target;
  delete from auth.sessions where user_id = v_target;
  -- Belt and braces (adversarial review): a refresh token with no session (an
  -- older GoTrue's rows) survives the session delete, and an unused magic
  -- link / OTP issued before the removal is still redeemable. Both go.
  delete from auth.refresh_tokens where user_id = v_target::text;
  delete from auth.one_time_tokens where user_id = v_target;

  return jsonb_build_object('ok', true, 'due_at', v_due, 'warnings', v_blockers);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. ACLs — the whole intended ACL (docs/03 #1). Restated functions keep
--    exactly the grants 20261007090000 gave them.
-- ---------------------------------------------------------------------------
revoke execute on function public.account_pending_departure(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.account_begin_departure(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke execute on function public.account_complete_due_deletions() from public, anon, authenticated, service_role;
revoke execute on function public.account_deletion_resume() from public, anon, authenticated, service_role;
revoke execute on function public.account_cancel_deletion(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.account_remove_from_platform(text) from public, anon, authenticated, service_role;

grant execute on function public.account_deletion_resume() to authenticated;
grant execute on function public.account_cancel_deletion(uuid) to authenticated;
grant execute on function public.account_remove_from_platform(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Apply-time assertions — catalog only, so they pass on an EMPTY database.
-- ---------------------------------------------------------------------------
do $$
begin
  if pg_get_constraintdef((select oid from pg_constraint
       where conrelid = 'public.account_deletions'::regclass
         and conname = 'account_deletions_initiated_via_check')) not like '%''removal''%' then
    raise exception 'assert: initiated_via does not allow removal';
  end if;
  if pg_get_functiondef('public.account_pending_departure'::regproc) not like '%(20261008020000)%'
     or pg_get_functiondef('public.account_deletion_resume'::regproc) not like '%(20261008020000)%'
     or pg_get_functiondef('public.account_complete_due_deletions'::regproc) not like '%(20261008020000)%' then
    raise exception 'assert: a signing-in-cancels derivation does not opt a removal out';
  end if;
  if pg_get_functiondef('public.account_begin_departure'::regproc) not like '%(20261008020000)%' then
    raise exception 'assert: account_begin_departure can overwrite a pending removal';
  end if;
  if pg_get_functiondef('public.account_cancel_deletion'::regproc) not like '%banned_until = null%' then
    raise exception 'assert: cancelling a removal does not lift the ban';
  end if;
  if has_function_privilege('anon', 'public.account_remove_from_platform(text)', 'execute')
     or has_function_privilege('service_role', 'public.account_remove_from_platform(text)', 'execute') then
    raise exception 'assert: account_remove_from_platform is executable beyond authenticated';
  end if;
  if not has_function_privilege('authenticated', 'public.account_remove_from_platform(text)', 'execute') then
    raise exception 'assert: authenticated cannot call account_remove_from_platform';
  end if;
  if has_function_privilege('authenticated', 'public.account_complete_due_deletions()', 'execute')
     or has_function_privilege('service_role', 'public.account_complete_due_deletions()', 'execute') then
    raise exception 'assert: an API role can run the silhouette job';
  end if;
end $$;
