-- SPEED DATING HARDENING (2026-10-17). Companion to 20261017010000 (which
-- owns sd_participants' self-registration and self-edit rules). Every item
-- below came out of the adversarial reviews of that migration.
--
-- 1. [CRITICAL, cross-org read] sd_mentors() trusted a mentor seat's
--    mentee_participant_id. Nothing checked that the mentee was in the SAME
--    event (or org), nor that the mentee had consented (allows_mentor). An
--    organizer of org A (sd_participants_write_organize, which also skips the
--    pin trigger) — or, before 20261017010000, a self-inserting participant —
--    could create a mentor seat pointing at ANY seat id in ANY org and then
--    SELECT that person's row, profile and profile_card through
--    sd_participants_select's `sd_mentors(id)` arm. Fixed at BOTH layers:
--      (a) sd_participants_c_integrity (BEFORE INSERT OR UPDATE, every
--          caller including no-JWT): a mentee pointer must name a
--          'participant' seat in the SAME event that has allows_mentor, and
--          only a 'mentor' seat may carry one;
--      (b) sd_mentors() itself now requires mentee.event_id = mentor.event_id,
--          mentee.org_id = mentor.org_id and mentee.allows_mentor (so a
--          withdrawn consent stops the read at once, and any row that predates
--          (a) is inert).
--    Sibling reviewed: sd_paired_with() trusts sd_pairings, whose rows are
--    integrity-checked by sd_pairings_before_write (both seats in the round's
--    event) and organizer-only. Belt and braces: it now also requires
--    pr.event_id = me.event_id.
-- 9. [LOW] An organizer could seat a user who is NOT an active org member.
--    The same integrity trigger refuses it (on INSERT, and on an UPDATE that
--    changes user_id or event_id) for callers with a JWT. It reads
--    org_members DIRECTLY for the seat's user — is_org_member is caller-
--    relative and cannot answer about a third party (docs/03 #29). No-JWT
--    callers (seed, worker) are trusted, as everywhere else.
-- 4. [LOW-MED] sd_interest: a rater could mark a target they were never
--    paired with, and from a withdrawn/removed seat — two such marks make a
--    REAL mutual match, and with shareContactOnMatch a contact exchange.
--    sd_interest_before_write now requires, for callers who cannot organize
--    the event: a pairing between rater and target in that event, and the
--    rater seat status 'registered'. Its messages for those callers are
--    generic (they used to confirm whether a seat id exists in an event).
--    The organizer path keeps its old checks and messages.
-- 5. [LOW-MED] sd_reports: sd_pin_report fires on UPDATE only, so a reporter
--    could INSERT state 'dismissed' with a forged reviewed_by/reviewed_at.
--    New sd_reports_b_guard (BEFORE INSERT OR UPDATE): event_id is DERIVED
--    from the reporter's seat; the reported seat and the pairing, if given,
--    must be in that event; and a non-organizer's INSERT is forced to
--    state 'open', reviewed_by/reviewed_at NULL. A REMOVED reporter can still
--    report (decided 2026-09-11: ejection must not remove abuse reporting).
--    sd_notes: new sd_notes_b_guard (BEFORE INSERT, JWT callers): about_user_id
--    must hold a seat in that event and pairing_id, if given, must belong to
--    it. Because it runs before the FK checks and answers generically, a
--    random user id no longer produces the FK error that confirmed whether
--    an account exists.
--    RE-REVIEW (2026-10-17): the first notes guard checked only the SUBJECT's
--    seat, so a seatless author could enumerate any event's registrations
--    from which error came back. Now the AUTHOR's seat (or staff tier) and
--    the event's existence are checked first, and every refusal is the same
--    message; and (final delta review) an author who does not staff the event
--    may only note someone their seat was PAIRED with — otherwise a seated
--    author could still test who else is registered. The reports guard likewise refuses a reporter seat that is not
--    the caller's (unless staff) BEFORE deriving anything, so a foreign seat
--    id no longer leaks its event via the scope trigger. A rater may always
--    RETRACT (update a mark away from 'interested') whatever their seat
--    status, so a withdrawn/removed rater's old 'interested' cannot still
--    produce a match. Reassigning a seat's user_id (organizer) resets
--    allows_mentor/allows_audience, and sd_mentors also requires the mentee
--    seat to be a 'participant'.
-- 6. [LOW] sd_bans.banned_by was client-supplied. sd_bans_a_stamp: on INSERT
--    banned_by := auth.uid(); on UPDATE it is pinned to the stored value
--    (JWT callers; no-JWT backend untouched).
-- 7. [LOW] sd_can_organize_event(org, event) trusted the org it was handed:
--    an organizer of org B passing (B, <org-A event id>) got TRUE. It now
--    reads the event's own org and scope node and returns FALSE when the
--    argument disagrees. When the event does not exist (yet) it keeps its old
--    answer, module_caller_covers_rank(org, …, NULL node, 2) — i.e. org admin
--    of the GIVEN org — because an INSERT … RETURNING on sd_events evaluates
--    the select policy before the new row is visible to that lookup; there is
--    no other event to confuse it with, so this cannot cross orgs.
--    sd_can_staff_event_of had the same shape on its host arm; fixed alike.
--    Signatures, STABLE and EXECUTE grants are unchanged (many policies call
--    them).
-- 8. [LOW] sd_pairings_before_write (definer) raised "Participant % is not in
--    event %" / "already paired" BEFORE RLS refused a non-organizer, so any
--    caller could probe seat ids. A caller with a JWT who cannot organize the
--    round's event now gets one generic error at the top.
--
-- NOT CHANGED, and why: sd_matches_before_write has the same pre-RLS message
-- shape, but sd_sync_mutual_match inserts sd_matches from inside a definer
-- trigger while auth.uid() is still the PARTICIPANT, so an organizer-only
-- gate there would break every mutual match. Its messages only fire for a
-- direct INSERT that RLS refuses anyway; recorded, not fixed.
--
-- ACL: trigger functions hold no API-role EXECUTE; the four policy helpers
-- keep exactly authenticated + service_role. Every ACL is restated
-- (revoke from public, anon, authenticated, service_role first — docs/03 #27).
-- Applies cleanly to an EMPTY database (catalog-only assertions); idempotent.

-- ---------------------------------------------------------------------------
-- 1 + 9. sd_participants integrity (mentee pointer, org membership).
-- ---------------------------------------------------------------------------
create or replace function public.sd_participants_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ev_org uuid;
begin
  select e.org_id into ev_org from public.sd_events e where e.id = new.event_id;
  if ev_org is null then
    return new;   -- sd_participants_scope raises 'Unknown event'
  end if;

  -- A seat handed to a different person does not carry the old holder's
  -- consents (otherwise a mentor would read the NEW person's card).
  if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id then
    new.allows_mentor := false;
    new.allows_audience := false;
  end if;

  if new.mentee_participant_id is not null
     and (tg_op = 'INSERT'
          or new.mentee_participant_id is distinct from old.mentee_participant_id
          or new.event_id is distinct from old.event_id
          or new.seat_type is distinct from old.seat_type)
  then
    if new.seat_type is distinct from 'mentor' or not exists (
      select 1 from public.sd_participants t
      where t.id = new.mentee_participant_id
        and t.id is distinct from new.id
        and t.event_id = new.event_id
        and t.seat_type = 'participant'
        and t.allows_mentor
    ) then
      raise exception 'A mentor seat must point at a consenting participant in the same event';
    end if;
  end if;

  if auth.uid() is not null
     and (tg_op = 'INSERT'
          or new.user_id is distinct from old.user_id
          or new.event_id is distinct from old.event_id)
     and not exists (
       select 1 from public.org_members om
       where om.org_id = ev_org and om.user_id = new.user_id and om.status = 'active'
     )
  then
    raise exception 'Only active members of this organization can be seated';
  end if;

  return new;
end;
$$;

revoke all on function public.sd_participants_integrity() from public, anon, authenticated, service_role;

drop trigger if exists sd_participants_c_integrity on public.sd_participants;
create trigger sd_participants_c_integrity
  before insert or update on public.sd_participants
  for each row execute function public.sd_participants_integrity();

create or replace function public.sd_mentors(check_participant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.sd_participants m
    join public.sd_participants t on t.id = m.mentee_participant_id
    where m.mentee_participant_id = check_participant_id
      and m.user_id = auth.uid()
      and m.seat_type = 'mentor'
      and t.event_id = m.event_id
      and t.org_id = m.org_id
      and t.seat_type = 'participant'
      and t.allows_mentor
      and public.is_org_member(m.org_id)
  );
$$;

create or replace function public.sd_paired_with(check_participant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.sd_pairings pr
    join public.sd_participants me on me.user_id = auth.uid()
    where public.is_org_member(me.org_id)
      and pr.event_id = me.event_id
      and (
        (pr.participant_a_id = check_participant_id and pr.participant_b_id = me.id)
        or (pr.participant_b_id = check_participant_id and pr.participant_a_id = me.id)
      )
  );
$$;

-- ---------------------------------------------------------------------------
-- 7. Authority helpers derive the org from the event.
-- ---------------------------------------------------------------------------
create or replace function public.sd_can_organize_event(check_org_id uuid, check_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (select 1 from public.sd_events e where e.id = check_event_id) then
      coalesce((
        select public.module_caller_covers_rank(e.org_id, 'speed-dating', e.scope_node_id, 2)
        from public.sd_events e
        where e.id = check_event_id and e.org_id = check_org_id
      ), false)
    else
      public.module_caller_covers_rank(check_org_id, 'speed-dating', null, 2)
  end;
$$;

create or replace function public.sd_can_staff_event_of(check_org_id uuid, check_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.sd_can_organize_event(check_org_id, check_event_id)
      or exists (
           select 1 from public.sd_events e
           where e.id = check_event_id
             and e.org_id = check_org_id
             and public.module_caller_covers_role(e.org_id, 'speed-dating', e.scope_node_id, 'host')
         );
$$;

do $$
declare f text;
begin
  foreach f in array array['sd_mentors(uuid)', 'sd_paired_with(uuid)',
                           'sd_can_organize_event(uuid,uuid)', 'sd_can_staff_event_of(uuid,uuid)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated, service_role', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 4. sd_interest: paired, registered rater.
-- ---------------------------------------------------------------------------
create or replace function public.sd_interest_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.sd_participants%rowtype;
  organizer boolean;
begin
  select * into p from public.sd_participants where id = new.rater_participant_id;
  organizer := auth.uid() is null
               or (p.id is not null and public.sd_can_organize_event(p.org_id, p.event_id));

  -- Retraction is always allowed: moving an EXISTING mark away from
  -- 'interested' (ids are pinned by sd_pin_interest; RLS sd_interest_update_own
  -- limits it to the rater) needs no pairing or registered seat, so a
  -- withdrawn/removed rater can still take back an 'interested' and
  -- sd_sync_mutual_match deletes the unrevealed match.
  if not organizer and not (tg_op = 'UPDATE' and new.verdict <> 'interested') then
    -- One generic answer: no seat-id / event-membership oracle.
    if p.id is null
       or p.status is distinct from 'registered'
       or new.rater_participant_id = new.target_participant_id
       or not exists (
         select 1 from public.sd_pairings pr
         where pr.event_id = p.event_id
           and ((pr.participant_a_id = new.rater_participant_id and pr.participant_b_id = new.target_participant_id)
             or (pr.participant_a_id = new.target_participant_id and pr.participant_b_id = new.rater_participant_id))
       )
    then
      raise exception 'You can only record interest in someone you met at this event';
    end if;
  end if;

  if p.id is null then
    raise exception 'Unknown rater participant %', new.rater_participant_id;
  end if;
  new.org_id := p.org_id;
  new.event_id := p.event_id;

  if new.rater_participant_id = new.target_participant_id then
    raise exception 'A participant cannot record interest in themselves';
  end if;

  if not exists (
    select 1 from public.sd_participants t
    where t.id = new.target_participant_id and t.event_id = new.event_id
  ) then
    raise exception 'Target % is not in event %', new.target_participant_id, new.event_id;
  end if;

  return new;
end;
$$;

revoke all on function public.sd_interest_before_write() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. sd_reports and sd_notes.
-- ---------------------------------------------------------------------------
create or replace function public.sd_reports_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  rep public.sd_participants%rowtype;
begin
  select * into rep from public.sd_participants where id = new.reporter_participant_id;
  -- FIRST, before deriving anything: the reporter seat must be the caller's
  -- own (or the caller staffs the event — hosts triage via UPDATE). Otherwise
  -- the same 'Invalid report' for every case, so a foreign seat id reveals
  -- nothing (not even its event, via the scope trigger's 'Unknown event').
  if rep.id is null
     or (auth.uid() is not null
         and rep.user_id is distinct from auth.uid()
         and not public.sd_can_staff_event_of(rep.org_id, rep.event_id))
  then
    raise exception 'Invalid report';
  end if;
  new.event_id := rep.event_id;   -- derived, never client-chosen

  if new.reported_participant_id is not null and not exists (
    select 1 from public.sd_participants t
    where t.id = new.reported_participant_id and t.event_id = rep.event_id
  ) then
    raise exception 'Invalid report';
  end if;

  if new.pairing_id is not null and not exists (
    select 1 from public.sd_pairings pr
    where pr.id = new.pairing_id and pr.event_id = rep.event_id
  ) then
    raise exception 'Invalid report';
  end if;

  if tg_op = 'INSERT' and auth.uid() is not null
     and not public.sd_can_organize_event(rep.org_id, rep.event_id)
  then
    new.state := 'open';
    new.reviewed_by := null;
    new.reviewed_at := null;
  end if;

  return new;
end;
$$;

revoke all on function public.sd_reports_guard() from public, anon, authenticated, service_role;

-- After sd_reports_a_pin (UPDATE pins), before sd_reports_scope (org from event).
drop trigger if exists sd_reports_b_guard on public.sd_reports;
create trigger sd_reports_b_guard
  before insert or update on public.sd_reports
  for each row execute function public.sd_reports_guard();

create or replace function public.sd_notes_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  -- ONE message for every refusal, author check FIRST: "unknown event",
  -- "not your event" and "subject not in event" are indistinguishable, so
  -- notes cannot be used to enumerate who is registered anywhere. (Before
  -- this, a seatless author learned the subject's registration from which
  -- error came back — this one, or the scope trigger's 'Unknown event'.)
  if not exists (
       select 1 from public.sd_events e
       where e.id = new.event_id
         and (exists (select 1 from public.sd_participants a
                      where a.event_id = e.id and a.user_id = auth.uid())
              or public.sd_can_staff_event_of(e.org_id, e.id))
     )
     or not exists (
       select 1 from public.sd_participants s
       where s.event_id = new.event_id and s.user_id = new.about_user_id
     )
     -- Non-staff authors: only about someone they were PAIRED with (the UI's
     -- "People you met"), or a note would test whether anyone is registered.
     or (not public.sd_can_staff_event_of(
               (select e.org_id from public.sd_events e where e.id = new.event_id), new.event_id)
         and not exists (
           select 1
           from public.sd_participants a
           join public.sd_participants s
             on s.event_id = a.event_id and s.user_id = new.about_user_id
           join public.sd_pairings pr
             on pr.event_id = a.event_id
            and ((pr.participant_a_id = a.id and pr.participant_b_id = s.id)
              or (pr.participant_a_id = s.id and pr.participant_b_id = a.id))
           where a.event_id = new.event_id and a.user_id = auth.uid()
         ))
     or (new.pairing_id is not null and not exists (
       select 1 from public.sd_pairings pr
       where pr.id = new.pairing_id and pr.event_id = new.event_id
     ))
  then
    raise exception 'You can only keep notes about someone at this event';
  end if;
  return new;
end;
$$;

revoke all on function public.sd_notes_guard() from public, anon, authenticated, service_role;

-- UPDATE is already pinned by sd_notes_a_pin (about/event/pairing).
drop trigger if exists sd_notes_b_guard on public.sd_notes;
create trigger sd_notes_b_guard
  before insert on public.sd_notes
  for each row execute function public.sd_notes_guard();

-- ---------------------------------------------------------------------------
-- 6. sd_bans.banned_by is server-stamped.
-- ---------------------------------------------------------------------------
create or replace function public.sd_bans_stamp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.banned_by := auth.uid();
  else
    new.banned_by := old.banned_by;
  end if;
  return new;
end;
$$;

revoke all on function public.sd_bans_stamp() from public, anon, authenticated, service_role;

drop trigger if exists sd_bans_a_stamp on public.sd_bans;
create trigger sd_bans_a_stamp
  before insert or update on public.sd_bans
  for each row execute function public.sd_bans_stamp();

-- ---------------------------------------------------------------------------
-- 8. sd_pairings: no pre-RLS oracle for non-organizers.
-- ---------------------------------------------------------------------------
create or replace function public.sd_pairings_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare r public.sd_rounds%rowtype;
begin
  select * into r from public.sd_rounds where id = new.round_id;

  if auth.uid() is not null
     and (r.id is null or not public.sd_can_organize_event(r.org_id, r.event_id))
  then
    raise exception 'Not allowed to write pairings';
  end if;

  if r.id is null then
    raise exception 'Unknown round %', new.round_id;
  end if;
  new.org_id := r.org_id;
  new.event_id := r.event_id;

  if not exists (
    select 1 from public.sd_participants p
    where p.id = new.participant_a_id and p.event_id = new.event_id
  ) then
    raise exception 'Participant % is not in event %', new.participant_a_id, new.event_id;
  end if;

  if new.participant_b_id is not null and not exists (
    select 1 from public.sd_participants p
    where p.id = new.participant_b_id and p.event_id = new.event_id
  ) then
    raise exception 'Participant % is not in event %', new.participant_b_id, new.event_id;
  end if;

  -- Cross-slot double-booking within the round (T5).
  if exists (
    select 1 from public.sd_pairings x
    where x.round_id = new.round_id
      and x.id is distinct from new.id
      and (
        x.participant_a_id in (new.participant_a_id, new.participant_b_id)
        or x.participant_b_id in (new.participant_a_id, new.participant_b_id)
      )
  ) then
    raise exception 'A participant is already paired in round %', new.round_id;
  end if;

  return new;
end;
$$;

revoke all on function public.sd_pairings_before_write() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Catalog-only assertions (safe on an empty database).
-- ---------------------------------------------------------------------------
do $$
declare
  fn record;
  f text;
  t text[];
begin
  foreach f in array array['sd_participants_integrity()', 'sd_interest_before_write()', 'sd_reports_guard()',
                           'sd_notes_guard()', 'sd_bans_stamp()', 'sd_pairings_before_write()']
  loop
    select p.prosecdef, p.provolatile, p.proconfig, p.proacl::text as acl into fn
    from pg_proc p where p.oid = ('public.' || f)::regprocedure;
    if not fn.prosecdef then raise exception '% must be SECURITY DEFINER', f; end if;
    if fn.provolatile <> 'v' then raise exception '% must be VOLATILE', f; end if;
    if not ('search_path=public' = any (fn.proconfig)) then raise exception '% lost search_path', f; end if;
    if fn.acl is null or fn.acl ~ '(anon|authenticated|service_role)=' or fn.acl ~ '(^|[{,])=X' then
      raise exception '% has an API-role/PUBLIC EXECUTE: %', f, fn.acl;
    end if;
  end loop;

  foreach f in array array['sd_mentors(uuid)', 'sd_paired_with(uuid)',
                           'sd_can_organize_event(uuid,uuid)', 'sd_can_staff_event_of(uuid,uuid)']
  loop
    select p.prosecdef, p.provolatile, p.proconfig, p.proacl::text as acl into fn
    from pg_proc p where p.oid = ('public.' || f)::regprocedure;
    if not fn.prosecdef or fn.provolatile <> 's' or not ('search_path=public' = any (fn.proconfig)) then
      raise exception '% must stay STABLE SECURITY DEFINER with a pinned search_path', f;
    end if;
    if fn.acl ~ 'anon=' or fn.acl ~ '(^|[{,])=X' or fn.acl !~ 'authenticated=X' or fn.acl !~ 'service_role=X' then
      raise exception '% ACL is not exactly authenticated + service_role: %', f, fn.acl;
    end if;
  end loop;

  foreach t slice 1 in array array[
    array['sd_participants', 'sd_participants_c_integrity', 'sd_participants_integrity()'],
    array['sd_interest', 'sd_interest_scope', 'sd_interest_before_write()'],
    array['sd_reports', 'sd_reports_b_guard', 'sd_reports_guard()'],
    array['sd_notes', 'sd_notes_b_guard', 'sd_notes_guard()'],
    array['sd_bans', 'sd_bans_a_stamp', 'sd_bans_stamp()'],
    array['sd_pairings', 'sd_pairings_scope', 'sd_pairings_before_write()']]
  loop
    if not exists (
      select 1 from pg_trigger tg
      where tg.tgrelid = ('public.' || t[1])::regclass and tg.tgname = t[2]
        and tg.tgfoid = ('public.' || t[3])::regprocedure and tg.tgenabled = 'O'
    ) then
      raise exception 'trigger %.% is not bound to % and enabled', t[1], t[2], t[3];
    end if;
  end loop;
end $$;
