# Safeguards — protecting the platform from its future maintainers

A future session (any AI, any model, any human) can damage this platform as
easily as extend it. These safeguards make damage hard, detectable, and
recoverable. **Mechanical guards outrank advisory rules** — advisory rules
rot; pipelines don't.

## The mechanical guards (already enforced)

1. **CI gates every deploy.** Every push runs typecheck → build → RLS tests →
   the full e2e suite; the Vercel deploy job runs ONLY on green. A red build
   cannot reach production through the normal path.
   **INCOMPLETE, FOUND 2026-09-04 — read `.github/workflows/ci.yml` yourself
   before trusting this line.** "RLS tests" names `pnpm --filter @platform/db
   test` specifically. There is NO step running `pnpm test` / `turbo run
   test` / any per-module `pnpm --filter @modules/<key> test` — so every
   module's OWN vitest suite (`modules/speed-dating/src/rotation.test.ts` and
   its siblings across every module) has **never once been run by CI**, only
   ever manually by whoever built it. Found as a side effect of adding 21 new
   speed-dating unit tests this session and noticing CI's green run never
   mentioned them. **Not fixed here, deliberately**: adding a new required CI
   step is a shared-pipeline change (this session's own instructions list
   "modifying CI/CD pipelines" as something to confirm before doing, and a
   concurrent session was actively pushing at the time this was found — an
   untested new step could break CI for reasons having nothing to do with
   either session's actual work). Flagged for the founder to decide: add a
   `pnpm test` (or `turbo run test`) step to `ci.yml`, verifying it passes
   clean across every module first.
   **The mechanism is `needs: check` inside the workflow, NOT a branch rule** —
   worth stating precisely, because the two get conflated. If `check` fails,
   `deploy` never runs, so no production deployment is created; that is a
   job-graph fact, independent of GitHub's branch rules and of anyone's bypass
   rights. It is what makes the standing inference "a `READY` production deploy
   proves CI was green" true. What it does NOT do is stop a red commit from
   LANDING on master — see item 10 below.
2. **Destructive-migration block.** CI fails any migration containing
   `DROP TABLE` / `TRUNCATE` / `DROP SCHEMA` unless the file carries the
   marker `DESTRUCTIVE-CHANGE-APPROVED` — which may only be added after the
   founder explicitly approves that specific change.
3. **Branch protection on master.** Force-pushes and branch deletion are
   configured as blocked at GitHub; history cannot be rewritten away **by a
   non-admin**.
   **VERIFIED 2026-08-28 (item 10 investigation) — confirms and RESOLVES the
   2026-08-07 "unverified" flag, in the direction the flag feared.** Read via
   the GitHub REST API using Git Credential Manager's cached OAuth token (the
   same technique CLAUDE.md documents for reading Action logs —
   `printf 'protocol=https\nhost=github.com\n' | git credential fill`), no `gh`
   or dedicated PAT needed. `GET /repos/.../branches/master/protection` shows
   `allow_force_pushes.enabled: false`, `allow_deletions.enabled: false` —
   AND `enforce_admins.enabled: false`. Classic branch protection ties every
   configured rule to that ONE exemption flag: since it's off, an account with
   admin on the repo is exempt from ALL of them, not just the required status
   check that was already known to bypass. So yes — the same account that
   bypasses the status check can also force-push and delete the branch; it is
   one hole, not two. See item 10 for the full picture (which API is actually
   in play, who holds admin, and what pushes through Claude Code authenticate
   as).
4. **RLS is the tenancy floor.** 7 isolation tests + per-module guard-trigger
   verifications; the web app has no service-role key to leak (worker only).
5. **Prod seeding is demo-scoped.** The seed's deletes are keyed to the demo
   orgs' ids; it cannot touch a real client org's rows. **The one exception,
   found and fixed 2026-08-07:** the invite-accept status flip
   (`org_members.update({status:'active'}).neq('status','active')`) was
   UNSCOPED — global across every org, not demo-scoped — so a real client's
   pending invite would have been silently force-accepted by any remote
   reseed. Checked against a pre-reseed backup and found harmless BY LUCK
   (every row on prod already happened to be `'active'`), not by design. Now
   `.in('org_id', demoOrgIds)` like every delete already was.

