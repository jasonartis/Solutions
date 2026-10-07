-- ACCOUNT DELETION — the silhouette model (docs/21 §7, decided 2026-09-11; last
-- three questions answered 2026-10-07, §7.9).
--
-- WHAT THIS BUILDS
--   * `account_deletions` — one row per person who has asked to leave. Two
--     states that matter: DEPARTED (reversible, 30-day grace, identity intact)
--     and DELETED (irreversible silhouette). A third, CANCELLED, records a
--     departure that was undone.
--   * Two ways in: `account_request_deletion` (self-serve, typed confirmation =
--     your own email address) and `account_request_deletion_for_email`
--     (superadmin, for an emailed request). Both only START the grace period.
--   * The silhouette step, `account_silhouette`, run 30 days later by
--     `account_complete_due_deletions` on a daily pg_cron job.
--   * Two read helpers for the "Former member" rendering (§7.5) and the
--     speed-dating archive reason (§7.7/§7.8).
--   * ⚠ IT ALSO CHANGES AN EXISTING GUARD: `sd_pin_participant` gains the
--     no-session bypass every other membership guard already has (section 5),
--     because without it the silhouette's participant scrub silently did
--     nothing.
--
-- THE SILHOUETTE (§7.1/§7.4): `auth.users` IS NEVER DELETED. Deleting it would
-- fire the ON DELETE CASCADE foreign keys (42 when docs/21 §1 counted them)
-- and erase other people's records (a
-- peer review on someone else's work, a safety report, a whole drawing thread).
-- Instead the row stays and is emptied: identity scrubbed, auth account banned
-- with its sign-in methods removed, memberships revoked, machine-derived rows
-- deleted, and every HUMAN act that touched someone else kept, now pointing at
-- an anonymous row. Zero FK changes. The per-table classification is in
-- docs/21 §7.10 — read it before adding a table that names a person.
--
-- WHY NOTHING NEW SITS ON THE SIGN-IN PATH. "Signing back in during the grace
-- period cancels the deletion" (§7.9) is DERIVED, not triggered: a departure
-- is live only while `auth.users.last_sign_in_at <= requested_at`. GoTrue
-- advances last_sign_in_at on every real sign-in (docs/03, measured for the
-- login-capture trigger), and the departure deletes every session, so a
-- refresh token cannot carry someone past it either. The alternative — a new
-- trigger on auth.users — would put this feature on the critical path of every
-- sign-in on the platform (docs/03 "Triggers on auth.users"). A derived rule
-- cannot break sign-in, and it cannot drift from GoTrue, because GoTrue is the
-- source of the fact.
--
-- WHAT RUNS THE 30-DAY EXPIRY ON PROD (§7.9's open build question). Production
-- has no always-on worker, so a pg-boss cron would silently never fire. This
-- uses pg_cron INSTEAD — it runs inside the managed database, needs no
-- credentials and no process anyone has to keep up. Measured on prod
-- 2026-10-07 before writing this: pg_cron 1.6.4 is available and
-- `cron.database_name` is `postgres` (it is preloaded). A deliberate exception
-- to docs/03 hard rule 5 ("all background work through pg-boss"), recorded
-- there. The job is idempotent and range-based (`due_at <= now()`), so a
-- missed day is caught up by the next run rather than lost.
--
-- ⚠ THE COMPLETION FUNCTION REFUSES ANY CALLER WITH A SESSION, deliberately.
-- The membership guards (org_members_guard_hierarchy, module_roles_guard_*,
-- and now sd_pin_participant) all treat "no JWT" as the trusted backend. Run
-- with a superadmin's JWT instead, sd_pin_participant would silently REVERT
-- the participant scrub (it returns `old`), and the run would report success
-- having scrubbed nothing. One caller context, so one behaviour.

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------
create table public.account_deletions (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  state           text not null check (state in ('departed', 'cancelled', 'deleted')),
  initiated_via   text not null check (initiated_via in ('self', 'superadmin')),
  requested_by    uuid references auth.users(id) on delete set null,
  requested_at    timestamptz not null default now(),
  due_at          timestamptz not null,
  cancelled_at    timestamptz,
  cancel_reason   text check (cancel_reason in ('signed_in', 'superadmin')),
  deleted_at      timestamptz,
  -- The last silhouette attempt that FAILED (e.g. the person became the sole
  -- admin of an org during the grace period). Shown on the console; cleared on
  -- success. A failed run must be visible, never a silent retry forever.
  last_error      text,
  last_attempt_at timestamptz,
  -- The orgs the person was an ACTIVE member of when the silhouette was made.
  -- Not identity data — tenant ids only — and it is what bounds
  -- former_members() to the people who could actually have seen this person.
  former_org_ids  uuid[] not null default '{}',
  constraint account_deletions_state_shape check (
    (state = 'departed'  and cancelled_at is null and deleted_at is null)
 or (state = 'cancelled' and cancelled_at is not null and cancel_reason is not null and deleted_at is null)
 or (state = 'deleted'   and deleted_at is not null and cancelled_at is null)
  )
);

comment on table public.account_deletions is
  'Account deletion requests (docs/21 §7). DEPARTED = 30-day grace, reversible by signing in; DELETED = irreversible silhouette. All writes go through SECURITY DEFINER functions.';

create index account_deletions_due on public.account_deletions (due_at) where state = 'departed';

alter table public.account_deletions enable row level security;

-- docs/03 #27: REVOKE FIRST. The ambient default differs by environment.
revoke all privileges on public.account_deletions from public, anon, authenticated, service_role;
grant select on public.account_deletions to authenticated;

-- Your own row (after cancelling, you can see that you once asked), and the
-- superadmin's console. No INSERT/UPDATE/DELETE policy: every write is a
-- definer below, which re-checks its own gate.
create policy account_deletions_select_own_or_superadmin on public.account_deletions
  for select to authenticated
  using (user_id = auth.uid() or public.is_superadmin());

-- ---------------------------------------------------------------------------
-- 2. Internal helpers (no API role may call these)
-- ---------------------------------------------------------------------------

-- Is this person inside a LIVE grace period? Derived, never stored: a sign-in
-- after the request means the departure is already cancelled, whether or not
-- anything has written state='cancelled' yet.
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
      and (u.last_sign_in_at is null or u.last_sign_in_at <= d.requested_at)
  );
