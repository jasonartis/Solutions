-- SPEED DATING: HOST UN-TICK + CAMERA/MIC/CONNECTION STATUS (2026-11-05). Module-6 spec,
-- "NEXT SLICE, HANDED TO AN OPUS SESSION" (2026-11-05). Founder rule: ONLY THE PERSON TICKS
-- THEMSELVES IN; staff may only take a tick away.
--
-- 1. sd_pin_participant — CHECK-IN ON SOMEONE ELSE'S SEAT. One rule for every JWT caller who is
--    not the seat's holder, organizers included, placed BEFORE the organizer early return:
--      * checked_in true -> false is allowed for staff of that event (sd_can_staff_event_of:
--        organizers AND hosts, global or scoped to that event); checked_in_at is then forced to
--        NULL, whatever the caller sent.
--      * checked_in false -> true is REFUSED ("Only the person can check themselves in") — for
--        organizers too. Before, an organizer could set it (the app simply offered no button);
--        now the founder's rule is the database's, not the app's.
--      * checked_in unchanged -> checked_in_at is pinned to OLD (nobody else can move "ready
--        since"; before, an organizer could rewrite it).
--    Before this, a HOST's write to another person's checked_in was silently reverted by the
--    host branch, so the app's update "succeeded" while changing nothing. The host branch keeps
--    its other pins (consents, profile, status = removed only); its two check-in pins are gone
--    because the rule above already decided them.
--    UNCHANGED: the seat holder's own path (any value; time server-stamped; withdrawn seat
--    frozen); the no-JWT path (worker, silhouette, seed) returns first; an INSERT never carries
--    a tick (sd_participants_insert_guard resets it). An event-scoped host for ANOTHER event
--    never reaches this trigger: sd_participants_update_staff (RLS) gives them no row.
--    Body otherwise VERBATIM 20261105010000 (solutions-platform-37's security follow-up).
--
-- 2. sd_device_status — NEW TABLE: what a person's browser reports about their camera,
--    microphone and video connection, so the organizer's Ready board can show "can't see /
--    hear them". ONE ROW PER SEAT (primary key participant_id), overwritten in place, so the
--    table is bounded by the number of seats and holds no history.
--      * camera / mic: 'ok' | 'missing' | 'blocked' | 'unknown'. NO device names, labels or ids.
--      * connection: 'connected' (in the round's video room) | 'reconnecting' (the room's
--        interrupted state) | 'not_in_call' (lobby, break, or left the room).
--      * reported_at: stamped by the SERVER (now()), never by the client. Staleness is read off
--        it ("last seen"): the client heartbeats every 30 s, so the UI treats > 75 s as stale.
--    WRITE PATH: only sd_report_device_status(event, camera, mic, connection), SECURITY DEFINER,
--    which writes the CALLER's own seat at that event and nothing else: the seat must be
--    registered or waitlisted, the caller an active org member, the event open/closed/running.
--    It returns 'saved' | 'unchanged' | 'throttled' | 'refused' (expected outcomes are return
--    values, docs/03 #22; malformed values raise). THROTTLE, server-side: at most one write
--    per seat per 5 s ('throttled' — the client retries a CHANGE after 5 s), and an identical
--    report within 25 s of the last write is not written ('unchanged'), so a 30 s heartbeat
--    always refreshes reported_at. No API role holds INSERT/UPDATE/DELETE on the table.
--    READ: staff of that event (sd_can_staff_event_of — organizer, host, global or scoped;
--    org admins through the same helper) and the person themselves (own row, active member).
--    Other daters: nothing. Another event's scoped host: nothing.
--    LIFETIME (data minimisation — the status only means anything live):
--      * an AFTER UPDATE OF state trigger on sd_events deletes the event's rows when it moves
--        to draft/complete/cancelled; the report function refuses those states, and it reads
--        the event FOR SHARE so a report cannot slip in past that delete (docs/03 #36);
--      * an AFTER UPDATE OF status trigger on sd_participants deletes a seat's row when the seat
--        leaves registered/waitlisted (withdrawn, removed — incl. the silhouette's withdraw);
--        the reporter reads its seat FOR SHARE for the same race reason (review B, LOW);
--      * event / seat / org deletion cascades;
--    NOT DELETED, recorded: when a person leaves the ORG but keeps a live seat, staff still see
--    that seat's last report going stale until the event ends (seats of ex-members are inert,
--    docs/19; the person's own read arm requires membership, and new reports are refused).
--      * ACCOUNT DELETION: machine-derived -> DELETE (docs/21 §7.10, docs/03 #35). One line is
--        added to account_silhouette, whose body is otherwise VERBATIM 20261007090000 (its only
--        definition).
--    NOT an activity event (docs/17): a heartbeat would flood the trail and make someone
--    idling in the lobby read as "active". NOT exported: machine-derived and deleted when the
--    event ends; the export manifest's authorship rule covers what a person ENTERED.
--
-- Every new function: SECURITY DEFINER, VOLATILE, pinned search_path; revoke from every API
-- role before any grant (docs/03 #27). Assertions at the end are catalog-only, so the file
-- applies to an EMPTY database.

-- ---------------------------------------------------------------------------
-- 1. sd_pin_participant: on another person's seat, check-in can only be taken away.
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

  -- Check-in on SOMEONE ELSE's seat (founder 2026-11-05: only the person
  -- ticks themselves in). Before the organizer early return, so it binds
  -- organizers too. Staff of the event may only take a tick AWAY.
  if old.user_id is distinct from auth.uid() then
    if new.checked_in is distinct from old.checked_in then
      if old.checked_in and new.checked_in is false
         and public.sd_can_staff_event_of(old.org_id, old.event_id)
      then
        new.checked_in_at := null;
      else
        raise exception 'Only the person can check themselves in';
      end if;
    else
      new.checked_in_at := old.checked_in_at;
    end if;
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

  -- Host triage: removal, and un-ticking (decided above); nothing else on
  -- someone else's row.
  if public.sd_can_staff_event_of(old.org_id, old.event_id) and old.user_id <> auth.uid() then
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
-- 2. sd_device_status: one row per seat, written only by its holder through
--    sd_report_device_status, read by the event's staff and the holder.
-- ---------------------------------------------------------------------------
create table public.sd_device_status (
  participant_id uuid primary key references public.sd_participants (id) on delete cascade,
  org_id uuid not null references public.orgs (id) on delete cascade,
  event_id uuid not null references public.sd_events (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  camera text not null check (camera in ('ok', 'missing', 'blocked', 'unknown')),
  mic text not null check (mic in ('ok', 'missing', 'blocked', 'unknown')),
  connection text not null check (connection in ('connected', 'reconnecting', 'not_in_call')),
  reported_at timestamptz not null default now()
);

comment on table public.sd_device_status is
  'Speed dating: the latest camera/mic/connection status a person''s browser reported for their seat (one row per seat, overwritten). Written only by sd_report_device_status; read by event staff and the person. No device names. Deleted when the event leaves open/closed/running, and by the account silhouette.';

create index sd_device_status_event_idx on public.sd_device_status (event_id);
create index sd_device_status_user_idx on public.sd_device_status (user_id);

alter table public.sd_device_status enable row level security;

-- docs/03 #27: the whole ACL, every role, revoke first.
revoke all privileges on public.sd_device_status from public, anon, authenticated, service_role;
grant select on public.sd_device_status to authenticated;

create policy sd_device_status_select on public.sd_device_status
  for select using (
    public.sd_can_staff_event_of(org_id, event_id)
    or (user_id = auth.uid() and public.is_org_member(org_id))
  );
-- No insert/update/delete policy and no such grant: the definer below is the
-- only writer; the event trigger, cascades and the silhouette are the only
-- deleters.

create or replace function public.sd_report_device_status(
  p_event_id uuid, p_camera text, p_mic text, p_connection text
)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  seat_id uuid;
  seat_status text;
  seat_org uuid;
  ev_state text;
  cur record;
begin
  if me is null then
    return 'refused';
  end if;
  if p_camera is null or p_camera not in ('ok', 'missing', 'blocked', 'unknown')
     or p_mic is null or p_mic not in ('ok', 'missing', 'blocked', 'unknown')
     or p_connection is null or p_connection not in ('connected', 'reconnecting', 'not_in_call')
  then
    raise exception 'Invalid device status';
  end if;

  -- The caller's OWN seat at this event — the only row this function can touch.
  -- FOR SHARE: a concurrent withdraw/removal (whose trigger deletes this
  -- seat's row) waits for this report instead of slipping past it.
  select p.id, p.status, p.org_id into seat_id, seat_status, seat_org
  from public.sd_participants p
  where p.event_id = p_event_id and p.user_id = me
  for share;
  if seat_id is null then
    return 'refused';
  end if;

  -- FOR SHARE (docs/03 #36): conflicts with the state UPDATE whose trigger
  -- clears this event's rows, so a report cannot land after that delete.
  select e.state into ev_state from public.sd_events e where e.id = p_event_id for share;

  if ev_state is null or ev_state not in ('open', 'closed', 'running')
     or seat_status not in ('registered', 'waitlisted')
     or not public.is_org_member(seat_org)
  then
    return 'refused';
  end if;

  select d.camera, d.mic, d.connection, d.reported_at into cur
  from public.sd_device_status d
  where d.participant_id = seat_id
  for update;

  if found then
    if cur.reported_at > now() - interval '5 seconds' then
      return 'throttled';
    end if;
    if cur.camera = p_camera and cur.mic = p_mic and cur.connection = p_connection
       and cur.reported_at > now() - interval '25 seconds'
    then
      return 'unchanged';
    end if;
    update public.sd_device_status
       set camera = p_camera, mic = p_mic, connection = p_connection, reported_at = now()
     where participant_id = seat_id;
    return 'saved';
  end if;

  insert into public.sd_device_status (participant_id, org_id, event_id, user_id, camera, mic, connection, reported_at)
  values (seat_id, seat_org, p_event_id, me, p_camera, p_mic, p_connection, now())
  on conflict (participant_id) do nothing;
  if not found then
    return 'throttled';   -- a concurrent first report won the insert
  end if;
  return 'saved';
end;
$$;

revoke all on function public.sd_report_device_status(uuid, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.sd_report_device_status(uuid, text, text, text) to authenticated;

-- An event leaving the live states takes its status rows with it.
create or replace function public.sd_events_clear_device_status()
returns trigger
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if new.state in ('draft', 'complete', 'cancelled')
     and new.state is distinct from old.state
  then
    delete from public.sd_device_status where event_id = new.id;
  end if;
  return null;
end;
$$;

revoke all on function public.sd_events_clear_device_status() from public, anon, authenticated, service_role;

create trigger sd_events_zz_clear_device_status
  after update of state on public.sd_events
  for each row execute function public.sd_events_clear_device_status();

-- A seat leaving registered/waitlisted takes its status row with it.
create or replace function public.sd_participants_clear_device_status()
returns trigger
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if new.status not in ('registered', 'waitlisted')
     and new.status is distinct from old.status
  then
    delete from public.sd_device_status where participant_id = new.id;
  end if;
  return null;
end;
$$;

revoke all on function public.sd_participants_clear_device_status() from public, anon, authenticated, service_role;

create trigger sd_participants_zz_clear_device_status
  after update of status on public.sd_participants
  for each row execute function public.sd_participants_clear_device_status();

-- ---------------------------------------------------------------------------
-- 3. account_silhouette: sd_device_status is machine-derived -> DELETE.
--    Body VERBATIM 20261007090000 plus that one line.
-- ---------------------------------------------------------------------------
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
  delete from public.sd_device_status where user_id = target;   -- 20261109010000
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

revoke all on function public.account_silhouette(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Catalog-only assertions (safe on an empty database).
-- ---------------------------------------------------------------------------
do $$
declare
  fn record;
  f text;
  acl_row record;
begin
  -- Definers: SECURITY DEFINER, VOLATILE, pinned search_path, no API EXECUTE
  -- except the one entry point (authenticated only).
  foreach f in array array['sd_pin_participant()', 'sd_events_clear_device_status()',
                           'sd_participants_clear_device_status()',
                           'account_silhouette(uuid)', 'sd_report_device_status(uuid,text,text,text)']
  loop
    select p.prosecdef, p.provolatile, p.proconfig, p.proacl::text as acl
      into fn
    from pg_proc p where p.oid = ('public.' || f)::regprocedure;

    if not fn.prosecdef then raise exception '% must be SECURITY DEFINER', f; end if;
    if fn.provolatile <> 'v' then raise exception '% must be VOLATILE (docs/03 #30)', f; end if;
    if not ('search_path=public' = any (fn.proconfig)) then raise exception '% lost its pinned search_path', f; end if;
    if fn.acl is null then raise exception '% has a NULL ACL (= PUBLIC EXECUTE)', f; end if;
    if fn.acl ~ '(anon|service_role)=' or fn.acl ~ '(^|[{,])=X' then
      raise exception '% grants EXECUTE to anon, service_role or PUBLIC: %', f, fn.acl;
    end if;
    if f = 'sd_report_device_status(uuid,text,text,text)' then
      if fn.acl !~ 'authenticated=X' then raise exception '% must be executable by authenticated: %', f, fn.acl; end if;
    elsif fn.acl ~ 'authenticated=' then
      raise exception '% grants EXECUTE to authenticated: %', f, fn.acl;
    end if;
  end loop;

  if (select prosrc from pg_proc where oid = 'public.sd_pin_participant()'::regprocedure)
     not like '%Only the person can check themselves in%' then
    raise exception 'sd_pin_participant lacks the check-in rule';
  end if;
  if (select prosrc from pg_proc where oid = 'public.sd_pin_participant()'::regprocedure)
     not like '%cannot be given to another person%' then
    raise exception 'sd_pin_participant lost 20261105010000''s user_id refusal';
  end if;
  if (select prosrc from pg_proc where oid = 'public.account_silhouette(uuid)'::regprocedure)
     not like '%delete from public.sd_device_status where user_id = target%' then
    raise exception 'account_silhouette does not delete sd_device_status';
  end if;

  -- The table: RLS on, exactly one policy (SELECT), and the ACL stated in full.
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.sd_device_status'::regclass) then
    raise exception 'sd_device_status: RLS is off';
  end if;
  if (select count(*) from pg_policy p where p.polrelid = 'public.sd_device_status'::regclass) <> 1
     or not exists (select 1 from pg_policy p
                    where p.polrelid = 'public.sd_device_status'::regclass
                      and p.polname = 'sd_device_status_select' and p.polcmd = 'r')
  then
    raise exception 'sd_device_status must have exactly one policy, sd_device_status_select (SELECT)';
  end if;
  for acl_row in
    select r.rolname,
           array(select x from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) x
                 where has_table_privilege(r.oid, 'public.sd_device_status', x)) as privs
    from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role')
  loop
    if acl_row.rolname = 'authenticated' and acl_row.privs <> array['SELECT'] then
      raise exception 'sd_device_status: authenticated must hold exactly SELECT, holds %', acl_row.privs;
    elsif acl_row.rolname <> 'authenticated' and cardinality(acl_row.privs) > 0 then
      raise exception 'sd_device_status: % must hold nothing, holds %', acl_row.rolname, acl_row.privs;
    end if;
  end loop;

  -- Triggers bound and enabled.
  if not exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.sd_participants'::regclass and t.tgname = 'sd_participants_a_pin'
      and t.tgfoid = 'public.sd_pin_participant()'::regprocedure and t.tgenabled = 'O'
  ) then
    raise exception 'sd_participants_a_pin is not bound and enabled';
  end if;
  if not exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.sd_events'::regclass and t.tgname = 'sd_events_zz_clear_device_status'
      and t.tgfoid = 'public.sd_events_clear_device_status()'::regprocedure and t.tgenabled = 'O'
  ) then
    raise exception 'sd_events_zz_clear_device_status is not bound and enabled';
  end if;
  if not exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.sd_participants'::regclass and t.tgname = 'sd_participants_zz_clear_device_status'
      and t.tgfoid = 'public.sd_participants_clear_device_status()'::regprocedure and t.tgenabled = 'O'
  ) then
    raise exception 'sd_participants_zz_clear_device_status is not bound and enabled';
  end if;
end $$;
