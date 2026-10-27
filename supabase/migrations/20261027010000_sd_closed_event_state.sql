-- SPEED DATING: A `closed` EVENT STATE — "registration closed, event still alive"
-- (2026-10-27). Founder decision 2026-10-26 (module-6 spec, "HANDOFF 2026-10-26").
--
-- STATE MOVES (sd_guard_event):
--   draft   -> open | cancelled
--   open    -> closed | running | cancelled | draft*
--   closed  -> open (reopen) | running | cancelled | draft*
--   running -> complete | cancelled
--   complete, cancelled: terminal (no un-cancel).
--   * -> draft ONLY when the event has ZERO live seats (registered or
--     waitlisted) and no round. Pulling an event from people who signed up is
--     irreversible for them, so it is refused, not warned ("warn for
--     reversible, refuse for irreversible"). Withdrawn/removed seats do not
--     block it; they stay on the row and may rejoin once it is open again.
--
-- BEHAVIOUR WHILE CLOSED: no new registration of any kind by a person's own
-- act (fresh insert, a withdrawn person's rejoin; self-promotion off the
-- waitlist was never allowed). Withdrawing stays allowed. Organizer acts are
-- unchanged (clearing a removal, promoting a waitlisted person — not a new
-- registration). Start event works from open or closed.
--
-- WHY THE REGISTRATION GATES NEED NO NEW TEST FOR 'closed': both
-- sd_participants_insert_guard and sd_pin_participant's rejoin branch already
-- test `state is distinct from 'open'`, so they refuse closed by construction.
-- They are re-created here for TWO reasons:
--   (1) THE BACK-TO-DRAFT RACE. A dater's INSERT takes only a FOR KEY SHARE
--       lock on the event (the FK check), which does NOT conflict with the
--       organizer's state UPDATE (FOR NO KEY UPDATE). So "organizer counts 0
--       live seats and moves to draft" and "dater sees state open and
--       inserts" could both commit, leaving a live seat on a draft event.
--       Both gates now read the event `FOR SHARE`, which DOES conflict: the
--       loser waits, and under READ COMMITTED re-reads the committed row
--       (dater: sees draft/closed and is refused; organizer: the guard's
--       count is a fresh statement and sees the seat). The same lock makes
--       open -> closed wait for in-flight registrations, so "closed" means
--       closed at commit.
--   (2) A clearer refusal message on a closed event.
--   (3) sd_pin_participant: a seat's event_id can no longer change for any
--       JWT caller, organizers included. Adversarial review (2026-10-27)
--       found an organizer scoped to event X could UPDATE a seat's event_id
--       to a closed event Y and land it 'registered' there (the organizer
--       early return was decided on OLD's event; the Y-side gates live in
--       the INSERT guard). Pre-existing, but it defeats this slice's gate.
--       This is the event_id half of the module-6 spec's queued SECURITY
--       FOLLOW-UP item 1; the user_id half stays queued with the consent
--       work (it cannot bypass the closed gate: reassigning a seat within an
--       event you organize gives nothing an organizer insert does not).
-- Bodies are otherwise VERBATIM 20261017010000.
--
-- KNOWN, NOT CHANGED (review, LOW, pre-existing): sd_events' INSERT policy
-- accepts any initial state, so an organizer may create an event already
-- 'closed'/'running'. Not a hole: a new event has no seats or rounds, so any
-- state it is born in is reachable by legal moves anyway.
--
-- sd_guard_event becomes SECURITY DEFINER: its live-seat count must not be
-- caller-relative (docs/03 #29). It was invoker before, harmless while it read
-- nothing. Trigger function only: EXECUTE revoked from every API role.
--
-- sd_events_select: the participant arm listed visible states explicitly, so a
-- closed event would have VANISHED for daters (a registered person losing the
-- event page). 'closed' is added; every other arm is verbatim
-- 20260726030000.
--
-- AUDITED AND UNCHANGED (each reads state, none needs 'closed'):
--   account-deletion silhouette (`state not in ('complete','cancelled')` —
--   treats closed as live, so a leaving person's seat is withdrawn: correct);
--   sd_side_registered_count (no state test); sd_my_departed_interests
--   ('complete' only); the worker orchestrator and video authorization
--   ('running' only).
--
-- Applies cleanly to an EMPTY database: the assertion block reads only the
-- catalog. Volatility: all plpgsql VOLATILE (docs/03 #30).

-- ---------------------------------------------------------------------------
-- 1. The state CHECK. Dropped by catalog lookup (the inline CHECK's name is
--    generated), then re-added with a fixed name.
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.sd_events'::regclass
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%state%'
      and pg_get_constraintdef(con.oid) like '%draft%'
  loop
    execute format('alter table public.sd_events drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.sd_events
  add constraint sd_events_state_check
  check (state in ('draft', 'open', 'closed', 'running', 'complete', 'cancelled'));

-- ---------------------------------------------------------------------------
-- 2. The state machine.
-- ---------------------------------------------------------------------------
create or replace function public.sd_guard_event()
returns trigger
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if new.state is not distinct from old.state then
    return new;
  end if;

  if not (
    (old.state = 'draft' and new.state in ('open', 'cancelled'))
    or (old.state = 'open' and new.state in ('closed', 'running', 'cancelled', 'draft'))
    or (old.state = 'closed' and new.state in ('open', 'running', 'cancelled', 'draft'))
    or (old.state = 'running' and new.state in ('complete', 'cancelled'))
  ) then
    raise exception 'Illegal event transition % -> %', old.state, new.state;
  end if;

  -- Back to draft only while nobody holds a live seat and no round has run.
  -- Fires for the no-JWT backend too: the rule is about the people, not the
  -- caller.
  if new.state = 'draft' then
    if exists (
      select 1 from public.sd_participants p
      where p.event_id = old.id and p.status in ('registered', 'waitlisted')
    ) or exists (
      select 1 from public.sd_rounds r where r.event_id = old.id
    ) then
      raise exception 'An event with registrations or rounds cannot go back to draft';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.sd_guard_event() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Fresh self-registration guard — verbatim 20261017010000 except the
--    FOR SHARE read of the event and the closed message.
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

  -- FOR SHARE: serialises against a concurrent state change (see header).
  select * into ev from public.sd_events e where e.id = new.event_id for share;

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

  if ev.state = 'closed' then
    raise exception 'Registration for this event is closed';
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

-- ---------------------------------------------------------------------------
-- 4. sd_pin_participant — verbatim 20261017010000 except the rejoin branch's
--    FOR SHARE read of the event and the closed message.
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

  -- A seat never moves to another event, for ANY JWT caller (review finding
  -- 2026-10-27; module-6 spec SECURITY FOLLOW-UP item 1's event_id half). The
  -- organizer early return below is decided on OLD's event, so an organizer
  -- scoped to event X could rewrite a seat's event_id to event Y and land it
  -- 'registered' in Y — skipping Y's closed/open gate, bans and capacity,
  -- which live in the INSERT guard. No flow needs it: delete and re-register.
  if new.event_id is distinct from old.event_id then
    raise exception 'A registration cannot be moved to another event';
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
      return new;   -- from registered or waitlisted (removed handled above); allowed while closed
    end if;

    -- Rejoin: withdrawn -> (registered | waitlisted); the database decides.
    if old.status = 'withdrawn' and new.status in ('registered', 'waitlisted') then
      -- FOR SHARE: serialises against a concurrent state change (see header).
      select e.state into ev_state from public.sd_events e where e.id = old.event_id for share;
      if ev_state = 'closed' then
        raise exception 'Registration for this event is closed';
      end if;
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
-- 5. sd_events_select: daters keep seeing a closed event. Verbatim
--    20260726030000 plus 'closed'.
-- ---------------------------------------------------------------------------
drop policy sd_events_select on public.sd_events;
create policy sd_events_select on public.sd_events
  for select using (
    public.sd_can_staff_event_of(org_id, id)
    or public.sd_in_event(id)
    or (public.sd_is_participant(org_id) and state in ('open', 'closed', 'running', 'complete', 'cancelled'))
  );

-- ---------------------------------------------------------------------------
-- 6. Catalog-only assertions (safe on an empty database).
-- ---------------------------------------------------------------------------
do $$
declare
  fn record;
  f text;
  def text;
begin
  foreach f in array array['sd_guard_event()', 'sd_pin_participant()', 'sd_participants_insert_guard()']
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

  -- Exactly one state CHECK, and it admits 'closed'.
  if (select count(*) from pg_constraint con
      where con.conrelid = 'public.sd_events'::regclass and con.contype = 'c'
        and pg_get_constraintdef(con.oid) like '%draft%') <> 1 then
    raise exception 'sd_events must carry exactly one state CHECK';
  end if;
  select pg_get_constraintdef(con.oid) into def from pg_constraint con
  where con.conrelid = 'public.sd_events'::regclass and con.conname = 'sd_events_state_check';
  if def is null or def not like '%closed%' then
    raise exception 'sd_events_state_check does not admit closed: %', def;
  end if;

  -- The guard is still bound and enabled.
  if not exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.sd_events'::regclass and t.tgname = 'sd_events_guard'
      and t.tgfoid = 'public.sd_guard_event()'::regprocedure and t.tgenabled = 'O'
  ) then
    raise exception 'sd_events_guard is not bound and enabled';
  end if;

  -- Exactly one SELECT policy on sd_events, and it shows closed events.
  if (select count(*) from pg_policies
      where schemaname = 'public' and tablename = 'sd_events' and cmd in ('SELECT', 'ALL')) <> 1 then
    raise exception 'sd_events must have exactly one SELECT-covering policy';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sd_events' and policyname = 'sd_events_select'
      and qual like '%closed%'
  ) then
    raise exception 'sd_events_select does not show closed events';
  end if;
end $$;
