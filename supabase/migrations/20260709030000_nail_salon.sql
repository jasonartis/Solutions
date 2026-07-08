-- Module 5: Nail Salon (key: 'nail-salon', prefix sal_).
-- Spec: docs/modules/module-5-nail-salon.md
--
-- DRAFT for review — NOT applied, NOT wired into supabase/migrations/. Becomes
-- supabase/migrations/<ts>_nail_salon.sql once a human security-reviews it
-- (mirrors how modules/classroom/schema-draft.sql and
-- modules/matchmaking/…  became real migrations, with a schema-fixes pass folded
-- in afterwards). Patterns copied from those exemplars
-- (20260708010000_classroom.sql, 20260709020000_matchmaking.sql):
--   * explicit grants — CLI migrations do NOT inherit Supabase's API-role
--     grants, so every table is granted to authenticated + service_role
--     explicitly before RLS restricts rows (this bit the team before).
--   * RLS enabled on EVERY table.
--   * security-definer helper functions for cross-table role/ownership checks
--     (avoids RLS recursion — see sal_can_manage / sal_owns_customer, modeled on
--     cls_can_manage / mm_can_manage).
--   * updated_at maintained by the shared public.set_updated_at() trigger.
--   * scope-sync BEFORE INSERT/UPDATE triggers that derive org_id (and
--     location_id where a parent implies it) from the FK chain server-side, so
--     a client can never misfile a row into another org/location by supplying a
--     bogus id (the vulnerability class fixed in modules 1 and 2 — see
--     cls_sync_from_* and mm_sync_from_group). Postgres evaluates RLS WITH CHECK
--     AFTER BEFORE triggers, so the derived org_id is what the policy sees.
--
-- Relies on platform objects that already exist:
--   public.is_superadmin(), public.is_org_member(), public.set_updated_at()  (core migration)
--   public.has_module_role(org, module_key, role)                            (module 3 migration)
--
-- Module key used throughout: 'nail-salon'.
-- Role vocabulary (module_roles.role values): 'admin', 'manager', 'cashier',
-- 'worker', 'customer'. RLS tiers built from them:
--   sal_can_manage  = superadmin / org owner-admin / module admin / module manager
--                     (config, overrides, voids/refunds, reporting)
--   sal_can_operate = sal_can_manage OR module cashier
--                     (front-desk: appointments, bills, customers, promotions read)
--   sal_is_worker   = module worker (own schedule only)
--   customer        = has no blanket role gate; sees ONLY rows tied to their own
--                     sal_customers record (sal_owns_customer / sal_owns_bill).
--
-- Data model: org -> locations from day one (decided 2026-07-06) so a salon
-- CHAIN costs a config change, not a migration. Almost every table therefore
-- carries BOTH org_id AND location_id. v1 runs a single location; per-location
-- STAFF scoping (a cashier who works only at location B) is intentionally NOT
-- built — staff RLS is org-wide for now. A location-scoped staff helper
-- (sal_staff_at_location) is the multi-location refinement, deferred until a
-- real chain needs it (CLAUDE.md: never build primitives speculatively).
--
-- Settings (no-show / late-cancel rules, deposit amounts, waitlist handling,
-- expense-category vocabulary, receipt/email templates, assignment-algorithm
-- knobs, online-signup windows) live in org_modules.settings for module_key
-- 'nail-salon' — no ad-hoc config table (docs/03 rule).
--
-- DELIBERATELY NOT BUILT (documented, see spec "Out of v1" / "Future"):
--   * Card PROCESSING. Spec is record-keeping only — cards run on the salon's
--     external machine. sal_bills carries payment_method + external_processor +
--     external_reference from day one so Stripe (or similar) plugs in later
--     without remodeling; no processing integration here.
--   * Notifications / email plumbing (receipts by email, SMS reminders). Those
--     are platform primitives (docs/03 hard-rule #5: all outbound email through
--     the email queue). Receipts render from the paid sal_bills row + items via
--     print-CSS / in-app history in v1; email + Twilio SMS are deferred.
--   * A generic scheduling / availability primitive. Availability (store hours −
--     worker schedule − time-off − booked slots, sized by service duration)
--     stays in THIS module's tables for now; extract only once a second module
--     needs slot math (CLAUDE.md).
--   * Tips & worker commissions (spec "Out of v1", payroll-adjacent).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- The org -> location backbone. Root table: org_id is client-supplied and the
-- RLS write gate (sal_can_manage) ties it to an org the caller manages, exactly
-- like cls_courses / mm_groups. store_hours is the weekly template that seeds
-- availability, e.g. {"mon":[["09:00","17:00"]], "sun":[], ...}; validated by
-- the module's Zod schema at the write site, not by a CHECK here.
create table public.sal_locations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null,
  address text,
  timezone text not null default 'America/New_York',
  store_hours jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Service catalog. Per-location so a chain can price/offer differently per site
