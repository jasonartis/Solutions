# Platform journal — archived current-state entries

The running, dated build journal that used to live in `CLAUDE.md`'s "## Current state"
section. Moved here 2026-07-27 to keep `CLAUDE.md` (which auto-loads into every session)
lean. Newest first. Durable *decisions/conventions* live in their own docs (docs/15
decision log, docs/03 conventions, docs/12 safeguards) — this is the chronological record.

- **2026-09-01/02 (GO-LIVE CHECKLIST ITEM 2 — AUTOMATED, TESTED BACKUPS + A PUBLIC-REPO CATCH.
  Sonnet. Commits `3851074`, `00c6f9c`, docs-only follow-ups.)**
  - **`.github/workflows/backup.yml` shipped**: reuses `pnpm backup:prod` unchanged, runs it
    nightly (09:00 UTC) plus on manual dispatch, uploads the dump as a 90-day-retention GitHub
    Actions artifact. Two new repo secrets (`PROD_SUPABASE_PROJECT_REF`,
    `PROD_SUPABASE_DB_PASSWORD`) rather than a new account — founder chose this over Backblaze
    B2 after seeing the actual tradeoff stated as a scenario (bounded retention, zero new
    accounts vs. unbounded retention, one new signup). **Verified with a real manual run**, not
    just a green YAML lint: a genuine 304KB artifact from live prod data, confirmed present via
    the API before trusting the schedule.
  - **The rehearsal — the actual deliverable the checklist item was written around — is done
    too**, and it was a real rehearsal, not a dry run: the founder created a live throwaway
    Supabase project (`us-east-2`), found its connection details through a materially
    reorganized dashboard UI (several rounds of "which button/tab" back-and-forth — worth
    remembering that this dashboard has moved since training data, same family as the Next-16
    warning), and the just-tested backup artifact's `schema.sql`+`data.sql` were restored into
    it for real. Both files applied cleanly; `data.sql` was loaded inside a transaction with
    `session_replication_role = replica` set first (the standard technique for skipping
    trigger/FK-check firing during a bulk load — stronger than pg_restore's
    `--disable-triggers` since it's role-scoped, not per-table).
  - **A real vacuous-test trap, caught rather than walked into.** The first verification
    attempt read `pg_stat_user_tables.n_live_tup`, which showed 0 on every table right after
    the load — that column is autovacuum/ANALYZE-maintained statistics, not a live count, and
    trusting it would have reported "restore looks empty" for a restore that actually worked.
    Switched to direct `select count(*)` on real tables (`orgs`, `org_members`, `profiles`,
    etc.) and got real numbers — **profiles: 12**, matching this platform's own account count
    exactly. Scratch project deleted after. Full writeup: docs/12's "Backups" section.
  - **A genuine, unrelated finding surfaced mid-session and fixed immediately, not filed for
    later: the GitHub repo had drifted PUBLIC.** `GET /repos/jasonartis/Solutions` returned
    `"private": false` — contradicting docs/14 and the platform's whole security posture.
    Before touching anything, searched the FULL git history (not just the current tree, since a
    public repo exposes every past commit too) for committed secrets: `.env`/`.env.deploy`/
    `.env.accounts` were never committed at any point, and no service-role key/GitHub PAT/
    Vercel token/DB password pattern appears in any commit. Exposure was source/schema/RLS-
    policy visibility only, not a live credential leak — no rotation needed. Flipped back to
    private via the GitHub API, founder-approved, confirmed. Cause not investigated (fixing it
    was more urgent than explaining it); no monitoring exists to catch this drifting again.
  - **`pnpm backup:envs` added on a founder request that arrived mid-session**, unrelated to
    the checklist item itself: a way to snapshot every real local `.env*` file (6 found across
    the repo) into a timestamped same-drive folder, for protection against an accidental
    edit/delete of the working copy. Explicitly NOT a substitute for the password-manager
    guidance docs/12 already gives `.env.deploy`/`.env.accounts` specifically — same-drive
    doesn't survive a dead disk. Tested for real (6/6 files copied, content diffed identical)
    before calling it done.
  - **One clean decision-by-scenario worth keeping as a model**: rather than asking "GitHub
    Actions or Backblaze B2?" as a bare label choice, both options were framed with the actual
    consequence ("expires after ~90 days, zero new accounts" vs. "never expires, one new
    signup") — the founder's own long-stated preference (CLAUDE.md's "ask choices as
    scenarios"), and it produced a fast, confident answer instead of a round-trip.

- **2026-08-31/09-01 (GO-LIVE CHECKLIST ITEM 1 — MONITORING + KEEP-ALIVE. Sonnet. Commit
  `267dd4a`.)**
  - **`/healthz` shipped** (`apps/web/app/healthz/route.ts`): the open question — "which query
    can `anon` legitimately make, given the 2026-07-28 sweep left it holding no table grants in
    `public`?" — was answered by measurement, not guesswork. A subagent traced
    `apps/web/app/s/[orgSlug]` and found it calls exactly two `anon`-executable security-definer
    RPCs (`syn_public_weeks`/`syn_public_week`, the only two functions the sweep re-granted).
    `/healthz` reuses `syn_public_weeks` against `demo-shul` — the permanently-seeded synagogue
    org whose current week the seed script already keeps published "so the public page shows
    it," i.e. already-living infrastructure, not a new fixture. Hardened once past the obvious
    case: `supabase.rpc()` returns `{data: null, error: null}` for an org slug that doesn't
    resolve — not an error — so a missing `demo-shul` would have silently reported `ok:true`
    from a check that had stopped proving anything; fixed to treat null data as unhealthy too.
    Explicitly uncacheable (`dynamic = 'force-dynamic'` + `Cache-Control: no-store`), on top of
    Route Handlers already not being cached by default in this Next version.
  - **Sentry wired, guarded on `NEXT_PUBLIC_SENTRY_DSN`** (`apps/web/instrumentation.ts` +
    `instrumentation-client.ts` + `app/global-error.tsx`, current Next-16 file-convention
    approach — no `sentry.*.config.ts`, no `withSentryConfig` wrapper, since source-map upload
    needs an org/project that doesn't exist until the founder creates the account). Inert with
    no DSN: no init, nothing sent.
  - **A real, reusable exFAT-drive finding.** Adding `@sentry/nextjs` broke `next build` LOCALLY
    with `TurbopackInternalError: failed to create junction point`, naming
    `require-in-the-middle`/`import-in-the-middle`. Root cause, confirmed by reading Next's own
    bundled docs (this Next version has real breaking changes from training-data Next, per
    `apps/web/AGENTS.md`'s own warning): both packages sit on Next's `serverExternalPackages`
    default list — packages Next externalizes rather than bundles, which means physically
    linking them into `.next/node_modules` — and exFAT cannot create that link, the identical
    reason `workspace:*` was already banned (docs/01). It reproduced even with ONLY the
    client-side instrumentation file present, because `next build` still resolves the package's
    Node entry points during SSR — dropping server-side usage would not have avoided it. **Never
    verified locally as broken and left at that**: opened a real (if throwaway) PR to trigger
    GitHub Actions' `check` job on Ubuntu, zero deploy risk since `deploy` only runs on a
    `master` push — `pnpm build` passed clean there, twice (once per commit), proving this is a
    Windows-only local-build artifact, not a real defect, before it ever touched master. Any
    future dependency on that same externals list (`pg`, `sharp`, `playwright`, `bcrypt`, …)
    will hit the identical wall; verify the same way rather than assuming the dependency itself
    is broken. Rule + the full externals list pointer → CLAUDE.md's exFAT bullet and docs/18
    item 1.
  - **A stale-docs near-miss, corrected by the founder rather than assumed.** `.env.accounts`'s
    still-blank `UPTIMEROBOT_LOGIN_EMAIL`/`PASSWORD` (with the original "FILL IN" TODO comment
    intact) looked like solid evidence the account was never created — consistent with three
    other docs (docs/04, docs/12, docs/18) all saying monitoring didn't exist yet. It was wrong:
    the founder had a real UptimeRobot weekly-report email and a live dashboard entry, monitor
    on `https://solutions-platform.vercel.app/s/pozne`, 100% uptime the prior week. Independently
    corroborated with a direct `curl` (`HTTP 200`) before trusting it. The credentials were just
    never copied back into the local template after being created straight on uptimerobot.com —
    absence of a RECORD is not absence of the THING. docs/14 already had this right and very
    nearly got "corrected" into being wrong; reverted, and the other three docs' stale "no
    monitoring exists" framing is what actually needed the fix (docs/18 item 1, CLAUDE.md).
  - **Verified via CI in the exact sequence that matters**, not just typecheck: `check` job
    green on Ubuntu (build + `pnpm --filter @platform/db test` + full e2e) on both commits
    pushed to the verification PR, merged to master only after both were green, `deploy` ran for
    real on the master push. Founder action still open: create the free Sentry account, paste
    the DSN into Vercel as `NEXT_PUBLIC_SENTRY_DSN`. UptimeRobot needed nothing — see above.

- **2026-08-29 (THE WORKER'S SILENT JOBS + THE GO-LIVE CHECKLIST. Opus. Commits `e98d1d3`,
  `29c7d23`, + this one. Same session as the 2026-08-28 entry below; split out because the
  worker finding stands on its own.)**
  - **The item read "low-priority verification: the pre-existing jobs were never exercised
    after the ACL sweep… watch the next real job run." The assumption was right and the METHOD
    was impossible.** `service_role`'s reads all still work — 14/14 via the new
    **`scripts/verify-worker-jobs.mts`**, which drives the rescore tick for real (marks a pair
    stale, runs it, asserts the flag clears — "6 pairs recomputed" on the verifying run) rather
    than asserting the absence of a throw. But **three of the four jobs SWALLOWED their entry
    query's error**: `const { data } = await admin.from(t).select(...)` discards `error`, then
    the code branches on `(data ?? []).length`. A denied read became "nothing to do", so **a
    broken job and an idle job printed the identical empty log** while `/healthz` kept
    reporting a fresh heartbeat. No amount of watching could ever have told them apart.
  - **Two cases were worse than silent.** The speed-dating orchestrator read `sd_rounds` into
    `?? []`, and its next branch reads empty as *"a fresh event with no rounds yet"* — so a
    transient error on an event that already had rounds sent it to BUILD ROUND 1, bounded only
    by the single-active-round guard trigger, i.e. by luck. And it built its personal-block
    list the same way, where an empty list is indistinguishable from *"nobody blocked
    anybody"* — **a failed `sd_blocks` read would have put two people who explicitly blocked
    each other into a video room together**, breaking module 6's "never pair me with them
    again" safety promise. `classroom-retention.ts` had always checked its error and was the
    in-repo precedent the fix copied, which is why the fix invented nothing.
  - **Rule → docs/03's vacuity section: `?? []` on an unchecked query result manufactures a
    confident empty answer out of an error** — the same false-claim family as docs/15 finding
    6, one layer down, but in production code rather than a test. With the corollary that is
    the real lesson here: **before planning to verify something by watching a log, confirm the
    failure mode actually prints.** A component whose success case is silence cannot be
    verified by observing silence.
  - **[docs/18-go-live-checklist.md](../18-go-live-checklist.md) written** in answer to the
    founder's question "what would it take to take on a real client and build them a module?"
    — read it there rather than duplicated here. The founder chose that path for the next
    session, starting at its item 1 (monitoring).
  - **docs/04 was found stale and given an end state.** A survey (subagent, hand-verified on
    its load-bearing claims) established the platform is ~85–90% complete against current
    scope, with go-live at ~5–8 sessions and everything currently scoped at ~25–40. The build
    plan's own last date was **2026-07-16** and it carried no milestone for the six weeks
    since, so it read as a plan that had been completed. It now carries a "Where we actually
    are" section with those numbers, the exclusions (modules 7/8, the generalization pass), the
    two external clocks (Supabase's 2026-10-30 auto-expose removal; Vercel Hobby's commercial
    ban), and **three doc contradictions the survey turned up** — classroom's "no known gaps"
    vs its spec's open professor-scoping item; docs/15 §11 slice 2 unmarked while CLAUDE.md
    calls slice 4 the only unbuilt one (both are half-right: 3 of 6 modules are rank-mapped);
    and the privacy line being called a shipping *precondition* in two places it was shipped
    without.

- **2026-08-28 (VIEW-AS HONESTY + COVERAGE — four items closed in one session, NO MIGRATIONS.
  Sonnet for 1–3, Opus for 4 after the founder switched tiers mid-session. Commits `9e03e60`,
  `a37bf76`, `d5a8769`, `f3bcaa6`, + this one.)** Everything here is about the same underlying
  worry — a view-as surface that makes a CLAIM it has not earned — approached from four sides.
  - **1. The surface-coverage ratchet** (`packages/db/src/view-as-coverage.test.ts`).
    `viewAsCompleteness()` only ever checked a declaration's INTERNAL consistency; nothing
    compared it to the DATABASE, and nothing looked inside `embed`. So a future `sal_tips`
    migration would have left every salon surface silently incomplete with CI green. The new
    test enumerates each module's real tables from `pg_catalog` by the prefix its own
    declaration uses (no hand-maintained prefix map to drift) and fails on anything unaccounted
    for. Baseline-and-ratchet per CLAUDE.md's own recommendation, with `KNOWN_GAPS` freezing
    what was already broken. **Proved it had teeth before trusting it:** removed an accepted
    entry (failed, naming the table), added an already-satisfied one (failed the other
    direction — the staleness check), restored, reran clean.
  - **2. Classroom's re-classification**, which emptied that baseline the same day (GA was
    missing 7/16 `cls_` tables, Student 3/16). Each gap answered by reading the REAL page that
    queries the table, not inferred from RLS — and that grounding is what produced the findings
    worth keeping: `cls_courses` is read-but-never-rendered by a GA (a pure staff-detection
    probe, so `excluded`); `cls_exams.structure` is a `{label,points}[]` the grading console
    uses to size its form, not an answer key; **a GA has RLS access to `cls_submission_files`
    that the real grading page never uses** — a genuine product gap this review found, not a
    security exclusion; and the existing GA `cls_grades` entry was separately missing a `detail`
    column the exam console reads.
  - **3. Speed-dating's 3 staff-to-staff pairs** (admin→organizer, admin→host, organizer→host),
    the last slice-5 follow-on. Drafted by a background subagent, then **independently
    fact-checked line by line before integrating** — every cited policy and column re-read from
    the current migrations, which matters because the base migration's `sd_interest`/`sd_matches`
    policies were later rewritten by `20260726030000`. The pair the review existed for
    (organizer→host) needed **no new mechanism**: the renderer only queries the TARGET's
    declared surface, and host's surface simply omits both tables. **One judgment call was
    overridden rather than accepted:** the agent classified organizer's genuine RLS access to
    `sd_interest`/`sd_matches` as `role`; changed to `excluded`, because the live console only
    ever shows an aggregate count, and rendering the raw grid would make the view-as tab MORE
    revealing than the real console — the falsely-INFORMATIVE mirror of docs/03 #18's usual
    failure. Flagged for the founder in both the code and CLAUDE.md.
  - **4. Finding 6 — the per-table `blinded` gap (Opus).** `blinded` answered "your own RLS may
    have emptied this" ONCE, for the module's `scopeEntity`, and could never answer it for an
    ordinary role table — so a dropped `is_org_admin` arm rendered as a confident "Nothing
    here", a false claim rather than a leak. **The constraint that shapes the whole fix:** an
    empty read and a policy-denied read are byte-identical over PostgREST (zero rows, null
    error), and the keystone forbids the renderer a second authority to compare against — so
    the only signal available is to ask the SAME client the same question with every declared
    narrowing dropped. That is `tableReachable()`, setting `emptyReason` to `narrowed` or
    `unverified`. **Measured before writing the copy, and the measurement changed it:** the
    superadmin reads ≥1 row of all 28 declared surface tables in every console-reachable
    org × module, and the only in-module holder who trips the badge is grace, the seed's one
    scoped salon manager, on 5 tables — because Uptown legitimately has no appointments. So the
    normal trigger is **a narrow grant, not a bug**, and the wording names all three readings
    instead of crying failure. **The docs prevented a self-inflicted CI break here:** the
    obvious e2e fixture was grace, and CLAUDE.md's own gotcha records that signing her in breaks
    the phase-3 engagement test deterministically. So e2e asserts the badge does NOT over-fire
    (the regression that would actually matter — a badge on every empty section is the warning
    nobody reads), and the PREMISE is proven in the db suite inside the block that already signs
    her in and already cleans up. **The positive block's own rendering is left untested and said
    so plainly**, since finding 5's lesson is that an honesty signal needs a test that renders it.
  - **One real regression caught, and only by e2e.** Item 2's new `cls_surveys` caveat mentions
    `cls_survey_answers` in prose, which tripped Playwright strict mode in an unrelated test
    whose page-wide `getByText` then matched two elements. **That test's own comment records it
    had already been bitten once by the same looseness** — passing for the wrong reason back
    then, failing outright now. Fixed by making the assertion say what it means (scoped to the
    leaves-out panel, exact match on the `font-mono` table-name span) rather than by rewording
    the prose. Lesson worth its line: **items 1–3 were verified with typecheck + the db suite
    only; the break existed for three commits and just wasn't run into.** Final verification was
    done in CI's exact order — db 141/141 → e2e 51/51 on the same database with no reset between.
  - Also this session, **not** a build item: **docs/12 item 10's investigation** (`a37bf76`).
    Read master's protection live via the GitHub API using Git Credential Manager's cached OAuth
    token — no `gh`, no PAT. **Corrected a standing assumption:** it is CLASSIC branch
    protection, not Rulesets (`/rulesets` is empty), which is why path-scoped rules ("PRs only
    for `supabase/migrations/`") are not available without migrating first. Confirmed the whole
    bypass is ONE flag, `enforce_admins: false`, which resolves guard 3's "UNVERIFIED" —
    force-push and deletion bypass the same way the status check does, one hole not two. And:
    exactly one collaborator exists (the founder, admin), and Claude Code's pushes authenticate
    as that same credential, so "should an AI hold bypass rights" is concretely "should Claude
    Code's pushes bypass CI the same way mine do." The decision stays the founder's.

- **2026-08-16 → 08-21 (ENGAGEMENT MONITORING PHASE 2 — FULLY SHIPPED: instrumentation, RLS
  tests, prod deploy, prod-verified with a real captured event. Commits `d653d4d`, `f121539`,
  `8107548`, `acf6e3c`, `d92459f`.
  Sonnet throughout, one confirmed-Fable subagent pass on phase 1. Full spec: docs/17.)**
  Finished the three tasks left after 2026-08-11's schema-only session: 48 `recordActivity()`
  call sites across all 6 modules (parallel Sonnet subagents, one per module, each independently
  adversarially reviewed — zero findings); the RLS test port of
  `scripts/verify-activity-capture.mts` into `rls.test.ts` plus the one fixture the probe script
  couldn't cover (an org member with no `module_roles` row, proving `actor_grants` comes back a
  real empty array); and `scripts/prod-verify-activity-events.mts`, extending the phase-1
  template for phase 2's real INSERT path.
  - **A confirmed-Fable re-review of phase 1's migration also ran** (closing the item open since
    2026-08-09 — this time via the Agent tool's own `model: "fable"` parameter, a stronger
    provenance claim than the first pass's self-reported subagent). Verdict: SHIP AS-IS. One
    concrete fix: a `select current_user` check confirming the worker's pooler connection really
    authenticates as `postgres` — previously a single one-time manual measurement — is now
    permanent in both prod-verify scripts.
  - **Two Docker Desktop host issues hit and fixed** (both now gotchas in CLAUDE.md): Docker
    coming back up in Windows Containers mode after the founder's reboot (`DockerCli.exe
    -SwitchDaemon` + full restart), and a crashed `com.docker.backend` ballooning to 13GB+ and
    starving every relaunch attempt until killed explicitly.
  - **THE REAL FINDING: CI failed on the first push (`d653d4d`), and it was not a flake.**
    `.github/workflows/ci.yml` runs `pnpm --filter @platform/db test` immediately before
    `pnpm test:e2e` on the SAME database with no reset in between. The new phase-2 RLS block
    signs in as `grace@demo.local` (the seed's only scoped nail-salon manager grant, needed to
    prove a SCOPED `{role, scope_ref}` pair survives the write path) — but the phase-3 engagement
    e2e test depends on grace never having signed in anywhere in this shared database. Two local
    reproductions in a different step order passed clean, which is exactly what made this look
    like environment-specific flakiness before the CI log (fetched via the GitHub API using Git
    Credential Manager's cached OAuth token, since no PAT was configured and job-log downloads
    need repo-admin scope) proved it was 100% deterministic in CI's actual order. **Fixed at the
    root in `f121539`**: the phase-2 block's own `afterAll` now deletes grace's
    `login_events`/`login_rollup` rows via a raw owner-level connection (both tables are read-only
    to every api role including the superadmin, so the ordinary RLS client can't do it) — verified
    by reproducing CI's literal sequence locally post-fix.
  - **The migration itself had never actually been applied to production** — "schema built,
    verified and pushed" (CLAUDE.md, since 2026-08-11) meant pushed to GitHub, not to the live
    Supabase project; `pnpm migrate:prod --dry-run` confirmed it was the only migration missing.
    Applied for real (`pnpm migrate:prod`) once the app commit was pushed and deployed, per
    docs/12's own documented order. Structural prod-verify: 77/78 (the one expected failure being
    "no real activity yet" — by design).
  - **A false lead worth recording as a gotcha, not just a war story**: proving live capture on
    prod with a real `INSERT` via `curl` initially failed with a generic RLS 42501 — reproduced
    even locally, which correctly redirected suspicion away from "prod is broken" toward "the
    request is different from what the app sends." The cause: `Prefer: return=representation`
    makes PostgREST try to `SELECT` the row back after inserting, and `activity_events` has no
    self-read policy by design (superadmin-only, no `user_id = auth.uid()` arm) — the real
    `recordActivity()` helper never chains `.select()` and was never at risk. Dropping the header
    made the same insert succeed instantly, on both prod and local.
  - **Verification, all real runs**: `turbo run typecheck --force` 9/9, `turbo run build --force`
    2/2, `pnpm --filter @platform/db test` 139/139 (confirmed three times across resets),
    `scripts/verify-activity-capture.mts` 53/53, `CI=true pnpm test:e2e` 51/51 (clean, after the
    grace fix — confirmed via GitHub's own CI run, not just locally), prod-verify 78/78 with one
    real captured event (dana@demo.local, `walk_in.added`, Demo Salon).
  - **Three small follow-up commits closed out the session's own continuity gaps, found by
    auditing this session specifically rather than the platform generally**: `8107548` (docs
    closure — CLAUDE.md/docs/17 status updates now that phase 2 is live); `acf6e3c` (the
    phase-2 privacy-policy line docs/17 §9 required BEFORE shipping — shipped without it, same
    as phase 1 did on 2026-08-09, recorded honestly rather than quietly relaxed; plus the
    GitHub-log-fetching-without-`gh` technique that found the CI root cause; plus the
    `RETURNING`-clause generalisation of the `Prefer: return=representation` false lead);
    `d92459f` (the CI test-count ratchet's `rls` floor was never bumped for this session's 18 new
    tests — 116 stayed on the books while the real count reached 134, silently widening how many
    tests could be deleted before the ratchet noticed; fixed to the exact anchored count, and the
    already-drifted `e2e` floor tightened 49 → 51 while touching the same file).


- **2026-08-11 (ENGAGEMENT MONITORING PHASE 2 — THE SCHEMA, RECOVERED FROM A LOST SESSION, THEN
  HARDENED AND VERIFIED. Migration `20260810010000_activity_events.sql`. Opus, with a Fable
  subagent for the review. Commits `2f1a0ea`, `42cc497`, `2ff596d`, `9367bad`, `a5bfb7d`. Full
  decisions log: docs/17, 2026-08-11.)** The session opened with the founder saying he had lost a
  chat mid-build and asking whether the repo could be picked up from. It could: a 745-line
  migration and a 369-line vocabulary/helper were sitting UNTRACKED in the working tree. The first
  act was committing them unverified, because a stray `git reset` or Docker restart would have
  destroyed reasoning nothing else recorded.
  - **THE DEFINING FINDING: the migration claimed "Founder-approved 2026-08-10, seven decisions,
    all recorded in that file's decisions log" and docs/17 had no such entry.** The commit
    immediately before it recorded the two discussions that produced NO decision, while the seven
    that did went unwritten. Decisions 1–3 plus "superadmin-only reads" were reconstructed from the
    file headers; **5, 6 and 7 are permanently lost and are recorded as lost rather than guessed**,
    because inferring them from code a single unreviewed session wrote would turn a draft into a
    decision by default. **The durable rule, now in docs/17: a decision recorded only inside the
    artifact it produced is not recorded** — a comment can carry the *reasoning*, but it cannot be
    the *register* of which decisions exist, since nothing enumerates it and nothing notices an
    absence.
  - **Four founder decisions closed the gaps.** ONE ENGAGEMENT BUCKET — settled by measurement, not
    preference: **rank cannot express staff-vs-member at all.** A GA is rank 1, identical to a
    student; a moderator rank 0, identical to a member; a matchmaker rank 0, identical to a single;
    synagogue-schedules' *maker*, its only writer, is rank 0 like a viewer. Rank answers "who may
    manage whose seat", and three of six modules were never rank-mapped. Deferred at zero cost
    because `actor_grants` stamps real position names, so any future definition applies backwards.
    `fileReport` STAYS EXCLUDED on the founder's own generalisation argument (safety reporting has
    no parallel in the other five modules, and a per-module privacy exception would force every
    future module to re-derive whether it has one) — the staff side, `reviewReport`, IS recorded.
    `setBranchFrozen` INCLUDED, having been in *neither* list. The console is an EXPANDABLE TREE,
    recollected and marked as recollected.
  - **Three defects fixed. (1) The `lock_timeout` was on the function that does not contend** — it
    sat on the BEFORE-INSERT guard while `activity_rollup_apply()`, holding the contending upsert,
    had none. A function-level SET is restored when *that* function exits; phase 1 says so
    explicitly and survived only because `capture_login()` was ONE function doing both jobs.
    **The transplant failure mode: a property structural in the original becomes conditional in the
    copy, and the comment travels intact while the guarantee does not.** **(2)** "Easy to subtract
    an action" was half-delivered — fixed by keying `activity_rollup` on `(user, org, module,
    ACTION)`, so retiring an action is a read-time re-sum over all history rather than a permanent
    total that cannot be unpicked. **(3)** The never-pruned rollup was an **unbounded amplification
    surface**: any member could mint unlimited permanent rows by POSTing fresh random `action`
    values straight to PostgREST, and the file's claim that the TypeScript union bounded row count
    was false for exactly the caller the table defends against. Bounded now by CHECKs on *shape*,
    not membership, so adding an action still needs no migration.
  - **A review finding was REJECTED, with the reasoning recorded** — Fable proposed an
    `org_modules` entitlement check; `org_modules` gates no RLS anywhere on this platform, so a
    guard stricter than the modules themselves would silently refuse activity for actions that
    genuinely succeeded, and by founder decision 3 that refusal is swallowed. **Invisible missing
    data is the one outcome this feature exists to prevent.**
  - **A hazard introduced and caught in-session:** `scripts/verify-activity-capture.mts` deletes
    from `activity_rollup` to stay re-runnable, against whatever `DATABASE_URL` names — and this
    repo has a real remote-database workflow. That table is permanent and cannot be backfilled, and
    the damage would have been invisible because every assertion after the wipe still passes
    against an empty table. Now loopback-only, failing closed. Found in round 3 of the founder's
    continuity audit, which is the argument for running one.
  - **Verification: 53/53 live as real users through PostgREST** (including settling the one thing
    the review could reason about but not test — a PostgREST upsert cannot target the partial
    dedupe index, `42P10`), **db 121/121 run directly, typecheck 9/9, build clean, e2e 51/51.**
  - **Ships CAPTURE-ONLY: no call sites, no console reader.** Capture cannot be backfilled, so
    every day without it is signal lost; a reader can be built any time. Next session is explicitly
    Sonnet-tier.
  - **Four new host gotchas, all costing real time in one session** (→ CLAUDE.md): Docker Desktop
    returning in **Windows-containers mode** (mimics total loss of images and volumes; loses
    nothing), **`pnpm` missing from PATH** while corepack works, **Playwright's browser binary
    missing** as a third cause of the 51/51 symptom, and **a hanging `git push` being a credential
    GUI dialog on the founder's desktop**. Three are the same shape — this machine lost per-user
    tool state mid-session, which may be what killed the original chat.

- **2026-08-09 (ENGAGEMENT MONITORING PHASE 3 — THE CONSOLE PAGE, BUILT. No migration. Sonnet
  build. Spec + full decisions log: docs/17.)** `/console/engagement` — the founder's outreach
  tool: who has gone quiet, and who to reach out to. A platform-wide "quietest members" landing
  panel plus the two directions §1 asked for (org→people, person→orgs), all reading phase 1's two
  tables through the caller's ordinary RLS client.
  - **The honesty badge reads `login_rollup`, not `login_events`.** The raw table is only a 90-day
    window and would read empty on a quiet-but-healthy platform for a reason having nothing to do
    with capture health; the rollup is permanent and can only advance when the capture trigger
    actually succeeds, so a stuck value there is the honest "capture may have stopped" signal —
    the most this schema can say without `auth` access. Rendered with a test that asserts a real,
    non-vacuous timestamp.
  - **grace@demo.local turned out to be exactly the right existing fixture for "never signed in."**
    An active Demo Salon member the whole e2e suite never signs in as, by nobody's design but
    useful anyway — every other demo account gets signed in somewhere in the 51-test suite. Used,
    read-only, to prove absence-of-rollup-row renders as "never signed in" rather than an error.
  - **Schema friction reported back, as docs/17 §8b item 12 asked of phase 3 as its first reader:**
    the deliberate absence of `org_id` on `login_events`/`login_rollup` really does force
    multi-round-trip client-side joining through `org_members` for the platform-wide "quietest"
    view — real, not hypothetical, though not costly at this platform's current scale. The single
    `last_login_at` index served every query actually written (a one-row badge lookup; small
    bounded per-org/platform listings sorted client-side). Full argument in docs/17's decisions log.
  - **First test-writing attempt failed on a real bug, not a flake:** `getByRole('button', { name:
    'Show' })` matched two buttons (the org and person pickers share a label) — fixed by scoping
    each locator to its own `<section>` before interacting, a small but generalizable lesson for
    any page with more than one same-labelled form.
  - **`apps/web/lib/engagement.ts` was already on master before this build session started** — a
    prior session's `git add -A` accidentally committed it while landing an unrelated CLAUDE.md
    fix. Confirmed byte-identical to this session's independently-written version; nothing to
    reconcile. New CLAUDE.md gotcha from the same incident: never `git add -A` in this repo.
  - **Verification: typecheck 9/9, db 121/121 (real run), full e2e 50/51 — the one failure is the
    pre-existing, documented speed-dating resume-review timeout flake, unrelated to this diff and
    reproduced identically against a byte-for-byte fresh `db:reset` + `pnpm seed`.**
- **2026-08-09 (ENGAGEMENT MONITORING PHASE 1 — LOGIN CAPTURE, BUILT AND SHIPPED.
  `20260809010000_login_events.sql`, a trigger on `auth.users`. Opus build; adversarial review on
  a user-directed Fable subagent. Spec + every decision: docs/17.)** The platform can now answer
  "who has gone quiet" for people. Two tables (`login_events` raw/90-day, `login_rollup`
  permanent), one trigger, one owner-only pruner, one pg-boss job. No UI — that is phase 3.
  - **THE NUMBER THAT JUSTIFIED SHIPPING CAPTURE BEFORE ANY UI: of 12 prod users, 5 have ever
    signed in and 7 NEVER have.** Measured read-only pre-deploy. The outreach list existed on day
    one, which is what the founder wanted this for — and a log started later can never cover the
    period before it existed, so waiting for the UI would have cost real history.
  - **The founder's own question reshaped phase 4.** He asked whether higher-ups would later see
    logins of those below them. Mechanically yes (additive policy arm, no data migration) — but it
    would answer the wrong question, because **a login has no org**: telling frank "dana signed in
    Tuesday" reports platform activity that may belong entirely to a different client's org.
    **Recorded recommendation, founder agreed: raw logins stay superadmin-only permanently, and
    hierarchy-governed engagement is built on phase 2's org-scoped activity**, which carries
    `org_id`. Prevents a plausible future session from bolting a rank arm onto the wrong table.
  - **THE SPEC'S `profiles` MIRROR WAS DROPPED, and finding out why took a live catalog read
    rather than an argument.** The spec wanted `last_sign_in_at` mirrored onto `profiles` so the
    console could read it under ordinary RLS. But `profiles_select_shared_org` admits every member
    of every org you belong to, and **RLS filters rows, never columns** — column grants are
    per-ROLE, so hiding it from a colleague hides it from the superadmin too. Proven by signing in
    as charlie (salon customer, rank 0) and reading 8 profile rows including frank's (salon admin,
    rank 3). The founder's reaction — *"there should never be any visibility to someone lower of
    someone higher"* — is the right instinct and revealed that **`profiles` has been flat since
    2026-07-08 by design** (a professor's roster was rendering UUIDs). Names and emails are static
    facts a customer already knows; a string of login times is a behaviour trail (working hours,
    holidays, whether someone quietly stopped showing up). Two items parked to the open list:
    whether the profiles policy should itself be hierarchy-narrowed, and that **anything put in
    `profiles.settings` is org-mate-readable** (today: one console checkbox).
  - **The prune exception came out far smaller than the spec feared.** docs/17 flagged it for the
    top model specifically because it is the only thing on the platform that can delete from a log.
    The answer was that it needs no elevated privilege at all: the only caller is the worker, which
    already connects as the table owner, so it is **`security invoker`, parameterless, EXECUTE
    granted to nobody**. `invoker` buys a second lock free — a future careless
    `grant execute … to service_role` still fails at 42501, because that role holds no DELETE.
    A `prune(older_than interval)` would have been the natural shape and the whole vulnerability.
  - **THE REVIEW'S ONE REAL DEFECT, and it was a good one: `WHEN OTHERS` does not catch
    `query_canceled`.** So the migration's absolute claim that the trigger "can never break
    sign-in" was false — a statement cancellation aborts GoTrue's own UPDATE. Prod's cluster
    `statement_timeout = 120000` (measured) made it reachable rather than theoretical. Fixed with
    `set lock_timeout = '50ms'` on the function: function-scoped, restored on exit, converts an
    unbounded lock wait into a catchable `lock_not_available`. **`when query_canceled` was
    deliberately not added** — it does not reliably help for a timeout and its other source is an
    operator's deliberate cancel, which a trigger must honour. **The review's stated failure
    scenario was wrong and is recorded as wrong** (a range `delete` and an `insert` both take ROW
    EXCLUSIVE, which does not self-conflict); the real exposure is DDL on the table.
  - **The more embarrassing finding: four comments claimed test coverage that did not exist yet.**
    "Asserted in the RLS suite" ×3 plus the worker job, written mid-draft because tests were the
    next beat — but at that moment editing `interval '90 days'` to `'1 day'` would have passed CI.
    Now 12 tests (floor 104 → 116), each mapped to the claim it makes true. **Generalised into
    docs/03: write the assertion or write the future tense; never document a test you have not
    written, even one you mean to write in the same session.**
  - **A PROCESS FAILURE OF MINE THAT THE REVIEW EXPOSED SIDEWAYS, and the most reusable thing
    here: `turbo run test` printed `>>> FULL TURBO` — all five tasks cached replays — after a
    migration changed the schema, and I read it as a real pass.** Turbo's cache key cannot include
    database state, so a cached test result after a migration proves nothing. It surfaced only
    because the reviewer mentioned the local tables were empty when 11 seeded users should have
    produced rows. The real run was green too, so nothing was hidden — but the "109/109" I reported
    had not been measured. Now a CLAUDE.md gotcha. Same family as the tally rule: **before writing
    a number, produce it.**
  - **Also verified empirically before writing a line of SQL**, because the design rests on it: a
    password grant advances `last_sign_in_at`; a refresh_token grant does NOT (so the count means
    sign-ins, not sessions); and a brand-new `/signup` DOES fire the trigger — which would have
    been a silent hole, since if GoTrue set the timestamp in the creating INSERT then every user's
    first-ever login would be missing and a new active user could read as "never signed in".
  - **`on delete cascade`, diverging from both existing logs.** They use `set null` so an oversight
    log outlives what it describes; here a row with a null `user_id` is unattributable and
    worthless, and account erasure should take it. Also lets `user_id` be `not null` and makes the
    CHECK constraints FK-action-safe (cascade deletes rather than performing the real UPDATE that
    `set null` performs — the trap that governs `superadmin_lookup_log`). Answers docs/17 §11's
    open question about the counters by construction: yes, erasure takes them.
  - **The rollup is maintained by the capture trigger, not the pruner** (the spec's wording implied
    the latter). Write-time means the permanent summary is correct even if the pruner never runs,
    and the pruner can then only destroy detail already counted. Also why there is no stored
    "logins in last 30 days": the pruner only ever sees rows ≥90 days old, so such a column would
    be permanently zero.
  - **PROVENANCE, at the founder's explicit request:** Fable is not available as a session model,
    so the review ran as a user-directed Fable SUBAGENT, and a subagent's tier cannot be verified
    from inside the session. Recorded as **claimed-Fable, unverified**; a confirmed-Fable re-review
    is on the open list. Nothing rests on it — both findings that mattered were independently
    checked against documented Postgres behaviour and the live catalog.
  - **Verification: typecheck 9/9, build clean, db 121/121 (real run, not cached), e2e 49/49
    exit 0 CI-STRICT, prod pre-flight 11/11, PROD-VERIFY 51/51 — including the control that
    matters most, CAPTURE PROVEN LIVE ON PROD** (signed in as a demo user against production and
    watched a row appear; the whole document exists because a table can look right locally and be
    permanently empty there). Prod ACL survived prod's default privileges: `anon` and
    `service_role` hold NOTHING on both tables. CI green on `4ed2958` (production READY, and
    `deploy` has `needs: check`). Local capture healthy under load (99 events across a full suite
    run). **The worker's prune WRAPPER was exercised separately, because the RLS suite tests the
    FUNCTION and not its only caller** — run against local with two 120-day rows planted, it
    connected as the owner over `DATABASE_URL`, deleted exactly 2, logged correctly and returned a
    real `number` (the driver hands back `bigint` as a string, so that conversion was worth
    proving). So retention works end-to-end; only the prod worker DEPLOYMENT is outstanding.
  - **The pre-flight script was DELETED after its findings were recorded here and in docs/17, and
    that is deliberate rather than untidy** — every assertion in it described a PRE-deploy state
    ("the capture trigger is not present yet", "the tables do not exist yet"), so keeping it would
    have left a script in `scripts/` that fails by design forever, which is its own trap for the
    next session. The permanent checker is `scripts/prod-verify-login-events.mts`. If a future
    migration wants the same pre-flight idea, the reusable queries are `pg_db_role_setting` +
    `pg_settings` for timeouts, `pg_default_acl` for what the revokes must beat, and
    `select current_user` over the pooler to confirm the owner identity — all now written up in
    docs/12 item 6a.

- **2026-08-09 (THE RANK ADMISSION MAP — docs/13's rank/tier-wrapper gap, closed. One test,
  one generated doc, zero migrations. Opus session, founder chose the mechanism from three
  options after asking for each to be explained in plain terms.)** Nothing verified that a
  rank remap did not silently change what a `rank >= N` wrapper ADMITS. Now
  `packages/db/src/rank-admission.test.ts` + `docs/rank-admission-map.md`.
  - **STEP ONE WAS AN AUDIT, AND IT MOVED THE ANSWER.** docs/13 recorded "one ladder, FOUR
    rules". The catalog says **eight functions**, in four families, with **fourteen** rank
    call sites. The tier-threshold family alone is five functions carrying four
    independently hardcoded `2`s — so the obvious fix (guard the generic
    `module_caller_covers_rank`) would have left `cls_can_manage`, `sal_can_manage`,
    `sd_can_organize` and `module_has_manager_grant` uncovered while looking finished.
    **Two rules were missing from the summary entirely:** `module_roles_guard_last_director`,
    the only reader of rank 4 and one that fails OPEN (drop `director` below 4 and the
    "a module must keep at least one Director" guard silently stops firing for every module),
    and the `= 3` peer-appointment arm in `module_caller_can_manage_seat` — an EQUALITY, so
    remapping a position TO exactly 3 grants peer-appointment into a strictly-contained
    sub-scope and no threshold-shaped check would ever have noticed.
  - **The mechanism: discover, don't declare.** The rank readers are read out of
    `pg_proc.prosrc` and asserted against a tripwire list, so a ninth rule fails the build the
    day it lands. Every rank comparison must parse into a known shape; one that does not is a
    FAILURE, never a skip — and a threshold whose value cannot be resolved to a literal at
    every call site fails too. Admitted sets are computed by asking the DATABASE for each
    rank (never the TS mirror) over `viewAsDeclarations` — deliberately not `moduleRegistry`,
    which `MODULES` filters, a hole the existing parity loop in `rls.test.ts:1382` still has.
  - **It caught a real defect in its own first draft.** The parser reported
    `module_roles_guard_last_director` as an unreadable shape. The cause:
    `losing := rank(...) < 4 or new.org_id <> old.org_id or …` is an assignment whose RHS is a
    boolean EXPRESSION containing a threshold, and matching on `:=` alone had swallowed it.
    Requiring the call to be the entire RHS fixed it. The "fail, don't skip" design is the only
    reason that surfaced instead of quietly dropping a rank-4 rule from coverage.
  - **THE PROOF, RUN FOR REAL.** `cashier` remapped 1 → 2 in the live database: test FAILS,
    and the diff names `sal_earnings_ledger` on the `sal_can_manage_location` row — the exact
    motivating example, with the consequence visible in the failure rather than one lookup
    away. Restored afterwards and verified byte-identical to the migration source by md5 of
    `prosrc` (`437eac89…`), not merely by re-reading the three ranks back.
  - **Two design bugs found by reading the generated file rather than trusting the code.**
    (1) The closure over-attributed: every wrapper calling `module_caller_covers_rank`
    inherited ALL four of its instantiations, so `sal_can_manage_location` claimed a
    *classroom* rank test. Fixed by tagging each resolved threshold with the caller that
    supplied it and stripping the tag once inherited. (2) The per-module table named internal
    functions; it now keys on the gate closure, so each row names the function policies
    actually reference **and the tables behind it**. That is what makes the failure diff
    legible instead of merely correct.
  - **Prod verifier de-duplicated.** `scripts/prod-verify-view-as.mts` probe [5] was twelve
    hand-typed `(module, role, rank)` triples — a second copy of the same facts, free to rot
    against the first, covering three of eight modules. It now PARSES the checked-in map and
    checks **56** pairs against prod, including the generic `director/coordinator/lead/position`
    vocabulary, with a control so a failed parse cannot pass as a clean run.
  - **THE ADVERSARIAL REVIEW WAS RUN ON THE TEST, and four of its findings were
    silent-widening holes** — cases where the check stays green while covering less, which is
    the same failure the check exists to catch. All applied, all re-verified:
    **(1) discovery was case-sensitive** over `prosrc` (stored verbatim), so
    `MODULE_POSITION_RANK(...)` or a quoted identifier was invisible. Fixed, and backed by a
    control requiring Postgres and the JS regex to agree on how many bodies mention the
    ladder — so a future lexical blind spot fails instead of hiding.
    **(2) only `pg_proc` was searched.** A rank test inline in a policy, CHECK, default, view,
    index predicate, trigger WHEN or another schema was outside the parser entirely. None
    exist; that absence is now asserted with its own catalog-size control, per the
    `prod-verify-superadmin-log.mts` template, because an incidental absence nothing checks is
    one migration from being a gap.
    **(3) the rule set was discovered but the VOCABULARY was declared** — the sharpest one,
    since assertion 1's own argument is "a list here rots". `when 'supervisor' then 3` added
    to the ladder would have given every module a rank-3 name satisfying the peer arm and
    every `>= 2` gate, with no map row and no failure. Now parsed from the ladder's own body,
    per module block, with the old constant demoted to a tripwire asserted against SQL.
    **(4) `not (rank >= 2)` parsed as `rank >= 2`**, which would have published the exact
    COMPLEMENT of who a gate admits. Now a hard failure — and distinguished from
    `not exists (… rank >= 4 …)`, which is live in the last-Director guard today and is
    correctly read as `>= 4`, by testing only the token immediately before the call.
    Also applied: SQL comments were being parsed as code in both directions (a commented-out
    gate became a live map entry; a gate name inside a comment invented a phantom threshold on
    another gate); the closure froze each function on its first pass, making it depend on the
    catalog's collation; `localeCompare` was replaced with code-unit ordering so the snapshot
    cannot churn between a Windows dev box and the Ubuntu runner; and **three claims in the
    file's own header were false** and are corrected — by this repo's standard a false comment
    is a defect. The remap proof was then RE-RUN against the hardened parser: still fails,
    still names `sal_earnings_ledger`, restored to md5 `437eac89…`.
  - **THE RATCHET GAP IS CLOSED TOO (founder-approved, same session).** CI's test-count
    ratchet only counts `rls.test.ts`, so deleting this file — or leaving its generated map
    untracked — tripped nothing. A numeric floor would be theatre here: these are ONE `it()`
    each and their value is the file. `tests-floor.json` gained `requiredFiles`, and CI now
    fails if any of them is missing **or merely untracked** (an untracked snapshot passes
    locally, because vitest writes new snapshots, and defends nothing). Verified both ways —
    it passes on the real list and bites on a deliberately absent path.
  - **Verification:** typecheck 9/9 exit 0, build clean, db suite **109/109** (`rls.test.ts`
    104, data-browser 4, rank-admission 1) via `turbo --concurrency=1`; e2e **49/49 exit 0**
    in CI-STRICT mode against the PREBUILT server. **Pushed as `ba4eb6a`, and CI confirmed
    green the documented way** — Vercel production `READY` for that SHA, which proves `check`
    passed since `deploy` has `needs: check`. That matters more than usual here because the
    commit CHANGES CI itself (the new `requiredFiles` guard), so a green run is also the
    guard's first live exercise.
  - **One more confirmation of a documented gotcha, because it cost a rerun.** The FIRST e2e
    run lost six tests — and it followed two full db-suite runs, which mutate the seed data
    several e2e tests assume is fresh. `db:reset` → restart Kong → `seed` → auth curl 200 →
    49/49. Nothing about the diff was involved, and nothing about the diff touches app code.
    The rule already in CLAUDE.md holds and is worth restating: **reset and reseed immediately
    before an e2e run, not once at the start of a session** — a suite run in between is enough
    to invalidate it.

- **2026-08-09 (cls_exam_papers fixture — the last zero-row classroom table, closed.
  Seed-only, no migration. Sonnet subagent, orchestrator-reviewed.)** The student/GA exam
  section rendered empty on every surface, and empty is indistinguishable from broken — the
  keystone test asserts only that the read does not ERROR. The seed now creates one
  `cls_exams` row plus a `cls_exam_papers` row for charlie.
  - **The collision the Next list warned about was REAL, and checking it first is why nothing
    broke.** The classroom exam e2e creates its OWN exam titled `Midterm` in the same (only)
    class and navigates by `getByRole('link', { name: 'Midterm' })` — PAGE-scoped, not
    section-scoped. A seeded exam sharing that title would have made the click a strict-mode
    ambiguity and broken a passing test. The fixture uses `Quiz 1 — Warm-up`, grades nobody and
    publishes nothing, so it also cannot pre-satisfy the grading/publish assertions. This is
    the 2026-08-07 lesson (*a fixture must not pre-satisfy another test's starting condition*)
    holding up under its first real test.
  - **ORCHESTRATOR REVIEW CAUGHT SOMETHING THE SUBAGENT'S OWN REPORT DISCLOSED BUT WOULD HAVE
    BEEN EASY TO SKIM PAST:** to work around a build OOM it had temporarily set
    `typescript: { ignoreBuildErrors: true }` in `apps/web/next.config.ts`. It did revert it
    (verified: `git status` showed only `seed.ts` modified, and the file has no such key) — but
    a build-time type-check suppression is exactly the kind of "temporary" edit that must be
    confirmed gone rather than assumed. **Verify a subagent's cleanup claim against the tree,
    not against its summary.** Also verified its factual claim about the
    `cls_exam_papers_scope` trigger (real, `20260708010000:797`).
  - **Scope of verification was widened deliberately:** the subagent ran ONE test (`--grep
    exam`). A seed change can break any test that assumes clean seed state, so the full suites
    were re-run against a fresh reset — **db 108/108, e2e 49/49 exit 0.**
  - **Rode along: Docker Desktop DIED mid-verification** and the symptom was a db suite
    reporting `ECONNREFUSED` with 104 tests skipped — which reads exactly like a broken diff.
    The engine itself was gone, not the containers. Recorded as a gotcha in CLAUDE.md with its
    tell-tales (an empty `db reset` log, the db container's uptime not resetting, and
    `bash: fork: Resource temporarily unavailable`), because the misleading part is that free
    RAM looks healthy afterwards — it is free BECAUSE Docker died.

- **2026-08-07/08 (THE SUPERADMIN LOOKUP LOG — built, reviewed at three lenses, findings
  applied, verified. Migration `20260807010000`. Opus session; reviews requested as Fable,
  model UNVERIFIED.)** Durable reasoning → docs/15's 2026-08-07/08 entry; reusable rules →
  docs/03 (three new bullets in the view-as/test-discipline section); checklist → docs/12
  item 9, now closed. Headlines:
  - **What shipped:** `public.superadmin_lookup_log` + `superadmin_log_guard()`, and the app
    half in `apps/web/lib/superadmin-log.ts` wired into BOTH Owner Console tools. One row per
    real lookup — not per page open: the write is gated on the same condition as the render
    itself, so populating a picker records nothing. Append-only by GRANTS with `service_role`
    named in the revoke (docs/03 #17 applied first time, unlike `view_as_sessions` which
    needed `20260802010000` to learn it on prod). Verified locally: `authenticated` holds
    INSERT+SELECT only, `service_role` SELECT only, `anon` nothing.
  - **The central finding, and it is reusable: "unranked" and "rank 0" are not the same
    thing.** The spec said visibility by the appointment rule (strict rank + scope coverage).
    Applied honestly it admits NOBODY, because a superadmin is outside every module ladder
    rather than on top of one — which is the founder's own answer. Writing the rank arm anyway
    would have INVERTED the hierarchy: `module_position_rank` returns 0 for unmapped pairs and
    never null, so every rank-1 holder (salon cashier, classroom GA, speed-dating host) would
    strictly outrank the platform operator and read their whole cross-tenant history —
    silently, error-free. The absence of that arm is the security decision in the file, stated
    as such, and a live test proves it from both ends of a real ladder.
  - **THE ORCHESTRATOR CAUGHT A BUG IN A REVIEWER'S PROPOSED FIX, and it is the same lesson
    the codebase already learned once, in a new disguise.** Review 2 proposed a shape CHECK
    including `subject_user_id is not null`. A CHECK is re-evaluated on every UPDATE
    *including the real UPDATE an FK action performs* — so with `on delete set null` on that
    column, it would have made every person ever browsed PERMANENTLY UNDELETABLE, exactly as
    the rejected before-update trigger would have. The clause was dropped, the rest kept, and
    a test now deletes a referenced scope node and asserts both halves (the delete succeeds;
    the log row survives with a nulled reference). **Reviewers are not oracles — the
    orchestrator reading the fix is part of the rhythm, not a formality.**
  - **A read arm keyed on WHO YOU WERE outlives the authority it was granted for.** The draft
    had `actor_user_id = auth.uid()` for self-read. Review 1 found it survives DEMOTION — strip
    the superadmin flag and the person keeps reading every row they ever wrote, forever, which
    is precisely the suspected-misuse case. Its proposed fix is correct AND makes the policy a
    strict subset of the superadmin arm, i.e. dead. So the arm was deleted rather than fixed.
  - **Four false claims in the existing codebase, found and corrected in place** — the two
    "this surface writes nothing" headers, the `view_as_sessions` data-browser note claiming
    the console "leaves no row to find", and the **on-screen `not logged` badge together with
    the e2e assertion holding it true.** That last pair is the memorable one: a badge is a
    claim to the operator, so a test that keeps passing after the claim goes false is worse
    than no test.
  - **The data browser's own coverage test caught the new table automatically** (it reads
    `pg_catalog` and failed the build until the log's person columns were declared) — the
    machine-enforced half working as designed. Surfaced as "Owner Console lookups naming
    them", **included rather than omitted**: the tool promises to enumerate everything held
    about a person, and "we looked at you, on these dates" is part of that answer.
  - **Left open ON PURPOSE, and recorded rather than closed:** with a SECOND superadmin, the
    flat `is_superadmin()` oversight arm means each reads 100% of the other's lookups,
    unscoped, forever. That is a v1 default, not a derivation of the appointment rule (there
    is no rank domain among superadmins), and it is a founder decision → docs/12 item 9 + the
    Next list.
  - **Verification:** typecheck 9/9; build clean; db suite **108/108 (RLS 104/104)** up from
    97/97 — 11 new tests, floor raised to 104; e2e 49 with two new round-trip tests that drive
    the real console over HTTP and assert the lookup then surfaces in the data browser. Live
    rows confirmed with the intended shape asymmetry.
  - **A LOCAL-ONLY HOST PROBLEM WORTH RECORDING, because it cost three suite runs and looked
    like a regression.** The full e2e suite failed 49/49 twice with every test reporting
    `ERR_CONNECTION_REFUSED` — the `pnpm dev` server had died with `FATAL ERROR:
    NewSpace::EnsureCurrentCapacity Allocation failed - JavaScript heap out of memory` after a
    session of resets, builds and Playwright runs. Clearing `%TEMP%\node-compile-cache` (the
    documented fix) did not help. **What did: running the suite the way CI does —
    `CI=true`, which serves the PREBUILT app via `pnpm start` instead of JIT-compiling routes
    in `next dev`.** 49/49, exit 0, and in the STRICTER config (5s expect, 30s test, retries
    1). Two lessons: an all-tests-fail-at-connection result is an infrastructure symptom, never
    a code one (the existing rule about sign-in failures generalises); and `CI=true` locally is
    both the memory fix and the more meaningful run, since it is literally what CI executes.
  - **SHIPPED AND PROD-VERIFIED THE SAME SESSION.** Backup first
    (`backups/2026-08-09T06-10-41/`), `--dry-run` confirmed exactly ONE pending migration,
    pushed (`eef09ce`), then `migrate:prod`. The CLI's non-fatal `pgdelta-target-ca.crt ENOENT`
    appeared again — its catalog-CACHE step tripping on a local cert path, third occurrence,
    and the migration applied regardless.
  - **NEW TOOLING: `scripts/prod-verify-superadmin-log.mts`, and it exists because of a trap
    this repo already documented.** `prod-verify-migration.ts` parses `create function` blocks,
    so on this migration it verified ONE trigger function and nothing else — not the table, its
    ACL, the policies, the constraints, or whether the trigger is even bound. That is exactly
    the vacuity that bit `20260806010000`. The new script checks all of it against prod,
    read-only, **with a control on every block** so a broken catalog read cannot pass as a
    correct absence. **Prod 23/23, zero failures** — including the three that only prod can
    answer: the `ALTER DEFAULT PRIVILEGES` over-grant did NOT happen (`authenticated` holds
    exactly INSERT+SELECT, `service_role` exactly SELECT, `anon` nothing, and no role holds
    the whole-table wipe privilege); **no policy references a module rank arm** (the rank-0
    inversion, asserted as a negative with the policy count as its control); and every FK is
    `on delete set null` with no CHECK clause fighting it.

- **2026-08-07 (PROD DEMO REFRESH + PROD-VERIFY, Sonnet session — closed CLAUDE.md's Next
  item 6. Also: cross-checked docs/15's 2026-08-06/07 entry and `apps/web/lib/view-as.ts`'s
  comments against the running code — no mismatches found.)**
  - **The cross-check, done first.** Every checkable claim in the 2026-08-06/07 decisions-log
    entry and the `view-as.ts`/`console-view-as.ts`/`platform.ts` header comments was verified
    against the actual code: the "four things bypassed" list, `SuperadminGate`'s
    `declare const unique symbol` mechanism, `personFilter`/`scopeFilter`'s exact branching in
    `renderSurface`/`resolveScope`, the `cls_review_comments` embed-under-`cls_submissions`
    fix, the db suite counts (97/97, RLS 93/93 — recounted live and matched exactly), and the
    probe counts (35 console-view-as checks, 22 data-browser checks — recounted call-by-call
    against the scripts' control flow and matched exactly). Nothing needed fixing.
  - **The refresh.** Backed up prod first (`backups/2026-08-07T23-00-47/`), then
    `SEED_ALLOW_REMOTE=yes` + `DEMO_PASSWORD=<PROD_DEMO_PASSWORD from .env.deploy>` against
    prod. Confirmed read-only afterward via the REST API with the service-role key: `grace@
    demo.local` now exists, `sal_locations` now has 2 rows (Downtown + Uptown), and
    `cls_review_comments` now has 2 rows on two DIFFERENT students' submissions — closing
    exactly the vacuity CLAUDE.md's item 6 named (prod's mode-3 scope case had nothing to
    narrow; the classroom peer-comment fix had nothing to filter).
  - **The probe script had to be parameterised, not just pointed at prod.** It hardcoded
    `password123` for every signed-in account, including "the superadmin." That collides with
    a real safeguard: `seed.ts`'s remote-seed guard deliberately sets `owner@demo.local`'s
    `is_superadmin` to `false` off-localhost, precisely so a demo password can never guard
    platform-wide power in production (docs/12). So on prod the superadmin is the founder's
    REAL account, with its OWN password, distinct from the demo accounts' password. Added
    `VERIFY_DEMO_PASSWORD` / `VERIFY_SUPERADMIN_EMAIL` / `VERIFY_SUPERADMIN_PASSWORD`, all
    defaulting to the exact original local behaviour. Re-ran locally first (35/35 unchanged)
    before touching prod.
  - **Prod result: 34/35, zero skips.** The one FAIL — `"the superadmin is a member of NO
    org"` — was a genuine pre-existing fact, not a regression or a bug in this session's work:
    the founder's real account already held `org_members` rows in 3 orgs on prod (owner of a
    real org `Solutions`/`pozne`, member of `demo-a`, admin of `demo-b`), confirmed against the
    PRE-reseed backup so it predates everything done here. Harmless for view-as specifically —
    his `module_roles` are still empty (the OTHER premise, which passed), and view-as
    authority runs off that ladder, never off org membership — but it meant the console's
    mode-1 blurb premise ("the superadmin belongs to no org") was not literally true for this
    account.
  - **Founder decision, same session: keep `Solutions`, drop the `demo-a`/`demo-b` residue.**
    Fresh backup first (`backups/2026-08-07T23-34-43/` — the prior one predated the reseed, so
    a new one was taken immediately before this second prod write), then a targeted delete of
    the two `org_members` rows by `user_id` + `org_id`, verified before/after via a read-only
    query. Re-ran the probe script afterward: still 34/35 — the remaining FAIL is `Solutions`
    itself, which is correct and permanent, not a target to chase to 35/35. He genuinely owns a
    real org on his own platform, so `is_org_member` genuinely returns true for him there; the
    probe is still telling the truth, and its FAIL is now the understood steady state rather
    than test residue.
  - **A real safeguard gap, found by the pre-reseed backup and fixed.** `seed.ts`'s
    invite-accept status flip — `org_members.update({status:'active'}).neq('status',
    'active')` — was UNSCOPED: global across every org on the target database, not demo-org
    scoped, directly contradicting docs/12 guard 5's claim that prod seeding "cannot touch a
    real client org's rows." That guard's own wording is about the seed's DELETES (which
    really are org-scoped, checked line-by-line before running anything remote); this UPDATE
    was the one exception. Checked against the backup taken immediately before this session's
    reseed: every `org_members` row on prod already happened to be `'active'`, so this run
    changed nothing — harmless BY LUCK on a platform with no real customers yet, not by
    design. Fixed to `.in('org_id', demoOrgIds)`, using the demo org ids already in scope at
    that point in the function. Local reseed re-run to confirm behaviour-preserving (unchanged
    output). Not yet pushed to prod as a migration — it is app-side seed code, not schema.
  - **Verification:** local `verify-console-view-as.mts` 35/35 zero skips (post-refactor,
    pre-prod); prod run 34/35 zero skips (one pre-existing, explained fact, not a defect).
    `verify-data-browser.mts` deliberately NOT run against prod — it creates fixtures and
    docs/12 has no guard proving those stay demo-scoped the way the seed's do.

- **2026-08-06/07 (THE OWNER CONSOLE VIEW-AS — built, adversarially reviewed, findings
  applied, verified, SHIPPED. Commit `6a90110`, migration `20260806010000`; prod backup
  first, migration applied to prod, policy confirmed live, then pushed — Vercel production
  `READY`, which proves CI was green since `deploy` has `needs: check`.)** Durable reasoning →
  docs/15's 2026-08-06/07 entry; reusable rules → docs/03 #18 (FIVE new bullets) + THREE in its
  Test-discipline section; the log follow-on → docs/12 item 9. Headlines:
  - **What shipped:** `/console/view-as`, superadmin-only, deliberately absent from the
    in-module tab strips. Renders any declared position's surface in any org, bypassing the
    declared edge, the rank/scope-coverage conditions, §8.1 point 10's caller-scope
    intersection and `org_modules.enabled` — never RLS, never the surface declaration. The
    three founder-specified modes are ONE AXIS (the mode picks the person axis; scope is an
    independent picker in every mode), which is what makes mode 3 the answer to the case the
    salon review refused to fake. docs/13's read-only positions/ranks/pair-grid viewer is
    folded into the same screen, where the operator is about to step over one of those rules.
  - **One migration,** `20260806010000_sal_locations_superadmin_read.sql`. The general
    lesson: **a `for all` policy's USING also covers SELECT, so splitting one per-command
    silently drops an inherited read arm.** `sal_locations` was the ONLY table in the schema
    where `service_role` saw rows and the superadmin saw ZERO WITH NO ERROR — which empties
    every scoped salon section and reads as a finding about the position.
  - **The review found a live defect OUTSIDE the diff, in classroom code shipped 2026-07-31.**
    The student surface declared `cls_review_comments` with `subjectColumn: null`, so every
    student's tab rendered the whole class's peer-review comments. A FALSE CLAIM rather than a
    leak — the live student page uses a definer that strips the author and filters to their
    own submission, and a professor already reads every comment in scope — but the tab's
    claim to show what the STUDENT sees was false. Now an embed under `cls_submissions` keyed
    on `student_id`, mirroring that definer's join.
  - **Two mechanisms worth reusing.** `SuperadminGate`: a `declare const unique symbol` brand
    with no runtime value, so the privileged `RenderAuthority` arm cannot be written as an
    object literal and `requireSuperadmin()`'s single cast is its only source — *naming a gate
    is not passing one*. And the `.rpc()`/service-role **source scan**, which existed for the
    data browser, hardcoded three paths, never saw these six files, and lived only in
    `scripts/*.mts` — which CI does not run. It is in `rls.test.ts` now.
  - **The unlogged question got its dated decision** instead of being inherited: this build
    ships unlogged and says so on screen; the log GETS BUILT as a follow-on, in its own table,
    with hierarchy-governed visibility (the founder's counter-proposal, which dissolved the
    load-bearing objection by changing the audience rather than the rule). It is now docs/12
    checklist item 9, because a log started later can never cover the period before it existed.
  - **Verification:** typecheck 9/9, build clean, db suite **97/97 (RLS 93/93)**, e2e **47**,
    floor raised to 47/93, **35/35 new console probes + 22/22 data-browser probes, zero
    skips**. The new probe script failed twice on its first run and both were its own
    mistakes — one wrong table name, and one real misreading: the salon SERVICE CATALOG is
    `is_org_member(org_id)`, org-wide so customers can book, while the back office is
    `sal_can_operate_location`. So the console's scope filter on that section is NARROWER
    than RLS (allowed — declarations only narrow), and comparing catalog counts between two
    managers proves nothing about scope.
  - **The badge fix's OWN bug was caught by the test written for it,** which is the argument
    for writing the test at the surface rather than only at the declaration. The first
    implementation keyed the "no scope filter" badge on `scope.entityIds === null` — but the
    whole-module bypass skips the node FILTER while still RETURNING every id, so the two
    cases are indistinguishable from the result. The page rendered both salon locations and
    badged nothing: the exact failure the badge exists to prevent, shipped inside the fix for
    it. `resolveScope` now tracks `wholeTree` directly.
  - **The full e2e run found that the 2026-08-06 FIXTURES had made two shipped tests
    vacuous** — the sharpest finding of the apply beat, and it came from running the suite
    rather than from reading. The peer-review rows were seeded onto the same homework the
    grading-workflow e2e drives through its whole lifecycle. That did not fail the test; it
    made it pass for the wrong reason (its "Dana D: pending" assertion was satisfied by the
    SEED, not by the action under test) and surfaced two steps later as a missing Finalize
    button. A seeded survey answer did the same to another test, whose student arrived
    already answered. Fixed at the source: **Homework 0 (finished) and a second survey
    (answered) now carry every fixture row, leaving the ones under test pristine.** Also
    fixed an assertion that had been passing accidentally since 2026-07-31 — the view-as test
    checked `cls_review_comments` appeared in the "deliberately leaves out" panel, but
    `getByText` searches the whole page and it was matching the role section's own table
    label; it now asserts one entry from each list that really populates that panel, plus
    both halves of the embed (Dana's comment on Charlie's work present, Charlie's on Dana's
    absent). Rule → docs/03 Test discipline.
  - **The prod push found two more things, both recorded rather than fixed on the spot.**
    (1) `prod-verify-migration.ts` reported "0 failures" for `20260806010000` while asserting
    NOTHING about it — the script checks FUNCTIONS only, and this migration defines none, so
    its pass was vacuous for a policy-only change. The policy was confirmed separately with a
    direct read-only `pg_policies` query carrying a count control. Now in CLAUDE.md's gotchas.
    (2) **Prod's demo data predates the 2026-08-06 fixtures** — no `grace@demo.local`, 1
    salon location, 0 review comments — so neither the mode-3 scope case nor the classroom
    peer-comment fix is observable on prod, and the console probe script cannot meaningfully
    run there. The vacuity the fixtures closed locally is still sitting on prod. A founder
    decision (it writes to production), on the Next list.
  - **A process cost worth not repeating — and the first diagnosis was WRONG.** Two full e2e
    runs (~50 min) failed with EVERY test timing out at sign-in, the button stuck on
    "Working…". The first was blamed on editing source mid-run, which was a real mistake but
    not the cause. Measuring instead of theorising found two infrastructure faults: a dev
    server left running from a session THREE DAYS earlier, which the local Playwright config
    silently reuses, and Kong holding a stale auth route because the reset came after the
    Kong restart rather than before. **Every-test-fails-at-sign-in is always infrastructure,
    never code** — curl the auth token endpoint (502 = Kong, 400 = unseeded, 200 = the app
    server) before forming any hypothesis. Both are now in CLAUDE.md's gotchas.

- **2026-08-05 (NAIL-SALON REVIEW FOLLOW-UPS + PROD PUSH — four founder decisions, all on
  findings the review itself produced; same Opus session). SHIPPED: commit `89fae0a`, migration
  `20260804010000` applied to prod and prod-verified **33/33**, Vercel production `READY` —
  which proves CI was green, since `deploy` has `needs: check`.** Durable reasoning → docs/15's 2026-08-05 entry;
  docs/12 for the ratchet. Headlines:
  - **Dead API removed:** `columns?` on `PersonalLayer` / `ExcludedFromSurface` could never be
    used (the overlap check forbids one table in both `role` and an off-surface list), so every
    column-level decision was a caveat anyway. Deleted rather than left to mislead.
  - **The CI test-count ratchet now counts tests.** Its RLS half was an unanchored
    `grep -c "it("`, matching every `.limit(` line too: real 90, measured 105. Anchored, floor
    set exact. Founder-approved because it is a guard (docs/12 rule).
  - **The salon seed gained a paid visit + bookkeeping rows + a salon ADMIN (frank).** Closes the
    review's one open verification gap: the Manager tab had never been browser-rendered, because
    only an `admin` can open it. A new e2e now renders it and asserts a REAL earnings row — which
    exists because the seeded bill is inserted `open` and then updated to `paid`, the only way
    the AFTER UPDATE `sal_feed_earnings` trigger fires. The admin could not be alice (she holds
    `manager`; giving her both would have inverted the "no Manager tab" assertion), and the visit
    is dated yesterday so the day board is untouched.
  - **Rode along, and it is the kind of thing that eats a session:** the slice-5 fixture that
    seeds a `cls_review_assignments` row **failed the whole describe with a duplicate key** when
    the RLS suite ran straight after e2e without a reset — the classroom grading-workflow e2e
    creates the same (homework, reviewer, submission) triple. It reads as a broken security test
    when it is only stale state (the documented trap). The fixture now inserts if it can and
    otherwise ADOPTS the existing row, leaving it alone in `afterAll` — all it ever owed the
    tests was that the table is not empty. The suite is now 90/90 in BOTH orders, where before
    it needed a reset.
  - **E2E timeouts are now environment-dependent, CI deliberately STRICTER.** Local gets
    `expect.timeout: 15s` / `timeout: 45s`; CI keeps the 5s expect default, because it serves a
    PREBUILT app where a slow assertion means something is genuinely slow. That split is what
    keeps the fix from becoming a blanket "wait longer" that hides regressions. The two
    sub-shapes need the two different knobs: an assertion timing out after a navigation
    (`expect.timeout`) versus the `.click()` action stalling to the test timeout (`test.slow()`).

- **2026-08-04 (NAIL-SALON VIEW-AS SURFACE REVIEW — slice 5's follow-on, sequenced ahead of
  the Owner Console by founder decision 2026-08-03; Opus session, review kept at Opus tier
  because this is a copy of an audited pattern, not a new mechanism):** Module 5's own §8.1
  point 9 review. Nine pairs answered, three surfaces written, twelve tables classified per
  position, one one-function migration (`20260804010000_nail_salon_view_as_edges.sql`).
  Durable decisions → **docs/15's decisions log, 2026-08-04**; reusable rules → docs/03
  **#18** (six new bullets); module record → docs/modules/module-5-nail-salon.md. Headlines:
  - **Mode 1 ON for all five staff-to-staff pairs; mode 2 additionally for the two into
    `worker`; all four customer pairs OFF and re-decided rather than inherited.** The
    finding that drove it, and it generalises: salon RLS narrows **per location** for
    manager/cashier and **per person** only for worker, so "what does this PERSON see" has
    no referent for the first two. Mode 1 answers "what can this POSITION see", which is
    useful for all three. The two ways to force mode 2 onto a scope-narrowed position both
    fail — filtering on an authorship stamp UNDER-shows the tab, rendering unfiltered is
    not mode 2 — and `viewAsCompleteness()` refuses the configuration independently.
  - **The migration is two ON pairs inside one module arm.** `module_view_as_edge()` mirrors MODE 2
    specifically (it gates the session INSERT), so the four mode-1-only pairs need no SQL:
    mode 1 writes nothing and reads only through the caller's RLS. The parity test compares
    SQL against `mode2` over every ordered pair, so this stayed in step by construction.
  - **A cashier cannot read one revenue row** (`sal_earnings_ledger` is the module's only
    manage-tier read) while writing expenses freely — the module's clearest asymmetric read, and
    the cashier tab now says so. **A worker cannot read the earnings rows carrying their own
    `worker_id`**, nor bills/items/promotions/expenses/shopping list: six
    `unreadableByPosition` entries. **A worker CAN read every colleague's profile and weekly
    schedule** (org-member-wide policy), so the worker tab's narrowing is ours and is
    labelled as such.
  - **No new mechanism needed, and the near-miss is on record.** `subjectColumn` names a
    user-id column, so `sal_worker_time_off` (links via `worker_profile_id`) and
    `sal_customers` (reachable only through an appointment) cannot be subject-filtered.
    Answered honestly: time-off as an embed under the profile that makes the hop, the
    customer's name as an embed on the appointment — which is how the worker's own console
    renders it. A standalone customer section would have been FALSELY PERMISSIVE, the one
    failure mode a mode-2 tab must not have.
  - **Two honesty fixes rode along.** (1) The third off-surface list
    (`unreadableByPosition`) was declared and test-enforced from slice 5 but **never
    rendered** — it would have hidden the most useful sentence on the cashier tab. All
    three lists now render with distinct badges plus a line saying they are three claims
    about three different readers. (2) `formatCell` collapses an embedded object to its
    `title`/`name` key, so a multi-column embed silently dropped columns from the screen
    while still being declared; the salon embeds use PostgREST aliasing (`name:full_name`)
    so the allow-list lists exactly what renders.
  - **Verification:** typecheck 9/9; RLS **90/90** (was 82); **36/36 live probes, zero
    skips** (was 21/21 at slice 5 — +7 edge-mirror cases, a two-store scope-intersection
    probe, an unauthenticated mode-2 page fetch); 2 new e2e; THREE clean-seed full e2e runs, all four view-as tests green in every one; each run also lost ONE unrelated test to the local dev-server navigation flake, a DIFFERENT test each time and each passing in isolation (recorded in CLAUDE.md — the moving target is why it is environmental, not a test bug). All SIX tables
    behind the seven "cannot read" claims are **empty on a clean seed**, so fixtures exist for
    all of them — the vacuity rule, applied before it could bite. The keystone test runs as
    a plain member granted `manager`, not as alice: she owns demo-salon, so her reads
    short-circuit through `is_org_admin()` and would prove nothing about the position.
  - **A third reusable lesson, in docs/03's "Test discipline" rather than under #18: A TEST
    THAT UNDOES ITS OWN SETUP.** The new e2e opened the "what this leaves out" disclosure on
    one tab, switched tabs, and clicked it again — which CLOSED it, because `<details open>`
    is DOM state React does not control and an App Router client-side navigation reconciles
    the element rather than replacing it, so `open` survives the switch. It failed as "the
    element is present but hidden", i.e. it read as a rendering bug; the same trap would
    silently make a `not.toBeVisible()` pass. Fix: make any toggle interaction idempotent
    (read state, act if needed, assert state) instead of assuming a fresh render resets it.
  - **Also found while here, and left for the founder because it is a CI gate:** the
    test-count ratchet's RLS half greps `"it("` UNANCHORED (`ci.yml:55`), so it counts every
    `.limit(` line too — the real suite is 90 while the ratchet reads 105. Deleting real
    tests can therefore be masked by unrelated churn, and a refactor removing `.limit()`
    calls can fail CI having deleted nothing. Recorded in docs/12 with the one-line fix; the
    floor was raised in the same change (e2e 41, rls 104, one below the measurement as the
    previous session did).
  - **Observed, not caused, and not blind-fixed: a THIRD member of the flaky-navigation
    family.** `classroom: student sees published materials and can submit homework files`
    failed on the second of three clean-seed full runs — the homework link is present and
    correct in the DOM, but the page is still the class list when the heading assertion fires,
    i.e. a `.click()` whose navigation did not complete inside the 5s `expect`. It passes in
    **5.1s in isolation** on a fresh seed and passed on the other two full runs the same day.
    Nothing in this change is reachable from that flow (the shared view-as component is used
    by the view-as ROUTE, not the class list). Recorded in CLAUDE.md beside the two siblings,
    with the matchmaking fix named as the template for the shape — and deliberately left
    unfixed, because that sibling's fix was earned by error-context analysis and this one has
    not had it.
  - **Concrete requirement handed to the Owner Console build:** its third mode ("this
    position's surface with no person filter") is now the answer to a real need this review
    identified and deliberately did not fake — viewing one named manager's LOCATION-scoped
    console. Not a nice-to-have any more.

- **2026-08-03 (PER-PERSON DATA BROWSER BUILT — docs/13's Owner Console pair, first half;
  Opus session, two Fable adversarial reviews; NOT YET PUSHED):** `/console/data-browser`,
  superadmin-only. Answers *"what do I hold about this person?"* — every row the VIEWER may
  read that names the subject — as distinct from view-as's *"what does this person see?"*.
  Full reasoning, findings and verification numbers in **docs/15's decisions log,
  2026-08-03**; the reusable rules are docs/03 **#19**. Headlines:
  - **Zero migrations**, because `is_org_admin()` already short-circuits on
    `is_superadmin()` and `profiles`/`module_roles` already carry superadmin select arms.
    The feature is presentation over the caller's own RLS client.
  - **Founder re-sequenced the pair 2026-08-03**: data browser first, Owner Console view-as
    second. Reading the code sharpened why — the console's edge bypass can only render a
    position that has a declared SURFACE, and today that is classroom `student`/`ga` alone,
    so the banned speed-dating pair it was meant to bypass renders blank anyway. The data
    browser needs no surfaces and worked on all 8 modules on day one.
  - **Two Fable reviews.** No ship-blocker on the security keystone (both attacked `.or()`
    injection from the URL param, existence leaks via the two-step `via`, and cross-org
    bleed; none broke it). One ship-blocker on honesty: `sal_bills` has no customer column,
    so reaching a paying customer needs TWO hops and a customer with an account saw zero
    bills. Plus three silent-under-report bugs and one factually wrong note.
  - **The lesson most likely to recur:** `scripts/*.mts` are not run by CI, so a claim the
    UI states as FACT (`neverReadable`) needs its assertion in the db suite, not only in a
    probe script.
  - **Rode along, unrelated:** the matchmaking e2e flake (~40% fresh seed, 100% dirty),
    confirmed pre-existing on clean `master` by stashing all new work, then diagnosed rather
    than patched blind — post-failure DB state was identical to the seed, so the write always
    succeeded and only the re-render was late. `test.slow()` + a 20s timeout on the one
    assertion; 5/5 green after. `test.slow()` alone is NOT sufficient: it raises the test
    timeout, not the `expect` timeout, which was what expired.

- **2026-08-02 (SLICE 5 PUSHED TO PROD + PROD-VERIFIED; a prod-only ACL gap the generic
  verifier structurally could not see, Opus session):** `20260731010000_view_as_sessions.sql`
  is **LIVE ON PROD** (commit `ad8e989`, pushed with 5 earlier commits;
  `git log origin/master..master` empty). Backup first
  (`backups/2026-08-02T14-06-48/` — schema 337KB + data 1.7MB); `--dry-run` confirmed exactly
  ONE pending migration; `migrate:prod` applied it. The CLI's non-fatal
  `pgdelta-target-ca.crt ENOENT` appeared again — its catalog-CACHE step tripping on a local
  cert path, same as slice 3; the migration applied and is recorded.
  - **New tooling, and it paid for itself on the first run:**
    `scripts/prod-verify-view-as.mts`. Needed because `prod-verify-migration.ts` parses
    `create function` blocks, so on this migration it verified two function bodies and the
    version row and **nothing else** — not the table, not its ACL, not the policies, not the
    trigger, not whether the guard actually refuses anything. The new script checks all of
    those plus the edge mirror across 9 pairs, rank parity across 12 positions, and a
    **rolled-back live probe** (founder's 2026-07-29 requirement) proving a student and a
    speed-dating organizer are both refused — the latter specifically by the EDGE check, not
    merely by rank or scope. Prod **29/29**.
  - **THE FINDING — a prod-only ACL gap, exactly the class the 2026-07-22 lesson is about.**
    `20260731010000` wrote `revoke all privileges ... from public, anon, authenticated` and
    its comment claimed "No UPDATE, no DELETE, no TRUNCATE, to anyone". True on LOCAL. On
    PROD, `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` also grants the full set to
    **service_role** on every new table, and the revoke never named it — so prod had
    `service_role = DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE` on the
    audit log. **anon and authenticated were correct**, so no api-role surface was ever
    exposed, but a security log the worker's key can wipe is not append-only in the sense the
    design claims. `20260802010000_view_as_sessions_service_role.sql` narrows it to SELECT.
    A NEW file, not an edit: the original had already run against prod, and editing an
    applied migration is the append-only rule's exact failure mode. Deliberately targeted at
    this ONE table rather than reopening the platform-wide `service_role` deferral — an audit
    log is precisely where "it bypasses RLS anyway" stops being a good reason, and nothing in
    the worker touches this table. Lesson recorded as docs/03 **#17**: a revoke naming only
    `public, anon, authenticated` is incomplete on prod.
  - **A harness bug worth remembering** (cost one crashed prod run, wrote nothing): in
    Postgres a failed statement poisons the whole transaction, so catching the error in
    JavaScript is not enough — the next statement dies with "current transaction is aborted".
    Every expected-to-fail probe now runs inside its own SAVEPOINT. Verified prod was left
    with 0 rows after the crash before continuing.
  - **Also this session:** the founder rule **"org position does not enable view-as, module
    position does"** (recorded in the migration, docs/15 and docs/03 #18 as an explicit
    do-not-fix, since it makes this the one gate on the platform without an `is_org_admin`
    arm); terminology corrected from "impersonation" to **view-as** on the founder's point
    that mode 2 is read-only viewing, not acting-as (`mayImpersonatePosition` →
    `mayViewAsPerson`); the peer-review anonymity boundary corrected (anonymous from other
    students and the GA, never from the professor) and the resulting GA comment/grade
    asymmetry confirmed INTENDED; and the finding that **no student-facing view of
    peer-review feedback exists at all** — `cls_comments_for_my_submission()` was written for
    it, strips `author_id`, is still granted, and has never had a caller.
  - Local after both migrations: `db:reset` + seed + **RLS 77/77**, typecheck 9/9, build clean.

- **2026-07-31 (USER-MODEL SLICE 5 — VIEW-AS BUILT, Opus session; the four open items resolved):**
  `20260731010000_view_as_sessions.sql` + a declaration layer
  (`packages/platform/src/view-as{,-modules}.ts`) + a generic renderer
  (`apps/web/lib/view-as.ts`, `apps/web/components/view-as/`) + the classroom route.
  Founder-initiated. Full docs/03 #12 rhythm: draft → two independent Fable-tier
  adversarial reviews → fixes → live verification as real users → RLS tests → docs.
  Decisions in docs/15's 2026-07-31 entry; the classroom vocabulary/surfaces in
  docs/modules/module-2-classroom.md; the reusable rules as docs/03 **#18**.
  - **The four open items the spec left to the builder, and what they became.**
    (1) *Starting scope* — declarations for **all 8 modules** (the completeness check
    is only a check if no module can opt out), edges **ON for classroom only**, on
    the principle that §8.1 point 9 makes surface classification a per-module
    security review, so an edge may only be ON in a module that has HAD one.
    (2) *Surface declarations* — written for classroom; see the vocabulary correction
    below. (3) *Every rank-differential pair* — classroom's two both ON;
    nail-salon's nine and speed-dating's six enumerated and OFF with per-pair
    reasons; the other five vocabularies are entirely rank 0 in SQL so they imply no
    pairs at all. (4) *Enforcement* — a TypeScript mapped type **plus** a SQL parity
    test, because the type alone provably does not deliver the guarantee.
  - **professor→student, the pair §8.1 point 11 left explicitly open, is ANSWERED:
    ON, both modes.** A student's surface is almost entirely the professor's own duty
    output reflected back, and "what does my student actually see?" is the support
    question the Student tab exists for. Nothing widens — every declared table is
    already professor-readable in scope. Rather than closing the pair, the sensitive
    parts were narrowed out: `cls_survey_answers` and `cls_review_comments` excluded,
    `submission_id` omitted from `cls_review_assignments` so the reviewer→reviewee
    direction cannot be walked, `cls_grades` filtered to `is_final AND visible` (the
    student's own RLS arm, byte for byte), and submission-retention hiding reproduced
    in the renderer because the professor is exempt from `cls_submission_hidden` —
    without that, a professor debugging "why can't Charlie see his old submission?"
    would see the row and conclude nothing was wrong. **Flagged for founder
    confirmation**; reversing it is a one-line change in two places.
  - **A vocabulary correction the build forced: "personal" split into two lists.**
    §8.1 point 1 defines personal as RLS-*unreadable* to higher positions and calls a
    personal marking on a staff-readable table a spec violation. Classroom has no
    `sd_notes` analogue at all — a professor reads every `cls_*` table inside their
    scope — so labelling survey answers "personal" would have been exactly that
    violation. The declaration therefore carries `personal` (asserted RLS-unreadable,
    test-enforced) and `excluded` (product decision over ambiently-readable data,
    also test-enforced, in the opposite direction). **Classroom's `personal` list is
    empty, and that emptiness is the finding.** The suite asserts both directions, so
    a genuine RLS gap cannot hide behind an "it's hidden" label.
  - **The mapped type alone is NOT the guarantee — the load-bearing catch.**
    `ViewAsEdges<positions>` makes an undeclared rank-differential pair a
    `pnpm typecheck` error (CI runs typecheck), an equal-rank or upward pair an
    excess-property error, and `mode2` without `mode1` unrepresentable. Both negative
    cases were proven to bite, including the amendment's own scenario: remapping
    `student` from rank 1 to 0 makes `ga → student` newly rank-differential and fails
    the build until it is answered. **But the type keys on the TypeScript rank table
    while the authoritative rank lives in SQL's `module_position_rank()`** — a
    SQL-only remap, precisely the "one-line migration, no backfill" the amendment
    exists to catch, sails straight past it. The RLS suite's rank-parity test against
    the live database is what actually closes that gap. Recorded in docs/03 #18 so it
    is never treated as optional. No new build script was needed: CI already runs
    `pnpm typecheck` and the db suite.
  - **Architecture: no new database read path, which is why the migration is small.**
    Everything renders through the CALLER's ordinary RLS-enforced client; the surface
    declaration is a column ALLOW-LIST (never `select *`), so a table nobody declared
    cannot appear and point 9's "anything unclassified defaults to PERSONAL" is
    structural rather than a rule to remember. **One correction to the 2026-07-30
    rejection of an RLS-bypassing read path:** it argued that no planned module has an
    allowed edge where the viewer's ambient access exceeds the intended surface.
    Turning professor→student on creates exactly two such cases (survey answers,
    review-comment authorship). The decision still stands — the allow-list excludes
    them and a definer would remove RLS as the backstop for no gain — but the premise
    is now falsified and future reasoning must not lean on it.
  - **Adversarial review 1 (Fable) found three ship-blockers, all fixed.**
    (1) **CRITICAL — the manifest's ON/OFF edge table had no enforcement at the one
    thing already live.** `authenticated` can insert into `view_as_sessions` straight
    through PostgREST, and the guard checked only rank + scope coverage, so a
    speed-dating organizer (rank 2) could have minted a session row naming a
    PARTICIPANT (rank 0) — a pair banned permanently by point 7. Fixed by mirroring
    the ON pairs into IMMUTABLE SQL (`module_view_as_edge()`, the same
    config-in-a-migration shape as `module_position_rank`) and requiring **one single
    grant** to satisfy rank, scope coverage and the declared edge together, so a
    caller holding two grants cannot borrow the rank of one and the edge of the other.
    A parity test asserts SQL and TypeScript agree on every ordered pair, OFF ones
    included. This is docs/03 #17's two-gate rule applied to edges.
    (2) **CRITICAL — FKs written `on delete cascade` would let a routine admin action
    erase the audit trail.** An org admin tidying up a `module_scope_nodes` row (a
    permitted, ordinary delete) would have silently removed every view-as session row
    pointing at it. Changed to `on delete set null`, matching `vm_moderation_log`, the
    platform's existing audit log — a security log must outlive what it describes.
    (3) **CRITICAL — missing explicit `revoke all`.** The migration relied on omitting
    UPDATE/DELETE grants, but prod's still-open `ALTER DEFAULT PRIVILEGES` (docs/15
    2026-07-29 deferral 2) auto-grants the full set on every new table — including
    TRUNCATE, which RLS provably does not gate. Without the revoke this would have
    shipped to prod with any signed-in user able to erase the whole impersonation
    audit trail. Exactly the convention #1/#17 rule, on a table created two days after
    the sweep that wrote it.
    The same review independently re-verified the classroom surfaces table by table
    against the live 20260724010000 policies, and confirmed the null semantics of
    `module_scope_covers`, the `is not distinct from` grant check, the
    trigger-then-revoke ordering, and the deliberate non-reuse of
    `module_caller_covers_rank` (which ORs in `is_org_admin`, unwanted here).
  - **Founder correction, 2026-08-02 — professor→student CONFIRMED, and the anonymity
    boundary was in the wrong place.** The pair is confirmed ON. But the first draft excluded
    `cls_review_comments` and dropped `submission_id` from `cls_review_assignments` on the
    reasoning that showing a reviewer's identity would break peer-review anonymity. Founder:
    anonymity runs from other STUDENTS and from the GA — **never from the professor**, who runs
    the process. Both are now on the student surface in full, carrying caveats saying they show
    deliberately MORE than the student sees (the student's own path strips the author via
    `cls_comments_for_my_submission`). The mistake was about WHO the anonymity protects
    against, not about the mechanism, which is worth remembering because it is easy to repeat
    per module. **A follow-up question was raised and answered the same day:**
    `cls_review_comments_select` carries a `cls_is_ga_class` arm while
    `cls_review_assignments_select` has never had one, so a GA reads comment text and
    authorship but no peer marks. Founder: **intended.** "Anonymous from the GA" means
    anonymous in the GRADING sense — the GA sees the substance, not the scores. No change;
    recorded in docs/modules/module-2-classroom.md so nobody "fixes" it later.

- **Adversarial review 2 (Fable) caught a regression created by review 1's own fix, plus
    three classification/coverage defects.** (1) **The append-only trigger and the
    `on delete set null` FKs were incompatible** — Postgres implements `SET NULL` as a real
    UPDATE on the referencing table, so the `before update or delete` guard fired on the FK
    action and aborted the parent DELETE. Once any scope node or user had been named in a
    session it became permanently undeletable, and `org_id`'s cascade did the same for whole
    orgs. The trigger did not make the log outlive what it describes; it made what it
    describes undeletable. Removed: append-only is now grants-only, exactly as
    `vm_moderation_log` has always done it. Reusable lesson in CLAUDE.md's gotchas and
    docs/03 #18. (2) **The live probe meant to validate review 1's FK fix was vacuous** —
    its cleanup delete was silently failing (for the reason above) and `supabase-js` does not
    throw, so "the log survived the delete" passed because the delete never happened. It now
    asserts the delete SUCCEEDS, that the node is really gone, and that the rows survived.
    (3) **A misclassification the two-list model allowed**: classroom's GA surface listed
    `cls_review_assignments` and `cls_survey_answers` as `excluded` when in fact no GA can
    read either. "Excluded" and "the position has no read path" are different claims about
    different readers, so there is now a third list, `unreadableByPosition`, asserted against
    a real position-holder. (4) **The excluded-is-readable test only looped `student`**,
    skipping `ga` — which is precisely where the misclassification sat. It now loops every
    surface of every module. Also fixed: a `scopeColumn: null` role table would have skipped
    scope intersection entirely (§8.1 point 10) and is now a completeness-check error; the
    app-layer pre-check could satisfy edge/rank/scope from three *different* grants where the
    SQL guard requires one; and `scopeCovers` now checks node existence before its identity
    shortcut. Independently of the review, a self-review found **mode 1 was not filtering by
    subject at all** — it rendered every row in scope under a lower position's label instead
    of the caller's own data (§8.1 point 8). Not a widening (the professor reads those rows
    anyway) but the wrong mechanism, and it would have become a real widening in the first
    module whose viewer has narrower ambient reach.

  - **The session log IS the session.** Its row id lives in an HttpOnly cookie and
    every impersonated render requires it, so point 6's "every mode-2 session start is
    logged" is structural, not something the app is trusted to remember. Sessions end
    by EXPIRY, never by an UPDATE — which is what lets the table stay genuinely
    append-only (no `ended_at` to write). Authorisation is re-resolved on every render,
    so revoked authority takes effect immediately rather than at session end.
  - **Point 7's `viewAs: none` is gone as a separate mechanism**, subsumed by point 11
    exactly as the amendment predicted: speed-dating's end-user ban is now three
    explicit `participant`-target pairs set OFF, each carrying its reason.
  - **Deliberate departure, flagged for founder confirmation:** the session guard has
    **no `is_org_admin` short-circuit**, unlike every other module gate on the platform
    (docs/03 #9). Org roles are independent of module authority (docs/15 §2.2) and this
    is the only floor under an impersonation surface, so an org owner who wants a
    view-as tab holds the module seat like anyone else.
  - **Verification.** RLS suite **77/77** (was 57; +20 for this slice, covering
    SQL↔TS rank parity, SQL↔TS edge parity over every ordered pair, the runtime
    completeness backstop, the personal/excluded split in both directions with a
    positive control on `sd_notes` so the assertion is not vacuous, and the session
    guard's accept/refuse cases including the equal-rank GA→student refusal). **2 new
    e2e tests** as real users through the browser: a professor opening the tabs, mode 1,
    a logged read-only mode 2 on a named student with the exclusions listed on the page,
    and the negative path where a GA (a peer) and a student get no tabs at all.
    **21/21 live probes** (`scripts/verify-view-as.mts`) over PostgREST as real
    signed-in users: the banned-pair refusal and its exact error, the edge mirror's
    fail-closed default across 9 pairs, mode 2 unreachable without the cookie, the log
    actually recording, a course-scoped professor refused on a student in a sibling
    course *and* allowed on one in their own, and the audit log surviving deletion of
    the scope nodes it references. Typecheck 9/9. Test floor raised to e2e 29 / rls 76.
  - **One probe initially failed for the right reason and caught a bad test.** The
    cross-course scope check passed its negative case vacuously: the professor fixture
    had been added to the org but never accepted the invite, so slice 3 refused him as
    a *pending* member before scope was ever consulted. Fixed the fixture to accept
    first, which made the negative assertion actually test scope. Worth remembering —
    since slice 3, any test fixture that adds an org member must accept the invite or
    its negative assertions may prove nothing.
  - **Also fixed in passing:** `pnpm --filter @platform/db test` never loaded the
    repo-root `.env` (Vitest looks beside the package), so the suite only ran where the
    vars happened to be exported — contradicting its own "run `pnpm dev` once to
    generate .env" error message. `packages/db/vitest.config.ts` now loads it, and
    aliases `@platform/core` so the suite can assert the declarations against the DB.
  - **Not done, deliberately:** nail-salon and speed-dating surface reviews (pairs
    enumerated and off); notifying view-as targets (point 6 leaves it a per-module
    product decision); the temporal-table audit-history upgrade (§8); any mode-2 write
    path (point 2 bans it until a dated decision says otherwise); and prod deployment,
    which is a separate founder-initiated step with its own backup → `--dry-run` →
    `migrate:prod` → prod-verify rhythm.

- **2026-07-30 (FLAKY E2E TEST — DIAGNOSED + FIXED, `speed-dating: register → round → mutual interest → reveal`, Sonnet session):** Diagnosed which of the three candidate causes (docs/history 2026-07-29 entry) it actually was, using the `error-context.md` artifact from the last real full-suite failure (2026-07-29): at the failing assertion, Dana's browser was still on the stale events-LIST page, mid-navigation to the event-detail page, when the assertion's 5s window expired — and every prior assertion in the test (exact roster/round/reveal counts) had already passed, which rules out both RLS-suite data contamination (that suite's speed-dating fixtures create/clean up their own uniquely-named events, never touching the seeded "Friday Night Mixer") and the test's own non-idempotency (stale seed state would have failed at the very first "Register" step, not 13 steps in). Root cause: genuine timing/load — this test does 8 full sign-ins/page-loads (every other speed-dating test does 1-3), each a data-heavy server component (~11 sequential Supabase round-trips), run sequentially right after the 57-test RLS suite, against the unbuilt `pnpm dev` server (JIT route compilation, flat 30s timeout, 0 local retries per `playwright.config.ts`). Fix: `test.slow()` on just this test (Playwright's idiom for a known-heavier test — triples its timeout to 90s) rather than padding global config, individual assertion timeouts, or adding retries. **Verified by clean reproduction, not just theory:** `db:reset` + `pnpm seed`, then the full 57-test RLS suite, then the full e2e suite immediately after (the exact ordering that produced the original failures) — the target test passed in 31.6s. (A first reproduction attempt was contaminated by an earlier isolated run of the same test advancing the seeded event to `complete` before the full-suite run started — a real instance of the test's documented non-idempotency, but self-inflicted by the reproduction method, not the phenomenon being fixed; redone clean.) **New finding surfaced by the clean reproduction, NOT investigated further (out of scope for this session):** with speed-dating now passing, a DIFFERENT test failed instead — `visual messaging: create from a picture, draw a reply, membership gates access` — with the same signature (30s timeout on a navigation-adjacent click, same post-RLS-suite load window), but a different immediate cause: Charlie's page showed only a "Layer 1" (root) link, no "Layer 1.1" link at all, right after Alice's moderation-removal step earlier in the same test — worth a founder-directed look at whether the removed-layer link should still render for a non-moderator member. Flagged, not fixed.
- **2026-07-29 (ACL HARDENING SWEEP — PUSHED TO PROD + PROD-VERIFIED, commit `a16f4a5`):** **PROD RESULT, all green.** Fresh backup first (`backups/2026-07-29T21-11-44/` — schema ~347KB + data ~1.73MB); `migrate:prod --dry-run` confirmed exactly ONE pending migration; `pnpm migrate:prod` applied it. (Same non-fatal `pgdelta-target-ca.crt ENOENT` as slice 3 — the CLI's own catalog-cache step tripping on a local cert path, not the migration; verified applied rather than assumed.) **`verify-acl-hardening.ts --probe` on prod: 39/39, 0 failures** — exactly the 2 allowlisted signatures anon-executable, 0 functions PUBLIC-executable, all 54 trigger functions with no api-role EXECUTE, oracles still service_role-only, all 81 others keeping authenticated+service_role, every definer still pinning `search_path`, anon holding NO privilege on any of the 67 tables, authenticated holding no TRUNCATE/REFERENCES/TRIGGER/MAINTAIN anywhere, authenticated DML matching intent on all 67, service_role un-shrunk, RLS on everywhere, and both `profiles` column grants intact with no table-wide UPDATE. Plus a **live rolled-back `anon` probe on prod**: all 20 table read/delete attempts refused `42501 permission denied for table`, `syn_public_weeks` allowed, `is_org_member` refused. **Verified from the OPEN INTERNET with the prod anon key** (the check that actually matters): `GET /rest/v1/orgs` → **401 `42501 permission denied for table orgs`** where it previously returned `200 []` with RLS as the sole gate; `POST /rest/v1/orgs` → 401; `POST /rest/v1/rpc/syn_public_weeks` → **200** with real data; and `/s/demo-shul` on the live site → **200**, rendering "Demo Synagogue". Live health check 200 on `/`, `/login`, `/s/demo-shul`, `/dashboard`. **Prod row counts UNCHANGED** (28 org_members / 8 orgs / 10 profiles, 0 non-active) — the migration moved privileges only, no DDL and no rows. Pushed to master and `git log origin/master..master` empty; note this commit carries **no app code**, so the slice-3 "DB ahead of deployed UI" trap did not apply. `gh` is not installed on this machine so CI status could not be read from the terminal — immaterial here for the same reason (a skipped deploy leaves the correct, unchanged app serving). **Build detail below.**
- **2026-07-29 (ACL HARDENING SWEEP — the build, local verification and prod preflight; Opus session):** `20260728010000_acl_hardening.sql` closes the GRANT layer platform-wide so RLS stops being the only gate. **Quantified off prod's `pg_catalog` FIRST, which found the job bigger than the docs implied:** 134 of 139 public functions were anon- AND PUBLIC-executable on *both* local and prod (not just slice 3's 20 of 23), and all 67 tables granted `anon` the full set `arwdDxtm` on prod. **Two findings that changed the shape of the work:** (1) `anon` AND `authenticated` held **TRUNCATE** on all 67 tables on *both* environments — and **RLS does not gate TRUNCATE**, so it was the one privilege here RLS could never have covered (unreachable today only because PostgREST emits no such verb — the API surface was the mitigation, not the database); (2) prod also granted `anon` **SELECT** on all 67 tables, a strictly larger surface than the INSERT/UPDATE/DELETE the task started from. **End state:** `anon` holds nothing in `public` but schema `USAGE` + EXECUTE on the two `syn_public_*` functions; the 54 trigger functions hold no api-role EXECUTE; `authenticated` keeps EXECUTE on all 81 other non-trigger functions and its per-table DML exactly as the creating migrations granted it; the 2 ancestry oracles stay service_role-only (preserving 20260722010000); `service_role` untouched. Strategy: ONE blanket `revoke execute on all functions in schema public` then 85 explicit grants — because hand-enumerating signatures is how an overload gets missed (`module_position_rank` exists as both `(text)` and `(text, text)`) and how a dropped function gets named (`org_members_guard_self_admin`, dropped 20260717010000, would abort the transaction). Every statement generated from `pg_get_function_identity_arguments`, nothing hand-typed. **FIVE MECHANISMS PROVED EMPIRICALLY RATHER THAN CITED — each changed the SQL:** (a) **SIGNUP SURVIVES** — the catastrophic case. `handle_new_user` is a definer trigger on `auth.users` and GoTrue reaches it as `supabase_auth_admin`, which today only gets there via the PUBLIC grant being removed. Tested with the real role and a real revoke (`has_function_privilege` = false), the insert still fired the trigger and created the profile row; rolled back, 0 leftovers. Trigger EXECUTE is checked at `create trigger` time, not fire time — confirmed across `authenticated`, `service_role`, `supabase_auth_admin`. (b) Functions named in an RLS policy **DO** require EXECUTE for the querying role — revoking it turned a working read into `permission denied for function`, so `authenticated` must keep it on ~60 predicates. (c) **A table-level `revoke all` ALSO wipes column-level grants** — would have broken `profiles` display-name/settings editing; restored explicitly. (d) Local has always run with zero anon table privileges and the public schedule RPC still returns real data there, so revoking anon SELECT is safe. (e) **`supabase db push` is ATOMIC per migration file** — verified by pushing a deliberately-failing migration to local: the preceding `create table` did not persist and no version row was written. That removes the "partial sweep locks out every user" outage scenario. **Full docs/03 #12 rhythm.** Two independent adversarial reviewers were lost to a session limit mid-flight and the gate was NOT counted as met until a relaunched review reported. It earned its keep — it **independently re-derived `authenticated`'s intended table privileges by replaying every grant/revoke across all 17 prior migrations and found zero differences across all 66 granted tables**, confirmed all 40 distinct `.rpc()` names and all 191 policy expressions (178 `public` + 13 `storage`) are covered, confirmed no index expression / CHECK / column default / generated column depends on a project function, and confirmed `auth.uid()` and `storage.foldername` live outside `public` and are untouched. **Findings fixed:** its top OUTAGE finding — the grant list was generated from LOCAL and nothing diffed PROD before the push — produced a new **`--preflight` mode** that compares the target's function set against the migration's parsed grant list and refuses the push on any orphan (would silently lose EXECUTE) or phantom (would abort the migration); **run against PROD, 3/3 green** — prod has the identical 139 functions (85 non-trigger + 54 trigger), all covered. It also found **three real test defects**: 4 of the 15 probed tables (`profiles`, `org_members`, `org_modules`, `syn_published_weeks`) have **no `id` column**, so 12 of 45 write assertions could never reach a privilege check (PGRST204/42703 first) — fixed with a real per-table key column; `isPrivilegeDenied` could not distinguish a table-privilege denial from an **RLS `WITH CHECK` violation, which is ALSO SQLSTATE 42501** — fixed to require `permission denied for (table|relation|function|view)` and exclude `row-level security`, so an RLS-only refusal can no longer make the tests green; and the block's own comment **falsely claimed** it closed the 2026-07-22 gap — it cannot, because local was never the vulnerable side (local `anon` only ever held `Dxtm`, no DML), so those tests would have been green throughout the window prod sat open — comment corrected to say so explicitly and to point at the prod verifier as the only thing that closes it. Also applied: `revoke all privileges on all tables in schema public from public` (the function revoke named PUBLIC, the table revokes didn't — an unexplained asymmetry that would have let a PUBLIC table entry keep anon fully privileged); `service_role` added to the two `syn_public_*` grants (otherwise this migration silently narrowed it, invisibly to any verifier, since those two must be exempt from the authenticated+service_role rule); verifier hardened (PUBLIC detected via `aclexplode` grantee=0 so `=X*/owner` with grant option can't hide, allowlists matched on full SIGNATURES not bare names so a future overload can't slip through, `MAINTAIN` added to the privilege set, plus a `service_role` no-shrink assertion — note `mm_interests` intentionally grants SELECT/INSERT/DELETE to BOTH roles, no UPDATE, so the bar there is not full CRUD). **CI caught a real hit:** its destructive-migration guard greps case-insensitively for that word followed by whitespace **including in comments**, and the first draft tripped it. Adding `DESTRUCTIVE-CHANGE-APPROVED` would have been a lie (this migration touches no rows and contains no DDL), so the prose was reworded instead and the safeguard left untouched — guard now clean across all migrations. **VERIFIED LOCALLY:** migration applies clean via `db:reset`; anon-executable functions **134 → 2**, PUBLIC-executable **134 → 0**, anon TRUNCATE **67 → 0**, authenticated TRUNCATE **67 → 0**, nothing else moved; **RLS suite 57/57** (51 pre-existing + 6 new); **typecheck 9/9**; **verifier 17/17** plus a **live rolled-back `anon` probe on local, 22/22** — every table read and write refused with `42501 permission denied for table`, `syn_public_weeks` still allowed, `is_org_member` refused. **TEST BLIND SPOT CLOSED:** `rls.test.ts` had a single `signIn()` factory and had therefore **never once tested the `anon` role**, so the table half of this change was both a local no-op and unverifiable — the same structural gap behind 2026-07-22. The new block asserts both the semantic invariant and the mechanism. **PRE-EXISTING FLAKE, NOT CAUSED BY THIS CHANGE — established by controlled experiment:** the full e2e suite failed `speed-dating module: register → round → mutual interest → reveal` (1 failure), then 3 failures on a second run, all 30s *timeouts* with page snapshots showing the app working correctly under the new ACLs. Pulling the migration out entirely and re-running gave **the same test failing, 1 failed / 34 passed** — so it is a flaky long test (the 1-vs-3 variance tracks machine load), unrelated to the sweep. Left alone deliberately rather than bundled in; worth a separate fix. **NOT YET PUSHED TO PROD** — awaiting the founder's go-ahead per the standing rule. **Founder decisions (2026-07-29):** strangers **never write** — no sanctioned anon write path anywhere, so a public surface is always a read-only definer function and a static page (about / contact-by-email) needs no grant at all; a **platform-level** public-page option is kept as a first-class concept alongside per-module ones; `service_role` keeps its grants; prod verification must include a real rolled-back anon probe. **Deferred (all recorded in docs/15 with rationale):** `storage`-schema grants (prod grants anon the full set incl. TRUNCATE there too; all 5 buckets private, 13 policies key on `auth.uid()`, and `... in schema public` doesn't touch it); prod's `ALTER DEFAULT PRIVILEGES`, which re-opens every FUTURE object so this sweep decays without a guard (Supabase removes the legacy auto-expose on **2026-10-30**, so the durable fix is likely project config, not SQL); ~9 internal-only helpers that keep `authenticated` EXECUTE they don't need; 3 provably dead functions locked rather than dropped; `service_role`'s retained TRUNCATE. **New tooling:** `scripts/acl-audit.ts` (read-only privilege reporter, `--json` diffable) and `scripts/verify-acl-hardening.ts` (`--preflight` / assertions / `--probe`) — needed because `prod-verify-migration.ts` parses `create function` blocks and so verifies *nothing* on an ACL-only migration. Conventions → docs/03 **#17**; two never-do entries → docs/12; dated record → docs/15. Also fixed longstanding **doc drift**: docs/01, docs/02 and docs/05 described Drizzle as generating/running migrations — it does neither (no config, no output dir, `drizzle-kit` an unused devDependency; `schema.ts` is a hand-maintained type-only mirror and `supabase/migrations/` is the sole source of truth).
- **2026-07-28 (USER MODEL slice 3 PUSHED TO PROD + fully prod-verified; a generic prod-verifier built; two prod-only ACL findings recorded, Opus session):** Shipped the entry below to prod. **Backup first** (`backups/2026-07-28T17-30-20/` — `schema.sql` ~339KB + `data.sql` ~1.7MB, exit 0), then `pnpm exec tsx scripts/prod-migrate.ts --dry-run` confirmed **exactly ONE** pending migration (`20260727010000_org_invite_accept.sql`), then `pnpm migrate:prod` applied it. The CLI printed a non-fatal `failed to cache migrations catalog: ... pgdelta-target-ca.crt ENOENT` — that's the CLI's own pg-delta catalog-CACHE step failing on a local cert path, **not** the migration: the migration applied and is recorded in `supabase_migrations.schema_migrations`. **NEW TOOLING:** `scripts/prod-verify-migration.ts`, a generic **read-only** prod verifier — give it a migration path and it parses every `create [or replace] function public.*` plus its dollar-quoted body out of the SQL file, then for each one compares against PROD's `pg_proc`: body **md5** (byte-identical?), `prosecdef`, pinned `search_path`, and the REAL `EXECUTE` ACL (resolving PUBLIC + per-role grants and flagging `anon`); it also asserts the migration version is present in `supabase_migrations`. It exists because function EXECUTE grants **diverge local vs prod** and the local RLS suite structurally cannot catch that (the standing CLAUDE.md gotcha / docs/03 convention #1 — the 2026-07-22 `module_scope_covers` gap). `VERIFY_DB_URL` lets it dry-run against local first. Also changed: `scripts/prod-migrate.ts` now forwards extra args to `supabase db push`, so `--dry-run` works. **VERIFICATION ON PROD — ALL GREEN.** *(1) Function bodies:* all **23** function definitions in the migration are byte-identical to prod's `pg_proc.prosrc`; every one is SECURITY DEFINER with `search_path=public`. *(2) The three NEW rpcs* (`org_accept_invite`, `org_my_pending_invites`, `org_member_profiles`) on prod carry `postgres=X | service_role=X | authenticated=X` — **no PUBLIC entry, no anon** (anon EXECUTE = false), so the intended ACL genuinely holds ON PROD and the divergence trap was defused by the migration's explicit `revoke ... from public, anon, authenticated` + `grant ... to authenticated`. (Prod's `ALTER DEFAULT PRIVILEGES` also granted `service_role` EXECUTE where local did not — harmless; service_role is the trusted worker role and bypasses RLS anyway.) *(3) Active-gating live:* `is_org_member`, `shares_org_with`, `org_caller_rank`, `is_org_admin` all carry `status = 'active'` on prod, and all **14** module capability predicates (`has_module_role`, `module_caller_covers_rank`/`_role`, `module_caller_can_manage_seat`, `module_has_manager_grant`, `syn_can_write`, `cls_can_manage`, `cls_is_ga`, `cls_is_class_member`, `sal_can_manage`/`_operate`/`sal_is_worker`, `sd_can_organize`/`_staff_event`) route through `is_org_member`/`is_org_admin`. The ONLY function reading `org_members` without a status filter is `org_member_profiles` — **intentional** (admin-scoped; it must show pending invitees). *(4) Schema on prod:* `org_members.status text NOT NULL default 'pending'` + `CHECK (status in ('pending','active'))`, `invited_by`, `invited_at NOT NULL default now()`, `accepted_at`, index `org_members_status_idx`; `profiles.settings jsonb NOT NULL default '{}'`; both new RLS policies present and scoped to `user_id = auth.uid()` (`org_members_select_self` SELECT, `org_members_delete_self` DELETE); RLS still enabled on `org_members`. *(5) BACKFILL CONFIRMED:* prod has **28** `org_members` rows, **ALL** `status='active'`, pending 0, `invited_at` backfilled on every row — cross-checked against the pre-migration backup, whose `org_members` INSERT block has exactly 28 rows with only the 4 pre-slice columns (`org_id, user_id, role, created_at`). Nothing added, lost, or silently left pending. *(6) Column-level ACL:* `profiles.settings` is `authenticated=w` only, and `authenticated` explicitly CANNOT update `profiles.is_superadmin` or `profiles.email` (prod's table-level ACL for authenticated is `ardDxtm` — no `w`), so the column-scoped UPDATE restriction holds on prod and there is **no self-promotion path**. *(7) LIVE BEHAVIORAL TEST on prod, inside a transaction that was ROLLED BACK* (prod data unchanged — 28 rows / 0 non-active verified before AND after): a synthetic **pending ADMIN** invite yielded `is_org_member=false`, `is_org_admin=false`, `org_caller_rank=0`, `shares_org_with(inviter)=false`, the org row NOT SELECTable by the pending invitee, `org_my_pending_invites()` returning exactly the caller's own invite, `org_member_profiles()` returning 0 rows to a non-admin, and `anon` refused on all three new rpcs ("permission denied for function"). After `org_accept_invite()`: `is_org_member=true`, `is_org_admin=true`, `org_caller_rank=2` (= `org_role_rank('admin')`), seat active with `accepted_at` stamped. **TWO PROD-ONLY ACL FINDINGS — both PRE-EXISTING, neither caused by slice 3, both now on the deferred-hardening list.** *(a)* The ~**20 REPLACED** functions kept their pre-existing prod ACL, which includes PUBLIC and anon EXECUTE (`=X/postgres | anon=X/postgres | ...`) — `create or replace` preserves ACLs, so slice 3 neither caused nor worsened this. Effect is harmless (they all key on `auth.uid()`, which is null for anon) but it **quantifies** the already-tracked "platform-wide `revoke PUBLIC` on definer fns" item: **20 of the 23** functions in this one migration are PUBLIC/anon-executable on prod. *(b)* **NEW:** prod grants `anon` **TABLE-LEVEL** INSERT/UPDATE/DELETE on **all 67** public tables (local does not), so **RLS is the only thing between an anonymous request and every table.** Assessed and currently **SAFE**: 0 public tables have RLS disabled; `syn_zmanim_cache` is RLS-on with zero policies (deny-all); of the **197** policies whose roles include public/anon, every write policy resolves to `auth.uid()` or a capability predicate — spot-checked `cls_submission_open`, `sal_owns_customer`, `sd_owns_participant`, `vm_is_conv_admin`, `module_has_manager_grant`, all keyed on `auth.uid()`. Recorded as deferred hardening: revoke anon's table-level write grants on public tables, alongside the `revoke PUBLIC on definer fns` sweep. **Slice 3 is therefore LIVE ON PROD.** **ONE PROCESS MISS, caught after the migration and closed the same session:** the migration went to prod while commit `29c572d` was still only LOCAL, so production was serving the PRE-slice-3 UI against a slice-3 DB. (Mechanism, worth knowing: the Vercel project has NO GitHub link — every deployment is `src=cli`, created by `ci.yml`'s `deploy` job (`needs: check`, prebuilt upload). Nothing reaches prod until a master push goes green.) Consequence on the live site: the deployed `addOrgMember` does `upsert({org_id, user_id, role})` with no `status`, so the new column default + guard made every member-add a **pending invite that the deployed build had no UI to accept** (and `shares_org_with` being active-only meant the pending row rendered with no name/email). Existing 28 active members were unaffected, and no real customers exist yet, so blast radius was nil — but member-adding was effectively broken until the app was pushed. Fixed by pushing the app commit in the same session; the durable rule is now a docs/12 never-do bullet: **never `migrate:prod` a slice whose app commit is unpushed — confirm `git log origin/master..master` is empty before calling a prod push done.** **SECOND MISS, caught by running `pnpm build` as pre-push insurance:** `29c572d`'s message claimed "typecheck 9/9", but the committed tree actually FAILED `tsc` — `supabase.rpc('org_member_profiles')` has no generated row type, so `data` came back `any` and `.find((p) => …)` tripped `noImplicitAny` in `members/page.tsx:44`. Had it been pushed blind, Vercel's build would have failed and prod would have kept serving the pre-slice-3 UI — the worst case given the DB had already moved. Fixed type-only (an exported `OrgMemberProfile` type in `lib/org-members.ts`, mirroring the existing `PendingInvite` pattern, + one cast at the call site); `pnpm typecheck` 9/9 and `pnpm build` green before pushing. Second docs/12 never-do bullet added: **always `pnpm typecheck && pnpm build` before pushing to master.** **End state verified:** `28ddf92` (type fix) + `2d6bcf2` (verifier tooling + this record) pushed, CI green (the `check` job runs typecheck → build → RLS suite → e2e, so the deploy is gated on the real suite), the `deploy` job shipped `2d6bcf2`, and the Vercel API confirms `solutions-platform.vercel.app` is aliased to that deployment — **prod DB and prod app are back in sync.** Remaining slice-3 work (entity-level joinPolicy) and slices 4/5 stay deferred to a founder-initiated session; docs/15 §11 + its decision log updated.
- **2026-07-27 (USER MODEL slice 3 — ORG-LEVEL INVITE-ACCEPT BUILT, Opus session):** `20260727010000_org_invite_accept.sql` — the most tenancy-sensitive slice to date (it edits `is_org_member()`, the predicate the entire platform's RLS leans on). Being ADDED to an org no longer makes you a live member: every add by a signed-in user creates a **pending** invite; the invitee sees a greyed-out dashboard card and becomes a member only when THEY accept (`org_accept_invite`, a definer that revalidates the inviter is still an authorized superadmin/active-outranking member). `org_members` gains `status ('pending'|'active')` + `invited_by/at`, `accepted_at`; existing rows backfilled `active`, future column default `pending` (fail-closed). Because reads/writes all flow through membership predicates, `is_org_member` **and its three siblings** (`shares_org_with` = the profiles email-directory read, `org_caller_rank`, `is_org_admin`) were all gated to `status='active'` — closing the "pending leaks through all three on day zero" trap the Fable pre-review named. **Guard rewrite** (`org_members_guard_hierarchy`): authenticated INSERT forced to `pending` + inviter server-stamped; a **self-accept** carve-out that is safe precisely because no self-UPDATE RLS policy exists (reachable only via the RLS-bypassing definer); a **self-decline/leave** carve-out (own pending or plain-member seat — an active owner/admin still can't self-remove); a **consent block** so no admin can force a pending→active flip on someone's behalf. `org_members_guard_last_admin` now counts active-only (a pending admin invite never holds the floor). New definers `org_accept_invite` + `org_my_pending_invites` (name-only card, explicit `revoke ... from public,anon,authenticated` + grant to authenticated); additive `org_members_select_self`/`_delete_self` policies. **Full docs/03 #12 rhythm with a 2-reviewer adversarial fan-out — and it earned its keep.** Reviewer A (guard logic/regressions): CLEAN — traced consent-bypass (upsert/re-point/DELETE+re-INSERT), self-accept reachability, self-leave, last-admin-with-pending, and every pre-existing rank-ladder flow; no defect. Reviewer B (leak-hunt): **found a CRITICAL systemic leak the first draft missed** — I'd gated only the generic module predicates, but slice-2b had redefined ~10 **coarse/shared** functions to read `module_roles` DIRECTLY (so scoped staff reach consoles): `cls_can_manage`, `cls_is_ga`, `cls_is_class_member`, the SHARED write-path `module_caller_can_manage_seat` + `module_has_manager_grant`, and the latent `sal_can_manage/operate/is_worker` + `sd_can_organize/staff_event`. A pending-or-non-member holding a grant could have reached classroom **Storage buckets (student PII)**, created courses, read class content, and **staffed other users**. Gated all ten on active membership (plus the inline `syn_can_write` I'd already caught in self-review) — this finally delivers the long-deferred **"a module_roles grant implies (active) org membership"** invariant, platform-wide, at the point of use. The precise per-row functions were already safe (extraction re-folded them onto the now-gated generics). **Superadmin choice (founder decision 2026-07-27):** the platform owner may add **immediately-active OR pending, per-add**, with a saved per-profile default (`profiles.settings.superadminDefaultAddActive`) — "the superadmin should control everything"; org admins can only ever invite (guard-enforced). App layer: dashboard invite cards + accept/decline/leave, members-panel pending badge + "Invite" label, Owner-Console add-active toggle + a "my default" control; `inviteOrgMember`/`changeMemberRole`/`acceptOrgInvite`/`getPendingInvites` helpers; seed flips all seeded members to active (invite-accept is exercised by tests, not the seed). **Verified: RLS 50/50** (8 new invite-accept tests: pending-invisibility, consent-no-force-activate, accept/decline/leave, inviter-revalidation, the module-capability gate incl. `syn_can_write` + classroom coarse gate + shared `module_roles` write path, superadmin immediate/pending/admin-forced-pending), plus the pre-existing suite green after fixing setups to invite→accept; **typecheck 9/9; e2e** updated (org self-management "Invite" + pending badge, new invite→accept dashboard test). **DEFERRED to a follow-on pass: entity-level joinPolicy** (invite-only/request-approval/open per class/location/event); org-level request-to-join is a NETWORK feature (gated by `orgs.kind`), not a client-org one. **NOT yet pushed to prod** (as of this session; local-verified) — *pushed + prod-verified the next day, see the 2026-07-28 entry above.*
- **2026-07-26 (USER MODEL slice 2 — speed-dating scope-awareness BUILT, Opus session):** `20260726030000_speed_dating_scoped_authority.sql` — THIRD real multi-entity module scoped (events), first to fully use the extracted generics. `sd_events` gains `scope_node_id` (flat ROOT nodes, trigger-minted + backfilled); other `sd_` tables carry `event_id`. Ranks admin=3/organizer=2/host=1/participant→0. Precise `sd_can_organize_event`/`sd_can_staff_event_of` delegate to `module_caller_covers_rank/role`; coarse `sd_can_organize`/`sd_can_staff_event` redefined off `module_roles` for console entry; `module_can_manage('speed-dating')` global-only. Rewrote 7 `_write_organize` (6 event-scoped + `sd_events` 3-way split), 7 selects, 2 `_update_staff`, 3 pin triggers, and — privacy-critical — the mutual-match reveal `sd_reveal_matches` (now `sd_can_organize_event(ev_org, event_id)`, org derived from the event row → only an organizer of THAT event reveals its matches). Existing grants stay global (no forced migration; no membership-inflation vector — participant access keys off `sd_participants` rows, not grant coverage). `sd_blocks`/`sd_bans` stay org-wide; no storage buckets. **Process: agent-drafted (context conservation) → I read it line-by-line → 2-reviewer adversarial fan-out, both SHIP** (tenancy+privacy: coverage/policy/reveal-privacy all correct; escalation: self-escalation impossible, flat-tree branch-B bounded, gate excludes host/participant, cross-event blocked). **N1/L1 CLOSED:** `sd_events` INSERT hardened to org-admin-or-GLOBAL-admin/organizer (matching salon), so a future scoped organizer can't spawn orphan events. **N2/L2 documented not changed** (pre-existing, non-exploitable: `_event` wrappers trust the org arg — every call site passes a self-consistent pair, returns only a boolean; + implicit PUBLIC-execute on new definer fns, fail-closed for anon — both belong to the deferred platform-wide `revoke PUBLIC` sweep). Verified: RLS 37/37 (+4 event-scoped tests as real users), e2e 34/34, typecheck+build; **8/8 prod checks; PUSHED to prod (4cbafd0).** **Slice-2 real multi-entity modules DONE + LIVE (classroom, salon, speed-dating) + the shared scope-authority engine extracted (module_caller_covers_rank/role).** **NEXT (deliberately deferred to a fresh chat, 2026-07-27, to conserve usage — this conversation had grown very large):** the three single-global-entity modules (matchmaking/synagogue/visual-messaging) are NOT yet rank-mapped. **Correction to an earlier note: mapping their ranks is NOT cosmetic** — it activates the guard + the rank>=2 write-gate, so e.g. a matchmaking 'admin' would gain the ability to grant sub-roles (matchmakers) directly (today org-admin-only). That's a real behavior change needing the full docs/03 #12 rhythm, for marginal value (single entity = no scope tree to enforce). So it's OPTIONAL/do-when-a-concrete-need-arises, not a clear win. Higher-value candidates for next session: the founder's view-as / role-clarity gaps (testing-round items 31–42), or slice 3 (join policies + invite-accept, docs/15 §11). Everything above is durably recorded here + docs/15 (decision log) + docs/03 #16 (the scope-authority convention) — a fresh chat loses nothing.
- **2026-07-26 (SCOPE-AUTHORITY EXTRACTION — shared engine, Opus session):** `20260726020000_module_scope_authority_extraction.sql` factors the per-row scope-authority logic (hand-rolled twice: classroom + salon) into two generic platform primitives — `module_caller_covers_rank(org, module, node, min_rank)` + `module_caller_covers_role(org, module, node, role)` (is-org-admin OR a grant of sufficient rank/role whose scope COVERS the node). All 6 classroom+salon functions collapse to one-line wrappers (resolve entity→`scope_node_id`, delegate); signatures unchanged ⇒ zero policy/trigger churn. Now the scope-authority LOGIC is one shared place (like the guard) — a new module writes one-liners; see docs/03 #16. **Behavior-preserving:** RLS 33/33 + e2e 34/34 unchanged. **Equivalence review (subagent) SHIP-WITH-CHANGES:** caught a missing-entity divergence (a non-admin GLOBAL grant wrongly covered a null node via `module_scope_covers(null,null)=true`) — inert (RLS always passes a real FK) but fixed exactly with a `check_node is not null` guard so a missing entity → `is_org_admin` only, matching the original JOIN. Coarse entry gates left per-module (smaller future tidy). Committed + prod-pushed. **Speed-dating slice 2 is next** (events as the entity; survey done — it's fully org-wide today like classroom/salon were, no existing grant-scoping; the mutual-match reveal `sd_reveal_matches` + `_write_organize` policies + pin triggers become event-scoped via the generics).
- **2026-07-26 (USER MODEL slice 2 — nail-salon scope-awareness BUILT, Opus session):** `20260726010000_nail_salon_scoped_authority.sql` applies the classroom pattern to the salon's org → **location** tree (2nd module scoped; pattern proven reusable). `sal_locations` gains `scope_node_id` (locations are flat ROOT nodes); every other `sal_` table already has `location_id` so its node resolves via `sal_locations`. `module_position_rank` gains salon vocab (admin=3/manager=2/cashier=1/worker=1/customer→0); precise `sal_can_manage_location`/`sal_can_operate_location` gate every per-row policy + both lifecycle triggers (`sal_pin_appointment`/`sal_guard_bill`); coarse `sal_can_manage`/`_operate`/`sal_is_worker` redefined off `module_roles` for console entry only; `module_can_manage('nail-salon')` tightened to admin-or-global-manager. **Simpler than classroom:** uniform `location_id`, no storage buckets, and NO forced grant migration — existing grants stay GLOBAL (= org-wide, unchanged; no `cls_is_class_member`-style inflation vector since customer/worker access keys off `sal_customers.user_id`/`worker_id`, not grant coverage). **2-reviewer adversarial fan-out run IN PARALLEL (founder's subagent guidance) — both SHIP:** no cross-tenant/cross-location hole (coverage direction correct, all 12 write + operate/select policies + both triggers location-precise, own-row arms verbatim, node SET-NULL fails closed); no escalation (manager self-escalation impossible; flat tree makes scoped-admin self-replication + peer tampering structurally impossible; gate excludes cashier/worker/customer; cross-module double-keyed; re-point defense holds). **One reviewer note CLOSED — deliberate divergence from classroom:** salon `sal_locations` INSERT gated on org-admin OR GLOBAL admin/manager (`has_module_role`), so a location-scoped manager can't spawn empty unmanageable locations (creating a STORE is business-level; salon has an admin tier). Verified: RLS (+ salon scoped-authority tests as real users), e2e, typecheck+build. **FOLLOW-ON (not built):** a "manager assigns staff to a location" UI (salon analogue of classroom enrollment) + multi-location console surfacing. **Remaining slice-2 modules** (speed-dating events; matchmaking/synagogue/VM single-global-entity) not yet mapped.
- **2026-07-24 (USER MODEL slice 2b BUILT — classroom scope-awareness, Opus session):** `20260724010000_classroom_scoped_authority.sql` makes classroom authority scope-aware and folds enrollment into scoped grants. `cls_courses`/`cls_classes` gain `scope_node_id` (course node = root, class node = child; minted by BEFORE-INSERT definer triggers, backfilled); new PRECISE functions `cls_can_manage_class/_course` + `cls_is_ga_class/_course` gate every per-row DB policy via `module_scope_covers` (a GLOBAL grant covers all → global professors unchanged; a course-scoped grant covers its classes; class-scoped covers one class). `module_position_rank` is now per-module (2-arg; classroom professor=2/ga=1/student=1, generic fallback for all else); the coarse write gate `module_has_manager_grant` dropped rank≥3→≥2 so a professor enrolls within their scope (resolves N2); guard callers repointed. `cls_is_class_member` reads SCOPED grants (enrollment authority = one source; the cls_class_members roster is demoted to a name/badge store). Existing global professor/GA grants stay global; student rosters migrated to scoped grants. `enrollClassMember`/`removeClassMember` write the scoped grant (authority) + roster row together. **Full docs/03 #12 rhythm, 2-reviewer adversarial fan-out:** Reviewer A (tenancy) SHIP-WITH-CHANGES — no cross-tenant hole; 5 findings fixed incl. **the must-fix F1** (cls_courses/cls_classes INSERT WITH CHECK self-referenced its own table → non-admin professors couldn't create courses/classes, masked in demo by owner-professors; split INSERT from UPDATE/DELETE + regression test), F2 (global-student footgun → cls_is_class_member requires scope_ref not null), F3 (export-controls/survey-results tightened off the coarse fn), F5 (node triggers own scope_node_id). Reviewer B (escalation) SHIP — gate lowering inert for the 6 other modules (roles rank 0), professors can't self-escalate/mint co-professors (branch B dead for classroom), no regression; 2 low notes mitigated (N3 neutralized by F2; N4 closed by an org-membership assertion in enrollClassMember). **Verified: RLS 30/30 (+5 scoped-authority tests as real users), e2e 34/34, typecheck+build clean.** **KNOWN LIMITATION:** storage (cls-submissions/materials/exams) stays ORG-scoped (bucket path = org_id, not class) — a scoped professor could fetch another class's file by path, but the DB rows exposing paths are class-scoped so paths aren't app-discoverable; per-class storage scoping + the general "module_roles grant implies org membership" invariant are documented follow-ons. **Committed local; prod push bundles 2a+2b (next).** Slice 2 remaining modules (mm/salon/speed-dating/etc. vocabulary) NOT started — classroom is the exemplar.
- **2026-07-24 (USER MODEL slice 2 STARTED — 2a: module_roles surrogate PK, Opus session):** Founder initiated slice 2 (per-module vocabulary), classroom first, built in two verified stages. **Stage 2a shipped + committed (local only, NOT pushed):** `20260723010000_module_roles_scoped_pk.sql` replaces `module_roles`' composite PK `(org,user,module,role)` with a surrogate `id`, moving the identity invariant to a `UNIQUE ... NULLS NOT DISTINCT` index on `(org,user,module,role,scope_ref)`. This permits MULTIPLE scoped grants per (user,role) — student@Math203 AND student@Bio49, the normal case once 2b folds enrollment into scoped grants — while NULLS NOT DISTINCT keeps at most ONE global grant per (user,role), byte-identical to the old composite-PK invariant for every existing (all-global) row. Purely structural/additive: no FK references the old PK; the two guard triggers + five RLS policies key on columns (unaffected); all existing data accepted unchanged. Upsert call sites (app `org-members.ts`, seed via a new `upsertModuleRoles` helper, tests) now name the conflict target explicitly (`onConflict: org_id,user_id,module_key,role,scope_ref`) since the implicit target was the composite PK. **Full rhythm:** RLS **25/25** (+1: multiple scoped grants legal / duplicate global rejected / upsert idempotent), reseed-idempotency re-verified, typecheck clean, schema.ts mirror updated → **independent adversarial security review: SHIP AS-IS** (no RISK findings; 3 info notes — last-Director guard conservatively over-blocks a hypothetical double-director, latent; `id` is authority-inert; a slice-2 reminder that reads assuming one-row-per-identity could break, but none exist today). **Holding the prod push to bundle with 2b** (2a alone is dark — no user-visible change, no prod test value). **Stage 2b (classroom scope-awareness + enrollment-as-scoped-grants) is NEXT, design fully locked** in docs/15's log (2026-07-24): rank Director 4/Coordinator 3/professor 2/GA 1/student 1 (GA & student PEERS); enrollment unifies into scoped grants (Option A) retiring the module_roles-vs-cls_class_members split (testing-round items 29–30); global professors stay working (scope-aware `cls_can_manage`/`cls_is_ga` treat a global grant as covering all); "more-involved GA" = gradebook-weight/visibility knob, not a hierarchy change; classroom has ~no real prod users so 2b's enforcement change is demo-blast-radius. Rank mapping stays per-module + COMPUTED (not stored) so future re-mapping is a one-line migration, no backfill.
- **2026-07-22 (USER MODEL slice 1 — branch-B decision applied + slice 1 PUSHED TO PROD, Opus session):** Founder resolved the open question the Fable re-review left below: **branch B of the two-branch module-grants guard (same-position + strict-scope containment) is now restricted to the Coordinator tier only** — `module_position_rank(seat_role) = 3` added to branch B in `module_caller_can_manage_seat` (keyed on the rank NUMBER, not the literal `'coordinator'`, so slice 2's per-module vocabulary at that tier is covered automatically). Reasoning: a Director already dominates any Coordinator via branch A (rank + coverage), so this costs Director no real capability — it only removes Director SELF-REPLICATION (a non-admin Director minting more Directors at sub-scopes on its own), matching §2.2's "Director is org-appointed, not Director-spawned". Coordinator→Coordinator sub-scope chains (STEM→Math) are unaffected. Full docs/03 #12 rhythm re-run: RLS **24/24** (+1 new test — a non-admin director is rejected minting a director via branch B, still succeeds appointing a coordinator via branch A), 4/4 live assertions as real users, typecheck+build clean, e2e **34/34**. **Then PUSHED slice 1 to prod** (backup first → `migrate:prod`) — `20260720010000` + this refinement are now live on prod. **A prod-only ACL gap surfaced during post-migrate verification and was fixed forward as `20260722010000`:** the 2026-07-20 "revoke PUBLIC" fix on the two ancestry oracles (`module_scope_covers`/`module_scope_strictly_contains`) **did not actually close the gap on prod** — prod's `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` grants `EXECUTE` DIRECTLY to `anon`/`authenticated`, which `revoke ... from public` does not remove, so both oracles stayed anon-executable on prod while local (lacking that default) showed them closed. The local RLS suite structurally can't catch this. Fixed with explicit `revoke ... from public, anon, authenticated`; re-verified live on prod (proacl now `{postgres, service_role}`, `anon`/`authenticated` denied; guard suite still 24/24). Low practical severity (boolean ancestry oracle over node UUIDs only org members can read) but exactly the defense-in-depth closure intended. **Two conventions added to docs/03 #1:** state the FULL intended ACL on functions explicitly (never rely on a default privilege for a security boundary — for functions the prod default is MORE permissive than local, so the failure is silent locally); and verify security-sensitive ACLs against PROD, not only local. The deferred platform-wide "revoke PUBLIC on definer functions" pass must therefore revoke from `public, anon, authenticated` and verify against prod. Slice 2 (per-module vocabulary) is the agreed next build — **founder initiated it this session**, starting with classroom.
- **2026-07-20 (USER MODEL slice 1 — Fable re-review pre-push, two fixes applied):** Founder had 2% weekly usage left with free Fable access for it and asked to spend it on a dedicated top-tier re-review of the slice-1 migration below (the build-time review had run on a cheaper model) before it gets pushed. Verdict: SHIP WITH CHANGES, both applied directly to the still-unpushed `20260720010000` migration: **(1)** the org_id/module_key re-assignment pin on UPDATE was only enforced for non-admins — an admin of TWO orgs could move a grant's org_id between them (not an escalation, since they already control both, but a real gap vs. the migration's own stated intent) — moved the pin to fire unconditionally, before the admin bypass. **(2)** `module_scope_covers`/`module_scope_strictly_contains` (the two ancestry-check functions) took bare node ids with no identity check, and — this is the notable general finding — **PostgreSQL grants EXECUTE to PUBLIC on every function by default at creation**, so the original `grant ... to authenticated` line never actually restricted anything; PUBLIC already covered the fully unauthenticated `anon` role. Fixed with an explicit `revoke ... from public`. **Verified via `pg_proc`/`has_function_privilege`: every security-definer function ever shipped on this platform has this same implicit anon-EXECUTE grant** — not an emergency today, since nearly all of them key on `auth.uid()` (NULL for `anon`) and fail closed, but a real, previously-unnoticed gap between what the `grant ... to authenticated, service_role` lines scattered through every migration appear to enforce and what Postgres actually enforces. **Deliberately NOT fixed platform-wide this pass** — flagged as a dedicated future piece of work (revoke PUBLIC explicitly wherever a function doesn't already fail closed on identity), not bundled into slice 1. Also recorded an open founder decision surfaced by the review: branch B of the two-branch guard is currently rank-agnostic, so a plain `director`-grant holder (not an admin) can independently mint scoped sub-director grants — bounded (stays in one org+module; the admin escape hatch can always revoke) but real, and worth deciding before slice 2 gives modules real Director grants. Re-verified: 21+8=29 live assertions as real users, RLS 23/23, typecheck+build clean. Details in docs/15's decision log (2026-07-20, "slice 1 re-reviewed on Fable"). Still unpushed/unmigrated to prod.
- **2026-07-20 (USER MODEL slice 1 BUILT — module grants generalization, Opus session):** First build off docs/15: `20260720010000_module_grants_scope.sql` generalizes flat org-wide `module_roles` into **scoped grants** (user, position, scope), per docs/15 §11 slice 1. New **`module_scope_nodes`** per-module entity tree (trigger-computed materialized path of node ids for O(prefix) ancestry coverage; re-parenting/re-keying deferred to slice 2 and actively blocked by the path trigger); `module_roles` gains **`scope_ref`** (null = global; FK `on delete cascade`, deliberately NEVER `set null`) + **`granted_by`** (audit pointer; server-stamping/pinning is slice 4). Immutable **`module_position_rank()`** maps ONLY the generic tier vocab (director=4/coordinator=3/lead=2/position=1) — every shipped role string (professor/ga/cashier/single/maker/…) stays unmapped→rank 0→invisible to the ladder, which is what makes the whole slice **purely additive**. Ported the org hierarchy guard as **`module_roles_guard_hierarchy`** implementing docs/15 §4's two-branch rule (strictly-outrank+scope-coverage OR same-position+strict-scope-containment), with all 9 §4.1 hardening items: old+new scope checked on UPDATE (re-point defense — same bug class as the 2026-07-16 org guard), **unconditional** scope-node tenancy validation (before any bypass), total null predicates (`module_scope_covers`/`module_scope_strictly_contains`), plus **`module_roles_guard_last_director`** (org owner/admin/superadmin exempt = the §2.2 escape hatch; latent in slice 1). Additive `module_roles_{insert,update,delete}_module_manager` RLS policies (coarse `module_has_manager_grant` gate + trigger tightening, mirroring `org_members_write_org_admin`); **`has_module_role()` hardened to `scope_ref is null`** so a scoped grant (e.g. professor@CS101) can NEVER leak module-wide authority through the 7 shipped modules' legacy scope-blind policies (behavior byte-identical today — every existing grant is global). **`is_org_admin` bypass retained in the module guard on purpose** — it's the legacy coupling docs/15 §9 unwinds later; keeping it is what preserves today's behavior. **Full docs/03 #12 rhythm, no shortcuts:** draft → independent adversarial security review (verdict **SHIP AS-IS**; one low-sev defense-in-depth fix applied — admin bypass evaluated on `old.org_id` for UPDATE/DELETE; N1/N2 recorded as slice-2 items in docs/15) → applied → **live-verified 28/28 as real users** (two-branch guard, re-point defense, cross-tenant scope pointer rejection, scoped-grant-no-global-leak, own-seat block, sibling/peer non-touch, escape hatch) → tracked RLS tests (**23/23**, +6 new) → schema.ts mirror + docs updated. **Composite PK kept unchanged** (scope_ref is a non-key column ⇒ one scope per (user,module,role) for now — multiple scoped grants is a slice-2 concern). **Slice 2 (per-module ladders/vocabulary) NOT started** — do not begin without the founder initiating. e2e/typecheck/build verification: see below.
- **2026-07-20 (THE USER MODEL captured — design doc, nothing built):** Multi-day founder design discussion distilled into **[docs/15-user-model.md](docs/15-user-model.md)** — the target model for roles/permissions platform-wide. Spine: org layer (built rank ladder, now decided to be INDEPENDENT of module authority) + a generic four-tier module ladder (module Owner → Coordinator → Entity Lead → entity positions), where every grant is **(user, position, scope)** against a module-local **nestable entity tree** (dept → course → class; scope coverage = ancestry walk; dept-chair = coordinator scoped to a subtree; "global professor" vs "course professor" collapse into one position at different pin heights). Key founder calls recorded there: manage-ladder ≠ view-as graph (GA/student are rank-PEERS with distinct data surfaces); single-global-entity pattern for matchmaking/synagogue; per-entity join policy (invite/request/open — generalizing VM's built joinPolicy); per-module default positions on join (matchmaking deliberately none); view-as via per-position tabs bounded by the role-surface rule (never a person's private layer) with UMember write-audit as v1; the `is_org_admin()`-inside-`_can_manage` coupling becomes legacy to unwind. Enforcement = the already-shipped org-hierarchy guard reused with a scope dimension. Build sequencing sketched in the doc (5 slices, all Opus + docs/03 #12 when built). **Founder has a few remaining tweaks pending — treat the spine as settled, details adjustable. Do NOT start building from it without him initiating.** **Same session, before Fable access expired:** three independent Fable red-teams reviewed every novel security design pre-build — findings folded in as **binding spec** (docs/15 §4.1 guard hardening — headline: UPDATE must check old AND new scope, the re-point bug class again; §8.1 view-as hardening — headline: view-as never widens RLS, mode 2 read-only v1, matchmaking/speed-dating impersonation banned) and as **[docs/16-network-features-review.md](docs/16-network-features-review.md)** (Public Square / cross-org switching / Redt-It tenancy review — headline: `profiles_select_shared_org` makes any platform-wide org an email directory, must be scoped first; pending≠member across is_org_member/shares_org_with/org_caller_rank; member self-leave carve-out needed; trust-class `client|network` org principle proposed; the cross-org switcher is approved-shape and Sonnet-buildable now). docs/16's checklist items are OPEN founder decisions; §4.1/§8.1 bind their slices. Slice 1 must implement §4.1 items 1–9.
- **2026-07-17 (org role hierarchy — superadmin>owner>admin>member, Opus session):** Founder decided the three org roles should be a real RANK ladder (they'd been flat "owner=admin" until now). Migration `20260717010000_org_role_hierarchy.sql`: `org_role_rank()` + `org_caller_rank()` helpers and an `org_members_guard_hierarchy` trigger — a caller may create/change/remove an org_members seat only if they STRICTLY outrank both its current and target role. So only superadmin creates owners; owner manages admins+members (not other owners); admin manages members only (can't mint/touch admins/owners); member manages no one; nobody touches their own seat. **This subsumed and REPLACED the 07-16 self-seat guard** (dropped in the same migration — equal-rank self-action is now blocked by the general rule) and definitively answers the earlier "can an admin touch another admin?" question (no). `is_org_admin()` is UNCHANGED (owner OR admin) so both keep full ORG management (settings, module-role grants) — the founder's "admins keep full powers" call; the ladder governs only org_members management. **Full docs/03 #12 rhythm**: independent adversarial review (SHIP AS-IS — no escalation/leak/lockout; noted two intended behaviors: owner can't self-toggle owner↔admin, and an all-admin no-owner org needs a superadmin to manage admins). Seed changed: alice is now `owner` (not admin) of all her demo orgs, so she can demonstrate the full ladder. UI: the members panel (shared by the org page + superadmin console) now offers only assignable roles (below the caller's rank) and shows non-manageable rows (incl. your own) as static text; console passes `SUPERADMIN_RANK`. RLS 17/17 (hierarchy test rewritten), e2e green, typecheck+build clean. Also this session: Owner Console gained an org **rename** field; matchmaking matches-list email-leak fix; `founder-todo.md` set up as the running "asks for the founder" doc (counterpart to `founder-feedback.md`, both gitignored). **Module-role hierarchy (professor grants GA/student) is the agreed NEXT piece** — separate per-module design, not built yet.
- **2026-07-16 (org self-seat guard — Opus session):** Founder-approved fix from the testing round: an org owner/admin could demote or remove their OWN seat (the pre-existing last-admin guard only blocked reaching ZERO admins, so a two-admin org's admin could still self-lockout). Migration `20260716030000_org_self_seat_guard.sql`: `org_members_guard_self_admin` trigger blocks a non-superadmin from demoting/removing (or re-pointing) their own owner/admin seat; co-admin and superadmin escape hatches preserved, owner↔admin lateral self-change still allowed. Full docs/03 #12 rhythm: independent adversarial review (verdict SHIP WITH ONE CHANGE — caught a re-point bypass where a crafted UPDATE moves user_id/org_id while keeping role=admin; closed it, mirroring the sibling last-admin guard's re-point defense), live-verified 8/8 as real users (incl. the two-admin isolation case proving it's the self-guard not the last-admin guard), tracked RLS test (17/17) + e2e added. UI: the members page hides your own row's role/remove controls (shows "(you)"), superadmin console unrestricted. **Deliberately did NOT build** the founder's related musing that an admin shouldn't demote OTHER admins — conflicts with owner=admin identity + org self-management; flagged back as an open question (would need a real owner>admin hierarchy decision). e2e 34/34, RLS 17/17, typecheck+build clean.
- **2026-07-16 (speed dating: two-sided capacity-count bug fixed — Opus session):** Closed the RLS-invisible-read bug flagged in the previous entry. Migration `20260716020000_speed_dating_side_capacity_count.sql`: `sd_side_registered_count(event, side) → integer` definer function so `registerForEvent`'s per-side capacity check works — a fresh registrant's own session can't see other participants' rows (`sd_participants_select` is own-row/staff/paired-with only), so the count goes through the RPC, which returns ONLY the integer (never rows/identities) and gates on `is_org_member` (org derived through the event row) so a non-member always gets 0. Full docs/03 #12 rhythm: drafted, independent adversarial security review (SHIP AS-IS), applied + live-verified 5/5 as real users (load-bearing case: a *different* member gets the true count via the RPC while their direct RLS-scoped query sees 0), tracked RLS test added (non-member gets 0), e2e `test.fixme` un-skipped → now a real passing capacity/waitlist/promotion test. Both `registerForEvent` and `promoteNextWaitlisted` route the count through the RPC (one source of truth). RLS 16/16, e2e 33/33, typecheck+build clean. **This was the correct Opus slice** (migration + RLS + tenancy); routine work switches back to Sonnet.
- **2026-07-16 (speed dating: two-sided capacity/waitlist — base built on Sonnet, a real capacity-count bug found and left for Opus):** Scoping "waitlist auto-promotion" (a named remaining item) surfaced that pool sides were never actually used anywhere in the app — `pool_side` was never set by any registration flow, so every event ran as one undifferentiated pool regardless of the schema's two-sided support. Stopped and asked the founder how to proceed rather than silently building a bigger feature than scoped; founder chose to build sides properly, with explicit answers to four design questions (self-select side at registration; opt-in per event, single-pool stays default; fully custom side labels, not hard-coded Men/Women; capacity lowered later grandfathers in existing registrants). Explained the concrete failure mode a naive single-cap waitlist would hit (an all-one-gender accepted pool, unusable for hetero pairing, purely from registration-order luck) before building, so the founder had the real tradeoff in view. Shipped: `modules/speed-dating/ui/event-format.ts` (opt-in two-sided config, no migration — `format` is Zod-validated-at-write-site jsonb), a side selector at registration, per-side registered/waitlisted counts + labels in the staff roster, a `promoteNextWaitlisted` staff action. **Two real RLS-invisible-read bugs caught by e2e in this one pass, same shape as the nail-salon time-off gap**: (1) promotion can't be triggered from the withdrawing participant's own action — `sd_participants_update_self` only lets someone write their OWN row — so it's staff/organizer-triggered instead (organizer-only specifically: the pin trigger lets a plain host only *remove* someone else's seat, not promote them); (2) deeper — the capacity COUNT itself runs under the registering participant's own session, and `sd_participants_select` only lets a participant see their own row, so the count always sees zero other registrants and capacity enforcement silently never triggers. Confirmed live: a second registrant on a capacity-1 side was wrongly accepted as `'registered'`. **Correctly stopped and did not fix this on Sonnet** — needs a `SECURITY DEFINER` count function (matching `sal_worker_has_time_off`'s pattern from the same day), queued for Opus. Intended behavior captured as `test.fixme(...)` (un-skip alongside the migration); a separate, real, passing test covers what works today. e2e 32/33 passed (1 fixme, expected), RLS unchanged 15/15, typecheck+build clean.
- **2026-07-16 (two future modules proposed, documented as DRAFTS — not scoped, not built):** Founder proposed two new modules to plan once current work settles: `docs/modules/module-7-redt-it-DRAFT.md` (a human-curated matchmaker-suggestion network — shadchan makes a two-second suggestion, both singles thumbs up/down, mutual yes reveals contact; needs its own reputation/ranking design for anti-spam, several open questions on irreversibility semantics and the invite-a-stranger flow, and a real tenancy-model decision since it implies a platform-wide singles pool unlike every existing per-org module) and `docs/modules/module-8-energy-analytics-DRAFT.md` (porting 2-3 analysis views from the founder's day-job C# app NEAT into a new module backed by Python analysis code in a separate `artispy` repo — **corrected one assumption**: NEAT is genuinely C#, but the referenced `artispy` analysis code is Python, not C#, which changes the porting-strategy question; flags a real file-level investigation still needed — reading NEAT.Web's actual chart pages and the two named Python libraries — before this can be scoped). Founder explicitly leans toward keeping Redt-It, Make-a-Match, and Speed Dating as separate user pools rather than shared profiles — recommended agreeing with that lean, reasoning grounded in the existing per-org tenancy model and the "modules never import each other" hard rule, not just agreement. **Do not start building either — pick this up only when the founder is ready for a dedicated planning session.**
- **2026-07-16 (speed dating: lobby/live-round UI shipped — Sonnet, no migration):** Next module tackled after Nail Salon reached zero known code gaps — a fresh survey confirmed video specifically needs the VPS decision, but a live "who am I paired with right now" display doesn't. New **"Right now" panel** on the participant's event page (shown while `running`): current partner (or bye, or "not checked in") with a live countdown to round end, computed from `sd_rounds.ends_at` — **real finding**: the schema's `'break'` round state is in the CHECK constraint but never actually written by the orchestrator (a round stays `'active'` through its whole round+break window; only `ends_at` distinguishes the two), so the panel infers round-vs-break from `now` vs `ends_at`/`ends_at + break_duration_seconds` client-side rather than trusting `state`. **Real bug caught and fixed before it shipped as working**: the manual "Run next round" button (`runPairingRound`, the pre-worker organizer stand-in used in every deployment without the worker running, and by e2e) never set `ends_at` — only the orchestrator did — so the new countdown would have silently shown nothing for every manually-advanced round. Fixed by mirroring the orchestrator's `ends_at` calculation there too; the display also degrades gracefully (shows the pairing, omits the timer) if `ends_at` is ever still null. Small bonus: a `lobby_opens_at`-driven "lobby is open" banner (that column existed since 2026-07-09, never read anywhere). Auto-refresh via a tiny client component polling `router.refresh()` every 15s — matches the platform's existing poll-not-push rhythm (matchmaking rescore, this module's own orchestrator) rather than wiring up Realtime for one panel. e2e extended (not new tests): both speed-dating tests re-verified passing. typecheck+build clean. See docs/modules/module-6-speed-dating.md.

- **2026-07-16 (nail salon: customer-path availability fix — Opus session, full security rhythm):** Closed the flagged gap from the base feature below. Migration `20260716010000_salon_worker_availability_check.sql`: a `SECURITY DEFINER` function `sal_worker_has_time_off(worker, location, window_start, window_end) → boolean` so the CUSTOMER self-booking path honors a worker's time off. Root cause: `sal_worker_time_off`'s SELECT policy is operate-tier-or-self only (its `reason` can be sensitive), so a customer's RLS-scoped read returned empty and the check no-opped — enforcement worked for operator/walk-in bookings but not customer self-booking. Fix returns ONLY a boolean (reveal-only-the-answer, like `mm_shared_answers`), never widening the read policy; the org is derived through the worker's own profile/location chain and gated on `is_org_member`, so a non-member always gets `false` and can't probe another tenant. **Ran the full docs/03 #12 rhythm**: drafted the function, spawned an independent adversarial security-review agent (verdict SHIP AS-IS — no cross-tenant leak, only a boolean escapes, overlap predicate correct), applied + live-verified 4/4 as real users, added a tracked RLS test for the non-member-gets-false tenancy property. All three booking paths now route the time-off check through the RPC (weekly-schedule half stays in TS — every member can read `weekly_schedule`, RLS never blocked it). RLS 15/15, e2e 31/31 (the availability test extended to cover both operator AND customer paths), typecheck+build clean. **Model note: this was the correct Opus slice** (migration + RLS + tenancy-critical); routine UI/feedback work should switch back to Sonnet.
- **2026-07-16 (nail salon: per-worker availability windows built — real gap found by the e2e test itself, fix needs Opus):** Founder asked which module to push toward "complete" next; verified via a fresh Explore-agent survey (not memory) that of Nail Salon / Speed Dating / Visual Messaging, Nail Salon had the only remaining gap that was pure code (no VPS/decision blocking it — Speed Dating needs the video-hosting call, Visual Messaging needs the org-auto-group-vs-ad-hoc call). No migration needed for the base feature: `sal_worker_profiles.weekly_schedule` / `sal_worker_time_off` already had schema+RLS+security-review from 2026-07-09; this closed the app-logic gap the migration's own INTEGRATION NOTE flagged. New `modules/nail-salon/ui/availability.ts` (pure functions, no supabase-js): an empty/unset schedule = unrestricted (so shipping this didn't retroactively make every existing worker unbookable); once a manager sets any day, unset days mean "not working" — enforced only when a SPECIFIC worker is requested (no assignment engine exists, so "Any worker" bookings still skip the check). Manage console gains **Worker schedules** (one text field per day, `HH:MM-HH:MM` comma-separated ranges — mirrors the exam problem-structure text-parsing convention rather than a heavier component) + time-off add/remove, wired into all three booking entry points. **Confirmed no notification/email primitive exists anywhere on the platform** before considering "booking reminders" — correctly left that out rather than inventing a platform primitive speculatively for one module. **The e2e test itself caught a real bug before it shipped silently**: the customer self-booking path's availability check always passes trivially — `sal_worker_time_off_select`'s RLS policy only lets operate-tier callers or the worker themselves read time-off rows, so a customer's own session gets an empty read (not an error) and the check no-ops. Enforcement genuinely works for operator/walk-in bookings (verified live via e2e, alice booking dana during her time-off is correctly rejected); the customer path is a documented, flagged gap (see module-5 spec) needing a `SECURITY DEFINER` availability-check function — a migration, correctly NOT pushed through on Sonnet per docs/03 #12. e2e 31/31 (test rewritten to cover the path that actually works + document the one that doesn't), typecheck+build clean. Also documented (not built) a design sketch for the matchmaking mutual-introduction open question (matchmaker-only reveal alternative) — still awaiting the founder's actual decision. **Model-switch flag: the customer-path fix above needs Opus 4.8+ — recommend switching before that specific slice.**
- **2026-07-16 (the three 2026-07-12 in-flight RLS items VERIFIED + their UIs shipped — resume finished):** The 2026-07-12 Opus session's three uncommitted migrations were re-verified live (21/21 as real users via `verify-migrations.mjs`) and their UIs built, regression'd, committed, and pushed. **The 2026-07-12 "GoTrue rate-limiting" diagnosis was WRONG**: the verifier itself had a bug — `as('alice')` passed the bare handle straight to `signInWithPassword` without appending `@demo.local`, so every sign-in was a genuine 400 for a nonexistent user (fast-fail ~10ms vs a real bcrypt check ~130ms — that timing difference in GoTrue logs is what exposed it). Lesson: when auth fails "impossibly," compare the failing request's latency against a known-good one before blaming infra. The verifier also now snapshots/restores demo-shul's settings (its own test writes were clobbering them, leaving `{"hacked":true}` in the local DB — restored). The three items, each RLS + UI + walkthrough + e2e:
  1. **Classroom GA grade visibility** (`20260712020000`) — GA sees only `source='ga' AND graded_by=auth.uid()` rows. UI: Manage-page gate broadened to staff-OR-GA (`cls_is_ga` RPC alongside `cls_can_manage`) with every create/config form wrapped in professor-only `{canManage}`; grading console hides Peer/Final columns + workflow buttons from non-professors. Exam console needed nothing (already reads own-ga rows + gates publish on `isProfessor`). New e2e: GA reaches Manage/grading, sees no professor controls.
  2. **Org-settings self-serve** (`20260712030000`) — new **`/o/[orgSlug]/settings`** page (requireOrgAdmin; "Settings" link on dashboard card next to Members) with the synagogue location form; `updateModuleSettings` action re-checks `is_org_admin`. Shared field component (`apps/web/components/synagogue-location-fields.tsx`) + parser (`apps/web/lib/synagogue-settings.ts`) reused by the superadmin console form (founder reuse rule). Supersedes the 07-12 "settings stay superadmin-only" note — docs/03 control hierarchy + module-3 spec updated. New e2e: admin round-trips a save; plain member and non-member 404.
  3. **Matchmaking mutual interest** (`20260712040000`) — single view gains **Express interest / Withdraw interest** per match + an **It's a match!** section (contact from `mm_mutual_matches()`); matchmaker view + admin Manage console show `mm_mutual_pairs()`. Seed: Charlie↔Dana mutual, Eve→Charlie one-sided. e2e (folded into the matchmaking test) drives the live chain: express → target sees nothing → reciprocate → both revealed → withdraw → reveal gone. **Founder OPEN QUESTION still open** (recorded in the module-1 spec): mutual match reveals email directly (current design) vs. matchmaker-only introduction — both halves exist, changing it is one column in `mm_mutual_matches()`.
  - **e2e strict-mode lesson (bit again):** the matchmaker page renders "A ↔ B" in TWO sections (mutual pairs + regular matches) — an unscoped `getByText(/A ↔ B/)` collides; scope to the section's heading-sibling list. Also re-confirmed: a first-attempt failure late in a data-mutating test makes the RETRY fail earlier on mutated data (91%→82% after the test's own answer change + recompute) — reset+reseed before trusting a full-suite result.
  - Founder was away ~2 days; his only note in `founder-feedback.md` was "uptimerobot set up" (no walkthrough feedback, no answer to the open question). `TESTING-TODO-2DAYS.md` / `founder-feedback.md` / `verify-migrations.mjs` stay untracked scratch.
  - **Model-choice rules got a Fable tier** (founder ask, 2026-07-16): see "Model choice" below — Fable only for novel-security review, defeated-a-session debugging, or big cross-cutting design; two-way say-so rule (heavy models must flag routine work at turn start).

- **2026-07-12 (two modules brought to zero known gaps — classroom + synagogue-schedules):** Founder asked to focus on finishing whole modules rather than spreading fixes thin, so testing doesn't hit known-but-undocumented holes. **Classroom needed no code at all**: its "remaining" item (submission retention) turned out to have already been fully built on 2026-07-09 (`20260709080000_classroom_submission_retention.sql` — `cls_classes.submissions_hidden_from`, `cls_submissions.visible_override_until`, both wired to UI, RLS-time visibility, verified live 8/8 at the time) — the module spec doc and build plan had simply never been updated afterward, so they still read as an open TODO. Fixed both docs (docs/modules/module-2-classroom.md, docs/04-build-plan.md). **This is worth remembering: "documented as not-done" isn't the same as "not done" — check git/CI history before assuming a spec's gap list is current.** GA-specific dedicated grading views remain the one explicitly-optional nice-to-have; module 2 has no other known gaps. **Synagogue-schedules' one real gap** (location settings — lat/long/timezone/myzmanim id — seed-only, no edit UI) is now closed: the superadmin Owner Console gained a location-settings form (`updateSynagogueSettings`, `apps/web/app/(app)/console/`), no migration needed since `org_modules`'s existing superadmin RLS policy is `for all` and already covers the `settings` column — the same write path `toggleModule` already used. Deliberately superadmin-only, not org-admin self-serve, matching the founder's standing decision that module-level configuration stays a platform-owner action (org self-management only covers membership/module-role grants). Module 3 now has no other known gaps short of the already-parked myzmanim live-auth item. **Matchmaking's remaining gap (mutual-agreement→introduction flow) was scoped but NOT started** — it genuinely needs a new migration (a pair-level interest table, e.g. `mm_interests`, plus a definer function mirroring `mm_shared_answers` that only reveals mutual interest) — queued for an Opus switch per the settled model-switch protocol, not built this pass. e2e 28/28, RLS 14/14, typecheck+build clean.
- **2026-07-12 (mobile/tablet responsive-design pass — the deferred "major upgrade"):** Founder-requested platform-wide pass, deliberately deferred earlier in the testing round. **Single highest-leverage fix, found first**: there was NO viewport meta tag anywhere in the app (`apps/web/app/layout.tsx`) — every mobile browser was rendering the page at desktop width and forcing the user to pinch-zoom, regardless of any responsive CSS underneath. Added the Next.js `viewport` export before touching anything else. **Worst per-page offender**: the visual-messaging Konva canvas (`layer-canvas.tsx`) hard-capped its display width at a fixed 640px with zero responsive handling — any image would overflow a phone screen. Fixed with a `ResizeObserver` on a measuring container (itself `w-full max-w-[640px]`, so it naturally shrinks on narrow screens) feeding `displayW = Math.min(640, natural.w, containerWidth)`; the swipe-arrow overlays moved to be children of the actual canvas-sized inner div (not the wider measuring div) so they still hug the canvas edges rather than floating in empty space on desktop. Verified with a real Playwright screenshot at 375px using a synthetic 1200×800 uploaded image — went from would-have-overflowed-badly to fitting the viewport exactly. **Other fixes, surveyed first via an Explore agent across every module**: horizontal-scroll wrappers (`overflow-x-auto` + `min-w-[…]`) on three unwrapped tables (nail-salon day-board, classroom grading, classroom materials); classroom's announcement input's `min-w-96` (384px, wider than a phone's content area) changed to `w-full sm:min-w-96`; `flex-wrap` added to several non-wrapping multi-field form rows (matchmaking groups, speed-dating notes/profile-card, visual-messaging moderation/member forms, nail-salon shopping list, sample module); touch targets enlarged (`px-1 py-1.5`) on every small `text-xs` text-only action button/shared style constant across modules; top bar (`apps/web/app/(app)/layout.tsx`) gained `flex-wrap` + a truncating max-width on the display name, and main-content padding tightened to `p-4 sm:p-6`. **Deliberately did NOT touch**: the two low-risk synagogue-schedules schedule tables (2 columns + already-wrapping per-day spans, confirmed genuinely low-risk, not worth the churn) and dozens of single-checkbox/radio `<label className="flex items-center gap-1">` pairs (already small enough that there's nothing to overflow). Visually verified via real Playwright screenshots (not just typechecking) at 375px and 768px across the dashboard, nail-salon, classroom manage, org members page, and the visual-messaging canvas — a script-generated synthetic image, cleaned up before the final regression. e2e 28/28, RLS 14/14, typecheck+build clean.
- **2026-07-12 (classroom: professor creates courses/classes directly):** Founder feedback: "if Alice can add projects in Sample Module, shouldn't she be able to add classes in Classroom?" Checked the actual RLS first (a dynamically-generated policy loop in the classroom migration already covers `cls_courses`/`cls_classes` with full staff `for all` access via `cls_can_manage`, and `cls_classes` already has a scope-sync trigger deriving `org_id` from `course_id`) — **no migration needed**, purely a missing `createCourse`/`createClass` action + form, same shape as the sample module's `deleteProject`. Manage console gains a **Courses** section (list + create) and a **create-class** form per course. **Real pre-existing bug fixed in passing**: the page's staff gate was `courses.length === 0 → notFound()` — a proxy for "is this user staff" that breaks for the very first course an org creates (chicken-and-egg 404, no way to ever create that first course). Replaced with an explicit `cls_can_manage` RPC check. **Two real e2e bugs caught and fixed, not pre-existing**: (1) the new test's own assertion hit a strict-mode violation — the "New class under {course name}:" form label embeds the course name as a substring, so an unscoped `getByText(courseName)` matched both the course list item and that label; fixed with `{ exact: true }`. (2) once the test's created course/class legitimately persisted for the rest of the suite run (2 courses/classes now exist in Demo Org A), two OTHER tests' generic unscoped placeholder locators (`New exam title`, materials `Title`) became ambiguous across course/class sections — fixed by scoping those locators to their specific section rather than constraining the test data, consistent with this project's established e2e convention (scope locators to a distinguishing element, don't just avoid creating a second occurrence). e2e 28/28, RLS 14/14, typecheck+build clean.
- **2026-07-12 (org self-management — control-hierarchy level 2 built):** The gap flagged repeatedly in the founder's testing round (classroom "no create-class UI," synagogue "Add your people" showing nothing, matchmaking assignment confusion) all traced to the same root cause: no UI existed for an org owner/admin to manage their own org's membership or grant module roles — only the superadmin console could. Built per docs/03's "Control hierarchy" (2026-07-09), level 2: **`/o/[orgSlug]/members`** (gated `requireOrgAdmin`, linked from the dashboard whenever the caller is org owner/admin) — add/remove members by email, change org roles, grant/revoke module-specific roles for modules already enabled on that org. **Module enablement itself (`org_modules`) deliberately stays superadmin-only forever** — the founder's explicit call: some orgs shouldn't have access to some modules, that's a platform-owner decision, not self-serve. **This touched RLS/migrations, so it ran the full docs/03 #12 rhythm with Opus 4.8 handling the sensitive piece**: `20260712010000_org_self_management.sql` adds two purely-additive permissive policies (`org_members_write_org_admin`, `module_roles_write_org_admin` — combine via OR with the untouched superadmin-only policies, so neither existing path changed), a "last-admin-standing" guard trigger on `org_members` (mirrors the visual-messaging conversation-admin pattern — an org can never be left with zero owner/admin), and a narrow `org_find_user_by_email()` definer function (org admins don't have broad profile-read access, only co-members' via the existing shared-org-read policy) — drafted by an Opus subagent, then adversarially reviewed by a second independent Opus subagent (verdict: SHIP AS-IS, no cross-tenant leaks, no privilege escalation since `is_org_admin()` already treats owner/admin identically everywhere), then applied and live-verified with 8 new RLS test cases (14/14 total) before any UI was built on top. **Reuse, per explicit founder instruction ("so a tooltip change updates in multiple places, not many")**: one shared component (`apps/web/components/org-members-panel.tsx`, plus a small client `module-role-form.tsx` for the module→role dependent select, mirroring the matchmaking assignment-form pattern) renders on BOTH the new org page and the superadmin Owner Console — `/console` gained module-role display/assignment for free as a reuse side-effect, where it previously only did org-membership. Shared data-operation helpers (`apps/web/lib/org-members.ts`) back both callers' server actions, which each still do their own distinct authorization gate (`requireOrgAdmin` vs `requireSuperadmin`) — RLS is the real ceiling either way. New dedicated seed fixture user `orgtest@demo.local` (a plain member of Platform Self-Test) added specifically so this feature's tests can add/remove/promote/demote freely without colliding with any other test's assumptions about org membership. **Model-switch protocol correction from the founder mid-build, recorded to memory**: when work drifts into migrations/RLS, pause and let the user manually switch the session model to Opus — don't silently route it through an Opus subagent instead (this build's migration work predated the correction and isn't being redone; the correction governs going forward). e2e 28/28, RLS 14/14, typecheck+build clean.
- **2026-07-12 (founder testing-round feedback, batch 3 — role clarity, error boundary, one help system per module, delete/undo, swipe UX finished):** A large round of founder confusion/bug reports, worked through item by item. **(1) Role visibility follow-through:** the dashboard badge fix from batch 1 disappeared once you clicked into a module — added an org-scoped layout (`o/[orgSlug]/layout.tsx` + `getMyOrgRole()`) showing "Your role here: {ORG ROLE}" on every page inside an org. Also relabeled the two dashboard badges themselves (`org: admin` vs the per-module role chip) with tooltips explaining they're two *different* role systems (org-level membership vs. a module-specific hat) — this is what was behind "Demo Salon is labeled Admin but Nail Salon is labeled Manager": same person, two roles, no visual distinction previously. **Confirmed: no "view as" feature exists anywhere** — a user's console is a fixed branch on their own role (`sal_can_manage`/`sal_can_operate`/`isWorker` for nail-salon, same pattern everywhere); Alice can't see the salon as a customer/worker would without an actual second account. **(2) First error boundary in the whole app:** `(app)/error.tsx` — there was NO `error.tsx` anywhere, so every thrown server-action Error (e.g. matchmaking's "No user with email X" on an assignment typo) fell back to Next's unstyled generic crash page ("The page couldn't load"). One boundary now covers every module. **(3) Matchmaker-assignment form rewritten as a client component** (`assign-matchmaker-form.tsx`): individual-vs-group target is now truly mutually exclusive (the non-selected field's `name` is absent from the FormData, not just hidden — the old raw-HTML form let you fill both), and both email fields suggest existing matchmakers/singles via `<datalist>` instead of blind free-text. **(4) One help system per module, not two:** synagogue-schedules had two different, drifted help documents — a bespoke module-owned setup page (built 2026-07-07, before the docs/03 walkthrough registry existed) and the generic registry guide (built 2026-07-10) — reached from two different "Help" links with different content. Folded the bespoke page's richer detail (name-templating tokens, worked rule examples, publish/export/public-link steps) into the one registry guide and deleted the duplicate page/route; every module now has exactly one help document, matching the platform-wide convention. **(5) Sample module gains `deleteProject`** (founder created a duplicate-named project by mistake, had no way to remove it) — RLS already permitted it (`smp_projects_write_staff` is `for all`), pure additive app code. Deliberately did NOT add a name-uniqueness constraint alongside it: duplicate names are a legitimate case, delete is the right fix for "I made a mistake," not a DB constraint blocking a valid state. **(6) Swipe UX finished:** non-editable directional arrows (← → ↑ ↓) overlaid on the canvas edges (plain HTML, not part of the Konva stage, so always rendered above whatever's drawn — answers the founder's "arrows that stay above the canvas" ask) show which directions have somewhere to go and a badge with how many consecutive swipes still work that way (reusing the `swipeCounts` computed in the page); clicking one navigates the same as the matching swipe. New layers now slide in ~24px from the swiped-from direction and ease to rest (200ms) — a directional cue, not a scene transition, wired through both real swipe gestures and the new arrow-button clicks. **Two real gaps surfaced but deliberately NOT fixed this batch (flagged for a dedicated pass, not a quick patch):** there is currently **no UI anywhere for an org admin (non-superadmin) to add members to their own org or grant module-specific roles** — confirmed via `grep -rln "module_roles" apps/web/app` / `"org_members" apps/web/app` (only the superadmin-gated `/console` touches org membership) — this is the root cause behind the classroom "no create-class UI," the synagogue "Add your people" step showing nothing for Alice, and the matchmaking assignment confusion all at once; and **org-level module settings (e.g. the synagogue's address/timezone) are seed-only**, no self-serve editing UI. Both belong to the same future "org self-management" design pass. e2e 27/27, RLS 7/7, typecheck+build clean.
- **2026-07-11 (founder testing-round feedback, batch 2 — placed stamps are now editable):** The founder's biggest ask from batch 1: a placed emoji/text/image was locked the instant you tapped it down. Now every draft stamp/text/image is selectable (tap it), draggable, resizable + rotatable via Konva's built-in `Transformer` handles, and deletable (**Delete selected** button appears only while something's selected). Local-only `id` fields on the draft item types drive selection/ref-tracking and are stripped before the send payload goes to the server — the stored shape (`Stamp`/`TextStamp`/`ImageStamp`) is unchanged. Resize/rotate reads the Konva node's final `scaleX/scaleY/rotation` on `onTransformEnd`, folds it into `fontSize` (text/emoji) or `width/height` (images) so it doesn't compound, then resets the node's own scale to 1. **Real bug caught before it shipped:** my first cut gated "is this an existing shape" on `e.target !== stage` — wrong, because the background photo is itself a full-canvas `KonvaImage`, so nearly every tap hits *it*, not the bare Stage, and that check silently blocked ALL new placements everywhere. Fixed by checking against the actual tracked draft-shape refs (`Object.values(shapeRefs.current).includes(e.target)`) instead of comparing to the Stage. Caught by the new e2e itself failing on the very first "place an emoji" step (Send stayed disabled) — not shipped broken. **e2e testing note:** the follow-up "tap to select" click needs to wait for a real signal (Send reply enabling) after the placement click, or it can race the just-mounted Konva node and land on empty canvas instead. e2e 27/27 (existing test extended: place → select → drag → delete → re-place → verify Send disables/enables correctly through it).
- **2026-07-11 (founder testing-round feedback, batch 1):** Real feedback from the founder's live walkthrough, addressed same-session: **(1) dashboard role visibility** — `getOrgsWithModules()` now also returns each module's caller-specific `module_roles` role (professor/GA/matchmaker/etc.), rendered as a small badge on each module button; the org-level role also got a colored pill instead of near-invisible gray text (bob vs alice previously looked identical). **(2) Module 4 UX fixes:** a visible blue border + "Drawing mode" label while in draw mode (founder: swiped without realizing he was in draw mode); **after Send, the canvas now navigates straight to the reply just sent** instead of leaving you on the parent requiring a swipe to find it (`replyWithDrawing` now returns the new layer's id; `LayerCanvas.onSend` returns `Promise<string>`); color-picker swatches enlarged (h-6→h-8) with a proper `ring-offset` selected-state (the old CSS `outline` barely showed) plus a "current color" preview swatch so the choice is visible before you draw. **e2e gotcha hit by my own navigate-after-send fix:** the send handler flips local `mode` to 'view' synchronously — before the `router.push` to the new layer resolves — so a transient render of the STALE parent page (in view mode, using pre-send data) briefly shows the same text a real destination-unique wait would look for; fixed by waiting on the breadcrumb segment for the new layer's own path ("1.1"), which only the true destination ever renders. e2e 27/27 (existing test's assertions updated for the new landing behavior, not a new test). **Documented, not yet built:** swipe-direction arrows with layer-count badges, a slide-in transition when navigating, and letting placed emoji/text/image stamps be dragged/resized/rotated/deleted after placement (currently: pick settings, tap once, it's locked in) — the founder's most-requested item, queued next.
- **2026-07-11 (module 5 reporting expansion — deliberately read-only, picked while the founder's testing round is live):** Manage console's summary grid gains **Net profit** (revenue − all-time expenses), plus two new report sections: **Top services** (billed revenue + count per service, from `sal_bill_items`) and **expenses by category** (all-time totals, above the recent-activity log). **Real accuracy bug fixed in passing:** the existing "Expenses (recent)" tile silently summed only the last 20 rows (the same query used for the activity log) — any salon with more history was under-reporting its own total spend. Renamed to "Total expenses" and now sums the full unlimited set. Chose this slice specifically because it's **additive and read-only** — no new writes, doesn't touch booking/availability — safe to ship while the founder is actively clicking through the live app for his testing round; a write-path feature (e.g. the still-open per-worker availability-window item — `sal_worker_profiles.weekly_schedule` + `sal_worker_time_off` have schema/RLS but zero UI and nothing enforces them at booking time) was deliberately deferred to a quieter moment. Guide updated same commit. e2e 26/26 (assertions folded into the existing manager back-office test).
- **2026-07-11 (module 1 group/matchmaker-assignment management UI):** The last piece of module 1's "remaining" list from the build plan — `mm_groups`/`mm_group_members`/`mm_matchmaker_assignments` had schema, RLS, and even the matchmaker's own read-scoped view (`MatchmakerView` in `page.tsx`) since 2026-07-09, but **no admin UI ever existed to create the rows** — the demo seed populated them directly via the service role, meaning a real admin had no way to assign a matchmaker to anyone. Manage console gains: create a group, add/remove members by email, and assign a matchmaker (by email) to an individual single or a whole group, with a live assignments list + remove. All admin-only writes (RLS's existing `mm_can_manage` staff policy, matching the page's own gate) — no migration. Guide updated same commit. e2e (folded into the existing matchmaking test, not a new test — floor stays 26): create group → add Eve → assign Mel to the group → confirm in the list → remove.
- **2026-07-11 (help-guide visibility bug FIXED — the one flagged two commits ago):** Root cause turned out narrower and safer to fix than first thought: `module_can_manage()` was built correctly for export-controls (docs/03 #13, admin-tier gating who can disable exports) and is STILL correct there — the bug was reusing it as the walkthrough-visibility gate, where "staff" means "operational tier for this module" (GA, matchmaker, moderator, organizer, host), not "can administer the module." Confirmed broken today for real seeded non-admin roles: classroom GA, matchmaking matchmaker, visual-messaging moderator, speed-dating organizer AND host (classroom professor / nail-salon manager / synagogue maker were already fine — their `_can_manage` fns happen to include that specific role). **Fix (no migration, no change to `module_can_manage` itself):** new `apps/web/lib/help-visibility.ts` — a guide is visible if `module_can_manage` is true (unchanged top tier) OR the caller's own `module_roles` row for that module exactly matches the guide's `role` field (confirmed 1:1 against every module's actual seeded role strings). Both the help index and the guide-detail route now call this instead of the bare RPC. e2e proves it with a REAL pre-existing seeded case (gabe: classroom GA, org member NOT admin) — sees his own guide, and confirms the fix doesn't over-broaden: the professor guide (a tier he doesn't hold) still 404s for him. Floor raised 25→26 (new test, not folded into an existing one).
- **2026-07-11 (module 6 notes/reports/blocks UI + a real host-tier gap fixed):** Speed dating's remaining schema-only tables (`sd_notes`, `sd_reports`, `sd_blocks` — all security-reviewed 2026-07-09) now have UI, no migration needed. Participants get a **Private note** (author-only, never visible to staff) and **Report** on every met person in "People you met", plus **Never pair me with them again** (a personal, cross-event block, idempotent on double-click) — managed from a new **People you've blocked** section on the main Speed Dating page. Staff (organizer OR host — `sd_can_staff_event`, broader than the organizer-only `sd_can_organize` the page previously checked) get a new **Roster & reports** section with triage (Mark reviewed/actioned/dismiss); the reported person never has a read path. **Real pre-existing gap fixed:** the event page only ever checked `canOrganize`, so a pure **host** (a real, distinct module role with lobby/safety duty but no event-setup rights) saw nothing but the header — not even the roster. Now gates roster+reports on the broader `canStaffEvent`. New `host` walkthrough guide added alongside the participant/organizer updates. **Latent platform-level bug FOUND, not fixed (flagged for a dedicated pass):** the generic help-guide route gates `staff: true` guides on `module_can_manage`, which resolves to org-ADMIN tier only — but every module's "staff" guide (professor, GA, matchmaker-admin, cashier/manager, organizer/host, moderator) means "operational tier," not "can administer the whole module." This masks itself in every demo seed because the demo organizer/GA/etc. also happens to be an org admin — a real customer's non-admin staff would 404 on their own guide. Cross-cutting (touches one shared route, affects every module), so deliberately NOT rushed into this commit — needs its own audited pass. e2e 25/25 (new assertions folded into the existing speed-dating test: note round-trips after reload, report files → staff triages → dismissed, block → appears in the list → unblocked).
- **2026-07-11 (module 4 image stamps — content vocabulary COMPLETE, all four spec types shipped):** Fourth and final canvas tool: **Image** — upload a photo, adjust size (50%-250%) and rotation (-180°..180°), tap the picture to place it (a no-op tap until an upload finishes). Uses the `vm-images` bucket + its `vm_can_post`-gated write policy that already existed from the 2026-07-09 security review (T8) — **no migration**, this was purely UI + a new server action (`uploadImageStamp`, called programmatically with a `File` rather than via `<form>` FormData since the canvas triggers it, not a native form submit). Content gains a fourth sibling `images: ImageStamp[]` (`{ path, x, y, width, height, rotation, opacity }` — path is the private storage object, x/y/width/height top-left+size in image pixels). Default guards per spec ("default max stamp size relative to canvas" and "default slight transparency"): 30% of the root image's width, 85% opacity — fixed v1 constants, the "admin/org-tunable" part deferred. **Security guard added in `replyWithDrawing`:** every image path must start with `${org.id}/${conversationId}/` — the only writer of that prefix is `uploadImageStamp` itself, so a client can't reference an arbitrary storage path from elsewhere. Rendering needs signed URLs (private bucket): the page batch-signs every distinct stamp path across the WHOLE conversation in one `createSignedUrls` call (tree view needs every layer's, not just the current chain's), then a shared `useImageCache` hook (exported from `layer-canvas.tsx`, reused by `layer-grid.tsx`) loads each URL into an `HTMLImageElement` for Konva — the same hook also loads the draft's local blob URLs so a just-uploaded image previews immediately without a round trip. **Hit the documented Docker-crash gotcha again mid-session** (Docker Desktop was down, `docker ps` failed, e2e sign-in failed with "Failed to fetch" — not a code bug): restarted Docker Desktop, waited for all containers healthy, restarted Kong defensively (the stale-route gotcha), clean reset+reseed, re-ran clean. **Module 4's layer-content vocabulary from the spec is now fully built**: strokes, emoji stamps, styled text, and image stamps — all four types, mixable in one reply. e2e 25/25.
- **2026-07-11 (module 4 text stamps — spec content vocabulary complete short of image stamps):** Third canvas tool alongside Pen/Emoji: **Text** (type a message, pick a color/size/-180°..180° angle, tap the picture to place it — a no-op tap until something's typed). Content vocabulary gains `texts: TextStamp[]` (`{ text, color, x, y, fontSize, angle }`, image-pixel coordinates like strokes/stamps) as a third sibling on layer `content` jsonb — no migration. `replyWithDrawing`'s payload is now `{ strokes, stamps, texts }`; a reply needs at least one non-empty. Tree-view thumbnails render texts the same way as strokes/stamps. Guide updated same commit. **Hit a self-inflicted flake while regression-testing** (worth re-recording since it bit again): ran the full e2e suite twice back-to-back without `db:reset` between runs — several OTHER modules' tests (classroom, nail-salon, speed-dating, sample) create rows with fixed non-unique titles ("Rollout plan" etc.), so stale duplicates from the first run broke strict-mode locators on the second. A clean reset+seed ran 25/25 with zero code changes — not a regression, not a machine issue, just needing a fresh seed before trusting a full-suite result. **Spec's layer-content vocabulary is now strokes + emoji stamps + styled text — only image stamps remain** (the bigger lift: needs a storage upload path + the spec's default-size/transparency guards). e2e 25/25.
- **2026-07-10 (module 4 emoji stamps):** The canvas gains a second draw tool alongside Pen: **Emoji** (a 14-emoji fixed palette + a size slider) — tap the picture to drop the selected emoji at that point. A reply can mix strokes and stamps in one send. Content model: layer `content` gains a sibling `stamps: Stamp[]` field (`{ emoji, x, y, fontSize }`, x/y in IMAGE pixel space like strokes so registration holds at any zoom) alongside `strokes` — no migration, `content` is jsonb. `replyWithDrawing`'s payload changed shape from a bare strokes array to `{ strokes, stamps }` (both validated server-side; a reply needs at least one). Tree-view thumbnails (`layer-grid.tsx`) composite stamps into the ancestor chain the same way as strokes, for parity. Styled text and image stamps (the spec's other two content types) remain unbuilt — image stamps specifically need upload UI + the spec's default-size/transparency guards, deferred. Guide updated same commit. e2e 25/25 (assertions folded into the existing vm test: switch to Emoji tool → palette replaces pen swatches → pick 🔥 → tap to place → switch back to Pen → ink a stroke → send both in one reply).
- **2026-07-10 (module 4 deep-link join + admin-tier UI gating):** "Deep links for non-members" shipped — and the diligent look showed the sensible, privacy-respecting version needs **NO migration** (I'd earlier mis-flagged it as Opus/migration work; verified otherwise against the schema). A conversation admin toggles **Link joining: open / invite-only** (writes `settings.joinPolicy`; the existing `vm_conversations_update_admin` policy + `vm_pin_conversation` allow it). A logged-in org-module member who isn't yet a conversation member and lands on the conversation URL now gets a **Join this conversation?** prompt instead of a 404; **Join** calls the existing `vm_join_conversation` RPC, which grants a read-only **viewer** seat only if the policy is open (invite-only / banned / non-member all refuse server-side — the title is never revealed pre-join). Truly-anonymous no-login public viewing is **explicitly out of v1** (founder, 2026-07-10: "make the whole public link a future enhancement, discussed later") — the design thinking (interactive teaser, server-side-bounded slice, request-access-not-signup, the multi-party consent crux) is captured in the module spec's future-enhancement section, parked as a whole. **Also fixed a real pre-existing UI/permission mismatch found while here:** the conversation page gated add-member / freeze-branch / (new) join-policy on the looser `canModerate`, but all three require the conversation-**admin** tier at the RLS layer — a plain moderator would have seen buttons that error. Now computes `vm_is_conv_admin` (added to the page's parallel batch) and gates those three on `canAdmin`, leaving tombstone/restore/flag-triage on `canModerate`. Both walkthroughs updated same commit. e2e 25/25 (new test: alice opens joining → dana deep-links in as a viewer → no Draw affordance), floor raised 24→25.
- **2026-07-10 (module 4 viewer-role fix + Opus handoff):** Fixed a latent bug found while scoping the next slice (deep links for non-members): the canvas's `drawable` prop only checked `Boolean(me)` — any signed-in conversation member, including a future viewer-role seat, would see **Draw a reply** and could ink a stroke that RLS would then silently reject on Send (viewers aren't in `vm_can_post`'s participant/moderator/admin allowlist). Fixed by fetching the caller's own `vm_conversation_members.role` and gating on it (`canPost`) — no migration, pure app code. Harmless today (the only role the UI ever grants is `participant`) but load-bearing for the next piece. **Scoping "deep links for non-members" surfaced that it isn't a routine UI slice**: the existing `vm_join_conversation` RPC checks `joinPolicy` *before* checking membership, so calling it on every page view would throw for existing members too on any conversation still defaulted to `invite`; a real non-member preview also needs RLS-bypassing read access via a definer function. That's migration/RLS territory — flagged per the model-choice rule; founder approved switching to Opus 4.8 for this piece specifically, Sonnet 5 resumes right after it ships and verifies clean.
- **2026-07-10 (module 4 moderation queue UI):** The guide's "moderation queue UI is coming" line is now true. Members get **Flag this layer** (reason + optional detail, any member — RLS only requires membership) next to the reactions row. Moderators get a **Moderation** section on every conversation page: **Flagged content** lists every open/actioned/dismissed flag conversation-wide (reporter identity visible to moderators only — the flagged layer's author never learns who reported, per the existing RLS design) with a **Review layer N.N** link and **Mark actioned**/**Dismiss**; plus **Remove this layer** / **Restore this layer** and **Freeze**/**Unfreeze this branch** acting on whatever layer is currently being viewed, wired straight to the already-audited `vm_tombstone_layer`/`vm_restore_layer`/`vm_set_branch_frozen` definer RPCs from the schema security review (no new migration — this was UI + three server actions). Both walkthroughs updated same commit. **Two e2e gotchas hit and fixed:** (1) the flag queue's "Layer 1.1" link collided in strict mode with the replies-list link of the same name — renamed to "Review layer N.N" to disambiguate (also just clearer copy for a moderator); (2) hit the documented searchParam-navigation race again — clicking a link that only changes `?layer=` and then immediately acting tombstoned the WRONG layer (the still-rendered old page's bound `current.id`) twice in a row before a destination-unique wait (`Replies to this layer (0)`) fixed it. e2e 24/24 (assertions added to the existing vm test, not a new test).
- **2026-07-10 (module 4 gesture layer, slice 2 — tree view):** The zoomed-out grid shipped as pure client-side rendering (`modules/visual-messaging/ui/layer-grid.tsx`): every layer renders as a small Konva thumbnail (root image + composited ancestor-chain strokes, tombstoned layers rendered blank) grouped by tree depth, each clickable to jump straight to that layer. No rasterizer worker job needed at this scale — reuses data the conversation page already loads; revisit only if a conversation's layer count grows into the hundreds. Reached via a **Tree view** / **Back to layer** toggle (`?view=tree` searchParam) next to the breadcrumb. Guide + e2e updated same commit (e2e assertions added to the existing vm test, not a new test — floor stays 24). **Confirmed a self-inflicted flake, not a regression:** running the full e2e suite twice back-to-back without a DB reset duplicated fixed-title classroom rows ("Homework 1 — Descriptive statistics") and broke strict-mode locators — the same class of bug already on record for the vm "Family sketch" test. A clean reset+seed run was 24/24. e2e 24/24, RLS 7/7, typecheck+build clean.
- **2026-07-10 (module 4 gesture layer, slice 1):** The spec's swipe navigation shipped: the canvas now runs in **view/draw modes** (view is default; "Draw a reply" enters draw mode, Cancel/Send return). In view mode swipes navigate the layer tree — left = dive into the first reply, right = back up to the parent, up/down = cycle siblings — with **sibling dots** (clickable carousel position) under the picture; the page computes nav targets server-side from the path-ordered rows. Member walkthrough updated same commit; the vm e2e now enters draw mode explicitly AND drives real swipe navigation (right → root, left → leaf). **e2e race worth remembering:** after clicking a link that only changes a searchParam, an assertion matching text present on BOTH pages passes against the OLD page — the swipe then fired against stale nav props (root's parent = null → no-op). Wait on a signal unique to the destination ("Replies to this layer (0)") before gesturing. Also: RLS tests need SUPABASE_ANON_KEY exported (grab from apps/web/.env.local) when run standalone. Slice 2 = thumbnail rasterizer worker job + zoomed-out grid. e2e 24/24, RLS 7/7.
- **2026-07-10 (founder testing kit — TESTING ROUND OPEN):** docs/11 is the master itinerary (chapters 0-8: every module, every role, from zero; feedback format module/guide/stepN) and works in BOTH environments: production (any browser; demo world SEEDED TO PROD — cast of 9 demo users incl. new GA gabe; password set via DEMO_PASSWORD seed override, handed to the founder privately, recoverable by re-seeding prod with a new one) and fully offline (pnpm dev runs everything incl. the worker; password123). Worker-dependent steps (⚙: rescore/round-clock/exports) carry in-place reminders. README refreshed from "no code exists yet" to reality. **The founder may switch models when Fable credits run out — advised Sonnet 5 for the feedback-fix phase, Opus 4.8 for anything touching migrations/RLS/triggers; the docs/03 #12 security rhythm is the invariant, not the model.**
- **2026-07-10 (module 4 UI v1 — EVERY module now has usable UI):** The visual-messaging core loop shipped: conversations list + create-from-picture (root image → vm-images; the root IS layer 1), conversation page compositing the viewed layer on its ancestors (Konva + perfect-freehand; strokes stored in IMAGE pixel space so zoom stays registered), click navigation (breadcrumb up / replies list down), hold-to-X-ray, pen palette/size/draft/send (drafts never leave the browser until Send), heart/laugh reactions, admin add-member. Walkthroughs (member/moderator) + export manifest (authorship: my layers/my reactions; admin: modlog) + demo-visual seed ship alongside; RLS test now expects 6 alice orgs. **Local e2e for this slice was blocked by a machine-instability episode (Docker Desktop crashed 3× in ~30min; Supabase CLI JSC heap OOM; browser spawn failures) — CI is the verifier for this push** (deploy only runs on green). New e2e: create → draw a real mouse stroke → send → layer 1.1 appears → non-member sees nothing → add member → member sees the tree.
- **2026-07-10 (matchmaking rescore worker):** The manual-recompute dependency is gone: `recomputeMatches` moved INTO the module (modules/matchmaking/src/recompute.ts, structurally-typed db param — no supabase-js dep; apps/web/lib/matchmaking.ts is now a thin re-export so both callers share ONE implementation per the composition rule). Worker gains a 30s rescore tick (apps/worker/src/jobs/matchmaking-rescore.ts): sweeps orgs with stale mm_pair_scores (the mm_mark_pairs_stale trigger flags them on answer changes) and recomputes with the same engine. Verified live 3/3: answer change → pairs stale → tick clears flags → percentages actually changed. Admin walkthrough updated same commit (rescoring automatic ~30s; button = instant refresh). Runs wherever the worker runs (worker:prod today). **Also hit the Windows build-crash gotcha again** (0xC0000409 mid-build left .next incomplete → "no production build"; full rebuild fixed). e2e 23/23.
- **2026-07-10 (salon self-booking):** Module 5 customer self-booking shipped — the customer console gains a booking form (service with price, optional preferred worker, date/time; location + customer id resolved from the caller's own record server-side) and a **Cancel** button on booked appointments. No migration: the RLS insert policy (own-customer, forced state=booked) and the cancel-only pin trigger existed from the security review — this was UI + action + walkthrough (updated same commit). e2e 23/23 (new: book → cancel round trip as charlie).
- **2026-07-10 (share-with-match reveal):** Module 1's flagged RLS gap closed: `mm_shared_answers(other_user)` definer fn (`20260710010000`, local+prod) reveals ONLY share-flagged answers of approved questions, ONLY between real (non-excluded) scored pairs, ONLY to callers holding the single role — 4/4 live privacy assertions (nothing-shared empty; match sees exactly the shared answer; EXCLUDED pair reveals nothing even when shared; non-single caller gets nothing). Single view renders them under each match as "(shared with you)"; walkthrough updated same commit per the rule. **Two gotchas hit:** `position` is a reserved word in RETURNS TABLE (renamed answer_position) — AND a failed `supabase db reset` piped through grep exits 0, so the failure was masked until the fn probe errored; PostgREST "schema cache" errors after adding a fn can also mean THE FN ISN'T THERE — check pg_proc before blaming the cache. e2e 22/22.
- **2026-07-10 (in-app walkthroughs / help system):** **Founder-approved walkthrough plan shipped** (docs/03 "User walkthroughs"): every module ships role-level numbered click-by-click guides at `/o/<slug>/help` (index) + `/o/<slug>/help/<module>/<role>` (guide), linked from every dashboard org card. Guides live INSIDE the module folder as typed strings (`modules/<key>/help/guides.ts` — no fs reads, deployment-safe on Vercel), registered in `apps/web/lib/help-registry.ts`, rendered with marked. **Visibility = the founder rule "each level sees their level and below"**: module staff (module_can_manage) see all guides incl. staff ones; members see non-staff guides — enforced at the route (a student deep-linking a professor guide 404s, e2e-proven). **UPDATE RULE recorded in docs/03: a UI change updates the module walkthrough in the same commit.** Guides shipped for ALL modules with UI: classroom (student/GA/professor), matchmaking (single/matchmaker/admin), nail-salon (customer/worker/cashier/manager), speed-dating (participant/organizer), synagogue-schedules (viewer/maker), sample template. Module 4 gains one with its UI. **These walkthroughs are the founder acceptance-test scripts**: he follows every step and gives feedback per step number. e2e 22/22.
- **2026-07-09 (module 6 orchestrator):** **The real rotation engine + automatic round clock shipped** (pure engine modules/speed-dating/src/rotation.ts, 7 unit tests: two-sided rotation with full cross-pool coverage, circle method for single pools, byes for odd/asymmetric counts, personal-block avoidance with deterministic partner-swap repair, no-repeat enforcement, exhaustion detection). Worker gains a 10s orchestrator tick (apps/worker/src/jobs/speed-dating-orchestrator.ts): running events auto-advance — expired round completes (round+break clock), next round builds from CHECKED-IN participants honoring blocks (service role sees all sd_blocks; a mere organizer manual round may not — noted in code) and allow_repeat_pairings; rotation exhaustion stops advancing and leaves completion to the organizer. **7/7 live clock assertions** (round1 → no-op mid-round → round2 differs → stops at 3 rounds with all 6 combos met exactly once). The manual UI button now uses the same engine. Runs wherever the worker runs (worker:prod today). Speed dating is now event-runnable minus video (Jitsi needs the VPS). e2e 21/21.
- **2026-07-09 (module 4 schema — ALL SIX MODULES NOW HAVE LIVE SCHEMA):** Visual messaging integrated (6 vm_ tables incl. the materialized-path layer tree and an append-only moderation log, local+prod). Security review built T1–T8: **atomic reply-path assignment** (parent row-lock serializes concurrent siblings; client path/child_count ignored; tombstoned/frozen parents reject replies), immutable-once-replied-on via a direct child_count column, audited tombstone/restore RPCs that preserve original content in the mod log, branch freeze by path prefix, join RPC honoring settings + bans, member pins with a last-admin-standing guard, flag-triage pins, and the vm-images bucket gated on CONVERSATION membership. **16/16 live guard assertions.** module_can_manage dispatcher extended. Dark until UI (the canvas frontend is the effort center). Platform status: modules 1/2/3/5/6 usable, 4 schema-only; docs/04 M2-M6 sequencing effectively complete at the schema level.
- **2026-07-09 (all six modules export-ready):** Export manifests added for matchmaking, nail-salon, speed-dating, and synagogue-schedules under the authorship principle — the salon one encodes the founder example directly (customer → own record/visits; worker → own work, no client details; cashier → bills they processed, no client details; manager → the business books) and a new e2e proves it (customer sees visit history; the CASHIER is offered no customer data sets). Matchmaking singles export answers+proposals, never computed pair scores (embed others: admin domain); speed-dating participants export registrations/marks/private notes (one-sided interest about them never appears); synagogue maker exports the rule configuration. Organizer console also gained a rounds counter. **Testing lesson recorded the hard way (3 attempts):** to confirm a server-action mutation landed before navigating, wait on the POST RESPONSE (page.waitForResponse) — client-side signals false-positive: a just-set checkbox reasserts itself, and <details open> survives RSC refresh because React preserves client DOM state. e2e 21/21.
- **2026-07-09 (export principle CORRECTED — authorship, not visibility):** Founder correction to the export primitive, now the law in docs/03: **the export slice is what you ENTERED into the platform** (uploads, answers, submissions, comments — so entering data never risks losing it) plus minimal context metadata (class name), NOT what you can see. His canonical example: a salesperson may SEE a client's history to do the job, but visibility confers no right to export client details. Staff hats still export the domain they operate (professor's gradebook = their work product). RLS stays as the hard ceiling, no longer the definition. Classroom manifest rewritten: student hat = my submissions / my files / my review comments / my survey answers (grades and published materials REMOVED — professor-entered; **flagged: grades are about-the-student but not by-them; revisit if grades-about-me should be an exception**); GA hat = grades they entered (source=ga); professor hat = gradebook/rosters/materials. Sample template carries the principle. **Also: my own goto-after-POST race bit the controls e2e** (a Save click un-confirmed before navigation left settings disabled across runs) — saves now assert the re-rendered checkbox state, and the local seed resets classroom module settings for a clean slate. e2e 20/20.
- **2026-07-09 (export controls):** **Founder addition shipped: each level can shut off export for the levels below.** New platform helpers (`20260709090000_export_controls.sql`, local+prod): `module_can_manage(org, module_key)` — the first platform-level is-module-staff dispatcher (explicit per-module case; extended when adding a module) — and `set_export_settings()` (definer, re-checks the gate internally per docs/03 #13) writing `org_modules.settings.export` = {disabledHats, disabledSets}, so a professor who is NOT an org admin can still govern their module. Export page gains a staff-only "Export controls" panel (allow/deny per hat + per data set); page AND `/api/export` both enforce; **staff bypass their own switches**. Also answered the founder materials question: students CAN export class-materials metadata published to them (new `class-materials` set, student+GA hats) — governed by exactly these controls, default on. e2e 20/20 (controls round-trip proven: professor disables student hat → student fully shut off → re-enable → student exports again).
- **2026-07-09 (data-export primitive):** **Founder-proposed export-with-hats shipped** (docs/03 "Data export"; e2e 20/20 incl. a real zip downloaded and verified file-by-file). Design: an export contains exactly what the caller can already see — fetches run AS the user under RLS, so the access hierarchy IS the export hierarchy (no parallel permission model). Each module declares an export manifest (`modules/<key>/ui/export.ts`: hats + human-named data sets); the generic page (`/o/<slug>/export`, linked from every dashboard org card) shows the caller's hats — **a higher-role user may deliberately pick a lower hat** (founder refinement) — with checkbox data sets; `/api/export` re-checks org/entitlement/hat server-side and streams one zip of CSV+JSON per set + README. Types in `packages/platform/src/export.ts`; registry `apps/web/lib/export-registry.ts`; explicit 40-line CSV serializer (no dep beyond jszip). Manifests so far: classroom (professor/GA/student hats — richest ladder) + the sample module (template updated per the composition rule). Other modules' manifests are now mechanical copies. v1 = data-only + instant download; files-in-zip and worker-async are documented later steps. **Founder goal recorded: trust + freedom to leave with your data.**
- **2026-07-09 (retention sweep — module 2 spec surface COMPLETE):** `classroom.retention-sweep` worker job (daily 04:00 cron via pg-boss): purge-retention publications past their window are deleted, with the file removed from storage once no other publication references the material (library row kept for the professor's record). Verified live: expired-purge file deleted, still-shared file survived. 'hide' was already RLS-enforced. **Module 2 now implements everything in its spec that's buildable without new client decisions**; one open question recorded in the spec (submission retention needs a class end-date + hide-vs-purge choice — founder is the client). Runs wherever the worker runs (`pnpm worker:prod` or the future VPS).
- **2026-07-09 (composition + module 0):** **Founder's modular-composition proposal adopted** (docs/03 "Composition & template"): (1) modules aim to be 100% self-contained — **module UI now lives inside the module folder** (`modules/<key>/ui`) mounted by one-line route wrappers; proven working by module 0 (Next compiles pages + `'use server'` actions from outside apps/web via tsconfig paths; **Tailwind v4 needs `@source "../../../modules/*/ui"` in globals.css** or classes silently miss). (2) **Plug-and-play stays one codebase**: the `MODULES` env var filters the module registry at build time (unknown keys throw; `requireOrgModule` 404s excluded modules) — an isolated "only module 3" white-label deployment is a config line, never a fork; one-deployment principle intact. (3) **`modules/sample` (module 0) is the living template** — minimal projects/items domain exercising every docs/03 convention with the convention number annotated at each block (root vs child table, grants, is_org_admin delegation, scope-sync, pin trigger + naming gotcha, direct-column own-row policies, gated page, placeholder inserts), with seed + its own e2e so the copy-me path stays green forever. Rule: every future extraction updates the sample in the same pass. Migration `20260709070000_sample_module.sql` local+prod. e2e 19/19, RLS 7/7. Also: automatic gradebook combination shipped for module 2 (weighted GA+peer, renormalized per-student, override-wins — e2e-proven), closing its spec's grading story; retention sweep is the only module 2 tail left.
- **2026-07-09 (prod exports LIVE via local worker):** **`pnpm worker:prod` runs the worker on the dev PC against production** (scripts/worker-prod.ts: credentials from .env.deploy, session-pooler DATABASE_URL `aws-1-us-west-2.pooler.supabase.com` — verified live; health on :8902 so it coexists with the local-dev worker). This is the founder's $0 stopgap until the VPS: **verified end-to-end by rendering Pozna's real week into the prod `syn-exports` bucket (print.pdf 21KB + lobby-screen.jpg + whatsapp.jpg)** — the production Export button now works whenever the local worker is running; jobs queue harmlessly otherwise. Also configured the standard three `syn_export_profiles` (Print/Lobby/WhatsApp) for the `pozne` org in prod (it had none — that was the only missing config). pg-boss created its `pgboss` schema on prod (expected; same thing the VPS deploy would do).
- **2026-07-09 (module 6 UI):** **Speed dating usable end-to-end (minus live video)** — events list + create (organizer), event page with lifecycle controls (draft→open→running→complete, guard-trigger-enforced), participant registration/withdrawal, **"Run next round" orchestrator stand-in** (organizer-run server action pairing registered participants sequentially — the real rotation engine honoring pools/blocks/repeats arrives with the worker; guard triggers already enforce single-active-round + no-double-booking), post-round interest marking (interested / not interested / no-show), and the reveal: organizer completes + reveals, both parties see "It's a match!". e2e 18/18 — the new test walks the entire privacy chain through the browser: one-sided interest shows the target nothing, mutual-but-unrevealed still shows nothing, reveal shows both sides. Seeded org `demo-dating` (organizer alice, 4 participants). **ALL SIX MODULES now have at least a usable core or live schema; module 4 (visual messaging) is the only one with neither — awaiting founder UX sketch.** Remaining for module 6: the real orchestrator worker (round clock, rotation, Jitsi rooms), lobby/live-round UI, notes UI, reports/blocks UI, resume-review profiles.
- **2026-07-09 (exam grading):** **Module 2 exam grading shipped** — professor creates an exam with a problem structure (`1a:10, 1b:5, 2:20` → Zod-shaped jsonb) from the Manage console; the exam console (`/manage/exams/[examId]`) does per-student scan upload (new `cls-exams` storage WRITE policies — the bucket only had read: `20260709060000_classroom_exams_storage.sql`, applied local+prod), per-subproblem score entry (server caps each score at the problem's max defensively; total = sum, detail jsonb keeps the breakdown), and professor-published finals (defaulting to the GA total). Exam finals appear in the student's "Your grades" (homework OR exam title join). e2e 17/17 (1 new: create exam → subproblem-grade 27/35 → publish → student sees it). **Module 2 now covers its spec's full assessment surface** (materials, submissions, GA+peer+exam grading, finals, surveys); remaining tail is automatic gradebook combination (professor types finals manually today) and the retention sweep.
- **2026-07-09 (worker deploy prep):** **VPS deployment scaffolding ready** (docs/10-worker-deploy.md): `apps/worker/Dockerfile` on the official Playwright base (amd64+arm64 — works on Hetzner OR Oracle; tag must match the playwright dep version), `deploy/worker/docker-compose.yml` (restart policy, healthcheck, log rotation, `shm_size: 1gb` for Chromium, git-ignored `worker.env` from a documented example), root `.dockerignore` keeping secrets/client-materials out of build contexts. **Fixed a real pre-existing worker-build bug:** tsc's common-root spans the monorepo (worker imports module sources relatively), so the compiled entry is `dist/apps/worker/src/index.js` — `pnpm start` pointed at a STALE `dist/index.js` from an earlier layout; start path fixed + build now cleans dist first. Docker image deliberately NOT built locally (Docker Desktop crashed twice today under memory pressure; first build happens on the VPS per the doc). **Founder recommendation recorded: Hetzner ~$5/mo over Oracle free tier** (capacity roulette, idle-reclamation risk, ARM friction) — awaiting his account signup; walkthrough is click-by-click ready. DATABASE_URL must be the Supabase SESSION POOLER string (direct is IPv6-only; pg-boss holds long-lived connections).
- **2026-07-09 (salon back-office):** **Module 5 manager screens shipped** — `/m/nail-salon/manage` (sal_can_manage-gated): revenue summary from the earnings ledger (total + by-worker), service-catalog CRUD (add/deactivate), promotions authoring (visit-count/spend/lapsed + %/$ discounts, toggle active), expense log, and the shopping list with the spec's to-buy → purchased → expense flow (cashier enters the ACTUAL paid cost at purchase; the expense row links both directions). No new migration. e2e 16/16 (1 new). **Module 5 remaining:** customer self-booking UI, cashier promotion-surfacing at billing, per-service availability windows, reporting beyond the summary cards. **e2e locator lesson:** after an action creates a second row mentioning the same string (shopping item → expense), earlier broad `hasText` filters break with strict-mode violations AND test retries accumulate rows — scope filters to a distinguishing suffix and use `.first()` for insert assertions.
- **2026-07-09 (module 6 schema):** **Module 6 (speed dating) schema integrated — 5 of 6 modules now have live schema.** 10 `sd_` tables local + prod (`20260709050000_speed_dating.sql`), agent-drafted then hand security-reviewed: all nine flagged guards built (event/round state machines, participant pins — no waitlist self-promotion/pool-switching, host = removal-only —, pairing double-booking checks, interest identity pin, report triage pins) plus **the privacy-critical mutual-interest reveal**: an AFTER trigger upserts an unrevealed canonical `sd_matches` row when interest becomes reciprocal (deleted on pre-reveal retraction); `sd_reveal_matches()` (organizer-gated definer fn) is the single audited reveal path; RLS keeps unrevealed matches invisible to both parties, so a rejected side is indistinguishable from an undecided one. **24/24 live guard assertions.** Two extra findings: `sd_can_manage` delegates to `is_org_admin()` (new convention), and a **new RLS gotcha now in docs/03 (#15)**: a table's own-row policy must use direct column checks (`user_id = auth.uid()`), never a definer lookup into the same table — the self-lookup breaks `INSERT … RETURNING` (function snapshot excludes the inserting row; found live). Manifest registered, no org enabled — dark until UI. Control hierarchy formalized in docs/03 after founder question (superadmin → org owner/admin → module tiers composing downward; delegated role-granting + location-scoped staff deliberately deferred). e2e 15/15, RLS 7/7. **Module 4 (visual messaging) is the only module without schema — held until its canvas UX is sketched (highest product uncertainty).**
- **2026-07-09 (extraction pass 2):** **Second extraction pass done** (founder-directed: modularize before more module UIs). SQL: new platform helper `public.is_org_admin()` consolidates the superadmin/org-owner-admin check that was copy-pasted into `cls_can_manage`/`mm_can_manage`/`sal_can_manage` — all three refactored onto it via `create or replace` with unchanged signatures (`20260709040000_platform_extraction.sql`, applied local+prod), so every dependent RLS policy is untouched. App: `DERIVED_SCOPE_PLACEHOLDER` in `@platform/core` (packages/platform/src/tenancy.ts) replaces 7 files' hand-typed placeholder UUIDs for scope-sync inserts. docs/03 gained the "conventions proven by modules 1/2/5" section (staff-check delegation, scope-sync, pin-trigger ordering gotcha, agent-draft→security-review process, definer-functions-recheck-roles, no service key in server actions) + the **new-module acceptance checklist** (module = own folder + migration + pages + manifest entry + seed; anything else = missing primitive). e2e 15/15, RLS 7/7 on the shared primitives. **Deliberately NOT extracted** (only 1–2 users so far, extract on second need): matches-recompute shape, materials/publications pattern, day-board pattern. **Module 6 (speed-dating) schema draft is ready for security review** in modules/speed-dating/schema-draft.sql (agent-drafted; reviewer TODOs T1–T9 listed in the draft header/final report — the big one is the mutual-interest reveal mechanism).
- **2026-07-09 (late night, 2):** **Module 5 (nail salon) operational spine live + usable.** Role-adaptive console at `/o/<org>/m/nail-salon`: operators (cashier/manager/admin) get today's day board (check-in → start → complete → bill → mark-paid, plus no-show), a booking form, and walk-in quick-add; workers see only their assigned chairs (RLS-scoped) with start/complete; customers see their own appointments. Billing generates a bill from the service, marks paid (triggers stamp `paid_by`/`paid_at` and auto-feed the earnings ledger). Seeded demo salon (`demo-salon`): manager alice, cashier eve, worker dana, customer charlie, one location, two services, a booked appointment. e2e 15/15 (2 new: operator booked→paid lifecycle, worker sees-only-own-chairs). **Deferred for module 5:** customer self-booking UI, manager setup/catalog/promotions/reporting/bookkeeping screens, the shopping-list→expense action, assignment-algorithm + reminder workers. **NOTE (2026-07-09):** founder directed the NEXT work be the **extraction/modularization pass** (docs/04) before more module UIs — factor the repeated patterns (requireOrgModule gate, rpc role-detection, scope-sync/pin trigger conventions, admin-recompute shape) into packages/platform, refactor modules onto them, finalize docs/03 conventions against reality. Modules 4 (visual messaging) & 6 (speed dating) UIs come after that; module 6 schema is being drafted by a background agent.
- **2026-07-09 (late night):** **Module 5 (nail salon) schema integrated** — 12 `sal_` tables live local + prod (`20260709030000_nail_salon.sql`), org→location model, drafted by a background agent then hand security-reviewed. The review built three column-level/lifecycle guards the draft flagged (RLS can't express them): `sal_pin_appointment` (worker may only tick checklist/notes + advance their own appointment along its lane, completed rows lock; customer may only cancel their own booked appointment; all other columns pinned), `sal_guard_bill` (manager-only void/refund with server-side audit stamps; paid/void/refunded bills' money is immutable to cashiers), and the existing `sal_feed_earnings` auto-feed. **18/18 live guard assertions passed** (worker can't change price/skip states/edit locked rows; cashier can't void or alter a paid total; manager can refund → negative earnings row; customer cancel pins service). Manifest registered but **not enabled for any org** — schema only, no UI, fully dark. e2e 13/13, RLS 7/7. **Module 5 next:** the full salon UI (booking, worker chair view, cashier billing, manager day-board/reporting/bookkeeping). Now 4 of 6 modules have live schema; modules 1/2/3 have working UI, module 5 is schema-only, modules 4 & 6 are spec-only.
- **2026-07-09 (night):** **Module 2 surveys shipped** — professor creates per-class survey questions and toggles results visibility from the Manage console; students answer (one response per survey, editable) on the class landing page; when the professor flips a survey's results visible, students see aggregate answer counts via the `cls_survey_results` definer function (raw answers stay owner/staff-only — never exposed). No new migration (schema existed from the classroom migration). Seed adds a demo survey. e2e 13/13 (1 new), typecheck clean. **Module 2 still remaining:** exam grading UI (schema exists), subproblem-level GA grading, automatic gradebook combination, retention sweep, GA-tailored views. These are the lower-priority tail; module 2's core teaching loop (materials → submit → GA/peer grade → final → surveys) is complete.
- **2026-07-09 (evening):** **Module 1 (matchmaking) is now usable end-to-end** — full UI on the live schema. Single view: answer approved questions (position radios + care slider −10..+10 + dealbreaker + share-with-match, admin-locked fields disabled), see own top-X matches from `mm_pair_scores` (RLS hides excluded/other pairs; stale rows flagged "recompute pending"). Matchmaker view: matches for assigned singles (RLS-scoped). Admin Manage console: approval queue (approve/reject proposed questions), question authoring (with care/dealbreaker locks — the gender-hard-filter pattern), and a **"Recompute all matches"** button. **The recompute is the pragmatic no-worker path** (the `matchmaking.rescore` worker isn't deployed): it runs the *pure* `pairScore` engine (`@modules/matchmaking`) inside a Next server action, reading every single's answers — which only works because an admin can read them under RLS (the staff `for all` policy covers SELECT). It deliberately does NOT use the service-role key (that stays in the worker, per the platform invariant). Shared helper `apps/web/lib/matchmaking.ts`; the seed uses the identical engine to precompute demo scores. Demo org `demo-match`: 4 singles (charlie/dana/eve/frank), matchmaker mel; a gender dealbreaker excludes same-gender pairs, Charlie↔Dana top at 91%. e2e 12/12 (1 new), RLS 7/7 (updated: alice now administers 3 orgs), matchmaking unit 26/26, typecheck clean. **Module 1 remaining:** the rescore worker (so recompute isn't manual), the mutual-agreement→introduction flow + share-with-match reveal (a single can't yet see a match's shared answers — RLS blocks cross-single answer reads, needs a definer function), group/assignment management UI, and the conversations primitive for users→admin messaging (deferred — doesn't exist platform-wide yet).
- **2026-07-09 (latest):** **Module 1 (matchmaking) schema integrated** — `mm_questions`/`mm_answers`/`mm_pair_scores`/`mm_groups`/`mm_group_members`/`mm_matchmaker_assignments` live local + prod (`20260709020000_matchmaking.sql`), drafted by a background agent then security-reviewed by hand (mirroring the classroom rhythm): fixed a `SECURITY DEFINER` RPC (`mm_ensure_answer`) that bypassed the "only singles answer questions" role gate, and a missing pin on `mm_answers.question_id`/`user_id` that let a user corrupt the one-row-per-(question,user) invariant via UPDATE — both fixes verified live against Postgres (a matchmaker's RPC call now correctly rejects, a single's succeeds, and a repoint attempt gets silently reverted). Manifest registered in the module registry but **not enabled for any org** — schema only, no UI yet, so it's fully dark. Module 1's next slice is the actual UI: question answering (sliders), admin approval queue, matches list. RLS 7/7, matchmaking unit tests 26/26, web e2e 11/11, typecheck clean.
- **2026-07-09 (later):** **Module 2 (classroom) core assessment loop complete** — grading workflow UI at `/manage/grading/[homeworkId]`: professor drives submitted → GA grading → peer review → done; GA enters a grade (own column only, RLS-enforced); "move to peer review" calls the existing pure `assignPeerReviews` engine (modules/classroom/src/peer-review.ts, already had unit tests) with real roster/submission/history data and writes the `cls_review_assignments` matrix; "finalize" averages submitted peer grades into a `cls_grades` row per submission; professor publishes an override/final grade, gated `is_final`+`visible` per the spec's student-sees-Final-only rule. New anonymous peer-review page (`/classroom/review/[assignmentId]`): reviewer sees the submission's files + their own comments, submits a grade — RLS (`cls_reviews_submission`, `locked=false`) enforces the boundaries, reviewer identity never reaches the reviewee. Classroom landing page gained "Peer reviews assigned to you" and "Your grades" sections. No new migration — built entirely on existing tables from the classroom migration. Seed extended with a second student (Dana) and pre-seeded submissions so peer review (which needs 2+ people) is testable; e2e 11/11 (1 new, multi-step: GA grade → peer assign → peer grade+comment → finalize → publish → student sees final grade), RLS 7/7, typecheck clean. **Remaining for module 2:** GA-specific dedicated views (current grading console works for both roles but isn't tailored to GA-only workflows), exam grading UI, survey UI. Reasonable next stopping point for module 2 before returning to module 1.
  **e2e gotcha found:** a `page.goto()` immediately after a mutating form-submit `.click()` can race and abort the in-flight POST before the server finishes writing (no thrown error — the click "succeeds" as a UI action, the write silently never lands). Fix: assert on a DOM change that only appears after the mutation completes (e.g. button text flips from "Publish" to "Update") before navigating away. Also: Playwright role/text locators scoped with `hasText` on a `<tr>`/`<div>` match ANY descendant text, including another row's/section's content that happens to mention the same name — scope by an exact-match cell/label instead of a substring filter when two entities' names can appear inside each other's row.
- **2026-07-09:** **Module 2 (classroom) materials + homework submission slice live in production.** Professor Manage console gained a Materials page (`/manage/materials`): create course materials (URL or file upload to `cls-materials`), publish into a class with an optional visible_from/visible_until window, unpublish. Students see published materials on the class landing page (window enforced by RLS, not just UI) and can now open a homework's own page to upload/list/remove submission files against the `cls-submissions` bucket, gated by `cls_submission_open()` (deadline + still-`submitted`). **Security-review finding fixed before shipping:** the draft's `cls_materials_storage_read` policy only checked org membership, not the publication visibility window enforced on the `cls_materials` table — any org member could read a not-yet-published or expired file directly from storage if they had the path. Replaced with a definer function (`cls_material_storage_visible`) that mirrors the table rule exactly; added the missing staff write/delete storage policies (`20260709010000_classroom_materials_storage.sql`). e2e 10/10 (2 new: publish-window enforcement, submission upload), RLS 7/7, typecheck clean. Migration applied local + prod.
  **New Windows gotcha found this session:** Next.js 16 dev mode's Turbopack persistent cache (`.next/dev/cache/turbopack/*.sst`, mmap-based) crashed repeatedly under `pnpm dev` with "paging file is too small" / tiny-heap OOM, even with ~7GB free RAM — root cause never fully pinned down (transient memory pressure from Docker+dev+Playwright browsers together, most likely). Workaround: build once (`pnpm --filter web build`) and run e2e in CI mode locally (`CI=1 pnpm test:e2e`, which uses `next start` instead of `next dev`) — stable every time. Prefer that over debugging the dev-mode cache when e2e needs to run locally.
- **2026-07-07 (night):** **Module 3 ACCEPTANCE PASSED** — Pozna's real Shabbos schedule reproduced from real myzmanim values (`pozna-acceptance.test.ts`, 49 module tests). Rule grammar complete (open zman vocab, day anchors, clamps, line-refs, fallback text, weekday conditions, title templating + molad) and fully exposed in the rule-builder UI. **Extraction pass done** (docs/03 conventions; `requireOrgModule()` gate; module 3 = exemplar). **Production live: solutions-platform.vercel.app** (Vercel via GitHub Actions deploy, prod Supabase migrated, founder is superadmin, real org `pozne` configured; walkthrough test script in docs/08). PARKED: myzmanim auth (context in module SPEC). NOT deployed: worker (prod exports pend until Phase B VPS). **Module 2 scaffold + module 1 scoring engine being drafted by agents** into modules/classroom/ and modules/matchmaking/ (drafts; integration next).
- **2026-07-07 (late):** **Module 3 core loop complete** — rule grammar + evaluator + week generator (15 unit tests), schedule view UI, maker setup UI (rule builder, publish controls, weekly messages), export pipeline (job_requests contract + worker Playwright renders → syn-exports bucket, verified: pdf/jpg files), public no-login viewer at `/s/<slug>` via security-definer functions exposing only published weeks. e2e 7/7; CI green through run #13; all four migrations on prod Supabase (`jbjqrkxdoiolwlglvoki`).
  **Blocked on founder:** myzmanim API key (connector next), sample schedule + rules sheet (acceptance validation), Vercel account (signup broken — fallback: VPS hosting per docs/05).
  **Platform primitives that now exist:** job_requests (async job→result), storage bucket w/ org-scoped read, has_module_role(), settings-in-org_modules pattern, public-access-via-definer-functions pattern.

- **2026-07-06 (evening):** M0 foundation built and verified locally. Monorepo scaffolded (Next.js 16 web app, pg-boss worker, packages/db + platform); core schema with RLS applied to local Supabase; seed script (`pnpm seed`) creates founder + two demo orgs; **RLS isolation tests 7/7 passing** (`pnpm --filter @platform/db test`); auth (password + magic link) + entitlement-driven app shell + stub module + owner console render and gate correctly; dev harness (`pnpm dev`) and CI workflow written. Local logins: owner/alice/bob `@demo.local` / `password123`.
  **2026-07-07 update:** pushed to GitHub (`github.com/jasonartis/Solutions`, remote pinned to the `jasonartis` credential) — CI green including RLS tests. Playwright e2e added (5 tests: entitlement chain, cross-org 404, console, redirects, sign-out) and wired into CI against the prod build. `dev:cloud-db` mode added with staging-only guard rails. `pnpm status` shows what's running; worker serves `/healthz` on :8901.
  **Remaining for M0:** first cloud deploy (founder does docs/07 Parts 2–3: Supabase + Vercel accounts), Sentry/UptimeRobot wiring at deploy time. `dev:docker` deliberately deferred to the VPS-deploy milestone. Then M1: module 3 (synagogue schedules) — needs founder's sample schedule output + rules sheet + synagogue zip + myzmanim key.
- **2026-07-06:** Planning complete. Six module specs + all architecture/tech/ops decisions documented.

