-- User model slice 2 — speed-dating scope-awareness by EVENT (docs/15;
-- classroom 20260724010000 + nail-salon 20260726010000 exemplars; delegates to
-- the generic scope-authority primitives extracted in 20260726020000).
--
-- WHAT CHANGES
--   * sd_events gains scope_node_id -> a module_scope_nodes tree. Each event is a
--     ROOT node (no parent), exactly like a salon LOCATION. Minted by a
--     BEFORE-INSERT definer trigger (node id is TRIGGER-OWNED — any client value
--     is ignored), backfilled for existing events. Every other sd_ operational
--     table already carries event_id, so its scope node is resolved via sd_events.
--   * module_position_rank gains a 'speed-dating' block: admin=3 (Coordinator —
--     global speed-dating authority), organizer=2 (Lead — runs an event), host=1
--     (position). participant -> 0 via fallback (end user, invisible to the ladder).
--   * The COARSE sd_can_organize / sd_can_staff_event are redefined off
--     module_roles directly (was has_module_role, which is global-only) so a
--     SCOPED organizer/host still reaches the console; they are used ONLY for
--     console entry + the sd_events INSERT gate now. sd_can_manage is UNCHANGED
--     (org-wide admin for bans/export). New PRECISE sd_can_organize_event /
--     sd_can_staff_event_of check scope coverage against a specific event's node;
--     every per-row organize/staff policy + the three pin triggers + the reveal
--     function are rewritten onto them.
--   * module_can_manage('speed-dating') is set to admin-or-global-admin (export
--     controls are module-wide; an event-scoped organizer must not toggle them) —
--     same shape as the classroom F3 / nail-salon fixes. Behaviour is identical
--     to today (sd_can_manage already resolved to exactly this), just inlined so
--     it stays global even if the coarse gates drift.
--
-- ADDITIVITY / DATA
--   * A GLOBAL grant (scope_ref null) covers every event
--     (module_scope_covers(null,·)=true), so existing global admin/organizer/host
--     grants keep their EXACT org-wide behavior — NO forced grant migration.
--     Speed-dating has no membership-inflation vector (unlike classroom students):
--     a participant's access keys off their sd_participants rows via
--     sd_in_event / sd_owns_participant / sd_paired_with, NOT off grant coverage,
--     so a scoped grant can never confer event access it shouldn't. Backfill only
--     mints event nodes.
--   * Only new capability: a SCOPED organizer/host grant is now enforced to its
--     event (and only that event). Cross-event root data — sd_blocks (personal,
--     cross-event) and sd_bans (org-wide admin ban list) — stays ORG-WIDE
--     unchanged (no event_id; a per-event block/ban would be nonsensical).
--
-- FOLLOW-ON (NOT built here): a per-event staffing UI (assign an organizer/host
-- to a specific event = mint a scoped grant at that event's node) + threading the
-- event_id through the app's page-level sd_can_organize / sd_can_staff_event
-- calls so a scoped organizer only sees their own events in the console. The
-- authority layer below is scope-correct; RLS tests exercise scoped grants as
-- real users. KNOWN LIMITATION: none for storage — speed-dating has NO storage
-- buckets (no recording ever, no participant uploads; confirmed against
-- 20260709050000), so there is no storage-scoping gap.

-- ===========================================================================
-- 1. Event scope nodes
-- ===========================================================================
alter table public.sd_events add column scope_node_id uuid references public.module_scope_nodes (id) on delete set null;

-- Node id is TRIGGER-OWNED (client value ignored — slice-1 item 7 / classroom
-- review Finding 5). An event is a root node in the speed-dating tree. The
-- event's display name is sd_events.name.
create function public.sd_create_event_node()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare nid uuid;
begin
  insert into public.module_scope_nodes (org_id, module_key, name, node_type)
  values (new.org_id, 'speed-dating', new.name, 'event')
  returning id into nid;
  new.scope_node_id := nid;
  return new;
end;
$$;

create trigger sd_events_node before insert on public.sd_events
  for each row execute function public.sd_create_event_node();

do $$
declare e record; nid uuid;
begin
  for e in select id, org_id, name from public.sd_events where scope_node_id is null loop
    insert into public.module_scope_nodes (org_id, module_key, name, node_type)
    values (e.org_id, 'speed-dating', e.name, 'event') returning id into nid;
    update public.sd_events set scope_node_id = nid where id = e.id;
  end loop;
end $$;

-- ===========================================================================
-- 2. Per-module rank — add the speed-dating vocabulary (extends classroom +
--    nail-salon blocks from 20260726010000; all prior blocks restated verbatim).
-- ===========================================================================
create or replace function public.module_position_rank(module_key text, role text)
returns integer
language sql
immutable
as $$
  select coalesce(
    case module_key
      when 'classroom' then case role
        when 'professor' then 2
        when 'ga' then 1
        when 'student' then 1
        else null end
      when 'nail-salon' then case role
        when 'admin' then 3       -- global salon authority (Coordinator tier)
        when 'manager' then 2     -- runs a location (Lead)
        when 'cashier' then 1     -- operate (position)
        when 'worker' then 1      -- operate (position; peer of cashier)
        else null end             -- 'customer' -> 0 via fallback (end user)
      when 'speed-dating' then case role
        when 'admin' then 3       -- global speed-dating authority (Coordinator tier)
        when 'organizer' then 2   -- runs an event (Lead)
        when 'host' then 1        -- lobby/rooms helper (position)
        else null end             -- 'participant' -> 0 via fallback (end user)
      else null
    end,
    public.module_position_rank(role)
  );
$$;

-- ===========================================================================
-- 3. Authority functions
-- ===========================================================================
-- sd_can_manage stays AS-IS (org-wide admin for bans/export — NOT redefined).
--
-- COARSE (any-scope) organize/staff — console entry + the sd_events INSERT gate
-- only. Redefined off module_roles so a SCOPED organizer/host reaches the
-- console; org-wide-precision comes from the _event fns below.
create or replace function public.sd_can_organize(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_admin(check_org_id)
      or exists (
           select 1 from public.module_roles g
           where g.org_id = check_org_id
             and g.module_key = 'speed-dating'
             and g.user_id = auth.uid()
             and public.module_position_rank('speed-dating', g.role) >= 2
         );
$$;

create or replace function public.sd_can_staff_event(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.sd_can_organize(check_org_id)
      or exists (
           select 1 from public.module_roles g
           where g.org_id = check_org_id
             and g.module_key = 'speed-dating'
             and g.user_id = auth.uid()
             and g.role = 'host'
         );
$$;

-- PRECISE: does the caller hold a speed-dating grant (organizer+ / host) whose
-- scope COVERS this specific event's node? Global grant covers every event.
-- Delegates to the generic primitives (20260726020000): resolve event -> node.
create function public.sd_can_organize_event(check_org_id uuid, check_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.module_caller_covers_rank(check_org_id, 'speed-dating',
    (select scope_node_id from public.sd_events where id = check_event_id), 2);
$$;

create function public.sd_can_staff_event_of(check_org_id uuid, check_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.sd_can_organize_event(check_org_id, check_event_id)
      or public.module_caller_covers_role(check_org_id, 'speed-dating',
           (select scope_node_id from public.sd_events where id = check_event_id), 'host');
$$;

grant execute on function public.sd_can_organize_event(uuid, uuid) to authenticated, service_role;
grant execute on function public.sd_can_staff_event_of(uuid, uuid) to authenticated, service_role;

-- Export controls are a module-WIDE setting (org_modules.settings, not per-event)
-- → keep them admin-or-global-admin (has_module_role is global-only), never an
-- event-scoped organizer. Restates module_can_manage (last set in 20260726010000)
-- with ONLY the speed-dating arm changed; all other arms identical. (This is
-- behaviour-identical to today — sd_can_manage already resolved to exactly
-- is_org_admin OR global 'admin' — but inlined so it stays global regardless of
-- the coarse gates above.)
create or replace function public.module_can_manage(check_org_id uuid, check_module_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case check_module_key
    when 'classroom' then
      public.is_org_admin(check_org_id)
      or public.has_module_role(check_org_id, 'classroom', 'professor')
    when 'nail-salon' then
      public.is_org_admin(check_org_id)
      or public.has_module_role(check_org_id, 'nail-salon', 'admin')
      or public.has_module_role(check_org_id, 'nail-salon', 'manager')
    when 'matchmaking' then public.mm_can_manage(check_org_id)
    when 'speed-dating' then
      public.is_org_admin(check_org_id)
      or public.has_module_role(check_org_id, 'speed-dating', 'admin')
    when 'sample' then public.smp_can_manage(check_org_id)
    when 'synagogue-schedules' then
      public.is_org_admin(check_org_id)
      or public.has_module_role(check_org_id, 'synagogue-schedules', 'maker')
    else public.is_org_admin(check_org_id)
  end;
$$;

-- ===========================================================================
-- 4. Rewrite per-row policies onto the scope-precise functions.
--    LEFT UNCHANGED (org-wide root / own-row): sd_blocks (all policies),
--    sd_bans_all_manage, sd_notes_all_own, sd_participants_insert_self,
--    sd_participants_update_self, sd_interest_insert_own/_update_own, and every
--    ownership-only arm (kept verbatim below).
-- ===========================================================================

-- 4a. Blanket organize-write: drop all 7 (the FOR ALL loop from 20260709050000),
--     recreate the 6 event_id-bearing tables scope-precise. sd_events is SPLIT
--     below (it has no event_id — it IS the event).
do $$
declare t text;
begin
  foreach t in array array[
    'sd_events', 'sd_participants', 'sd_rounds', 'sd_pairings',
    'sd_interest', 'sd_matches', 'sd_reports']
  loop
    execute format('drop policy %I_write_organize on public.%I;', t, t);
  end loop;
  -- 6 event_id-bearing tables.
  foreach t in array array[
    'sd_participants', 'sd_rounds', 'sd_pairings',
    'sd_interest', 'sd_matches', 'sd_reports']
  loop
    execute format(
      'create policy %I_write_organize on public.%I for all
         using (public.sd_can_organize_event(org_id, event_id))
         with check (public.sd_can_organize_event(org_id, event_id));',
      t, t);
  end loop;
end $$;

-- sd_events: INSERT can't check the not-yet-created event node (its own id isn't
-- visible to the statement snapshot — docs/03 #15). Gate creation on org-admin OR
-- a GLOBAL admin/organizer (has_module_role is global-only) — the same deliberate
-- hardening as nail-salon's sal_locations INSERT (escalation review N1): a future
-- event-scoped organizer must not spawn orphan events it can't manage (a root node
-- it can't cover). UPDATE/DELETE use the event node.
create policy sd_events_insert_organize on public.sd_events
  for insert with check (
    public.is_org_admin(org_id)
    or public.has_module_role(org_id, 'speed-dating', 'admin')
    or public.has_module_role(org_id, 'speed-dating', 'organizer')
  );
create policy sd_events_update_organize on public.sd_events
  for update using (public.sd_can_organize_event(org_id, id))
             with check (public.sd_can_organize_event(org_id, id));
create policy sd_events_delete_organize on public.sd_events
  for delete using (public.sd_can_organize_event(org_id, id));

-- 4b. Select policies — swap ONLY the staff/organize arm to the event-scoped
--     fn; every ownership / seat-holder / reveal arm is preserved VERBATIM.
drop policy sd_events_select on public.sd_events;
create policy sd_events_select on public.sd_events
  for select using (
    public.sd_can_staff_event_of(org_id, id)
    or public.sd_in_event(id)
    or (public.sd_is_participant(org_id) and state in ('open', 'running', 'complete', 'cancelled'))
  );

drop policy sd_participants_select on public.sd_participants;
create policy sd_participants_select on public.sd_participants
  for select using (
    public.sd_can_staff_event_of(org_id, event_id)
    or user_id = auth.uid()
    or public.sd_paired_with(id)
    or public.sd_mentors(id)
  );

drop policy sd_rounds_select on public.sd_rounds;
create policy sd_rounds_select on public.sd_rounds
  for select using (
    public.sd_can_staff_event_of(org_id, event_id)
    or public.sd_in_event(event_id)
  );

drop policy sd_pairings_select on public.sd_pairings;
create policy sd_pairings_select on public.sd_pairings
  for select using (
    public.sd_can_staff_event_of(org_id, event_id)
    or public.sd_owns_participant(participant_a_id)
    or public.sd_owns_participant(participant_b_id)
  );

-- PRIVACY-CRITICAL: the target has NO read path — "one-sided interest reveals
-- nothing". Staff arm scoped to the event; rater own-marks arm kept verbatim.
drop policy sd_interest_select on public.sd_interest;
create policy sd_interest_select on public.sd_interest
  for select using (
    public.sd_can_organize_event(org_id, event_id)
    or public.sd_owns_participant(rater_participant_id)
  );

-- THE REVEAL GATE: a participant sees a match ONLY when a party AND revealed.
-- Organize arm scoped to the event; the reveal arm kept VERBATIM.
drop policy sd_matches_select on public.sd_matches;
create policy sd_matches_select on public.sd_matches
  for select using (
    public.sd_can_organize_event(org_id, event_id)
    or (
      revealed
      and (public.sd_owns_participant(participant_a_id) or public.sd_owns_participant(participant_b_id))
    )
  );

drop policy sd_reports_select on public.sd_reports;
create policy sd_reports_select on public.sd_reports
  for select using (
    public.sd_can_staff_event_of(org_id, event_id)
    or public.sd_owns_participant(reporter_participant_id)
  );

-- 4c. Staff UPDATE paths (host is not in organize-write) -> event-scoped.
drop policy sd_participants_update_staff on public.sd_participants;
create policy sd_participants_update_staff on public.sd_participants
  for update using (public.sd_can_staff_event_of(org_id, event_id))
  with check (public.sd_can_staff_event_of(org_id, event_id));

drop policy sd_reports_update_staff on public.sd_reports;
create policy sd_reports_update_staff on public.sd_reports
  for update using (public.sd_can_staff_event_of(org_id, event_id))
  with check (public.sd_can_staff_event_of(org_id, event_id));

-- ===========================================================================
-- 5. Pin triggers -> event-precise authority (bodies otherwise identical to
--    20260709050000's T2/T3, T6, T9; all read old.org_id + old.event_id already).
-- ===========================================================================
create or replace function public.sd_pin_participant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
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

create or replace function public.sd_pin_interest()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.sd_can_organize_event(old.org_id, old.event_id) then
    new.rater_participant_id := old.rater_participant_id;
    new.target_participant_id := old.target_participant_id;
  end if;
  return new;
end;
$$;

create or replace function public.sd_pin_report()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.sd_can_organize_event(old.org_id, old.event_id) then
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

-- ===========================================================================
-- 6. The mutual-interest reveal — event-precise gate (privacy-critical). Only an
--    organizer of THIS event may reveal its matches. Body otherwise identical to
--    20260709050000's sd_reveal_matches.
-- ===========================================================================
create or replace function public.sd_reveal_matches(check_event_id uuid)
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
  if not public.sd_can_organize_event(ev_org, check_event_id) then
    raise exception 'Only an organizer may reveal matches';
  end if;

  update public.sd_matches
  set revealed = true, matched_at = coalesce(matched_at, now())
  where event_id = check_event_id and revealed = false;
  get diagnostics cnt = row_count;
  return cnt;
end;
$$;
