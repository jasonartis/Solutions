-- The email slice, STEP 4 of docs/22 §11: `profiles` becomes a PUBLIC IDENTITY
-- ROW and nothing else (2026-09-17). `email`, `settings` and `is_superadmin` all
-- leave it; what remains is `user_id, display_name, created_at, updated_at`.
--
-- ############################################################################
-- ## DEPLOY ORDERING IS ONE-DIRECTIONAL AND IT IS THE OPPOSITE OF THIS      ##
-- ## REPO'S NORMAL HABIT. THE APPLICATION CODE MUST BE LIVE ON PRODUCTION   ##
-- ## *BEFORE* `pnpm migrate:prod` RUNS THIS FILE.                           ##
-- ##                                                                        ##
-- ## Dropping a column is the one schema change that is NOT additive, so    ##
-- ## code and migration cannot be decoupled the way docs/03 normally allows.##
-- ## On this platform they are already separate steps by construction:      ##
-- ## `git push` deploys the app through Vercel, and `pnpm migrate:prod` is a##
-- ## MANUAL step that nothing in CI runs. That separation is the safety     ##
-- ## here -- but only in one direction. Run this FIRST and it is a          ##
-- ## simultaneous app-wide outage across ALL SIX shipped modules, every     ##
-- ## affected query failing 42703. Review B named this as its sharpest      ##
-- ## operational point (docs/22 §14.2).                                     ##
-- ##                                                                        ##
-- ## PRECONDITION, CHECKABLE: 20260917010000 must already be applied AND    ##
-- ## the app build that calls its definers must be serving production.      ##
-- ## `scripts/prod-verify-profile-visibility.mts` asserts the after-state.  ##
-- ############################################################################
--
-- WHAT THIS IS NOT. It does NOT touch `profiles_select_shared_org`, the blanket
-- co-member row read. Killing that is docs/22 §19.4 and it is BLOCKED on the
-- founder-deferred entity-level visibility question (§20.2): the resolver rule
-- it needs -- "you may resolve a name for a person you are legitimately
-- interacting with" -- contains the deferred question inside the phrase
-- "legitimately interacting with". Do not merge the two (§20.4).
--
-- So after this migration a co-member still reads every co-member's
-- `display_name`. That is decision 6 and it is intended: a name is essentially
-- always visible to co-members (Discord, Slack, Meetup, LinkedIn). What they can
-- no longer read is an email address, a settings blob, or who the platform
-- superadmin is.

-- ---------------------------------------------------------------------------
-- 1. `display_name` backfill -- "searchable implies mandatory" has a tail
--    (docs/22 §17.6, §11 step 1)
--
-- MEASURED ON PROD 2026-09-17: 1 of 12 users has a NULL `display_name`
-- (control: the other 11 are non-null). Until now every roster fell back to
-- `display_name || email`, so that row rendered as an address; after this
-- migration there is no address to fall back to and it would render as a bare
-- UUID.
--
-- Signup now COLLECTS a display name (`apps/web/app/login/page.tsx`), so no new
-- account can arrive NULL, and `/account` lets anyone change theirs -- the
-- `grant update (display_name)` for that has existed since 20260706120000 and
-- had never been used by any screen.
--
-- THE BACKFILL VALUE IS THE EMAIL LOCAL-PART, and the trade is stated rather
-- than hidden: `display_name` is PUBLIC to co-members, so seeding it from an
-- address discloses the part before the @. It is chosen anyway because it is
-- generic (no name is hardcoded, and it behaves identically in any
-- environment), it is the convention every product uses for exactly this
-- backfill, and the person can change it in one screen. On PRODUCTION it
-- affects exactly one row and that row is the founder's own account, so no
-- third party's address is involved at all.
update public.profiles p
set display_name = split_part(u.email, '@', 1)
from auth.users u
where u.id = p.user_id
  and (p.display_name is null or btrim(p.display_name) = '')
  and u.email is not null;