-- (v1 = one location). approx_duration_minutes is "same for all workers"
-- (decided) and DRIVES SLOT SIZING; price feeds the booking price-preview and
-- default bill line. org_id derived from location by scope-sync.
create table public.sal_services (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  location_id uuid not null references public.sal_locations (id) on delete cascade,
  name text not null,
  price numeric(10, 2) not null default 0 check (price >= 0),
  approx_duration_minutes integer not null check (approx_duration_minutes > 0),
  active boolean not null default true,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A nail worker's per-location profile. Workers are represented as module_roles
-- ('nail-salon','worker') PLUS this row for per-location assignment, skills, and
-- their weekly working template (subset of store hours). DESIGN DECISION: a
-- worker who serves two locations has two profile rows; the appointment's own
-- location_id + worker_id (auth.users) is the source of truth for "whose
-- schedule", so appointment RLS never has to join through this table.
-- weekly_schedule shape mirrors sal_locations.store_hours. skills = service ids
-- this worker performs (jsonb array of uuids); NULL/empty = can do anything.
create table public.sal_worker_profiles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  location_id uuid not null references public.sal_locations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  display_name text,
  skills jsonb not null default '[]'::jsonb,
  weekly_schedule jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (location_id, user_id)
);

-- Time-off / shift exceptions that carve availability out of a worker's weekly
-- template (spec: "worker time-off & shift management drives bookable slots").
-- Parent = worker profile, so org_id AND location_id are BOTH derived from it.
create table public.sal_worker_time_off (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  location_id uuid not null references public.sal_locations (id) on delete cascade,
  worker_profile_id uuid not null references public.sal_worker_profiles (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

-- Customer record. DESIGN DECISION: a customer is NOT necessarily an auth user
-- — walk-ins (spec: cashier three-tap quick-add) get a lightweight row with no
-- login. user_id is set only when the manager grants "customer online access"
-- (spec), linking the record to an auth.users id; then that user sees their own
-- history/receipts. Every customer belongs to exactly one location in v1
-- (location_id NOT NULL, org derived from it). MULTI-LOCATION NOTE: a chain that
-- wants a shared customer across sites turns this into a customer<->location
-- many-to-many later — a documented v2 change (Future: multi-location rollout),
-- not a v1 concern.
create table public.sal_customers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  location_id uuid not null references public.sal_locations (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  full_name text not null,
  phone text,
  email text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- At most one customer record per online-access user per location.
  unique (location_id, user_id)
);

-- Manager-authored promotions the cashier surfaces at billing (spec: by visit
-- count / spend / lapsed customers). kind selects which criterion applies;
-- threshold is visits (kind='visit_count') or dollars (kind='spend'),
-- lapsed_days is used for kind='lapsed'. discount_type/value describe the
-- reward. Actual "does this customer qualify?" evaluation lives in module code
-- reading these rows + the customer's appointment/bill history.
create table public.sal_promotions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  location_id uuid not null references public.sal_locations (id) on delete cascade,
  name text not null,
  description text,
  kind text not null check (kind in ('visit_count', 'spend', 'lapsed')),
  threshold numeric(10, 2),
  lapsed_days integer,
  discount_type text not null check (discount_type in ('percent', 'amount')),
  discount_value numeric(10, 2) not null check (discount_value >= 0),
  active boolean not null default true,
  starts_on date,
  ends_on date,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The core state machine. Lifecycle (spec):
--   booked -> checked_in -> in_progress -> complete(locked) -> billed -> paid
--   (+ no_show, cancelled at appropriate points).
-- worker_id is NULLABLE — "preferred worker optional; algorithm/manager fills
-- the rest". customer_id + service_id are required (a walk-in gets a customer
-- row first, then the appointment; service is one of the three quick-add taps).
-- scheduled_end is stored (derived from the service duration at booking time)
-- so slot math and the day-view board don't recompute it. checklist = care
-- items the worker checks off mid-appointment, e.g.
-- [{"label":"cuticle care","done":true,"done_at":"..."}, ...].
-- org_id derived from location by scope-sync; the same trigger validates that
-- service/customer/worker all belong to this org+location.
create table public.sal_appointments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  location_id uuid not null references public.sal_locations (id) on delete cascade,
  customer_id uuid not null references public.sal_customers (id) on delete cascade,
  service_id uuid not null references public.sal_services (id) on delete restrict,
  worker_id uuid references auth.users (id) on delete set null,
  scheduled_start timestamptz not null,
  scheduled_end timestamptz not null,
  state text not null default 'booked'
    check (state in ('booked', 'checked_in', 'in_progress', 'complete',
                     'billed', 'paid', 'no_show', 'cancelled')),
  checklist jsonb not null default '[]'::jsonb,
  notes text,
  booked_by uuid references auth.users (id) on delete set null,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (scheduled_end > scheduled_start)
);

