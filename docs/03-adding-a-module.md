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
