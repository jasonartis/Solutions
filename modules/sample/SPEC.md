# Module 0: Sample (key: `sample`, prefix `smp_`) — the living template

Not a client module. This is the copyable starting point for every new module
(docs/03 "Composition & template" decision, 2026-07-09): a minimal
projects-and-items domain that exercises every platform convention with the
smallest possible surface, verified by its own e2e test like any real module.

## To start module 7+

1. Copy this folder to `modules/<key>/`; rename `smp_` → your prefix, `sample`
   → your key, and the roles to your module's vocabulary.
2. Adapt `schema-draft.sql` (it is annotated with the docs/03 convention number
   each block demonstrates), then follow the agent-draft → security-review →
   integrate rhythm from docs/03 for anything beyond template shape.
3. Copy the thin route wrappers in
   `apps/web/app/(app)/o/[orgSlug]/m/sample/` — module UI lives HERE in
   `ui/`; the app only mounts it.
4. Register a manifest in `packages/platform/src/modules.ts`, add a seed block,
   add an e2e test. Done — the docs/03 acceptance checklist is the definition
   of done.

## What each file demonstrates

- `schema-draft.sql` — prefixed tables, explicit grants, RLS tiers,
  `is_org_admin()` delegation (#9), scope-sync trigger (#10), pin trigger +
  alphabetical-order gotcha (#11), direct-column own-row policies (#15).
- `ui/page.tsx` — `requireOrgModule()` gate (#2), rpc role probes, role-adaptive
  rendering. The ONE allowed app-import in module UI is `@/lib/module-gate` /
  `@/lib/supabase/server` (the app's request context); everything else in the
  module folder.
- `ui/actions.ts` — server actions with `DERIVED_SCOPE_PLACEHOLDER` (#10), no
  service-role key ever (#14).

## Maintenance rule

Whenever a capability is extracted into `packages/platform`, update this module
in the same pass — the template must never rot behind the conventions.
