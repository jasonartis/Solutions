-- User model slice 2 — nail-salon scope-awareness (docs/15; classroom exemplar
-- 20260724010000 applied to the salon's org -> LOCATION entity tree).
--
-- WHAT CHANGES
--   * sal_locations gains scope_node_id -> a module_scope_nodes tree (each
--     location is a root node). Minted by a BEFORE-INSERT definer trigger,
--     backfilled. Every other sal_ table already carries location_id, so its
--     scope node is resolved via sal_locations.
--   * module_position_rank gains a 'nail-salon' block: admin=3 (Coordinator —
--     global salon authority), manager=2 (Lead — runs a location), cashier=1,
--     worker=1 (peers), customer -> 0 (end user, invisible to the ladder). The
--     rank>=2 gate (module_has_manager_grant, from classroom 2a/2b) then lets a
--     manager grant cashier/worker scoped to their own location.
--   * The coarse sal_can_manage/sal_can_operate/sal_is_worker are redefined off
--     module_roles directly (was has_module_role, which is global-only) so a
--     SCOPED staffer still reaches the console; they are used ONLY for console
--     entry now. New PRECISE sal_can_manage_location/sal_can_operate_location
--     gate every per-row policy + the two lifecycle triggers via scope coverage.
--   * module_can_manage('nail-salon') is tightened to admin-or-global-manager
--     (export controls are module-wide; a class... location-scoped manager must
--     not toggle them) — same shape as the classroom F3 fix.
--
-- ADDITIVITY / DATA
--   * A GLOBAL grant (scope_ref null) covers every location
--     (module_scope_covers(null,·)=true), so existing global admin/manager/
--     cashier/worker grants keep their EXACT org-wide behavior — no forced grant
--     migration (unlike classroom students; the salon has no membership-inflation
--     analogue — customers key off sal_customers.user_id, not grant coverage).
--   * Only new capability: a SCOPED manager/cashier/worker grant is now enforced
--     to its location subtree. Backfill just mints location nodes.
--
-- FOLLOW-ON (NOT built here): a "manager assigns staff to a location" UI (the
-- salon analogue of classroom enrollment) + multi-location surfacing in the
-- console (today both consoles hard-select one location). The authority layer
-- below is scope-correct; RLS tests exercise scoped grants as real users.
-- No storage buckets exist for nail-salon, so there is no storage-scoping gap.

-- ===========================================================================
-- 1. Location scope nodes
-- ===========================================================================
alter table public.sal_locations add column scope_node_id uuid references public.module_scope_nodes (id) on delete set null;

-- Node id is TRIGGER-OWNED (client value ignored — slice-1 item 7 / classroom
-- review Finding 5). A location is a root node in the nail-salon tree.
create function public.sal_create_location_node()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare nid uuid;
begin
  insert into public.module_scope_nodes (org_id, module_key, name, node_type)
  values (new.org_id, 'nail-salon', new.name, 'location')
  returning id into nid;
  new.scope_node_id := nid;
  return new;
end;
$$;

create trigger sal_locations_node before insert on public.sal_locations
  for each row execute function public.sal_create_location_node();

do $$
declare l record; nid uuid;
begin
  for l in select id, org_id, name from public.sal_locations where scope_node_id is null loop
    insert into public.module_scope_nodes (org_id, module_key, name, node_type)
    values (l.org_id, 'nail-salon', l.name, 'location') returning id into nid;
    update public.sal_locations set scope_node_id = nid where id = l.id;
  end loop;
end $$;

-- ===========================================================================
-- 2. Per-module rank — add the nail-salon vocabulary (extends classroom 2b).
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
      else null
    end,
    public.module_position_rank(role)
  );
$$;

-- ===========================================================================
-- 3. Authority functions
-- ===========================================================================
-- COARSE (any-scope) — console entry only. Redefined off module_roles so scoped
-- staff reach the console; org-wide-precision comes from the _location fns.
create or replace function public.sal_can_manage(check_org_id uuid)
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
             and g.module_key = 'nail-salon'
             and g.user_id = auth.uid()
             and public.module_position_rank('nail-salon', g.role) >= 2
         );
$$;

