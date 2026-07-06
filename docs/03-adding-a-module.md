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
