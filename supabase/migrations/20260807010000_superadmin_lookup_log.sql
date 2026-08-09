-- THE SUPERADMIN LOOKUP LOG (docs/15 2026-08-06/07 decision 5; docs/12 checklist
-- item 9). Founder-decided 2026-08-06, built as the follow-on the Owner Console
-- view-as build deliberately shipped without.
--
-- WHAT IT RECORDS: every time a platform superadmin uses one of the two Owner
-- Console tools to look at a person or a position. Both tools, one table —
-- logging only the narrower one (`/console/view-as`) while the `select *`
-- per-person data browser stayed silent is the incoherent option, and the data
-- browser is the strictly MORE revealing of the two.
--
-- WHY A NEW TABLE AND NOT `view_as_sessions` (docs/15 decision 5, three reasons,
-- the first decisive):
--   1. IT IS NOT THE SAME EVENT. This covers BOTH console tools, and the data
--      browser has no session, no target_role, no target_scope_ref and no expiry.
--      What is recorded is "a superadmin looked up a person, with tool X", not
--      "a view-as session started".
--   2. In `view_as_sessions` a row IS A CAPABILITY, not merely a record: the
--      in-module page resolves a cookie to a row and renders from it. Mixing
--      non-capability rows into that table would make safety depend on a
--      downstream re-check instead of on the row not existing.
--   3. Retrofitting hierarchy-governed reads onto `view_as_sessions` is its own
--      migration with its own review — its `select_org_admin` policy is whole-org
--      today and narrowing it REMOVES reach tenants currently have.
--
-- ---------------------------------------------------------------------------
-- THE READ RULE — and the trap that decided its shape.
-- ---------------------------------------------------------------------------
-- The founder's principle (2026-08-06): "logs should be based on hierarchy — a
-- manager can see logs of himself and those below, those below should not see
-- the manager's. So we can log superadmin activity but only the superadmin can
-- see them." docs/15 decision 5 names the mechanism as the APPOINTMENT rule
-- (strict rank + scope coverage) rather than view-as's per-pair declaration,
-- because a log row is metadata with no surface and no third-party secret:
-- "if you can remove someone, you can review what they did" derives for every
-- module and brings scope narrowing along for free.
--
-- APPLYING THAT RULE TO THIS TABLE'S ACTUAL ROWS GIVES: only the superadmin.
-- Every actor here is a platform superadmin (the guard below enforces that), and
-- a superadmin is not at the top of any module ladder — they are OUTSIDE every
-- ladder. Nobody in a module hierarchy outranks them, so the appointment rule
-- admits nobody. That is not a gap in the rule; it is the rule returning the
-- founder's own answer.
--
-- PRECISION ABOUT THAT PREMISE, because the first draft overstated it and the
-- overstatement was load-bearing (adversarial review finding, 2026-08-07). The
-- draft said a superadmin holds NO module grants "at all", as though it were
-- structural. IT IS NOT ENFORCED ANYWHERE. `profiles.is_superadmin` and
-- `module_roles` are independent tables with no constraint linking them, and
-- 20260731010000 explicitly notes that an org owner "may grant themselves the
-- seat freely". So it is a fact about today's population — the seed never grants
-- the founder a module role — not a guarantee.
--
-- DOES THE OVERSTATEMENT BREAK THE ARGUMENT? No, and it is worth saying why, so
-- nobody "fixes" this by adding the rank arm. If a superadmin DID also hold a
-- module grant, the appointment rule would then be computable for them — and it
-- would be computed against THEIR OWN POSITION, which this table does not
-- record, because the actor's position is not what a superadmin acts with here.
-- They open the Owner Console as a platform operator, bypassing every module
-- edge; the seat they happen to hold in some module is irrelevant to the row.
-- Recording it and ranking on it would be worse than not: it would let a salon
-- admin (rank 3) read the operator's cross-tenant lookups because the operator
-- happens to be a rank-2 manager somewhere. The conclusion stands on WHAT
-- AUTHORITY THE ACTION USED, not on what seats the actor holds.
--
-- SO THERE IS DELIBERATELY NO MODULE-RANK ARM IN THE SELECT POLICY, AND THAT
-- ABSENCE IS THE SECURITY-CRITICAL DECISION IN THIS FILE.
--
-- Writing one anyway would not be harmless ceremony — it would INVERT the
-- hierarchy it claims to enforce. `module_position_rank(module_key, role)`
-- returns 0 for any unmapped pair and NEVER returns null (its inner CASE falls
-- through `coalesce` to the generic tier table, whose `else` is 0). A superadmin
-- has no position to look up at all. So the natural-looking policy arm
--
--     exists (select 1 from module_roles g
--              where g.user_id = auth.uid()
--                and module_position_rank(l.module_key, g.role)
--                      > module_position_rank(l.module_key, <the actor's position>))
--
-- evaluates the actor's rank as 0, and every rank-1 holder on the platform — a
-- salon cashier, a classroom GA, a speed-dating host — then STRICTLY OUTRANKS
-- the platform operator and reads their entire lookup history. Silently, with no
-- error, and passing any test that only asserts the policy exists.
--
-- The bug underneath is a category error worth naming once, because it will
-- recur anywhere ranks meet non-participants: "unranked" and "rank 0" are not
-- the same thing. Rank 0 is the bottom of a ladder. Unranked is not on it.
-- Collapsing the two lets anyone on the ladder outrank everyone off it.
--
-- WHEN THE RANK ARM SHOULD BE WRITTEN: the first time a NON-superadmin tool
-- writes a row here. At that point the row must also record THE ACTOR'S OWN
-- (position, scope_ref) — which is information this build has none of, since its
-- actors hold no positions — and the arm must require it NOT NULL, so a row
-- written by someone outside the ladder can never be captured by a rank
-- comparison. That is a migration with its own review, not a policy tweak.
-- Those columns are deliberately NOT added speculatively here: they would be
-- null on 100% of the rows this build can ever write, and a null column is
-- exactly what invites the rank-0 confusion above to be written carelessly
-- later. See docs/15's entry for this build.
--
-- THE OTHER HALF OF THE TWO-PEOPLE TRAP (docs/15 decision 5). A log row names
-- TWO people: the ACTOR who looked, and the SUBJECT who was looked at. Hierarchy
-- answers who may read BY ACTOR — that is oversight, and it is what this file
-- implements. Reading BY SUBJECT ("a superadmin viewed your account") is §8.1
-- point 6's notify-the-target question, which is deliberately still open. So
-- `subject_user_id` has NO read arm here, exactly as `view_as_sessions` gives
-- its target none. One table, two features; a single policy must not try to be
-- both, and shipping the second one by accident would be a product decision made
-- in a migration.
--
-- NOT AN ORG-ADMIN LOG. `view_as_sessions` gives org admins a whole-org read,
-- because overseeing view-as inside your own tenant is auditing. This table is
-- the opposite direction: it records what the PLATFORM OPERATOR did, across
-- tenants. Giving tenants a read arm would publish superadmin activity into
-- every tenant's audit view — which was the load-bearing objection that made the
-- 2026-08-06 build ship unlogged in the first place, and the founder's
-- separate-table counter-proposal is precisely what dissolved it. Re-adding it
-- here would reintroduce the objection the table exists to avoid.

create table public.superadmin_lookup_log (
  id uuid primary key default gen_random_uuid(),

  -- WHO LOOKED. Server-stamped by the guard below; never client-supplied.
  --
  -- `on delete set null` and NOT cascade, copied from vm_moderation_log
  -- (20260709100000) and view_as_sessions: an oversight log must outlive the
  -- things it describes. Deleting a departed account must not erase the record
  -- of what that account did. Nullable only so `set null` is legal — the guard
  -- refuses to write a row with a null actor, so no row is ever born without one.
  actor_user_id uuid references auth.users (id) on delete set null,

  -- WHICH TOOL. The whole reason this is not `view_as_sessions`: one table
  -- covering both Owner Console surfaces. Constrained rather than free text so a
  -- typo cannot create a third, invisible category that no reader filters for.
  tool text not null check (tool in ('view-as', 'data-browser')),

  -- WHICH TENANT was looked into.
  --
  -- `on delete set null`, DIVERGING FROM `view_as_sessions` (which cascades with
  -- the org) — and the divergence is the point, not an oversight.
  -- `view_as_sessions` is a TENANT-VISIBLE log: org admins read their own org's
  -- rows, so a row outliving its org would be readable by nobody and cascading
  -- is coherent. This table is a PLATFORM-OPERATOR oversight log, and the
  -- operator is exactly who can delete an org. Cascading here would mean an
  -- operator could erase the record of everyone they looked up in a tenant by
  -- deleting that tenant — the audit trail vanishing with a single ordinary,
  -- permitted action of the very person it exists to hold to account.
  -- Nullable only so `set null` is legal; the guard requires it at insert.
  org_id uuid references public.orgs (id) on delete set null,

  -- WHICH MODULE, for the view-as tool. NULL for the data browser, which spans
  -- every module the org is entitled to in one lookup and so has no single key.
  -- That asymmetry is real and is why this column is nullable rather than a
  -- sentinel string: 'all' would be a lie about a module that does not exist.
  module_key text,

  -- WHO WAS LOOKED AT. Null in view-as mode 3 ("the whole position surface"),
  -- which deliberately has no person filter at all.
  --
  -- THE UI'S "MODE" IS DELIBERATELY NOT RECORDED, and the first draft was wrong
  -- about why (adversarial review finding, 2026-08-07). It claimed the mode was
  -- exactly derivable — null => mode 3, equal to the actor => mode 1, anyone
  -- else => mode 2. That derivation is NOT sound: `holdersOf()` in
  -- lib/console-view-as.ts does not exclude the caller from the mode-2 holder
  -- picker the way the in-module `targetsFor()` does, so a superadmin who also
  -- holds a module seat can pick themselves and produce a genuine mode-2 lookup
  -- whose subject equals its actor — which the table would have misfiled as
  -- mode 1. An audit log that quietly mislabels what happened is the "false
  -- claim a future reader trusts" category.
  --
  -- The fix is to stop claiming it rather than to add a column, because the mode
  -- is UI VOCABULARY, not a fact about what was seen. What was seen is fully
  -- determined by (position, subject_user_id, scope_ref), and those are all
  -- recorded. Anyone reconstructing an incident wants the reach, not the label
  -- on the radio button that produced it.
  subject_user_id uuid references auth.users (id) on delete set null,

  -- WHICH POSITION's surface was rendered (view-as only; null for the data
  -- browser). Free text matching `module_roles.role`, deliberately not an FK:
  -- positions are manifest-declared code, not rows.
  position text,

  -- WHICH SCOPE the render was narrowed to, or null for the whole module.
  -- `on delete set null` for the same outlive-what-it-describes reason as above,
  -- and because deleting a scope node is an ordinary permitted org-admin action.
  scope_ref uuid references public.module_scope_nodes (id) on delete set null,

  created_at timestamptz not null default now(),

  -- ROW COHERENCE — the prose invariants in the column comments above, made
  -- structural (adversarial review finding, 2026-08-07). Without this a row can
  -- exist saying `tool='data-browser'` with a `position` set, or `tool='view-as'`
  -- with no module at all, silently contradicting this file's own documentation.
  -- The reader of an audit log has no way to tell such a row from a true one.
  --
  -- THE CLAUSE THAT IS DELIBERATELY *NOT* HERE, and why it is the most important
  -- thing in this constraint: the review that proposed it also proposed
  -- `and subject_user_id is not null` for the data-browser arm (that tool always
  -- targets exactly one person, so it reads as obviously true). It is a TRAP, and
  -- it is the 2026-07-31 `ON DELETE SET NULL` lesson wearing a new disguise.
  -- `subject_user_id` is `on delete set null`; a CHECK constraint is re-evaluated
  -- on EVERY update, including the real UPDATE that Postgres performs to satisfy
  -- an FK action. So that clause would make the FK action fail, and every person
  -- who had ever been looked up in the data browser would become PERMANENTLY
  -- UNDELETABLE — breaking account erasure, exactly as the rejected
  -- before-update trigger would have. The lesson generalises past triggers: any
  -- constraint that forbids the null an FK action is about to write turns
  -- "the log outlives what it describes" into "what it describes cannot die".
  --
  -- Every clause below is FK-action-safe, and that is the test to apply to any
  -- future addition: `module_key`/`position` have no FK and cannot be nulled
  -- behind our back; the data-browser arm requires `scope_ref` to be null, which
  -- an FK action can only keep true; `org_id` is left unconstrained here
  -- precisely because it is `set null` too.
  constraint superadmin_lookup_log_shape check (
    (tool = 'data-browser' and module_key is null and position is null and scope_ref is null)
    or
    (tool = 'view-as' and module_key is not null and position is not null)
  )
);

-- Reads are "what did this operator do, newest first" and "who touched this
-- person". Both get an index; neither is a policy dependency.
create index superadmin_lookup_log_actor_idx
  on public.superadmin_lookup_log (actor_user_id, created_at desc);
create index superadmin_lookup_log_subject_idx
  on public.superadmin_lookup_log (subject_user_id, created_at desc);
create index superadmin_lookup_log_org_idx
  on public.superadmin_lookup_log (org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- ACL. APPEND-ONLY IS ENFORCED HERE, AT THE GRANT LAYER — never by a trigger.
--
-- A `before update or delete ... raise exception` trigger is the obvious way to
-- write "append-only" and it is WRONG, proven live in the 2026-07-31 view-as
-- review: Postgres implements `ON DELETE SET NULL` as a real UPDATE on the
-- referencing table, which fires that table's own BEFORE UPDATE triggers. Every
-- FK on this table is `set null`, so such a trigger would make every user, org
-- and scope node this log has ever named PERMANENTLY UNDELETABLE — breaking
-- account erasure and ordinary org tidy-up. `vm_moderation_log`, the platform's
-- first audit log, has no such trigger for exactly this reason.
--
-- Grants are the right gate: with no UPDATE/DELETE privilege, an api-role write
-- is refused with 42501 before RLS is even consulted, while internal FK actions
-- — which run as the system, not as an api role — still work.
--
-- `service_role` IS NAMED IN THE REVOKE (docs/03 #17). Omitting a grant is NOT
-- the same as revoking one: on PROD, `ALTER DEFAULT PRIVILEGES FOR ROLE postgres`
-- auto-grants the full set — including the whole-table wipe privilege, the one
-- privilege RLS provably does not gate — to `service_role` on every newly created
-- table. `view_as_sessions` shipped without naming it and needed a follow-up
-- migration (20260802010000) once prod's catalog was actually read. An audit log
-- the worker's key can erase is not append-only in the sense this design claims,
-- and nothing in the worker touches this table. Getting it right the first time
-- here is the whole lesson of #17.
--
-- (Phrased "erase"/"wipe" rather than the literal SQL keyword on purpose: CI's
-- destructive-migration guard greps for that word followed by whitespace, in
-- comments too, and adding DESTRUCTIVE-CHANGE-APPROVED to this file would be a
-- lie — it creates a table, touches no rows and drops nothing. Same rewording
-- precedent as the 2026-07-29 ACL sweep and 20260731010000.)
-- ---------------------------------------------------------------------------
revoke all privileges on public.superadmin_lookup_log from public, anon, authenticated, service_role;
grant select, insert on public.superadmin_lookup_log to authenticated;
grant select on public.superadmin_lookup_log to service_role;

alter table public.superadmin_lookup_log enable row level security;

-- ---------------------------------------------------------------------------
-- The guard. Server-stamps identity and time, and refuses anything the app
-- layer might get wrong — because the app layer is not the gate (docs/03 #18).
-- `authenticated` can reach this table through PostgREST directly, so every
-- property the log claims must hold in the database.
-- ---------------------------------------------------------------------------
create function public.superadmin_log_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Identity and time are the SERVER's, always. A forged actor_user_id is the
  -- one thing that would make this log worse than no log — it would let a
  -- caller write rows attributing their own lookups to somebody else. The
  -- assignment (not a check) is deliberate: there is nothing to validate,
  -- because whatever the client sent is simply discarded.
  new.actor_user_id := auth.uid();
  new.created_at := now();

  if new.actor_user_id is null then
    raise exception 'superadmin log: not signed in';
  end if;

  -- ONLY A SUPERADMIN MAY WRITE HERE, in this build. Both writers are Owner
  -- Console tools and the console is superadmin-only, so this refuses nothing
  -- legitimate today. It is here so the table's NAME stays true from the
  -- database's point of view: every row really was written by a platform
  -- superadmin, which is what makes the "no module-rank read arm" reasoning
  -- above sound rather than merely currently-accurate.
  --
  -- The day a non-superadmin tool should log here, this check and the read
  -- policy change TOGETHER — see the header. Loosening one without the other is
  -- precisely how the rank-0 inversion would ship.
  if not public.is_superadmin() then
    raise exception 'superadmin log: only a platform superadmin writes to this log';
  end if;

  -- An oversight log row that cannot say WHICH TENANT was looked into is not
  -- oversight. Nullable in the column list only so `on delete set null` is legal.
  if new.org_id is null then
    raise exception 'superadmin log: org_id is required';
  end if;

  -- SCOPE-NODE TENANCY (adversarial review finding, 2026-08-07). A scope node
  -- belongs to exactly one (org, module) — `module_scope_nodes` carries both
  -- columns and its path trigger refuses a parent from a different pair. Nothing
  -- above stopped this row from naming org A while pointing `scope_ref` at a node
  -- in org B, which would be a quietly cross-tenant audit row: the reader would
  -- attribute a lookup to the wrong tenant's scope and have no way to notice.
  -- `20260720010000` enforces the identical property for `module_roles`; this
  -- file claims "every property the log claims must hold in the database", and
  -- until now that claim was overstated by exactly this much.
  if new.scope_ref is not null and not exists (
    select 1 from public.module_scope_nodes n
    where n.id = new.scope_ref
      and n.org_id = new.org_id
      and n.module_key = new.module_key
  ) then
    raise exception 'superadmin log: scope_ref does not belong to this org and module';
  end if;

  return new;
end;
$$;

create trigger superadmin_lookup_log_guard
  before insert on public.superadmin_lookup_log
  for each row execute function public.superadmin_log_guard();

-- Trigger functions hold no api-role EXECUTE (docs/03 #17). EXECUTE is checked
-- at `create trigger` time, not at fire time — established empirically
-- 2026-07-29, so revoking here does not stop the trigger working.
--
-- `service_role` IS NAMED, unlike the precedent at 20260731010000:270 which lists
-- only three roles. docs/03 #17 states the rule with four. Nothing is exploitable
-- either way — Postgres refuses to call a `returns trigger` function outside
-- trigger context regardless of who holds EXECUTE — but the convention says four
-- and drift from a stated convention is how the next reader learns the wrong rule.
revoke execute on function public.superadmin_log_guard() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS.
--
-- INSERT is pinned to the caller AND to superadmin — the same belt-and-braces
-- division of labour as `view_as_sessions_insert_actor` beside its guard
-- trigger. The guard already forces `actor_user_id`, so the policy's equality
-- check can never fail for a legitimate write; it exists so that the property
-- is visible in `pg_policies` to anyone auditing the table without reading the
-- trigger body.
--
-- There is NO UPDATE and NO DELETE policy, on purpose — and with no grant
-- either, an api-role write is refused at the privilege layer regardless of
-- policy. Both layers, deliberately.
--
-- SELECT HAS EXACTLY ONE ARM: `is_superadmin()`.
--
-- The first draft had TWO — a `_select_actor` arm (`actor_user_id = auth.uid()`)
-- beside the superadmin one, to serve the founder's explicitly stated use case
-- (2026-08-06): "reading your OWN log is not useless, because looking back to
-- debug something you did yourself is a real use." The adversarial review killed
-- it, and the reasoning is worth keeping because the conclusion is the opposite
-- of the obvious one.
--
-- The review's finding: `actor_user_id` is stamped once and never changes, while
-- `profiles.is_superadmin` is a separate mutable column with nothing tying the
-- two together. So an identity-keyed arm SURVIVES DEMOTION — strip someone's
-- superadmin flag and they keep reading every row they ever wrote, across every
-- tenant, forever. Demotion is precisely the suspected-misuse scenario this log
-- exists for, so the arm worked against the table's own purpose in the one case
-- that matters.
--
-- The review proposed `actor_user_id = auth.uid() and public.is_superadmin()`.
-- That fix is correct and also makes the policy DEAD: with the superadmin arm
-- present, "my rows AND I am a superadmin" is a strict subset of "I am a
-- superadmin", so it can never admit a row the other arm does not. A dead policy
-- is not free — it is a second thing to reason about that looks load-bearing.
--
-- So the arm is GONE, and the founder's self-read use case is unaffected: a
-- superadmin reading `is_superadmin()` rows already gets their own. The arm was
-- only ever needed for a future in which non-superadmins write here — which is
-- the same future that must add the actor's own (position, scope) columns and
-- the rank arm, in one migration, with its own review. Building a third of it
-- early bought nothing and cost a demotion hole.
--
-- What is NOT here, each absence deliberate and argued in the header: no module
-- rank/scope arm (it would invert the hierarchy via rank 0 — the central point
-- of this file), no org-admin arm (it would publish operator activity into
-- tenant audit views, the objection this table's existence dissolves), and no
-- subject arm (that is the still-open notify-the-target question).
--
-- ONE THING THIS ARM IS *NOT*, said plainly because the review caught the draft
-- implying otherwise: `is_superadmin()` IS NOT THE APPOINTMENT RULE. It performs
-- no rank comparison and no scope coverage test, because there is no rank domain
-- among superadmins to compare over — `is_superadmin` is a flat boolean on
-- `profiles`, not a ladder. Presenting a blanket "any superadmin reads every
-- row" as though it were the output of "strict rank + scope coverage" would be
-- dressing an unspecced choice in the spec's language.
--
-- So it is stated as what it is: a deliberate v1 choice, correct while there is
-- exactly ONE superadmin (where it is precisely the founder's "only the
-- superadmin can see them"), and CARRYING AN OPEN QUESTION the moment there are
-- two — should superadmin B read 100% of superadmin A's lookups, unscoped,
-- forever? The alternative (each reads only their own) would make the log pure
-- self-audit and give no oversight at all, so this is the better default, but it
-- IS a default and not a derivation. A second superadmin is already one of the
-- named conditions that expires this whole design (docs/12 item 9); this is now
-- a second reason that condition matters, and it is on the Next list as a
-- founder decision rather than settled here.
--
-- Note it is `for select` and not `for all`: a `for all` policy's USING also
-- covers SELECT, so splitting one per-command later silently drops an inherited
-- read arm — the exact defect 20260806010000 was written to repair on
-- `sal_locations`.
-- ---------------------------------------------------------------------------
create policy superadmin_lookup_log_insert_actor on public.superadmin_lookup_log
  for insert to authenticated
  with check (actor_user_id = auth.uid() and public.is_superadmin());

create policy superadmin_lookup_log_select_superadmin on public.superadmin_lookup_log
  for select to authenticated
  using (public.is_superadmin());
