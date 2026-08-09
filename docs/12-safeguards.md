# Safeguards — protecting the platform from its future maintainers

A future session (any AI, any model, any human) can damage this platform as
easily as extend it. These safeguards make damage hard, detectable, and
recoverable. **Mechanical guards outrank advisory rules** — advisory rules
rot; pipelines don't.

## The mechanical guards (already enforced)

1. **CI gates every deploy.** Every push runs typecheck → build → RLS tests →
   the full e2e suite; the Vercel deploy job runs ONLY on green. A red build
   cannot reach production through the normal path.
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
   blocked at GitHub; history cannot be rewritten away.
   **UNVERIFIED SINCE 2026-08-07 — do not quote this as fact until item 10 is
   done.** The 2026-08-07 push proved the ruleset on `master` is BYPASSABLE by
   the pushing account (it bypassed the required-status-check rule outright).
   Whether the force-push and deletion rules are bypassable by that same role is
   unknown, and cannot be checked from this machine — `gh` is not installed and
   there is no GitHub token in `.env.deploy`. A safeguard doc asserting a
   protection nobody has tested is the same failure as a vacuous test.
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
   **Two tables the retention wording must explicitly cover (2026-08-09), both
   append-only by design and neither prunable by any api role:**
   `view_as_sessions` and `superadmin_lookup_log` (item 9). They record that a
   person was LOOKED AT, which is personal data about that person even though
   they cannot read it, and a deletion request has to have an answer for them.
   Note the deliberate tension to resolve rather than paper over: **an audit log
   that a deletion request can empty is not an audit log** — the FKs are
   `on delete set null` precisely so the record survives the account, which is
   the shape the answer should probably build on.
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

   **STILL OPEN, and now doubly so: what happens with a SECOND superadmin.** The
   oversight arm is a flat `is_superadmin()`, which is not the appointment rule and
   does not pretend to be — there is no rank domain among superadmins to compare
   over. With one operator it is exactly the founder's "only the superadmin can see
   them"; with two it silently means each reads 100% of the other's lookups,
   unscoped, forever. That is a founder decision, not a derivation. "A second
   superadmin" was already a named expiry condition for the unlogged design; it is
   now also the trigger for revisiting this policy.

10. **What should actually gate `master`? — OPEN, needs a comprehensive review
    (raised 2026-08-07; NOT launch-blocking, but decide it deliberately rather
    than by habit).** Every direct push prints
    `Bypassed rule violations for refs/heads/master: Required status check
    "check" is expected.` — and the balance behind that is unexamined.

    **Established facts, so a reviewer does not re-derive them:**
    (a) The wording is GitHub *rulesets*, not classic branch protection, and
    `is expected` means "no result reported for this commit yet", not "failed".
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
    (e) The real cost today is a false signal in two directions — the repo
    settings imply master is gated when the path actually used bypasses them,
    and every push prints an alarming line that is always benign. **A warning
    you always ignore has stopped being a warning**, which is the same failure
    this document's other guards exist to avoid.

    **What the review must actually answer** — the question is a BALANCE, not a
    toggle, which is why it is a review and not a one-line fix:
    - Should an AI agent hold bypass rights on `master` at all? That is the
      deeper question under the surface one, and it is a judgement about how
      this repo is worked, not about GitHub.
    - Is red-on-master acceptable given a solo founder and a `needs: check`
      deploy gate? (Recovery is one more commit; the cost is a confusing
      history and a broken starting point for the next session.)
    - Options seen so far, none yet endorsed: drop the required-check rule as
      misleading; require PRs only for the changes where red-master is expensive
      (`supabase/migrations/`) and keep direct pushes elsewhere; adopt PRs
      wholesale with a merge queue; or keep the status quo and formalise the
      pre-push local verification this session did by hand. A pre-push hook
      running the ratchet + typecheck is a fifth option nobody has costed.
    - **First concrete step regardless: find out what the ruleset really
      enforces and against whom** — including whether force-push and deletion
      (item 3) are bypassable by the same role. That needs the GitHub web UI or
      a token; neither `gh` nor a token exists on this machine.

    **This item ends in a SHIPPED PROCESS, not a memo.** Deliverables: (1) the
    facts above confirmed against the real ruleset, (2) a recommendation with
    its trade-off stated, (3) the founder's decision recorded here as a dated
    entry, and (4) the change actually made — settings, workflow, hook, or
    CONTRIBUTING note as the decision requires — plus whatever this document and
    CLAUDE.md must say afterwards.

    **BLOCKED ON ACCESS, and this is the first thing to sort out.** Both reading
    the ruleset and changing it need GitHub admin access that this machine does
    not have: `gh` is not installed and `.env.deploy` holds no GitHub token.
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
- **When a guard blocks you, the guard is right.** Stop, report, and ask —
  do not work around CI, markers, or protections.
- **Edit sources, not derivatives:** module UI lives in `modules/<key>/ui`
  (the `apps/web/.../m/<key>` files are one-line wrappers); assembled
  migrations come from `schema-draft.sql` + `schema-fixes.sql`; never commit
  `.env*` or anything from `backups/`.