$$;

-- Has this person left — in the grace period, or a silhouette?
create or replace function public.account_has_left(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.account_pending_departure(target)
      or exists (select 1 from public.account_deletions d where d.user_id = target and d.state = 'deleted');
$$;

-- What stops this person's deletion? Checked when it is REQUESTED (so the
-- person is told now, not 30 days later) and again when it is COMPLETED (the
-- situation can change during the grace period).
--   * a superadmin: deleting the platform's operator account must be a
--     deliberate demotion first, never a side effect.
--   * the only active owner/admin of an org: org_members_guard_last_admin
--     would refuse the membership delete anyway, and an org with no admin is
--     unmanageable. Same rule Slack applies to a workspace's primary owner.
create or replace function public.account_deletion_blockers(target uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(distinct b order by b), '[]'::jsonb)
  from (
    select 'superadmin'::text as b
    where exists (select 1 from public.user_private p where p.user_id = target and p.is_superadmin)
    union all
    select 'sole_admin:' || o.name
    from public.org_members m
    join public.orgs o on o.id = m.org_id
    where m.user_id = target
      and m.status = 'active'
      and m.role in ('owner', 'admin')
      -- An admin who is THEMSELVES in a grace period does not count as the
      -- one who stays (adversarial review, 2026-10-07): otherwise two
      -- co-admins can each request deletion, each passing because the other
      -- is still active, and the second is wedged as sole admin forever
      -- after the first is deleted — unfixable by them, since signing in to
      -- sort it out cancels their own deletion.
      and not exists (
        select 1 from public.org_members other
        where other.org_id = m.org_id
          and other.user_id <> target
          and other.status = 'active'
          and other.role in ('owner', 'admin')
          and not public.account_pending_departure(other.user_id)
      )
    union all
    -- The only Director of a module (rank >= 4). module_roles_guard_last_director
    -- lets a no-session delete through, so without this the silhouette would
    -- quietly leave a module with no Director (review, 2026-10-07; 0 such
    -- grants exist today, so it is latent).
    select 'sole_director:' || o.name || ' / ' || g.module_key
    from public.module_roles g
    join public.orgs o on o.id = g.org_id
    where g.user_id = target
      and public.module_position_rank(g.module_key, g.role) >= 4
      and not exists (
        select 1 from public.module_roles other
        where other.org_id = g.org_id
          and other.module_key = g.module_key
          and other.user_id <> target
          and public.module_position_rank(other.module_key, other.role) >= 4
          and not public.account_pending_departure(other.user_id)
      )
  ) s;
