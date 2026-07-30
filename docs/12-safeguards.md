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
- **Never `migrate:prod` a slice whose APP commit is still unpushed.** Production
  deploys ONLY from a master push — `.github/workflows/ci.yml`'s `deploy` job
  (a prebuilt Vercel deploy, `needs: check`); the Vercel project has NO GitHub
  link, so every deployment is `src=cli` and nothing ships until CI is green.
  So an unpushed app commit means the DB lands ahead of the UI. Slice 3
  (2026-07-28) proved the cost: prod's `org_members.status` began defaulting to
  `pending` while the deployed build still had no accept UI, so every member-add
  on the live site created an invite nobody could accept. Push the app commit and
  run `migrate:prod` in the same session, and confirm
  `git log origin/master..master` is EMPTY before calling a prod push done.
- **Never push to master without running `pnpm typecheck && pnpm build` first.**
  CI's `check` job would catch a red tree — but then `deploy` is SKIPPED, so prod
  keeps serving the OLD app, which is exactly the wrong outcome when the DB has
  already moved (above). Slice 3 proved this too: commit `29c572d`'s message
  claimed "typecheck 9/9" but the committed tree actually failed `tsc` (an untyped
  `rpc('org_member_profiles')` row) — caught by a pre-push build, fixed in
  `28ddf92` before pushing.
- **Never grant `anon` a table privilege, and never assume RLS is the only gate
  that matters.** Strangers hold nothing in schema `public` but schema `USAGE`
  plus EXECUTE on the allowlisted public functions (docs/03 #17). A public
  no-login surface is a `security definer` function granted to `anon`; strangers
  never write. Note `TRUNCATE`/`REFERENCES`/`TRIGGER` are **not** RLS-gated at
  all — an ACL is the only thing standing in front of them.
- **Never trust a green local RLS suite as proof of a privilege change.** Local
  and prod have different `ALTER DEFAULT PRIVILEGES`, so prod can be wide open
  while local looks closed (the 2026-07-22 gap). Any migration touching grants
  must be verified against PROD's catalog:
  `pnpm exec tsx scripts/verify-acl-hardening.ts --probe` (asserts + exits
  non-zero; `--probe` additionally becomes `anon` and attempts real reads/writes
  inside a transaction that always rolls back), with
  `scripts/acl-audit.ts --json` before/after for the diff.
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

## Known risks & pre-launch checklist (2026-07-10 review)

Found in a deliberate "what haven't we thought of" pass; ordered by urgency.

1. **Supabase free-tier auto-pause (availability landmine).** Free projects
   PAUSE after ~7 days without activity — the production site would break
   until manually restored. Mitigations: an UptimeRobot monitor pinging
   `/s/demo-shul` every 5 min (touches the DB → counts as activity, and
   doubles as downtime alerting), or the Hetzner worker's minute heartbeat
   once deployed. **Until one exists, a quiet week can take prod down.**
2. **No monitoring at all.** Errors and downtime are invisible until a user
   complains. 10-minute founder setup when ready: UptimeRobot (free) on the
   site URL + `/healthz` of the worker; Sentry (free tier) DSN into the web
   app. Both were deferred from M0.
3. **Account 2FA.** GitHub, Vercel, and Supabase accounts are the real keys
   to everything (pipeline, secrets, database). Enable 2FA on all three —
   a compromised GitHub account defeats every safeguard in this file.
4. **Demo superadmin (FIXED 2026-07-10).** The prod seed had made
   owner@demo.local a platform superadmin guarded by the demo password —
   demoted on prod, and the seed now only grants superadmin locally.
   Rotate the demo password after each testing round (re-seed with a new
   DEMO_PASSWORD).
5. **Vercel Hobby plan prohibits commercial use.** Fine while free/testing;
   upgrade to Vercel Pro (~$20/mo) when clients pay.
6. **Privacy & terms before real users beyond Pozna.** The platform stores
   sensitive-category personal data (dating preferences in modules 1/6,
   student grades in module 2). Before onboarding real singles/students:
   a privacy policy + terms page, and a decision on data-retention wording.
   The authorship-export feature is the portability story; deletion requests
   need a documented process.
7. **Auth email sender.** Supabase's built-in sender is rate-limited and
   spam-prone; before real user onboarding, configure custom SMTP (their
   dashboard supports it) so magic links and confirmations actually arrive.
8. **Automated, tested backups before real/paying customers (founder, 2026-07-27
   — not urgent; no real users yet).** Today prod backups are MANUAL: a
   `pnpm backup:prod` dump taken by hand before each migration. That protects
   migration mistakes (recoverable), but not a bad day between deploys. Before
   real customers depend on the data:
   (a) confirm which Supabase tier prod is on and its automated-backup / PITR
       (point-in-time-recovery) policy — managed daily backups on paid plans,
       PITR on higher tiers — so there's a platform safety net under the manual
       dumps;
   (b) schedule automated daily backups (not only pre-migration ones);
   (c) TEST a restore once on a throwaway project — an untested backup is not a
       backup.
   The routine dev loop is already safe (forward-only additive migrations never
   reset/drop prod; the destructive `db:reset`/`seed` are local-only and guarded
   — see "Low-context assistant protections" below); this item upgrades
   "recoverable by discipline" to "recoverable by tested automation."

## Low-context assistant protections (2026-07-10)

Guards against well-meaning but confused sessions (any AI, any tool):

- **No standing prod link.** The repo is deliberately NOT linked to the prod
  Supabase project, so `supabase db reset --linked` cannot wipe production.
  Prod operations go through explicit scripts only: `pnpm migrate:prod`
  (apply migrations), `pnpm backup:prod` (dump), `pnpm worker:prod` (run the
  worker). Never re-link (`supabase link`) — if a session does, unlink after.
- **Migrations are append-only (CI-enforced).** Editing or deleting an
  existing file under `supabase/migrations/` fails CI — fix forward with a
  new migration.
- **Test-count ratchet (CI-enforced).** If the e2e or RLS test count drops
  below `tests-floor.json`, CI fails. Deleting or weakening a test to get a
  green build is never the fix; the founder approves any deliberate lowering.
  When ADDING tests, raise the floor in the same commit.
- **When a guard blocks you, the guard is right.** Stop, report, and ask —
  do not work around CI, markers, or protections.
- **Edit sources, not derivatives:** module UI lives in `modules/<key>/ui`
  (the `apps/web/.../m/<key>` files are one-line wrappers); assembled
  migrations come from `schema-draft.sql` + `schema-fixes.sql`; never commit
  `.env*` or anything from `backups/`.
