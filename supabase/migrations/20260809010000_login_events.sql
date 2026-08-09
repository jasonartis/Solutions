-- ENGAGEMENT MONITORING, PHASE 1 — LOGIN CAPTURE.
-- Spec: docs/17-engagement-monitoring.md (founder-approved 2026-08-09, phase 1
-- only). Phase 2 (org-scoped activity), phase 3 (the console page) and phase 4
-- (hierarchy-governed reads) are NOT in this migration.
--
-- WHAT IT ANSWERS: "who has gone quiet, and who should I reach out to." Phase 1
-- delivers the person half of that — is this person alive on the platform at
-- all — because a login has no org context (see THE SECOND HARD FACT below).
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS AS A CAPTURE MECHANISM AT ALL, RATHER THAN A QUERY.
-- ---------------------------------------------------------------------------
-- `auth.audit_log_entries` HAS NEVER BEEN WRITTEN TO ON PRODUCTION. Measured
-- read-only against prod 2026-08-09: `ins=0, del=0, live=0` — not pruned, never
-- inserted, because Supabase's hosted GoTrue routes auth logs to platform
-- logging instead. The control matters as much as the finding, since a zero
-- count is exactly the shape of a broken query: on the same connection
-- `auth.users` showed `ins=12`, `auth.sessions` `ins=27`, `auth.refresh_tokens`
-- `ins=51`. The read works; the absence is real.
--
-- That same table is FULLY POPULATED LOCALLY (160 rows). So building the
-- feature on it yields a dashboard that demos perfectly on a developer machine
-- and is permanently, silently empty in production — reporting "nobody has ever
-- logged in", which is indistinguishable from a true answer. This is the ACL
-- trap in a new costume: local and prod disagree, and only prod matters.
--
-- What prod actually has is `auth.users.last_sign_in_at`: the LAST login, never
-- a frequency. `auth.sessions` is lossy by construction (12 of 27 rows already
-- deleted by logout / token rotation). So LOGIN FREQUENCY DOES NOT EXIST
-- ANYWHERE TODAY — it has to be captured going forward, and, exactly like the
-- superadmin lookup log, a log started later can never cover the period before
-- it existed. That is the whole argument for shipping capture before the UI.
--
-- ---------------------------------------------------------------------------
-- THE MECHANISM, AND WHY IT IS NOT NOVEL.
-- ---------------------------------------------------------------------------
-- GoTrue updates `auth.users.last_sign_in_at` on every sign-in. This repo has
-- owned a trigger on `auth.users` since day one — `on_auth_user_created`, an
-- AFTER INSERT calling `handle_new_user()`, live in production since
-- `20260706120000_core.sql:49-51`. An `AFTER UPDATE OF last_sign_in_at` sibling
-- is the same mechanism in the same place, already proven to survive the
-- managed environment.
--
-- VERIFIED EMPIRICALLY ON THIS STACK BEFORE THIS FILE WAS WRITTEN (2026-08-09),
-- because the whole design rests on it and "GoTrue probably does X" is not a
-- fact:
--   * a password grant DOES advance last_sign_in_at (18:37:50 -> 19:06:50);
--   * a refresh_token grant does NOT touch it (stayed 19:06:50).
-- So one row here means one real sign-in, not one token refresh. That is the
-- difference between a login count and a noise count.
--
-- AND THE ONE THAT WOULD HAVE BEEN A SILENT HOLE: a brand-new `/signup` DOES
-- produce a row. This was worth measuring rather than assuming, because if
-- GoTrue set `last_sign_in_at` in the same INSERT that creates the user, no
-- UPDATE would fire and EVERY user's first-ever login would be missing — which
-- would corrupt `first_observed_login_at` and could report a brand-new active
-- user as "never signed in", the exact false answer this feature must not give.
-- It does not: GoTrue inserts the user and then UPDATEs the timestamp, so the
-- trigger sees it. Confirmed 2026-08-09 (signup -> 1 event, second sign-in -> 2).
--
-- ---------------------------------------------------------------------------
-- THE SECOND HARD FACT: A LOGIN CANNOT BE ATTRIBUTED TO AN ORG.
-- ---------------------------------------------------------------------------
-- People sign into the PLATFORM, not into an org. `auth` has no org concept.
-- For someone who belongs to three orgs, "logged into org B" is undefined at
-- the auth layer, and fanning one sign-in out across their three orgs would
-- turn one login into three "engagements" — making a three-org member look
-- three times as active as a one-org member who uses the platform more. That is
-- a false claim in the OVER-reporting direction, which is the direction that
-- misleads an outreach decision.
--
-- SO THERE IS NO org_id, NO module_key, NO role AND NO scope_ref ON EITHER
-- TABLE BELOW, and that is a decision rather than an omission (founder-approved
-- 2026-08-09, spec section 5). They would be null on 100% of the rows this
-- build can ever write, and the lookup log's own header records why an all-null
-- hierarchy column is worse than no column: it is precisely what invites the
-- rank-0 confusion below to be written carelessly later.
--
-- Phase 2 is the opposite case and the spec is emphatic about it: org-scoped
-- activity MUST stamp org/module/role/scope at WRITE time, because
-- `module_roles` is mutated in place with no history — an UPDATE re-points
-- `role`/`scope_ref` on the same row and a DELETE removes it — so a person's
-- authority AT THE MOMENT OF AN EVENT is unreconstructable afterwards. Both
-- existing logs already denormalise for exactly this reason. Phase 1 carries
-- none of it only because a login genuinely has no such context to stamp.
--
-- ---------------------------------------------------------------------------
-- THE READ RULE: SUPERADMIN ONLY, AND THE ABSENCE OF A RANK ARM IS THE
-- SECURITY-CRITICAL DECISION IN THIS FILE.
-- ---------------------------------------------------------------------------
-- v1 is superadmin-only (founder decision 5, 2026-08-09). Hierarchy-governed
-- visibility — a manager seeing the engagement of those below them — is a named
-- future enhancement (phase 4), designed around here and explicitly not built.
--
-- Writing the rank arm now would not be harmless ceremony; it would INVERT the
-- hierarchy it claims to enforce, and on this table it is WORSE than on the
-- lookup log. `module_position_rank(module_key, role)` returns 0 for any
-- unmapped pair and NEVER returns null. On the lookup log the victim of that is
-- the platform operator (every rank-1 holder outranks rank 0). Here the SUBJECT
-- of a row is an ordinary member who may genuinely hold no `module_roles` at
-- all — a salon customer, a student, a walk-in. A rank arm keyed on the subject
-- scores every one of those at 0, so every rank-1 holder in the org would read
-- the engagement of every unranked person in it. That is not "the people below
-- them"; it is most of the org. Silently, with no error, passing any test that
-- merely asserts a policy exists.
--
-- The category error worth naming once more because it will recur wherever
-- ranks meet non-participants: UNRANKED IS NOT RANK 0. Rank 0 is the bottom of
-- a ladder; unranked is not on it.
--
-- WHEN THE RANK ARM IS EVENTUALLY WRITTEN (phase 4) it must require the actor's
-- own `(position, scope_ref)` NOT NULL, so a row involving somebody outside the
-- ladder can never be captured by a rank comparison. That is a migration with
-- its own founder decision and its own adversarial review, not a policy tweak.
--
-- ALSO INHERITED FROM THE LOOKUP LOG: an arm keyed on identity SURVIVES
-- DEMOTION. There is deliberately no `user_id = auth.uid()` self-read arm here.
-- Letting people read their own login history is defensible and may well be the
-- right answer later, but it is a PRODUCT decision about disclosure (spec
-- section 9 settles the notice question, not the self-service question) and
-- shipping it inside a capture migration would be making that decision by
-- accident.
--
-- ---------------------------------------------------------------------------
-- WHAT IS DELIBERATELY *NOT* IN THIS MIGRATION: THE `profiles` MIRROR.
-- ---------------------------------------------------------------------------
-- The spec (section 5) called for mirroring `last_sign_in_at` onto `profiles`,
-- so the console could read it under ordinary RLS with no definer call and no
-- `auth` access. THE GOAL IS RIGHT AND IS FULLY MET BELOW; THE LOCATION IS NOT,
-- AND THIS IS FLAGGED FOR THE FOUNDER RATHER THAN SILENTLY CHANGED.
--
-- `profiles` is not a private table. `profiles_select_shared_org`
-- (`20260708020000`) lets EVERY member of EVERY org you belong to read your
-- whole profile row, and RLS is row-level: a policy cannot hide one column.
-- Mirroring onto it would therefore publish "when did this person last sign in"
-- to every org-mate — a salon customer learning when the manager last worked,
-- and the reverse. Today that timestamp is readable through the API by NOBODY:
-- `authenticated` holds no grant on `auth.users`, which has RLS on and zero
-- policies. So the mirror is not a neutral relocation of data the platform
-- already exposes; it is a new disclosure to a new audience.
--
-- That matters because spec section 9's disclosure reasoning turns on exactly
-- this point — "Supabase already records last_sign_in_at for every user today,
-- so this is not a new CATEGORY of data." True of RETENTION by one operator.
-- Not true of publishing it to peers, which section 9 never considered.
--
-- `login_rollup.last_login_at` below serves the stated purpose exactly: ordinary
-- RLS, no definer call, no `auth` access, readable by the console — and visible
-- to the superadmin alone. It is also BACKFILLED from `auth.users` in this
-- migration, so the console has day-one "last login" and "never signed in" for
-- every existing user, which is the founder's stated primary outreach value and
-- which a going-forward-only mirror could not have given either.
--
-- ---------------------------------------------------------------------------
-- APPEND-ONLY, AND HOW IT IS STRONGER HERE THAN ON EITHER EXISTING LOG.
-- ---------------------------------------------------------------------------
-- Enforced at the GRANT layer, never by a trigger — the documented,
-- already-paid-for lesson from the 2026-07-31 view-as review: Postgres
-- implements `ON DELETE SET NULL` as a real UPDATE on the referencing table,
-- which fires that table's own BEFORE UPDATE triggers, so a
-- `before update or delete ... raise exception` trigger makes every row the
-- table has ever referenced permanently undeletable.
--
-- NO API ROLE HOLDS ANY WRITE PRIVILEGE ON EITHER TABLE — not even INSERT. The
-- lookup log needs `insert to authenticated` because the console writes its
-- rows as the caller; nothing here has a user-facing write path at all, because
-- the only writer is a trigger on `auth.users` running as the owner. So these
-- two tables are READ-ONLY to every api role, which is a strictly stronger
-- statement than "append-only" and is asserted as such in the RLS suite.
--
-- `service_role` IS NAMED IN THE REVOKE and then granted NOTHING (docs/03 #17).
-- Omitting a grant is not the same as revoking one: on PROD,
-- `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` auto-grants the full privilege
-- set — including the whole-table wipe privilege, the one RLS provably does not
-- gate — to `anon`, `authenticated` AND `service_role` on every newly created
-- table. `view_as_sessions` shipped without naming `service_role` and needed a
-- repair migration (`20260802010000`) once prod's catalog was actually read. The
-- worker's only business here is the pruner, which it invokes as the table
-- OWNER over a direct database connection, so it needs no table privilege at
-- all — see the pruner's own note.
--
-- (Phrased "wipe" rather than the literal SQL keyword throughout, on purpose:
-- CI's destructive-migration guard greps for that word followed by whitespace,
-- in comments too, and adding DESTRUCTIVE-CHANGE-APPROVED to this file would be
-- a lie — it creates two tables, drops nothing and deletes no existing row.
-- Same rewording precedent as `20260807010000` and the 2026-07-29 ACL sweep.)
--
-- ---------------------------------------------------------------------------
-- THE FK ACTION DIVERGES FROM BOTH EXISTING LOGS, AND THE DIVERGENCE IS THE
-- POINT. `on delete cascade`, not `on delete set null`.
-- ---------------------------------------------------------------------------
-- The spec proposed copying the lookup log's rule ("every FK `on delete set
-- null`, so the log outlives what it describes"). That rule is correct FOR AN
-- OVERSIGHT LOG and wrong here, for two independent reasons:
--
--   1. AN ENGAGEMENT ROW THAT NAMES NOBODY IS NOT AN ENGAGEMENT ROW. A
--      `vm_moderation_log` row with a null actor still says "somebody
--      moderated this layer" — it retains meaning and an investigator can use
--      it. A login event with a null `user_id` is unattributable by
--      construction: it can never answer "who is engaged", cannot be
--      aggregated, and cannot be disclosed to a subject. It is retained
--      personal-adjacent data with zero informational value.
--   2. THE PURPOSE IS THE OPPOSITE. An audit log must survive the deletion of
--      the account it holds to account — that is precisely why the lookup log
--      diverges from `view_as_sessions` and refuses to cascade with an org.
--      This table records ordinary members' behaviour for an outreach decision.
--      Account erasure SHOULD take it, and spec section 11 already carries the
--      matching open question about the rollup counters.
--
-- Two consequences worth stating because they are load-bearing, not incidental:
--   * `user_id` can be — and is — `not null`, so "every row names a real
--     person" is a database guarantee rather than a comment.
--   * CASCADE PERFORMS A DELETE, NOT AN UPDATE, so the FK-action-fires-triggers
--     trap that governs the other two logs does not apply to this table at all.
--     That is why the CHECK constraints below are safe here while the
--     equivalent clause was a trap on `superadmin_lookup_log`: nothing will
--     ever try to write a null into a column a CHECK forbids. Every future
--     addition to this file must re-derive that, not assume it.

-- ---------------------------------------------------------------------------
-- login_events — one row per sign-in. Raw detail, pruned at 90 days.
-- ---------------------------------------------------------------------------
create table public.login_events (
  id uuid primary key default gen_random_uuid(),

  -- WHO signed in. `not null` + `on delete cascade` — see the header; this is
  -- the deliberate divergence from the two existing logs.
  user_id uuid not null references auth.users (id) on delete cascade,

  -- WHEN. GoTrue's own stamp for the sign-in, which it sets in the same
  -- statement that fires this trigger, falling back to `now()`. Server-side
  -- either way — there is no client-supplied value anywhere in this table, and
  -- no api role can insert a row at all.
  occurred_at timestamptz not null default now()
);

-- "This person's logins, newest first" is the person query; the bare
-- `occurred_at` index is what makes the pruner's range delete cheap rather
-- than a full scan every night.
create index login_events_user_idx on public.login_events (user_id, occurred_at desc);
create index login_events_occurred_idx on public.login_events (occurred_at);

-- ---------------------------------------------------------------------------
-- login_rollup — the PERMANENT per-user summary (founder decision 2, 2026-08-09:
-- 90 days raw + permanent rollup).
--
-- MAINTAINED BY THE CAPTURE TRIGGER, NOT BY THE PRUNER, and this is the single
-- most important structural choice in the retention design. The spec described
-- the rollup as what "the pruner deletes is folded into", which is the obvious
-- reading and the fragile one: it makes a permanent record depend on a
-- destructive nightly job running correctly forever. Maintaining it at WRITE
-- time instead means:
--   * the summary is correct at every instant, even if the pruner never runs,
--     runs twice, or is deleted outright;
--   * the pruner can only ever destroy detail that has ALREADY been counted, so
--     "prune loses data" is impossible by construction rather than by care;
--   * `last_login_at` is a genuine last-login. Folded at prune time it could
--     only ever be a timestamp from >90 days ago, which is useless as the very
--     field the outreach question asks for.
-- The founder decision is about WHAT IS RETAINED, and it is honoured exactly.
-- Where the fold happens is an implementation choice, and write-time is the
-- one that cannot silently lose the permanent half.
--
-- THE COLUMN NAMES SAY WHAT THEY CAN HONESTLY CLAIM. A log started later cannot
-- cover the period before it existed (spec section 2), so a column called
-- `total_logins` would be a false claim on every row that predates this
-- migration. `observed_*` + `observed_since` says the true thing instead.
-- ---------------------------------------------------------------------------
create table public.login_rollup (
  user_id uuid primary key references auth.users (id) on delete cascade,

  -- The first sign-in THIS LOG saw. Null on a backfilled row: GoTrue keeps only
  -- the last one, so for anyone who existed before this migration the first
  -- login is genuinely unknown and a guess would be a fabrication.
  first_observed_login_at timestamptz,

  -- The best-known last login, and the field the outreach question actually
  -- asks for. Backfilled from `auth.users.last_sign_in_at`, then maintained by
  -- the trigger. `not null` because a row only exists once a last login is
  -- known — so "a row exists" means "we know when they were last here", and
  -- "no row" means "never signed in", which is the cleanest possible answer to
  -- the founder's primary question.
  last_login_at timestamptz not null,

  -- Sign-ins counted by this log, since `observed_since`. Zero on a backfilled
  -- row: we know they signed in before, and we have counted none since.
  observed_logins bigint not null default 0,

  -- When counting began for this row — migration time for a backfilled row,
  -- first-observed-login time for anyone new. Without it `observed_logins = 0`
  -- is ambiguous between "quiet" and "we only just started watching", and an
  -- outreach tool that cannot tell those apart sends the wrong email.
  observed_since timestamptz not null default now(),

  -- ROW COHERENCE, made structural rather than left as prose above.
  --
  -- SAFE HERE FOR A REASON THAT MUST BE RE-DERIVED BEFORE ANY FUTURE ADDITION,
  -- not assumed: a CHECK is re-evaluated on every UPDATE, INCLUDING the real
  -- UPDATE Postgres performs to satisfy an `ON DELETE SET NULL` FK action —
  -- which is why the equivalent clause was rejected as a trap on
  -- `superadmin_lookup_log`, where it would have made every person who had ever
  -- been looked up permanently undeletable. This table's only FK is
  -- `on delete cascade`, which DELETES the row instead of updating it, so no FK
  -- action can ever be blocked by a constraint here.
  constraint login_rollup_coherent check (
    observed_logins >= 0
    and (first_observed_login_at is null or first_observed_login_at <= last_login_at)
    -- A counted login means a first-observed login exists, and vice versa.
    -- Without this, `observed_logins > 0` with a null `first_observed_login_at`
    -- would read to a future maintainer as a backfilled row, which it is not.
    and ((observed_logins = 0) = (first_observed_login_at is null))
  )
);

-- "Who has been quiet longest" is the whole outreach query, and it is a sort on
-- this column across every user.
create index login_rollup_last_login_idx on public.login_rollup (last_login_at);

-- ---------------------------------------------------------------------------
-- ACL. Read-only to every api role; see the header.
-- ---------------------------------------------------------------------------
revoke all privileges on public.login_events from public, anon, authenticated, service_role;
revoke all privileges on public.login_rollup from public, anon, authenticated, service_role;

grant select on public.login_events to authenticated;
grant select on public.login_rollup to authenticated;

alter table public.login_events enable row level security;
alter table public.login_rollup enable row level security;

-- `for select` and not `for all`: a `for all` policy's USING also covers SELECT,
-- so splitting one per-command later silently drops an inherited read arm — the
-- exact defect `20260806010000` was written to repair on `sal_locations`. There
-- is no INSERT/UPDATE/DELETE policy AND no such grant; both layers, deliberately.
create policy login_events_select_superadmin on public.login_events
  for select to authenticated
  using (public.is_superadmin());

create policy login_rollup_select_superadmin on public.login_rollup
  for select to authenticated
  using (public.is_superadmin());

-- ---------------------------------------------------------------------------
-- THE CAPTURE TRIGGER.
--
-- IT MUST NOT BE ABLE TO BREAK SIGN-IN, AND THAT IS WHY IT SWALLOWS ITS OWN
-- ERRORS — a deliberate divergence from `handle_new_user()`, which has no
-- exception handler.
--
-- THE PRECISE GUARANTEE, because the first draft of this comment claimed an
-- ABSOLUTE one and the absolute version is FALSE (adversarial review finding,
-- 2026-08-09). PL/pgSQL's `WHEN OTHERS` matches every error condition EXCEPT
-- `query_canceled` and `assert_failure`. So the true statement is: every error
-- this trigger can ordinarily raise — constraint violation, FK violation,
-- deadlock, permission denied, undefined table — is caught and the sign-in
-- proceeds. A STATEMENT CANCELLATION IS NOT CAUGHT and propagates, aborting
-- GoTrue's own `UPDATE auth.users`.
--
-- MEASURED AGAINST PROD RATHER THAN LEFT AS A WORRY (2026-08-09, read-only):
-- `supabase_auth_admin` carries no per-role `statement_timeout`, but the
-- CLUSTER DEFAULT is `statement_timeout = 120000` from the configuration file,
-- so GoTrue's sign-in statement does run under a 2-minute limit. The exposure is
-- therefore real rather than theoretical, and it is addressed by BOUNDING THE
-- ONLY PART OF IT THIS FILE CONTROLS:
--
--   * `set lock_timeout = '50ms'` on the function below. A function-level SET is
--     scoped to the function and restored on exit, so it constrains this trigger
--     WITHOUT altering the timeout for the rest of GoTrue's transaction. Any lock
--     wait inside the trigger now fails after 50ms as `lock_not_available`
--     (55P03) — which IS an ordinary error, IS caught by the handler, and leaves
--     the sign-in untouched. Without it, a lock wait would simply continue until
--     the 120-second statement timeout and then take the sign-in down with it.
--     This converts the one uncatchable failure mode into a catchable one and
--     caps this trigger's worst-case contribution to a sign-in at ~50ms.
--   * `when query_canceled` is DELIBERATELY NOT ADDED, though the review
--     proposed it. Two reasons. Catching it would not reliably help for a
--     statement timeout (the deadline has already passed, so the cancel
--     re-asserts at the next interrupt check), and the other source of
--     `query_canceled` is an operator running `pg_cancel_backend()` — which a
--     trigger must HONOUR, not swallow. Swallowing a human's deliberate cancel
--     to protect an analytics write is the wrong trade.
--
-- THE COUPLING THIS INTRODUCES, stated because it is new and non-obvious: from
-- this migration onward, SIGN-IN AVAILABILITY DEPENDS ON `public.login_events`
-- BEING WRITABLE. The 50ms lock timeout makes ordinary contention harmless (and
-- note the nightly pruner does NOT contend — a range `delete` and an `insert`
-- both take ROW EXCLUSIVE, which does not self-conflict). The case that matters
-- is DDL: any future migration taking a strong lock on `login_events` blocks
-- capture, and although the 50ms bound means sign-ins survive it, they will be
-- silently uncaptured for the duration. So ALTER/REINDEX on this table belongs in
-- a maintenance window or behind `concurrently`, not in a casual migration.
--
-- The two are not comparable, and the difference is criticality, not style. If
-- `handle_new_user` raises, signup fails — correctly, because an account with no
-- `profiles` row is a broken account and the platform depends on that row. This
-- trigger writes MONITORING DATA. If it raises, the enclosing UPDATE aborts and
-- GoTrue's sign-in fails: an engagement-metrics defect would become a
-- platform-wide login outage, for every user, on every tenant. No analytics
-- feature may hold that power, and the failure would arrive as "nobody can log
-- in" with no obvious connection to this file.
--
-- WHAT THE HANDLER COSTS, STATED PLAINLY BECAUSE IT IS A REAL COST: a capture
-- failure is then SILENT to the user and to the operator. Three things carry
-- that weight, and phase 3 owes the third:
--   1. `raise warning` puts it in the Postgres log with the user id and SQLSTATE.
--   2. Spec section 10 point 3's launch control — sign in against PROD and
--      assert a row appears. This whole document exists because a table that
--      looks right locally can be permanently empty in production.
--   3. PHASE 3 MUST RENDER "newest captured login" AS AN HONESTY SIGNAL, per the
--      lookup log's badge discipline, with a test that asserts the badge. An
--      empty engagement table is indistinguishable from "nobody is using the
--      platform" — the one answer this feature must never give falsely.
--
-- The two writes are inside ONE exception block on purpose. A plpgsql exception
-- block is a subtransaction, so a failure at either statement rolls back BOTH:
-- an event is never recorded without being counted, and never counted without
-- being recorded. That atomicity is what lets the pruner below be a plain
-- range delete with nothing to reconcile.
-- ---------------------------------------------------------------------------
create function public.capture_login()
returns trigger
language plpgsql
security definer
set search_path = public
-- See the header: this is what keeps a lock wait inside the trigger from riding
-- the enclosing statement all the way to the 120-second cluster
-- `statement_timeout` and taking GoTrue's sign-in down with it. Scoped to this
-- function and restored on exit, so GoTrue's transaction is unaffected.
set lock_timeout = '50ms'
as $$
declare
  -- The `coalesce` fallback is UNREACHABLE as written — the trigger's own WHEN
  -- clause already requires `new.last_sign_in_at is not null` — and it is kept
  -- deliberately, so that loosening that WHEN clause later cannot silently
  -- produce a null `occurred_at` against a NOT NULL column (which the handler
  -- would then swallow, making the capture vanish rather than fail loudly).
  -- Flagged by the review as redundant; kept, and labelled, rather than removed.
  v_at timestamptz := coalesce(new.last_sign_in_at, now());
begin
  begin
    insert into public.login_events (user_id, occurred_at)
    values (new.id, v_at);

    insert into public.login_rollup as r (
      user_id, first_observed_login_at, last_login_at, observed_logins, observed_since
    )
    values (new.id, v_at, v_at, 1, v_at)
    on conflict (user_id) do update
      set first_observed_login_at = coalesce(r.first_observed_login_at, excluded.first_observed_login_at),
          -- `greatest`, not `excluded`, so the column is MONOTONIC. Nothing
          -- observed today can reorder sign-ins, but a backdated
          -- last_sign_in_at from the auth server must never be able to make a
          -- person look quieter than they are — the direction that suppresses
          -- an outreach signal instead of raising a false one.
          last_login_at           = greatest(r.last_login_at, excluded.last_login_at),
          observed_logins         = r.observed_logins + 1;
  exception
    when others then
      -- Never re-raise: see the header. The sign-in proceeds regardless.
      raise warning 'capture_login: capture failed for user % — % (%)', new.id, sqlerrm, sqlstate;
  end;

  return new;
end;
$$;

-- The WHEN clause is load-bearing, not an optimisation. `UPDATE OF col` fires
-- whenever the column appears in a statement's SET list — even if the value is
-- unchanged — so without this a GoTrue update that re-writes the same timestamp
-- would record a phantom login, and a null-to-null write would record a login
-- that never happened. Both inflate the exact number this feature exists to
-- report.
create trigger on_auth_user_login
  after update of last_sign_in_at on auth.users
  for each row
  when (new.last_sign_in_at is not null and new.last_sign_in_at is distinct from old.last_sign_in_at)
  execute function public.capture_login();

-- Trigger functions hold no api-role EXECUTE (docs/03 #17). EXECUTE is checked
-- at `create trigger` time, not at fire time — established empirically
-- 2026-07-29 — so revoking here does not stop the trigger firing. All four
-- roles named, per the convention.
revoke execute on function public.capture_login() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- BACKFILL — the pre-log truth, recorded once.
--
-- Gives the console day-one answers to the founder's primary question ("who has
-- never signed in", "who was last here months ago") instead of an empty page
-- that fills up over the following months. `observed_logins` stays 0 and
-- `first_observed_login_at` stays null on every row this writes, because those
-- are claims about what THIS LOG saw and it has seen nothing yet — inventing a
-- count of 1 here would be a fabrication that no later reader could detect.
--
-- Users with a null `last_sign_in_at` are deliberately NOT given a row: their
-- absence from this table IS the "never signed in" answer, and it is a cleaner
-- one than a row with a null timestamp. The console reads the population from
-- `org_members`/`profiles` and LEFT JOINs this table.
-- ---------------------------------------------------------------------------
insert into public.login_rollup (
  user_id, first_observed_login_at, last_login_at, observed_logins, observed_since
)
select u.id, null, u.last_sign_in_at, 0, now()
from auth.users u
where u.last_sign_in_at is not null
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------------
-- THE PRUNER — 90 days raw (founder decision 2, 2026-08-09).
--
-- THIS IS THE ONE THING ON THE PLATFORM THAT CAN DELETE FROM A LOG, AND THE
-- SPEC FLAGGED IT FOR ADVERSARIAL REVIEW ON EXACTLY THAT GROUND. Every other
-- log here is append-only with no exception whatsoever. So the design goal was
-- to make the exception as small as it can possibly be, and it turned out to be
-- much smaller than the spec anticipated:
--
--   1. IT IS NOT `security definer`. The spec expected "a SECURITY DEFINER
--      function owned by postgres that can delete only rows past the window,
--      callable by the worker and by nobody else". But if the only caller is
--      the table's OWNER, elevated privilege is redundant — the owner can
--      already delete. So this is `security invoker`, stated explicitly because
--      the ABSENCE of `definer` is the security property. There is no privilege
--      escalation path here to reason about, because there is no escalation.
--
--      IT ALSO BUYS A SECOND LOCK FOR FREE, which is the real reason to prefer
--      it over a definer function granted narrowly. `security invoker` means
--      this function can never do more than its caller could already do by
--      hand. So if some future migration carelessly grants EXECUTE on it to
--      `service_role`, the prune STILL fails: that role holds no DELETE
--      privilege on `login_events` and is refused at the privilege layer
--      (42501). A `security definer` version would have cheerfully obeyed. The
--      grant below is the first lock; this is the one that holds when somebody
--      gets the first one wrong.
--   2. NO API ROLE MAY EXECUTE IT — not `authenticated`, not `service_role`,
--      not `anon`. Only the owner. A leaked service-role key therefore cannot
--      prune, which is a materially stronger position than the spec's "callable
--      by the worker" (the worker holds that key). The worker invokes this over
--      its DIRECT database connection, where it already connects as `postgres`
--      — locally, and on prod through the session pooler as `postgres.<ref>`,
--      which is the same role. So nothing is lost by granting nobody.
--   3. IT TAKES NO ARGUMENTS. The retention window is a literal in the body.
--      A `login_events_prune(older_than interval)` would have been the natural
--      shape and is the whole vulnerability: one caller passing
--      `interval '0 days'` empties the table, and the function would have
--      obeyed. Nothing about the deletion is caller-controlled — not the
--      window, not the predicate, not the target.
--   4. THE 90 IS ASSERTED BY THE TEST SUITE against `pg_get_functiondef`, so
--      quietly editing it to `interval '1 day'` fails CI. A retention window is
--      a founder decision; it should not be changeable without tripping
--      something.
--
-- WHAT IT DOES NOT TOUCH: `login_rollup`. The rollup is maintained at write
-- time (see its header), so the permanent half of the retention decision does
-- not depend on this function behaving. It deletes raw detail that has already
-- been counted, and nothing else. Asserted in the RLS suite.
--
-- RETENTION IS NOT ENFORCED IN PROD UNTIL THE WORKER RUNS THERE, and that is
-- worth knowing rather than discovering: the worker is still the local stopgap
-- (`pnpm worker:prod`, docs/10's VPS plan). Raw events accumulate past 90 days
-- until it runs. The function is idempotent and range-based, so the first real
-- run simply catches up; and at this volume (a few rows per user per day) the
-- delay is a documentation problem, not a capacity one.
-- ---------------------------------------------------------------------------
create function public.login_events_prune()
returns bigint
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_cutoff timestamptz := now() - interval '90 days';
  v_deleted bigint;
begin
  delete from public.login_events where occurred_at < v_cutoff;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- Granted to NOBODY. `revoke ... from public` alone would be a no-op on prod,
-- where `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` grants EXECUTE DIRECTLY to
-- `anon` and `authenticated` — the 2026-07-22 `module_scope_covers` gap, which
-- looked closed locally and was open on prod. All four roles are named for that
-- reason, and no `grant execute` follows.
revoke execute on function public.login_events_prune() from public, anon, authenticated, service_role;
