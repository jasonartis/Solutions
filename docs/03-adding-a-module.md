# Adding a Module

The platform's economics depend on this process being fast and repeatable — by a human, by Claude Code, by Copilot, or any mix. Conventions are deliberately rigid: an AI given this doc plus one exemplar module should scaffold a correct new module.

## Module anatomy

```
modules/<module-key>/
├── manifest.ts        # id/key, display name, entitlement key, roles, nav entries,
│                      # jobs, settings schema (Zod), upload limits
├── schema.ts          # Drizzle tables — ALL prefixed (e.g. `sal_`), ALL with org_id
├── policies.sql       # RLS policies for every table (reviewed, no exceptions)
├── routes/            # API route handlers (mounted by apps/web under /api/m/<key>/)
├── pages/             # React pages (mounted under /m/<key>/), per-role entry points
├── components/        # module-private components
├── jobs/              # pg-boss job handlers (registered by apps/worker)
├── seed.ts            # demo org + realistic test data for local dev
├── SPEC.md            # the module's specification (source of truth)
└── __tests__/         # unit + Playwright e2e for the critical paths
```

## Conventions proven by module 3 (extraction pass, 2026-07-07)

`modules/synagogue-schedules` is the **canonical exemplar** — copy its structure. The
hard-won specifics every new module must follow:

1. **Migrations grant explicitly — for tables AND functions — and never rely on a
   default privilege for a security boundary.** Tables created in CLI migrations do NOT
   inherit Supabase's API-role grants: every migration `grant select, insert, update,
   delete on <tables> to authenticated, service_role;` then RLS restricts rows (see
   `20260707030000_synagogue_schedules.sql`). For **functions** the trap is the
   opposite and environment-dependent, so state the FULL intended ACL explicitly
   (`revoke execute ... from public, anon, authenticated;` then `grant execute ... to
   <exactly the roles that need it>;`) rather than trusting defaults:
   - Postgres grants `EXECUTE` to `PUBLIC` on every function at CREATE time, so omitting
     a grant does NOT restrict anything — `PUBLIC` already covers `anon`.
   - On the **hosted (prod) stack**, `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` also
     grants `EXECUTE` **directly** to `anon`/`authenticated`. A `revoke ... from public`
     does not touch a direct grant, so it is a no-op there. The **local** stack lacks
     this default, so a function locked down with `revoke ... from public` looks closed
     locally but is still open on prod (the 2026-07-22 `module_scope_covers` gap —
     `20260722010000`). Only functions that DON'T fail closed on `auth.uid()` (i.e. take
     bare ids with no identity check) actually need the tight ACL; state it explicitly
     regardless so the migration is environment-independent.
   - **Verify security-sensitive ACLs against PROD, not only local** — the RLS suite runs
     against local, where default privileges differ, so it cannot catch this class of
     gap. A privilege/ACL assertion belongs in a prod-verification step.
2. **Module pages gate with `requireOrgModule(orgSlug, moduleKey)`**
   (`apps/web/lib/module-gate.ts`) — org by slug → entitlement → 404. Never hand-roll.
3. **Org-level module config lives in `org_modules.settings`** (jsonb), typed via a cast
   at the read site; module-role checks use `has_module_role()` / a module-specific
   `<prefix>_can_write()` definer function.
4. **Public (no-login) access = security-definer functions**, never anon table policies
   (see `syn_public_weeks` / `syn_public_week`): the function exposes exactly what a
   visitor may see, gated on maker-published rows.
5. **Async work = `job_requests` row** (org-scoped RLS insert by members) + a worker
   handler registered in the poller; results land in storage/DB; UI shows status +
   signed URLs. Never a bespoke queue.
6. **Imports**: apps reference module code via the `@modules/<key>` tsconfig path alias
   (web) or a relative path (worker, tsx runtime); NO `workspace:*` deps (exFAT, docs/01).
7. **Admin-configured rules are Zod-validated JSON** parsed at every read site with
   `safeParse` + skip-on-invalid, so one bad row never crashes a page.
8. **Acceptance = reproduce the client's real artifact** from their real data as a test
   (see `pozna-acceptance.test.ts`) — the module isn't done until that's green.

## Conventions proven by modules 1/2/5 (second extraction pass, 2026-07-09)

Four modules now run on these; they are load-bearing, not suggestions:

9. **Staff checks delegate to `is_org_admin()`** — every module defines
   `<prefix>_can_manage(check_org_id)` as `is_org_admin(check_org_id) OR
   has_module_role(org, '<key>', <staff-role>...)`. The superadmin/org-owner tail
   lives ONLY in `public.is_org_admin()` (`20260709040000_platform_extraction.sql`);
   never restate it in a module function. Additional tiers compose downward the same
   way (e.g. `sal_can_operate = sal_can_manage OR cashier`).
10. **Scope-sync triggers derive tenancy server-side** — child tables get a BEFORE
    INSERT/UPDATE trigger deriving `org_id` (and any parent scope like `class_id`/
    `location_id`) from the FK chain, raising on an unknown parent. Root tables
    (no parent) rely on the RLS write gate tying client-supplied `org_id` to an org
    the caller manages. Server actions insert `DERIVED_SCOPE_PLACEHOLDER` (from
    `@platform/core`) to satisfy NOT NULL pre-trigger — never a hand-typed UUID.
11. **RLS is row-level; column/lifecycle rules are BEFORE-UPDATE guard triggers** —
    pin protected columns back to `OLD` for non-staff and validate state-machine
    transitions (see `cls_pin_submission_columns`, `mm_pin_answer_identity`,
    `sal_pin_appointment`, `sal_guard_bill`). **Trigger-order gotcha:** same-event
    triggers fire alphabetically; a pin trigger must sort BEFORE the scope-sync
    trigger so a reverted parent-FK can't leak into scope derivation.
12. **Agent-draft → security-review → integrate** is the module-schema process:
    a background agent drafts `modules/<key>/schema-draft.sql` from the spec +
    exemplars; a human review produces `schema-fixes.sql` (the guards above are the
    usual findings — definer functions bypassing role gates, unpinned identity
    columns); the two concatenate into the real migration. Every security fix is
    verified LIVE against Postgres (signed-in anon clients attempting the bypass)
    before the migration ships.
13. **SECURITY DEFINER functions re-check role gates internally** — a definer RPC
    bypasses RLS entirely, so any role restriction the table's policies enforce must
    be restated inside the function (the `mm_ensure_answer` finding).
14. **Server actions never use the service-role key** — admin-triggered heavy work
    (e.g. matchmaking recompute) runs as the admin under RLS; the service-role key
    exists only in the worker. If a user-triggered job genuinely needs it, it goes
    through `job_requests`.
15. **A table's own policies use direct column checks, never self-referential
    lookups** — an ownership check like `<prefix>_owns_row(id)` that queries the
    same table breaks `INSERT … RETURNING`: the definer function's snapshot does
    not include the row being inserted, so the RETURNING select fails even though
    the insert succeeded (found live in module 6). Compare columns directly
    (`user_id = auth.uid()`); reserve ownership helper functions for policies on
    OTHER tables, whose referenced rows already exist.

## Scope-aware authority (user-model slice 2, proven by classroom + nail-salon)

A module that scopes authority to an entity (a class, a location, an event) follows
this shape — the authority LOGIC is shared; each module adds only thin wrappers:

16. **The scope-authority engine is platform-shared; per-module code is thin.** The
    "who may act on this scope" logic lives in ONE place and every module reuses it:
    - `module_scope_nodes` (one entity-tree table) + a `scope_node_id` column on the
      module's entity table, minted by a BEFORE-INSERT definer trigger + backfilled.
    - `module_position_rank(module_key, role)` — one IMMUTABLE fn; add a `CASE` block
      mapping the module's roles to the generic tiers (director 4 / coordinator 3 /
      lead 2 / position 1); unmapped roles stay rank 0 (invisible to the ladder).
    - The two-branch hierarchy guard (`module_caller_can_manage_seat` +
      `module_roles_guard_hierarchy`) governs who may GRANT which seat — module-agnostic,
      never re-implemented per module.
    - **`module_caller_covers_rank(org, module, node, min_rank)` /
      `module_caller_covers_role(org, module, node, role)`** (20260726020000) — the
      per-row authority primitives (is-org-admin OR a grant of sufficient rank/role
      whose scope COVERS the node). Each module writes a ONE-LINE wrapper
      (`<prefix>_can_manage_<entity>(org, entity_id)`) that resolves its entity → its
      `scope_node_id` and delegates. Keep the wrapper signatures stable so the RLS
      policies don't churn.
    - **Coarse vs precise:** keep a coarse `<prefix>_can_manage(org)` (any-scope, off
      `module_roles` not `has_module_role`) for CONSOLE ENTRY only; per-row policies
      and lifecycle/pin triggers use the PRECISE `_<entity>` wrappers. `module_can_manage`
      (export controls) must gate on admin-or-GLOBAL (`has_module_role`, global-only), so
      a scoped staffer can't toggle module-wide settings.
    - **Entity-CREATE gate self-reference:** the entity's own row/node isn't in the
      INSERT snapshot, so gate INSERT on a NON-self-referential check (coarse, or the
      parent's node), never `<prefix>_can_manage_<self>(id)` (docs/03 #15). UPDATE/DELETE
      use the node.
    - **Existing global grants stay global = org-wide** (unchanged). Only re-scope
      existing grants when a global grant would OVER-expose through a coverage-based
      membership read (classroom's `cls_is_class_member` — a "global student" would be a
      member of every class; salon had no such vector, so its grants were untouched).

### Composition & template (founder decision, 2026-07-09)

Founder-proposed, adopted with one adjustment:

- **A module aims to be 100% self-contained in `modules/<key>/`** — logic, schema,
  AND UI (pages under `modules/<key>/ui`, mounted by one-line route wrappers in
  `apps/web`). New modules are built this way; older modules migrate
  opportunistically.
- **Plug-and-play composition stays within ONE codebase** (docs/00's one-deployment
  principle is not weakened): entitlements already hide modules per org; for the
  future case of an isolated white-label instance, the `MODULES` env var filters
  the module registry at build time — "an app with only module 3" is a config
  line on a second deployment of the SAME repo, never a fork.
- **`modules/sample` (module 0) is the living template**: a minimal module
  exercising every convention in this doc (prefixed parent+child tables,
  scope-sync + pin triggers, RLS tiers, gated page + server actions, seed,
  e2e). Copy it to start module 7+. **Rule: whenever a capability is extracted
  into `packages/platform`, the sample module is updated in the same pass** —
  the template must never rot behind the conventions.

### Control hierarchy (founder question, 2026-07-09 — formalized; level 2 built 2026-07-12)

Three levels, uniform across modules: **superadmin** (platform-wide) → **org
owner/admin** (`is_org_admin()`, everything in their own org) → **module role ladders**
(tiers compose downward via the `_can_*` helpers — each tier includes all higher
tiers, so higher always controls lower).

**Org roles are a real RANK ladder (founder decision, 2026-07-17):**
superadmin(4) > owner(3) > admin(2) > member(1). A caller may create/change/
remove an `org_members` seat only if they STRICTLY outrank both its current
and target role (`org_members_guard_hierarchy`, `20260717010000`). So only a
superadmin creates owners; an owner manages admins+members (not other owners);
an admin manages members only (can't mint/touch admins or owners); a member
manages no one; and nobody can act on their OWN seat (equal rank — this
subsumed and replaced the earlier self-seat guard). The retained last-admin
guard still enforces the zero-owner/admin floor. NOTE the rank ladder governs
ONLY who-manages-whom in `org_members`; `is_org_admin()` is UNCHANGED (owner
OR admin), so both keep full ORG management (settings, module-role grants) —
the founder's "admins keep full powers" call. Two intended consequences: an
owner can't self-toggle owner↔admin (any self-action is blocked), and an
all-admin org with no owner can't self-manage admins (only a superadmin can
create/manage an owner). "Owners-only settings" is a possible future
refinement, deliberately not built.

**Level 2 is now self-serve**, not superadmin-only: `/o/[orgSlug]/members`
(gated `requireOrgAdmin`, linked from the dashboard's org card whenever the
caller is owner/admin) lets an org owner/admin add/remove their own org's
members, change org roles, and grant/revoke module-specific roles (`module_roles`)
for modules already enabled there — everything an org runs day-to-day short of
deciding WHICH modules it has access to. **Module SETTINGS are level-2
self-serve too** (founder, 2026-07-12: "whoever fills in the synagogue info
should enter it"): `/o/[orgSlug]/settings` lets an org owner/admin edit
`org_modules.settings` for their own org
(`20260712030000_org_settings_self_serve.sql` — an org-admin UPDATE policy
plus an `org_modules_pin_enablement` trigger pinning
`enabled`/`org_id`/`module_key` for non-superadmins, because RLS alone can't
protect one column of a row it allows updates on). Module ENABLEMENT
(`org_modules.enabled` — WHICH modules an org may use) stays superadmin-only
(`20260712010000_org_self_management.sql` is additive-only RLS and never
touches enablement; neither does the settings policy, thanks to the pin) —
the founder's explicit call: some orgs shouldn't have access to some modules,
and that's a platform-owner business decision, not something an org can
grant itself. A "last-admin-standing"
guard trigger (mirroring the visual-messaging conversation-admin pattern) stops
an org from ever being left with zero owner/admin. (A short-lived self-seat
guard, `20260716030000`, blocked only self-demote/remove; it was superseded
2026-07-17 by the rank ladder above — which subsumes it AND answers the
"can an admin touch another admin?" question: no, equal rank — and the
`20260717010000` migration drops it.) The superadmin Owner Console
(`/console`) and the new org page share one component
(`apps/web/components/org-members-panel.tsx`) and one set of data-operation
helpers (`apps/web/lib/org-members.ts`) — one place to change either surface,
not two that can drift.

Two things remain deliberately NOT built until a real client needs them
(extract-don't-speculate): **delegated role-granting one level further down**
(e.g. a salon manager appointing cashiers themselves, rather than the org
owner/admin doing it) and **location-scoped staff** (the franchise-owner layer;
salon data is org→location-ready but staff RLS is org-wide). When the first
client needs either, build it as a platform primitive, not per-module.

**New-module acceptance checklist (the docs/04 extraction-pass criterion):** a new
module must need no code outside (a) `modules/<key>/`, (b) its migration, (c) its
pages under `apps/web/app/(app)/o/[orgSlug]/m/<key>/`, (d) a manifest entry in
`packages/platform/src/modules.ts`, and (e) a seed block. If building one forces an
edit anywhere else, that's a missing platform primitive — extract it, don't fork it.

## The privilege model — two locks (ACL hardening sweep, 2026-07-29)

17. **Every object has TWO gates and a module must satisfy both.** RLS ("which rows?")
    is the one we design carefully; the GRANT layer ("may this role touch the object at
    all?") is the one that silently defaults open. Until `20260728010000` prod granted
    `anon` the full privilege set (`arwdDxtm`) on all 67 tables and left 134 of 139
    functions PUBLIC/anon-executable, so RLS was the ONLY gate. The sweep set the
    intended ACL platform-wide; keeping it that way is now a convention, not a one-off:
    - **`anon` holds NOTHING in schema `public`** except schema `USAGE` and EXECUTE on
      the explicitly allowlisted public functions. **Strangers never write — there is no
      sanctioned anon write path anywhere** (founder decision, 2026-07-29). A new module
      table needs no anon grant, ever.
    - **A public (no-login) surface is a `security definer` function granted to `anon`,
      never a table grant** (extends convention #4). This holds for platform-level pages
      as much as module pages. A purely static page (about, contact-by-email) needs no
      grant at all. If a public page ever needs to WRITE, it goes through a definer
      function that validates and writes internally — never `grant insert ... to anon`.
    - **`authenticated` must KEEP EXECUTE on every function named in an RLS policy.**
      Policy expressions are permission-checked as the *querying* role, so revoking it
      turns every read into `permission denied for function`. Verified empirically.
    - **Trigger functions get no api-role EXECUTE at all.** EXECUTE is checked at
      `create trigger` time, not at fire time — verified as `authenticated`,
      `service_role` and `supabase_auth_admin` (signup still works with the grant fully
      revoked). So `revoke execute ... from public, anon, authenticated, service_role`.
    - **Never enumerate signatures by hand.** Generate from
      `pg_get_function_identity_arguments`, or blanket-revoke then re-grant explicitly.
      Hand lists miss overloads (`module_position_rank` exists as both `(text)` and
      `(text, text)`) and can name dropped functions (which aborts the transaction).
    - **A table-level `revoke all` also wipes COLUMN-level grants** (verified). `profiles`
      deliberately gives `authenticated` column-only UPDATE on `(display_name, settings)`;
      any table-wide revoke must restore it explicitly.
    - **RLS does not gate `TRUNCATE`** (nor REFERENCES/TRIGGER). Those are ACL-only, so
      they must not be granted to `anon`/`authenticated` — RLS is not a mitigation.
    - **A `revoke all` must name `service_role` too, or prod decides for you.** Prod's
      `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` grants the FULL set to `service_role`
      on every new table as well as to anon/authenticated — so a revoke listing only
      `public, anon, authenticated` leaves service_role holding DELETE/UPDATE/the wipe
      privilege, silently and only on prod. Usually harmless (it bypasses RLS by design
      and isn't internet-reachable — the 2026-07-29 founder decision), but **never for an
      audit log**, whose entire value is that nobody can quietly edit or erase it. Caught
      on `view_as_sessions` by its prod verifier on the first run; fixed by
      `20260802010000`. State every role the migration means to govern.
    - **Don't write `revoke truncate`** — CI's destructive-migration guard matches
      `truncate[[:space:]]`. Use `revoke all privileges` then re-grant the intended DML.
    - **Verify against PROD, not local** (convention #1's rule, mechanized):
      `pnpm exec tsx scripts/verify-acl-hardening.ts [--probe]` asserts the intended end
      state and exits non-zero; `scripts/acl-audit.ts [--json]` reports the full privilege
      state for a before/after diff. The local RLS suite alone cannot catch this class of
      gap, which is why `packages/db/src/rls.test.ts` now has an explicit `anon`-role
      block — before the sweep the suite had never once tested a not-logged-in caller.

## View-as (user-model slice 5, proven by classroom 2026-07-31 + nail-salon 2026-08-04)

18. **Every module declares view-as, and the declaration is exhaustive by
    construction.** A module may not opt out: the rank-differential completeness
    check (docs/15 §8.1 point 11) is only a check if it is platform-wide.
    - **Declare with `declareViewAs()`** in `packages/platform/src/view-as-modules.ts`
      and attach it to the manifest. `edges` is typed `ViewAsEdges<positions>`, a mapped
      type over the module's own rank table, so **every ordered position pair with a rank
      gap must carry an explicit `{mode1, mode2, note}` entry or `pnpm typecheck` fails**
      — and CI runs typecheck. Equal-rank pairs (GA/student) require no entry and get
      their exclusion for free. `mode2` without `mode1` is not representable.
    - **The mapped type alone does NOT deliver the guarantee.** It keys on the
      *TypeScript* rank table, while the authoritative rank lives in SQL's
      `module_position_rank()`. A SQL-only rank remap — the exact "one-line migration,
      no backfill" the amendment exists to catch — would not fail it. The RLS suite's
      rank-parity test against the live database is what closes that; never treat the
      type as sufficient on its own.
    - **Both gates again (#17), for edges too.** `module_view_as_edge(module_key,
      from_role, to_role)` mirrors the ON pairs into IMMUTABLE SQL and the
      `view_as_sessions` guard requires it, because `authenticated` can reach the table
      through PostgREST directly — the app layer is not a gate. A parity test asserts SQL
      and TypeScript agree on **every** ordered pair, including the OFF ones.
    - **No new read path, ever.** View-as renders through the CALLER's ordinary
      RLS-enforced client; the surface declaration is a column ALLOW-LIST that can only
      narrow. If a declared surface table is not readable by the viewing position, that
      is a gap in the ladder's RLS — fix the ladder, never add a definer to bridge it. A
      SECURITY DEFINER read path for view-as was considered and rejected (docs/15,
      2026-07-30) precisely because it removes RLS as the backstop against a bad
      declaration.
    - **Three off-surface lists, because there are three different readers.** Each
      claim is separately falsifiable and the RLS suite asserts all three:
      `personal` — the **viewer** cannot read it (§8.1 point 1's strict sense);
      `excluded` — the **viewer** can read it, we decline to render it;
      `unreadableByPosition` — the **position itself** has no read path.
      Collapsing any two lets a genuine RLS gap hide behind the wrong label, which is
      exactly what §8.1 point 1 warns about when it calls a personal marking on a
      staff-readable table a spec violation. Two lists were tried first and the second
      adversarial review found a real misclassification inside a week: classroom's GA
      surface listed `cls_review_assignments` as `excluded` when in fact no GA can read
      it at all.
    - **Enforce append-only with GRANTS, never a `before update or delete` trigger.**
      Postgres implements `ON DELETE SET NULL` as a genuine UPDATE on the referencing
      table, so such a trigger fires on the FK action and aborts the parent DELETE —
      making any row an audit log has ever referenced permanently undeletable (users,
      scope nodes, and via `org_id`'s cascade, whole orgs). A no-UPDATE/no-DELETE grant
      refuses api-role writes at the privilege layer with `42501` while leaving internal
      FK actions working, which is why `vm_moderation_log` has no such trigger. Found
      live by the second view-as review, after the first review had (correctly) required
      the `set null` FKs.
      **THE RULE GENERALISES PAST TRIGGERS — learned again 2026-08-07, in a new disguise.**
      A CHECK CONSTRAINT re-creates the identical trap, because a CHECK is re-evaluated on
      every UPDATE *including the real UPDATE Postgres performs to satisfy an FK action*.
      The superadmin lookup log's review proposed `subject_user_id is not null` for its
      data-browser rows — obviously true of that tool, and it would have made **every person
      ever browsed permanently undeletable**. General form: **any constraint that forbids the
      null an FK action is about to write turns "the log outlives what it describes" into
      "what it describes cannot die."** The test to apply to every clause of an audit table's
      CHECK: could an `on delete set null` write a value this clause rejects? Prove it with a
      test that deletes a referenced row and asserts BOTH halves — the delete succeeds, and
      the log row survives with a nulled reference.
    - **Widening a CHECK on an append-only log needs `not valid` + `validate constraint`**
      (2026-08-07, from the lookup log's review; recorded here and NOT in the migration,
      because that migration has already run and an applied migration is never edited — the
      CLI stores its `statements` per version). Adding a value to an existing CHECK the
      obvious way (`drop constraint` then `add constraint ... check (...)`) takes an
      ACCESS EXCLUSIVE lock for a FULL-TABLE validation scan. On a log that is append-only
      and never pruned that scan grows without bound — free at zero rows, an outage after
      years of history. Instead: `add constraint ... check (...) not valid` (skips the scan,
      brief lock), then a separate `validate constraint` (SHARE UPDATE EXCLUSIVE, blocks
      neither reads nor writes). Applies to `superadmin_lookup_log`'s `tool` vocabulary and
      its row-shape CHECK, and to any future audit table built on the same pattern.
    - **"Unranked" and "rank 0" are not the same thing** (2026-08-07, the superadmin lookup
      log). `module_position_rank(module_key, role)` returns **0 for any unmapped pair and
      never null** — its inner CASE falls through `coalesce` to the generic tier table, whose
      `else` is 0. So a hierarchy test written as `rank(reader) > rank(actor)` treats anyone
      OUTSIDE the ladder (a platform superadmin holds no module position at all) as sitting at
      the BOTTOM of it, and every rank-1 holder on the platform then "strictly outranks" them.
      For an oversight log that is a total inversion of the intended hierarchy, and it is
      silent and error-free. **Before writing any rank comparison, ask what the function
      returns for a participant who is not on the ladder at all** — and if the answer is 0,
      the comparison needs an explicit `is not null` guard on a recorded position, or it needs
      not to exist. Rank 0 is the bottom of a ladder; unranked is not on it.
    - **An audit-log read arm keyed on WHO YOU WERE outlives the authority it was granted
      for** (2026-08-07). `actor_user_id = auth.uid()` looks like the obvious way to let
      someone review their own activity, and it is stamped once and never changes — while the
      privilege that justified it (`profiles.is_superadmin`, a module seat, an org role) is a
      separate mutable fact with nothing tying the two together. Demote the person and they
      keep reading their own history forever, which is exactly the suspected-misuse case the
      log exists for. Key read arms on who the caller **is**, not who they **were**. Note the
      usual consequence: once conditioned on current authority, a self-read arm is often a
      strict subset of the oversight arm and should simply be deleted rather than fixed.
    - **Every "X cannot read this" assertion needs a non-emptiness control.** A clean seed
      has no `cls_review_assignments` and no `cls_survey_answers`, so "the GA sees nothing"
      passes because the table is EMPTY, not because RLS hides it. Assert a privileged
      reader sees rows first, and create a fixture if the seed has none. This caught itself
      on the first clean run — an earlier manual row count had been contaminated by e2e
      leftovers, which is its own reminder that counts taken mid-session prove nothing.
    - **Org position does not enable view-as; module position does** (founder,
      2026-08-02). The `view_as_sessions` guard is the ONE gate on the platform with no
      `is_org_admin` short-circuit — org membership is a precondition, org rank confers
      nothing. Do not "fix" the inconsistency by adding the arm. Org admins may still READ
      the session log (auditing is not view-as), and may still grant themselves a module
      seat freely, which is the point: the power becomes an explicit recorded act instead
      of an ambient one.
    - **An edge may only be ON in a module whose surfaces have had a security review**
      (§8.1 point 9). Enumerate the pairs, set them OFF with a note saying why, and turn
      them on when that module's review happens. Classroom is the worked example;
      nail-salon (2026-08-04) is the second and the one to read for the mode-1-only case.
    - **Mode 1 and mode 2 answer different questions, so decide them separately.**
      Mode 1 = *what can this POSITION see?* Mode 2 = *what does this PERSON see?*, which
      is only meaningful where RLS narrows **per person**. Ask of each position: is its
      reach a function of WHO it is, or only of WHAT SCOPE it covers? Nail-salon narrows
      per location for manager/cashier and per person only for worker, so five staff pairs
      are `{mode1: true, mode2: false}` and two are full. The two wrong ways to force mode
      2 onto a scope-narrowed position: filter on an authorship stamp (`created_by`,
      `paid_by`), which **under-shows** the tab by hiding rows the target genuinely reads;
      or render unfiltered, which is honest but is not mode 2. `viewAsCompleteness()`
      refuses mode 2 on a surface with no per-person table — treat that error as the
      design telling you something, not as an obstacle. The real need behind it (one named
      holder's SCOPE-narrowed console) is the Owner Console's no-person-filter mode.
    - **A mode-1-only pair still needs no migration arm.** `module_view_as_edge()` mirrors
      MODE 2 specifically, because mode 2 is the only mode that writes (a session row).
      Mode 1 creates nothing and reads only through the caller's RLS, so it has no
      database gate and needs none. The parity test compares SQL against `mode2`, so a
      mode-1-only pair reads `false` in SQL exactly like an undeclared one — the manifest
      note is where the difference is recorded.
    - **The failure mode a surface must never have is FALSELY PERMISSIVE.** A section that
      shows rows the target cannot see turns the tab into a lie in the one direction that
      matters: an operator debugging "why can't she see this?" sees it and concludes
      nothing is wrong. Under-showing is a usability cost; over-showing is a correctness
      bug. When `subjectColumn` cannot express a narrowing (it names a user-id column, so a
      table reaching its person through a child row is out of reach), the honest options
      are an **embed under the row that makes the hop** — the hop is already made, so the
      children are the right ones in both modes — or `excluded` with the reason. Never
      `subjectColumn: null` on a table the position reads only part of.
    - **Render all THREE off-surface lists, not two.** `unreadableByPosition` was declared
      and test-enforced from slice 5 but never shown on screen until 2026-08-04 — which
      would have hidden the single most useful fact on nail-salon's cashier tab ("a
      cashier cannot read the earnings ledger"). A declaration nobody can read is
      documentation, not disclosure.
    - **Watch what `formatCell` does to embeds.** It collapses an embedded object to its
      `title`/`name` key and otherwise stringifies JSON, so a multi-column embed silently
      drops columns from the screen while still being declared. Use PostgREST column
      aliasing (`name:full_name`) so the allow-list lists exactly what renders. Classroom's
      embeds select `title` — that met the constraint by luck, not by design.
    - **Verify the keystone as the POSITION, not as an org admin.** Every module gate
      except the view-as guard short-circuits on `is_org_admin()`, and the seeded
      module-level staffer is often also the org owner (alice is both manager and owner of
      demo-salon). A keystone test run as her proves nothing about the manager position:
      grant a plain member the position for the test instead.
    - **`subjectColumn` names the person ON THE ROW — if the person is one hop away, it is
      an EMBED, never `null`.** A comment names its AUTHOR; the reviewee is reached through
      the submission. Declaring `subjectColumn: null` because "no column fits" silently
      reclassifies the table as class-wide, and the surface then renders every holder's rows
      under one person's name — badged, misleadingly, exactly like a genuine announcement
      table. The honest mechanism is an embed under a parent whose subject column IS that
      person (mirroring whatever definer the live UI uses), or `excluded` if the target is
      not meant to see it at all. Found live 2026-08-06 in classroom's student surface,
      shipped 2026-07-31 and invisible to every test because the table had zero seed rows.
    - **A per-person badge is only half the honesty; scope is the other half.** A position
      narrowed by SCOPE rather than by PERSON has `subjectColumn: null` on every table, so a
      person-filter badge can never fire for it — and a whole-module render then combines
      every scope while the page claims "affected sections say so". Any surface that can be
      rendered with an axis left open must badge THAT axis. State the badge as a fact about
      the render ("no scope filter"), never as an inference about holders: a global grant
      genuinely does see every scope, so "more than one holder sees" is the opposite lie.
    - **Count your bypasses out loud, and expect the count to be wrong.** A superadmin
      surface that says "it bypasses exactly these three things" is making a falsifiable
      claim, which is why it is worth writing — the 2026-08-06 review found a fourth
      (`org_modules.enabled`) precisely because the list invited the check. An
      exhaustive-sounding list that is not exhaustive is worse than no list.
    - **Naming a gate is not passing one.** A `{ kind: 'platform-superadmin' }` discriminated
      union closes the ACCIDENTAL bypass (no defaulting boolean), but the literal is
      structurally typeable by any future caller who checked nothing. Give the privileged arm
      a token minted ONLY by the check itself — a `declare const unique symbol` brand has no
      runtime value, so the type cannot be written as an object literal and one documented
      cast inside the gate is its only source. It is a compile-time control (`as never` still
      defeats it) and it is not trying to be more: it stops the plausible accident of a new
      call site copying the literal without noticing the check was what it stood for.
    - **An app-layer invariant that keeps a UI gate sound belongs in a SOURCE SCAN, and the
      scan belongs where CI runs it.** "No `.rpc()` and no service-role client on this path"
      cannot be caught by any runtime probe after the fact — by the time the call exists, the
      gate has silently become a security boundary. Two failure modes, both hit: a scan that
      hardcodes paths never sees the NEXT surface added (list the files, and assert the count
      you scanned), and a scan living only in `scripts/*.mts` is not run by CI at all.

## The data browser (docs/13, built 2026-08-03)

19. **Every module declares which of its tables can name a person, and the DATABASE
    CATALOG — not TypeScript — is the authority.** The data browser answers a different
    question from view-as: *"what do I hold about this person?"* (everything the VIEWER
    may read, bounded by RLS and nothing else) rather than *"what does this person
    see?"* (a curated surface, deliberately narrower). Two tools, two questions; a UI
    that presents one as the other is the only way the pair becomes misleading, so the
    contrast is stated on the page itself.
    - **Declare with `declareDataBrowser()`** in `packages/platform/src/data-browser-modules.ts`,
      attached to the manifest beside `viewAs`. Three lists, mirroring #18's discipline for
      the same reason: `lookups` (queried), `omitted` (person columns we deliberately do not
      query, with a why), `neverReadable` (rows exist that NO viewer may read).
    - **A mapped type cannot enforce this**, because "which columns name a person" is a fact
      about the schema. `packages/db/src/data-browser-coverage.test.ts` reads `pg_catalog` and
      FAILS on any FK to `auth.users`/`profiles` that no list accounts for, so a migration
      adding a person column breaks CI until someone decides what the browser should do with
      it. Use `pg_catalog`, never `information_schema` — `constraint_column_usage` does not
      expose constraints targeting the `auth` schema, so the information_schema form of that
      query silently returns ZERO rows and passes vacuously.
    - **Indirect links are the ones that bite, and no catalog scan can find them.** Nine
      tables name a person only through a child row and carry no person column at all
      (`sd_interest`, `sd_matches`, `sd_pairings`, peer-review comments on your own
      submission), and they hold some of the most sensitive rows on the platform. Declared as
      `via` hops. The dividing rule for which one-hop links to declare: does the row say
      something ABOUT the person, or does it merely share a CONTAINER with them? A flag on
      their layer, a comment on their submission, a line item on their bill — declared.
      "Same event", "same conversation" — not.
    - **A hop chain can be longer than one, and assuming otherwise shipped a real gap.**
      `sal_bills` has no customer column at all, so the path to a paying customer is
      `bills.appointment_id -> appointments.customer_id -> customers.user_id`. With one hop
      the browser showed a customer their appointments and ZERO bills — which reads as "we
      hold no billing record for you", not as a broken link. Hence `PersonVia.then`.
    - **`select *`, not an allow-list — the one deliberate departure from view-as.** The
      feature exists to be COMPLETE, so an allow-list would silently hide exactly the new data
      it should surface; and RLS is row-level, so anyone who can read the row can already read
      every column of it from any client, making a UI allow-list comfort rather than
      protection (hard rule 6).
    - **The failure direction is under-reporting, and an empty section is indistinguishable
      from a truthful "nothing here".** So: never swallow a query error (a failed `via` lookup
      makes a via-only section VANISH — a third state, "we could not check", that must be
      rendered as an error); cap every query including the intermediate hops; and check
      module selection off entitlement rows that EXIST, not `enabled = true`, or disabling a
      module hides its whole history at the exact moment someone opens this tool to decide
      what to export before deprecating it.
    - **Verify a `via` points where it CLAIMS to point.** Checking only that the column is
      "some FK to some person-bearing table" leaves a hole: two candidate targets both having
      an `id` means a wrong `lookupTable` passes every check and then returns zero rows
      forever.
    - **`neverReadable` is asserted in the CI suite, not only in a probe script.** It is
      rendered to an operator as a statement of fact, and `scripts/*.mts` are NOT run by CI —
      a migration adding a staff arm to `sd_notes` would leave everything green while the UI
      kept claiming the opposite. `rls.test.ts` builds a real row as its author and asserts
      staff and the superadmin both get nothing; a declared table with no fixture recipe
      FAILS rather than being skipped.
    - **The superadmin gate is a UI gate, and that is sound HERE for one specific reason:**
      every query runs on the caller's own RLS client, so each is one they could already issue
      against PostgREST themselves — bypassing the gate grants nothing. This does NOT
      contradict #18's "the app layer is not a gate": that rule was about view-as, where
      starting a session was a real PostgREST-reachable WRITE. **The invariant that keeps it
      true: no code on this path may call `.rpc()` or a service-role client.** One SECURITY
      DEFINER call turns the app gate into the only thing standing between a user and data RLS
      would have refused. Source-scanned by `scripts/verify-data-browser.mts`.

## Test discipline: the vacuity rule (generalised 2026-08-03)

> **A passing NEGATIVE assertion proves nothing unless something nearby proves the
> subject exists.**

#18 already states this for one case ("every 'X cannot read this' assertion needs a
non-emptiness control"). It was generalised after the same failure appeared three times
in a single session wearing three different costumes, none of which looked like the
others:

- **An RLS check on an empty table.** "The GA sees nothing" passes because the table has
  no rows, not because RLS hides them. → Assert a privileged reader sees rows FIRST, and
  create a fixture if the seed has none.
- **A catalog query that returns zero rows.** The first version of the data browser's
  completeness check used `information_schema.constraint_column_usage`, which does not
  expose constraints targeting the `auth` schema. It returned ZERO person columns and the
  "every column is declared" assertion passed against an empty set. → Assert a floor on
  the row count (`expect(rows.length).toBeGreaterThan(40)`), so an empty result is a
  failure rather than a pass.
- **A UI absence assertion after a wording change.** `expect(getByText('...')).not.
  toBeVisible()` keeps passing forever once that string no longer exists anywhere.
  Renaming a heading during a review fix silently converted a real check into a no-op. →
  Pair every `not.toBeVisible()` with a positive assertion of the SAME text somewhere it
  should appear, and key both to a stable substring rather than a full sentence.

- **A test that undoes its own setup** (the near relative, found 2026-08-04). A Playwright
  test opened the view-as "what this leaves out" disclosure on one tab, switched tabs, and
  clicked it again — which CLOSED it, because `<details open>` is DOM state React does not
  control and an App Router client-side navigation reconciles the element rather than
  replacing it, so `open` survives the tab switch. The failure reads as "the element is
  present but hidden", i.e. as a rendering bug, and would just as easily have gone the other
  way (a `not.toBeVisible()` passing because the test had closed the thing itself). → Make
  any toggle interaction IDEMPOTENT — read the state, act only if needed, then assert the
  state — rather than assuming a fresh render resets it.

- **A negative that needs TWO subjects needs both of them seeded (2026-08-06).** "This
  student's tab shows only their own peer-review comments" is unfalsifiable unless comments
  exist on MORE THAN ONE student's submission: with comments on a single submission, a
  surface that forgot to filter renders identically to one that filtered correctly. The
  fixture was therefore seeded CROSS-AUTHORED on purpose, and the test asserts the
  cross-authoring itself before asserting the absence. Same shape one level up: the second
  salon location was seeded with DIFFERENT row counts from the first, so a scope filter that
  silently does nothing shows as a wrong number rather than an identical one. → When the
  claim is "A is shown and B is not", seed B and assert B exists first. → And when the
  claim is about a READ RETURNING NOTHING, an error-free assertion is not enough: assert the
  table holds rows (past RLS, via a direct SQL count) and that the caller sees some. The
  `sal_locations` outage this build fixed would have passed an error-free check throughout.

- **A FIXTURE MUST NOT PRE-SATISFY ANOTHER TEST'S STARTING CONDITION (2026-08-07).** The
  vacuity rule usually bites a test; this is it biting the SEED. Peer-review rows were seeded
  onto the same homework the grading-workflow e2e drives from `submitted` to `done`. That did
  not fail the test — it made it PASS FOR THE WRONG REASON: the test clicks "Move GA-graded →
  peer review" and asserts the roster shows "Dana D: pending", which the seeded assignments
  already satisfied, so the assertion held whether or not the action worked. It surfaced two
  steps later as a missing Finalize button, because the homework had never left `ga_grading`.
  A seeded survey answer did the same to a different test, whose student arrived already
  answered and was offered "Update" where it clicked "Submit". → When a fixture needs rows in
  a table some test drives through a LIFECYCLE, give it **its own parent row** (a second,
  already-finished homework; a second, already-answered survey) rather than adding rows to the
  one under test. → And read a fixture addition as a question: *which existing assertion could
  this now satisfy on its own?*
  The same addition also produced three plain STRICT-MODE collisions — a second homework means
  two review links, a second survey means two "Show results" buttons, and by the time the full
  suite reaches the salon console an earlier test has put "Pedicure" on a bill as well as in
  the catalog. → Scope every locator to its section or its subject, never to the page, and
  remember that **an unscoped locator passes in isolation and trips only in a full run**,
  which is the worse of the two failure modes.

- **Test the BADGE at the surface, not only the declaration that feeds it (2026-08-06).** A
  declaration test proves the surface is shaped right; it cannot prove the page says so. The
  "no scope filter" badge's first implementation keyed on the resolver returning a null id
  list — but the whole-module bypass skips the node FILTER while still RETURNING every id, so
  the two cases were indistinguishable from the result and the badge never fired. The page
  rendered every location and claimed nothing: the exact failure the badge exists to prevent,
  shipped inside the fix for it, and caught only by the e2e case that opened the page and
  looked. → Any honesty signal — a badge, a caveat, a "we could not check" — needs a test
  that renders it, because its whole purpose is to be visible to a human.

The shared shape: **absence is only evidence when presence was demonstrated under the
same conditions.** Whenever a test asserts something is missing, ask what would have to be
true for it to pass on an empty universe — and then assert that the universe is not empty.

Related, and the reason this keeps mattering: a vacuous test does not merely fail to catch
a bug, it actively reports that the bug is absent. That is worse than having no test, which
**And it extends to the TALLIES YOU WRITE ABOUT YOUR OWN WORK (2026-08-07).** A count in a
docs entry — "six new bullets", "five clean runs", "33/33 probes" — is a factual claim that
the next reader will trust and act on, and it is exactly as checkable as a test assertion.
Two shipped false in one session's own write-up: "seven new bullets" where five were added,
and "five clean full runs across two sessions with no reproduction" — a tally that silently
EXCLUDED three earlier runs, one of which had reproduced the very flake, and which was then
used to recommend closing the open item. → **Before writing a number, produce it** (`grep -c`
the diff, re-read the run log). → Be most careful with tallies that span sessions: the
tempting ones are the ones that support the conclusion you already reached, and the honest
version usually needs a qualifier about what changed between them. This is the same category
as the "four FALSE factual claims in the notes" a prior review caught — self-authored prose
is not exempt from verification just because you wrote it.

**The rule extends past tests, to SEARCH (2026-08-07).** "Is this documented?" answered by a
grep that returns hits is the same error in a different costume: the hits prove the vocabulary
exists somewhere, not that the CLAIM does. Searching `rank remap` returned four confident
matches — every one about the view-as pair check, a different mechanism that proves rank
parity and pair coverage and says nothing about what a `rank >= N` tier wrapper admits. The
gap read as covered and was nearly lost. → **Read the hits, never count them**, and be most
suspicious when the matched vocabulary is adjacent to what you meant rather than identical to
it. Adjacent vocabulary is what manufactures the false positive.

is why "no silent skips" is enforced in the probe scripts (a skipped probe prints loudly
and is never counted as a pass).

**A CHECKER MUST FAIL ON WHAT IT CANNOT UNDERSTAND, NOT SKIP IT (2026-08-09, from the rank
admission map).** A check that inspects code or schema — a catalog reader, a source parser,
a coverage sweep — will eventually meet a construct it was not written for. There are only
two designs, and only one of them stays true:

- *Skip the unrecognised and carry on.* Coverage silently shrinks every time the codebase
  grows a shape the checker predates, and the green tick keeps claiming the same guarantee.
  This is the vacuity rule with a slow fuse: not one vacuous assertion, but a check that
  becomes vacuous by degrees while nobody is watching.
- *Fail, naming the construct.* Somebody spends five minutes teaching the parser, and the
  guarantee is still the guarantee.

→ Take the second. `rank-admission.test.ts` fails on a rank comparison whose shape it cannot
classify AND on a threshold whose value it cannot resolve to a literal at every call site —
"I don't know what this gate admits" is reported as a defect, never as a pass. Corollary:
**the set of things being checked should be DISCOVERED, not declared.** That file reads the
list of rank-reading functions out of `pg_proc.prosrc` and asserts it against a checked-in
tripwire list, so a ninth rule fails the build the day it lands instead of the day somebody
remembers a list exists. A hand-maintained list of what to check is only ever as current as
the last person who remembered it — which is the same failure as the thing being checked.

**AND: A COUNT OF MECHANISMS IS NOT A COUNT OF CODE (same session).** docs/13 recorded "one
rank ladder, read by FOUR rules". True as *families* — appointment, tier threshold,
last-Director, view-as — and it was eight functions, with the tier-threshold family alone
holding four separately hardcoded copies of the same `2`. A remediation scoped to the
documented four would have shipped, passed review, and left half the surface uncovered. →
When a doc summarises a mechanism by counting it, **the count is a summary, not an
inventory** — re-derive the inventory from the code before building anything that depends on
its completeness. The re-derivation here also turned up two whole rules the summary omitted,
one of which (`module_roles_guard_last_director`, the only reader of rank 4) fails OPEN.

**AND THE THIRD LESSON FROM THAT SESSION: WHEN HALF A FACT COMES FROM THE SOURCE OF TRUTH, THE
OTHER HALF IS WHERE THE NEXT GAP IS.** The rank-admission checker DISCOVERED its list of
rank-reading functions from `pg_proc.prosrc` — correctly, and that was the whole point — while
hand-DECLARING the position vocabulary it compared them against. An adversarial review caught it:
the discovered half looks so rigorous that it lends unearned credibility to the declared half
sitting beside it, and the declared half is the one that silently goes stale. → **Whenever a check
derives one input from the authority, ask what its OTHER inputs are derived from**, and derive
those too (the fix read the vocabulary out of the ladder function's own body). This is the
discover-don't-declare rule applied recursively, and it generalises past checkers to any claim
assembled from a measured part and an assumed part — the measured part is not evidence for the
assumption next to it.

*(Recorded here 2026-08-09, at the second attempt. This rule spent a session being cited as
"now in docs/03" by CLAUDE.md while never having been written to docs/03 at all — it existed only
in the pointer that claimed it lived elsewhere, and a later compression of that pointer came
within one commit of deleting it outright. Which is itself the lesson: a cross-reference is a
claim, and an unverified one is how a lesson dies.)*

**NEVER DOCUMENT A TEST YOU HAVE NOT WRITTEN — NOT EVEN ONE YOU INTEND TO WRITE IN THE SAME
SESSION (2026-08-09, from the login-capture review).** The migration for engagement monitoring
carried four comments saying "asserted in the RLS suite", written while drafting because the
tests were the next beat of the docs/03 #12 rhythm. The adversarial review grepped for them and
found nothing: at that moment, editing the retention window from `interval '90 days'` to
`interval '1 day'` would have passed CI while the file claimed otherwise. Nobody had lied and the
tests did get written an hour later — but had the session ended early, or had the reviewer trusted
the comment, a false guarantee would have shipped. This is the tally rule (above) applied to
coverage claims: a comment asserting a test exists is exactly as checkable as the test itself. →
**Write the assertion, or write the future tense** ("must be asserted by the RLS suite"). → And
when reviewing anything, treat a claim of test coverage as a claim to verify, not as
documentation — `grep` for it.

## Triggers on `auth.users` (engagement monitoring phase 1, 2026-08-09)

The platform now has two: `on_auth_user_created` (AFTER INSERT → `handle_new_user`, live since
2026-07-06) and `on_auth_user_login` (AFTER UPDATE OF `last_sign_in_at` → `capture_login`). The
mechanism is proven in the managed environment, but it carries rules that are not obvious:

- **A trigger on `auth.users` is on the critical path of signup or sign-in.** If it raises, the
  enclosing statement aborts and the AUTH OPERATION FAILS. So the question "should this swallow
  its errors?" is a criticality judgement, not a style one: `handle_new_user` deliberately does
  NOT (an account with no `profiles` row is broken, so failing signup is correct), while
  `capture_login` deliberately DOES (a missing engagement row is nothing; a platform-wide login
  outage caused by an analytics defect is unacceptable).
- **`WHEN OTHERS` DOES NOT CATCH `query_canceled` OR `assert_failure`.** This is documented
  PL/pgSQL behaviour and it falsifies the obvious claim that an exception handler makes a trigger
  unable to break its caller. A statement cancellation propagates regardless — and this project's
  cluster runs `statement_timeout = 120000` (measured on prod 2026-08-09), so it is reachable.
- **The fix is to bound the wait, not to catch the cancel.** `set lock_timeout = '50ms'` in the
  function definition is scoped to the function and restored on exit, so it constrains the trigger
  without altering the caller's transaction; a lock wait then fails as `lock_not_available`
  (55P03), which IS ordinary and IS caught. Catching `query_canceled` instead is wrong twice: it
  does not reliably help for a timeout (the deadline has passed, so the cancel re-asserts at the
  next interrupt check) and its other source is an operator's `pg_cancel_backend`, which a trigger
  must honour.
- **Swallowing errors creates a debt the UI owes.** A silent capture failure is invisible, so the
  surface reading the data must render a "newest captured row" honesty signal, with a test that
  renders it (the badge discipline from the superadmin lookup log).
- **The coupling is permanent and must be respected by future migrations:** once a trigger writes
  to a table on the sign-in path, AUTH AVAILABILITY DEPENDS ON THAT TABLE BEING WRITABLE. DDL on
  it belongs in a maintenance window or behind `concurrently` — never in a casual migration.
- **Measure GoTrue's behaviour; do not assume it.** Verified before building: a password grant
  advances `last_sign_in_at`, a refresh_token grant does not, and a `/signup` DOES produce an
  UPDATE (so first-ever logins are captured). Had that last one been false — the timestamp set in
  the same INSERT that creates the row — every user's first login would have been silently missing.

## Hard rules

1. **Never fork a platform primitive.** If the notifications/files/workflow primitive almost fits, extend it in `packages/platform` (benefiting every module) — don't copy it into the module.
2. **Every table:** `org_id`, RLS policy, module prefix. No RLS policy → PR rejected.
3. **Module code never imports from another module.** Shared needs go through `packages/platform`. (Module 6 uses the question engine, not `modules/matchmaking` internals.)
4. **Settings via the settings primitive** (typed, per-org, admin-lockable) — no ad-hoc config tables.
5. **All outbound email through the email queue**; all background work through pg-boss; no inline `setTimeout` business logic.
6. **Roles come from the manifest** and are checked server-side per route; UI hiding is convenience, not security.
7. **Seed data is mandatory** — a module without a seeded demo org can't be developed or demoed.

## Process checklist

1. **Spec** — write `SPEC.md` from the client conversation using the template below. This is the engagement artifact; everything else derives from it.
2. **Schema** — tables + RLS + migration (`supabase db diff`), reviewed against the tenancy rules.
3. **Manifest** — register key, roles, nav, settings schema; add entitlement row for the client org.
4. **Pages/routes** — per-role entry points; follow an exemplar module's structure file-for-file where possible.
5. **Jobs** — worker handlers + cron registration.
6. **Seed** — demo org, users for each role, realistic data.
7. **Tests** — critical-path e2e (each role logs in and completes their core task) + unit tests for algorithms.
8. **Verify locally** — full flow on `supabase start` + `pnpm dev` with seeded data.
9. **Deploy** — migrate + ship via CI; enable entitlement for the real org; import real data.
10. **Document** — update SPEC.md with anything that changed during build; add module to README table.

## SPEC.md template

```markdown
# Module: <name>   (key: <key>)
## Problem & client context
## Roles (and what each can do)
## Core concepts / data
## Features by role
## Algorithms / rules (exact, with examples)
## Settings (org-level, admin locks)
## Jobs (batch) & realtime needs
## Platform primitives used / extended
## Explicit decisions log (dated)
## Future enhancements (documented, not built)
## Open questions
```

## AI workflow

For a new module, a Claude Code / Copilot session should be pointed at:

1. `CLAUDE.md` (repo conventions, current state)
2. This document
3. The new module's `SPEC.md`
4. One exemplar module (after the extraction pass, `modules/synagogue-schedules` is expected to be the canonical exemplar)

Then: scaffold anatomy → schema+RLS → manifest → pages per role → jobs → seed → tests, in that order, verifying locally between steps. Human reviews schema/RLS and the algorithm code with the most care; UI iteration is cheap.

## Generalizing a module for a second client

Budget a deliberate pass (see docs/00 risks): move client-specific constants into org settings, re-check copy/labels, add the second org's seed variant, and walk both orgs through every critical path. Never resell a module that has only ever run for one org without this pass.

## Deprecating a module

Disable entitlements → export the org's data on request → mark the module deprecated in its manifest (hidden from new orgs) → remove code only after all orgs are off it and a final DB backup exists.

### Data export (founder decisions, 2026-07-09 — twice revised same day)

Every user can export their data — trust and freedom-to-leave are explicit
goals. **The export slice is defined by AUTHORSHIP, not visibility** (founder
correction): you export **what you entered into the platform** (uploads,
answers, submissions, comments — so entering data never risks losing it),
plus minimal context metadata (e.g. the class name) to keep it legible.
What someone else let you SEE is not yours to export — the canonical
illustration (founder's): a salesperson may see a client's history to do
their job, but that visibility does not make them eligible to export
client details. RLS remains the hard CEILING (fetches run AS the user, so an
export can never exceed what they can read) but is not the definition.

**Staff hats** export the data of the domain they operate (the professor's
gradebook, the manager's books) — "their data and the data of those under
them" — because operating the domain is their authorship. Visibility-only
relationships (cashier↔customer, student↔materials) confer NO export sets.

Mechanics: each module declares an export manifest (hats + named data sets);
the generic page (`/o/<slug>/export`) lets the user pick a hat they hold (a
higher role may deliberately choose a lower hat); output is one zip of
CSV+JSON per set. **Export controls:** module staff can shut off any hat or
data set for the levels below (`set_export_settings` / `module_can_manage`);
staff bypass their own switches. v1 data-only, instant download.

### User walkthroughs / in-app help (founder decision, 2026-07-09)

Every module ships **role-level walkthroughs** — numbered click-by-click guides a
user can follow to learn their level of the platform — indexed at
`/o/<slug>/help` and rendered at `/o/<slug>/help/<moduleKey>/<role>`. Guides
live as typed data in the module's folder (`modules/<key>/help/guides.ts`, one
`HelpGuide` per role, `staff: true` on staff guides — no fs reads, so it's
deployment-safe on Vercel and type-checked). Visibility: module staff see every
guide; everyone else sees the non-staff guides ("each level sees their level
and below").

**Visibility gotcha found 2026-07-11 — don't reuse `module_can_manage` for
this.** It was built for export-controls (admin-tier gating, above) and is
correctly admin-only there — but a module's "staff" guides are usually for
*operational* sub-tiers (GA, matchmaker, moderator, organizer, host) that
aren't module admins. Gating on `module_can_manage` alone 404s real non-admin
staff on their own guide, invisibly masked in every demo seed because the demo
staff member also happens to be an org admin. **Correct check** (see
`apps/web/lib/help-visibility.ts`): a staff guide is visible if
`module_can_manage` is true (top tier, unchanged) **OR** the caller's own
`module_roles` row for this module matches the guide's `role` field exactly —
confirmed 1:1 against every module's real role strings, no per-module
special-casing needed. Use this helper (not the bare RPC) for any new
staff-gated surface.

**Update rule: a UI change updates the module's walkthrough in the same commit**
— "stale docs are bugs" extended to user docs; the e2e suite mirrors the same
core flows, so a broken step usually turns CI red too. The founder tests the
platform BY following these walkthroughs and gives feedback against step
numbers. They are the script for future visual tutorials — the interactive spotlight-tour evolution is specced as an idea in docs/13-future-ideas.md. The sample module
carries a template walkthrough (composition rule).