create or replace function public.sal_can_operate(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.sal_can_manage(check_org_id)
      or exists (
           select 1 from public.module_roles g
           where g.org_id = check_org_id
             and g.module_key = 'nail-salon'
             and g.user_id = auth.uid()
             and g.role = 'cashier'
         );
$$;

create or replace function public.sal_is_worker(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.module_roles g
    where g.org_id = check_org_id
      and g.module_key = 'nail-salon'
      and g.user_id = auth.uid()
      and g.role = 'worker'
  );
$$;

-- PRECISE: does the caller hold a salon grant (manager+ / cashier) whose scope
-- COVERS this location? Global grant covers every location.
create function public.sal_can_manage_location(check_org_id uuid, check_location_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_admin(check_org_id)
      or exists (
           select 1
           from public.module_roles g
           join public.sal_locations l on l.id = check_location_id
           where g.org_id = check_org_id
             and g.module_key = 'nail-salon'
             and g.user_id = auth.uid()
             and public.module_position_rank('nail-salon', g.role) >= 2
             and public.module_scope_covers(g.scope_ref, l.scope_node_id)
         );
$$;

create function public.sal_can_operate_location(check_org_id uuid, check_location_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.sal_can_manage_location(check_org_id, check_location_id)
      or exists (
           select 1
           from public.module_roles g
           join public.sal_locations l on l.id = check_location_id
           where g.org_id = check_org_id
             and g.module_key = 'nail-salon'
             and g.user_id = auth.uid()
             and g.role = 'cashier'
             and public.module_scope_covers(g.scope_ref, l.scope_node_id)
         );
$$;

grant execute on function public.sal_can_manage_location(uuid, uuid) to authenticated, service_role;
grant execute on function public.sal_can_operate_location(uuid, uuid) to authenticated, service_role;

-- Export controls are a module-WIDE setting → keep them admin-or-global-manager
-- (has_module_role is global-only), never a location-scoped manager. Restates
-- module_can_manage (last set in 20260724010000) with the nail-salon case
-- tightened; all other cases unchanged.
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
    when 'speed-dating' then public.sd_can_manage(check_org_id)
    when 'sample' then public.smp_can_manage(check_org_id)
    when 'synagogue-schedules' then
      public.is_org_admin(check_org_id)
      or public.has_module_role(check_org_id, 'synagogue-schedules', 'maker')
    else public.is_org_admin(check_org_id)
  end;
$$;

-- ===========================================================================
-- 4. Rewrite per-row policies onto the scope-precise functions.
--    Member-reads (sal_locations/sal_services/sal_worker_profiles) stay
--    org-wide on purpose — the booking flow needs the catalog, and the founder
--    wants customers to see all stores (a "global customer").
-- ===========================================================================

-- 4a. Blanket manager write: drop all 12, recreate scope-precise.
do $$
declare t text;
begin
  foreach t in array array[
    'sal_locations', 'sal_services', 'sal_worker_profiles', 'sal_worker_time_off',
    'sal_customers', 'sal_promotions', 'sal_appointments', 'sal_bills',
    'sal_bill_items', 'sal_earnings_ledger', 'sal_expenses', 'sal_shopping_list']
  loop
    execute format('drop policy %I_write_manage on public.%I;', t, t);
  end loop;
  -- 11 location_id-bearing tables.
  foreach t in array array[
    'sal_services', 'sal_worker_profiles', 'sal_worker_time_off',
    'sal_customers', 'sal_promotions', 'sal_appointments', 'sal_bills',
    'sal_bill_items', 'sal_earnings_ledger', 'sal_expenses', 'sal_shopping_list']
  loop
    execute format(
      'create policy %I_write_manage on public.%I for all
         using (public.sal_can_manage_location(org_id, location_id))
         with check (public.sal_can_manage_location(org_id, location_id));',
      t, t);
  end loop;
end $$;

-- sal_locations: INSERT can't check the not-yet-created location node (its own
-- id isn't visible to the statement snapshot — classroom review Finding 1).
-- DELIBERATE DIVERGENCE from classroom's coarse course-INSERT gate (tenancy
-- reviewer's optional hardening): creating a STORE is a business-level act, and
-- salon has an explicit admin tier — so gate creation on org-admin OR a GLOBAL
-- admin/manager (has_module_role is global-only), NOT the coarse any-scope fn.
-- This stops a location-scoped manager from spawning empty, unmanageable
-- locations (a root node they can't even cover). UPDATE/DELETE use the node.
create policy sal_locations_insert_manage on public.sal_locations
  for insert with check (
    public.is_org_admin(org_id)
    or public.has_module_role(org_id, 'nail-salon', 'admin')
    or public.has_module_role(org_id, 'nail-salon', 'manager')
  );
create policy sal_locations_update_manage on public.sal_locations
  for update using (public.sal_can_manage_location(org_id, id))
             with check (public.sal_can_manage_location(org_id, id));
create policy sal_locations_delete_manage on public.sal_locations
  for delete using (public.sal_can_manage_location(org_id, id));

-- 4b. Operate/manage-gated per-row policies -> location-precise (own-row arms
--     preserved verbatim).
drop policy sal_promotions_select_operate on public.sal_promotions;
create policy sal_promotions_select_operate on public.sal_promotions
  for select using (public.sal_can_operate_location(org_id, location_id));

drop policy sal_worker_time_off_select on public.sal_worker_time_off;
create policy sal_worker_time_off_select on public.sal_worker_time_off
  for select using (
    public.sal_can_operate_location(org_id, location_id)
    or exists (
         select 1 from public.sal_worker_profiles w
         where w.id = worker_profile_id and w.user_id = auth.uid()
       )
  );

drop policy sal_customers_write_operate on public.sal_customers;
create policy sal_customers_write_operate on public.sal_customers
  for all using (public.sal_can_operate_location(org_id, location_id))
  with check (public.sal_can_operate_location(org_id, location_id));

drop policy sal_customers_select on public.sal_customers;
create policy sal_customers_select on public.sal_customers
  for select using (
    public.sal_can_operate_location(org_id, location_id)
    or user_id = auth.uid()
    or public.sal_worker_sees_customer(id)
  );

drop policy sal_appointments_write_operate on public.sal_appointments;
create policy sal_appointments_write_operate on public.sal_appointments
  for all using (public.sal_can_operate_location(org_id, location_id))
  with check (public.sal_can_operate_location(org_id, location_id));

drop policy sal_appointments_select on public.sal_appointments;
create policy sal_appointments_select on public.sal_appointments
  for select using (
    public.sal_can_operate_location(org_id, location_id)
    or worker_id = auth.uid()
    or public.sal_owns_customer(customer_id)
  );

drop policy sal_bills_write_operate on public.sal_bills;
create policy sal_bills_write_operate on public.sal_bills
  for all using (public.sal_can_operate_location(org_id, location_id))
  with check (public.sal_can_operate_location(org_id, location_id));

drop policy sal_bills_select on public.sal_bills;
create policy sal_bills_select on public.sal_bills
  for select using (
    public.sal_can_operate_location(org_id, location_id)
    or public.sal_owns_bill(id)
  );

drop policy sal_bill_items_write_operate on public.sal_bill_items;
create policy sal_bill_items_write_operate on public.sal_bill_items
  for all using (public.sal_can_operate_location(org_id, location_id))
  with check (public.sal_can_operate_location(org_id, location_id));

drop policy sal_bill_items_select on public.sal_bill_items;
create policy sal_bill_items_select on public.sal_bill_items
  for select using (
    public.sal_can_operate_location(org_id, location_id)
    or public.sal_owns_bill(bill_id)
  );

drop policy sal_earnings_ledger_select_manage on public.sal_earnings_ledger;
create policy sal_earnings_ledger_select_manage on public.sal_earnings_ledger
  for select using (public.sal_can_manage_location(org_id, location_id));

drop policy sal_expenses_write_operate on public.sal_expenses;
create policy sal_expenses_write_operate on public.sal_expenses
  for all using (public.sal_can_operate_location(org_id, location_id))
  with check (public.sal_can_operate_location(org_id, location_id));
drop policy sal_expenses_select_operate on public.sal_expenses;
create policy sal_expenses_select_operate on public.sal_expenses
  for select using (public.sal_can_operate_location(org_id, location_id));

drop policy sal_shopping_list_write_operate on public.sal_shopping_list;
create policy sal_shopping_list_write_operate on public.sal_shopping_list
  for all using (public.sal_can_operate_location(org_id, location_id))
  with check (public.sal_can_operate_location(org_id, location_id));
drop policy sal_shopping_list_select_operate on public.sal_shopping_list;
create policy sal_shopping_list_select_operate on public.sal_shopping_list
  for select using (public.sal_can_operate_location(org_id, location_id));

-- ===========================================================================
-- 5. Lifecycle triggers -> location-precise (bodies otherwise identical to
--    20260709030000; both read old.org_id + old.location_id already).
-- ===========================================================================
create or replace function public.sal_pin_appointment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Operators (of THIS location) have full control.
  if public.sal_can_operate_location(old.org_id, old.location_id) then
    return new;
  end if;

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

  return old;
end;
$$;

create or replace function public.sal_guard_bill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.state in ('void', 'refunded') and old.state is distinct from new.state then
    if not public.sal_can_manage_location(old.org_id, old.location_id) then
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

  if old.state in ('paid', 'void', 'refunded') and not public.sal_can_manage_location(old.org_id, old.location_id) then
    new.subtotal := old.subtotal;
    new.discount_total := old.discount_total;
    new.total := old.total;
    new.promotion_id := old.promotion_id;
    new.payment_method := old.payment_method;
    new.external_processor := old.external_processor;
    new.external_reference := old.external_reference;
    new.state := old.state;
  end if;

  if new.state = 'paid' and old.state is distinct from 'paid' then
    new.paid_by := coalesce(new.paid_by, auth.uid());
    new.paid_at := coalesce(new.paid_at, now());
  end if;

  return new;
end;
$$;