-- Bill generated from work actually done (spec). One bill per appointment
-- (unique) — every bill, including a walk-in quick-add, ties back through an
-- appointment to a location for reporting/earnings. state:
--   open -> paid, with void/refunded as the manager escape hatch.
-- payment_method + external_processor + external_reference exist FROM DAY ONE so
-- a future card processor (Stripe) records against the same row — record-keeping
-- only, no processing here. void_*/refund_* are the audit trail for the
-- manager-level overrides. org_id + location_id derived from the appointment.
create table public.sal_bills (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  location_id uuid not null references public.sal_locations (id) on delete cascade,
  appointment_id uuid not null references public.sal_appointments (id) on delete cascade,
  state text not null default 'open' check (state in ('open', 'paid', 'void', 'refunded')),
  subtotal numeric(10, 2) not null default 0 check (subtotal >= 0),
  discount_total numeric(10, 2) not null default 0 check (discount_total >= 0),
  total numeric(10, 2) not null default 0 check (total >= 0),
  promotion_id uuid references public.sal_promotions (id) on delete set null,
  payment_method text,               -- 'cash' | 'card' | 'other' (free text, record-keeping)
  external_processor text,           -- future: 'stripe' etc.; NULL in v1
  external_reference text,           -- future: processor txn id; NULL in v1
  paid_at timestamptz,
  paid_by uuid references auth.users (id) on delete set null,
  voided_at timestamptz,
  voided_by uuid references auth.users (id) on delete set null,
  void_reason text,
  refunded_at timestamptz,
  refunded_by uuid references auth.users (id) on delete set null,
  refund_reason text,
  refund_amount numeric(10, 2) check (refund_amount is null or refund_amount >= 0),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (appointment_id)
);

-- Line items on a bill. service_id is nullable so an ad-hoc / retail-ish line
-- (rare in v1) is legal; description is always present so a receipt renders
-- without joining. Append-only from the app's perspective (no updated_at).
-- org_id + location_id derived from the parent bill.
create table public.sal_bill_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  location_id uuid not null references public.sal_locations (id) on delete cascade,
  bill_id uuid not null references public.sal_bills (id) on delete cascade,
  service_id uuid references public.sal_services (id) on delete set null,
  description text not null,
  quantity integer not null default 1 check (quantity > 0),
  unit_price numeric(10, 2) not null default 0,
  line_total numeric(10, 2) not null default 0,
  created_at timestamptz not null default now()
);

