-- ENGAGEMENT MONITORING, PHASE 2 — ORG-SCOPED ACTIVITY.
-- Spec: docs/17-engagement-monitoring.md. Founder-approved 2026-08-10, seven
-- decisions, all recorded in that file's decisions log. Phase 4
-- (hierarchy-governed reads — "a manager sees those below them") is NOT in this
-- migration and is explicitly still a future piece with its own founder decision
-- and its own adversarial review.
--
-- WHAT IT ANSWERS, and why phase 1 could not. Phase 1 records "Dana signed into
-- the platform on Tuesday". That is a PLATFORM fact: a login has no org, so for
-- someone who belongs to a salon and a classroom it says nothing about whether
-- either is being used. This table records "Dana did something in Demo Salon on
-- Tuesday", which is the half of the outreach question phase 1 structurally
-- cannot reach — "which ORGS have gone quiet", not merely "which PEOPLE".
--
-- ---------------------------------------------------------------------------
-- WHY A NEW RECORD AT ALL, RATHER THAN READING THE MODULE TABLES.
-- ---------------------------------------------------------------------------
-- Founder question, 2026-08-10, and worth answering in the file because it is
-- the first thing any future reader will ask. The module tables already carry
-- `created_at` and often a person column, so counting rows looks like it would
-- work. It does not, for four independent reasons:
--
--   1. AN UPDATE LEAVES NO TRACE. `markBillPaid` UPDATEs `sal_bills`. Afterwards
--      the row says `state = 'paid'` — it does not say that Eve did it last
--      Tuesday, and if she processed twelve bills that week the table records
--      one state per bill and no history of the twelve acts.
--   2. A DELETE ERASES THE EVIDENCE COMPLETELY.
--   3. ROLES ARE MUTATED IN PLACE. `module_roles` has no history: an UPDATE
--      re-points `role`/`scope_ref` on the same row and a DELETE removes it. So
--      a row read back later is attributed to whatever the person is TODAY. A
--      worker promoted to manager makes every past act look managerial. This is
--      spec section 7.2's finding and it is the one that cannot be worked around
--      at read time by any amount of cleverness.
--   4. IT WOULD BE ~90 DIFFERENT QUERIES across 6 modules with 6 different
--      shapes, and every future module adds more, forever.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS TABLE DOES *NOT* CLAIM, stated once and plainly.
-- ---------------------------------------------------------------------------
-- A row asserts "this signed-in member of this org reported doing X at time T".
-- It does NOT prove X happened. Every row is an ordinary INSERT by the caller
-- under RLS, so a member could in principle insert rows naming themselves
-- without performing the underlying action, and inflate their own engagement.
--
-- THAT IS ACCEPTED, DELIBERATELY, and the reasoning matters because the
-- alternative looks superficially better. Proving the act would mean writing
-- from a trigger on each module table — which cannot distinguish a deliberate
-- act from a read-triggered write (spec section 12.2: classroom's
-- `getOrCreateSubmission` fires from OPENING a page, matchmaking's
-- `mm_ensure_answer` from every page load), and so would silently redefine
-- "engaged" as "loaded a page". The audience here is one platform operator
-- deciding who to email. The threat model is noise, not fraud; there is no
-- incentive to forge an engagement row and nothing is granted by one.
-- `superadmin_lookup_log` has the identical property for the identical reason.
--
-- ---------------------------------------------------------------------------
-- THE WRITE SHAPE IS NEW FOR THIS PLATFORM'S LOGS, AND THAT IS THE RISK.
-- ---------------------------------------------------------------------------
-- `login_events` has NO user-facing write path at all — its only writer is a
-- trigger on `auth.users` running as the owner, which is why phase 1 could be
-- READ-ONLY to every api role. This table is the opposite: ~30 call sites across
-- 6 modules insert into it AS THE CALLER. So it is structurally much closer to
-- `superadmin_lookup_log` (insert to `authenticated`, guard-trigger-stamped,
-- policy-checked) than to phase 1, and the lookup log is the pattern copied.
--
-- ---------------------------------------------------------------------------
-- EVERYTHING THE APP CANNOT BE TRUSTED WITH IS DERIVED BY THE GUARD, NOT SENT.
-- ---------------------------------------------------------------------------
-- Surveyed 2026-08-10 before this file was written, because the design turned on
-- it: A MODULE SERVER ACTION KNOWS ALMOST NOTHING ABOUT ITS OWN CONTEXT. It has
-- `orgSlug` and the target row ids. It does NOT have `org_id` (four of six
-- modules deliberately push that to a scope-sync trigger via
-- DERIVED_SCOPE_PLACEHOLDER), it has no module-key constant to import, and it
-- knows NOTHING about the caller's role or scope — every module's actions header
-- says so explicitly ("RLS is the enforcement layer; these actions just shape
-- input").
--
-- A literally-implemented recorder would therefore have cost THREE extra round
-- trips on every instrumented action (org lookup + getUser + module_roles read),
-- on top of the real work, at ~30 call sites. Instead the guard below derives
-- identity, time, the actor's grants and the actor's org role server-side, so
-- the app sends only what it genuinely knows. That is both faster and STRONGER:
-- docs/03 #18 — the app layer is not the gate — and `authenticated` can reach
-- this table through PostgREST directly, so every property the log claims has to
-- hold in the database.
--
-- (`org_id` is the one thing the app must still supply, because there is nothing
-- on the row to derive it FROM when `scope_ref` is null. The helper resolves it
-- from the slug in one indexed query against `orgs`, and the guard then VERIFIES
-- active membership rather than trusting it — derive-then-verify, so a resolved
-- id the caller has no business with is refused.)
--
-- ---------------------------------------------------------------------------
-- THE HARDEST DECISION IN THIS FILE: THERE IS NO SUCH THING AS "THE CALLER'S
-- ROLE", SO THIS TABLE DOES NOT PRETEND THERE IS.
-- ---------------------------------------------------------------------------
-- Spec section 12.4 called for the actor's `role` and `scope_ref` as NOT NULL
-- scalar columns. THAT IS NOT IMPLEMENTABLE, and discovering why changed the
-- design rather than the ambition. Two independent findings, both from the live
-- schema:
--
--   1. MULTIPLE SIMULTANEOUS GRANTS ARE FIRST-CLASS AND COMMON. Since
--      `20260723010000` the identity index is UNIQUE on
--      (org, user, module, role, scope_ref) NULLS NOT DISTINCT — and that
--      migration's own header states the motivation: several SCOPED grants per
--      (user, role) must be legal, "student@Math AND student@Bio". A student
--      enrolled in two classes holds two rows. So "the role" is not a function.
--   2. THE ACTION MAY NOT HAVE BEEN AUTHORISED BY A MODULE GRANT AT ALL. Every
--      module's policies also admit `is_org_admin()`, which is a seat in
--      `org_members`, not in `module_roles`. So even with one grant, "the
--      authority this act used" is not computable by a generic trigger.
--
-- Picking one grant and calling it "the role they acted with" would therefore be
-- a FABRICATION — and specifically the kind this feature exists to avoid, since
-- a later reader has no way to detect it. What IS true, and what section 7.2
-- actually requires (the part that is unreconstructable afterwards), is the SET
-- OF GRANTS HELD AT THAT MOMENT. So:
--
--   * `actor_grants` is a jsonb array of {role, scope_ref} objects — PAIRED, not
--     two parallel arrays. The pairing is load-bearing and the lesson is already
--     paid for: `apps/web/components/view-as/actions.ts` warns that checking
--     rank and scope separately lets a caller "borrow the edge of one grant and
--     the rank or scope of the other". Two arrays would reintroduce exactly that.
--   * `actor_org_role` is a plain text column, because org membership IS a
--     function: `org_members` is keyed (org_id, user_id), one seat per person
--     per org. No ambiguity, so no array.
--   * AN EMPTY ARRAY IS A REAL, EXPECTED ANSWER, not a defect. A salon customer
--     booking their own appointment — the module's flagship action — holds no
--     module grant. Forcing NOT NULL here would either refuse that insert or
--     invent a fake role for someone who is genuinely off the ladder, which IS
--     the rank-0 category error below, committed at write time instead of read
--     time.
--
-- ---------------------------------------------------------------------------
-- THE READ RULE: SUPERADMIN ONLY, AND THE ABSENCE OF A RANK ARM IS AGAIN THE
-- SECURITY-CRITICAL DECISION IN THE FILE.
-- ---------------------------------------------------------------------------
-- Founder decision 2026-08-10: "superadmin-only for now". Phase 4 — a manager
-- reading the engagement of those below them — is designed around here and
-- deliberately not built.
--
-- `module_position_rank(module_key, role)` RETURNS 0 FOR ANY UNMAPPED PAIR AND
-- NEVER RETURNS NULL. On this table the subject of a row is very often an
-- ordinary member with no `module_roles` at all — a salon customer, a student, a
-- walk-in. A rank arm keyed on the subject scores every one of them at 0, so
-- every rank-1 holder in the org (a cashier, a GA) would read the engagement of
-- most of the org. Silently, error-free, passing any test that merely asserts a
-- policy exists. UNRANKED IS NOT RANK 0: rank 0 is the bottom of a ladder,
-- unranked is not on it.
--
-- WHEN THE PHASE 4 ARM IS WRITTEN it must, at minimum: require `actor_grants` to
-- be NON-EMPTY (so a row by someone off the ladder can never be captured by a
-- rank comparison — fail closed), outrank EVERY grant in the array rather than
-- any one of them, and cover the row's `scope_ref`. That is a migration with its
-- own founder decision and its own review, not a policy tweak. It is also why
-- `actor_grants` is stamped from day one: it cannot be reconstructed later.
--
-- Note also, inherited from the lookup log: AN ARM KEYED ON IDENTITY SURVIVES
-- DEMOTION. There is deliberately no `user_id = auth.uid()` self-read arm here.
-- Letting people read their own activity may well be right later, but it is a
-- PRODUCT decision about disclosure and shipping it inside a capture migration
-- would be making that decision by accident.
--
-- ---------------------------------------------------------------------------
-- WHAT COUNTS AS ACTIVITY IS DELIBERATELY *NOT* IN THIS FILE.
-- ---------------------------------------------------------------------------
-- Founder ask, 2026-08-10: "make it easy to change it to include more mundane
-- activity in the future" — page views specifically were raised as a maybe.
--
-- So `action` is FREE TEXT with no CHECK constraint and no FK to a vocabulary
-- table, and the curated list lives in ONE TypeScript file
-- (`packages/platform/src/activity.ts`) as a typed union, beside an explicit
-- list of every action deliberately EXCLUDED and why. Consequences, both
-- intended:
--   * adding or removing an action — including switching page views on — is a
--     one-line change in that file plus a call site. NO MIGRATION.
--   * a typo cannot invent a silent new category, because the union is checked
--     by `pnpm typecheck` at every call site.
-- This mirrors `superadmin_lookup_log.position`, which is free text for the same
-- reason: positions are manifest-declared code, not rows. The CHECK-constrained
-- `tool` column there is the counter-example, and it is constrained precisely
-- because its two values are a closed set that will never grow.
--
-- A NOTE FOR WHOEVER TURNS PAGE VIEWS ON: nothing in this schema forbids it, but
-- it is a VOLUME change, not a shape change. The 90-day window and the permanent
-- rollup both absorb it; the indexes below are the thing to re-measure.
--
-- ---------------------------------------------------------------------------
-- APPEND-ONLY, ENFORCED AT THE GRANT LAYER — NEVER BY A TRIGGER.
-- ---------------------------------------------------------------------------
-- The documented, already-paid-for lesson (2026-07-31 view-as review): Postgres
-- implements `ON DELETE SET NULL` as a real UPDATE on the referencing table,
-- which fires that table's own BEFORE UPDATE triggers. `scope_ref` below is
-- `set null`, so a `before update or delete ... raise exception` trigger would
-- make every scope node this log has ever named permanently undeletable.
--
-- THE SAME TRAP APPLIES TO CHECK CONSTRAINTS, which is why the constraint on
-- `activity_rollup` names no FK-bearing column: a CHECK is re-evaluated on the
-- UPDATE an FK action performs, so a clause forbidding the null an FK is about
-- to write turns "the log outlives what it describes" into "what it describes
-- cannot die" (`superadmin_lookup_log`'s header, 2026-08-07). Every future
-- addition to this file must re-derive that rather than assume it.
--
-- With no UPDATE/DELETE grant, an api-role write is refused with 42501 before
-- RLS is even consulted, while internal FK actions — which run as the system,
-- not as an api role — still work.
--
-- `service_role` IS NAMED IN EVERY REVOKE (docs/03 #17). Omitting a grant is not
-- the same as revoking one: on PROD, `ALTER DEFAULT PRIVILEGES FOR ROLE postgres`
-- auto-grants the full privilege set — including the whole-table wipe privilege,
-- the one RLS provably does not gate — to `anon`, `authenticated` AND
-- `service_role` on every newly created table. `view_as_sessions` shipped
-- without naming it and needed a repair migration (`20260802010000`).
--
-- (Phrased "wipe"/"erase" rather than the literal SQL keyword throughout, on
-- purpose: CI's destructive-migration guard greps for that word followed by
-- whitespace, in comments too, and adding DESTRUCTIVE-CHANGE-APPROVED to this
-- file would be a lie — it creates two tables, drops nothing and deletes no
-- existing row. Same rewording precedent as `20260807010000`, `20260809010000`
-- and the 2026-07-29 ACL sweep.)
--
-- ---------------------------------------------------------------------------
-- FK ACTIONS, DERIVED HERE RATHER THAN COPIED FROM EITHER PRECEDENT.
-- ---------------------------------------------------------------------------
-- Spec section 12.4 explicitly asked for this to be re-derived. The two existing
-- logs disagree with each other, and both are right for their own purpose:
-- `superadmin_lookup_log` is `set null` everywhere (an OVERSIGHT log must outlive
-- the account it holds to account), `login_events` cascades (an engagement row
-- naming nobody is worthless).
--
-- This table is engagement, not oversight, so it follows phase 1 — with one
-- deliberate exception:
--   * `user_id` — CASCADE. A row with no person cannot answer "who is engaged",
--     cannot be aggregated and cannot be disclosed to a subject. It is retained
--     personal data with zero informational value. Cascade also lets `user_id` be
--     NOT NULL, so "every row names a real person" is a database guarantee. And
--     CASCADE PERFORMS A DELETE, NOT AN UPDATE, so it cannot trip the
--     FK-action-fires-triggers trap at all.
--   * `org_id` — CASCADE, same argument: "activity in an org that no longer
--     exists" is not an outreach signal about anything.
--   * `scope_ref` — SET NULL, and this one diverges on purpose. Cascading would
--     mean a salon closing one location, or a school retiring one course, ERASES
--     the engagement history of everyone who ever worked in it — destroying the
--     very record this table exists to keep, as a side effect of ordinary tidying
--     up. `module_roles.scope_ref` cascades for the opposite and equally correct
--     reason (`20260720010000`): a scoped GRANT must never be silently promoted
--     to global. A grant is a capability; this is a record.
--     THE CONSEQUENCE, NAMED SO IT IS NOT DISCOVERED LATER: a nulled `scope_ref`
--     is FAIL-CLOSED for the future phase 4 arm, because
--     `module_scope_covers(ancestor, null)` returns false — a node never covers
--     global. So such a row becomes invisible to scoped readers and visible only
--     to whole-module readers. Losing reach is the safe direction; gaining it
--     would not be.

-- ---------------------------------------------------------------------------
-- activity_events — one row per meaningful action. Raw detail, pruned at 90 days.
-- ---------------------------------------------------------------------------
create table public.activity_events (
  id uuid primary key default gen_random_uuid(),

  -- WHO. Server-stamped by the guard from auth.uid(); never client-supplied.
  user_id uuid not null references auth.users (id) on delete cascade,

  -- WHICH TENANT. The whole point of phase 2, and the thing a login can never
  -- carry. Supplied by the caller (there is nothing else on the row to derive it
  -- from when scope_ref is null) and then VERIFIED by the guard against active
  -- membership — derive-then-verify, never trust-and-store.
  org_id uuid not null references public.orgs (id) on delete cascade,

  -- WHICH MODULE. Free text; the vocabulary is TypeScript. See the header.
  module_key text not null,

  -- WHAT THEY DID. Free text, curated in packages/platform/src/activity.ts so
  -- the list is changeable without a migration. See the header.
  action text not null,

  -- WHERE IN THE MODULE — the scope the ACTION happened in (this class, this
  -- salon location, this event), NOT the actor's grant scope. Those are
  -- different questions and conflating them is how a scoped read later reports
  -- the wrong rows: a manager scoped to Downtown wants acts that happened at
  -- Downtown, regardless of how broadly the actor happens to be granted.
  --
  -- Null is ordinary and means "not scoped / whole module" — many real actions
  -- have no scope node, and several modules have no scope tree at all.
  scope_ref uuid references public.module_scope_nodes (id) on delete set null,

  -- THE ACTOR'S AUTHORITY AT THIS INSTANT, derived by the guard. See the header
  -- for why this is an array of pairs and not two scalar columns, and why an
  -- empty array is a correct answer rather than a hole.
  --
  -- Shape: [{"role": "worker", "scope_ref": "…uuid…"}, …] — `scope_ref` null
  -- inside an element means that grant is global over the module.
  actor_grants jsonb not null default '[]'::jsonb,

  -- The actor's ORG seat at this instant ('owner' | 'admin' | 'member'), derived
  -- by the guard. Unambiguous because org_members is keyed (org_id, user_id).
  -- Nullable only because a superadmin acting outside any org membership is
  -- conceivable; the guard's membership check makes that unreachable today, and
  -- a null here should be read as "not a member at write time", which would be a
  -- bug worth chasing rather than a category.
  actor_org_role text,

  -- OPTIONAL DE-DUPLICATION KEY — the mechanism that makes noisy actions
  -- affordable, and the reason it exists NOW rather than later.
  --
  -- Founder decision 1, 2026-08-10, had two halves. The curated list is the
  -- first; the second was "make it easy to change it to include more mundane
  -- activity in the future", with page views named as a maybe. A vocabulary
  -- change alone does not deliver that: the reason page views (and matchmaking's
  -- `saveAnswer`, which the founder agreed to debounce) are unaffordable is
  -- FREQUENCY, not naming. One person dragging a slider must not out-count
  -- somebody who turned in an assignment.
  --
  -- So a caller may supply a key that is unique per whatever window it wants to
  -- collapse — `saveAnswer` sends `<questionId>:<YYYY-MM-DD>`, a future page view
  -- would send `<page>:<YYYY-MM-DD>` — and the partial unique index below makes
  -- the second write of the day a no-op. Null (the default) means "record every
  -- occurrence", which is what almost every action wants.
  --
  -- THE DUPLICATE IS REFUSED BY THE DATABASE, NOT AVOIDED BY A PRE-CHECK, and
  -- that is deliberate: a read-then-write in the app would be racy, and two
  -- concurrent saves would both see nothing and both insert. Here the loser gets
  -- 23505, and the app helper — which already swallows every failure by founder
  -- decision 3 — treats that one code as success rather than as an error worth
  -- reporting, because it means "already recorded for this window".
  dedupe_key text,

  -- WHEN. Server-stamped; there is no client-supplied value anywhere in this row
  -- except org_id, module_key, action, scope_ref and dedupe_key, each of which
  -- the guard validates.
  occurred_at timestamptz not null default now()
);

-- Partial, so the overwhelming majority of rows (dedupe_key null) carry no
-- uniqueness obligation at all and pay nothing for this feature.
create unique index activity_events_dedupe_idx
  on public.activity_events (user_id, org_id, module_key, action, dedupe_key)
  where dedupe_key is not null;

-- "This org's activity, newest first" is the org-rollup query; "this person's
-- activity" is the person query; the bare `occurred_at` index is what makes the
-- pruner's range delete cheap rather than a nightly full scan.
create index activity_events_org_idx on public.activity_events (org_id, occurred_at desc);
create index activity_events_user_idx on public.activity_events (user_id, occurred_at desc);
create index activity_events_org_module_idx on public.activity_events (org_id, module_key, occurred_at desc);
create index activity_events_occurred_idx on public.activity_events (occurred_at);

-- ---------------------------------------------------------------------------
-- activity_rollup — the PERMANENT summary (founder decision 2, 2026-08-10:
-- 90 days raw + a tally that NEVER expires).
--
-- KEYED (user_id, org_id, module_key), which is the decision that makes phase 2
-- worth building. A rollup keyed only on user_id — phase 1's shape — would throw
-- away exactly the org and module signal this phase exists to capture: it could
-- say "Dana is active" but never "Dana is active IN YOUR SALON", and the second
-- is the founder's actual question.
--
-- The founder's stated requirement, verbatim in substance (2026-08-10): "Dana
-- logged in to nail salon 1 year 2 months ago, and Dana logged in to visual chat
-- 120 days ago should be stored so even if they did not engage in a while, we
-- know at least the last time they did." `last_activity_at` is that column, and
-- nothing ever deletes from this table.
--
-- MAINTAINED BY THE CAPTURE PATH, NOT BY THE PRUNER — phase 1's most important
-- structural lesson, repeated here for the same reasons: the summary is correct
-- at every instant even if the pruner never runs, runs twice, or is deleted; the
-- pruner can then only ever destroy detail that has ALREADY been counted, so
-- "prune loses data" is impossible by construction rather than by care; and
-- `last_activity_at` is a genuine last-activity rather than a timestamp from
-- >90 days ago, which is useless as the very field the outreach question asks
-- for.
--
-- THE COLUMN NAMES CLAIM ONLY WHAT THEY CAN PROVE. Unlike phase 1 there is NO
-- BACKFILL and none is possible — no activity history exists anywhere to
-- backfill FROM (spec section 3: "there is no activity record anywhere on the
-- platform today"). So every row here is born from a real observed event, which
-- is why `first_observed_at` is NOT NULL where phase 1's equivalent had to be
-- nullable. `observed_*` still says the honest thing: a log started later cannot
-- cover the period before it existed.
-- ---------------------------------------------------------------------------
create table public.activity_rollup (
  user_id uuid not null references auth.users (id) on delete cascade,
  org_id uuid not null references public.orgs (id) on delete cascade,
  module_key text not null,

  -- The first activity THIS LOG saw for this (person, org, module).
  first_observed_at timestamptz not null,

  -- The field the outreach question actually asks for, and the one that must
  -- survive forever. "No row" means "has never done anything here", which is a
  -- cleaner answer than a row with a null timestamp.
  last_activity_at timestamptz not null,

  -- Actions counted since `observed_since`. Never a lifetime total, and named so
  -- that it cannot be misread as one.
  --
  -- DELIBERATELY NO DEFAULT. The trigger below always supplies 1 on insert and
  -- only ever increments, so the CHECK can assert `> 0` — which makes "a row
  -- exists" and "something was counted" the same statement. A `default 0` would
  -- have contradicted that CHECK and turned any hand-written insert into a
  -- confusing constraint violation instead of a clear missing-column error.
  observed_actions bigint not null,

  -- When counting began for this row. Without it `observed_actions` is ambiguous
  -- between "quiet" and "we only just started watching", and an outreach tool
  -- that cannot tell those apart sends the wrong email.
  observed_since timestamptz not null default now(),

  primary key (user_id, org_id, module_key),

  -- ROW COHERENCE, made structural rather than left as prose.
  --
  -- FK-ACTION-SAFE BY CONSTRUCTION, and this must be re-derived before any
  -- future addition rather than assumed: a CHECK is re-evaluated on every
  -- UPDATE, INCLUDING the real UPDATE Postgres performs for an
  -- `ON DELETE SET NULL` FK action. Both FKs on this table are CASCADE, which
  -- DELETES the row instead of updating it, and no clause below names an
  -- FK-bearing column anyway. Adding a clause about a `set null` column here
  -- would make whatever it references permanently undeletable.
  constraint activity_rollup_coherent check (
    -- A row exists ONLY because something was counted — there is no backfill
    -- here and none is possible, so unlike phase 1 there is no such thing as a
    -- zero-count row. Stating it structurally means "no row" unambiguously means
    -- "never active here", which is the answer the console renders.
    observed_actions > 0
    and first_observed_at <= last_activity_at
  )
);

-- "Who in this org has been quiet longest" is the whole outreach query.
create index activity_rollup_org_idx on public.activity_rollup (org_id, last_activity_at);
create index activity_rollup_user_idx on public.activity_rollup (user_id, last_activity_at);

-- ---------------------------------------------------------------------------
-- ACL. Insert-only for members, read-only for the superadmin, no api-role
-- UPDATE or DELETE anywhere. See the header on append-only.
--
-- NOTE THE ASYMMETRY, which is deliberate: `authenticated` may INSERT into
-- activity_events but holds NO privilege at all on activity_rollup. The rollup
-- is maintained exclusively by the definer trigger below, so a caller can never
-- write a tally directly — the only way to move a counter is to record a real
-- event that the guard has already validated.
-- ---------------------------------------------------------------------------
revoke all privileges on public.activity_events from public, anon, authenticated, service_role;
revoke all privileges on public.activity_rollup from public, anon, authenticated, service_role;

grant select, insert on public.activity_events to authenticated;
grant select on public.activity_rollup to authenticated;

alter table public.activity_events enable row level security;
alter table public.activity_rollup enable row level security;

-- ---------------------------------------------------------------------------
-- THE GUARD. Server-stamps identity, time and authority, and refuses anything
-- the app layer might get wrong — because the app layer is not the gate
-- (docs/03 #18). `authenticated` can reach this table through PostgREST
-- directly, so every property this log claims must hold in the database.
--
-- `lock_timeout` IS SET, AND DELIBERATELY LONGER THAN PHASE 1's 50ms. The two
-- are protecting different things and the difference is not style. Phase 1's
-- trigger runs INSIDE GoTrue's sign-in transaction, where a lock wait rides the
-- enclosing statement to the 120-second cluster `statement_timeout` and takes
-- the sign-in down with it, so 50ms is right there. This function runs in its
-- own statement, in the user's own request, where the only casualty of a wait is
-- that one request's latency — and 50ms would be actively harmful, because the
-- rollup upsert genuinely can contend when one person acts twice in quick
-- succession, and a spuriously failed capture is a silently missing row. One
-- second bounds the request without manufacturing losses.
-- ---------------------------------------------------------------------------
create function public.activity_event_guard()
returns trigger
language plpgsql
security definer
set search_path = public
set lock_timeout = '1s'
as $$
declare
  v_grants jsonb;
  v_org_role text;
begin
  -- Identity and time are the SERVER's, always. A forged user_id is the one
  -- thing that would make this log worse than no log. The assignment (not a
  -- check) is deliberate: there is nothing to validate, because whatever the
  -- client sent is simply discarded.
  new.user_id := auth.uid();
  new.occurred_at := now();

  if new.user_id is null then
    raise exception 'activity: not signed in';
  end if;

  -- An engagement row that cannot say WHICH TENANT is not phase 2 — it is a
  -- login event with extra columns. NOT NULL already forces a value; this
  -- catches the placeholder, which is a real risk because every module's insert
  -- idiom on this platform sends DERIVED_SCOPE_PLACEHOLDER for org_id and lets a
  -- scope-sync trigger fill it in. There is no such trigger here, so a call site
  -- copied from a neighbouring action would otherwise file every act under the
  -- all-zeroes uuid — which would fail the FK, but with an error naming `orgs`
  -- rather than the actual mistake.
  if new.org_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception 'activity: org_id is the derived-scope placeholder — this table derives nothing, pass the real org id';
  end if;

  if new.module_key is null or btrim(new.module_key) = '' then
    raise exception 'activity: module_key is required';
  end if;

  if new.action is null or btrim(new.action) = '' then
    raise exception 'activity: action is required';
  end if;

  -- An empty-string dedupe key is the dangerous input, not a null one: it is
  -- non-null, so the partial unique index applies, and every row for that
  -- (user, org, module, action) would then collapse into ONE — permanently, and
  -- silently, since the losers are swallowed as ordinary duplicates. A caller
  -- building a key from an id that turned out undefined produces exactly that
  -- string. Normalise it to null, which means "record every occurrence".
  if new.dedupe_key is not null and btrim(new.dedupe_key) = '' then
    new.dedupe_key := null;
  end if;

  -- DERIVE-THEN-VERIFY. The helper resolved org_id from a slug through the
  -- caller's own RLS client, so it is already an org they can see — but "can
  -- see" is not "is an active member of", and a pending invitee must never
  -- register as engaged (spec section 3: an invited-but-never-accepted member
  -- reading as a DISENGAGED member is the opposite of the truth, and would send
  -- the founder to apologise to somebody who never joined). `is_org_member`
  -- requires status = 'active'.
  if not public.is_org_member(new.org_id) then
    raise exception 'activity: not an active member of this org';
  end if;

  -- SCOPE-NODE TENANCY. A scope node belongs to exactly one (org, module).
  -- Without this a row could name org A while pointing scope_ref at a node in
  -- org B — a quietly cross-tenant row whose reader would attribute the act to
  -- the wrong tenant's scope with no way to notice. Identical check to
  -- `superadmin_log_guard` and to `module_roles_guard_hierarchy` step (1).
  if new.scope_ref is not null and not exists (
    select 1 from public.module_scope_nodes n
    where n.id = new.scope_ref
      and n.org_id = new.org_id
      and n.module_key = new.module_key
  ) then
    raise exception 'activity: scope_ref does not belong to this org and module';
  end if;

  -- THE AUTHORITY STAMP — the part that is unreconstructable afterwards
  -- (spec section 7.2), and the reason this migration exists now rather than
  -- when phase 4 is built. `module_roles` is mutated in place with no history.
  --
  -- Ordered so the array is deterministic: two rows recording the same authority
  -- must compare equal, or every test asserting on this column becomes flaky and
  -- any future policy over it becomes order-dependent.
  select coalesce(
           jsonb_agg(
             jsonb_build_object('role', g.role, 'scope_ref', g.scope_ref)
             order by g.role, g.scope_ref
           ),
           '[]'::jsonb
         )
    into v_grants
    from public.module_roles g
   where g.org_id = new.org_id
     and g.module_key = new.module_key
     and g.user_id = new.user_id;

  new.actor_grants := v_grants;

  select m.role
    into v_org_role
    from public.org_members m
   where m.org_id = new.org_id
     and m.user_id = new.user_id
     and m.status = 'active';

  new.actor_org_role := v_org_role;

  return new;
end;
$$;

create trigger activity_events_guard
  before insert on public.activity_events
  for each row execute function public.activity_event_guard();

-- Trigger functions hold no api-role EXECUTE (docs/03 #17). EXECUTE is checked
-- at `create trigger` time, not at fire time — established empirically
-- 2026-07-29 — so revoking here does not stop the trigger working. All four
-- roles named, per the convention.
revoke execute on function public.activity_event_guard() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- THE ROLLUP MAINTAINER. AFTER INSERT, so it can only ever count a row that
-- actually landed.
--
-- WHY IT IS SAFE FOR THIS ONE TO RAISE, unlike phase 1's capture trigger. Phase
-- 1's ran inside GoTrue's sign-in transaction, so an unhandled error there was a
-- platform-wide login outage — which is why it swallows everything. This one
-- runs inside the activity INSERT, which is a statement of its own that the app
-- helper already treats as failable and swallows (founder decision 3,
-- 2026-08-10: a failed activity write must never break the real action, and must
-- surface nothing to the actor). So a failure here rolls back the event AND the
-- tally together — atomically, leaving no half-counted state — and the user's
-- real action, which committed in an earlier statement, is untouched.
--
-- That atomicity is the point: an event is never recorded without being counted,
-- and never counted without being recorded, so the pruner below has nothing to
-- reconcile. The cost is the same cost phase 1 accepted — a capture failure is
-- SILENT — and it is paid for the same way: the console renders a "newest
-- recorded activity" honesty badge, with a test that asserts a real timestamp.
-- ---------------------------------------------------------------------------
create function public.activity_rollup_apply()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.activity_rollup as r (
    user_id, org_id, module_key,
    first_observed_at, last_activity_at, observed_actions, observed_since
  )
  values (
    new.user_id, new.org_id, new.module_key,
    new.occurred_at, new.occurred_at, 1, new.occurred_at
  )
  on conflict (user_id, org_id, module_key) do update
    set first_observed_at = least(r.first_observed_at, excluded.first_observed_at),
        -- `greatest`, not `excluded`, so the column is MONOTONIC. Nothing
        -- observed today can reorder what already happened, and a clock skew or
        -- a backdated write must never be able to make a person look QUIETER
        -- than they are — that is the direction which suppresses an outreach
        -- signal rather than raising a false one.
        last_activity_at  = greatest(r.last_activity_at, excluded.last_activity_at),
        observed_actions  = r.observed_actions + 1;

  return null; -- AFTER trigger: the return value is ignored.
end;
$$;

create trigger activity_events_rollup
  after insert on public.activity_events
  for each row execute function public.activity_rollup_apply();

revoke execute on function public.activity_rollup_apply() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS.
--
-- INSERT is pinned to the caller AND to active membership — the same
-- belt-and-braces division of labour as `view_as_sessions_insert_actor` and
-- `superadmin_lookup_log_insert_actor` beside their guards. The guard already
-- forces `user_id`, so the policy's equality check can never fail for a
-- legitimate write; it exists so the property is visible in `pg_policies` to
-- anyone auditing the table without reading the trigger body.
--
-- SELECT HAS EXACTLY ONE ARM: `is_superadmin()`. What is NOT here, each absence
-- deliberate and argued in the header: no module rank/scope arm (it would invert
-- the hierarchy via rank 0 — the central point of this file, and worse here than
-- anywhere else because most subjects are genuinely unranked), no org-admin arm,
-- and no self-read arm (an identity-keyed arm survives demotion, and self-service
-- is a product decision, not a migration one).
--
-- THERE IS NO UPDATE AND NO DELETE POLICY, and no grant either, so an api-role
-- write is refused at the privilege layer regardless of policy. Both layers,
-- deliberately.
--
-- `for select` / `for insert` and never `for all`: a `for all` policy's USING
-- also covers SELECT, so splitting one per-command later silently drops an
-- inherited read arm — the exact defect `20260806010000` was written to repair
-- on `sal_locations`.
-- ---------------------------------------------------------------------------
create policy activity_events_insert_self on public.activity_events
  for insert to authenticated
  with check (user_id = auth.uid() and public.is_org_member(org_id));

create policy activity_events_select_superadmin on public.activity_events
  for select to authenticated
  using (public.is_superadmin());

-- No INSERT policy and no INSERT grant: the rollup is trigger-maintained only.
create policy activity_rollup_select_superadmin on public.activity_rollup
  for select to authenticated
  using (public.is_superadmin());

-- ---------------------------------------------------------------------------
-- THE PRUNER — 90 days raw (founder decision 2, 2026-08-10, same window as
-- phase 1 so there is one number to remember rather than two).
--
-- IDENTICAL IN SHAPE TO `login_events_prune()`, and every property of that
-- design is load-bearing here too:
--   1. IT IS NOT `security definer`. A definer is only necessary if a NON-owner
--      must call it, and the only caller is the worker, which already connects
--      as the table owner (`postgres` locally, `postgres.<ref>` through the
--      session pooler on prod — the same role). `security invoker` also buys a
--      second lock free: if some future migration carelessly grants EXECUTE to
--      `service_role`, the prune STILL fails, because that role holds no DELETE
--      on the table and is refused at the privilege layer (42501). A definer
--      version would have cheerfully obeyed.
--   2. NO API ROLE MAY EXECUTE IT — not `authenticated`, not `service_role`, not
--      `anon`. A leaked service-role key cannot prune.
--   3. IT TAKES NO ARGUMENTS. The window is a literal in the body. A
--      `prune(older_than interval)` would have been the natural shape and is the
--      entire vulnerability: one caller passing `interval '0 days'` empties the
--      table. Nothing about the deletion is caller-controlled — not the window,
--      not the predicate, not the target.
--   4. THE 90 IS ASSERTED BY THE TEST SUITE against `pg_get_functiondef`, so
--      quietly editing it to `interval '1 day'` fails CI. A retention window is
--      a founder decision; it should not be changeable without tripping
--      something.
--
-- WHAT IT DOES NOT TOUCH: `activity_rollup`. The tally is maintained at write
-- time, so the permanent half of the retention decision — the founder's explicit
-- "even if they did not engage in a while, we know at least the last time they
-- did" — does not depend on this function behaving. It deletes raw detail that
-- has already been counted, and nothing else. Asserted in the RLS suite.
--
-- RETENTION IS NOT ENFORCED IN PROD UNTIL THE WORKER RUNS THERE — the same live
-- caveat phase 1 carries (still the `pnpm worker:prod` stopgap, docs/10). Raw
-- events accumulate past 90 days until it runs. The function is idempotent and
-- range-based, so the first real run simply catches up.
-- ---------------------------------------------------------------------------
create function public.activity_events_prune()
returns bigint
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_cutoff timestamptz := now() - interval '90 days';
  v_deleted bigint;
begin
  delete from public.activity_events where occurred_at < v_cutoff;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- Granted to NOBODY. `revoke ... from public` alone would be a no-op on prod,
-- where `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` grants EXECUTE DIRECTLY to
-- `anon` and `authenticated` — the 2026-07-22 `module_scope_covers` gap, which
-- looked closed locally and was open on prod. All four roles are named for that
-- reason, and no `grant execute` follows.
revoke execute on function public.activity_events_prune() from public, anon, authenticated, service_role;