## The never-do list (for every future session)

- Never `git push --force` to master (blocked anyway) or bypass hooks/CI
  (`--no-verify`, committing around a red build).
- Never write a destructive migration without the founder's explicit,
  in-conversation approval AND the marker. Migrations are forward-only,
  additive-first (CLAUDE.md working agreements).
- Never put the service-role key anywhere but the worker (docs/03 #14).
- Never run bulk mutations against prod without a fresh backup (below).
- **Never `git rm` a handoff/working note until its OPEN ITEMS have been diffed
  into the repo** — not just its task list ticked off. Grep the file for
  `STILL`/`OPEN`/`NOT`/`left`/`gap`/`empty`/`deliberately`/`follow-on` and check
  each against the docs. Deleting one is a state migration, not a cleanup; the
  2026-08-07 session nearly lost two real findings this way (CLAUDE.md session
  hygiene has the full lesson and the two traps that hid them).
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
- The Supabase free tier has no automated backups — confirmed live 2026-09-01
  via the scratch project's own General settings page (no PITR/automated-
  backup option shown, only manual "Restart"/"Pause"/"Delete" and a Pro-only
  custom-domains upsell — consistent with free tier having none).
- **AUTOMATED since 2026-09-01/02** (go-live checklist item 2):
  `.github/workflows/backup.yml` runs the same `pnpm backup:prod` script
  nightly (09:00 UTC) via GitHub Actions and uploads the dump as a repo
  artifact (90-day retention) — durable off Supabase, off Vercel, and off
  the dev PC, using two new repo secrets (`PROD_SUPABASE_PROJECT_REF`,
  `PROD_SUPABASE_DB_PASSWORD`) rather than a new account. **Verified
  end-to-end, not just written**: a manual `workflow_dispatch` run produced
  a real 304KB artifact from the actual prod database. Bounded retention
  (not a permanent archive) is a known tradeoff — Backblaze B2 stays the
  earmarked upgrade (docs/14) for unbounded off-site retention once that's
  worth a new account.
