-- Speed dating: the round count a dater sees ("round 2 of N") follows the people actually there
-- (founder 2026-11-05).
--
-- BEFORE: when the first round started, the app overwrote sd_events.rounds_planned (the organizer's
-- cap) with the rounds everyone REGISTERED would need. No-shows left "round 2 of 5" promising rounds
-- that never ran, and the organizer's typed number was lost, so the count could never grow back for
-- a late arrival.
--
-- AFTER: rounds_planned stays exactly as the organizer typed it (a hard stop, unchanged). The new
-- column rounds_expected holds the projected total, recomputed by the app / worker at the start of
-- EVERY round from the people checked in at that moment (and set to the rounds actually run when the
-- rotation runs out early). Daters cannot compute it themselves — RLS rightly hides other people's
-- pairing history from them — so it is stored where they can already read the event.
--
-- Display-only: nothing enforces anything from it. Written by the same callers that already write
-- sd_events (organizers through sd_events_update_organize; the worker through service_role) — table
-- grants already cover a new column, so there is no new grant, no new function, no new policy.
-- PRIVACY: the projection is computed WITHOUT personal blocks, so a change in the count can never
-- reveal that two present people blocked each other.

alter table public.sd_events
  add column rounds_expected integer
  check (rounds_expected is null or (rounds_expected > 0 and rounds_expected <= 99));

comment on column public.sd_events.rounds_expected is
  'Projected total rounds for daters'' "round X of N": recomputed at each round start from who is checked in (blocks ignored). Display only; rounds_planned is the organizer''s cap.';

-- Catalog-only assertions (this must also apply to an EMPTY database, docs/03).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sd_events' and column_name = 'rounds_expected'
      and data_type = 'integer' and is_nullable = 'YES' and column_default is null
  ) then
    raise exception 'sd_events.rounds_expected missing or wrong shape';
  end if;
  -- The organizer's cap is still there and still untouched in shape.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sd_events' and column_name = 'rounds_planned'
  ) then
    raise exception 'sd_events.rounds_planned unexpectedly missing';
  end if;
end;
$$;
