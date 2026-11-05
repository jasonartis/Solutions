-- SPEED DATING: SECURITY FOLLOW-UP (2026-11-05). Module-6 spec, "SECURITY
-- FOLLOW-UP" (2026-10-22), the three items left after 20261027010000 shipped
-- the event_id half of item 1. Founder triage 2026-10-22: low severity,
-- organizer/seat-holder only, no screen reaches any of them.
--
-- 1. sd_pin_participant: a seat's user_id can no longer change for ANY JWT
--    caller, organizers included. Before, the organizer early return let an
--    organizer hand a seat (with its pool side, check-in, waitlist place) to a
--    different person. sd_participants_integrity already reset the consents
--    on such a move (re-review 3), and finding 9's member check stopped a
--    non-member — but no flow needs it: withdraw/remove and seat the other
--    person. Raises (not a silent pin) so a caller learns the write did not
--    happen. The no-JWT path (trusted backend, account-deletion silhouette)
--    is unaffected: it returns before this check. Body otherwise VERBATIM
--    20261027010000.
--
-- 2. sd_notes_guard: every check is computed into a boolean FIRST — the
--    event/org lookup, the staff check, the author's seat, the subject's
--    seat, the pairing between them and the given pairing_id — and the
--    refusal is raised once. Before, the OR chain short-circuited, so a
--    refusal on the first arm ran fewer queries than one on the last: a
--    timing difference between "you are not at this event" and "you are,
--    but never met them". The message was already identical.
--    NOT closed (review, LOW, unchanged from before): an UNKNOWN event id
--    still costs different work than a known one inside
--    sd_can_organize_event, so a caller with a guessed uuid could tell that
--    an event exists — never who is registered at it. Remaining differences
--    depend only on who the CALLER is (org admin, organizer), which tells the
--    caller nothing about anyone else.
--
-- 3. sd_notes_guard: a pairing_id (when given) must be a pairing between the
--    AUTHOR's seat and the SUBJECT's seat. Before, any pairing in the event
--    passed. The app never sets pairing_id (saveNote omits it), so this only
--    refuses hand-made API writes. A staff author who holds no seat therefore
--    cannot attach a pairing_id; staff notes without one are unchanged.
--
-- Both are trigger functions: SECURITY DEFINER, VOLATILE, pinned search_path,
-- EXECUTE revoked from every API role (asserted at the end, catalog-only, so
-- the file is safe on an empty database).

-- ---------------------------------------------------------------------------
-- 1. sd_pin_participant: user_id is fixed for every JWT caller.
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

  -- A seat never changes hands, for ANY JWT caller (SECURITY FOLLOW-UP item
  -- 1, user_id half; 2026-11-05). Before, the organizer early return below
  -- let an organizer give a seat to another person. No flow needs it.
  if new.user_id is distinct from old.user_id then
    raise exception 'A registration cannot be given to another person';
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
-- 2 + 3. sd_notes_guard: all checks computed, one refusal; the pairing must
-- join the author's seat to the subject's seat.
-- ---------------------------------------------------------------------------
create or replace function public.sd_notes_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ev_org uuid;
  author_seat uuid;
  subject_seat uuid;
  is_staff boolean;
  met boolean;
  pairing_matches boolean;
begin
  if auth.uid() is null then
    return new;
  end if;

  -- Every lookup runs on every path (no short-circuit), so a refusal takes
  -- the same queries whichever check fails. NULL seats simply match nothing.
  select e.org_id into ev_org from public.sd_events e where e.id = new.event_id;
  is_staff := coalesce(public.sd_can_staff_event_of(ev_org, new.event_id), false);

  select a.id into author_seat
  from public.sd_participants a
  where a.event_id = new.event_id and a.user_id = auth.uid();

  select s.id into subject_seat
  from public.sd_participants s
  where s.event_id = new.event_id and s.user_id = new.about_user_id;

  -- Were the author and the subject ever paired at this event?
  met := exists (
    select 1 from public.sd_pairings pr
    where pr.event_id = new.event_id
      and ((pr.participant_a_id = author_seat and pr.participant_b_id = subject_seat)
        or (pr.participant_a_id = subject_seat and pr.participant_b_id = author_seat))
  );

  -- Is the given pairing_id THAT pairing (author's seat <-> subject's seat)?
  pairing_matches := exists (
    select 1 from public.sd_pairings pr
    where pr.id = new.pairing_id
      and pr.event_id = new.event_id
      and ((pr.participant_a_id = author_seat and pr.participant_b_id = subject_seat)
        or (pr.participant_a_id = subject_seat and pr.participant_b_id = author_seat))
  );

  -- ONE message for every refusal: "unknown event", "not your event",
  -- "subject not here", "never met" and "wrong pairing" are indistinguishable,
  -- so notes cannot be used to enumerate who is registered anywhere.
  if not (
       ev_org is not null
       and (author_seat is not null or is_staff)   -- the author is at the event (or staffs it)
       and subject_seat is not null                -- the subject is at the event
       and (is_staff or met)                       -- non-staff: only someone they met
       and (new.pairing_id is null or pairing_matches)
     )
  then
    raise exception 'You can only keep notes about someone at this event';
  end if;
  return new;
end;
$$;
revoke all on function public.sd_notes_guard() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Catalog-only assertions (safe on an empty database).
-- ---------------------------------------------------------------------------
do $$
declare
  fn record;
  f text;
begin
  foreach f in array array['sd_pin_participant()', 'sd_notes_guard()']
  loop
    select p.prosecdef, p.provolatile, p.proconfig, p.proacl::text as acl, p.prosrc
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

  if (select prosrc from pg_proc where oid = 'public.sd_pin_participant()'::regprocedure)
     not like '%cannot be given to another person%' then
    raise exception 'sd_pin_participant lacks the user_id refusal';
  end if;
  if (select prosrc from pg_proc where oid = 'public.sd_notes_guard()'::regprocedure)
     not like '%pairing_matches%' then
    raise exception 'sd_notes_guard lacks the pairing tie';
  end if;

  -- Both triggers still bound and enabled, in their alphabetical order slots.
  if not exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.sd_participants'::regclass and t.tgname = 'sd_participants_a_pin'
      and t.tgfoid = 'public.sd_pin_participant()'::regprocedure and t.tgenabled = 'O'
  ) then
    raise exception 'sd_participants_a_pin is not bound and enabled';
  end if;
  if not exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.sd_notes'::regclass and t.tgname = 'sd_notes_b_guard'
      and t.tgfoid = 'public.sd_notes_guard()'::regprocedure and t.tgenabled = 'O'
  ) then
    raise exception 'sd_notes_b_guard is not bound and enabled';
  end if;
end $$;
