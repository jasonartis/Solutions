-- Pin the three view-as self-mask functions to the platform's function
-- convention: SECURITY DEFINER + `set search_path = public` (2026-09-22).
--
-- WHY THIS EXISTS — a convention violation caught by a mechanical guard, not by
-- review. `20260920010000` created sd_interest_mine / sd_matches_mine /
-- sd_pairings_mine as PLAIN (invoker) functions with no pinned search_path. The
-- reasoning at the time was "least privilege: they only call
-- sd_owns_participant, which is already definer, so the wrapper needs no
-- elevation." That argument is fine as far as it goes and it is still why these
-- three do not NEED definer — but it skipped the repo's standing convention,
-- and `scripts/prod-verify-migration.ts` failed all three the moment the
-- migration reached production (`INVOKER  NO-search_path`, bodies matching,
-- ACLs already correct). Recorded plainly because the guard did its job: this is
-- exactly the class of thing a human reviewer waves through.
--
-- WHY IT IS SAFE TO MAKE THEM DEFINER — measured against what they actually do,
-- not assumed. Each body is a single `select` of one already-definer predicate
-- and touches NO table directly. `sd_owns_participant` is itself SECURITY
-- DEFINER and keys on auth.uid(), which reads the request JWT and is unaffected
-- by the caller's own rights. So definer grants these wrappers nothing they can
-- use: there is no table read to escalate and no parameter naming "whose rows".
-- The behaviour before and after this migration is identical — verified by the
-- suite, which is unchanged and still green.
--
-- WHY search_path IS THE PART THAT ACTUALLY MATTERS. The bodies already
-- schema-qualify every name (`public.sd_owns_participant`), so nothing here
-- currently resolves through search_path at all. Pinning it is belt-and-braces
-- against a future edit that drops a qualification — which, on a definer
-- function, is the difference between calling the intended predicate and
-- calling an attacker-shadowed one. It is cheap and it is the convention
-- precisely because the failure mode is invisible.
--
-- FORWARD-ONLY: `20260920010000` is applied on production and is history, so it
-- is not edited (CI blocks that mechanically — docs/12 guard 2's sibling).
-- Bodies are restated verbatim; only the attributes change.

create or replace function public.sd_interest_mine(public.sd_interest)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.sd_owns_participant($1.rater_participant_id);
$$;

create or replace function public.sd_matches_mine(public.sd_matches)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.sd_owns_participant($1.participant_a_id)
      or public.sd_owns_participant($1.participant_b_id);
$$;

create or replace function public.sd_pairings_mine(public.sd_pairings)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.sd_owns_participant($1.participant_a_id)
      or public.sd_owns_participant($1.participant_b_id);
$$;

-- `create or replace` preserves the existing EXECUTE grants, which
-- prod-verify-migration.ts already confirmed correct (anon=no,
-- authenticated=yes, service_role=yes). Restated anyway so the intended ACL is
-- stated in full in one place rather than inherited silently (docs/03 #1).
revoke execute on function public.sd_interest_mine(public.sd_interest) from public, anon;
revoke execute on function public.sd_matches_mine(public.sd_matches) from public, anon;
revoke execute on function public.sd_pairings_mine(public.sd_pairings) from public, anon;
grant execute on function public.sd_interest_mine(public.sd_interest) to authenticated, service_role;
grant execute on function public.sd_matches_mine(public.sd_matches) to authenticated, service_role;
grant execute on function public.sd_pairings_mine(public.sd_pairings) to authenticated, service_role;

notify pgrst, 'reload schema';