$$;

-- Start (or restart) a departure. Shared by both entry points.
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
    where d.state <> 'deleted';

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
-- 3. Entry points (API-callable, each re-checks its own gate — docs/03 #13)
-- ---------------------------------------------------------------------------

-- Self-serve. The typed confirmation is the caller's OWN email address,
-- compared here rather than in the app, so the gate cannot be skipped by
-- calling the RPC directly.
create or replace function public.account_request_deletion(confirm_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'not_signed_in');
  end if;
  select lower(u.email) into v_email from auth.users u where u.id = v_uid;
  if v_email is null or lower(btrim(coalesce(confirm_email, ''))) <> v_email then
    return jsonb_build_object('ok', false, 'reason', 'confirmation_mismatch');
  end if;
  return public.account_begin_departure(v_uid, 'self', v_uid);
end;
$$;

-- What would block MY deletion? So /account can explain before the person
-- types anything.
create or replace function public.account_my_deletion_blockers()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when auth.uid() is null then '[]'::jsonb
              else public.account_deletion_blockers(auth.uid()) end;
$$;

-- After signing back in: turn a departure that the sign-in already cancelled
-- into a recorded one, and tell the app so it can say so. Requires a REAL
-- sign-in after the request — an access token issued before it (valid up to an
-- hour) is not one, so it cannot be used to cancel.
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
     and exists (
       select 1 from auth.users u
       where u.id = v_uid and u.last_sign_in_at > d.requested_at
     );
  get diagnostics v_n = row_count;
  return jsonb_build_object('cancelled', v_n > 0);
end;
$$;

-- Superadmin, for a request that arrived by email. Resolves the address here
-- so no new email->user lookup is exposed. The superadmin's own account is
-- refused by the superadmin blocker.
create or replace function public.account_request_deletion_for_email(target_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target uuid;
  v_count integer;
begin
  if not public.is_superadmin() then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;
  -- docs/22 lesson (2): auth.users' email uniqueness is PARTIAL, so count
  -- rather than trusting a scalar select to pick one.
  select count(*), min(u.id::text)::uuid into v_count, v_target
  from auth.users u
  where lower(u.email) = lower(btrim(coalesce(target_email, '')));
  if v_count = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_such_user');
  elsif v_count > 1 then
    return jsonb_build_object('ok', false, 'reason', 'ambiguous_email');
  end if;
  return public.account_begin_departure(v_target, 'superadmin', auth.uid());
end;
$$;

-- Superadmin undo, for a request made in error.
create or replace function public.account_cancel_deletion(target uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  if not public.is_superadmin() then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;
  update public.account_deletions
     set state = 'cancelled', cancelled_at = now(), cancel_reason = 'superadmin'
   where user_id = target and state = 'departed';
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', v_n > 0, 'reason', case when v_n > 0 then null else 'not_pending' end);
end;
$$;

-- Is the daily job actually running? The console's honesty badge: a cron job
-- that silently stopped would otherwise look exactly like a quiet week.
create or replace function public.account_deletion_runner_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb;
begin
  if not public.is_superadmin() then
    return null;
  end if;
  select jsonb_build_object(
           'scheduled', true,
           'active', j.active,
           'schedule', j.schedule,
           'last_start', r.start_time,
           'last_status', r.status,
           'last_message', r.return_message)
    into v
    from cron.job j
    left join lateral (
      select d.start_time, d.status, d.return_message
      from cron.job_run_details d
      where d.jobid = j.jobid
      order by d.start_time desc
      limit 1
    ) r on true
   where j.jobname = 'account-deletions-complete-due';
  return coalesce(v, jsonb_build_object('scheduled', false));
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Rendering helpers (§7.5, §7.7, §7.8)
-- ---------------------------------------------------------------------------

-- Which of these people are silhouettes? Needed because a silhouette has no
-- org membership left, so `profiles_select_shared_org` no longer shows its row
-- to anyone — without this, a deleted author renders exactly like a profile
-- the caller cannot see ("Someone"), which is the honesty failure §7.5 names.
--
-- BOUNDED TO FORMER CO-MEMBERS (adversarial review, 2026-10-07). The first
-- draft answered for ANY uuid the caller supplied, so it was an oracle: anyone
-- holding an old uuid — from a past org, or from a speed-dating partner they
-- had DECLINED — could learn that the account was deleted, which is the
-- disclosure §7.8 forbids. Now it answers only when the caller is an active
-- member of an org the person belonged to at deletion: the people who can
-- still see the silhouette's content, which is who the label is for.
-- RESIDUAL, accepted and recorded in docs/21 §7.10: a co-member who declined
-- this person in speed dating and wrote a safety note keeps that pairing (a
-- safety record outranks minimisation), so can still see "Former member"
-- beside their own note.
-- ONLY the DELETED state: a person in the grace period is still a member and
-- renders normally (§7.8 minimisation).
create or replace function public.former_members(check_user_ids uuid[])
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select d.user_id
  from public.account_deletions d
  where auth.uid() is not null
    and d.state = 'deleted'
    and d.user_id = any(check_user_ids)
    and exists (select 1 from unnest(d.former_org_ids) as o(id) where public.is_org_member(o.id));
$$;

-- Speed dating's archive reason (§7.7, binding rule §7.8). Returns the ids of
-- the caller's own REVEALED matches whose counterparty has left — in the grace
-- period or deleted. The filter is sd_matches_select's participant arm verbatim
-- (revealed AND the caller owns a side, with org membership), so this discloses
-- nothing about a match the caller could not already read.
--
-- WHY THIS IS §7.8's RULE AND NOT A LOOSER ONE. An sd_matches row exists only
-- when BOTH people said yes. So:
--   * viewer declined   -> no match row -> never returned -> nothing about
--     their account is disclosed ("You declined" stands on its own);
--   * counterparty declined -> no match row -> never returned -> departure is
--     not the cause, and is not offered as one;
--   * both said yes     -> a revealed match -> departure IS what blocks the
--     next step -> "This person left the platform".
-- The reveal guard ("a rejected side is indistinguishable from an undecided
-- one", module-6:71) is untouched: nothing here answers for a non-match.
create or replace function public.sd_my_departed_matches(check_event_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.id
  from public.sd_matches m
  join public.sd_participants mine
    on mine.id in (m.participant_a_id, m.participant_b_id)
  join public.sd_participants other
    on other.id = case when mine.id = m.participant_a_id then m.participant_b_id else m.participant_a_id end
  where m.event_id = check_event_id
    and m.revealed
    and mine.user_id = auth.uid()
    and public.is_org_member(mine.org_id)
    and other.user_id <> mine.user_id
    and public.account_has_left(other.user_id);
$$;

-- ---------------------------------------------------------------------------
-- 5. sd_pin_participant: the no-session bypass every other guard already has
-- ---------------------------------------------------------------------------
-- The silhouette scrubs a participant's self-written profile card and
-- withdraws them from events that have not happened. Under no JWT this
-- trigger fell through to `return old` and SILENTLY reverted the update — the
-- UPDATE "succeeds" and changes nothing. Every other membership guard treats
-- no-JWT as the trusted backend (org_members_guard_hierarchy,
-- module_roles_guard_hierarchy, module_roles_guard_last_director); this one
-- now does too. `anon` holds no UPDATE on sd_participants (ACL hardening,
-- 20260728010000), and the worker never writes this table, so the only no-JWT
-- writer is a trusted backend. Body otherwise UNCHANGED from 20260910040000.
create or replace function public.sd_pin_participant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if public.sd_can_organize_event(old.org_id, old.event_id) then
    return new;
  end if;

  -- Structural identity is pinned for everyone below organize tier.
  new.event_id := old.event_id;
  new.user_id := old.user_id;
  new.seat_type := old.seat_type;
  new.pool_side := old.pool_side;
  new.mentee_participant_id := old.mentee_participant_id;

  -- Host triage: removal only; nothing else on someone else's row.
  if public.sd_can_staff_event_of(old.org_id, old.event_id) and old.user_id <> auth.uid() then
    new.checked_in := old.checked_in;
    new.checked_in_at := old.checked_in_at;
    new.allows_audience := old.allows_audience;
    new.allows_mentor := old.allows_mentor;
    new.profile_card := old.profile_card;
    new.profile := old.profile;
    if new.status is distinct from old.status and new.status <> 'removed' then
      raise exception 'Host may only remove a participant';
    end if;
    return new;
  end if;

  -- Self-editor: check-in/consents/profile + withdraw. No waitlist self-promotion.
  if old.user_id = auth.uid() then
    if new.status is distinct from old.status and new.status <> 'withdrawn' then
      raise exception 'You may only withdraw your registration';
    end if;
    return new;
  end if;

  return old; -- unreachable under RLS; pin everything as a backstop
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The silhouette step (irreversible)
-- ---------------------------------------------------------------------------
-- Classification (docs/21 §7.10 has the full table and the reasons):
--   REVOKE   org_members, module_roles, mm_group_members (the matchmaking pool:
--            left in place, the rescore job would keep pairing a silhouette)
--   DELETE   machine-derived: login_events, login_rollup, activity_events,
--            activity_rollup, mm_pair_scores, sd_pairings (except a pairing a
--            safety note or report points at — that is part of the incident
--            record, and deleting it would SET NULL the note's context)
--   DELETE   self-only personal data touching nobody: mm_answers
--   SCRUB    identity copies: profiles.display_name, user_private.settings,
--            cls_class_members preferred names, sal_worker_profiles
--            display_name, sd_participants profile/profile_card, the person's
--            entry in sd_matches.contact_shared, sal_customers.user_id (the
--            salon's own customer card survives, unlinked)
--   AUTH     email + phone NULL (frees the address for a fresh signup — §7.2:
--            a returning person is a new person), password blanked, metadata
--            emptied, banned for 100 years, every identity / session / MFA
--            factor / one-time token deleted
--   KEEP     every human act that touched someone else — layers, reactions,
--            flags, peer reviews, submissions, grades, exam papers, survey
--            answers, safety notes in both directions, reports, blocks, bans,
--            matchmaker assignments, interests, matches, seats/rosters (inert:
--            every seat predicate also requires org membership, docs/19),
--            audit logs.
--
-- GoTrue's token columns are deliberately NOT nulled: GoTrue scans several of
-- them into plain Go strings, and a NULL there breaks loading the user row.
-- `email` and `phone` are nullable in GoTrue's model (phone-only and
-- email-only users), so those two are safe to null.
create or replace function public.account_silhouette(target uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_blockers jsonb;
begin
  -- Serialise against a concurrent sign-in or admin edit of this user.
  perform 1 from auth.users where id = target for update;
  if not found then
    raise exception 'account_silhouette: no such user %', target;
  end if;

  v_blockers := public.account_deletion_blockers(target);
  if jsonb_array_length(v_blockers) > 0 then
    raise exception 'account_silhouette: blocked by %', v_blockers;
  end if;

  -- Record which orgs could see this person, BEFORE the memberships go.
  update public.account_deletions
     set former_org_ids = coalesce(
           (select array_agg(distinct m.org_id) from public.org_members m
             where m.user_id = target and m.status = 'active'), '{}')
   where user_id = target;

  -- REVOKE
  delete from public.module_roles where user_id = target;
  delete from public.org_members where user_id = target;
  delete from public.mm_group_members where user_id = target;

  -- DELETE: machine-derived
  delete from public.login_events where user_id = target;
  delete from public.login_rollup where user_id = target;
  delete from public.activity_events where user_id = target;
  delete from public.activity_rollup where user_id = target;
  delete from public.mm_pair_scores where user_a = target or user_b = target;
  delete from public.sd_pairings pr
   where (pr.participant_a_id in (select id from public.sd_participants where user_id = target)
       or pr.participant_b_id in (select id from public.sd_participants where user_id = target))
     and not exists (select 1 from public.sd_notes n where n.pairing_id = pr.id)
     and not exists (select 1 from public.sd_reports r where r.pairing_id = pr.id);

  -- DELETE: self-only personal data
  delete from public.mm_answers where user_id = target;

  -- SCRUB: identity copies
  update public.profiles set display_name = null where user_id = target;
  update public.user_private set settings = '{}'::jsonb, is_superadmin = false where user_id = target;
  update public.cls_class_members
     set preferred_first_name = null, preferred_last_name = null
   where user_id = target
     and (preferred_first_name is not null or preferred_last_name is not null);
  update public.sal_worker_profiles set display_name = null, active = false where user_id = target;
  update public.sal_customers set user_id = null where user_id = target;
  update public.sd_participants p
     set profile = '{}'::jsonb,
         profile_card = null,
         status = case
                    when p.status in ('registered', 'waitlisted')
                     and exists (select 1 from public.sd_events e
                                 where e.id = p.event_id and e.state not in ('complete', 'cancelled'))
                    then 'withdrawn'
                    else p.status
                  end
   where p.user_id = target;
  update public.sd_matches
     set contact_shared = contact_shared - target::text
   where contact_shared ? target::text;

  -- AUTH
  update auth.users
     set email = null,
         phone = null,
         encrypted_password = '',
         email_change = '',
         phone_change = '',
         raw_user_meta_data = '{}'::jsonb,
         banned_until = now() + interval '100 years'
   where id = target;
  delete from auth.identities where user_id = target;
  delete from auth.sessions where user_id = target;
  delete from auth.mfa_factors where user_id = target;
  delete from auth.one_time_tokens where user_id = target;
  -- GoTrue's audit log carries the address in its payload. Prod has never
  -- written to it (CLAUDE.md, measured), local does; scrubbed either way.
  delete from auth.audit_log_entries where payload ->> 'actor_id' = target::text;
  -- Auth tables that exist only in some GoTrue versions (review, 2026-10-07).
  -- Guarded so a Supabase upgrade that renames or drops one cannot make every
  -- future silhouette fail.
  if to_regclass('auth.webauthn_credentials') is not null then
    execute 'delete from auth.webauthn_credentials where user_id = $1' using target;
  end if;
  if to_regclass('auth.webauthn_challenges') is not null then
    execute 'delete from auth.webauthn_challenges where user_id = $1' using target;
  end if;
  if to_regclass('auth.oauth_authorizations') is not null then
    execute 'delete from auth.oauth_authorizations where user_id = $1' using target;
  end if;
  if to_regclass('auth.oauth_consents') is not null then
    execute 'delete from auth.oauth_consents where user_id = $1' using target;
  end if;
  if to_regclass('auth.flow_state') is not null then
    execute 'delete from auth.flow_state where user_id = $1' using target;
  end if;
end;
$$;

-- Run by pg_cron daily. Idempotent and range-based.
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
  -- See the header: one caller context, or a pin trigger silently reverts.
  if auth.uid() is not null then
    raise exception 'account_complete_due_deletions runs only from the scheduled job';
  end if;

  for r in
    select d.user_id, d.requested_at, u.last_sign_in_at
    from public.account_deletions d
    join auth.users u on u.id = d.user_id
    where d.state = 'departed' and d.due_at <= now()
    order by d.due_at
    for update of d skip locked
  loop
    if r.last_sign_in_at is not null and r.last_sign_in_at > r.requested_at then
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
-- 7. Function ACLs — state the whole intended ACL (docs/03 #1)
-- ---------------------------------------------------------------------------
revoke execute on function public.account_pending_departure(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.account_has_left(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.account_deletion_blockers(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.account_begin_departure(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke execute on function public.account_silhouette(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.account_complete_due_deletions() from public, anon, authenticated, service_role;

revoke execute on function public.account_request_deletion(text) from public, anon, authenticated, service_role;
revoke execute on function public.account_my_deletion_blockers() from public, anon, authenticated, service_role;
revoke execute on function public.account_deletion_resume() from public, anon, authenticated, service_role;
revoke execute on function public.account_request_deletion_for_email(text) from public, anon, authenticated, service_role;
revoke execute on function public.account_cancel_deletion(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.account_deletion_runner_status() from public, anon, authenticated, service_role;
revoke execute on function public.former_members(uuid[]) from public, anon, authenticated, service_role;
revoke execute on function public.sd_my_departed_matches(uuid) from public, anon, authenticated, service_role;

grant execute on function public.account_request_deletion(text) to authenticated;
grant execute on function public.account_my_deletion_blockers() to authenticated;
grant execute on function public.account_deletion_resume() to authenticated;
grant execute on function public.account_request_deletion_for_email(text) to authenticated;
grant execute on function public.account_cancel_deletion(uuid) to authenticated;
grant execute on function public.account_deletion_runner_status() to authenticated;
grant execute on function public.former_members(uuid[]) to authenticated;
grant execute on function public.sd_my_departed_matches(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. The schedule
-- ---------------------------------------------------------------------------
-- pg_cron's control file pins it to pg_catalog; its tables live in `cron`.
-- cron.schedule() with a job name is an upsert, so re-running is harmless.
-- 03:17 UTC daily: off the hour, when the platform is quiet.
create extension if not exists pg_cron;

select cron.schedule(
  'account-deletions-complete-due',
  '17 3 * * *',
  'select public.account_complete_due_deletions()'
);

-- ---------------------------------------------------------------------------
-- 9. Apply-time assertions (they run on prod during `db push`, atomically)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from cron.job where jobname = 'account-deletions-complete-due' and active) then
    raise exception 'assert: the expiry job is not scheduled and active';
  end if;
  if has_function_privilege('authenticated', 'public.account_complete_due_deletions()', 'execute')
     or has_function_privilege('service_role', 'public.account_complete_due_deletions()', 'execute')
     or has_function_privilege('anon', 'public.account_complete_due_deletions()', 'execute') then
    raise exception 'assert: an API role can run the silhouette job';
  end if;
  if has_function_privilege('authenticated', 'public.account_silhouette(uuid)', 'execute')
     or has_function_privilege('service_role', 'public.account_silhouette(uuid)', 'execute') then
    raise exception 'assert: an API role can silhouette a user directly';
  end if;
  if has_table_privilege('anon', 'public.account_deletions', 'select') then
    raise exception 'assert: anon can read account_deletions';
  end if;
  -- Works on an EMPTY database (CI applies migrations before any seed).
  if public.account_has_left('00000000-0000-0000-0000-000000000000'::uuid) then
    raise exception 'assert: a nonexistent user reads as having left';
  end if;
end;
$$;
