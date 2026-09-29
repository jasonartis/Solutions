-- Make deleting an org possible, and report honestly what that destroys.
-- Drafted 2026-09-25, revised 2026-09-28 after two adversarial reviews.
--
-- ===========================================================================
-- THE BUG (docs/20 §30.1) — AND THE PART THAT IS EASY TO STATE WRONG
-- ===========================================================================
-- `org_members.org_id` references `orgs(id) ON DELETE CASCADE`, and
-- `org_members_guard_last_admin` is a BEFORE DELETE trigger enforcing "an org
-- must keep at least one active owner/admin" with no cascade escape. The
-- cascade fires the guard for the last owner and it raises.
--
-- THE FAILURE IS CONDITIONAL, and an earlier draft of this header drew the
-- wrong conclusion from that. Measured:
--
--     org with no members ............... deletes fine   (already worked)
--     org with an active 'member' seat .. deletes fine   (already worked)
--     org with a PENDING owner .......... deletes fine   (already worked)
--     org with an ACTIVE owner/admin .... REFUSED        <- what this fixes
--
-- So this migration does NOT unblock "delete a freshly-created typo org" —
-- that already worked. What it unblocks is deleting an org that has a real
-- administrator in it. Adversarial review caught the earlier header claiming
-- otherwise; the distinction decides what the console may safely offer, which
-- is why it is stated here rather than in a commit message.
--
-- (docs/18 item 8 called a raw delete "SAFE" after the onboarding rehearsal.
-- True only of the already-working shapes above; corrected there.)
--
-- ===========================================================================
-- WHY A PARENT-EXISTENCE TEST *AND* A DEPTH TEST — NEITHER ALONE
-- ===========================================================================
-- docs/20 §30.3 prescribes `pg_trigger_depth() > 1` as the canonical cascade
-- escape. Used ALONE it is wrong here, because two different referential
-- actions reach this guard and deserve OPPOSITE answers:
--
--   * cascade from `orgs`       — the org is going away. The floor is moot.
--                                 Must be allowed.
--   * cascade from `auth.users` — `org_members.user_id` is ALSO ON DELETE
--                                 CASCADE. The ORG SURVIVES and would be left
--                                 with zero admins and no way to appoint one.
--                                 Must stay blocked until docs/21 decides what
--                                 account deletion does to such an org.
--
-- A depth test cannot tell those apart and would silently permit orphaning.
-- Asking whether the parent org still exists separates them exactly.
--
-- BUT PARENT-EXISTENCE ALONE FAILS *OPEN*, which the safety review caught and
-- which matters more than it first looks: the clause reads "I cannot see the
-- org" as "the org is gone". If `orgs` ever gains FORCE ROW LEVEL SECURITY, or
-- this function's owner changes, that read starts returning nothing for reasons
-- unrelated to deletion — and the floor disappears for EVERY delete, silently,
-- with no error. So the depth test is kept as a CONJUNCT: it costs nothing,
-- changes none of the reasoning above, and bounds the blast radius of a broken
-- visibility assumption to referential actions only.
--
-- Verified by measurement, all rolled back:
--     delete the ORG (sole owner) ....... ALLOWED   <- the fix
--     delete the sole owner SEAT ........ REFUSED   <- floor preserved
--     demote the sole owner ............. REFUSED   <- floor preserved
--     delete the sole-admin USER ........ REFUSED   <- org would be orphaned
--
-- The other BEFORE DELETE trigger on this table, `org_members_guard_hierarchy`,
-- needs no change: it early-returns when `auth.uid()` is null or the caller is
-- a superadmin, covering both the cascade and the console.
-- ⚠ LATENT TRAP, recorded by the safety review: if ORG-OWNER-initiated org
-- deletion is ever added (today only a superadmin may delete an org), that
-- hierarchy guard WILL block the cascade on the owner's own seat, and this fix
-- alone will not be enough.

