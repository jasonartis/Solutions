-- Two-sided event capacity enforcement works for the registering
-- participant (2026-07-16).
--
-- The two-sided capacity/waitlist feature (modules/speed-dating/ui, shipped
-- 2026-07-16, no migration) is meant to land a registration past a side's
-- capacity as 'waitlisted' instead of 'registered'. It worked for the roster
-- display and the organizer's "Promote next waitlisted" (both run under a
-- staff session that can read every participant row), but the CAPACITY CHECK
-- AT REGISTRATION silently never triggered: registerForEvent counted a side's
-- registered participants under the REGISTERING PARTICIPANT's own session, and
-- sd_participants_select only lets a participant see their OWN row (or staff,
-- or someone they've actually been paired with in a round — neither applies to
-- a fresh registrant). So the count always came back 0 and everyone was
-- accepted as 'registered' regardless of capacity.
--
-- The e2e test caught this before it shipped as "working": a second registrant
-- on a capacity-1 side was wrongly accepted as 'registered'.
--
-- Fix (this migration): a definer function returning ONLY the integer count of
-- registered participants on a side — never the rows, identities, or statuses,
-- just a number the app compares against the capacity it already parsed from
-- sd_events.format. Same reveal-only-the-answer shape as
-- sal_worker_has_time_off / mm_shared_answers, NOT a widening of
-- sd_participants_select (which would expose participant identities to every
-- co-registrant). A count of "how full is this side" is exactly the kind of
-- aggregate a booking UI legitimately shows a registrant; it carries no
-- identity.
--
-- Tenancy: the count is only taken when the caller is a member of the event's
-- org (is_org_member inside the WHERE — the org is derived through the
-- participant's own event, not caller-supplied). A non-member therefore always
-- gets 0 and cannot probe another org's event sizes; and cannot act on it
-- regardless, since the registration insert is independently gated by
-- sd_participants_insert_self (sd_is_participant + user_id = auth.uid()).
create function public.sd_side_registered_count(
  check_event_id uuid,
  check_side text
)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
  from public.sd_participants p
  join public.sd_events e on e.id = p.event_id
  where p.event_id = check_event_id
    and p.pool_side = check_side
    and p.status = 'registered'
    and public.is_org_member(e.org_id);   -- caller must belong to the org
$$;

grant execute on function public.sd_side_registered_count(uuid, text)
  to authenticated, service_role;