-- Earnings ledger — the bookkeeping revenue log, FED AUTOMATICALLY by paid
-- bills (spec) via the sal_feed_earnings() trigger below. Append-only: a 'sale'
-- row on paid, a negative 'refund' row on refund (never mutate history).
-- worker_id carried for "revenue by worker" reporting. No updated_at (immutable).
create table public.sal_earnings_ledger (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  location_id uuid not null references public.sal_locations (id) on delete cascade,
  bill_id uuid references public.sal_bills (id) on delete set null,
  appointment_id uuid references public.sal_appointments (id) on delete set null,
  worker_id uuid references auth.users (id) on delete set null,
  kind text not null default 'sale' check (kind in ('sale', 'refund', 'adjustment')),
  amount numeric(10, 2) not null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Expenses log with categories (spec). category is free text (vocabulary can be
-- constrained via org_modules.settings — no lookup table). source_shopping_item
-- links back when this expense was born from a purchased shopping-list item.
-- org_id derived from location.
create table public.sal_expenses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  location_id uuid not null references public.sal_locations (id) on delete cascade,
  category text not null,
  description text,
  amount numeric(10, 2) not null check (amount >= 0),
  spent_at timestamptz not null default now(),
  source_shopping_item_id uuid,   -- FK added after sal_shopping_list exists (below)
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Shopping list: to_buy -> purchased (-> becomes an expense entry) | cancelled
-- (spec). When marked purchased the app records the actual cost and creates a
-- sal_expenses row, linking both directions (expense_id here,
-- source_shopping_item_id there). See the INTEGRATION NOTE by the policies:
-- whether that expense creation is a trigger or an app action is a reviewer
-- call — drafted as an app action so the cashier enters the real paid amount.
-- org_id derived from location.
create table public.sal_shopping_list (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  location_id uuid not null references public.sal_locations (id) on delete cascade,
  item text not null,
  quantity integer not null default 1 check (quantity > 0),
  estimated_cost numeric(10, 2),
  status text not null default 'to_buy' check (status in ('to_buy', 'purchased', 'cancelled')),
  purchased_at timestamptz,
  expense_id uuid references public.sal_expenses (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Deferred FK now that both tables exist (a purchased item's resulting expense).
alter table public.sal_expenses
  add constraint sal_expenses_source_shopping_item_fkey
  foreign key (source_shopping_item_id)
  references public.sal_shopping_list (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Indexes (FK lookups + the query shapes each role's views actually need)
-- ---------------------------------------------------------------------------

create index sal_services_location_idx on public.sal_services (location_id);
create index sal_worker_profiles_location_idx on public.sal_worker_profiles (location_id);
create index sal_worker_profiles_user_idx on public.sal_worker_profiles (user_id);
create index sal_worker_time_off_profile_idx on public.sal_worker_time_off (worker_profile_id);
create index sal_customers_location_idx on public.sal_customers (location_id);
create index sal_customers_user_idx on public.sal_customers (user_id) where user_id is not null;
create index sal_promotions_location_idx on public.sal_promotions (location_id) where active;

-- Day-view board + worker schedule: "appointments at location L on day D" and
-- "my (worker's) upcoming appointments" are the two hot reads.
create index sal_appointments_location_start_idx
  on public.sal_appointments (location_id, scheduled_start);
create index sal_appointments_worker_start_idx
  on public.sal_appointments (worker_id, scheduled_start) where worker_id is not null;
create index sal_appointments_customer_idx on public.sal_appointments (customer_id);
create index sal_appointments_service_idx on public.sal_appointments (service_id);

create index sal_bills_appointment_idx on public.sal_bills (appointment_id);
create index sal_bills_location_state_idx on public.sal_bills (location_id, state);
create index sal_bill_items_bill_idx on public.sal_bill_items (bill_id);

-- Reporting: revenue by day/worker/location.
create index sal_earnings_location_occurred_idx
  on public.sal_earnings_ledger (location_id, occurred_at);
create index sal_earnings_worker_idx
  on public.sal_earnings_ledger (worker_id) where worker_id is not null;
create index sal_earnings_bill_idx on public.sal_earnings_ledger (bill_id);

create index sal_expenses_location_spent_idx on public.sal_expenses (location_id, spent_at);
create index sal_shopping_list_location_status_idx
  on public.sal_shopping_list (location_id, status);

-- ---------------------------------------------------------------------------
-- updated_at triggers (tables whose rows get edited after creation).
-- Excluded: sal_bill_items and sal_earnings_ledger are append-only (no updated_at).
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'sal_locations', 'sal_services', 'sal_worker_profiles', 'sal_worker_time_off',
    'sal_customers', 'sal_promotions', 'sal_appointments', 'sal_bills',
    'sal_expenses', 'sal_shopping_list']
  loop
    execute format(
      'create trigger %I_updated_at before update on public.%I
         for each row execute function public.set_updated_at();',
      t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Grants first (migrations do not inherit defaults — see core migration note).
-- RLS below restricts rows; the service_role (worker) bypasses RLS for jobs
-- (assignment algorithms, reporting rollups, reminder dispatch) and must filter
-- by org_id explicitly in that code.
-- ---------------------------------------------------------------------------

grant select, insert, update, delete
  on public.sal_locations, public.sal_services, public.sal_worker_profiles,
     public.sal_worker_time_off, public.sal_customers, public.sal_promotions,
     public.sal_appointments, public.sal_bills, public.sal_bill_items,
     public.sal_earnings_ledger, public.sal_expenses, public.sal_shopping_list
  to authenticated, service_role;

alter table public.sal_locations         enable row level security;
alter table public.sal_services          enable row level security;
alter table public.sal_worker_profiles   enable row level security;
alter table public.sal_worker_time_off   enable row level security;
alter table public.sal_customers         enable row level security;
alter table public.sal_promotions        enable row level security;
alter table public.sal_appointments      enable row level security;
alter table public.sal_bills             enable row level security;
alter table public.sal_bill_items        enable row level security;
alter table public.sal_earnings_ledger   enable row level security;
alter table public.sal_expenses          enable row level security;
alter table public.sal_shopping_list     enable row level security;

-- ---------------------------------------------------------------------------
-- Role / ownership helpers (security definer: they read tables the caller may
-- not, and break RLS recursion — same technique as cls_* / mm_* helpers).
-- ---------------------------------------------------------------------------

-- Manager tier: superadmin, org owner/admin, or module admin/manager. This is
-- the "sees everything operational + overrides + reporting + config" gate.
create function public.sal_can_manage(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_superadmin()
      or public.has_module_role(check_org_id, 'nail-salon', 'admin')
      or public.has_module_role(check_org_id, 'nail-salon', 'manager')
      or exists (
           select 1 from public.org_members
           where org_id = check_org_id
             and user_id = auth.uid()
             and role in ('owner', 'admin')
         );
$$;

-- Front-desk tier: cashier plus everyone above. Reads/writes the location's
-- day-to-day operational data (appointments, bills, customers, promotions).
create function public.sal_can_operate(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.sal_can_manage(check_org_id)
      or public.has_module_role(check_org_id, 'nail-salon', 'cashier');
$$;

create function public.sal_is_worker(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_module_role(check_org_id, 'nail-salon', 'worker');
$$;

-- The caller is the online-access user behind this customer record.
create function public.sal_owns_customer(check_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.sal_customers c
    where c.id = check_customer_id
      and c.user_id = auth.uid()
  );
$$;

-- The caller owns the customer this appointment is for (their own history).
create function public.sal_owns_appointment(check_appointment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.sal_appointments a
    join public.sal_customers c on c.id = a.customer_id
    where a.id = check_appointment_id
      and c.user_id = auth.uid()
  );
$$;

-- The caller owns the customer this bill is for (their receipt / history).
create function public.sal_owns_bill(check_bill_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.sal_bills b
    join public.sal_appointments a on a.id = b.appointment_id
    join public.sal_customers c on c.id = a.customer_id
    where b.id = check_bill_id
      and c.user_id = auth.uid()
  );
$$;

-- The caller (a worker) has an appointment with this customer, so may see the
-- customer's contact/care details for the chair (spec: "expands to customer +
-- full care details; calls the customer by name").
create function public.sal_worker_sees_customer(check_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.sal_appointments a
    where a.customer_id = check_customer_id
      and a.worker_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
-- Scope-sync BEFORE triggers — derive org_id (and location_id where the parent
-- implies it) from the FK chain so a client can never misfile a row into
-- another org/location by supplying bogus ids. Root tables (sal_locations) have
-- no parent; their org_id stays client-supplied and RLS write checks
-- (sal_can_manage on that exact org) already prevent misfiling (same as
-- cls_courses / mm_groups).
-- ---------------------------------------------------------------------------

-- Tables whose ONLY derivable scope is org_id, taken from their location_id:
-- sal_services, sal_worker_profiles, sal_customers, sal_promotions,
-- sal_expenses, sal_shopping_list.
create function public.sal_sync_from_location()
returns trigger
language plpgsql
as $$
begin
  select l.org_id into new.org_id
  from public.sal_locations l where l.id = new.location_id;
  if new.org_id is null then
    raise exception 'Unknown location %', new.location_id;
  end if;
  return new;
end;
$$;

-- sal_worker_time_off: derive BOTH org_id and location_id from the worker profile.
create function public.sal_sync_from_worker_profile()
returns trigger
language plpgsql
as $$
begin
  select w.org_id, w.location_id into new.org_id, new.location_id
  from public.sal_worker_profiles w where w.id = new.worker_profile_id;
  if new.org_id is null then
    raise exception 'Unknown worker profile %', new.worker_profile_id;
  end if;
  return new;
end;
$$;

-- sal_bills, sal_earnings_ledger: derive org_id + location_id from the appointment.
create function public.sal_sync_from_appointment()
returns trigger
language plpgsql
as $$
begin
  select a.org_id, a.location_id into new.org_id, new.location_id
  from public.sal_appointments a where a.id = new.appointment_id;
  if new.org_id is null then
    raise exception 'Unknown appointment %', new.appointment_id;
  end if;
  return new;
end;
$$;

-- sal_bill_items: derive org_id + location_id from the parent bill.
create function public.sal_sync_from_bill()
returns trigger
language plpgsql
as $$
begin
  select b.org_id, b.location_id into new.org_id, new.location_id
  from public.sal_bills b where b.id = new.bill_id;
  if new.org_id is null then
    raise exception 'Unknown bill %', new.bill_id;
  end if;
  return new;
end;
$$;

-- sal_appointments: derive org_id from the location AND validate that the
-- service, customer, and (optional) worker all belong to that same org+location
-- — a range/consistency check that can't be a static CHECK because it depends
-- on parent rows (same idea as mm_answers_before_write validating position
-- against the parent question's scale).
create function public.sal_appointments_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare loc_org uuid;
begin
  select l.org_id into loc_org
  from public.sal_locations l where l.id = new.location_id;
  if loc_org is null then
    raise exception 'Unknown location %', new.location_id;
  end if;
  new.org_id := loc_org;

  if not exists (
    select 1 from public.sal_services s
    where s.id = new.service_id
      and s.org_id = new.org_id
      and s.location_id = new.location_id
  ) then
    raise exception 'Service % is not offered at location %', new.service_id, new.location_id;
  end if;

  if not exists (
    select 1 from public.sal_customers c
    where c.id = new.customer_id
      and c.org_id = new.org_id
  ) then
    raise exception 'Customer % is not in org %', new.customer_id, new.org_id;
  end if;

  if new.worker_id is not null and not exists (
    select 1 from public.sal_worker_profiles w
    where w.user_id = new.worker_id
      and w.org_id = new.org_id
      and w.location_id = new.location_id
  ) then
    raise exception 'Worker % has no profile at location %', new.worker_id, new.location_id;
  end if;

  return new;
end;
$$;

create trigger sal_services_scope before insert or update on public.sal_services
  for each row execute function public.sal_sync_from_location();
create trigger sal_worker_profiles_scope before insert or update on public.sal_worker_profiles
  for each row execute function public.sal_sync_from_location();
create trigger sal_customers_scope before insert or update on public.sal_customers
  for each row execute function public.sal_sync_from_location();
create trigger sal_promotions_scope before insert or update on public.sal_promotions
  for each row execute function public.sal_sync_from_location();
create trigger sal_expenses_scope before insert or update on public.sal_expenses
  for each row execute function public.sal_sync_from_location();
create trigger sal_shopping_list_scope before insert or update on public.sal_shopping_list
  for each row execute function public.sal_sync_from_location();
create trigger sal_worker_time_off_scope before insert or update on public.sal_worker_time_off
  for each row execute function public.sal_sync_from_worker_profile();
create trigger sal_appointments_scope before insert or update on public.sal_appointments
  for each row execute function public.sal_appointments_before_write();
create trigger sal_bills_scope before insert or update on public.sal_bills
  for each row execute function public.sal_sync_from_appointment();
create trigger sal_earnings_ledger_scope before insert or update on public.sal_earnings_ledger
  for each row execute function public.sal_sync_from_appointment();
create trigger sal_bill_items_scope before insert or update on public.sal_bill_items
  for each row execute function public.sal_sync_from_bill();

-- ---------------------------------------------------------------------------
-- Earnings auto-feed (spec: "earnings ledger fed automatically by paid bills").
-- Real behavioral trigger (precedent: mm_mark_pairs_stale). SECURITY DEFINER so
-- the insert into sal_earnings_ledger bypasses that table's manager-only write
-- policy — this is system-generated revenue history, not a user write. Idempotent
-- on the state transition (only fires when the state ACTUALLY becomes paid /
-- refunded), so re-saving a paid bill won't double-count.
-- ---------------------------------------------------------------------------

create function public.sal_feed_earnings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.state = 'paid' and old.state is distinct from 'paid' then
    insert into public.sal_earnings_ledger
      (org_id, location_id, bill_id, appointment_id, worker_id, kind, amount, occurred_at)
    select new.org_id, new.location_id, new.id, a.id, a.worker_id, 'sale',
           new.total, coalesce(new.paid_at, now())
    from public.sal_appointments a
    where a.id = new.appointment_id;
  elsif new.state = 'refunded' and old.state is distinct from 'refunded' then
    insert into public.sal_earnings_ledger
      (org_id, location_id, bill_id, appointment_id, worker_id, kind, amount, occurred_at)
    select new.org_id, new.location_id, new.id, a.id, a.worker_id, 'refund',
           -1 * coalesce(new.refund_amount, new.total), coalesce(new.refunded_at, now())
    from public.sal_appointments a
    where a.id = new.appointment_id;
  end if;
  return new;
end;
$$;

create trigger sal_bills_feed_earnings after update on public.sal_bills
  for each row execute function public.sal_feed_earnings();

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------

-- Uniform staff-manage write: managers/admins (and org owners/superadmin) have
-- FULL control of every module table. Cashier/worker/customer carve-outs are
-- added explicitly per table below.
do $$
declare t text;
begin
  foreach t in array array[
    'sal_locations', 'sal_services', 'sal_worker_profiles', 'sal_worker_time_off',
    'sal_customers', 'sal_promotions', 'sal_appointments', 'sal_bills',
    'sal_bill_items', 'sal_earnings_ledger', 'sal_expenses', 'sal_shopping_list']
  loop
    execute format(
      'create policy %I_write_manage on public.%I for all
         using (public.sal_can_manage(org_id))
         with check (public.sal_can_manage(org_id));',
      t, t);
  end loop;
end $$;

-- --- Reference / config data readable by anyone in the org --------------------
-- Locations, services, worker profiles and promotions are needed to render the
-- booking flow (price preview, worker picker, store hours) and the day board.
-- Only non-sensitive columns are surfaced by the app; RLS keeps them org-scoped.

create policy sal_locations_select_member on public.sal_locations
  for select using (public.is_org_member(org_id));

create policy sal_services_select_member on public.sal_services
  for select using (public.is_org_member(org_id));

-- Worker profiles: any org member may see them (customer picks a preferred
-- worker; the day board lists chairs). The worker themselves and operators can
-- of course see their own; this single member-read covers all of it.
create policy sal_worker_profiles_select_member on public.sal_worker_profiles
  for select using (public.is_org_member(org_id));

-- Promotions: cashier surfaces them, manager authors them. Not exposed directly
-- to customers (the cashier applies/announces). Operate-tier read.
create policy sal_promotions_select_operate on public.sal_promotions
  for select using (public.sal_can_operate(org_id));

-- --- Worker time-off ---------------------------------------------------------
-- Operators manage/read; a worker sees their own time-off rows.
-- INTEGRATION NOTE: worker SELF-SERVICE time-off requests are NOT granted here
-- (write stays manager-tier per spec "manager: worker time-off & shift
-- management"). If workers should submit requests, add an insert policy gated on
-- the worker owning worker_profile_id + a pending status, at integration.
create policy sal_worker_time_off_select on public.sal_worker_time_off
  for select using (
    public.sal_can_operate(org_id)
    or exists (
         select 1 from public.sal_worker_profiles w
         where w.id = worker_profile_id and w.user_id = auth.uid()
       )
  );

-- --- Customers ---------------------------------------------------------------
-- Operators (cashier/manager/admin) manage every customer at the location.
-- Cashier needs insert/update (walk-in quick-add, edit contact) beyond the
-- manager-only blanket policy, so grant operate a full policy here.
create policy sal_customers_write_operate on public.sal_customers
  for all using (public.sal_can_operate(org_id))
  with check (public.sal_can_operate(org_id));

-- A customer sees only their own record; a worker sees a customer they have an
-- appointment with (chair details).
create policy sal_customers_select on public.sal_customers
  for select using (
    public.sal_can_operate(org_id)
    or user_id = auth.uid()
    or public.sal_worker_sees_customer(id)
  );

-- --- Appointments ------------------------------------------------------------
-- Operate tier: full CRUD (booking on behalf, walk-in quick-add, cancellations,
-- price/schedule overrides, moving through billed/paid).
create policy sal_appointments_write_operate on public.sal_appointments
  for all using (public.sal_can_operate(org_id))
  with check (public.sal_can_operate(org_id));

-- Read: operators see the location's board; a worker sees appointments assigned
-- to them (their own schedule); a customer sees their own.
create policy sal_appointments_select on public.sal_appointments
  for select using (
    public.sal_can_operate(org_id)
    or worker_id = auth.uid()
    or public.sal_owns_customer(customer_id)
  );

-- Customer self-booking: create an appointment for THEMSELVES, always landing in
-- 'booked'. (worker_id may be their preferred worker or NULL; the
-- before-write trigger validates service/worker belong to the location.)
-- INTEGRATION NOTE: this permits a customer to pick any scheduled_start —
-- online-booking-window / slot-availability / lead-time enforcement is module
-- logic (or a validating trigger) to add at integration; RLS only proves
-- ownership + org scoping here.
create policy sal_appointments_insert_customer on public.sal_appointments
  for insert with check (
    public.sal_owns_customer(customer_id)
    and state = 'booked'
  );

-- Customer self-cancel: may touch their own appointment only while it is still
-- 'booked', and only to cancel it.
-- INTEGRATION NOTE (column pins + state machine): RLS is row-level and cannot
-- stop the customer from ALSO editing service_id/worker_id/scheduled_* or
-- jumping to an arbitrary state in the same UPDATE. Add a BEFORE UPDATE trigger
-- (à la cls_pin_submission_columns / mm_pin_answer_identity) that, for non-staff,
-- pins every column except (state -> 'cancelled', cancel_reason, cancelled_at).
create policy sal_appointments_update_customer on public.sal_appointments
  for update using (
    public.sal_owns_customer(customer_id) and state = 'booked'
  )
  with check (
    public.sal_owns_customer(customer_id) and state in ('booked', 'cancelled')
  );

-- Worker mid-appointment edits: a worker may advance an appointment assigned to
-- them from checked_in -> in_progress -> complete and tick the checklist / add
-- notes. Once 'complete' the row LOCKS to the worker (the `using` clause no
-- longer matches complete), so they cannot reopen or re-bill it — billing/paid
-- is operator-only via the operate policy above (spec: "taps Complete ->
-- appointment locks; moves to next customer").
-- INTEGRATION NOTE (the key lifecycle guard): RLS cannot restrict WHICH columns
-- a worker changes, and this policy alone would let a worker edit
-- price-relevant fields (service_id/scheduled_*/customer_id) or skip states.
-- Add a BEFORE UPDATE trigger that, when the actor is a worker (not operate):
--   * pins everything except checklist, notes, and state;
--   * allows ONLY the transitions checked_in->in_progress, in_progress->complete
--     (and permits no_show from checked_in if the client wants it here);
--   * forbids any edit once old.state in ('complete','billed','paid','cancelled').
-- This is the "complete->billed lock" the spec calls out — flagged, not built,
-- exactly like the classroom draft's INTEGRATION NOTEs.
create policy sal_appointments_update_worker on public.sal_appointments
  for update using (
    worker_id = auth.uid() and state in ('checked_in', 'in_progress')
  )
  with check (
    worker_id = auth.uid() and state in ('checked_in', 'in_progress', 'complete', 'no_show')
  );

-- --- Bills + items -----------------------------------------------------------
-- Operate tier creates a bill from work done, adds items, records
-- payment_method + marks paid. The manager-only blanket policy already covers
-- the escape hatches, but cashiers also need normal billing writes:
create policy sal_bills_write_operate on public.sal_bills
  for all using (public.sal_can_operate(org_id))
  with check (public.sal_can_operate(org_id));

-- Read: operators, plus the customer whose bill this is (their receipt/history).
create policy sal_bills_select on public.sal_bills
  for select using (
    public.sal_can_operate(org_id)
    or public.sal_owns_bill(id)
  );

-- INTEGRATION NOTE (manager-only void/refund + paid-bill immutability): the
-- operate policy above lets a CASHIER move a bill to 'void'/'refunded' and edit
-- totals on an already-paid bill. Spec makes voids/refunds a MANAGER-level,
-- audit-trailed escape hatch. Add a BEFORE UPDATE trigger that:
--   * blocks state -> 'void'/'refunded' unless sal_can_manage(org_id);
--   * requires voided_by/void_reason (or refunded_by/refund_reason/refund_amount)
--     to be set on that transition, and stamps voided_at/refunded_at server-side;
--   * pins monetary columns + payment fields once state in ('paid','void',
--     'refunded') so a locked bill's history is immutable to cashiers.
-- Deliberately flagged, not built (reviewer's call whether trigger vs. a
-- definer RPC for void/refund) — mirrors the classroom/matchmaking split.

create policy sal_bill_items_write_operate on public.sal_bill_items
  for all using (public.sal_can_operate(org_id))
  with check (public.sal_can_operate(org_id));

create policy sal_bill_items_select on public.sal_bill_items
  for select using (
    public.sal_can_operate(org_id)
    or public.sal_owns_bill(bill_id)
  );

-- --- Earnings ledger ---------------------------------------------------------
-- Reporting read is manager-tier only (revenue by day/service/worker). Writes
-- are the auto-feed trigger (definer) or manager corrections via the blanket
-- policy — NO operate/worker/customer write here. (Reporting itself is a
-- platform primitive candidate; for now the module aggregates these rows.)
create policy sal_earnings_ledger_select_manage on public.sal_earnings_ledger
  for select using (public.sal_can_manage(org_id));

-- --- Bookkeeping: expenses + shopping list -----------------------------------
-- Expenses and shopping lists are back-office; manager-tier owns them via the
-- blanket policy. Cashiers commonly log purchases / tick shopping items, so
-- grant operate full write here too (reviewer may tighten to manager-only if the
-- client wants expenses locked down).
create policy sal_expenses_write_operate on public.sal_expenses
  for all using (public.sal_can_operate(org_id))
  with check (public.sal_can_operate(org_id));
create policy sal_expenses_select_operate on public.sal_expenses
  for select using (public.sal_can_operate(org_id));

create policy sal_shopping_list_write_operate on public.sal_shopping_list
  for all using (public.sal_can_operate(org_id))
  with check (public.sal_can_operate(org_id));
create policy sal_shopping_list_select_operate on public.sal_shopping_list
  for select using (public.sal_can_operate(org_id));

-- INTEGRATION NOTE (shopping -> expense): when a shopping item is marked
-- 'purchased', an expense row is created and linked both ways (expense_id here,
-- source_shopping_item_id there). Drafted as an APP action (server action /
-- definer RPC) rather than a trigger so the cashier enters the actual paid cost
-- at purchase time; if the reviewer prefers it automatic, add an AFTER UPDATE
-- trigger mirroring sal_feed_earnings. Also note: sal_feed_earnings feeds a
-- 'refund' reversal on state->'refunded'; if partial refunds or re-refund need
-- richer handling, extend that function at integration.

-- ---------------------------------------------------------------------------
-- Storage buckets (created at integration time alongside this migration):
--   sal-receipts  — optional rendered receipt PDFs, org-scoped prefix
--                   <org_id>/<location_id>/<bill_id>/… ; customer reads own via
--                   sal_owns_bill, staff via sal_can_operate. Bucket policies
--                   follow the cls-submissions / syn-exports foldername pattern
--                   and are reviewed with the integration migration (storage.objects
--                   is shared platform state — kept out of this draft).
-- No customer-uploaded files exist in v1, so no write bucket is needed yet.
-- ---------------------------------------------------------------------------

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
