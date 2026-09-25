-- Complete the revoke on two trigger functions (2026-09-25).
--
-- WHAT IS WRONG. `service_role` holds EXECUTE on exactly two of the platform's
-- 61 trigger functions:
--
--     public.view_as_guard_session()
--     public.vm_guard_last_conversation_admin()
--
-- Nobody granted it. Both creating migrations revoke from `public, anon,
-- authenticated` and stop one role short:
--
--     20260731010000:270  revoke ... from public, anon, authenticated;
--     20260914020000:157  revoke ... from public, anon, authenticated;
--     20260922030000:375  revoke ... from public, anon, authenticated;   (create or replace)
--
-- (`create or replace function` PRESERVES the existing ACL, which is why the
-- September re-creation of vm_guard_last_conversation_admin did not clear it.)
--
-- WHY ONLY ON PROD, AND WHY THAT IS THE INTERESTING PART. The grant was never
-- written by a migration — it was applied automatically at CREATE time by
-- prod's `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public`, which
-- grants EXECUTE on every new function to anon, authenticated AND service_role.
-- The incomplete revoke then took back three of the four. Measured 2026-09-25:
--
--     PROD   default for functions:  postgres=X | anon=X | authenticated=X | service_role=X
--     LOCAL  default for functions:  postgres=X
--
-- So on LOCAL there was never anything to leak and the same migrations look
-- complete; the defect is invisible there and always will be. This is docs/03
-- #1's local/prod divergence caught in the wild rather than reasoned about.
--
-- ⚠ WHY THESE TWO AND NOT OTHERS — AND THE OBVIOUS WRONG ANSWER. An earlier
-- draft of this header said they are "the only trigger functions created after
-- 20260728010000's blanket revoke." THAT IS FALSE, and adversarial review
-- caught it. At least four others were created after it — `superadmin_log_guard`
-- (20260807010000), `capture_login` (20260809010000), `activity_event_guard` and
-- `activity_rollup_apply` (20260810010000) — and all return `trigger`. They are
-- clean because each of their migrations revoked from ALL FOUR roles, not
-- because they do not exist. The correct rule is therefore about the REVOKE, not
-- about the date: a post-sweep trigger function is safe iff its own migration
-- named all four roles. The wrong version of this sentence would have told the
-- next reader there was nothing to check.
--
-- SEVERITY: LOW, AND SAID PLAINLY SO THIS IS NOT OVERSOLD. A trigger function
-- cannot be invoked directly whatever the grant — it returns pseudo-type
-- `trigger`, and Postgres refuses the call — and `service_role` is not
-- internet-reachable (it lives only in the worker, which bypasses RLS anyway).
-- Adversarial review confirmed zero direct call sites: no `.rpc()` in apps/ or
-- scripts/, and no occurrence inside any SQL function body or policy. This is an
-- unintended grant and a proof that the auto-grant mechanism fires in practice.
-- It is not a reachable hole.
--
-- WHY FIX IT AT ALL, then: (1) a privilege nobody decided to grant is how the
-- reachable ones begin; (2) `scripts/verify-acl-hardening.ts` reports it, and a
-- permanently-red checker is one nobody reads — this repo has already watched
-- that happen to this very script; (3) it is the last thing between that script
-- and running in CI, which is the forcing function that stops it rotting again.
--
-- SAFETY, ESTABLISHED EMPIRICALLY RATHER THAN ASSUMED (docs/15's 2026-07-29
-- entry). Trigger-function EXECUTE is checked at `create trigger` time, NOT at
-- fire time. The ACL sweep proved this on 54 trigger functions by testing as
-- `authenticated`, as `service_role`, and — the catastrophic case — as
-- `supabase_auth_admin`, where signup still created its profile row with the
-- grant fully revoked. Prod has run that way since 2026-07-28. Revoking here
-- therefore cannot stop either trigger from firing; both remain bound and
-- enabled, and nothing about them changes. (Moot here anyway: these two fire on
-- `view_as_sessions` and `vm_conversation_members`, never in the `auth` schema.)
--
-- ⚠ HOW TO VERIFY THIS ON PROD — NOT with the usual script. `prod-verify-
-- migration.ts` parses `create function` blocks; this migration defines none, so
-- its "0 failures" here would be VACUOUS (the same trap docs/03 records for
-- policy-only migrations). The real check is
-- `pnpm exec tsx scripts/verify-acl-hardening.ts`, which reported this defect in
-- the first place and must go from 16/17 to **17/17** on prod afterwards.
--
-- The full ACL is stated rather than just the missing role (docs/03 #1): naming
-- all four is what makes the intent unambiguous, and it is precisely the
-- shortcut of naming only some of them that produced this defect.

revoke execute on function public.view_as_guard_session()
  from public, anon, authenticated, service_role;

revoke execute on function public.vm_guard_last_conversation_admin()
  from public, anon, authenticated, service_role;

-- ===========================================================================
-- Assertions — prove the end state rather than trusting the statements above.
-- ===========================================================================
do $$
declare
  leaked text;
  n integer;
  fname text;
begin
  -- 1. THE WHOLE CLASS, not just the two touched here. If any other trigger
  --    function holds an api-role EXECUTE, this migration is incomplete and
  --    should fail loudly rather than close two and leave a third.
  --    NOTE (adversarial review): because this polices all 61 rather than the
  --    two, a FUTURE migration applied in the same `supabase db push` batch that
  --    adds an unrevoked trigger function would fail HERE rather than in its own
  --    file. That is the intended direction — the batch aborts and the database
  --    does not move — but the error will name the wrong migration.
  select string_agg(p.proname || '()', ', ' order by p.proname) into leaked
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_type t on t.oid = p.prorettype
   where n.nspname = 'public'
     and p.prokind = 'f'
     and t.typname = 'trigger'
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE')
       or has_function_privilege('service_role', p.oid, 'EXECUTE'));
  if leaked is not null then
    raise exception 'trigger functions still hold api-role EXECUTE: %', leaked;
  end if;

  -- 2. CONTROL for assertion 1's POPULATION. It is a negative over a filtered
  --    set, so it would pass just as happily if the filter matched NOTHING —
  --    e.g. if the `trigger` return-type test silently stopped matching.
  select count(*) into n
    from pg_proc p
    join pg_namespace n2 on n2.oid = p.pronamespace
    join pg_type t on t.oid = p.prorettype
   where n2.nspname = 'public' and p.prokind = 'f' and t.typname = 'trigger';
  if n < 50 then
    raise exception 'only % trigger functions found — assertion 1 is vacuous', n;
  end if;

  -- 3. POSITIVE CONTROL for assertion 1's MECHANISM, which assertion 2 does not
  --    give (adversarial review). Assertion 1 is a pile of negatives; if
  --    `has_function_privilege` returned false for some unrelated reason, it
  --    would pass while proving nothing — and on LOCAL, where the defect never
  --    existed, it can only ever pass. So assert the function can return TRUE.
  --    Doubles as proof the revokes above did not bleed into unrelated grants.
  if not has_function_privilege('authenticated', 'public.is_superadmin()', 'EXECUTE') then
    raise exception
      'authenticated lost EXECUTE on is_superadmin() — either the revoke was far too broad, or has_function_privilege is not measuring what assertion 1 assumes';
  end if;

  -- 4. EACH guard trigger is still BOUND and ENABLED — checked PER FUNCTION.
  --    A lumped `count(*) >= 2` across both names (the earlier draft) would be
  --    satisfied by two triggers on one guard and none on the other, which is
  --    exactly the failure this is meant to exclude. Schema-qualified, too.
  --    ('O' = enabled in origin/local mode, the normal state; tgenabled is a
  --    stored column, so session_replication_role cannot skew this.)
  foreach fname in array array['view_as_guard_session', 'vm_guard_last_conversation_admin']
  loop
    select count(*) into n
      from pg_trigger tg
      join pg_proc p on p.oid = tg.tgfoid
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.proname = fname
       and not tg.tgisinternal
       and tg.tgenabled = 'O';
    if n < 1 then
      raise exception
        '% has no enabled trigger bound to it — revoking EXECUTE must never unbind or disable a trigger', fname;
    end if;
  end loop;
end $$;
