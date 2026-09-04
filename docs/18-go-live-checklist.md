# Go-live checklist — the minimum to take on a real client

**Written 2026-08-29.** The question this answers, exactly as the founder framed it:
*what has to be true before the platform can take on a new client and build that client
a new module on the generalized infrastructure we already have?*

**This is deliberately MINIMAL.** Everything here is either a legal/operational blocker or
something whose absence loses data or hides an outage. The long tail of hardening,
feature depth and open design questions is NOT here — it lives in CLAUDE.md's "Next /
open" list and in docs/12's risk register, and a paying client does not have to wait for
any of it. §4 names what was deliberately left off and why, because a checklist that
silently omits things reads as "nothing else exists."

**Sizing note.** "Session" = one focused working session, the unit the platform journal
actually shows (see docs/history/platform-journal.md). Founder chores are wall-clock
minutes, not sessions, and several can happen in parallel with build work.

---

## The short version

| # | Item | Whose job | Size | Blocks what |
|---|------|-----------|------|-------------|
| 1 | Monitoring + keep-alive | **CODE DONE.** Founder: 1 free Sentry account (UptimeRobot already existed) | ~1 session | Silent outages; **prod pausing itself** |
| 2 | Automated + tested backups | **DONE 2026-09-01/02.** | ~1–2 sessions | Unrecoverable data loss |
| 3 | Privacy + terms page | Claude drafts, **founder owns wording** | ~1 session | Legal exposure the moment a real person signs in |
| 4 | Worker on a real host | Claude (runbook exists) | ~30 min | Retention never runs in prod |
| 5 | Vercel Pro | Founder | ~10 min, ~$20/mo | **Commercial use is prohibited on Hobby** |
| 6 | 2FA on GitHub / Vercel / Supabase | Founder — **raised 2026-09-03, deliberately deferred until the first real client is signed** | ~15 min | One compromised account defeats every safeguard |
| 7 | Custom SMTP | Founder account + Claude config | ~half session | Auth email rate limits at real volume |
| 8 | Onboarding rehearsal | **DONE 2026-09-02.** | ~half session | Finding gaps live, in front of the client |

**Total: roughly 4–6 sessions of build work, plus about an hour of founder account chores.**
Items 5 and 6 can be done today and are independent of everything else.

**STATUS AS OF 2026-09-03: items 1, 2, 3 (draft awaiting founder review), and 8 are done.
Items 4, 5, 6, and 7 are ALL DELIBERATELY PAUSED, founder's call, same trigger: they each add
real cost or a new external dependency (a VPS, a $20/mo plan, a domain + email service) to
solve a problem that only exists once a real client generates real volume — no real client
exists yet. Extract-don't-speculate applies to this checklist too, not just to code. Revisit
items 4/5/6/7 together when the first real client is signed, not before.**

---

## 1. Monitoring + keep-alive — *do this first* — **CODE DONE 2026-08-31/09-01, verified live on prod**

**Status: the app-side half is shipped and prod-verified.** `/healthz`
(`apps/web/app/healthz/route.ts`) and Sentry's guarded wiring
(`apps/web/instrumentation.ts` + `instrumentation-client.ts` +
`app/global-error.tsx`) are on master and deployed. **One founder action
remains: create the free Sentry account and paste the DSN into Vercel as
`NEXT_PUBLIC_SENTRY_DSN`** — until then Sentry stays inert by design (no
crash, no code path taken, just never initialized). See docs/14 for the
account row.

**UptimeRobot is NOT a founder action — it already exists and is live**
(confirmed 2026-08-31: a real monitor on `https://solutions-platform.vercel.app/s/pozne`,
100% uptime the prior week, corroborated independently by curling the URL
directly). This checklist item's own premise ("founder makes 2 free
accounts") was half wrong — only Sentry is actually new. **Recommended
follow-up, not required:** add a second UptimeRobot monitor on `/healthz`
once convenient — it's a purpose-built JSON probe (proves the DB
round-trip specifically) rather than a full page render, and free-tier
UptimeRobot allows 50 monitors, so this is additive, not a replacement.

