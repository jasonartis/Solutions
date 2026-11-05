-- Speed dating: a seat's side (sd_participants.pool_side) cannot change once the event has run a round
-- (adversarial re-review of 20261107010000, 2026-11-05).
--
-- WHY: in a two-sided event the rotation pairs side A against side B. Moving a seat to the other side after
-- rounds have run silently reshapes the pairing for everyone (the engine would now treat past opposite-side
-- partners as same-side, and vice versa), skews the side counts that capacity and the waitlist are built on,
-- and makes the dater's "round X of N" (sd_events.rounds_expected) wrong, because the history it replays
-- assumes each seat kept its side. The app never changes a side after registration (the edit form locks
-- once rounds exist); only a direct organizer write through the API could. Nothing needs it, so it is
-- refused for EVERY caller, the no-JWT backend included — the rule is about the event, not the caller.
--
-- A NEW trigger + function; sd_pin_participant (redefined by 20261109010000) is not touched. Before any
-- round has run the organizer may still move a seat between sides, as today.

create or replace function public.sd_lock_side_after_rounds()
returns trigger
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if new.pool_side is distinct from old.pool_side
     and exists (select 1 from public.sd_rounds r where r.event_id = old.event_id)
  then
    raise exception 'A side cannot be changed once rounds have run';
  end if;
  return new;
end;
$$;

-- Revoke before grant (docs/03 #27): a trigger function is called by the trigger, never by an API role.
revoke all on function public.sd_lock_side_after_rounds() from public, anon, authenticated, service_role;

create trigger sd_participants_side_lock
  before update of pool_side on public.sd_participants
  for each row execute function public.sd_lock_side_after_rounds();

-- Catalog-only assertions (must also apply to an EMPTY database, docs/03).
do $$
begin
  if not exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.sd_participants'::regclass
      and t.tgname = 'sd_participants_side_lock'
      and t.tgfoid = 'public.sd_lock_side_after_rounds()'::regprocedure
      and t.tgenabled = 'O'
  ) then
    raise exception 'sd_participants_side_lock is not bound';
  end if;
  if not exists (
    select 1 from pg_proc p
    where p.oid = 'public.sd_lock_side_after_rounds()'::regprocedure
      and p.prosecdef and p.proconfig @> array['search_path=public']
  ) then
    raise exception 'sd_lock_side_after_rounds must be SECURITY DEFINER with a pinned search_path';
  end if;
  if has_function_privilege('anon', 'public.sd_lock_side_after_rounds()', 'execute')
     or has_function_privilege('authenticated', 'public.sd_lock_side_after_rounds()', 'execute')
     or has_function_privilege('service_role', 'public.sd_lock_side_after_rounds()', 'execute')
  then
    raise exception 'sd_lock_side_after_rounds must not be executable by an API role';
  end if;
end;
$$;
