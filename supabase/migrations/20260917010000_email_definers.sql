-- The email slice, STEP 2 of docs/22 §11: the SECURITY DEFINER functions, added
-- while `profiles.email` still exists (2026-09-17). ADDITIVE AND REVERSIBLE.
-- Nothing breaks when this lands; nothing breaks if it lands before the app
-- code. It is the step that makes the DROP in 20260917020000 safe.
--
-- THE DESIGN: docs/22-profile-visibility.md, start at §0. Eleven founder
-- decisions are recorded in §0.2 and are not re-opened here. Two adversarial
-- reviews ran (§13, §14).
--
-- THE PROBLEM THIS SLICE FIXES (docs/22 §0.1, demonstrated live, not asserted):
-- charlie@demo.local -- a rank-0 nail-salon CUSTOMER holding no role of any kind
-- -- signs in and runs ONE query against `public.profiles`, and gets back eight
-- people's names AND EMAIL ADDRESSES, including the salon admin's. The cause is
-- that `profiles_select_shared_org` grants read of the WHOLE ROW to anyone
-- sharing an org, and A POLICY FILTERS ROWS, NEVER COLUMNS. Nobody chose to
-- expose the address; it came along with the name. "The UI never shows it" is
-- not a defence -- the app queries as the user, so the browser can ask the
-- database directly with the token the app already issued (docs/03 hard rule 6).
--
-- WHY NOT A NEW `profile_emails` TABLE, which is what docs/20 §31 literally
-- commissioned (docs/22 §4): `profiles.email` is a write-once copy of
-- `auth.users.email` that NO trigger has ever refreshed -- a cache with no
-- invalidation (a recorded latent bug in CLAUDE.md). A second copy one table
-- over INHERITS that bug and adds a sync obligation on the signup path. So the
-- copy is deleted instead and `auth.users` becomes the single source of truth,
-- read only through the definers below.
--
-- WHY THE GUARANTEE IS STRONGER IN KIND, not merely in degree (docs/22 §2.2,
-- VERIFIED ON PROD): `authenticated` holds NO privilege on `auth.users` at ROW
-- or COLUMN level, and no policy can create one -- a policy can only filter rows
-- a GRANT already permits, and `postgres` does not own the `auth` schema's
-- grants to hand out. v3 of this workstream died trying to SUBTRACT from a
-- table-level grant that already existed (docs/20 §9). This subtracts nothing.
--
-- ORDERING, AND IT IS NOT SYMMETRIC WITH 20260917020000:
--   * THIS migration is purely additive. Run `pnpm migrate:prod` FIRST, then
--     deploy the app code -- the normal habit. Reversed, the three module
--     resolvers would call `find_module_peer` before it exists.
--   * The NEXT migration DROPS a column, which forfeits additive-first by
--     design. There the order is INVERTED: code live FIRST, `migrate:prod`
--     second. Its own header says so again.
--
-- ACL DISCIPLINE (docs/03 convention #1): prod carries an
-- `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` that grants EXECUTE directly to
-- `anon`/`authenticated` at CREATE, which `revoke ... from public` does NOT
-- remove, and which local does not have. So every function below states its
-- FULL intended ACL explicitly rather than relying on a revoke from public.

-- ---------------------------------------------------------------------------
-- 1. The three EXISTING definers: one FROM clause each, profiles -> auth.users
--
-- Behaviour-preserving TODAY: measured on prod 2026-09-16 and again 2026-09-17,
-- ZERO of the 12 users have `profiles.email` differing from `auth.users.email`.
-- Behaviour-CORRECTING from the first email change onwards, which is the point:
-- the copy would have gone stale and these would have silently answered with a
-- dead address.
--
-- THE THREE `auth.users` FLAGS, decided explicitly rather than left to default
-- (docs/22 §4.5 item 4 -- the zero-counts that make them look unnecessary are
-- vacuous evidence, so the filters are stated, not inferred):
--   * `deleted_at is not null`  -> EXCLUDED. A soft-deleted account must not
--     resolve; `public.profiles` has no equivalent column, so this is a filter
--     that could not have existed before.
--   * `is_anonymous = true`     -> EXCLUDED. An anonymous session is not a
--     person with an address.
--   * `banned_until`            -> NOT filtered, deliberately. A ban is a
--     temporary state of a real account; an org admin administering a banned
--     member still needs to see who they are.
-- ---------------------------------------------------------------------------

-- The admin-scoped member roster. Unchanged in reach: `is_org_admin` already
-- gated it and still does. An org ADMIN keeps seeing member addresses; that is
-- the roster of people they administer. An ordinary co-member never did have a
-- reason to, and after the drop has no route to.
create or replace function public.org_member_profiles(check_org_id uuid)
returns table (user_id uuid, display_name text, email text)
language sql
stable
security definer
set search_path = public
as $$
  select p.user_id, p.display_name, u.email::text
  from public.profiles p
  join public.org_members m on m.user_id = p.user_id and m.org_id = check_org_id
  join auth.users u on u.id = p.user_id
  where public.is_org_admin(check_org_id)
    and u.deleted_at is null
    and coalesce(u.is_anonymous, false) = false;
$$;

-- Matchmaking's mutual-match reveal. PURPOSE-BOUND and unchanged: both parties
-- have independently expressed interest and the pair is not excluded, which is
-- exactly the "shared with someone who already earned it" test in docs/22
-- decision 5. This is the one surface that deliberately shows another person's
-- address, and it keeps doing so.
create or replace function public.mm_mutual_matches()
returns table (matched_user uuid, display_name text, email text)
language sql
stable
security definer
set search_path = public
as $$
  select mine.target_user_id, p.display_name, u.email::text
  from public.mm_interests mine
  join public.mm_interests theirs
    on theirs.org_id = mine.org_id
   and theirs.user_id = mine.target_user_id
   and theirs.target_user_id = mine.user_id
  join public.profiles p on p.user_id = mine.target_user_id
  join auth.users u on u.id = mine.target_user_id
  where mine.user_id = auth.uid()
    and public.mm_is_single(mine.org_id)
    and u.deleted_at is null
    and coalesce(u.is_anonymous, false) = false
    and exists (
      select 1 from public.mm_pair_scores s
      where s.org_id = mine.org_id
        and s.excluded = false
        and (
          (s.user_a = mine.user_id and s.user_b = mine.target_user_id)
          or (s.user_a = mine.target_user_id and s.user_b = mine.user_id)
        )
    );
$$;

-- ---------------------------------------------------------------------------
-- 2. The invite lookup: A LOOKUP NEVER CONFIRMS A NAME
--    (docs/22 decision 3, §15.2)
--
-- FOUNDER, asked whether a mistyped address should prompt "did you mean Sarah
-- Cohen?": *"no we should not."* So the NAME and the ADDRESS both leave the
-- return type and only `user_id` survives. This OVERTURNS docs/20 §3.4, which
-- had deliberately kept the name for exactly that confirmation; the trade was
-- put to the founder with the cost named and he chose the other way. It aligns
-- with five of the six products surveyed in docs/22 §22.1 and with OWASP
-- WSTG-IDNT-04.
--
-- CONSEQUENCE, and it is why `drop function` is required rather than
-- `create or replace`: the OUT parameters change, and Postgres will not replace
-- a function with a different result type.
--
-- WHAT IS DELIBERATELY *NOT* CHANGED: this function still resolves a user who is
-- NOT a member of `check_org_id`. That is not an oversight -- it is an INVITE
-- lookup, so the target is by definition not yet in the org. docs/20 §8.3 warns
-- explicitly against "fixing" it with an org join; doing so breaks every invite
-- on the platform. Its remaining exposure (an org admin can test whether an
-- arbitrary address has an account) is docs/20 §8.3's open item and is closed by
-- logging, not by this slice.
drop function if exists public.org_find_user_by_email(uuid, text);

create function public.org_find_user_by_email(check_org_id uuid, target_email text)
returns table (user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select u.id
  from auth.users u
  where public.is_org_admin(check_org_id)
    and lower(u.email) = lower(trim(target_email))
    and u.deleted_at is null
    and coalesce(u.is_anonymous, false) = false;
$$;

revoke execute on function public.org_find_user_by_email(uuid, text) from public, anon, authenticated;
grant execute on function public.org_find_user_by_email(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. `find_module_peer` -- the three module resolvers' replacement
--    (docs/22 §3 R5)
--
-- REPLACES an identical `.eq('email', ...)` read of `public.profiles` in three
-- places: classroom `manage/actions.ts:52`, matchmaking `manage/actions.ts:96`,
-- visual-messaging `actions.ts:169`.
--
-- IT IS STRICTLY NARROWER THAN WHAT IT REPLACES, which is the reason to prefer
-- it over a bare port. Today's read resolves ANYONE the caller shares ANY org
-- with (`profiles_select_shared_org`), and all three call sites then perform the
-- SAME follow-up check in application code -- "but are they an active member of
-- THIS org?" -- with three near-identical comments explaining why the lookup is
-- not itself a bound (docs/19 §1). That check moves INTO the definer here, so
-- the bound is in the database rather than in three copies of a comment.
--
-- AND IT CLOSES AN EXISTENCE ORACLE NOBODY HAD NAMED. Because the app check was
-- separate from the lookup, the three call sites raise two DIFFERENT errors
-- today: "No user with email X" versus "No user found with email X in this
-- organization -- add them as an org member first". The second sentence tells
-- the caller that the address exists on the platform but is not in their org.
-- Folding the two into one definer that returns NULL for both cases collapses
-- the two messages into one and removes the oracle. The app-side wording is
-- unified to match in the same commit.
--
-- THE CALLER GATE IS `is_org_member`, NOT A MODULE ROLE, and this was chosen
-- against the alternative on a measured risk. Gating on `has_module_role` would
-- be tighter, but docs/19's 2026-09-15 lesson is that GLOBAL vs SCOPED grants
-- are a CLIFF: `has_module_role` demands `scope_ref is null`, so a classroom
-- PROFESSOR -- whose grant is pinned to a class scope node -- would silently
-- fail the gate and lose the ability to enrol anyone. That is the exact
-- regression BOTH adversarial reviewers caught independently in that slice. An
-- `is_org_member` gate confers nothing new: an ordinary member can already read
-- the whole `org_members` roster (`org_members_select_member`) and every
-- co-member's `display_name`. All this adds is the email -> id DIRECTION,
-- bounded to an org they are already in, and it returns nothing at all for an
-- address outside it.
--
-- NO NAME, NO ADDRESS IN THE RETURN -- same rule as the invite lookup above.
--
-- IT FAILS CLOSED ON AN AMBIGUOUS ADDRESS, and that is not theoretical
-- housekeeping. `auth.users`' own email uniqueness is PARTIAL
-- (`users_email_partial_key ... WHERE is_sso_user = false`), so TWO accounts
-- may legitimately share one address — one SSO, one not (the same asymmetry
-- that produces the signup abort in docs/22 §4.6). A SQL function declared to
-- return a SCALAR over a query that yields two rows does NOT raise: it silently
-- returns the first (DEMONSTRATED 2026-09-17 in a rolled-back probe, which
-- returned row 1 of 2 with no error). Silently minting a seat for an ARBITRARY
-- one of two accounts is precisely the wrong-product-outcome failure this slice
-- exists to avoid, so the aggregate below returns NULL unless the match is
-- unique, and the caller reports "no such member" rather than guessing.
-- Found by adversarial review A, 2026-09-17.
create or replace function public.find_module_peer(check_org_id uuid, target_email text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  -- `min(uuid)` does not exist in Postgres, so the unique value is taken from
  -- an aggregated array rather than a min()/max() over the id.
  select case when count(*) = 1 then (array_agg(u.id))[1] end
  from auth.users u
  join public.org_members m on m.user_id = u.id
  where public.is_org_member(check_org_id)
    and m.org_id = check_org_id
    and m.status = 'active'
    and lower(u.email) = lower(trim(target_email))
    and u.deleted_at is null
    and coalesce(u.is_anonymous, false) = false;
$$;

revoke execute on function public.find_module_peer(uuid, text) from public, anon, authenticated;
grant execute on function public.find_module_peer(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. `superadmin_user_emails` -- the Owner Console's five sites (docs/22 §3 R3)
--
-- THE ONE REAL COST OF DELETING THE COLUMN, and docs/22 §4.4 states it plainly:
-- five console call sites (`console/page.tsx:36`, `lib/data-browser.ts:366`,
-- `lib/engagement.ts:97,233,250`) read another user's address through the
-- ordinary RLS client, and all five re-route through this ONE function.
--
-- Gated on `is_superadmin()`, which is the same authority those pages already
-- require -- `requireSuperadmin()` is the mint, and every console surface it
-- guards is independently RLS-gated on `is_superadmin()` anyway, so this
-- function grants nothing that a superadmin could not already obtain. It takes
-- an explicit id array rather than returning the whole table so that a console
-- page asks for the people it is displaying, not for a directory.
create or replace function public.superadmin_user_emails(target_user_ids uuid[])
returns table (user_id uuid, email text)
language sql
stable
security definer
set search_path = public
as $$
  select u.id, u.email::text
  from auth.users u
  where public.is_superadmin()
    and u.id = any(target_user_ids)
    and u.deleted_at is null;
$$;

revoke execute on function public.superadmin_user_emails(uuid[]) from public, anon, authenticated;
grant execute on function public.superadmin_user_emails(uuid[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. `sd_match_contacts` -- the ONLY SILENT failure in the whole survey
--    (docs/22 §5.1, §3 R7)
--
-- `modules/speed-dating/ui/actions.ts:351-367` reads BOTH parties' addresses
-- through the organizer's own RLS client and writes them into
-- `sd_matches.contact_shared`. docs/20 §11.3 records that write as WRITE-ONCE
-- AND NEVER RETRIED. So without this function the snapshot would be written with
-- a missing address and NO later run would ever repair it -- every other site in
-- the survey fails loudly with a 42703, and this one would have failed quietly
-- with a wrong product outcome. That is the failure mode docs/20's own history
-- says kills a design, which is why it is inside this slice and not after it.
--
-- THE AUTHORITY TEST IS THE MUTUAL-REVEAL EVENT ITSELF, mirroring what
-- `mm_mutual_matches` encodes for matchmaking (docs/22 §5.1 asks for exactly
-- this). Three conditions, all required:
--   * the caller can organize THIS event -- `sd_can_organize_event`, the
--     SCOPE-AWARE variant (20260726030000), not the org-wide `sd_can_organize`;
--   * the match is `revealed` -- before the reveal there is no mutual anything;
--   * the event's own `shareContactOnMatch` toggle is on, which is the whole
--     consent mechanism in v1 per the schema's own header note. READ WITH `->>`
--     AND A TEXT COMPARE, NOT `-> ... ::boolean`. `sd_events.format` is an
--     unconstrained jsonb blob; if any row ever stores the flag as the JSON
--     STRING `"true"` rather than the JSON boolean `true`, the cast raises
--     `22023 cannot cast jsonb string to type boolean` and ABORTS THE WHOLE
--     QUERY for that event rather than skipping one row — so the contact share
--     would fail for everybody at the exact moment it is write-once. All four
--     shapes were run live 2026-09-17: real boolean, JSON string, absent key,
--     NULL `format`. The cast raised on the second; `->>` handled all four.
--     Found by adversarial review A.
-- It returns one row per (match, participant), so the caller no longer needs a
-- separate `profiles` read to assemble the pair.
create or replace function public.sd_match_contacts(check_event_id uuid)
returns table (match_id uuid, user_id uuid, display_name text, email text)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, pa.user_id, pr.display_name, u.email::text
  from public.sd_matches m
  join public.sd_events e on e.id = m.event_id
  join public.sd_participants pa
    on pa.id in (m.participant_a_id, m.participant_b_id)
  join public.profiles pr on pr.user_id = pa.user_id
  join auth.users u on u.id = pa.user_id
  where m.event_id = check_event_id
    and m.revealed = true
    and coalesce(e.format ->> 'shareContactOnMatch', '') = 'true'
    and public.sd_can_organize_event(e.org_id, e.id)
    and u.deleted_at is null
    and coalesce(u.is_anonymous, false) = false;
$$;

revoke execute on function public.sd_match_contacts(uuid) from public, anon, authenticated;
grant execute on function public.sd_match_contacts(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. The caller's own PRIVATE columns, behind a function so the NEXT migration
--    can move them without a second app deploy (docs/22 §21)
--
-- `settings` and `is_superadmin` ride along out of `profiles` (founder, docs/22
-- decision 2: *"let them ride along"*) into a private per-user companion table.
-- But a companion table cannot be created in THIS migration and read by code
-- deployed BEFORE it: that is the deadlock the one-directional deploy ordering
-- creates. Both columns keep no copy anywhere, so the mirror argument that
-- killed Option A does not apply to them (docs/22 §21.5) -- they simply move,
-- once.
--
-- THE INDIRECTION IS WHAT BREAKS THE DEADLOCK. These two functions read and
-- write `public.profiles` TODAY. The app is re-pointed at them while that is
-- still true, so nothing changes. 20260917020000 then swaps ONE body each to the
-- companion table, and the app never changes again.
--
-- VERIFIED LIVE 2026-09-16 (docs/22 §6): no application code reads another
-- user's `settings` or `is_superadmin` -- all nine hits read the CALLER's own
-- row. So moving both costs nothing app-side beyond this indirection.
create or replace function public.current_user_private()
returns table (settings jsonb, is_superadmin boolean)
language sql
stable
security definer
set search_path = public
as $$
  select p.settings, p.is_superadmin
  from public.profiles p
  where p.user_id = auth.uid();
$$;

revoke execute on function public.current_user_private() from public, anon, authenticated;
grant execute on function public.current_user_private() to authenticated, service_role;

-- The write half. Only ever the caller's OWN row -- `auth.uid()` is the whole
-- WHERE clause and there is no parameter that could name another user.
create or replace function public.set_current_user_settings(new_settings jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  update public.profiles set settings = coalesce(new_settings, '{}'::jsonb)
  where user_id = auth.uid();
end;
$$;

revoke execute on function public.set_current_user_settings(jsonb) from public, anon, authenticated;
grant execute on function public.set_current_user_settings(jsonb) to authenticated, service_role;