**A genuinely new exFAT-drive finding, worth keeping for the next session
that adds any dependency in this family:** adding `@sentry/nextjs` broke
`next build` LOCALLY on this Windows/exFAT machine with a Turbopack
`TurbopackInternalError: failed to create junction point` naming
`require-in-the-middle`/`import-in-the-middle` — Next.js's own
`serverExternalPackages` default list (any dependency Next treats as
"don't bundle, use native Node `require`") needs a real symlink/junction
into `.next/node_modules`, which exFAT cannot create, for the SAME reason
`workspace:*` links were already banned (docs/01). This is NOT a code bug
and NOT specific to how minimally Sentry is used — it reproduced even
with only the client-side instrumentation file present, because
`next build` still resolves the package's Node entry points during SSR.
**Verified via a throwaway PR against GitHub Actions (Ubuntu, real
symlinks): `pnpm build` passes clean on Linux** — proving this is a local
Windows-only limitation, not a real defect, before it ever reached
master. Any FUTURE dependency on Next's `serverExternalPackages` list
(`pg`, `sharp`, `playwright`, `bcrypt`, etc. — full list in
`node_modules/next/dist/docs/.../serverExternalPackages.md`) will hit the
exact same local-build wall; verify the same way (a PR triggers `check`
on Linux with zero deploy risk, since `deploy` only runs on a master
push) rather than assuming the dependency is broken.