- **RESTORE REHEARSED AND PROVEN, 2026-09-01/02** — the deliverable item 2
  actually asked for, not just the dump script. Restored the tested backup
  artifact's `schema.sql` + `data.sql` into a real throwaway Supabase
  project (founder-created, `us-east-2`, deleted after). Both files applied
  cleanly (`data.sql` loaded inside a transaction with
  `session_replication_role = replica` set, so triggers/FK checks didn't
  fire mid-load — the standard technique, stronger than pg_restore's
  `--disable-triggers` since it's role-scoped rather than per-table).
  **Verified with real row counts, not `pg_stat_user_tables.n_live_tup`** —
  that statistics column read 0 on every table checked immediately after
  the load, because autovacuum/ANALYZE hadn't run yet; trusting it would
  have been the exact vacuous-test trap this doc already warns about
  elsewhere. A direct `select count(*)` against `orgs`/`org_members`/
  `profiles`/etc. showed real numbers matching the platform's known state
  (**profiles: 12** — the exact account count CLAUDE.md's own history
  cites repeatedly). Restore capability is proven working, not assumed.

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

0. **Branch protection is configured but NOT blocking (observed 2026-08-03).**
   Every push to `master` reports
   `remote: Bypassed rule violations for refs/heads/master: - Required status
   check "check" is expected.` — GitHub wants CI green before the push lands, and
   lets it through anyway because the pusher can bypass. So the rule is currently
   advisory, not a gate. **This has not caused a problem and may be exactly what
   the founder wants** (a one-person team pushing straight to `master`, with the
   real gate being that Vercel's `deploy` job has `needs: check`, so a broken
   commit deploys nothing and prod keeps serving the previous build). Recorded
   because the failure mode is non-obvious: the protection LOOKS enforced in the
   GitHub UI, so a future session — or a second contributor who cannot bypass —
   could reasonably assume a green `master` is guaranteed. Decide deliberately:
   either enforce it (uncheck "allow bypass" / include administrators) or drop the
   rule so it stops implying a guarantee it does not give.

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
2a. **VERCEL SILENTLY BLOCKED EVERY DEPLOYMENT FROM 2026-09-01 17:35 THROUGH 2026-09-02
   11:49 — found and fixed 2026-09-02.** Cause: the git commit author email
   (`jasonartisenergy@gmail.com`, this machine's global git config) didn't match the Vercel
   team owner's registered email (`jasonartisenergy1@gmail.com`, one character different) —
   Vercel enforces this match even for CLI/token-based deploys (`vercel deploy --prebuilt`),
   not just its own git-integration auto-deploys, because the CLI still attaches git commit
   metadata that the same protection checks against. **Every affected deployment showed
   `state: BLOCKED` in Vercel's own API — not `ERROR`, not `CANCELED` with a clear reason — the
   GitHub Actions job just reported `conclusion: cancelled` with no explanation printed
   anywhere in the CI log.** Confirmed via `GET /v6/deployments` directly, since neither GitHub's
   UI nor the workflow log said why. **Real impact was nil**: every blocked commit in that
   window touched only docs/infra (backup.yml, docs updates), never `apps/web` — so production
   kept correctly serving the last successful deploy the whole time, just not the newest one.
   Fix: `git config --global user.email` changed to match Vercel's registered owner email
   (the smaller, local, instantly-reversible side to fix — not Vercel's account email, which
   would touch login/billing). **Any future push whose commit author doesn't match a Vercel
   team member's email will silently block the same way — check `GET /v6/deployments`'s `state`
   field if a deploy job ever shows `cancelled` with no visible reason.**
3. **Account 2FA.** GitHub, Vercel, and Supabase accounts are the real keys
   to everything (pipeline, secrets, database). Enable 2FA on all three —
   a compromised GitHub account defeats every safeguard in this file.
   **RAISED 2026-09-03, DELIBERATELY DEFERRED (founder's call) — REVISIT WHEN
   THE FIRST REAL CLIENT IS SIGNED, not before.** That's the trigger, same
   shape as other "not worth building ahead of a real need" deferrals in this
   doc set. Confirmed
   along the way: Supabase's dashboard MFA is authenticator-app-only (no
   email option — intentional, email 2FA is the weakest form since a
   compromised email often also unlocks password-reset flows everywhere
   else); GitHub's is currently unconfigured (plain password only). Vercel
   has a team-level "2FA Enforcement" toggle rather than a personal 2FA
   setting of its own (this account signs into Vercel via GitHub SSO) —
   **flagged but NOT tested: enabling it warns that CI/CD tokens belonging
   to users without 2FA stop working**, which would hit the exact
   `VERCEL_TOKEN` this platform's deploy pipeline depends on. If this is
   revisited, enable GitHub's 2FA FIRST, then test a real deploy immediately
   after flipping Vercel's enforcement toggle — don't trust it silently,
   the same lesson as the 2026-09-02 deploy-block incident above.
   **REPO VISIBILITY: PUBLIC, DELIBERATELY, AS OF 2026-09-02 — a cost
   decision, not a security lapse. Read this before ever flipping it private
   again.** Full sequence: found drifted PUBLIC 2026-09-01 (contradicting
   docs/14's "private" claim); verified clean before doing anything — searched
   the FULL git history (not just the current tree) for committed secrets,
   found none (`.env`/`.env.deploy`/`.env.accounts` were never committed at
   any point, only their `.example` templates; no service-role key/GitHub
   PAT/Vercel token/DB password pattern anywhere in any commit) — so the
   original exposure was source/schema/policy visibility only, never a live
   credential leak. Flipped to private (founder-approved) same day. **Then,
   2026-09-02, CI started failing instantly with zero steps run** — GitHub's
   own annotation: *"recent account payments have failed or your spending
   limit needs to be increased."* Checked the real billing page together:
   **$13.45 already charged** for Actions minutes beyond the included
   2,000/month — private repos meter Actions minutes, public repos don't.
   This was NOT primarily caused by that one session's testing (measured:
   only ~35 real minutes run since the private flip) — it's cumulative usage
   across the project's history, most likely from whatever earlier stretch
   the repo was genuinely private before drifting public. **Founder decision:
   revert to public for now** (stops further Actions charges immediately;
   does not undo the $13.45 already billed) **and revisit going private only
   after CI-usage discipline is actually designed**, not before. Flipped back
   to public via the GitHub API same day, confirmed.

   **OPEN, NOT YET DESIGNED — do this BEFORE the next attempt to go private:**
   a concrete plan to keep Actions minutes cheap on a metered private repo.
   Candidates worth evaluating when that session happens, none decided yet:
   - **`paths-ignore` on push triggers for pure docs/markdown changes** —
     today, a docs-only commit still runs the FULL ~15-20 minute suite
     (build + db tests + full e2e), identically to an app-code change. A
     large fraction of this platform's commits are docs-only (journal
     entries, checklist updates); skipping the full suite for those alone
     would likely be the single biggest saving.
   - **Diagnose before re-running.** The 2026-09-02 Vercel git-author
     investigation burned several full pipeline re-runs before reading the
     actual error message via the API — reading first, re-running only once
     confident, would have cost a fraction of the minutes for the same
     answer.
   - **A non-zero but small spending limit** (e.g. $5–10) instead of the
     account default of $0 — turns a hard, confusing instant block into a
     graceful warning with headroom, without writing a blank check.
   - **Batch small doc-only commits** rather than pushing each one
     individually, if that fits how a session is already working — fewer
     pushes, fewer full-suite triggers.
   No monitoring exists for the repo drifting visibility again either way —
   worth a periodic manual check (`GET /repos/jasonartis/Solutions` →
   `"private"`) until real monitoring of account/repo settings exists.
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
   **Two tables the retention wording must explicitly cover (2026-08-09), both
   append-only by design and neither prunable by any api role:**
   `view_as_sessions` and `superadmin_lookup_log` (item 9). They record that a
   person was LOOKED AT, which is personal data about that person even though
   they cannot read it, and a deletion request has to have an answer for them.
   Note the deliberate tension to resolve rather than paper over: **an audit log
   that a deletion request can empty is not an audit log** — the FKs are
   `on delete set null` precisely so the record survives the account, which is
   the shape the answer should probably build on.
   **A THIRD IS NOW LIVE AND ITS WORDING IS AN OUTSTANDING OBLIGATION, NOT A
   FUTURE ONE: engagement monitoring phase 1 SHIPPED 2026-08-09**
   ([docs/17](17-engagement-monitoring.md), `20260809010000_login_events.sql`,
   prod-verified). Founder decision, recorded there: no user-facing notice — one
   line under "what we collect", *"authentication events (when you sign in)"*.
   That is proportionate because Supabase already stores `last_sign_in_at` today,
   so the new thing is RETENTION and cross-org aggregation, not a new category of
   data.
   **READ THIS BEFORE ANY REAL USER SIGNS IN.** The previous version of this item
   said that wording was "a PRECONDITION of shipping it, not a follow-up".
   **Phase 1 shipped anyway, and this records that honestly rather than quietly
   relaxing the rule.** The practical exposure today is nil — prod holds 12
   accounts, all demo or the founder's own, of which 7 have never signed in, and
   there is no privacy policy page yet at all (that page is this very item). But
   *(**CORRECTED 2026-09-04: the page now EXISTS** — `apps/web/app/privacy/page.tsx`,
   shipped as go-live item 3 in commit `6033ae9` and linked from the footer. The
   clause above was true when written and is not any more. The obligation is
   therefore no longer "there is nowhere to put the wording" but **"the page is
   live and does not yet carry these lines"** — a concrete edit, not a build.
   **A THIRD owed line joins the two below the moment ad-hoc visual-messaging
   groups ship:** their pending-invite table stores the email of a person who has
   NO account — no export, no data-browser presence, no deletion route, since
   every one of those keys on a user. See docs/modules/module-4-visual-messaging.md's
   "TWO PRIVACY OBLIGATIONS THIS CREATES" section.)*  But
   the obligation has changed status: it is no longer "write it before you build
   the feature", it is **"the feature is collecting now, so the wording is owed
   before the first real customer account exists."** Do not let the pre-launch
   framing of this checklist hide that one of its items is already accruing.
   **Phase 2 moves the line again:** logging what a person opened and when, per
   org, is materially more than a login timestamp, and that wording must exist
   BEFORE it ships.
   **PHASE 2 SHIPPED TO PRODUCTION 2026-08-21 WITHOUT THAT WORDING — recorded
   honestly, same as phase 1 above, not quietly relaxed.** `20260810010000_activity_events.sql`
   is applied and ~48 `recordActivity()` call sites across all 6 modules are live; capture is
   proven working with one real recorded event. **The obligation is now doubly outstanding**: both
   phase 1's login-timestamp line AND phase 2's per-org-activity line are owed, and there is still
   no privacy policy page of any kind to put either on. Exposure today remains nil for the same
   reason as phase 1 — the one real captured phase-2 event is a demo account
   (`dana@demo.local`), and prod otherwise holds only the 12 demo/founder accounts already
   described above. **This is the single most concrete "must happen before a real customer"
   item on the whole platform now** — not because it is hard (it is one page and two sentences),
   but because two live features have shipped ahead of it and a third module would make it three.
   Founder's call whether to close it now or keep deferring; not something to start unprompted.
   Unlike the two logs above, the engagement log IS prunable by design (90 days
   raw + a permanent rollup) — a deliberate divergence, see docs/17 §6. **The
   exception turned out NOT to need `SECURITY DEFINER`** (as this item previously
   predicted it would): `public.login_events_prune()` is `security invoker`, takes
   no arguments, and holds EXECUTE for **nobody** — only the table owner, which is
   the role the worker already connects as. So it can never exceed its caller, and
   a future careless `grant execute … to service_role` still fails at the
   privilege layer because that role holds no DELETE. That is a smaller exception
   than this checklist anticipated, and it has had its adversarial review.
   **Raised again 2026-08-10 and explicitly DEFERRED, not forgotten:** offered as a candidate
   quick win (draft a minimal real page now, or just record the wording), the founder chose to
   skip it for this session. Still open, same exposure as stated above (nil today).
6a. **PRODUCTION POSTGRES TIMEOUTS — measured read-only 2026-08-09, recorded
   because they bound every query the app makes and are invisible locally.** The
   local stack sets none of these, so a query that is merely slow here can FAIL
   on prod:
   - `authenticated`: `statement_timeout = 8s` (per-role, all databases)
   - `anon`: `statement_timeout = 3s`
   - `authenticator`: `statement_timeout = 8s`, `lock_timeout = 8s`
   - `supabase_auth_admin`: no statement/lock timeout of its own, but
     `idle_in_transaction_session_timeout = 60000` and `search_path = auth`
   - cluster default (configuration file): `statement_timeout = 120000`,
     `lock_timeout = 0`, `idle_in_transaction_session_timeout = 0`
   Two consequences already load-bearing: GoTrue's sign-in statement runs under
   the 120-second cluster default, which is why the capture trigger in
   `20260809010000` carries its own `set lock_timeout = '50ms'`
   (PL/pgSQL's `WHEN OTHERS` cannot catch a `query_canceled`, so an unbounded
   lock wait there could have failed the sign-in itself — docs/03's
   "Triggers on `auth.users`"); and an 8-second ceiling on `authenticated` means
   any expensive console/report query must be judged against that, not against
   local behaviour. Re-derive with
   `select * from pg_db_role_setting` joined to `pg_roles`/`pg_database`, plus
   `pg_settings` for the cluster defaults.
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

9. ~~**Superadmin lookup log — MUST exist before the first paying customer**~~
   **DONE 2026-08-07/08** — migration `20260807010000_superadmin_lookup_log.sql`,
   built with the full docs/03 #12 rhythm (draft → three-lens adversarial review →
   findings applied → 11 RLS tests → live round-trip verification → docs). Both
   Owner Console tools now write one row per real lookup; the failure to write is
   badged on screen rather than swallowed. Detail → docs/15's 2026-08-07/08 entry.
   **The structural point that made this urgent is now satisfied and cannot be
   re-satisfied later: the log covers everything from this date forward.**

   **What it does NOT do, deliberately, so nobody assumes otherwise:**
   - **No module-rank read arm.** The appointment rule, applied honestly to rows
     whose actor is always a platform superadmin, admits nobody — a superadmin is
     OUTSIDE every module ladder, not at the top of one. Writing the arm anyway
     would INVERT the hierarchy, because `module_position_rank` returns 0 for
     unmapped pairs and never null, so every rank-1 holder would outrank the
     operator. See docs/03's "unranked ≠ rank 0" rule.
   - **No org-admin arm** (unlike `view_as_sessions`), because a tenant read would
     republish operator activity into every tenant's audit view — the exact
     objection the separate table exists to dissolve.
   - **No subject arm.** Reading BY TARGET is §8.1 point 6's still-open
     notify-the-target question. One table, two features; the second is not built.

   **ALSO OPEN, and created BY this build rather than inherited: THE LOG HAS NO
   RETENTION POLICY, and by design nothing can prune it.** Append-only is
   enforced at the grant layer — no role holds DELETE — so the table can only
   ever grow, and trimming it would take a deliberate migration or a
   `postgres`-level job. That is the right default for an audit log and it is
   not urgent operationally (one operator, a handful of rows per session), but
   two things follow that should be decided rather than drifted into:
   - **It is PERSONAL DATA about the subject** — "a superadmin looked at this
     person, on this date" — so it belongs in item 6's data-retention wording
     below, and it is disclosable in a subject-access request (which is exactly
     why the data browser surfaces it rather than omitting it).
   - **Widening either CHECK later gets more expensive as it grows** — see
     docs/03's `not valid` + `validate constraint` rule, which exists because a
     full-table validation scan on a never-pruned log is free today and an
     outage after years of history.

   **FOUNDER DECISION, 2026-08-10: each superadmin should read their own lookups
   and those of superadmins "lower" than them** — the founder's words: "consistent
   with the way we handle similar items," i.e. the same appointment-rule/hierarchy
   shape used everywhere else on the platform (reads flow down a ladder, never up;
   docs/15 §"the founder's visibility principle").

   **NOT IMPLEMENTED, and deliberately so — this is a decision recorded ahead of
   need, not a build.** There is exactly one superadmin today, so there is nothing
   to rank and no second reader this policy would affect yet (extract-don't-
   speculate, docs/00). It is also missing the one thing the decision itself
   presupposes: **superadmins have no ordering today.** `is_superadmin` is a flat
   boolean on `profiles` — no rank column, no appointment-chain, no seniority
   field. So "lower than them" has no referent yet, and the concrete policy cannot
   be written from this decision alone. **Before this can become a migration, a
   second, narrower decision is needed: what determines "lower"** — candidates are
   appointment order (whoever granted `is_superadmin` outranks whoever they
   granted it to, mirroring the appointment rule exactly), an explicit rank/seniority
   column, or something else. Surface that question again the day a second
   superadmin is actually being appointed, since it's unanswerable in the abstract
   and cheap to answer with a real second operator in front of you.
   "A second superadmin" remains the trigger for revisiting this policy — now to
   implement the decision above, not to make it.

