-- Customer self-booking honors worker time off (2026-07-16).
--
-- The per-worker availability feature (modules/nail-salon/ui/availability.ts,
-- shipped 2026-07-16, no migration) enforces a worker's weekly schedule +
-- time off at booking time. It works for OPERATOR and WALK-IN bookings, but
-- the CUSTOMER self-booking path (customerBookAppointment) silently no-ops on
-- the time-off half: assertWorkerAvailable read sal_worker_time_off directly,
-- and that table's SELECT policy (sal_worker_time_off_select) grants read
-- ONLY to operate-tier callers (cashier/manager/admin) or the worker
-- themselves — deliberately, because `reason` can hold sensitive text like
-- "medical leave". So a customer's own RLS-scoped session saw ZERO time-off
-- rows and the check passed trivially, letting a customer book a worker who
-- is on time off. (The weekly_schedule half already works for customers: they
-- CAN read sal_worker_profiles via sal_worker_profiles_select_member.)
--
-- The e2e test caught this before it shipped as "working": booking a worker
-- during their seeded time off succeeded as a customer, failed (correctly) as
-- an operator.
--
-- Fix (this migration): a definer function that answers ONLY the yes/no
-- time-off overlap question. It never returns the rows, the reason, the
-- count, or the boundaries, so a customer's booking honors a worker's time
-- off WITHOUT any time-off detail leaking — the reveal-only-the-answer
-- pattern of mm_shared_answers / cls_material_storage_visible, NOT a widening
-- of sal_worker_time_off's SELECT policy (which would expose `reason`).
--
-- Tenancy: the overlap is only counted when the caller is a member of the org
-- that owns the worker's location. A non-member therefore always gets FALSE
-- ("no overlap"), learning nothing and unable to distinguish "no time off"
-- from "not my org" — and cannot act on it regardless, since the booking
-- insert itself is still gated by sal_appointments_insert_customer
-- (sal_owns_customer). The single bit this can reveal to a MEMBER — "is this
-- co-org worker unavailable in this window" — is exactly what any booking
-- attempt reveals implicitly, and never includes the reason.
create function public.sal_worker_has_time_off(
  check_worker_id uuid,
  check_location_id uuid,
  window_start timestamptz,
  window_end timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.sal_worker_time_off t
    join public.sal_worker_profiles w on w.id = t.worker_profile_id
    join public.sal_locations l on l.id = w.location_id
    where w.user_id = check_worker_id
      and w.location_id = check_location_id
      and public.is_org_member(l.org_id)   -- caller must belong to the org
      -- half-open overlap, identical to the TS overlapsTimeOff():
      -- window and time-off intersect iff each starts before the other ends.
      and window_start < t.ends_at
      and window_end > t.starts_at
  );
$$;

grant execute on function public.sal_worker_has_time_off(uuid, uuid, timestamptz, timestamptz)
  to authenticated, service_role;