create or replace function public.org_members_guard_last_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  losing boolean;
begin
  -- THE ONLY NEW CLAUSE. Both halves are load-bearing: the depth test proves
  -- this is a referential action rather than someone's own DELETE (fail
  -- closed), and the parent-existence test proves it is the ORGS cascade
  -- rather than the auth.users one (which must still be refused).
  if tg_op = 'DELETE'
     and pg_trigger_depth() > 1
     and not exists (select 1 from public.orgs o where o.id = old.org_id)
  then
    return old;
  end if;

  -- A non-active seat never counted toward the admin floor.
  if old.status <> 'active' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- Only owner/admin rows can be the seat that keeps an org administrable.
  if old.role not in ('owner', 'admin') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    losing := true;
  else
    losing := (new.role not in ('owner', 'admin'))
           or (new.org_id <> old.org_id)
           or (new.user_id <> old.user_id)
           or (new.status <> 'active');
  end if;

  if losing and not exists (
    select 1 from public.org_members
    where org_id = old.org_id
      and role in ('owner', 'admin')
      and status = 'active'
      and user_id <> old.user_id
  ) then
    raise exception 'An org must keep at least one owner or admin';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- `create or replace` preserves the ACL and the trigger binding. Restated
-- anyway (docs/03 #1), naming all four roles — the shortcut of naming only
-- some is what produced 20260925010000.
revoke execute on function public.org_members_guard_last_admin()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- org_delete_impact() — what would deleting this org actually do?
-- ---------------------------------------------------------------------------
-- 68 foreign keys reference `orgs(id)`. The operator deserves an itemised list
-- before confirming, not a generic "this is permanent".
--
-- THREE CORRECTIONS FROM REVIEW, all in the same direction — the earlier draft
-- UNDER-REPORTED, which for a destructive action is the worst way to be wrong:
--
--  1. It enumerated tables by the presence of a column NAMED `org_id`. Now it
--     walks the FOREIGN KEYS themselves, so a table referencing `orgs` under
--     any column name is found, and a coincidental `org_id` that is not a real
--     reference is not miscounted.
--  2. It lumped `superadmin_lookup_log` in with the rest. That FK is ON DELETE
--     SET NULL by design — those rows are UNLINKED, not destroyed. Reporting
--     them as "will be destroyed" is a lie in the alarming direction; the
--     action is now returned so the caller can say which is which.
--  3. `relkind = 'r'` skipped partitioned tables. Now 'r' and 'p'.
--
-- ⚠ WHAT THIS STILL DOES NOT COVER, stated because a list that looks complete
-- is worse than one that admits a gap:
--
--  * UPLOADED FILES. `storage.objects` has no FK to `orgs` and lives outside
--    `public`, so it is excluded twice over. Deleting an org destroys rows like
--    `cls_submission_files` while the actual files survive, orphaned. Any
--    caller presenting this inventory MUST say so.
--    ⚠ CORRECTED after review: an earlier draft said those files "carry no
--    org_id", which is FALSE and understated how fixable this is —
--    visual-messaging stores objects under `<org_id>/<conversation_id>/<uuid>`
--    (20260709100000:848), so at least that bucket IS enumerable by org prefix.
--    The gap is that nothing does it, not that nothing could.
--  * ANY FK FROM OUTSIDE `public`. The walk is scoped to `ns.nspname='public'`.
--  * TRANSITIVE rows (a child of a child). Harmless today because every module
--    table carries its own `org_id` FK, but that is a property of the current
--    schema, not a guarantee.
--
-- AND ONE THING THE `on_delete` COLUMN DOES NOT PROMISE: it is the DECLARED
-- referential action, not the EFFECTIVE one. A BEFORE trigger on a SET NULL
-- child can turn "this row is unlinked" into "the whole delete aborts" — this
-- repo's own recorded landmine. Verified 2026-09-28 that the sole SET NULL
-- child (`superadmin_lookup_log`) has no such trigger, and 20260807010000:233
-- explicitly declines one; so this is latent, not live.
create or replace function public.org_delete_impact(check_org_id uuid)
returns table (table_name text, column_name text, row_count bigint, on_delete text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  r record;
  n bigint;
begin
  -- The definer bypasses RLS, so authority is explicit. Asks about the CALLER,
  -- which is what is_superadmin() answers (docs/03 #29).
  if not public.is_superadmin() then
    raise exception 'org_delete_impact is superadmin-only' using errcode = '42501';
  end if;

  -- A mistyped uuid previously returned an EMPTY inventory, which reads as
  -- "nothing would be lost" — the most dangerous possible way to be wrong.
  if not exists (select 1 from public.orgs o where o.id = check_org_id) then
    raise exception 'no org with id %', check_org_id using errcode = 'P0002';
  end if;

  -- The loop below counts single-column FKs. A composite FK to `orgs` would be
  -- skipped SILENTLY, under-reporting a destructive action — so refuse to
  -- produce a list at all rather than produce one known to be short. None
  -- exists today (all 68 references are single-column).
  if exists (
    select 1 from pg_constraint con
    where con.contype = 'f'
      and con.confrelid = 'public.orgs'::regclass
      and array_length(con.conkey, 1) > 1
  ) then
    raise exception
      'a composite foreign key to orgs exists; this inventory would under-report and must be taught to count it';
  end if;

  for r in
    select cl.relname as tbl,
           att.attname as col,
           case con.confdeltype
             when 'c' then 'CASCADE' when 'n' then 'SET NULL'
             when 'd' then 'SET DEFAULT' when 'r' then 'RESTRICT'
             else 'NO ACTION'
           end as action
      from pg_constraint con
      join pg_class cl on cl.oid = con.conrelid
      join pg_namespace ns on ns.oid = cl.relnamespace
      join unnest(con.conkey) with ordinality as k(attnum, ord) on true
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
     where con.contype = 'f'
       and con.confrelid = 'public.orgs'::regclass
       and ns.nspname = 'public'
       and cl.relkind in ('r', 'p')
       -- An FK on a partitioned table is CLONED onto every partition. Without
       -- this, the parent row AND each partition row would both be returned
       -- while the parent's count(*) already includes the partitions — double
       -- counting. No partitioned table exists yet; this is here so the first
       -- one does not silently inflate a destructive-action estimate.
       and con.conparentid = 0
       and array_length(con.conkey, 1) = 1
     order by cl.relname
  loop
    -- %I quotes both identifiers, and both come from pg_catalog rather than
    -- from the caller, so there is no injection surface.
    execute format('select count(*) from public.%I where %I = $1', r.tbl, r.col)
      into n using check_org_id;
    if n > 0 then
      table_name := r.tbl;
      column_name := r.col;
      row_count := n;
      on_delete := r.action;
      return next;
    end if;
  end loop;
end;
$$;

revoke execute on function public.org_delete_impact(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.org_delete_impact(uuid) to authenticated;

-- ===========================================================================
-- Assertions
-- ===========================================================================
-- BEHAVIOURAL PROBES RUN INSIDE A SUBTRANSACTION THAT ALWAYS ROLLS BACK.
-- The earlier draft INSERTed a probe org and made an arbitrary REAL user its
-- owner, relying on the whole migration aborting to clean up — which both
-- reviews flagged, one noting it could leave a real person silently owning a
-- phantom org if the file were not applied atomically. Here the probe work is
-- wrapped in its own BEGIN/EXCEPTION block and terminated with a sentinel
-- raise: PL/pgSQL rolls the block's writes back when the exception is caught,
-- while the boolean results survive because variables are not transactional.
do $$
declare
  probe_org uuid;
  probe_user uuid;
  n integer;
  probe_skipped boolean := false;
  org_deleted boolean := false;
  seat_blocked boolean := false;
  demote_blocked boolean := false;
begin
  -- ⚠ FIXED 2026-09-28, SAME DAY, AFTER THIS BROKE CI. The first version raised
  -- when `profiles` was empty, reasoning that assertions with no user to probe
  -- would be vacuous. That is true, and raising was still WRONG: migrations run
  -- against a FRESH database before any seed exists, so `profiles` is legitimately
  -- empty every time CI runs `supabase start` — the migration failed, `supabase
  -- start` failed, and the whole pipeline died before a single test, on every
  -- commit including other sessions'.
  --
  -- The lesson is not "handle the empty case". It is that this file was verified
  -- only against a SEEDED database — applied to a seeded local, and probed inside
  -- transactions on seeded data — and a migration's real first audience is an
  -- EMPTY one. The journal entry for this slice even named fresh-replay coverage
  -- as the gap and pointed at CI for it; nobody then read CI.
  --
  -- So the behavioural probes SKIP when there is no user to probe with, and say
  -- so rather than pretending they ran. They still run on prod (which has users)
  -- and on a seeded local. The orphaning refusal, which nothing here asserts
  -- either way, is covered in packages/db/src/org-delete.test.ts against real
  -- seeded users — after the seed, which is why that suite is unaffected by this.
  select user_id into probe_user from public.profiles limit 1;
  if probe_user is null then
    raise notice
      'org_delete: no profiles yet (fresh database) — skipping the behavioural assertions; the structural ones below still run, and packages/db/src/org-delete.test.ts covers the behaviour after seeding';
    probe_skipped := true;
  end if;

  if not probe_skipped then
  begin
    insert into public.orgs (name, slug) values ('Assertion Probe', 'assert-probe-'||gen_random_uuid())
      returning id into probe_org;
    insert into public.org_members (org_id, user_id, role, status)
      values (probe_org, probe_user, 'owner', 'active');

    -- (a) THE FIX: an org whose sole member is an active owner can be deleted.
    delete from public.orgs where id = probe_org;
    org_deleted := not exists (select 1 from public.orgs where id = probe_org)
               and not exists (select 1 from public.org_members where org_id = probe_org);

    -- (b) THE FLOOR STILL HOLDS for a direct seat delete. Matched on the
    --     MESSAGE, not `when others` — the earlier draft would have counted any
    --     unrelated failure as proof the floor worked.
    insert into public.orgs (name, slug) values ('Assertion Probe 2', 'assert-probe-'||gen_random_uuid())
      returning id into probe_org;
    insert into public.org_members (org_id, user_id, role, status)
      values (probe_org, probe_user, 'owner', 'active');
    begin
      delete from public.org_members where org_id = probe_org;
    exception when others then
      seat_blocked := sqlerrm like '%at least one owner or admin%';
    end;

    -- (c) and for a demotion.
    begin
      update public.org_members set role = 'member' where org_id = probe_org;
    exception when others then
      demote_blocked := sqlerrm like '%at least one owner or admin%';
    end;

    raise exception 'ROLLBACK_PROBE';
  exception when others then
    if sqlerrm <> 'ROLLBACK_PROBE' then raise; end if;
  end;
  end if;

  if not probe_skipped and not org_deleted then
    raise exception 'an org with a sole active owner still cannot be deleted — the escape did not take';
  end if;
  if not probe_skipped and not seat_blocked then
    raise exception 'the admin floor no longer blocks deleting the sole owner seat — the escape is too broad';
  end if;
  if not probe_skipped and not demote_blocked then
    raise exception 'the admin floor no longer blocks demoting the sole owner';
  end if;

  -- (d) CONTROL: the impact function can see the FKs it claims to walk. Zero
  --     would make the inventory silently empty — under-reporting a
  --     destructive action, the worst direction.
  select count(*) into n
    from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid
    join pg_namespace ns on ns.oid = cl.relnamespace
   where con.contype = 'f' and con.confrelid = 'public.orgs'::regclass
     and ns.nspname = 'public' and cl.relkind in ('r', 'p')
     and con.conparentid = 0 and array_length(con.conkey, 1) = 1;
  if n < 50 then
    raise exception 'only % FKs to orgs found — the impact inventory would under-report', n;
  end if;

  -- (e) The function is actually CALLABLE and its authority gate actually
  --     fires. Review found the earlier block never invoked it at all: it
  --     could have been mis-granted, or raised on every call, and everything
  --     above would still have passed. This migration runs as `postgres` with
  --     no JWT, so is_superadmin() is false and the correct outcome is a
  --     REFUSAL — which proves existence, executability and the gate at once.
  begin
    perform public.org_delete_impact(gen_random_uuid());
    raise exception 'org_delete_impact did not refuse an unauthenticated caller';
  exception when insufficient_privilege then
    null;  -- 42501, exactly as intended
  end;
end $$;

-- ⚠ WHAT THESE ASSERTIONS DELIBERATELY DO NOT COVER, named so they are not
-- mistaken for comprehensive (adversarial review, 2026-09-28):
--
--  1. THE ORPHANING REFUSAL — that deleting a user who solely administers a
--     SURVIVING org is still blocked. That is the entire reason this escape
--     tests parent-existence instead of `pg_trigger_depth()` alone, and
--     nothing here asserts it: replace the conjunct with a bare depth test and
--     every assertion above still passes. It is NOT asserted here because
--     probing it means DELETEing a real user, and a migration that mutates
--     live tenant data to prove itself is a pattern this repo should not
--     normalise. It IS asserted, against real seeded users, in
--     `packages/db/src/org-delete.test.ts` ("THE FLOOR HOLDS ACROSS THE OTHER
--     CASCADE"), which runs in CI.
--  2. That `org_delete_impact` returns CORRECT ROWS for a real org — (e) only
--     proves it refuses the wrong caller. Correct output needs a superadmin
--     session, which a migration does not have; also covered by that test file.
