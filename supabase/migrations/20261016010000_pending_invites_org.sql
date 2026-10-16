-- PENDING INVITES, SLICE 1: ORG PRE-INVITE (2026-10-16, docs/25-pending-invites.md).
--
-- An org admin can invite an ADDRESS, whether or not anyone has an account
-- with it yet. The invite is held for 30 days. When someone signs in with
-- that exact, confirmed address, the invite turns into the SAME pending org
-- seat the platform already uses (accept-first, 20260727010000) — never an
-- active one. The person still accepts it themselves, and org_accept_invite
-- re-checks the inviter a second time when they do.
--
-- Founder decisions (docs/25 §2, 2026-10-15): 30-day hold; anyone may
-- pre-invite to what they could invite to if the person were already here;
-- authority re-checked at claim; the inviter never learns whether the person
-- already exists; only a verified address can claim.
--
-- THE SHAPE, AND THE TWO CHOICES WORTH KNOWING ABOUT
--
-- (1) The claim is an RPC the app calls on the dashboard, NOT a trigger on
--     auth.users. A trigger there that fails can block every sign-up and
--     sign-in (docs/03's auth-trigger rules; login_events is the precedent),
--     and prod's Before-User-Created hook is ON. A sign-in trigger would also
--     never reach an EXISTING user who stays signed in (a token refresh does
--     not move last_sign_in_at). "Confirmed" is checked in SQL
--     (auth.users.email_confirmed_at), so the call site cannot get it wrong.
--     ⚠ That check proves ownership ONLY because prod's GoTrue requires
--     confirmation of a new address and of an email CHANGE. Locally and in CI
--     (enable_confirmations = false) an email change applies at once, so a
--     local test of this path does not prove ownership — the prod verifier
--     reads prod's auth config instead.
--
-- (2) The applier runs with the caller's identity CLEARED (auth.uid() is
--     NULL inside it). The seat must be created on behalf of the INVITER, and
--     org_members_guard_hierarchy already treats "no signed-in user" as the
--     trusted service path: it does not overwrite invited_by with the caller,
--     does not force status, and does not apply the caller's (rank 0) ladder.
--     So the applier sets status = 'pending' itself. A function-level
--     `SET request.jwt.claims` is refused on this database (measured
--     2026-10-15: "permission denied to set parameter"), so the applier saves
--     both settings, blanks them with set_config(..., true), and restores them
--     at its ONE exit; its own exception handler restores them before
--     re-raising. pending_invites_claim_mine then asserts the caller's identity
--     is back. The applier is reachable ONLY from pending_invites_claim_mine
--     (no API role holds EXECUTE), and it re-checks the inviter itself.
--
-- MODULE ROLES ARE NOT CARRIED (adversarial review, 2026-10-15). A grant
-- written at claim survives its inviter losing authority — module_roles has
-- no tie to org_members — and goes live later through somebody else's
-- invite. Granting at ACCEPT, after the inviter re-check, is slice 2's job.
-- Until then an admin grants module roles once the person has accepted, as
-- today.
--
-- PRIVACY. The stored address belongs to someone who may have no account: no
-- data browser, no export, no deletion route. So the row is DELETED on claim,
-- on cancel, on expiry, and when its inviter leaves the platform, and no
-- fingerprint or copy of it is kept anywhere (no log line, no activity event,
-- no warning text carries it). The 30-day expiry plus the admin's cancel ARE
-- the deletion mechanism (docs/25 §4.2.5). Backups are the stated exception.
--
-- NO ORACLE. Issuing never asks whether an account exists. The one distinct
-- answer, 'already_member', is computed only from this org's own seats, which
-- the issuing org admin can already read with addresses (org_member_profiles).
-- This migration also narrows org_find_user_by_email to the superadmin: until
-- now every org admin could ask it whether ANY address has an account.

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------
create table public.pending_invites (
  id           uuid primary key default gen_random_uuid(),
  -- 'vm_conversation' arrives in slice 2. A future 'platform' kind (an address
  -- allowed to sign up while signup is closed) would need no org and no target
  -- — docs/25 §6 answer 6 — so both columns are nullable at the TABLE level
  -- and required per kind by the CHECK below. Nothing is built for it.
  kind         text not null check (kind in ('org')),
  -- The org the invite belongs to (tenancy: every org-anchored kind sets it,
  -- and RLS reads it). Required for kind 'org'.
  org_id       uuid references public.orgs (id) on delete cascade,
  -- What the invite is FOR. For kind 'org' this is the org itself.
  target_id    uuid,
  -- Stored lower+trim. Matched EXACTLY at claim — never by
  -- account_email_fingerprint, which is deliberately aggressive and exists
  -- for blocks, not identity.
  email        text not null check (
                 email = lower(btrim(email))
                 and char_length(email) between 3 and 320
                 and email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  role         text not null,
  -- auth.users is never deleted by the platform (account deletion keeps the
  -- row as a silhouette); the pruner removes a departed inviter's rows.
  invited_by   uuid not null references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  constraint pending_invites_org_shape check (
    kind <> 'org' or (org_id is not null and target_id = org_id and role in ('owner', 'admin', 'member'))),
  -- NULLS NOT DISTINCT so a target-less kind still gets one row per address.
  constraint pending_invites_one_per_target unique nulls not distinct (kind, target_id, email)
);

create index pending_invites_email_idx on public.pending_invites (email);
create index pending_invites_invited_by_idx on public.pending_invites (invited_by);
create index pending_invites_org_idx on public.pending_invites (org_id);
create index pending_invites_expires_idx on public.pending_invites (expires_at);

comment on table public.pending_invites is
  'Invitations held for an ADDRESS (docs/25). Rows are deleted on claim, cancel, expiry and '
  'when the inviter leaves; the address is never copied elsewhere. All writes go through definers.';

-- docs/03 #27: revoke from every API role FIRST — pg_default_acl differs by
-- schema and environment, and a column grant cannot narrow a table grant.
revoke all privileges on public.pending_invites from public, anon, authenticated, service_role;
grant select on public.pending_invites to authenticated;

alter table public.pending_invites enable row level security;

-- SELECT only, and only for a CURRENT org admin (adversarial review: an
-- "inviter may read their own" arm let a demoted admin keep reading the
-- addresses, and watch a row vanish early — which says the address now has an
-- account). There is deliberately no INSERT/UPDATE/DELETE policy: every write
-- goes through the definers below. The invitee never reads this table.
create policy pending_invites_select_org_admin on public.pending_invites
  for select to authenticated
  using (public.is_org_admin(org_id));

-- ---------------------------------------------------------------------------
-- 2. Issue
-- ---------------------------------------------------------------------------
-- Returns 'invited' (stored or refreshed), 'exists' (an invite for this
-- address is already held by someone this caller cannot overrule — the admin
-- can see it in the list), or 'already_member'.
--
-- CAPS (founder, docs/25 §6 answer 2, 2026-10-16): at most N open invitations
-- per INVITER (default 100) and M open invitations naming one ADDRESS across
-- every inviter (default 20). Both live in platform_settings under
-- 'pending_invites.caps' ({"maxPerInviter", "maxPerAddress"}), editable by the
-- superadmin on the Owner Console; the defaults here are the fallback when no
-- row exists. Over the inviter cap the inviter is told THEIR limit. Over the
-- address cap nothing is stored and the answer is the ordinary 'invited' —
-- a refusal would tell the inviter that other people have invited this
-- address (the no-oracle rule; the review that dropped the first per-address
-- cap found exactly that). Revisit both when invites start sending email.
create or replace function public.pending_invite_issue_org(
  check_org_id uuid,
  target_email text,
  invited_role text
)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_email text := lower(btrim(coalesce(target_email, '')));
  v_rank  integer;
  v_rows  integer;
  v_max_inviter integer;
  v_max_address integer;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;
  if char_length(v_email) not between 3 and 320 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    raise exception 'Enter a valid email address';
  end if;
  if coalesce(invited_role, '') not in ('owner', 'admin', 'member') then
    raise exception 'Unknown role';
  end if;

  -- "Could invite this person if they already had an account": the same test
  -- org_members_guard_hierarchy applies to a direct add.
  v_rank := public.org_caller_rank(check_org_id);
  if not public.is_org_admin(check_org_id) or v_rank <= public.org_role_rank(invited_role) then
    raise exception 'Not authorized';
  end if;

  -- Already a member (or already holding a pending seat) of THIS org. Not an
  -- oracle: the caller is an org admin and already reads every seat's address.
  if exists (
    select 1
    from public.org_members m
    join auth.users u on u.id = m.user_id
    where m.org_id = check_org_id
      and lower(btrim(u.email)) = v_email
  ) then
    return 'already_member';
  end if;

  -- A malformed value falls back to the default rather than raising: a typo
  -- in the console must not stop every invitation on the platform.
  select case when s.value ->> 'maxPerInviter' ~ '^[0-9]{1,6}$'
              then (s.value ->> 'maxPerInviter')::integer else 100 end,
         case when s.value ->> 'maxPerAddress' ~ '^[0-9]{1,6}$'
              then (s.value ->> 'maxPerAddress')::integer else 20 end
    into v_max_inviter, v_max_address
  from (select 1) one
  left join public.platform_settings s on s.key = 'pending_invites.caps';

  -- Serialise per address and per inviter so neither cap can be raced past.
  perform pg_advisory_xact_lock(hashtext('pending_invites:address:' || v_email));
  perform pg_advisory_xact_lock(hashtext('pending_invites:inviter:' || v_uid::text));

  -- A refresh of a row that already exists adds nothing, so caps only apply
  -- to a NEW (kind, target, address).
  if not exists (select 1 from public.pending_invites
                 where kind = 'org' and target_id = check_org_id and email = v_email) then
    if (select count(*) from public.pending_invites
        where invited_by = v_uid and expires_at > now()) >= v_max_inviter then
      raise exception 'You have reached your limit of % open invitations. Cancel some first.', v_max_inviter;
    end if;
    if (select count(*) from public.pending_invites
        where email = v_email and expires_at > now()) >= v_max_address then
      return 'invited';   -- silent: see the CAPS note above
    end if;
  end if;

  -- One invite per (org, address). Re-issuing refreshes it — but only for its
  -- own inviter or someone who outranks the role it carries, so an admin
  -- cannot rewrite an owner's admin-level invite.
  insert into public.pending_invites as p
    (kind, org_id, target_id, email, role, invited_by, expires_at)
  values
    ('org', check_org_id, check_org_id, v_email, invited_role, v_uid, now() + interval '30 days')
  on conflict (kind, target_id, email) do update
    set role       = excluded.role,
        invited_by = excluded.invited_by,
        created_at = now(),
        expires_at = excluded.expires_at
    where p.invited_by = v_uid
       or v_rank > public.org_role_rank(p.role);
  get diagnostics v_rows = row_count;

  return case when v_rows = 0 then 'exists' else 'invited' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Cancel and resend
-- ---------------------------------------------------------------------------
-- CANCEL: any CURRENT org admin of the invite's org, whoever issued it
-- (founder, docs/25 §6 answer 3: it is how an admin finds and removes abuse;
-- cancelling grants nothing to anyone). Anything else reads as "not found" —
-- the same answer as a row that does not exist.
create or replace function public.pending_invite_cancel(invite_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  inv public.pending_invites%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  select * into inv from public.pending_invites where id = invite_id for update;
  if not found or not public.is_org_admin(inv.org_id) then
    raise exception 'Invitation not found';
  end if;
  delete from public.pending_invites where id = invite_id;
end;
$$;

-- RESEND = a fresh 30 days. Unlike cancel it RE-ISSUES the invite, so it is
-- held to the issue rule: a current org admin who is its inviter or outranks
-- the role it carries. It also needs issue authority NOW, and it moves
-- invited_by to the caller, because the claim re-checks the inviter recorded
-- on the row. (Resending can keep an invite alive indefinitely; that follows
-- from the founder's "resend resets the clock" and is stated in docs/25.)
create or replace function public.pending_invite_resend(invite_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  inv public.pending_invites%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  select * into inv from public.pending_invites where id = invite_id for update;
  if not found
     or not public.is_org_admin(inv.org_id)
     or not (inv.invited_by = auth.uid()
             or public.org_caller_rank(inv.org_id) > public.org_role_rank(inv.role)) then
    raise exception 'Invitation not found';
  end if;
  if public.org_caller_rank(inv.org_id) <= public.org_role_rank(inv.role) then
    raise exception 'Not authorized';
  end if;
  update public.pending_invites
     set expires_at = now() + interval '30 days',
         invited_by = auth.uid()
   where id = invite_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Apply (internal) — turn ONE invite into a pending seat for ONE user
-- ---------------------------------------------------------------------------
-- Returns true if a seat was created. Never callable by an API role.
create or replace function public.pending_invite_apply(invite_id uuid, invitee uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  inv        public.pending_invites%rowtype;
  v_ok       boolean;
  v_applied  boolean := false;
  old_claims text := current_setting('request.jwt.claims', true);
  old_sub    text := current_setting('request.jwt.claim.sub', true);
begin
  select * into inv from public.pending_invites where id = invite_id;
  if not found or inv.kind <> 'org' then
    return false;
  end if;

  -- Defence in depth: the invite's address must be the invitee's own,
  -- confirmed address — not merely trusted from the caller.
  if not exists (select 1 from auth.users u
                 where u.id = invitee
                   and u.email_confirmed_at is not null
                   and lower(btrim(u.email)) = inv.email) then
    return false;
  end if;

  -- Authority AT CLAIM. The inviter must still be able to make this invite:
  -- not removed from the platform, not departed, and a superadmin or an
  -- ACTIVE member of the org who strictly outranks the invited role — the
  -- same rule org_accept_invite applies, so the two checks cannot disagree.
  -- Every predicate here is about a THIRD party, so none is caller-relative
  -- (docs/03 #29: is_org_member/is_org_admin answer only about auth.uid()).
  select
    not exists (select 1 from auth.users u
                where u.id = inv.invited_by
                  and (u.banned_until > now() or u.deleted_at is not null))
    and not public.account_has_left(inv.invited_by)
    and (
      exists (select 1 from public.user_private up
              where up.user_id = inv.invited_by and up.is_superadmin)
      or exists (select 1 from public.org_members ib
                 where ib.org_id = inv.org_id
                   and ib.user_id = inv.invited_by
                   and ib.status = 'active'
                   and public.org_role_rank(ib.role) > public.org_role_rank(inv.role))
    )
    -- Any existing seat (pending or active) wins; the invite is used up.
    and not exists (select 1 from public.org_members
                    where org_id = inv.org_id and user_id = invitee)
  into v_ok;

  if not coalesce(v_ok, false) then
    return false;
  end if;

  -- From here to the single exit the caller's identity is cleared, so
  -- org_members_guard_hierarchy takes its trusted path and keeps
  -- invited_by = the inviter (see header, choice 2).
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    insert into public.org_members (org_id, user_id, role, status, invited_by, invited_at)
    values (inv.org_id, invitee, inv.role, 'pending', inv.invited_by, now());
    v_applied := true;
  exception when others then
    perform set_config('request.jwt.claims', coalesce(old_claims, ''), true);
    perform set_config('request.jwt.claim.sub', coalesce(old_sub, ''), true);
    raise;
  end;
  perform set_config('request.jwt.claims', coalesce(old_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(old_sub, ''), true);
  return v_applied;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Claim — the signed-in person's own invites, by their own confirmed address
-- ---------------------------------------------------------------------------
-- Called by the app on the dashboard. Returns how many seats were created.
create or replace function public.pending_invites_claim_mine()
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_email   text;
  v_id      uuid;
  v_applied integer := 0;
begin
  if v_uid is null then
    return 0;
  end if;

  select lower(btrim(u.email)) into v_email
  from auth.users u
  where u.id = v_uid
    and u.email is not null
    and u.email_confirmed_at is not null
    and u.deleted_at is null
    and coalesce(u.is_anonymous, false) = false
    and (u.banned_until is null or u.banned_until <= now());
  if v_email is null or v_email = '' then
    return 0;
  end if;

  -- auth.users' email uniqueness is PARTIAL (is_sso_user = false). If two
  -- accounts share this address, neither may claim (CLAUDE.md lesson 2 of the
  -- email slice: never let "the first row" decide who someone is).
  if (select count(*) from auth.users u
      where lower(btrim(u.email)) = v_email and u.deleted_at is null) > 1 then
    return 0;
  end if;

  for v_id in
    select p.id from public.pending_invites p
    where p.email = v_email and p.expires_at > now()
    order by p.created_at
    for update skip locked
  loop
    begin
      if public.pending_invite_apply(v_id, v_uid) then
        v_applied := v_applied + 1;
      end if;
      -- Used up whether or not it applied: an invite whose inviter lost
      -- authority is dead, and the address must not outlive its purpose.
      delete from public.pending_invites where id = v_id;
    exception when others then
      -- Leave the row (it expires on its own) and never break the page.
      -- The address is deliberately NOT in this message.
      raise warning 'pending_invites_claim_mine: invite % not applied (%)', v_id, sqlstate;
    end;
  end loop;

  -- The applier clears the caller's identity; prove it came back.
  if auth.uid() is distinct from v_uid then
    raise exception 'pending_invites_claim_mine: caller identity was not restored';
  end if;

  return v_applied;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Expiry — pg_cron, hourly (docs/03 hard rule 5's exception: pure SQL,
--    idempotent, range-based, and something renders whether it has run)
-- ---------------------------------------------------------------------------
-- Also removes invites whose inviter's account deletion has COMPLETED: the
-- silhouette never deletes auth.users, so the FK cascade never fires on prod,
-- and such an invite can never apply. Deliberately NOT account_has_left(),
-- which also counts the 30-day grace period — someone who signs back in during
-- grace should find their invitations still there.
create or replace function public.pending_invites_prune_expired()
returns integer
language sql
volatile
security definer
set search_path = public
as $$
  with gone as (
    delete from public.pending_invites p
    where p.expires_at <= now()
       or exists (select 1 from public.account_deletions d
                  where d.user_id = p.invited_by and d.state = 'deleted')
    returning 1
  )
  select count(*)::integer from gone;
$$;

-- The last SUCCESSFUL prune, for the members page. A timestamp only — never
-- the job's command or return message.
create or replace function public.pending_invites_pruner_last_run()
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select max(d.end_time)
  from cron.job j
  join cron.job_run_details d on d.jobid = j.jobid
  where j.jobname = 'pending-invites-prune-expired'
    and d.status = 'succeeded';
$$;

-- ---------------------------------------------------------------------------
-- 7. org_find_user_by_email -> SUPERADMIN ONLY (docs/25 §4.3, docs/20 §8.3)
-- ---------------------------------------------------------------------------
-- It answered "does ANY account have this address?" for every org admin. The
-- org members page no longer calls it (it issues a pending invite instead);
-- the Owner Console's direct add still does, and is superadmin-gated.
-- Signature, return type and ACL unchanged; only the gate narrows.
create or replace function public.org_find_user_by_email(check_org_id uuid, target_email text)
returns table (user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select u.id
  from auth.users u
  where public.is_superadmin()
    and lower(u.email) = lower(trim(target_email))
    and u.deleted_at is null
    and coalesce(u.is_anonymous, false) = false;
$$;

-- ---------------------------------------------------------------------------
-- 8. ACLs — the full intended ACL for every new function (docs/03 #1)
-- ---------------------------------------------------------------------------
revoke execute on function public.pending_invite_issue_org(uuid, text, text) from public, anon, authenticated, service_role;
revoke execute on function public.pending_invite_cancel(uuid)               from public, anon, authenticated, service_role;
revoke execute on function public.pending_invite_resend(uuid)               from public, anon, authenticated, service_role;
revoke execute on function public.pending_invite_apply(uuid, uuid)          from public, anon, authenticated, service_role;
revoke execute on function public.pending_invites_claim_mine()              from public, anon, authenticated, service_role;
revoke execute on function public.pending_invites_prune_expired()           from public, anon, authenticated, service_role;
revoke execute on function public.pending_invites_pruner_last_run()         from public, anon, authenticated, service_role;

grant execute on function public.pending_invite_issue_org(uuid, text, text) to authenticated;
grant execute on function public.pending_invite_cancel(uuid)               to authenticated;
grant execute on function public.pending_invite_resend(uuid)               to authenticated;
grant execute on function public.pending_invites_claim_mine()              to authenticated;
grant execute on function public.pending_invites_pruner_last_run()         to authenticated;

-- ---------------------------------------------------------------------------
-- 9. The schedule
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;

select cron.schedule(
  'pending-invites-prune-expired',
  '23 * * * *',
  'select public.pending_invites_prune_expired()'
);

-- ---------------------------------------------------------------------------
-- 10. Apply-time assertions (run on prod during `db push`, atomically; they
--     must hold on an EMPTY database — CI applies migrations before any seed)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from cron.job where jobname = 'pending-invites-prune-expired' and active) then
    raise exception 'assert: the pending-invites pruner is not scheduled and active';
  end if;
  if has_table_privilege('anon', 'public.pending_invites', 'select')
     or has_table_privilege('service_role', 'public.pending_invites', 'select')
     or has_table_privilege('authenticated', 'public.pending_invites', 'insert')
     or has_table_privilege('authenticated', 'public.pending_invites', 'update')
     or has_table_privilege('authenticated', 'public.pending_invites', 'delete') then
    raise exception 'assert: an API role holds more than SELECT-for-authenticated on pending_invites';
  end if;
  if has_function_privilege('authenticated', 'public.pending_invite_apply(uuid, uuid)', 'execute')
     or has_function_privilege('service_role', 'public.pending_invite_apply(uuid, uuid)', 'execute')
     or has_function_privilege('anon', 'public.pending_invite_apply(uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.pending_invites_prune_expired()', 'execute') then
    raise exception 'assert: an API role can call an internal pending-invites function';
  end if;
  if has_function_privilege('anon', 'public.pending_invites_claim_mine()', 'execute')
     or has_function_privilege('anon', 'public.pending_invite_issue_org(uuid, text, text)', 'execute') then
    raise exception 'assert: anon can reach a pending-invites function';
  end if;
  if (select count(*) from pg_policy where polrelid = 'public.pending_invites'::regclass) <> 1
     or not exists (select 1 from pg_policy
                    where polrelid = 'public.pending_invites'::regclass and polcmd = 'r') then
    raise exception 'assert: pending_invites must have exactly one policy, and it must be SELECT';
  end if;
  if position('is_superadmin' in pg_get_functiondef('public.org_find_user_by_email(uuid, text)'::regprocedure)) = 0
     or position('is_org_admin' in pg_get_functiondef('public.org_find_user_by_email(uuid, text)'::regprocedure)) > 0 then
    raise exception 'assert: org_find_user_by_email is not superadmin-only';
  end if;
end;
$$;