-- ---------------------------------------------------------------------------
-- 2. The PRIVATE per-user companion table (docs/22 §21.2)
--
-- THE GAP THE FOUNDER FOUND: *"what about email addresses? What if we want to
-- add something later, are we making provisions for that?"* docs/22 §6 said
-- `settings` and `is_superadmin` "leave profiles" and never said WHERE TO. This
-- table is the destination, and it is equally the provision for the next private
-- field -- which is the durable half of the answer.
--
-- THIS IS NOT OPTION A RETURNING (docs/22 §21.5). Option A was rejected for
-- creating a SECOND COPY of email -- data whose authoritative home is
-- `auth.users`, kept in sync by nothing. This table copies nothing: `settings`
-- and `is_superadmin` have no other home and simply move, once. No backfill
-- trigger, no sync obligation, no staleness -- which were the three arguments
-- against Option A.
--
-- THE RECURSION QUESTION, DEMONSTRATED AND NOT REASONED ABOUT (docs/22 §21.4
-- required this before any SQL was written). `is_superadmin()` READS the
-- `is_superadmin` column, and this table's own SELECT policy CALLS
-- `is_superadmin()`. Run live in a ROLLED-BACK transaction on 2026-09-17
-- against this exact shape: the superadmin read all 11 rows through the
-- self-referential policy -- NO RECURSION, no 42P17. CONTROLS, so the pass is
-- not vacuous: an ordinary user in the same transaction saw exactly 1 row (their
-- own), proving the policy was genuinely being ENFORCED rather than bypassed,
-- and `is_superadmin()` returned false for them. The rollback was confirmed
-- clean (0 rows left in `pg_class`/`pg_proc`, with a control query proving those
-- catalog reads can see a table that does exist). The mechanism: the function is
-- SECURITY DEFINER owned by `postgres`, so it bypasses RLS entirely and never
-- re-enters the policy. The recorded fallback -- leave `is_superadmin` on
-- `profiles` -- was therefore not needed.
create table public.user_private (
  user_id uuid primary key references auth.users (id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  is_superadmin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.user_private is
  'PRIVATE per-user row. Readable only by the user themselves and by a platform '
  'superadmin. This is the home for anything per-user that must NOT be visible '
  'to a co-member -- see the comment on public.profiles for the rule, and '
  'docs/22-profile-visibility.md section 21.';

create trigger user_private_updated_at
  before update on public.user_private
  for each row execute function public.set_updated_at();

alter table public.user_private enable row level security;

-- One row per existing user, carried over verbatim. `profiles` is the source
-- because it is still the live home at this point in the file.
insert into public.user_private (user_id, settings, is_superadmin, created_at)
select p.user_id, p.settings, p.is_superadmin, p.created_at
from public.profiles p;

-- ACL: REVOKE FIRST, THEN GRANT. STATE THE WHOLE INTENDED SET (docs/03 #1).
--
-- ⚠ THIS IS A FIX, AND THE BUG IT FIXES WAS A REAL PRIVILEGE ESCALATION THAT
-- PASSED LOCALLY AND FAILED IN CI. The first version of this block had the
-- `grant` lines below WITHOUT the `revoke`, on the reasoning that a table
-- created by a CLI migration inherits no API-role grants. That reasoning is
-- what docs/03 #1 already warns about, and it is only true of the environment
-- you happen to be sitting in:
--
--   `pg_default_acl`, measured 2026-09-17 on the local stack:
--     grantor=postgres schema=public  -> authenticated=Dxtm     (no UPDATE)
--     grantor=postgres schema=storage -> authenticated=arwdDxtm (UPDATE on ALL)
--
-- So the default for a NEW TABLE is whatever that row says, and it is not the
-- same everywhere. In CI it was permissive enough that `authenticated` held
-- table-level UPDATE — which covers EVERY COLUMN — and the RLS suite caught it
-- in the bluntest possible way: **`bob@demo.local`, an ordinary user, set his
-- own `is_superadmin` to true.** He then passed `is_org_admin` everywhere and
-- took 23 further tests down with him. The column-scoped grant below cannot
-- defend anything if a table-level grant already covers it: a narrower grant
-- never subtracts from a wider one (the same arithmetic that killed v3 of this
-- workstream -- docs/20 §9).
--
-- `20260728010000_acl_hardening.sql` had already established exactly this
-- pattern for every table that existed then (`revoke all privileges on all
-- tables in schema public from anon, authenticated` and then grant back). A
-- table added afterwards is outside that sweep and must do it itself.
--
-- WHAT THE INTENDED SET IS, stated positively:
--   * `authenticated` -- SELECT (policy-filtered to own row + superadmin), and
--     UPDATE on `settings` ONLY. No INSERT, no DELETE: a row's existence is the
--     signup trigger's business, not the user's.
--   * `is_superadmin` gets NO write grant to ANY api role. Promotion runs
--     through `service_role`, which is not subject to RLS. That grant, not the
--     policy, is the real gate -- the policies are defence in depth.
--   * `anon` holds nothing at all.
revoke all privileges on public.user_private from public, anon, authenticated, service_role;

grant select on public.user_private to authenticated;
grant update (settings) on public.user_private to authenticated;
grant select, insert, update, delete on public.user_private to service_role;

-- Same shape as the `profiles_select_own` policy this replaces for these two
-- columns, so the semantics do not move: your own row, plus the superadmin.
create policy user_private_select_own on public.user_private
  for select using (user_id = auth.uid() or public.is_superadmin());

-- Self-write only. Both USING and WITH CHECK, so a row cannot be updated INTO
-- or OUT OF someone else's ownership.
create policy user_private_update_own on public.user_private
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- DELIBERATELY ABSENT: any superadmin WRITE policy. An earlier draft of this
-- migration carried `user_private_write_superadmin ... for all using
-- (is_superadmin())`, and adversarial review A took it apart on 2026-09-17.
-- Two things were wrong with it and only the second is obvious in hindsight:
--
--   1. IT GRANTED NOTHING THE SUPERADMIN NEEDED. Reading every private row is
--      already covered by the `or public.is_superadmin()` arm of
--      `user_private_select_own` above, so the `for all` policy's SELECT half
--      was pure duplication.
--   2. ITS UPDATE HALF WAS A REAL, UNINTENDED WIDENING. `for all` carries no
--      `user_id` restriction, so it ORed with the self-update policy and let a
--      superadmin overwrite ANY OTHER USER'S `settings` blob — which the
--      review demonstrated live. Its own comment claimed it existed so
--      superadmins could administer the `is_superadmin` FLAG, and that
--      capability never existed for `authenticated` at all: the column grant is
--      `settings` only, so the flag write is refused by privilege regardless of
--      policy. The comment described a capability that was absent and stayed
--      silent about the one that was present.
--
-- This is docs/20 §8.1's already-shipped lesson arriving in a new place — a
-- `for all` policy's USING governs SELECT too, and splitting them is what makes
-- each authority legible. Nothing needs the write: promotion to superadmin runs
-- through `scripts/prod-promote-superadmin.ts` as `service_role`, which holds
-- full table grants above and is not subject to RLS.

-- ---------------------------------------------------------------------------
-- 3. Re-point the three functions that read the moved columns.
--    The APP does not change again: 20260917010000 already put the indirection
--    in front of it, and it was deployed and live before this file ran.
-- ---------------------------------------------------------------------------

-- The one-line change docs/22 §6 predicted. The NINE other functions that
-- reference `is_superadmin` (`is_org_admin`, `module_roles_guard_hierarchy`,
-- `module_roles_guard_last_director`, `org_accept_invite`, `org_caller_rank`,
-- `org_members_guard_hierarchy`, `org_modules_pin_enablement`,
-- `superadmin_log_guard`) call the FUNCTION, not the column -- VERIFIED LIVE
-- 2026-09-16 -- which is why moving the column is one edit here rather than a
-- nine-function sweep.
create or replace function public.is_superadmin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select is_superadmin from public.user_private where user_id = auth.uid()),
    false
  );
$$;

create or replace function public.current_user_private()
returns table (settings jsonb, is_superadmin boolean)
language sql
stable
security definer
set search_path = public
as $$
  select up.settings, up.is_superadmin
  from public.user_private up
  where up.user_id = auth.uid();
$$;

-- `org_accept_invite` — THE ONE READER `is_superadmin()` CANNOT COVER, and it
-- was missed by the design's own survey. Found by the RLS suite, not by
-- reading: the invite-accept tests failed with `column p.is_superadmin does
-- not exist`.
--
-- WHY IT IS DIFFERENT FROM THE NINE OTHERS: every other function asks "is the
-- CALLER a superadmin", which is exactly what `is_superadmin()` answers. This
-- one asks whether `inv.invited_by` — ANOTHER USER, who is not the caller and
-- may not even be in the org any more — was a superadmin, because it
-- revalidates that a stale high-privilege invite is still legitimate (docs/15
-- §4.1). `is_superadmin()` takes no argument and could never have served it.
--
-- WORTH RECORDING, because it is the second time in this workstream the same
-- shape of miss happened: docs/22 §6 measured that "no application code reads
-- another user's `settings` or `is_superadmin`" and that measurement was
-- CORRECT — it searched TypeScript. A SQL FUNCTION BODY IS ALSO A CALL SITE.
-- Same lesson as §14.1's R10 in a different costume: the survey looked where
-- the pattern was expected to be.
--
-- The read stays a bare table read of another user's flag; only the table
-- changes. It is inside a SECURITY DEFINER that already runs with `postgres`
-- authority, so `user_private`'s RLS is no more an obstacle than `profiles`'
-- was.
create or replace function public.org_accept_invite(check_org_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  inv public.org_members%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select * into inv
  from public.org_members
  where org_id = check_org_id
    and user_id = auth.uid()
    and status = 'pending';

  if not found then
    raise exception 'No pending invitation to accept for this organization';
  end if;

  -- Revalidate: the inviter must STILL be authorized to have issued this invite
  -- — a platform superadmin, or an active member who still strictly outranks
  -- the invited role. Blocks a stale high-privilege invite from an inviter who
  -- has since been removed or demoted (docs/15 §4.1).
  if inv.invited_by is null
     or not (
       exists (
         select 1 from public.user_private up
         where up.user_id = inv.invited_by and up.is_superadmin
       )
       or exists (
         select 1 from public.org_members ib
         where ib.org_id = check_org_id
           and ib.user_id = inv.invited_by
           and ib.status = 'active'
           and public.org_role_rank(ib.role) > public.org_role_rank(inv.role)
       )
     )
  then
    raise exception 'This invitation is no longer valid — ask an admin to re-invite you';
  end if;

  update public.org_members
     set status = 'active', accepted_at = now()
   where org_id = check_org_id and user_id = auth.uid() and status = 'pending';
end;
$$;

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
  insert into public.user_private (user_id, settings)
  values (auth.uid(), coalesce(new_settings, '{}'::jsonb))
  on conflict (user_id) do update set settings = excluded.settings;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The signup path (docs/03's auth-trigger criticality rules apply: this
--    function runs INSIDE the `auth.users` INSERT, so anything that raises here
--    aborts the whole signup).
--
-- TWO CHANGES, and the first REMOVES a live failure mode rather than adding one:
--
--   (a) It stops writing `email`. With the column goes `profiles_email_key`, a
--       NON-PARTIAL unique constraint -- and `auth.users`' own email uniqueness
--       is PARTIAL (`users_email_partial_key ... WHERE is_sso_user = false`).
--       So GoTrue would happily create an SSO user whose address duplicates an
--       existing one, and this trigger would then hit a UNIQUE violation and
--       ABORT THE ENTIRE SIGNUP -- in a case `auth.users` was designed to
--       tolerate. Found by adversarial review A (docs/22 §4.6). Zero rows are
--       affected today (no SSO provider is configured), which makes it a latent
--       trap rather than an outage, and it is recorded as the vacuous negative
--       it is. Deleting the column removes the constraint and the trap with it.
--
--   (b) It now writes the companion row too. Both inserts are in one trigger, so
--       a user can never exist with a `profiles` row and no `user_private` row.
--
-- `display_name` is now collected at signup and arrives in `raw_user_meta_data`.
-- It stays NULLABLE in the schema: a magic-link signup may legitimately not
-- carry one, and a NOT NULL here would abort that signup -- exactly the class of
-- failure (a) removes.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, display_name)
  values (new.id, nullif(btrim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), ''));

  insert into public.user_private (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. THE DROP.
--
-- `pg_depend` on `profiles.email` (attnum 2) returns EXACTLY ONE row: an `auto`
-- dependency from `profiles_email_key`, which the drop takes with it. CONTROL,
-- so that single row is a real measurement and not a broken query: the identical
-- query on `user_id` (attnum 1) returns SIX rows -- the PK, an FK, and THREE
-- policy dependencies -- proving the query does surface policy dependents when
-- they exist. Verified 2026-09-16 (docs/22 §13.1).
--
-- The column-level grants (`grant update (display_name, settings)`, issued by
-- 20260728010000) go with their columns; `display_name` keeps its own.
-- ---------------------------------------------------------------------------
alter table public.profiles
  drop column email,
  drop column settings,
  drop column is_superadmin;

-- ---------------------------------------------------------------------------
-- 6. THE RULE, written where a schema reader will find it (docs/22 §21.2, §21.3)
--
-- This is the durable output of the whole exercise and it is worth more than any
-- of the tables. `settings` was added to `profiles` in 20260727010000 and became
-- readable by every org-mate THE SAME DAY. Nobody decided that and nobody
-- noticed -- because the table's public nature had never been written down
-- anywhere. Documentation alone did not stop it and will not stop the next one,
-- so this comment is paired with a RATCHET TEST over `profiles`' column list
-- (packages/db/src/profiles-public-columns.test.ts) that fails the build when
-- the set changes. The rule also goes into docs/03's conventions.
comment on table public.profiles is
  'PUBLIC IDENTITY ROW. Every column here is readable by every co-member, by '
  'definition -- profiles_select_shared_org grants the whole row to anyone who '
  'shares an org, and a POLICY FILTERS ROWS, NEVER COLUMNS. Before adding a '
  'column, decide which home it belongs in: PUBLIC identity -> here; PRIVATE '
  'per-user -> public.user_private; SHAREABLE org-scoped -> the in-org profile '
  '(deferred, docs/22 section 16). If the column is private and it lands here, '
  'you have shipped the exact bug this table was fixed for. '
  'See docs/22-profile-visibility.md section 21.';
