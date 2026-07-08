-- Integration-review additions (2026-07-09 security review of the draft).
-- Builds the draft's flagged TODOs T1–T9 (guards RLS cannot express) plus two
-- reviewer findings: sd_can_manage must delegate to the platform's
-- is_org_admin() (docs/03 convention #9, extracted 20260709040000), and the
-- match reveal needs one audited definer path. Each guard verified live
-- against Postgres before merge.

-- Reviewer finding A: delegate the org-admin tail to the platform helper.
create or replace function public.sd_can_manage(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_admin(check_org_id)
      or public.has_module_role(check_org_id, 'speed-dating', 'admin');
$$;

-- Reviewer finding B (found live): the draft's sd_participants_select checked
-- own-row access via sd_owns_participant(id) — a definer function that queries
-- sd_participants itself. During INSERT ... RETURNING the function's snapshot
-- does NOT include the row being inserted, so a participant's own registration
-- insert failed its RETURNING select. A table's OWN policies must use direct
-- column comparisons (user_id = auth.uid()), not self-referential lookups.
-- (sd_owns_participant stays correct for OTHER tables, whose seats pre-exist.)
drop policy sd_participants_select on public.sd_participants;
create policy sd_participants_select on public.sd_participants
  for select using (
    public.sd_can_staff_event(org_id)
    or user_id = auth.uid()
    or public.sd_paired_with(id)
    or public.sd_mentors(id)
  );

-- ---------------------------------------------------------------------------
-- T1: event state-machine guard. Legal transitions only:
--   draft -> open|cancelled, open -> running|cancelled,
--   running -> complete|cancelled; complete/cancelled are terminal.
-- Fires for the worker too (triggers ignore RLS bypass) — the orchestrator
-- must follow the same lifecycle.
-- ---------------------------------------------------------------------------
create function public.sd_guard_event()
returns trigger
language plpgsql
as $$
begin
  if new.state is distinct from old.state and not (
    (old.state = 'draft' and new.state in ('open', 'cancelled'))
    or (old.state = 'open' and new.state in ('running', 'cancelled'))
    or (old.state = 'running' and new.state in ('complete', 'cancelled'))
  ) then
    raise exception 'Illegal event transition % -> %', old.state, new.state;
  end if;
  return new;
end;
$$;

create trigger sd_events_guard before update on public.sd_events
  for each row execute function public.sd_guard_event();

-- ---------------------------------------------------------------------------
-- T2 + T3: participant column pins. Organizers keep full control. A HOST (staff
-- but not organize) may ONLY flip someone's status to 'removed' (live-console
-- ejection). A self-editor may only touch check-in, consent toggles, and the
-- resume-review profile, plus withdraw — they can NOT change seat/pool/event or
-- self-promote off the waitlist. Named "..._a_pin" to sort alphabetically
-- BEFORE sd_participants_scope so a tampered event_id is reverted to OLD before
-- org_id is derived from it.
-- ---------------------------------------------------------------------------
create function public.sd_pin_participant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.sd_can_organize(old.org_id) then
    return new;
  end if;

  -- Structural identity is pinned for everyone below organize tier.
  new.event_id := old.event_id;
  new.user_id := old.user_id;
  new.seat_type := old.seat_type;
  new.pool_side := old.pool_side;
  new.mentee_participant_id := old.mentee_participant_id;

  -- Host triage: removal only; nothing else on someone else's row.
  if public.sd_can_staff_event(old.org_id) and old.user_id <> auth.uid() then
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

create trigger sd_participants_a_pin before update on public.sd_participants
  for each row execute function public.sd_pin_participant();

-- Host needs an UPDATE path (organize-write doesn't cover host); the pin above
-- narrows it to removal.
create policy sd_participants_update_staff on public.sd_participants
  for update using (public.sd_can_staff_event(org_id))
  with check (public.sd_can_staff_event(org_id));

-- ---------------------------------------------------------------------------
-- T4: rounds — single-active-round invariant + legal transitions
-- (pending -> active -> break|complete, break -> complete).
-- ---------------------------------------------------------------------------
create unique index sd_rounds_one_active on public.sd_rounds (event_id) where state = 'active';

create function public.sd_guard_round()
returns trigger
language plpgsql
as $$
begin
  if new.state is distinct from old.state and not (
    (old.state = 'pending' and new.state = 'active')
    or (old.state = 'active' and new.state in ('break', 'complete'))
    or (old.state = 'break' and new.state = 'complete')
  ) then
    raise exception 'Illegal round transition % -> %', old.state, new.state;
  end if;
  return new;
end;
$$;

create trigger sd_rounds_guard before update on public.sd_rounds
  for each row execute function public.sd_guard_round();

-- ---------------------------------------------------------------------------
-- T5: pairing rotation invariants — a participant sits in at most one room per
-- round. Same-slot duplicates get hard partial-unique guarantees; the cross-slot
-- case (a in one row, b in another) is validated in the before-write trigger,
-- which we extend (create or replace of the draft's function).
-- ---------------------------------------------------------------------------
create unique index sd_pairings_round_a_unique on public.sd_pairings (round_id, participant_a_id);
create unique index sd_pairings_round_b_unique
  on public.sd_pairings (round_id, participant_b_id) where participant_b_id is not null;

create or replace function public.sd_pairings_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare r public.sd_rounds%rowtype;
begin
  select * into r from public.sd_rounds where id = new.round_id;
  if not found then
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

-- ---------------------------------------------------------------------------
-- T6: interest identity pin — a rater cannot repoint an existing mark at a
-- different pair (would corrupt unique(rater,target) + the mutual detector).
-- Sorts BEFORE sd_interest_scope.
-- ---------------------------------------------------------------------------
create function public.sd_pin_interest()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.sd_can_organize(old.org_id) then
    new.rater_participant_id := old.rater_participant_id;
    new.target_participant_id := old.target_participant_id;
  end if;
  return new;
end;
$$;

create trigger sd_interest_a_pin before update on public.sd_interest
  for each row execute function public.sd_pin_interest();

-- ---------------------------------------------------------------------------
-- T7: THE mutual-interest reveal mechanism.
-- Detection is an AFTER trigger on sd_interest (near-live, à la
-- sal_feed_earnings): a new/updated 'interested' verdict checks for the
-- reciprocal 'interested' row and upserts one canonical-ordered match with
-- revealed = FALSE — existence alone leaks nothing (RLS hides unrevealed rows
-- from both parties). If a verdict later moves OFF 'interested' before reveal,
-- the unrevealed match is deleted; a revealed match stays (already seen).
-- The reveal itself is a single audited definer function the organizer calls
-- (typically at event close): flips revealed, stamps matched_at. Contact-share
-- population (spec: per user prefs / organizer designation) happens at the app
-- layer on reveal — there is no share-prefs column in v1.
-- ---------------------------------------------------------------------------
create function public.sd_sync_mutual_match()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  a uuid;
  b uuid;
begin
  a := least(new.rater_participant_id, new.target_participant_id);
  b := greatest(new.rater_participant_id, new.target_participant_id);

  if new.verdict = 'interested' and exists (
    select 1 from public.sd_interest r
    where r.rater_participant_id = new.target_participant_id
      and r.target_participant_id = new.rater_participant_id
      and r.verdict = 'interested'
  ) then
    insert into public.sd_matches (org_id, event_id, participant_a_id, participant_b_id)
    values (new.org_id, new.event_id, a, b)
    on conflict (event_id, participant_a_id, participant_b_id) do nothing;
  elsif new.verdict <> 'interested' then
    delete from public.sd_matches
    where event_id = new.event_id
      and participant_a_id = a
      and participant_b_id = b
      and revealed = false;
  end if;

  return new;
end;
$$;

create trigger sd_interest_mutual after insert or update on public.sd_interest
  for each row execute function public.sd_sync_mutual_match();

-- The audited reveal path. Returns how many matches were revealed.
create function public.sd_reveal_matches(check_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  ev_org uuid;
  cnt integer;
begin
  select org_id into ev_org from public.sd_events where id = check_event_id;
  if not found then
    raise exception 'Unknown event %', check_event_id;
  end if;
  if not public.sd_can_organize(ev_org) then
    raise exception 'Only an organizer may reveal matches';
  end if;

  update public.sd_matches
  set revealed = true, matched_at = coalesce(matched_at, now())
  where event_id = check_event_id and revealed = false;
  get diagnostics cnt = row_count;
  return cnt;
end;
$$;

grant execute on function public.sd_reveal_matches(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- T8: notes — only body may change; the cross-event key (author/about/event)
-- stays stable. Applies to everyone (the author is the only updater anyway).
-- ---------------------------------------------------------------------------
create function public.sd_pin_note()
returns trigger
language plpgsql
as $$
begin
  new.author_user_id := old.author_user_id;
  new.about_user_id := old.about_user_id;
  new.event_id := old.event_id;
  new.pairing_id := old.pairing_id;
  return new;
end;
$$;

create trigger sd_notes_a_pin before update on public.sd_notes
  for each row execute function public.sd_pin_note();

-- ---------------------------------------------------------------------------
-- T9: report triage — a host (staff but not organize) may only change
-- state/review fields, never the report's substance; reviewed_by/reviewed_at
-- stamp server-side on any state change, for hosts AND organizers.
-- ---------------------------------------------------------------------------
create function public.sd_pin_report()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.sd_can_organize(old.org_id) then
    new.reporter_participant_id := old.reporter_participant_id;
    new.reported_participant_id := old.reported_participant_id;
    new.pairing_id := old.pairing_id;
    new.reason := old.reason;
    new.detail := old.detail;
    new.during_call := old.during_call;
  end if;
  if new.state is distinct from old.state then
    new.reviewed_by := auth.uid();
    new.reviewed_at := coalesce(new.reviewed_at, now());
  end if;
  return new;
end;
$$;

create trigger sd_reports_a_pin before update on public.sd_reports
  for each row execute function public.sd_pin_report();
