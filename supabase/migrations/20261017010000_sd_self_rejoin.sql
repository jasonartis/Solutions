-- SPEED DATING: SELF-REJOIN, AND THE DATABASE DECIDES EVERY SELF-REGISTRATION
-- (2026-10-17). Companion: 20261017020000_sd_hardening.sql (the other tables).
--
-- PART A — REJOIN AFTER A SELF-WITHDRAWAL.
-- A participant who withdrew (status 'withdrawn') could never come back:
-- `unique (event_id, user_id)` blocks a second INSERT, and sd_pin_participant
-- let a self-editor change status ONLY to 'withdrawn'. The second rule stays
-- for every OTHER transition: free self-reactivation would let anyone jump a
-- full side's waitlist.
-- FOUNDER DECISION (consent principle): a person who withdrew THEMSELVES may
-- register again THEMSELVES; an organizer must never put them back without
-- their say-so. Someone REMOVED stays removed until an organizer clears it.
-- The organizer path is unchanged (sd_pin_participant returns early for
-- sd_can_organize_event).
--
-- THE MECHANISM: one new branch inside sd_pin_participant, the SECURITY
-- DEFINER BEFORE UPDATE trigger that already owns every status transition a
-- non-organizer can make.
--   * NOT FORGEABLE. The decision is made from OLD (the stored row), the
--     stored event, sd_bans, module_roles and org_members. The client's
--     requested status is only the WISH to rejoin; the stored value is
--     computed. No session GUC / set_config flag (any authenticated session
--     can set a custom GUC, so a flag would be an authorization anyone holds).
--   * NOT DELETE+INSERT: deleting the withdrawn seat would cascade its
--     pairings, interest, matches and the context reports/notes point at.
--   * A trigger, not an RPC: the self-UPDATE door already exists
--     (sd_participants_update_self); an RPC would be a second door.
-- A rejoin requires: caller owns the seat; old.status = 'withdrawn' (never
-- from 'removed'; never waitlisted -> registered); event state 'open';
-- sd_is_participant(org) (caller-relative, docs/03 #29 — correct here because
-- the caller IS the seat owner); no ACTIVE sd_bans row. It resets check-in and
-- re-stamps created_at to now() (the back of the waitlist: promoteNextWaitlisted
-- orders by created_at, so every existing reader stays correct with no new
-- column to forget).
--
-- PART B — FRESH SELF-REGISTRATION IS DECIDED BY THE DATABASE TOO (review
-- finding, 2026-10-17). sd_participants_insert_self only checked
-- `user_id = auth.uid() AND sd_is_participant(org) AND status in
-- (registered, waitlisted)`. So a participant could self-insert: into a
-- DRAFT/running/complete event; while banned; as seat_type 'mentor' or
-- 'audience' with a mentee_participant_id of their choosing (the read half of
-- that is the cross-org hole 20261017020000 closes); already checked in with
-- a back-dated checked_in_at; with a 1970 created_at (front of the waitlist);
-- and as 'registered' on a full side by simply sending status 'registered'.
-- New BEFORE INSERT guard sd_participants_b_insert_guard, for callers with a
-- JWT who cannot organize the event: forces seat_type 'participant',
-- mentee_participant_id NULL, not checked in, created_at now(); requires an
-- OPEN event, eligibility and no active ban; requires a side 'a'/'b' on a
-- two-sided event and forces pool_side NULL on a single-pool one; and
-- OVERWRITES status with the database's decision.
--
-- ONE CAPACITY RULE, ONE DEFINITION (docs/03 #31): sd_registration_status()
-- is called by BOTH the insert guard and the rejoin branch. 'waitlisted' when
-- the event is two-sided (both side labels present — mirrors
-- modules/speed-dating/ui/event-format.ts getEventSides), the side has a
-- numeric capacity, and EITHER the side's registered count >= capacity OR
-- anyone is already waitlisted on that side; else 'registered'. The "anyone
-- already waiting" arm is deliberate: without it a newcomer (or a rejoiner)
-- would take a seat that a waiting person is owed but an organizer has not yet
-- promoted. It counts directly as definer, NOT via sd_side_registered_count,
-- which is caller-relative (docs/03 #29).
-- RACE: it takes a transaction-scoped advisory lock on (event, side) before
-- counting, so two self-registrations/rejoins racing for the last seat are
-- serialised (read committed: the second waiter's count runs in a fresh
-- snapshot after the first commits). Organizer writes do not take the lock;
-- they set status explicitly and are not deciding by count.
--
-- PART C — SELF-EDITOR COLUMN PINS (review findings, 2026-10-17):
--   * created_at pinned below organizer tier (a waitlisted user could set it
--     to 1970 and go to the FRONT of the queue). Only the rejoin re-stamps it.
--   * id pinned below organizer tier.
--   * A REMOVED seat is frozen: every column is pinned (the trigger returns
--     OLD); a status change raises. Before this a removed person could still
--     check in, back-date checked_in_at, flip consents and rewrite the card.
--   * A WITHDRAWN seat cannot check in (checked_in/checked_in_at pinned).
--   * checked_in_at is SERVER-STAMPED for a self-editor: now() when checked_in
--     flips to true, NULL when it flips to false, unchanged otherwise.
--   * 'removed' -> 'withdrawn' by the person themselves is refused: with
--     rejoin it would launder an ejection. An organizer can still clear a
--     removal to 'withdrawn', after which the person may rejoin.
--
-- PART D — CONSENT RULE ALSO BINDS ORGANIZERS (re-review, 2026-10-17). The
-- organizer early return let an organizer set a SELF-WITHDRAWN seat back to
-- registered/waitlisted — putting someone back without their say-so. Now,
-- for any JWT caller who is not the seat's holder, (withdrawn|removed) ->
-- (registered|waitlisted) raises 'Only the person can register again'
-- ('removed' included: otherwise withdrawn -> removed -> registered steps
-- round the rule). A removed person returns only by an organizer clearing
-- the removal to 'withdrawn' and the person then rejoining themselves.
-- Organizers keep removed -> withdrawn (how a removal is cleared) and
-- waitlisted -> registered (promotion).
-- STILL OPEN (founder question, not decided here): an organizer may INSERT a
-- fresh seat for any active member (sd_participants_write_organize). No UI
-- does this today; whether an organizer-created seat needs the person's
-- acceptance is the same consent question for a first registration.
--
-- UNCHANGED: the no-JWT trusted-backend bypass (seed, silhouette, worker),
-- the organizer early return (after the consent check above), the structural
-- pins, host triage (removal only). RLS policies are unchanged.
--
-- JUDGEMENT CALL (review finding, LOW): any org member WITHOUT a speed-dating
-- role can call sd_side_registered_count and learn how many people are
-- registered on a side. LEFT AS IS: it returns a number, never identities;
-- the event list it would apply to is only readable by participants/staff
-- anyway (an event id is needed); and narrowing it to sd_is_participant would
-- also need staff arms (organizers/hosts call it through promoteNextWaitlisted)
-- for no real privacy gain. Revisit if per-side counts ever become sensitive.
--
-- ACL: every function here is either a trigger function or an internal helper
-- only called from definer triggers; none needs API-role EXECUTE. All are
-- revoked from public, anon, authenticated, service_role (docs/03 #1, #27).
-- Volatility: all plpgsql VOLATILE (docs/03 #30).
-- Applies cleanly to an EMPTY database: the assertion block reads only the
-- catalog. Idempotent (create or replace / drop trigger if exists).

-- ---------------------------------------------------------------------------
-- 1. The one capacity rule.
-- ---------------------------------------------------------------------------
create or replace function public.sd_registration_status(
  check_event_id uuid,
  check_side text,
  exclude_participant_id uuid
)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  ev_format jsonb;
  side_capacity numeric;
  side_registered integer;
  side_has_waitlist boolean;
begin
  select e.format into ev_format from public.sd_events e where e.id = check_event_id;

  if check_side is null
     or check_side not in ('a', 'b')
     or coalesce(ev_format -> 'sides' -> 'a' ->> 'label', '') = ''
     or coalesce(ev_format -> 'sides' -> 'b' ->> 'label', '') = ''
     or jsonb_typeof(ev_format -> 'sides' -> check_side -> 'capacity') is distinct from 'number'
  then
    return 'registered';   -- single pool, or unlimited side
  end if;

  side_capacity := (ev_format -> 'sides' -> check_side ->> 'capacity')::numeric;

  -- Serialise deciders for this (event, side); released at commit.
  perform pg_advisory_xact_lock(hashtextextended('sd_side:' || check_event_id::text || ':' || check_side, 0));

  select count(*)::integer into side_registered
  from public.sd_participants p
  where p.event_id = check_event_id
    and p.pool_side = check_side
    and p.status = 'registered'
    and p.id is distinct from exclude_participant_id;

  select exists (
    select 1 from public.sd_participants p
    where p.event_id = check_event_id
      and p.pool_side = check_side
      and p.status = 'waitlisted'
      and p.id is distinct from exclude_participant_id
  ) into side_has_waitlist;

  if side_registered >= side_capacity or side_has_waitlist then
    return 'waitlisted';
  end if;
  return 'registered';
end;
$$;

revoke all on function public.sd_registration_status(uuid, text, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Fresh self-registration guard (BEFORE INSERT).
-- ---------------------------------------------------------------------------
create or replace function public.sd_participants_insert_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ev public.sd_events%rowtype;
  two_sided boolean;
begin
  if auth.uid() is null then
    return new;   -- trusted backend (seed, worker)
  end if;

  select * into ev from public.sd_events e where e.id = new.event_id;

  if found and public.sd_can_organize_event(ev.org_id, ev.id) then
    return new;   -- organizer path unchanged (integrity is 20261017020000's trigger)
  end if;

  -- One generic answer for "no such event" and "not eligible": no oracle.
  if not found
     or new.user_id is distinct from auth.uid()
     or not public.sd_is_participant(ev.org_id)
     or exists (
       select 1 from public.sd_bans b
       where b.org_id = ev.org_id and b.banned_user_id = auth.uid() and b.active
     )
  then
    raise exception 'You are not eligible to register for this event';
  end if;

  if ev.state is distinct from 'open' then
    raise exception 'Registration for this event is not open';
  end if;

  two_sided := coalesce(ev.format -> 'sides' -> 'a' ->> 'label', '') <> ''
           and coalesce(ev.format -> 'sides' -> 'b' ->> 'label', '') <> '';
  if two_sided then
    if new.pool_side is null or new.pool_side not in ('a', 'b') then
      raise exception 'Choose a side to register for';
    end if;
  else
    new.pool_side := null;
  end if;

  new.seat_type := 'participant';
  new.mentee_participant_id := null;
  new.checked_in := false;
  new.checked_in_at := null;
  new.created_at := now();
  new.status := public.sd_registration_status(new.event_id, new.pool_side, new.id);
  return new;
end;
$$;

revoke all on function public.sd_participants_insert_guard() from public, anon, authenticated, service_role;

-- Fires before sd_participants_scope (alphabetical), so the decision is made
-- on the client's event_id; the scope trigger then derives org_id from it.
drop trigger if exists sd_participants_b_insert_guard on public.sd_participants;
create trigger sd_participants_b_insert_guard
  before insert on public.sd_participants
  for each row execute function public.sd_participants_insert_guard();

-- ---------------------------------------------------------------------------
-- 3. sd_pin_participant: rejoin branch + the column pins.
-- ---------------------------------------------------------------------------
create or replace function public.sd_pin_participant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ev_state text;
begin
  if auth.uid() is null then
    return new;
  end if;

  -- Consent rule (founder): a seat its holder WITHDREW goes back to
  -- registered/waitlisted only by that person's own act — not even an
  -- organizer may do it. removed -> withdrawn (clearing a removal) and
  -- waitlisted -> registered (promotion) stay open to organizers.
  -- 'removed' is covered too, or withdrawn -> removed -> registered would
  -- step round it.
  if old.status in ('withdrawn', 'removed')
     and new.status in ('registered', 'waitlisted')
     and auth.uid() is distinct from old.user_id
  then
    raise exception 'Only the person can register again';
  end if;

  if public.sd_can_organize_event(old.org_id, old.event_id) then
    return new;
  end if;

  -- Structural identity is pinned for everyone below organize tier.
  new.id := old.id;
  new.event_id := old.event_id;
  new.user_id := old.user_id;
  new.seat_type := old.seat_type;
  new.pool_side := old.pool_side;
  new.mentee_participant_id := old.mentee_participant_id;
  -- Waitlist order is created_at (promoteNextWaitlisted): nobody below
  -- organize tier may reorder the queue. Only the rejoin re-stamps it.
  new.created_at := old.created_at;

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

  -- Self-editor.
  if old.user_id = auth.uid() then
    -- A removed seat is frozen for its holder.
    if old.status = 'removed' then
      if new.status is distinct from old.status then
        raise exception 'You were removed from this event; only an organizer can change that';
      end if;
      return old;
    end if;

    -- Check-in: no check-in from a withdrawn seat; the time is server-stamped.
    if old.status = 'withdrawn' then
      new.checked_in := old.checked_in;
      new.checked_in_at := old.checked_in_at;
    elsif new.checked_in is distinct from old.checked_in then
      new.checked_in_at := case when new.checked_in then now() else null end;
    else
      new.checked_in_at := old.checked_in_at;
    end if;

    if new.status is not distinct from old.status then
      return new;
    end if;

    if new.status = 'withdrawn' then
      return new;   -- from registered or waitlisted (removed handled above)
    end if;

    -- Rejoin: withdrawn -> (registered | waitlisted); the database decides.
    if old.status = 'withdrawn' and new.status in ('registered', 'waitlisted') then
      select e.state into ev_state from public.sd_events e where e.id = old.event_id;
      if ev_state is distinct from 'open' then
        raise exception 'Registration for this event is not open';
      end if;
      if not public.sd_is_participant(old.org_id) then
        raise exception 'You are not eligible to register for this event';
      end if;
      if exists (
        select 1 from public.sd_bans b
        where b.org_id = old.org_id and b.banned_user_id = old.user_id and b.active
      ) then
        raise exception 'You are not eligible to register for this event';
      end if;

      new.status := public.sd_registration_status(old.event_id, old.pool_side, old.id);
      new.checked_in := false;
      new.checked_in_at := null;
      new.created_at := now();   -- back of the waitlist
      return new;
    end if;

    if old.status = 'withdrawn' then
      raise exception 'You may only register again or stay withdrawn';
    end if;
    raise exception 'You may only withdraw your registration';
  end if;

  return old; -- unreachable under RLS; pin everything as a backstop
end;
$$;

revoke all on function public.sd_pin_participant() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Catalog-only assertions (safe on an empty database).
-- ---------------------------------------------------------------------------
do $$
declare
  fn record;
  f text;
begin
  foreach f in array array['sd_pin_participant()', 'sd_participants_insert_guard()',
                           'sd_registration_status(uuid,text,uuid)']
  loop
    select p.prosecdef, p.provolatile, p.proconfig, p.proacl::text as acl
      into fn
    from pg_proc p where p.oid = ('public.' || f)::regprocedure;

    if not fn.prosecdef then raise exception '% must be SECURITY DEFINER', f; end if;
    if fn.provolatile <> 'v' then raise exception '% must be VOLATILE (docs/03 #30)', f; end if;
    if not ('search_path=public' = any (fn.proconfig)) then raise exception '% lost its pinned search_path', f; end if;
    if fn.acl is null then raise exception '% has a NULL ACL (= PUBLIC EXECUTE)', f; end if;
    if fn.acl ~ '(anon|authenticated|service_role)=' or fn.acl ~ '(^|[{,])=X' then
      raise exception '% grants EXECUTE to an API role or PUBLIC: %', f, fn.acl;
    end if;
  end loop;

  if not exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.sd_participants'::regclass and t.tgname = 'sd_participants_a_pin'
      and t.tgfoid = 'public.sd_pin_participant()'::regprocedure and t.tgenabled = 'O'
  ) then
    raise exception 'sd_participants_a_pin is not bound and enabled';
  end if;
  if not exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.sd_participants'::regclass and t.tgname = 'sd_participants_b_insert_guard'
      and t.tgfoid = 'public.sd_participants_insert_guard()'::regprocedure and t.tgenabled = 'O'
  ) then
    raise exception 'sd_participants_b_insert_guard is not bound and enabled';
  end if;
end $$;
