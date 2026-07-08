-- Integration-review additions (2026-07-09 security review of the draft).
-- The draft flagged three column-level / lifecycle guards that RLS cannot
-- express (RLS is row-level) and left them for review. All three are built
-- here as BEFORE UPDATE triggers, mirroring cls_pin_submission_columns and
-- mm_pin_answer_identity. Each was verified live against Postgres before merge.

-- ---------------------------------------------------------------------------
-- 1. Appointment column pins + lifecycle guard (the spec's "tap Complete →
-- locks", plus worker/customer edit boundaries).
--
-- Operators (cashier/manager/admin) keep full control. A worker may only tick
-- the checklist, edit notes, and advance their OWN appointment along its lane
-- (checked_in → in_progress → complete, or → no_show); every other column is
-- pinned and any out-of-lane transition is rejected. A customer may only
-- cancel their own still-booked appointment; everything else is pinned.
--
-- Trigger NAME matters: it must sort BEFORE sal_appointments_scope so a
-- worker/customer's attempt to also change location_id is reverted to OLD
-- *before* the scope trigger derives org_id from location (otherwise org_id
-- would be derived from the client's bogus location and only location_id would
-- be reverted afterward). "sal_appointments_pin" < "sal_appointments_scope".
-- ---------------------------------------------------------------------------
create function public.sal_pin_appointment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Operators have full control (reschedule, reassign, override, bill, pay).
  if public.sal_can_operate(old.org_id) then
    return new;
  end if;

  -- Worker acting on their own appointment.
  if old.worker_id = auth.uid() then
    new.customer_id := old.customer_id;
    new.service_id := old.service_id;
    new.worker_id := old.worker_id;
    new.location_id := old.location_id;
    new.scheduled_start := old.scheduled_start;
    new.scheduled_end := old.scheduled_end;
    new.booked_by := old.booked_by;
    if not (
      (old.state = 'checked_in' and new.state in ('checked_in', 'in_progress', 'no_show'))
      or (old.state = 'in_progress' and new.state in ('in_progress', 'complete'))
    ) then
      raise exception 'Worker cannot move appointment from % to %', old.state, new.state;
    end if;
    return new;
  end if;

  -- Customer acting on their own appointment: cancel-from-booked only.
  if public.sal_owns_customer(old.customer_id) then
    new.customer_id := old.customer_id;
    new.service_id := old.service_id;
    new.worker_id := old.worker_id;
    new.location_id := old.location_id;
    new.scheduled_start := old.scheduled_start;
    new.scheduled_end := old.scheduled_end;
    new.checklist := old.checklist;
    new.booked_by := old.booked_by;
    if not (old.state = 'booked' and new.state in ('booked', 'cancelled')) then
      raise exception 'Customer may only cancel a booked appointment';
    end if;
    return new;
  end if;

  -- Unreachable under the RLS policies, but pin everything as a backstop.
  return old;
end;
$$;

create trigger sal_appointments_pin before update on public.sal_appointments
  for each row execute function public.sal_pin_appointment();

-- ---------------------------------------------------------------------------
-- 2. Bill void/refund gate + paid-bill immutability. The operate policy lets a
-- cashier write bills (normal billing), but voids/refunds are a manager-level,
-- audit-trailed escape hatch, and a locked bill's money must not be editable by
-- a cashier afterward. Audit stamps are set server-side, not trusted from input.
-- ---------------------------------------------------------------------------
create function public.sal_guard_bill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Void/refund transitions require manager tier; stamp the audit fields.
  if new.state in ('void', 'refunded') and old.state is distinct from new.state then
    if not public.sal_can_manage(old.org_id) then
      raise exception 'Only a manager may void or refund a bill';
    end if;
    if new.state = 'void' then
      new.voided_by := auth.uid();
      new.voided_at := coalesce(new.voided_at, now());
    else
      new.refunded_by := auth.uid();
      new.refunded_at := coalesce(new.refunded_at, now());
    end if;
  end if;

  -- Once locked, monetary/payment columns and state are immutable to non-managers.
  if old.state in ('paid', 'void', 'refunded') and not public.sal_can_manage(old.org_id) then
    new.subtotal := old.subtotal;
    new.discount_total := old.discount_total;
    new.total := old.total;
    new.promotion_id := old.promotion_id;
    new.payment_method := old.payment_method;
    new.external_processor := old.external_processor;
    new.external_reference := old.external_reference;
    new.state := old.state;
  end if;

  -- Stamp paid metadata server-side on the transition to paid.
  if new.state = 'paid' and old.state is distinct from 'paid' then
    new.paid_by := coalesce(new.paid_by, auth.uid());
    new.paid_at := coalesce(new.paid_at, now());
  end if;

  return new;
end;
$$;

-- Sort key note: runs after sal_bills_scope is irrelevant here (scope only
-- re-derives org/location from the immutable appointment_id); this guard only
-- reads old.org_id, which the scope trigger doesn't change on update.
create trigger sal_bills_guard before update on public.sal_bills
  for each row execute function public.sal_guard_bill();