10. **What should actually gate `master`? — investigation DONE 2026-08-28, the
    decision itself still OPEN (raised 2026-08-07; NOT launch-blocking, but
    decide it deliberately rather than by habit).** Every direct push prints
    `Bypassed rule violations for refs/heads/master: Required status check
    "check" is expected.` — and the balance behind that is now fully examined,
    not just theorized about.

    **CORRECTED FACT (2026-08-28): this is CLASSIC branch protection, NOT
    GitHub's newer Rulesets feature** — the previous version of this item had
    that backwards. Confirmed two ways: `GET /repos/.../rulesets` returns an
    empty array (no rulesets exist on this repo at all), while
    `GET /repos/.../branches/master/protection` (the classic API) returns the
    full configured rule. This matters for the options below, not just as
    trivia: classic protection has one blunt `enforce_admins` on/off switch
    covering every rule at once, where rulesets support scoped bypass lists
    (e.g. "this app bypasses, this team doesn't") and path-filtered rules
    (e.g. "require a PR only under `supabase/migrations/`"). **The
    `supabase/migrations/`-only-PRs option below is not available under the
    current classic-protection setup — it would require migrating to a
    ruleset first.**

    **Access is no longer blocked.** Read via the GitHub REST API using Git
    Credential Manager's cached OAuth token — the same credential that lets
    `git push` work without prompting, extracted with
    `printf 'protocol=https\nhost=github.com\n' | git credential fill`. No
    `gh` install and no dedicated PAT needed for reading. (Only reads were
    performed; whether that same token can WRITE a settings change, e.g. via
    `PATCH .../branches/master/protection`, is untested.)

    **Established facts, confirmed against the real config, not re-derived:**
    (a) `required_status_checks`: one check named `check` (GitHub Actions app
    id 15368), `strict: false` (does not require the branch to be up to date).
    `is expected` in the push message means "no result reported for this
    commit yet", not "failed".
    (b) **A required status check can NEVER be satisfied by a direct push,
    structurally.** The `check` job is triggered BY the push (`on: push:
    branches: [master]`), so at rule-evaluation time the commit has zero status
    results and the rule is violated by construction. Required checks are a
    PULL-REQUEST mechanism. So this is not drift — the rule is doing the only
    thing it can do in a push-to-master workflow.
    (c) **Production is not at risk either way:** `deploy` has `needs: check`
    (item 1 above). The exposure is that a RED COMMIT CAN LAND ON MASTER — it
    just never deploys.
    (d) The rule is not inert everywhere: it would genuinely block merging a PR.
    Only the direct-push path can do nothing with it.
    (e) **No PR review requirement is configured at all** (no
    `required_pull_request_reviews` key in the response) — so today, even a PR
    could be merged with zero review. Worth knowing before costing the "adopt
    PRs" options: PRs alone add no review gate unless one is added at the same
    time.
    (f) **`enforce_admins.enabled: false` is the single mechanism behind every
    bypass** — confirmed in item 3 above, it is not separate from the
    status-check bypass, it is the SAME flag exempting an admin from
    everything configured on this branch (status check, force-push block,
    deletion block alike).
    (g) **There is exactly one collaborator on the repo: `jasonartis`
    (the founder), with `admin` role.** No second human account, no bot
    account, no service account exists today.
    (h) **Claude Code pushes authenticate as that same founder credential** —
    Git Credential Manager's cached OAuth token, the founder's own GitHub
    login. There is no separate "AI agent" identity on GitHub with its own,
    possibly narrower, permissions; a push made through Claude Code and a push
    typed by hand bypass the same rules for the same reason, because they are
    the same account. Narrowing what Claude Code can bypass, without
    narrowing the founder's own pushes too, is not possible with today's
    single shared credential.
    (i) The real cost today is a false signal in two directions — the repo
    settings imply master is gated when the path actually used bypasses them,
    and every push prints an alarming line that is always benign. **A warning
    you always ignore has stopped being a warning**, which is the same failure
    this document's other guards exist to avoid.

    **What the review must actually answer** — the question is a BALANCE, not a
    toggle, which is why it is a review and not a one-line fix:
    - Should an AI agent hold bypass rights on `master` at all? Per fact (h)
      above, this is really "should pushes made through Claude Code bypass CI
      the same way my own manual pushes do" — there is no separate credential
      to answer differently for, unless one is created (e.g. a scoped PAT
      issued to Claude Code specifically, held by a non-admin account).
    - Is red-on-master acceptable given a solo founder (fact (g): literally no
      one else could be blocked by a stricter rule today) and a `needs: check`
      deploy gate? (Recovery is one more commit; the cost is a confusing
      history and a broken starting point for the next session.)
    - Options, now costed against the corrected facts above: **drop** the
      required-check rule as misleading (cheapest, changes nothing about risk,
      just stops the false signal); **turn `enforce_admins` on** (blocks EVERY
      direct push, including the founder's own, until CI has run — forces a
      PR-based workflow for literally everything, a real workflow change for a
      one-person repo); **migrate to a Ruleset** to get path-scoped PRs
      (`supabase/migrations/` only) with everything else still direct-pushable
      — the only option that gets selective gating, but is new surface area to
      configure and verify; **adopt PRs wholesale**, which per fact (e) needs
      an explicit review requirement added too or it gates nothing meaningful;
      or **keep the status quo and formalize the pre-push local verification**
      sessions already do by hand as an actual pre-push git hook (ratchet +
      typecheck), costing nothing in GitHub config.

    **This item ends in a SHIPPED PROCESS, not a memo.** Deliverables: (1) the
    facts above confirmed against the real ruleset — DONE 2026-08-28, (2) a
    recommendation with its trade-off stated, (3) the founder's decision
    recorded here as a dated entry, and (4) the change actually made —
    settings, workflow, hook, or CONTRIBUTING note as the decision requires —
    plus whatever this document and CLAUDE.md must say afterwards. Steps 2-4
    still need the founder.
    Either provision a PAT with repo-admin scope into `.env.deploy` (same
    pattern as `VERCEL_TOKEN`, and note it widens what a session can do to the
    repo — that trade-off is itself part of this item's question), or the
    founder makes the change in the web UI from the recommendation. Do not start
    this one expecting to finish it from the terminal alone.

    **Model:** Opus tier — cross-cutting process/infra design touching the one
    inference every session relies on ("READY proves CI was green"). Not Fable:
    no novel RLS/trigger mechanism is involved. The mechanical follow-through
    once the decision is made (workflow edit, hook, docs) is Sonnet work.

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
  **Both counters are ANCHORED, and the RLS one only became so on 2026-08-04
  (founder-approved).** It had been a bare `grep -c "it("`, which matched every
  line containing that substring — including every `.limit(` call, of which the
  suite has dozens — so it was never a test count: the day it was found, the real
  count was 90 and the ratchet measured 105. That is worse than no counter,
  because deleting real tests could be masked by unrelated `.limit()` churn while
  a pure refactor removing `.limit()` calls could fail CI having deleted nothing.
  It is now `grep -cE "^[[:space:]]+it\(" packages/db/src/rls.test.ts`, the floor
  is the EXACT count (no slack is needed once the metric is precise), and both
  halves count only real test declarations. If a legitimate reorganisation ever
  lowers the count — folding several `it()` into one `it.each`, say — that is a
  deliberate lowering and needs founder approval like any other.
  **A COUNT IS THE WRONG METRIC FOR SOME CHECKS, so 2026-08-09 added a second
  half (founder-approved): `tests-floor.json.requiredFiles`.** The two counters
  watch two files. The schema-coverage checks —
  `packages/db/src/data-browser-coverage.test.ts` and
  `packages/db/src/rank-admission.test.ts` — are ONE `it()` each, because their
  work is a sweep rather than a list of cases. A floor of 1 on those would be
  theatre; deleting either file outright tripped nothing at all. CI now fails if
  any listed path is missing **or merely UNTRACKED**, and the untracked half is
  the load-bearing one: `docs/rank-admission-map.md` is a vitest file snapshot,
  and vitest WRITES a missing snapshot rather than failing (outside `CI=true`),
  so an uncommitted map passes locally while defending nothing. Removing an entry
  from `requiredFiles` is a founder decision, exactly like lowering a floor.
- **When a guard blocks you, the guard is right.** Stop, report, and ask —
  do not work around CI, markers, or protections.
- **Edit sources, not derivatives:** module UI lives in `modules/<key>/ui`
  (the `apps/web/.../m/<key>` files are one-line wrappers); assembled
  migrations come from `schema-draft.sql` + `schema-fixes.sql`; never commit
  `.env*` or anything from `backups/`.