**UPDATE 2026-09-04 — this was investigated to a conclusion, and the conclusion
is that IT CANNOT BE FIXED IN PLACE. Do not re-attempt the workarounds; four
were tried and all are dead, recorded with their exact error signatures in
CLAUDE.md's exFAT bullet under "Key standing decisions":** `distDir` onto an
NTFS path (Next's own docs forbid leaving the project directory), `next build
--webpack` (the flag exists in Next 16 and gets past exFAT's `readlink` error
with `resolve.symlinks = false`, then dies inside Next's own
`FlightClientEntryPlugin`), dropping `@sentry/nextjs` (it is genuinely wired in
at three call sites — real error monitoring, and item 2 of this very checklist),
and any in-place filesystem trick (exFAT hosts neither junctions nor volume
mount points). The root cause was proved rather than inferred: `mklink /J`
succeeds on C: (NTFS) and fails on D: (exFAT) with *"Local NTFS volumes are
required to complete the operation."* **The only real fix is moving the repo to
NTFS** — which would also retire docs/01's `workspace:*` ban and the
`node-linker=hoisted` pin, since both exist for this same reason. Founder's
call; CLAUDE.md carries the step-by-step including which gitignored files git
will not bring. **Until then the verify-via-CI advice above remains correct and
is proven to work** — an e2e failed in CI on 2026-09-04, was diagnosed from the
CI log, and passed on re-land, with no local run at any point.



**Why it is first, and why it is not merely prudent.** docs/12 item 1: Supabase free-tier
projects **pause themselves after ~7 days without activity**, and docs/12 item 2: there is
no monitoring of any kind, so "errors and downtime are invisible until a user complains."
Those two compound. A quiet week takes production down and nothing tells anyone — that is
true of the platform *today*, before any client exists.

A 5-minute uptime ping fixes both at once: it is the alert, and the traffic it generates
is itself the activity that prevents the pause.

- A `/healthz` route handler in `apps/web` that makes one cheap, RLS-safe database
  round-trip and returns JSON. It must be uncacheable — a cached health check reports the
  last good result forever and never touches the database, losing both purposes. (Next 16
  does not cache route handlers by default; state it explicitly anyway.)
  **Open question to settle when building it: which query can `anon` legitimately make?**
  The 2026-07-28 ACL sweep left `anon` holding nothing in `public`, so the obvious
  `from('orgs').select()` probably returns a permission error rather than an empty set —
  which would make a healthy platform report unhealthy. Check what the existing public
  page under `apps/web/app/s/` actually reads and mirror it.
- The worker already serves `/healthz` (`apps/worker/src/index.ts`) — point a monitor at
  it too, once item 4 puts the worker somewhere with a URL.
- Sentry wired into the web app, guarded on the DSN env var so it stays inert until the
  founder supplies one.

**Founder:** free UptimeRobot account (50 monitors), free Sentry account, paste the DSN
into Vercel's env vars.

## 2. Automated, tested backups — **DONE 2026-09-01/02**

docs/12 item 8, a founder decision of 2026-07-27. Full story, including the vacuous-test
trap avoided while verifying the restore: docs/12's "Backups" section.

`.github/workflows/backup.yml` runs the existing `pnpm backup:prod` script nightly and
stores the dump as a GitHub Actions artifact (90-day retention) — founder-controlled, off
Supabase/Vercel/the dev PC, no new account. Verified with a real manual run (304KB artifact
from actual prod data). **The rehearsal — the actual deliverable, not the dump script —
is done too**: restored a real backup into a throwaway Supabase project and proved it with
live `select count(*)` queries (not the stale `pg_stat_user_tables` statistics column,
which read 0 right after the load and would have been a false negative). Scratch project
deleted after.

## 3. Privacy + terms page

docs/12 item 6, and **overdue twice over**: engagement monitoring phases 1 and 2 both
shipped without the wording their own specs called a precondition (recorded honestly at the
time rather than the rule being quietly relaxed). Two lines are owed, not one — phase 1's
"authentication events (when you sign in)" and phase 2's materially larger per-org activity
line, which logs what someone opened and when.

Exposure is **nil today** — prod holds only demo and founder accounts — and stops being nil
the moment a real person signs in. It is one page and two sentences of engineering.

Also needs a documented answer for deletion requests, including the deliberate tension
docs/12 already records: `view_as_sessions` and `superadmin_lookup_log` are append-only by
design, and *an audit log a deletion request can empty is not an audit log*.

**The founder owns this wording.** Claude drafts; do not ship words about what the platform
collects without the founder reading them.

## 4. Worker on a real host

docs/10 holds the deploy runbook (~30 minutes, a small VPS). Until it runs somewhere real,
`pnpm worker:prod` is the only production execution path, which means **the 90-day retention
pruners never run in prod** and raw `login_events` / `activity_events` accumulate past their
stated window — a claim the privacy page in item 3 would otherwise be making falsely. The
pruners are idempotent and range-based, so the first real run catches up rather than needing
a backfill.

## 5. Vercel Pro

docs/12 item 5: **the Hobby plan prohibits commercial use.** Fine for testing; not fine the
day a client pays. ~$20/month, ten minutes.

## 6. 2FA on GitHub, Vercel and Supabase

docs/12 item 3. These three accounts are the real keys to the pipeline, the secrets and the
database — a compromised GitHub account defeats every safeguard in docs/12. Fifteen minutes.

## 7. Custom SMTP

docs/12 item 7: Supabase's built-in sender is rate-limited and unsuitable for real signup
volume. Needs a sending domain and a provider account.

## 8. Onboarding rehearsal — **DONE 2026-09-02**

Rehearsed end to end against **real production**, signed in as the actual superadmin (not a
service-role bypass — this exercises the exact RLS-gated path the console UI uses):
create org → enable a module → resolve an existing member by email → add them active →
grant a module role → read every write back with real row counts (not a vacuous check).
All six steps worked cleanly on the first try. Full click-path, in order:

1. `orgs.insert({name, slug})` — creates the org.
2. `org_modules.upsert({org_id, module_key, enabled: true})` — turns on one module.
3. `rpc('org_find_user_by_email', {check_org_id, target_email})` — resolves an email to a
   user id, scoped to the org (the same RPC `addMember`'s UI uses).
4. `org_members.insert({org_id, user_id, role, status: 'active'})` — superadmin-only escape
   hatch to add someone already-active rather than pending (docs/03 slice 3).
5. `module_roles.upsert({org_id, user_id, module_key, role})` — grants the module-level role.
6. Read every row back independently (org, membership, module role) with real `select`s, not
   `pg_stat_user_tables`-style shortcuts.

**Two real findings, not hypothetical:**
- **The console has NO way to delete an org.** `apps/web/app/(app)/console/actions.ts` has no
  `deleteOrg` — cleaning up the throwaway org needed a direct owner-level SQL connection
  (`delete from orgs where id = …`), bypassing the app entirely. Every `org_id`-referencing
  table cascades correctly except `superadmin_lookup_log` (deliberately `SET NULL`, matching
  its append-only design elsewhere in this doc set) — so a raw delete is SAFE, just not
  reachable from the UI. **This is a real operational gap**: today, undoing an onboarding
  mistake (wrong slug, wrong client) requires a Claude session with `.env.deploy` access, not
  something the founder can do solo from the console. Not launch-blocking (mistakes are rare
  and reversible with help), but worth a founder decision on whether it's worth building.
- **A new client's people must sign up for an account BEFORE an admin can add them** —
  `resolveEmailToUserId`/`org_find_user_by_email` returns nothing for an email with no
  account yet, and the real UI surfaces this as "No user found … they must sign up first."
  This is expected behavior (by design, not a bug), but it's a real sequencing fact for
  onboarding communication: tell a new client's members to create their login first, THEN
  the admin adds them — not the other way around.

Rotate the demo password afterwards (docs/12 item 4) — **still open**, unrelated to this
rehearsal (this rehearsal used an existing demo user, `dana@demo.local`, read-only from its
perspective; nothing about the demo password was touched).

---

## Building the new client their module

Little to do here — this is what the last two months bought.

- `modules/sample` is the living template, kept in the registry so CI proves the copy-me
  path stays green; docs/03 is the process, including the #12 security rhythm every
  migration follows.
- The shared infrastructure a new module inherits on day one: orgs, members, invites and
  entitlements; RLS with `org_id` on every table; the module-role ladder with ranks and
  scoped grants; view-as; the per-person data browser; engagement monitoring; the superadmin
  console and its lookup log.
- **The one real risk, and it is a strategy risk rather than a task** (docs/00): building
  for one client tends to over-fit. Reselling an *existing* module to a *second* client
  needs a deliberate generalization pass that nobody has budgeted. Building a *new* module
  for a new client does not — that is the path the template supports.

---

## 4. Deliberately NOT on this list

None of these blocks a first client. Recorded so their absence reads as a decision.

- **Open design questions** — `profiles_select_shared_org` hierarchy narrowing,
  `view_as_sessions` admin-read narrowing, the second-superadmin ordering (genuinely
  unbuildable until a second operator exists), `sd_interest`/`sd_matches` surface
  classification. All need a founder decision, none blocks a client.
- **What gates `master`** — investigated 2026-08-28, decision pending. Not launch-blocking:
  prod is gated by `needs: check` in the workflow, so a red commit deploys nothing.
- **Feature depth** — slice 4 (defaults-on-join), entity-level joinPolicy, rank-mapping the
  three single-entity modules. Real features; nobody is waiting on them.
- **Deferred hardening** — storage-schema grants, the ~9 over-granted helpers,
  `service_role`'s retained TRUNCATE, the per-position × per-table visibility map. One has
  an external clock worth tracking: **Supabase removes the legacy auto-expose 2026-10-30**,
  which is when the `ALTER DEFAULT PRIVILEGES` drift item stops being theoretical.
- **Speed-dating video (Jitsi)** — **updated 2026-09-04**: the provider interface, JWT
  join-token issuance, and the click-to-join UI are all shipped and CI-verified (module-6
  spec's dated entries); what remains is a real Jitsi server (local `docker-jitsi-meet` or
  the deployed VPS) to prove the actual WebRTC connection, plus the VPS deploy decision
  itself — still the largest single piece of INFRASTRUCTURE the platform is missing, just
  no longer unbuilt code. Still irrelevant unless the first client is a speed-dating client.
- **Modules 7 and 8** — both marked DRAFT / NOT SCOPED; module 8 needs a file-level
  investigation of the legacy app before it can even be estimated.
