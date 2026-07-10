# Safeguards — protecting the platform from its future maintainers

A future session (any AI, any model, any human) can damage this platform as
easily as extend it. These safeguards make damage hard, detectable, and
recoverable. **Mechanical guards outrank advisory rules** — advisory rules
rot; pipelines don't.

## The mechanical guards (already enforced)

1. **CI gates every deploy.** Every push runs typecheck → build → RLS tests →
   the full e2e suite; the Vercel deploy job runs ONLY on green. A red build
   cannot reach production through the normal path.
2. **Destructive-migration block.** CI fails any migration containing
   `DROP TABLE` / `TRUNCATE` / `DROP SCHEMA` unless the file carries the
   marker `DESTRUCTIVE-CHANGE-APPROVED` — which may only be added after the
   founder explicitly approves that specific change.
3. **Branch protection on master.** Force-pushes and branch deletion are
   blocked at GitHub; history cannot be rewritten away.
4. **RLS is the tenancy floor.** 7 isolation tests + per-module guard-trigger
   verifications; the web app has no service-role key to leak (worker only).
5. **Prod seeding is demo-scoped.** The seed's deletes are keyed to the demo
   orgs' ids; it cannot touch a real client org's rows.

## The never-do list (for every future session)

- Never `git push --force` to master (blocked anyway) or bypass hooks/CI
  (`--no-verify`, committing around a red build).
- Never write a destructive migration without the founder's explicit,
  in-conversation approval AND the marker. Migrations are forward-only,
  additive-first (CLAUDE.md working agreements).
- Never put the service-role key anywhere but the worker (docs/03 #14).
- Never run bulk mutations against prod without a fresh backup (below).
- Never skip the docs/03 #12 rhythm for schema/RLS work: agent-draft →
  security-review → live verification, regardless of model.
- If running as a lighter model and the task drifts into migrations, RLS,
  triggers, or export/privacy rules: **say so and suggest switching to
  Opus-class before continuing** — don't push through quietly.

## Backups

- `pnpm backup:prod` dumps prod schema + data to `backups/<timestamp>/`
  (git-ignored, local disk). Run it **before any risky prod operation** and
  weekly regardless. First backup taken 2026-07-10.
- The Supabase free tier has no automated backups — this script is currently
  the only net. (Upgrading to Supabase Pro adds daily backups; revisit when
  revenue starts.)

## Recovery playbook

- **Bad code deployed:** `git revert <sha>` + push → CI redeploys the fix.
  Or redeploy the previous build from the Vercel dashboard instantly.
- **Bad data change:** restore from the newest `backups/<ts>/` — schema via
  `psql < schema.sql` into a fresh project if catastrophic, or surgically
  extract the affected rows from `data.sql`. Data-only restores may need
  `--disable-triggers` (circular FKs).
- **Lost credentials:** `.env.deploy` is the one irreplaceable local file
  (docs/09) — keep a copy in a password manager.
- **Suspected tenancy leak:** treat as an incident — verify with the RLS
  suite + a live probe as a signed-in anon client before and after any fix.

## Continuity (picking up fresh)

CLAUDE.md (state log + model-choice rule) → docs/03 (conventions) →
docs/09 (fresh-session starter) are the read-first chain. The sample module
is the copy-me template. The founder's walkthroughs (docs/11 + in-app Help)
are the acceptance tests: after any significant change, the affected
walkthrough must still be followable step-by-step — and updated in the same
commit when the UI changes.
