# 17 — Engagement monitoring (superadmin)

**Status: PHASES 1, 2 AND 3 ARE LIVE ON PRODUCTION** (phase 1 + 3: `20260809010000_login_events.sql`,
built 2026-08-09; phase 2: `20260810010000_activity_events.sql`, schema built 2026-08-11,
instrumented and deployed to prod 2026-08-21 — see the 2026-08-16→08-21 decisions-log entry for the
full story). Phase 4 (hierarchy-governed reads) remains sketched only and is NOT approved to build.
Login capture is live: an `AFTER UPDATE OF last_sign_in_at` trigger on `auth.users` appends to
`public.login_events` and maintains a permanent `public.login_rollup` summary; a 90-day pruner trims
the raw detail. Org-scoped activity capture is also live: ~48 `recordActivity()` call sites across
all 6 modules write to `public.activity_events`/`activity_rollup` under RLS as the caller — **phase 2
SHIPS CAPTURE-ONLY, no reader yet** (decisions log item 10), so `/console/engagement` (phase 3)
still reads phase 1's tables only. The console page answers §1's two directions for logins — see
§8b's decisions-log entry for what phase 3 actually built, its test coverage, and the schema-friction
it reports back per item 12.
**Six things were built differently from the draft below and every one is recorded in the
decisions log with its reasoning — read that entry before trusting any paragraph in §5 or §6,
which have been corrected in place.** The largest change: there is NO `profiles` mirror.

---

## 1. The question this answers

Founder, 2026-08-09, verbatim in substance:

> See how often each organization has members login, then expand down to the individuals of
> the organizations and how often they logged in. Or start from the individuals and their
> logins and see which organizations they have been using. Basically something to see who is
> engaged and using the platform and who I should reach out to to see what can be made better
> for them since they have not been utilizing the platform.

So the deliverable is an outreach tool, not analytics for its own sake: **which orgs and which
people have gone quiet.** Two directions, org→people and person→orgs, both explicitly asked
for.

**And a future enhancement to design around, not to build now** (founder, same day):
eventually a manager should see the engagement of the people *below them* — engagement
visibility becomes hierarchy-governed rather than superadmin-only. §7 covers what phase 1 must
get right so that is possible without a rewrite.

---

## 2. THE FINDING THAT DECIDES THE DESIGN

**`auth.audit_log_entries` has never been written to on production.**

Measured 2026-08-09, read-only, against prod: `pg_stat_all_tables` for
`auth.audit_log_entries` shows `ins=0, del=0, live=0` — not pruned, *never inserted*. The
control matters as much as the finding, because a zero row-count is exactly the shape of a
broken query: on the same connection, `auth.users` showed `ins=12`, `auth.sessions`
`ins=27 / del=12 / live=15`, `auth.refresh_tokens` `ins=51`. The read works. The absence is
real. Supabase's hosted GoTrue routes auth logs to platform logging, not to this table.

**Locally that same table is fully populated** — 160 rows (148 `login`, 11 `user_signedup`,
1 `logout`), one per sign-in, with a clean `payload.actor_id` joining to `auth.users` on all
148. Note `ip_address` is EMPTY on all 160 rows even locally, so no IP-based signal exists
there regardless.

> This is the ACL trap in a new costume, and it is the reason this document exists before any
> code does. Build the feature on `audit_log_entries` and it works perfectly on the developer's
> machine and is permanently, silently empty in production — an engagement dashboard reading
> "nobody has ever logged in", which looks exactly like a true answer.

### What production actually has

| Source | What it gives | Usable? |
|---|---|---|
| `auth.users.last_sign_in_at` | The LAST login. No history. | Yes, but it answers "when", never "how often" |
| `auth.sessions` | `created_at`/`refreshed_at`, plus `user_agent` and `ip` (both populated) | No — lossy by construction; 12 of 27 rows already deleted by logout / token rotation. The only place device/IP exists at all, if that is ever wanted |
| `auth.audit_log_entries` | One row per sign-in | **No — empty on prod** |

**Conclusion: login frequency does not exist anywhere today.** It has to be captured going
forward, and — exactly like the superadmin lookup log — *a log started later can never cover
the period before it existed.* That is the argument for building phase 1 sooner rather than
later, independent of when the UI gets built.

---

## 3. THE SECOND HARD FACT: a login cannot be attributed to an org

People sign into the **platform**, not into an org. `auth` has no org concept, and the audit
payload carries only `actor_id` / `actor_username` / provider. For someone who belongs to three
orgs, "logged into org B" is undefined at the auth layer.

The only thing linking a person to an org is `org_members` / `module_roles` — **membership, not
activity.**

**AND THERE IS NO ACTIVITY RECORD ANYWHERE ON THE PLATFORM TODAY.** Surveyed 2026-08-09:
nothing records "user X did something in org Y at time T". `org_members` has `created_at`,
`invited_at`, `accepted_at` and no activity column; `module_roles` has `created_at` and is
mutated in place. The only tables carrying `(org_id, actor, created_at)` are
`vm_moderation_log`, `view_as_sessions`, `superadmin_lookup_log` and `job_requests` — each
locked to one tool by a CHECK or an insert policy, none of them general. The single piece of
prior art in the whole repo is **`vm_conversation_members.last_seen_at`**, which is per
conversation, not per org.

*Recorded as a NEGATIVE finding on purpose:* the natural first instinct in phase 2 will be to
look for an existing activity table to extend. There isn't one, and re-running that search
costs an hour to arrive back here.

So the founder's two questions need two different data sources:

| Question | Honest source |
|---|---|
| Is this *person* alive on the platform at all? | login events (phase 1) |
| Is this *org* actually being used? | org-scoped activity (phase 2) |

**Rejected: fanning one login out to each of a member's orgs.** It would turn one sign-in into
three "engagements" and make a three-org member look three times as active as a one-org member
who uses the platform more. That is a false claim, and the docs/03 rule about under- vs
over-reporting applies: this over-reports, which is the direction that misleads an outreach
decision.

`org_members.status = 'pending'` must be excluded from any org rollup, or "invited but never
accepted" reads as "disengaged member" — the opposite of the truth, and it would send the
founder to apologise to someone who never joined.

---

## 4. Constraints the design must satisfy

All verified against the repo, 2026-08-09:

1. **The web app may never use a service-role client** (docs/01, docs/03 #14, docs/12). The key
   exists only in the worker, scripts and CI.
2. **The console path may not call `.rpc()`** — machine-enforced by a source scan in
   `rls.test.ts`. docs/03 #19 is explicit about why: the superadmin UI gate is sound *only*
   because every query is one the caller could already issue. One SECURITY DEFINER call turns
   the app gate into the only thing between a user and data RLS would have refused.
3. **The `auth` schema is unreachable from the web client.** `config.toml` exposes `public` and
   `graphql_public` only; `authenticated` holds no grant on `auth.users`, and those tables have
   RLS on with zero policies.
4. **Every migration must state its full ACL explicitly** (docs/03 #1) — prod's
   `ALTER DEFAULT PRIVILEGES` grants `EXECUTE` directly to `anon`/`authenticated`, which
   `revoke ... from public` does not remove. Name all four roles.
5. **Any new column with an FK to `auth.users`/`profiles` fails `pnpm test`** until it is
   declared in `data-browser-modules.ts`. This already caught the lookup log.

Constraints 1–3 together rule out reading `auth` from the console. §5 is the way through.

---

## 5. Phase 1 — capture logins

### The mechanism, and why it is not novel

GoTrue updates `auth.users.last_sign_in_at` on every sign-in. **The repo already owns a trigger
on `auth.users`** — `on_auth_user_created`, an `AFTER INSERT` calling `handle_new_user()`,
live in production since `20260706120000_core.sql:34-51`. An `AFTER UPDATE OF last_sign_in_at`
sibling is the same mechanism, already proven to survive the managed environment.

That gives real per-login history **on prod**, independent of the audit table that never fills.

```
auth.users  --AFTER UPDATE OF last_sign_in_at-->  public.login_events (append, 90-day raw)
                                             \->  public.login_rollup  (permanent summary)
```

**CORRECTED AS BUILT (2026-08-09): the second arrow is NOT `profiles`.** The draft called for
mirroring `last_sign_in_at` onto `profiles`, and the *reason* was right — the console must reach
the timestamp through ordinary RLS, with no definer call and no `auth` access (constraints 2
and 3). The *location* was wrong, and it took a live catalog read to see why.

`profiles` is not private. `profiles_select_shared_org` (`20260708020000`) admits **every member
of every org you belong to**, and RLS filters ROWS, never COLUMNS — so any column added to
`profiles` is readable by all of them. Column-level grants cannot rescue it: they are per-ROLE,
so hiding the column from a colleague hides it from the superadmin too and breaks `select *`
across the app. **Demonstrated live rather than argued:** signed in as charlie (salon customer,
rank 0) and read 8 profile rows including frank's (salon admin, rank 3).

Today that timestamp is readable through the API by **nobody**. So the mirror was not a neutral
relocation of data the platform already exposes — it was a new disclosure to a new audience, and
a behavioural one (working hours, holidays, whether someone has quietly stopped showing up) as
opposed to the static facts `profiles` already carries. §9's "not a new CATEGORY of data"
argument is sound about RETENTION BY ONE OPERATOR and says nothing about audience.

`login_rollup.last_login_at` satisfies constraints 2 and 3 identically and is superadmin-only.
It is also BACKFILLED from `auth.users` at migration time, so the console has day-one answers
for everyone who existed before capture began — which the trigger-fed mirror as drafted would
not have given.

**Founder-confirmed 2026-08-09** ("superadmin-only for now"). Two items were parked in the same
exchange and are on CLAUDE.md's open list: whether `profiles_select_shared_org` should itself be
hierarchy-narrowed for name/email (the founder's stated rule — *lower never sees higher* — does
conflict with it today, and changing it touches every roster in every module), and the standing
trap that **anything placed in `profiles.settings` is readable by every org-mate** (today it
holds one console preference, `superadminDefaultAddActive`, so nothing sensitive).

### Table shape (draft — the adversarial review may change it)

Copy `superadmin_lookup_log` (`20260807010000`), which is the audited precedent:

- **Append-only enforced by GRANTS, never a trigger.** `ON DELETE SET NULL` is implemented as a
  real UPDATE, so a `before update or delete ... raise exception` trigger would make every
  referenced row permanently undeletable. This is a documented, already-paid-for lesson.
- **Every FK `on delete set null`**, so the log outlives what it describes, and **no CHECK
  constraint fighting it** — a `not null` CHECK re-creates exactly the trap the trigger did.
- **`revoke all privileges ... from public, anon, authenticated, service_role`**, then grant
  only what is needed. Note `view_as_sessions` missed `service_role` here and needed a repair
  migration; do not repeat it.
- **Server-stamped**, never client-supplied: `occurred_at := now()`.

### What phase 1 does NOT carry, deliberately

**No `org_id`, no `module_key`, no role, no scope.** A login has no org context (§3), so those
columns would be null on 100% of rows — and the lookup log's own migration header warns
specifically against adding hierarchy columns speculatively, because all-null is precisely what
invites the rank-0 confusion later (§7). Founder-approved 2026-08-09.

---

## 6. Retention — **90 days raw + permanent rollup** (founder decision, 2026-08-09)

Raw login events are pruned at 90 days, and a permanent per-user summary survives.

**CORRECTED AS BUILT (2026-08-09), because the obvious reading of that sentence is the fragile
one.** The draft said the summary is what "the pruner deletes is folded into" — i.e. maintained
BY the destructive nightly job. It is instead maintained by the CAPTURE TRIGGER at write time,
which is the same retention decision implemented so that it cannot silently fail:

- the summary is correct at every instant, even if the pruner never runs, runs twice, or is
  deleted outright;
- the pruner can then only ever destroy detail that has ALREADY been counted — "prune loses
  data" becomes impossible by construction rather than by care;
- `last_login_at` is a genuine last-login. Folded at prune time it could only ever hold a
  timestamp from >90 days ago, which is useless as the very field the outreach question asks for.

**And "logins in the last 30 days" is deliberately NOT a stored column.** The pruner only ever
sees rows ≥90 days old, so a pruner-maintained 30-day counter would be permanently zero. It is a
live query over the raw window (always ≥30 days of coverage) in phase 3.

**The stored columns are named for what they can honestly claim:** `last_login_at` (backfilled,
then maintained), `first_observed_login_at`, `observed_logins`, `observed_since`. A column called
`total_logins` would be false on every backfilled row — §2's own point is that a log started
later cannot cover the period before it existed.

Reasoning: the detail anyone acts on is recent — "quiet for six weeks" is an outreach trigger,
"signed in on a Tuesday last March" never is. The rollup keeps the long-term signal, volume
stays bounded, and **a counter is a much smaller claim about a person than a permanent
minute-by-minute record of their working hours.**

> **This creates a real tension that needs its own review, and must not be smuggled in.**
> Grant-layer append-only is exactly why nothing can prune the two existing logs. A prunable
> log needs a narrow, deliberate exception: a `SECURITY DEFINER` function owned by `postgres`
> that can delete *only* rows past the window, callable by the worker and by nobody else — not
> by `authenticated`, not from the console path. Alternative worth costing at build time:
> monthly partitions dropped by the owner, which needs no DELETE grant at all.

**RESOLVED AS BUILT (2026-08-09) — and the tension turned out smaller than this paragraph
predicted, so do not read the blockquote above as a live requirement.** Neither option was
needed. A `SECURITY DEFINER` is only necessary if a NON-owner must call the function, and the
only caller is the worker, which already connects as the table owner (`postgres` locally,
`postgres.<ref>` through the session pooler on prod — verified to be the same role).
`public.login_events_prune()` is therefore **`security invoker`, takes no arguments, and holds
EXECUTE for nobody at all**. `invoker` is what makes it safe rather than merely gated: the
function can never do more than its caller, so a future careless `grant execute … to
service_role` still fails at the privilege layer, because that role holds no DELETE on the
table. Full reasoning in the migration header and §11.

**This decision does not extend to `superadmin_lookup_log` or `view_as_sessions.`** Those record
superadmin *actions*, where docs/12's unresolved tension stands — *an audit log that a deletion
request can empty is not an audit log*. Different purpose, different answer, still open.

---

## 7. Designing phase 1 so the hierarchy version is possible later

### 7.1 The trap, inherited from the lookup log

`superadmin_lookup_log`'s read policy is a flat `is_superadmin()` with **no rank arm, and the
absence is the security decision.** `module_position_rank` returns **0 for any unmapped pair and
never null**, so a rank arm written the obvious way computes an off-ladder actor's rank as 0 —
and every rank-1 holder (a salon cashier, a classroom GA) strictly outranks the platform
operator and reads their whole cross-tenant history. Silently, error-free, passing any test that
merely asserts the policy exists.

**This applies to an engagement table, and it is worse there.** An engagement row's *subject* is
an ordinary member who may genuinely be unranked in a given module — a salon customer, a
student, anyone with no `module_roles`. A rank arm keyed on the subject scores all of those at 0
too, so **every rank-1 holder would see the engagement of every unranked person in the org**.
That is not "the people below them"; it is most of the org.

Also inherited: **an arm keyed on `actor_user_id = auth.uid()` survives demotion.** Key on who
someone IS, never on who they WERE.

When the rank arm is eventually written, the row must carry the actor's own
`(position, scope_ref)` and **the arm must require them NOT NULL**, so a row written by someone
outside the ladder can never be captured by a rank comparison.

### 7.2 What genuinely cannot be deferred

`module_roles` is **mutated in place with no history** — an UPDATE may re-point `role` or
`scope_ref` on the same row, and DELETE removes it outright. Therefore:

> **A person's role and scope at the time of an event cannot be reconstructed afterwards.**

Both existing logs already denormalise for exactly this reason (`view_as_sessions` stores
`target_role` + `target_scope_ref`; `superadmin_lookup_log` stores `module_key`, `position`,
`scope_ref`, with `position` deliberately free text rather than an FK).

| Field | Reconstructable later? | Verdict |
|---|---|---|
| display name, email, org name, *current* role | Yes | Defer |
| `org_id`, `module_key` of the activity | No | **Phase 2: mandatory at write time** |
| subject's role **as of that moment** | **No** | **Phase 2: mandatory at write time** |
| subject's `scope_ref` **as of that moment** | **No** | **Phase 2: mandatory at write time** |

Phase 1 (logins) has no org context at all, so it carries none of these — see §5.

---

## 8. Phases

| Phase | What | Status |
|---|---|---|
| **1** | Login capture: trigger on `auth.users`, read-only `login_events`, permanent `login_rollup` (no `profiles` mirror), prune | **BUILT 2026-08-09** |
| **2** | Org-scoped activity, written by the app as the user under RLS, carrying org/module/role/scope stamped at write time | **BUILT, INSTRUMENTED AND LIVE ON PROD 2026-08-21** — capture-only, no reader yet |
| **3** | The console page: org rollup → drill to people; person → their orgs | **BUILT 2026-08-09** |
| **4** | Hierarchy-governed visibility (a manager sees those below them) | Future enhancement, §7 — **and it belongs on phase 2's data, not phase 1's; see below** |

**PHASE 4 MUST BE BUILT ON PHASE 2, NOT ON LOGINS (recommended 2026-08-09, founder agreed).**
The founder asked directly whether higher-ups will be able to see the logins of those below them
later. Mechanically yes — a hierarchy arm on `login_rollup` is additive, needs no data migration,
and nothing shipped in phase 1 forecloses it. But it would answer the wrong question, for the
reason in §3: **a login has no org.** Telling frank "dana signed in Tuesday" is a PLATFORM fact.
Dana may have signed in solely to use a different org — possibly a different client — so frank
would be reading activity that has nothing to do with his salon, which is a small cross-tenant
disclosure dressed up as an engagement metric. What frank actually wants is "is dana using MY
salon", and that is phase 2's org-scoped activity, which *does* carry `org_id` and over which a
hierarchy arm is clean and meaningful.

So: **raw logins stay superadmin-only permanently; hierarchy-governed engagement is a phase 2/4
feature over org-scoped activity.** The §7.1 rank-0 trap still governs whenever that arm is
written — an engagement row's subject is often genuinely unranked, so the arm must require both
parties to be on the ladder and fail closed otherwise.

---

## 8a. Console integration notes (surveyed 2026-08-09 — saves re-deriving it in phase 3)

Recorded because it was established by reading the code and is not obvious from it:

- **There are only four files under `apps/web/app/(app)/console/`** — `page.tsx` (index + org
  CRUD), `actions.ts`, `data-browser/page.tsx`, `view-as/page.tsx`. **There is no
  `console/layout.tsx` and no shared page shell**, so a new tool brings its own.
- **`requireSuperadmin()` lives in `apps/web/lib/platform.ts`**, not in the console files:
  `createClient()` → `auth.getUser()` → `profiles.is_superadmin` → `notFound()` on failure,
  returning `{ supabase, userId, gate }`. The `SuperadminGate` brand is in the same file and
  the **only** place that mints it is the cast inside that function — enforced by a test in
  `rls.test.ts`.
- **The console nav is inline JSX, not a data array** (`console/page.tsx`, the tool list).
  A new tool is hand-added there — there is no registry to extend.
- **A new console page must also be added to `CONSOLE_PATH` in `rls.test.ts`**, or it is never
  source-scanned for the two bans that make the UI gate sound (no `.rpc()`, no service-role on
  that path). Missing that is silent: the page works and simply is not checked.
- **`data-browser.ts` already has an `activity: boolean` section flag**, used for
  `job_requests`, `view_as_sessions` and `superadmin_lookup_log`. Its declaration format
  (`table, personColumns, orgColumn, orderBy, limit, note`) is directly reusable, and it is
  already org-pivoted then person-pivoted — the same two directions §1 asks for. What it does
  NOT do is aggregate; engagement is a third question and docs/03 #19 requires the page to say
  so explicitly rather than look like a fourth data-browser tab.
- **One inconsistency noticed, not fixed:** `console/page.tsx` does its own inline
  `getProfile()` superadmin check, and `console/actions.ts` carries a *duplicate private*
  `requireSuperadmin()` that THROWS where the shared one 404s. Not a hole — both still gate —
  but a new tool should use the shared `platform.ts` one, and this is worth cleaning up
  separately rather than copying.

## 8b. PHASE 3 CHECKLIST — everything the console page must get right, in one place

**STATUS: BUILT 2026-08-09 — every item below addressed; see the decisions log entry for how, plus
the schema-friction item 12 asked for.** Kept as a checklist (not rewritten past tense) because it
is still the right shape for auditing the build against.

Collected 2026-08-09 after phase 1 shipped, because these requirements were scattered across §3,
§8a and §10 of a long document and the platform's own lesson is that **open state spread through a
document is open state that gets missed.** Each item names its source section.

1. **BADGE A FAILED OR ABSENT CAPTURE, with a test that renders the badge** (§10 point 4). This is
   the hard requirement, not a polish item: the capture trigger swallows its own errors so it can
   never cause a login outage, which makes a capture failure SILENT. Render "newest captured
   login" so a human can see capture has stopped. A badge is a claim to the operator, and a test
   that keeps passing after the claim goes false is worse than no test.
2. **EXCLUDE `org_members.status = 'pending'` from every org rollup** (§3). An invited-but-never-
   accepted member otherwise reads as a *disengaged* member — the opposite of the truth, and it
   would send the founder to apologise to someone who never joined.
3. **"No rollup row" means NEVER SIGNED IN** (§6). Drive the population from
   `org_members`/`profiles` and LEFT JOIN `login_rollup`; absence is the answer, not an error.
   On prod today that is 7 of 12 accounts, which is most of the feature's value.
4. **Do not present `observed_logins` as a lifetime total** (§6). It counts from `observed_since`,
   which for backfilled users is the migration date. `last_login_at` IS trustworthy for everyone
   (it was backfilled from `auth.users`); the counter is only trustworthy after `observed_since`.
   Showing them side by side without that distinction is the kind of false claim §2 exists to
   prevent.
5. **"Logins in the last 30 days" is a LIVE QUERY over `login_events`**, never a stored column
   (§6) — and it is only meaningful while retention holds, which on prod waits on the worker.
6. **No `.rpc()` and no service-role client on the console path** (§4 constraints 1–2). The
   superadmin UI gate is sound *only* because every query is one the caller could already issue.
   Both tables are readable by an ordinary `.select()` as a superadmin, so nothing here needs a
   definer call.
7. **Add the new page to `CONSOLE_PATH` in `rls.test.ts`** (§8a). Missing this is SILENT: the page
   works and simply is never source-scanned for the two bans that make the UI gate sound.
8. **Bring your own page shell and hand-add the nav entry** (§8a). There is no
   `console/layout.tsx` and the tool list is inline JSX, not a registry.
9. **Say plainly that this is a THIRD question, not a data-browser tab** (§8a). The data browser
   answers "what do we hold about this person"; view-as answers "what does this person see";
   engagement answers "who has gone quiet". docs/03 #19 requires the page to state which.
10. **Use the shared `requireSuperadmin()` from `apps/web/lib/platform.ts`** (§8a) — not
    `console/actions.ts`'s duplicate private copy, which throws where the shared one 404s.
11. **Org→people and person→orgs, both directions** (§1) — the founder asked for both explicitly.
    Remember a login cannot be attributed to an org (§3), so the org direction shows *members'
    platform activity*, and the page must not imply it means "activity in this org". That
    distinction is phase 2's whole reason for existing.
12. **PHASE 3 IS THE FIRST CONSUMER OF PHASE 1, SO TREAT QUERY FRICTION AS FEEDBACK ON THE SCHEMA
    — NOT AS SOMETHING TO WORK AROUND SILENTLY.** Phase 1 was designed and shipped without a
    single reader existing, which means every claim about how pleasant it is to query is currently
    a prediction. If the outreach queries turn out to need a column that isn't there, an index
    that doesn't exist, or a join that reads awkwardly, SAY SO and record it here — that is real
    evidence about the design, and it is much cheaper to act on in phase 2 (which ships its own
    migration anyway) than to discover after phase 4 has been built on the same shape. Two things
    specifically worth reporting: whether `login_rollup`'s single index on `last_login_at` serves
    the "who has been quiet longest, across every org" query, and whether the deliberate absence
    of `org_id` forces an uncomfortable amount of client-side joining through `org_members`.
    Working around friction in the page instead of naming it is how a schema's flaws become
    permanent.

## 9. Privacy and disclosure (founder decision, 2026-08-09)

**No user-facing notification, no consent flow, no setting. One line in the privacy policy when
it is written** (docs/12 item 6, pre-launch).

The reasoning, recorded because the first pass overstated it: Supabase already records
`last_sign_in_at` for every user today, so capturing sign-ins is not a new *category* of data
about anyone. What is new is **retention** (a history rather than the latest timestamp) and
**cross-org aggregation by one operator**. The proportionate response to that is disclosure in
the policy — "authentication events (when you sign in)" under what we collect — not a notice.

**Phase 2 is a bigger claim and the line moves.** Logging *what someone opened and when*, per
org, is materially more than a login timestamp. That wording must exist **before** phase 2
ships, not after.

Two further constraints already on the books: an engagement row is personal data about its
subject, so it is disclosable in a subject-access request and must appear in the per-person data
browser; and any FK to `auth.users`/`profiles` must be declared in `data-browser-modules.ts` or
the test suite fails.

---

## 10. Verification plan (docs/03 #12 — this ships a migration, so the full rhythm applies)

> **Model, decided 2026-08-09: build on Opus; run the adversarial review step on Fable.**
> The build is ordinary Opus-tier migration/RLS work. The REVIEW earns the top tier under the
> "novel mechanism, not a copy of an audited pattern" test for one specific reason: **the prune
> function is a `SECURITY DEFINER` that can DELETE from an otherwise append-only table**, and
> every existing log on this platform is append-only with no exception whatsoever. That is a
> new hole in an established invariant, on a table of personal data. Switch manually at that
> beat rather than delegating it.

**AS BUILT: that premise was a pre-build prediction and the shipped function is NOT a
`SECURITY DEFINER`** (see §6 and §11) — kept above unedited because it is the recorded reasoning
for spending the top tier, and it was still the right call: the review's one HIGH finding
(`WHEN OTHERS` does not catch `query_canceled`) was in the capture trigger, not the pruner, and
would not have been found by a check of the thing everyone expected to be dangerous. The tier
was earned; the stated reason for it simply stopped being true once the design got narrower.


**AS RUN, 2026-08-09 (all beats completed; detail in the decisions log and the journal):**
draft → orchestrator read → prod pre-flight (read-only, 11 checks) → claimed-Fable adversarial
review → findings applied → 12 RLS tests (floor 104 → 116) → local live round-trip → typecheck
9/9, build clean, db 121/121, e2e 49/49 CI-STRICT → prod deploy → `prod-verify-login-events.mts`.
**One process lesson worth more than the feature: `turbo run test` reported `>>> FULL TURBO` —
every task a cached replay — after a migration had changed the schema, and it was read as a real
pass. Turbo cannot see database state, so a cached test result after a migration proves nothing.
Now a CLAUDE.md gotcha.** It was caught only because the review noticed the local tables were
empty when they should not have been.

1. Draft the migration → **orchestrator reads it** → independent adversarial review → apply
   findings → RLS tests → live round-trip as real users.
2. **Prod-verify with `scripts/prod-verify-superadmin-log.mts` as the template**, not
   `prod-verify-migration.ts` — that one parses `create function` blocks, so on a table/policy
   migration its "0 failures" is vacuous. Check the real prod ACL, each policy's expression,
   **the ABSENCE of a rank arm asserted as a negative**, the trigger being BOUND rather than
   merely defined, and every FK's delete action — each with its own control.
3. **A control the moment it is live: prove capture actually works on PROD.** This whole
   document exists because a table that looks right locally can be permanently empty in
   production. Sign in as a demo user against prod and assert a row appears. An empty
   engagement table is indistinguishable from "nobody is using the platform", which is the one
   answer this feature must never give falsely.
   **DONE 2026-08-09, and here is how to re-run it** (the verifier's last check fails until you
   do, on purpose — a green run with zero captured events would be the vacuity rule shipping as
   a checkmark). POST to
   `https://<SUPABASE_PROJECT_REF>.supabase.co/auth/v1/token?grant_type=password` with the
   `SUPABASE_ANON_KEY` as the `apikey` header and `alice@demo.local` +
   **`PROD_DEMO_PASSWORD`** — all three keys are in `.env.deploy`. Then re-run
   `pnpm exec tsx scripts/prod-verify-login-events.mts`; `raw events captured since deploy`
   must be non-zero. **Do NOT use the superadmin account for this:** prod's superadmin is the
   founder's real account, and `owner@demo.local` is forced to `is_superadmin = false`
   off-localhost by `seed.ts`'s remote guard.
4. **The UI must badge a failed or absent capture**, per the lookup log's badge discipline — and
   a test must assert the badge, because a badge is a claim to the operator and a test that
   keeps passing after the claim goes false is worse than no test.

---

## 11. Open questions

- ~~**The prune mechanism** (§6): narrow `SECURITY DEFINER` function vs. monthly partitions.~~
  **RESOLVED 2026-08-09 — and it turned out much smaller than this question assumed.** Neither
  option was needed: a `SECURITY DEFINER` is only necessary if a non-owner must call it, and the
  only caller is the worker, which already connects as the table owner. So it is
  `security invoker`, takes NO arguments (the window is a literal in the body — a
  `prune(older_than interval)` would have been the natural shape and the entire vulnerability,
  since one caller passing `interval '0 days'` empties the table), and holds EXECUTE for
  **nobody**: not `authenticated`, not `service_role`, not `anon`. A leaked service-role key
  cannot prune. `security invoker` also buys a second lock free — a future careless
  `grant execute … to service_role` still fails, because that role holds no DELETE on the table.
  The 90 is asserted against `pg_get_functiondef` by the RLS suite, so editing it trips CI.
  **The one live caveat: retention is not enforced in prod until the worker runs there** (still
  the `pnpm worker:prod` stopgap, docs/10). The prune is idempotent and range-based, so the first
  real run catches up.
- **Phase 2's activity granularity** — every page view is too much noise and too much data; "a
  meaningful action per module" needs defining per module, which risks becoming per-module
  bespoke work.
- ~~**Whether the rollup counters are themselves subject to a deletion request.**~~ **ANSWERED
  BY CONSTRUCTION 2026-08-09: yes.** Both tables' FKs are `on delete cascade`, so erasing an
  account erases its raw events AND its rollup row. This is a deliberate divergence from both
  existing logs (`on delete set null`, so an oversight log outlives what it describes) and the
  reasoning is in the migration header: a `vm_moderation_log` row with a null actor still says
  "somebody moderated this", whereas a login event with a null `user_id` is unattributable,
  unaggregatable and undisclosable — retained personal data with zero informational value. It
  also means `user_id` is `not null`, so "every row names a real person" is a database guarantee.
  Asserted behaviourally in the RLS suite (create an account, sign in, delete it, assert both
  tables are empty for it AND that the delete succeeded — nothing became undeletable).
  **But do not read that as "erasure is handled": THERE IS NO ACCOUNT-DELETION PATH IN THE
  PRODUCT AT ALL.** Verified 2026-08-09 by searching the whole repo for `deleteUser` — the only
  caller anywhere is the RLS test fixture above. Nothing in `apps/web`, `apps/worker` or
  `scripts/` deletes a user, so today erasure happens only by hand through the Supabase
  dashboard or a service-role call. The cascade means it *would* do the right thing the moment
  such a path exists; docs/12 item 6's "deletion requests need a documented process" is still
  entirely open, and this table is now one more thing that process has to name.
- **Phase 4's read policy**, which is the §7 trap in full. Not to be attempted without the
  founder and its own adversarial review.

---

## 12. Phase 2 build brief — gathered 2026-08-10, ready for an Opus session

**NOT founder-approved to build.** The founder asked for this to be gathered ahead of switching
models, not for phase 2 to start — treat everything below as a well-informed draft for the Opus
session's docs/03 #12 rhythm (draft → adversarial review → findings → RLS tests → live verification
→ docs), not as sign-off. It answers §11's open granularity question with real evidence instead of
guessing, so the Opus session can start on a concrete draft rather than re-deriving one.

### 12.1 What was gathered, and how

Six parallel read-only surveys (2026-08-10), one per module, of every real write/mutation path
(server actions, not reads) in `modules/*/ui/**/actions.ts` and what actually calls them from
`apps/web/app/(app)/o/[orgSlug]/m/**`. Synthesized in 12.2–12.3 below; the full per-module findings
— including the reasoning behind every exclusion, not just the curated recommendation — are in
**§12.6**, inlined rather than left in this session's chat transcript, which will not exist for
whatever session builds phase 2. Nothing was written anywhere — this is inventory only.

### 12.2 The cross-module pattern that fell out of the survey

Every module has the SAME three-way split, which means the granularity question has one honest
answer rather than six bespoke ones:

1. **Deliberate content/work — the clear "meaningful action" signal.** A submission, a booking, a
   payment, a published schedule, an expressed interest, a posted reply, a grade, an exam created.
   The founder's own examples in §8b item 12 (booking an appointment, checking out a bill) are
   exactly this category, and every module has 2–4 actions that clearly belong in it.
2. **Read-triggered writes masquerading as activity — must be EXCLUDED, not merely de-prioritized.**
   The clearest examples: classroom's `getOrCreateSubmission` (fires on opening a homework page,
   not on doing work) and matchmaking's `mm_ensure_answer` RPC (fires on every page load for a
   single, lazily seeding a default row). These are writes caused by *viewing*, not by *acting* —
   logging them would make "engagement" mean "loaded a page," which is precisely the noise §11
   warned about. **Any table/query that decides what's "meaningful" must check against this list
   explicitly, not assume `INSERT` implies intent.**
3. **Config/housekeeping toggles — low value, arguably exclude.** Visibility flags, promo/service
   on-off switches, deletes of one's own upload, schedule-type cleanup. Real writes, but they read
   as platform administration, not "used the platform today." Borderline; a case can be made either
   way, but including them dilutes the outreach signal the founder actually wants.

**Two cross-cutting exclusions independent of any one module:**
- **System/worker-driven writes must never be attributed to a human.** Matchmaking's `recompute`
  can be invoked by an admin OR by the `matchmaking.rescore` background tick — same function, no
  acting user on the worker path. Speed-dating's `promoteNextWaitlisted` is similarly
  capacity-management-driven rather than a human decision most of the time. **The activity-recording
  call must live at the SERVER ACTION call site (which knows there's a real, authenticated caller),
  never inside a shared function also invoked by the worker.**
- **Bulk operations are one event, not N.** classroom's grading-workflow bulk transitions and
  matchmaking's `recompute` upsert many rows from one admin decision — log once per invocation, keyed
  to the action, not once per row affected.

### 12.3 Recommended action taxonomy (per module, for the Opus session to confirm/amend)

Real-signal candidates, module by module — the ones worth an explicit `recordActivity()` call site:

- **classroom:** `uploadSubmissionFile`, `submitPeerGrade`, `addReviewComment`, `postAnnouncement`,
  `createHomework`/`createExam`/`createSurvey`, `submitGaGrade`/`saveExamScores`,
  `publishFinalGrade`/`publishExamFinal`, `uploadExamPaper`. Excluded: `getOrCreateSubmission`
  (read-triggered — see 12.2), `setSubmissionsHiddenFrom`/`setSurveyResultsVisible`/`setRevealUntil`
  (toggles), plain deletes.
- **nail-salon:** `customerBookAppointment` (strongest signal — the module's flagship), `bookAppointment`,
  `walkInAdd`, `createBillForAppointment`, `markBillPaid` (the founder's own "checking out a bill"
  example), `addExpense`, `purchaseShoppingItem`. Excluded: catalog/promo toggles, shopping-list
  housekeeping, schedule/time-off config (infrequent admin, not daily use).
- **matchmaking:** `expressInterest`/`withdrawInterest` (strongest signal), `saveAnswer` (real, maybe
  debounce per question/day), admin actions (`createQuestion`, `approveQuestion`/`rejectQuestion`,
  `recompute` — ONLY the admin-invoked path, `createGroup`, `addGroupMember`/`removeGroupMember`,
  `assignMatchmaker`). Excluded: `mm_ensure_answer` (read-triggered — see 12.2).
- **speed-dating:** `registerForEvent` (strongest signal), `markInterest` (the module's core "submitted
  a round result" action), `createEvent`, `runPairingRound`, `revealMatches`, `reviewReport`.
  Borderline, Opus/founder to decide: `saveProfileCard`/`saveNote` (low-stakes self-edits),
  `fileReport` (real but sensitive — logging it at all needs its own privacy thought, not a reflexive
  yes). Excluded: `promoteNextWaitlisted` (system-driven), `setEventState` transitions probably
  collapse to one "ran an event" signal rather than one per transition.
- **synagogue-schedules:** `publishWeek` (the module's best single "did their job" signal — weekly
  cadence), `createLine` (the real config-authoring action), `createOverride`. Excluded: deletes,
  `unpublishWeek` (correction, low value). Note this module is almost entirely read-only display —
  its writer population is just makers, and the write surface is small; do not expect this module to
  generate much activity volume, which is a true fact about the module, not a gap in the design.
- **visual-messaging:** `replyWithDrawing` (the core "posted content" signal, equivalent to sending a
  message), `createConversation`. Excluded: `toggleReaction` (the CANONICAL noise case — high
  frequency, low value, explicitly what §11 warned about), `uploadImageStamp` (plumbing step, not a
  result), `setJoinPolicy` (toggle). Moderator actions (`tombstoneLayer`, `restoreLayer`,
  `reviewFlag`, `setBranchFrozen`) are real but role-scoped — flagged as possibly belonging to a
  separate "moderation activity" concept rather than ordinary member engagement; Opus/founder call.

### 12.4 Structural recommendations (draft only — the review step may change all of this)

- **One shared table, not six per-module ones** — matching phase 1's own shape
  (`login_events`/`login_rollup` are platform primitives, not module tables) and the fact that the
  whole point of phase 2 is one cross-module engagement view. Working name: `public.activity_events`.
- **Mandatory columns at write time** (§7.2, non-negotiable): `org_id`, `module_key`, actor's `role`
  and `scope_ref` AS OF THAT MOMENT (not looked up later — `module_roles` is mutated in place, so
  this is unreconstructable afterwards). Plus `user_id not null`, `action text not null` (free text
  from the curated list in 12.3, not an FK to a vocabulary table — matches the platform's
  explicit-over-clever style and `superadmin_lookup_log.position`'s precedent of deliberately free
  text), `occurred_at`.
- **Written by the app AS THE USER under RLS — a genuinely different write shape from phase 1.**
  `login_events` has NO user-facing write path (only a trigger, running as owner). This table DOES —
  every module action calls it, as the caller. That makes it structurally closer to
  `superadmin_lookup_log` (insert to `authenticated`, policy-checked) than to `login_events`. Recommend
  a single shared helper in `packages/platform` (matching "shared behavior goes through
  packages/platform"), so ~30 call sites across 6 modules share one insert path rather than
  reimplementing the write six times.
- **A failed activity write must never break the real action it's attached to** — the same
  criticality judgement phase 1's capture trigger made (an analytics defect can't become a platform
  outage), applied at the app layer instead of a DB trigger this time since these are ordinary app
  inserts, not trigger-fired. Needs its own decision: swallow-and-log like the trigger, or
  swallow-and-badge like the superadmin lookup log's failure badge? The lookup log's UI-facing badge
  works because a human is looking at the screen right after the write; a module action (booking an
  appointment) has no equivalent "did this get logged" moment, so an unlogged activity event may need
  to fail silently server-side (a Postgres `raise warning`-equivalent, i.e. log-and-continue) rather
  than surface anything to the actor. Real design question for the Opus session, not resolved here.
- **Retention/rollup shape is unresolved and may not want to copy phase 1's.** Phase 1's rollup is
  one row per user (a login has no other dimension). Phase 2's natural rollup key is
  `(user_id, org_id, module_key)` — a rollup keyed only on `user_id` would lose exactly the
  cross-module, per-org signal that's the entire point of phase 2. Needs its own founder decision
  on raw retention window and what the permanent summary claims.
- **Read policy: superadmin-only for v1, structured so a hierarchy arm can be added later without
  the §7.1 rank-0 trap.** Store the actor's OWN `(role, scope_ref)` as NOT NULL from day one (already
  mandatory per 12.3) — that's what lets a future rank arm require both parties on the ladder and
  fail closed otherwise, rather than retrofitting it. Do not write the rank arm itself now (§11: not
  without the founder and its own adversarial review).
- **ACL pattern: reuse `superadmin_lookup_log`'s conventions wholesale** — `revoke all ... from public,
  anon, authenticated, service_role` then grant exactly `select, insert` to `authenticated`; `for
  select`/`for insert` as separate policies, never `for all`; no update/delete grant to anyone (this
  table wants append-only too, and unlike phase 1 it has no `ON DELETE SET NULL` FK-fires-triggers
  trap to worry about if it follows phase 1's `on delete cascade` choice for personal-data-with-no-
  informational-value-if-orphaned — re-derive which FK action is right here rather than copy either
  precedent blindly, since this table's purpose is closer to phase 1 (member behaviour) than to the
  two oversight logs).
- **`data-browser-modules.ts` declaration required** (§4 constraint 5) — a new table with an FK to
  `auth.users` fails `pnpm test` until declared; this is a build-time task, not a design one, flagged
  here only so it isn't missed.

### 12.5 What is still a real founder decision, not something Opus should just pick

1. The exact final action list per module (12.3 is a strong draft, not sign-off) — especially the
   flagged borderlines (speed-dating's `fileReport`, visual-messaging's moderator actions).
2. Raw retention window + rollup shape for phase 2 (12.4) — likely NOT identical to phase 1's.
3. Failed-write handling (12.4) — silent server-side log vs. some UI signal.
4. Whether moderator/staff actions across modules (grading, exam intake, flag review, tombstone/
   restore) count as the SAME "engagement" as member actions, or a separate bucket — this affects
   whether "who has gone quiet" ever conflates a professor grading with a student submitting.

### 12.6 Full per-module write-path inventory (verbatim findings, 2026-08-10 survey)

The complete findings behind 12.2–12.3's synthesis, inlined so nothing behind the curated
recommendation is lost. Every write/mutation path found in `modules/*/ui/**/actions.ts`, per module.

**classroom** (`ui/actions.ts`, `ui/homework/[homeworkId]/actions.ts`,
`ui/review/[assignmentId]/actions.ts`, `ui/manage/actions.ts`, `ui/manage/materials/actions.ts`,
`ui/manage/grading/[homeworkId]/actions.ts`, `ui/manage/exams/[examId]/actions.ts`):
- `answerSurvey` (student) — insert/update `cls_survey_answers`. Real: genuine content submission.
- `getOrCreateSubmission` (student) — creates `cls_submissions` on first page visit. **NOISE —
  fires from opening the page, not doing work; a page-view event in disguise.**
- `uploadSubmissionFile` (student) — insert `cls_submission_files` + storage. Real: clearest
  "turned in homework" signal.
- `deleteSubmissionFile` (student) — remove own upload. Low-value/incidental.
- `submitPeerGrade` (student-as-reviewer) — update `cls_review_assignments`. Real: graded work.
- `addReviewComment` (student-as-reviewer) — insert `cls_review_comments`. Real: authored feedback.
- `createCourse`, `createClass` (professor/coordinator) — real, infrequent structural setup.
- `enrollClassMember` / `removeClassMember` (professor/GA) — real roster management; borderline/
  noisy if done in bulk-import loops.
- `postAnnouncement` (professor) — real: authored content to students.
- `createHomework`, `createExam`, `createSurvey` (professor) — real: the doc's own "created an
  exam" example.
- `setSubmissionsHiddenFrom` (professor) — noise: retention-date config toggle.
- `setSurveyResultsVisible` (professor) — noise: visibility flag flip.
- `createMaterial` / `deleteMaterial` (professor) — create is real (authored content); delete is
  mostly cleanup/noise.
- `publishMaterial` / `unpublishMaterial` (professor) — publish is real ("made content available");
  unpublish is closer to noise.
- `moveToGaGrading`, `moveToPeerReview`, `finalizePeerReview` (professor/GA) — real bulk workflow
  transitions; one click affects many rows — worth ONE event per invocation, not per row.
- `submitGaGrade`, `saveExamScores` (GA) — real: the canonical "graded work today" action.
- `computeCombinationFinals` (professor) — real but automated/batch.
- `publishFinalGrade`, `publishExamFinal` (professor) — real: publishing a grade.
- `setRevealUntil` (professor) — noise: a display/access-window tweak.
- `uploadExamPaper` (staff/GA) — real: recording physical exam intake.
- Noise cluster, explicit: `getOrCreateSubmission`, `setSubmissionsHiddenFrom`,
  `setSurveyResultsVisible`, `setRevealUntil`, `unpublishMaterial`, plain deletes.

**nail-salon** (`ui/actions.ts`, `ui/manage/actions.ts`):
- `bookAppointment` (operator/cashier) — real: core "used the platform" event.
- `walkInAdd` (staff) — real: front-desk transaction, creates login-less customer + books.
- `customerBookAppointment` (customer, self) — **strongest signal**: the customer's own booking.
- `setAppointmentState` (staff) — mixed: state-transition writes (booked→checked_in→completed→
  cancelled); noisy if every transition counts equally, "completed"/"cancelled" might be worth one
  event each.
- `createBillForAppointment` (staff/cashier) — real: revenue-producing action.
- `markBillPaid` (cashier/manager) — **strongest signal candidate**: literally the doc's own
  "checking out a bill" example.
- `createService` (manager) — real but infrequent setup; borderline noise if bulk.
- `setServiceActive` (manager) — low-value/incidental config toggle.
- `createPromotion` (manager) — real but rare setup, not daily-use signal.
- `setPromotionActive` (manager) — low-value/incidental.
- `addExpense` (manager/bookkeeper) — real: recurring genuine bookkeeping activity.
- `addShoppingItem` (manager) — low-value/incidental (a to-do, not a business outcome).
- `purchaseShoppingItem` (manager) — real: closes the loop, produces a real expense record.
- `cancelShoppingItem` (manager) — low-value/incidental list housekeeping.
- `setWorkerSchedule` (manager) — occasional config, not a recurring "used it today" signal.
- `addWorkerTimeOff` / `removeWorkerTimeOff` (manager only, no worker self-service) — real but
  infrequent/administrative, more HR upkeep than daily platform usage.

**matchmaking** (`ui/actions.ts`, `ui/manage/actions.ts`):
- `saveAnswer` (single) — real, deliberate engagement with the questionnaire; consider deduping
  multiple saves on the same question in one sitting (per question/day) to avoid over-counting
  slider fiddling.
- `expressInterest` (single) — **strongest signal**: "I want to be introduced to this person."
- `withdrawInterest` (single) — real decision/action, lower frequency than saves.
- `mm_ensure_answer` RPC, called from `ui/page.tsx` on every page load for a single — **NOISE,
  explicit exclusion**: a write caused purely by viewing the page, lazily seeding a default row.
- `createQuestion` (admin) — real: genuine content-authoring action.
- `approveQuestion` / `rejectQuestion` (admin) — real: moderation decisions.
- `recompute` (admin) — real, ONCE per invocation not per row upserted into `mm_pair_scores`. **Same
  function is also invoked by the `matchmaking.rescore` background worker tick with no acting
  user — that path must never be logged as engagement.**
- `createGroup` (admin) — real setup/admin action.
- `addGroupMember` / `removeGroupMember` (admin) — real roster-management, though can be bulk/
  repetitive in one sitting.
- `assignMatchmaker` / `removeAssignment` (admin) — real admin configuration actions.
- Summary: every admin action here is real, low-frequency, deliberate — safe to log 1:1. For
  singles, `expressInterest`/`withdrawInterest` are highest-value; `saveAnswer` meaningful but may
  need debouncing; `mm_ensure_answer` is the one write path that must be excluded as noise.

**speed-dating** (`ui/actions.ts`, invoked from `ui/page.tsx` and `ui/events/[eventId]/page.tsx`;
the apps-router pages are thin re-export wrappers with no logic of their own):
- `createEvent` (organizer) — real: set up a new event.
- `setEventState` (organizer) — real key lifecycle milestone, but fires once per transition — may
  want to log distinctly per transition or dedupe to "ran an event."
- `registerForEvent` (participant) — **strong real signal**: the canonical "used the platform"
  action for a participant (handles side/capacity/waitlist logic).
- `withdrawFromEvent` (participant) — real but rare/negative action.
- `promoteNextWaitlisted` (organizer/staff, or future worker) — **low-value/exclude**: system-driven
  capacity management, not really "staff did something" in a human-intent sense unless done as a
  deliberate manual override.
- `runPairingRound` (organizer, manual stand-in for the orchestrator worker) — real: substantive
  organizer action.
- `markInterest` (participant) — **strong real signal**: the core "submitting a round result"
  action this module exists for.
- `revealMatches` RPC (organizer) — real but infrequent/one-off per event.
- `saveProfileCard` (participant, self-only) — borderline: genuine content contribution but more
  setup/profile-editing than activity; noise if resaved repeatedly.
- `saveNote` (participant) — low/ambiguous: private per-person scratch notes, author-only
  visibility, very low stakes; could fire on every keystroke-adjacent autosave.
- `fileReport` (participant) — real but rare/sensitive: a safety report; worth flagging but
  sensitive to log with detail — needs its own privacy thought, not a reflexive yes.
- `reviewReport` (organizer/staff) — real: staff moderation action.
- `blockUser` / `unblockUser` (participant, cross-event) — low-value/noise-leaning: defensive/
  administrative.
- Note: `export.ts` in the same UI dir is read-only (organizer exports/reports queries), not a
  mutation path.

**synagogue-schedules** (`ui/setup/actions.ts`, `ui/export-actions.ts`; gated by RLS's
`syn_can_write` — makers/org owners/admins/superadmins only):
- `createScheduleType` / `deleteScheduleType` (maker) — create is real setup/config; delete is
  rare/incidental cleanup.
- `createSection` / `deleteSection` (maker) — same pattern: create real, delete incidental.
- `createLine` (maker) — **strong real signal**: the most complex action (builds/validates a time
  rule), the core "did work" action for this module.
- `deleteLine` (maker) — incidental cleanup, weaker signal.
- `publishWeek` (maker) — **arguably the best single "did their job" signal** for this module:
  strong, recurring, weekly cadence.
- `unpublishWeek` (maker) — rare correction; low value, mostly noise.
- `createOverride` (maker) — real, recurring, good signal (weekly special messages).
- `requestExport` (maker, `export-actions.ts`) — enqueues a render job; low-effort/one-click and
  easily repeated (double-clicks, retries) — borderline/noisy unless deduped per week.
- **No update/reorder actions exist at all** for schedule types, sections, or lines — only create/
  delete, no edit-in-place. No CRUD for `syn_export_profiles` via UI despite appearing in the export
  schema (presumably seeded/admin-only).
- **Overall finding, itself important: this module is almost entirely read-only display.** The
  entire write surface is the maker's setup console plus one export button — no viewer/congregant
  writes at all. Do not expect this module to generate much activity volume; that is a true fact
  about the module, not a gap in the design.

**visual-messaging** (`ui/actions.ts` is the sole write surface; `page.tsx`/`layer-grid`/
`layer-canvas` call into it via props/handlers):
- `createConversation` (any member starting a thread) — real: inserts conversation + creator
  membership + root `vm_layers` row. Strong "did something real" signal.
- `uploadImageStamp` (anyone drawing a reply) — noise on its own: an intermediate storage-only step
  with no message-level result yet; the real signal is the reply it becomes part of.
- `replyWithDrawing` (any participant) — **strong real signal**: the core "posted content" action,
  equivalent to sending a message.
- `joinConversation` RPC `vm_join_conversation` (new participant via deep link) — moderate: a real
  one-time onboarding event, not a recurring "used it today" action.
- `addMember` (admin/participant inviting someone) — moderate: meaningful for the inviter but
  infrequent/admin-flavored.
- `setJoinPolicy` (conversation admin) — low/incidental: a settings toggle, not content creation.
- `toggleReaction` (any viewer) — **NOISE, the canonical example**: high-frequency, low-value,
  easy to spam by clicking — explicitly the kind of engagement that would be noise if logged.
- `flagLayer` (any member) — moderate/situational: rare and meaningful, but a safety action, not
  "used the product" in the typical sense — arguably its own category rather than generic engagement.
- `reviewFlag` (moderator) — strong for the moderator role, but role-specific, not general activity.
- `tombstoneLayer` RPC `vm_tombstone_layer` (moderator) — strong, moderator-only.
- `restoreLayer` RPC `vm_restore_layer` (moderator) — strong, moderator-only, low frequency.
- `setBranchFrozen` RPC `vm_set_branch_frozen` (moderator/admin) — low-moderate: administrative,
  infrequent.
- Bottom line: `replyWithDrawing` and `createConversation` are the clean candidates.
  `toggleReaction` is the canonical noise case. `uploadImageStamp`/`setJoinPolicy` are incidental
  plumbing. Moderator actions may warrant a separate "moderation activity" bucket rather than
  counting toward regular member engagement (same open question as 12.5 item 4).

---

## Decisions log (dated)

- **2026-08-21 — PHASE 2 IS FULLY LIVE ON PRODUCTION, capture proven with a real event.** Closes the
  instrumentation work opened 2026-08-16 (call sites, RLS test port, prod-verify script — commit
  `d653d4d`) and a CI regression fixed the same week (commit `f121539`; full account: CLAUDE.md's
  gotchas and `docs/history/platform-journal.md`'s 2026-08-16→08-21 entry — the short version: the
  new RLS block's own sign-in as `grace@demo.local` deterministically broke a phase-3 e2e assertion
  in CI's actual step order, fixed by having that block clean up her login-capture footprint in its
  own `afterAll`).
  1. **The migration had never actually reached production.** `20260810010000_activity_events.sql`
     was committed 2026-08-11 and every doc since called it "built, verified and pushed" — true of
     GitHub, not of the live Supabase project. `pnpm migrate:prod --dry-run` confirmed it was the
     only migration missing. **Flagged explicitly to the founder before running it for real**
     (first live write of this migration to a shared production database, the first genuinely new
     prod-write action of the session) and the founder confirmed proceeding; applied once the app
     commit (the call sites that actually use the tables) was pushed and deployed, per docs/12's
     documented order ("never migrate:prod a slice whose app commit is still unpushed").
  2. **Structural prod-verify: 77/77** (`scripts/prod-verify-activity-events.mts`'s first 11
     sections, everything except the capture-proof check that's item 3's own topic) — tables, RLS
     enabled, the ACL asymmetry (activity_events gets INSERT+SELECT, activity_rollup SELECT-only),
     all 3 policies with no rank arm, both triggers bound and enabled, both trigger functions with
     their own `lock_timeout` (the 2026-08-11 fix, re-confirmed live on prod), the 3 CHECK
     constraints, both FK actions, the 4-column rollup primary key, the partial dedupe index, and the
     pruner's ACL — all exactly as designed.
  3. **Capture proven live** (closing out the 78th check, for a final 78/78): one real
     `walk_in.added` event recorded by `dana@demo.local` against Demo Salon, via a direct
     authenticated PostgREST insert shaped identically to what `recordActivity()` sends (no
     client-supplied `user_id`/`occurred_at`/`actor_grants` — all guard-derived). A first attempt at
     this via `curl` failed with a generic RLS 42501 and reproduced even locally — traced to an
     unnecessary `Prefer: return=representation` header triggering an implicit post-insert SELECT
     against a table with no self-read policy, not to any defect in the migration or the app's own
     call sites (which never request representation). Now a
     CLAUDE.md gotcha so a future prod-verify session doesn't re-chase the same false lead.
  4. **What remains, unchanged from item 10 below**: phase 2 still ships capture-only — no console
     reader, so "which orgs have gone quiet" (§1) is still not answerable from phase 2's data, and
     retention still isn't enforced on prod until the worker actually runs there
     (`pnpm worker:prod` stopgap, unchanged).

- **2026-08-16 — THE CONFIRMED-FABLE RE-REVIEW OF `20260809010000` (phase 1) IS DONE. Verdict: SHIP AS-IS
  (already shipped; nothing changes), plus one concrete fix applied to tooling.** Closes the item that had
  sat open on CLAUDE.md since 2026-08-09: the original adversarial review of the login-capture migration ran
  as a user-directed Fable SUBAGENT whose tier could not be verified from inside that session (self-reported
  identity is not evidence), so it was recorded as "claimed-Fable, unverified." This pass was invoked via an
  explicit `model: "fable"` parameter on the orchestrating tool call — a claim asserted by the calling
  harness rather than self-reported by the subagent, which is a stronger provenance signal, though still not
  independently verifiable from inside a session; recorded as such rather than overclaimed. **Local
  Docker/Supabase was unavailable during this pass** (a host issue, see CLAUDE.md's gotchas), so this was a
  static/code-level review rather than one checking a live catalog — noted so it isn't mistaken for a repeat
  of the first review's method.
  1. **The review deliberately looked PAST the two findings the first pass already closed** (the
     `query_canceled`/`lock_timeout` HIGH finding and the false-test-coverage MEDIUM finding) and focused on
     `login_events_prune()` specifically, per CLAUDE.md's own framing of it as "the platform's only exception
     to append-only logging." Stress-tested and CONFIRMED, not merely re-read: `security invoker` is genuinely
     sufficient (no privilege the function grants that its only possible caller — the table owner — didn't
     already hold; a future careless `grant execute ... to service_role` would still fail at the DELETE, since
     that role holds no table-level privilege regardless of a definer/invoker choice); the zero-argument,
     literal-90-day-window shape has no injection or boundary-widening path (the boundary comparison is strict
     `<`, so a row exactly at 90 days is *retained*, biasing toward over-retention rather than data loss); the
     guard trigger's single nested exception block genuinely covers every statement that could raise, with no
     path in the function body that reaches an error before that handler; the RLS policies are genuinely
     rank-arm-free (independently re-read `is_superadmin()`'s own definition, not just the two policies); the
     `on delete cascade` FK choice is correct and does not trip the FK-action-fires-triggers trap (CASCADE
     performs a DELETE, not an UPDATE, so there is no trigger on either table for it to trip in the first
     place); and the pruner-vs-fresh-sign-in race is genuinely impossible (a fresh row's `occurred_at` can
     never match the prune predicate by construction, and `ROW EXCLUSIVE` — the lock both a plain INSERT and a
     plain DELETE take — is self-compatible per Postgres's documented lock conflict matrix, independently
     checked rather than trusted from the migration's own comment).
  2. **One real gap found and fixed as tooling, not a migration change**: the claim that the worker's session-
     pooler connection (`postgres.<ref>` username) actually authenticates as the `postgres` ROLE — which the
     whole "owner-only pruner is invocable by the worker and nobody else" argument rests on — had been checked
     exactly ONCE, by hand, pre-deploy (`docs/history/platform-journal.md`, 2026-08-09), and never carried into
     the permanent, re-runnable `scripts/prod-verify-login-events.mts`. A future change to Supabase's Supavisor
     username-to-role mapping would have gone silently unnoticed. **Fixed same day**: added a `select
     current_user as u` check (the same pattern already used in `scripts/verify-acl-hardening.ts`) as a new
     `[0]` section at the top of both `scripts/prod-verify-login-events.mts` and the new
     `scripts/prod-verify-activity-events.mts` (phase 2's pruner rests on the identical assumption) — this
     assumption is now re-proven on every prod-verify run rather than resting on a one-time measurement.
  3. **One operational note, not a security finding**: applying a migration that adds a trigger to `auth.users`
     takes an `ACCESS EXCLUSIVE` lock on that table for the (brief) duration of the migration transaction,
     which could block or delay a concurrent sign-in. True of the original `on_auth_user_created` migration too
     — not a defect specific to this file, but worth deploying during low-traffic windows as a general practice.
  Full review detail (every file read, every claim independently re-derived rather than trusted) is preserved
  in this session's transcript; this entry is the durable summary.

- **2026-08-11 — PHASE 2 RECOVERED AFTER A LOST SESSION, and seven decisions reconstructed to four.**
  **Read this entry before trusting any "founder decision N, 2026-08-10" reference in the phase 2
  files** — the numbering in those headers points at a record that does not exist.

  **What happened.** An Opus session on 2026-08-10 obtained founder approval to build phase 2 and
  wrote two substantial files — `supabase/migrations/20260810010000_activity_events.sql` and
  `packages/platform/src/activity.ts` — then ended abruptly. Its transcript is gone and there is no
  session log for it in `D:\Jason_prompts\sessions`. Both files were sitting UNTRACKED in the working
  tree when the next session opened; they are now committed (`2f1a0ea`) precisely so a stray reset
  cannot repeat this. **The migration header asserts "Founder-approved 2026-08-10, seven decisions,
  all recorded in that file's decisions log" and that was never true** — the commit immediately
  before it (`e1936fb`) recorded the two 2026-08-10 discussions that produced NO decision, while the
  ones that did went unwritten. This entry is the repair.

  **The general lesson, which is the expensive part and belongs to the platform rather than to this
  feature: a decision recorded only inside the artifact it produced is not recorded.** Both files
  cite decision numbers confidently and neither defines them. A code comment can carry the
  *reasoning* for a decision; it cannot serve as the *register* of which decisions exist, because
  nothing enumerates it and nothing notices when an entry is missing. Write the decisions log entry
  in the same beat as the artifact, not after it.

  **RECOVERED from the two files' headers — believed accurate, reconstructed rather than
  transcribed:**
  1. **Decision 1 — the curated action list**, with the explicit rider *"MAKE IT EASY TO CHANGE IT
     TO INCLUDE MORE MUNDANE ACTIVITY IN THE FUTURE"* (page views named as a maybe). Hence a free-text
     `action` column, the vocabulary as TypeScript data, and no migration to change it. Includes the
     per-question-per-day debounce on `answer.saved`, and `fileReport` excluded on privacy grounds.
  2. **Decision 2 — retention: 90 days raw + a permanent rollup that never expires**, deliberately
     the same window as phase 1 so there is one number to remember. Verbatim in substance: *"Dana
     logged in to nail salon 1 year 2 months ago … should be stored so even if they did not engage in
     a while, we know at least the last time they did."*
  3. **Decision 3 — a failed activity write must never break the real action, and must surface
     NOTHING to the actor.** Somebody booking a nail appointment has no "did this get logged" moment.
  4. **(Unnumbered in the files) — reads are SUPERADMIN-ONLY for now.** Hierarchy-governed reads are
     a later phase with its own founder decision and its own adversarial review.

  **LOST, and recorded as lost rather than guessed: decisions 5, 6 and 7.** Nothing in the repo
  names them. §12.5's four open questions map cleanly onto 1–3 plus the moderator/staff-bucket
  question below, so the residue is genuinely unknown. **Do not infer them from the code** — the code
  is what a single unreviewed session wrote, and treating it as evidence of founder intent is how a
  draft becomes a decision by default.

  **DECIDED 2026-08-11, with the founder, to close the gaps:**
  5. **ONE ENGAGEMENT BUCKET — staff and member actions are counted together.** The question was
     whether a professor grading and a student submitting should be distinguishable. **The finding
     that settled it: the platform has no staff/member concept, and rank cannot supply one.** Checked
     against `docs/rank-admission-map.md`: a **GA is rank 1, identical to a student**; a
     **moderator is rank 0, identical to a member**; a **matchmaker is rank 0, identical to a
     single**; in synagogue-schedules the *maker* — the only writer in the module — is rank 0, same
     as a viewer. Rank answers "who may manage whose seat", not "who works here", and three of six
     modules were never rank-mapped at all, so their vocabularies are flat. A real split would need a
     hand-declared per-module staff list — new platform design, adjacent to the role-clarity-labels
     item in docs/13. **It is deferred at zero cost because `actor_grants` stamps the actual position
     names on every row, so any future definition can be applied RETROACTIVELY over all history.**
     Reinforced by decision 8: the reporting tree expands by position at read time, so the split was
     never a write-time concern.
  6. **`fileReport` STAYS EXCLUDED — and the deciding argument is a platform one, not a
     speed-dating one.** Founder, 2026-08-11: *"the idea here is to generalize these things for all
     apps. so unless there is potential harrasment parallels to include for the other apps, we are
     going to avoid it."* Safety reporting has no parallel in the other five modules; carving a
     per-module privacy exception into a shared engagement log would force every future module to
     re-derive whether it has one. The rule is therefore: **this log records ordinary use, and
     anything requiring a disclosure decision stays out of it.** The STAFF side, `reviewReport`, is
     recorded — triaging a report is an assigned job; filing one is something that happened *to*
     someone. **The cost is named rather than discovered: a person whose only act in a month was
     reporting harassment reads here as fully disengaged**, so a naive "we miss you" message would
     go to exactly the wrong person. That blind spot belongs to whatever builds outreach on this
     table and cannot be fixed by recording the report.
  7. **`setBranchFrozen` IS RECORDED** (`branch.frozen` / `branch.unfrozen` — two actions, since the
     action takes a boolean and freezing a thread and releasing it are different decisions). Founder,
     2026-08-11: *"even small actions still mean they are active"*, with the rider that it must stay
     easy to add or subtract an action later. **It had been in NEITHER list in the draft** — not
     included, not excluded — which is precisely the silent omission `ACTIVITY_EXCLUDED` exists to
     make impossible, and it is why that record earns its keep.
  8. **THE CONSOLE IS AN EXPANDABLE TREE — recollected by the founder 2026-08-11, and marked as
     recollected rather than transcribed**, since it is very likely one of the lost decisions but
     cannot be confirmed against any record. Shape: an org total (*"Demo Salon — 200 actions last
     month"*) that opens into per-person, per-position and per-action detail. **Verified against the
     drafted schema: it needs no additional column.** Per-person is the rollup key; per-position is a
     read-time join to `module_roles`; per-action is decision 9.
  9. **`activity_rollup` IS NOW KEYED `(user_id, org_id, module_key, action)`** — changed 2026-08-11,
     before the migration had ever been applied anywhere. Two reasons, and the first is what makes it
     a defect rather than a refinement: **decision 1's "easy to add or subtract an action" was only
     half-delivered.** Adding was one line; subtracting was impossible backwards, because
     `observed_actions` was a single permanent running total that did not remember what it was made
     of, so an action retired from the list kept every occurrence it had already contributed, forever.
     With `action` in the key, "this no longer counts as active" becomes a read-time re-sum over all
     history. Second, it stops the tree's per-action level expiring at the 90-day prune. Cost, both
     accepted: up to one permanent row per action actually performed (bounded by each module's
     vocabulary — at most 13, classroom), and *"when did they last do anything here"* becomes
     `max(last_activity_at)` rather than a single row read.
  10. **PHASE 2 SHIPS CAPTURE-ONLY. No reader this pass.** Capture cannot be backfilled — every day
      without it is signal permanently lost — whereas a console can be built at any time against data
      already accumulating. The per-person data browser is the one place phase 2 data surfaces
      meanwhile (both tables are now declared there). **Consequence to state plainly: until that
      reader exists, "which orgs have gone quiet" — §1's actual question — is NOT answerable**, and
      alice, who owns Demo Salon, cannot see her own salon's engagement. Only the superadmin can.

  **A REAL DEFECT FOUND AND FIXED IN THE DRAFT, 2026-08-11 — the `lock_timeout` was on the function
  that does not contend.** The draft put `set lock_timeout = '1s'` on `activity_event_guard()` (BEFORE
  INSERT, stamps identity) and nothing on `activity_rollup_apply()` (AFTER INSERT, holds the
  `on conflict do update` that actually contends). **A function-level SET is restored when that
  function exits** — stated in as many words by phase 1's own header, where the equivalent 50ms sat on
  `capture_login()`, a SINGLE function containing both the insert and the upsert. Splitting that work
  across two trigger functions silently dropped the property. The guard's header meanwhile asserted
  that the 1s *"bounds the request"* for the rollup upsert, which was false. Fixed by setting it on
  both, and the file now carries the rule that a third lock-taking function would need its own.
  **Worth generalising: this is the transplant failure mode — a property that was structural in the
  original becomes conditional in the copy, and the comment travels intact while the guarantee does
  not.**

  **Build status at the close of 2026-08-11:** migration **APPLIED LOCALLY AND VERIFIED LIVE**, not
  merely written; both tables declared in `data-browser-modules.ts` (a hard blocker — Tier 1 of
  `data-browser-coverage.test.ts` fails on any undeclared `auth.users` FK); the
  `platform.activity-events-prune` worker job written and scheduled 04:35.
  **Verification: `scripts/verify-activity-capture.mts` 53/53 — exercised AS REAL USERS THROUGH
  POSTGREST, which is the only layer that matters given `authenticated` reaches the table directly;
  db 121/121 run directly (a `FULL TURBO` result after a migration is a cached replay); typecheck
  9/9; build clean; e2e 51/51, cleaner than the previous recorded run of 50/51.**
  **Still owed: the RLS test block** (port the verifier's assertions — it IS the spec — plus a
  fixture for the one case it cannot cover, an org member with NO `module_roles` row for the module,
  whose `actor_grants` must be an empty array)**, the ~45 call sites, a prod-verify script** (which
  must FAIL until real activity lands on prod, since capture failures are silent by founder decision
  and phase 2 has no honesty badge)**, and the prod deploy.** A confirmed-Fable
  adversarial review ran 2026-08-11 per the model-choice rule (a genuinely novel write
  shape — ~45 caller-authenticated inserts, where phase 1 had no user-facing write path at all).

- **2026-08-09 (build session) — PHASE 3 BUILT. No migration.** `/console/engagement`
  (`apps/web/app/(app)/console/engagement/page.tsx` + `apps/web/lib/engagement.ts`). Sonnet build,
  per docs/17 §8b's own note that phase 3 needs no migration.
  1. **Every §8b checklist item addressed.** The honesty badge (item 1) reads
     `max(login_rollup.last_login_at)` platform-wide, not `login_events` — the raw table is only a
     90-day window and would read empty on a quiet-but-healthy platform for a reason unrelated to
     capture health, where the rollup is permanent and can only advance when the trigger actually
     succeeds. Pending members are excluded from every rollup and the exclusion is COUNTED, not
     silently dropped (item 2). Population is derived from `org_members` and LEFT-JOINED to
     `login_rollup` in application code, so "no row" renders as "never signed in" (item 3).
     `observed_logins` is always rendered next to `observed_since` with an explicit "not a lifetime
     total" caveat, never alone (item 4). "Last 30 days" is a live `.gte()` query over
     `login_events`, no stored column (item 5). No `.rpc()`, no service-role, added to
     `rls.test.ts`'s `CONSOLE_PATH` (items 6–7). Own page shell, hand-added nav entry in
     `console/page.tsx` (item 8). The page states on screen that this is a third question, distinct
     from the data browser and view-as (item 9), using `requireSuperadmin()` from `lib/platform.ts`
     (item 10). Both directions built: a platform-wide "quietest members" landing panel plus org→
     people and person→orgs pickers, each stating that a login is a platform event, not an org one
     (item 11).
  2. **Item 12's schema-friction report, as promised — two real observations, not fabricated ones.**
     `login_rollup`'s single index on `last_login_at` served every query actually written: the
     honesty badge is a one-row `order by ... limit 1` (cheap, indexed), and the per-org/platform
     "quietest members" listing fetches a small bounded population (this platform's member counts)
     and sorts client-side rather than via `order by`, so the index's marginal value there is small
     at this scale — it would matter more if the platform-wide population grew into the thousands.
     The deliberate absence of `org_id` DID force real client-side joining, exactly as §8b
     predicted: `getQuietestMembers` has no single query available to it — it reads `org_members`
     (filtered to `status = 'active'`), embeds `orgs(name)` for display, derives the distinct
     user-id population in application code, and only then fetches `profiles`/`login_rollup`/
     `login_events` `.in()` that id list. This is three or four round trips where a table carrying
     `org_id` would have allowed one join. Not a blocker at this platform's scale, and not a reason
     to add `org_id` to phase 1's tables retroactively (§5/§7.1's reasoning against speculative
     hierarchy columns stands) — but real friction worth weighing if phase 2's own schema is ever
     tempted to skip carrying `org_id` for the same "keep it simple" reason phase 1 correctly did
     for logins specifically.
  3. **Tests.** Two new e2e tests in `apps/web/e2e/platform.spec.ts`: the honesty badge renders a
     real (non-vacuous) timestamp and grace@demo.local — a real, active Demo Salon member this
     suite otherwise never signs in as — reads "never signed in" in both the platform-wide panel
     and the org-scoped one; and a pending invite into the seed's dedicated Platform Self-Test
     scratch org is excluded from that org's rollup and named as excluded, with cleanup. First
     attempt at both failed on a genuine bug, not a flake: `getByRole('button', { name: 'Show' })`
     matched two buttons (the org and person picker forms share the label), fixed by scoping each
     locator to its own `<section>` before interacting. **Verification: typecheck 9/9, db 121/121
     (real run, not a `FULL TURBO` replay), full e2e 50/51 — the one failure is the pre-existing,
     documented speed-dating resume-review timeout flake (CLAUDE.md's e2e flake family), unrelated
     to this diff and reproduced identically on a byte-for-byte fresh `db:reset` + `pnpm seed`.**
  4. **`apps/web/lib/engagement.ts` was already committed to master (`82dfbc5`) before this build
     session started** — a prior session's `git add -A` swept it in while committing an unrelated
     CLAUDE.md fix (see CLAUDE.md's "never `git add -A`" gotcha, `3c7150e`). Verified byte-identical
     to the file this session wrote independently before continuing; no divergence, nothing to
     reconcile.

- **2026-08-09 (build session) — PHASE 1 BUILT. `20260809010000_login_events.sql`.**
  Six deviations from the draft above, each argued to the founder before shipping, plus the
  adversarial review's findings. Ordered by how much they matter.
  1. **NO `profiles` MIRROR — founder-confirmed** ("superadmin-only for now"). Full reasoning in
     §5 as corrected. Short version: `profiles` is readable by every org-mate and RLS cannot hide
     a column, so the mirror would have published a behavioural signal to peers.
     `login_rollup.last_login_at` meets the stated requirement and is backfilled besides.
  2. **`on delete cascade`, not `on delete set null`** — see §11. An engagement row naming nobody
     is worthless; account erasure should take it.
  3. **The rollup is trigger-maintained, not pruner-maintained** — see §6.
  4. **Column names claim only what they can prove** (`observed_logins`, `observed_since`,
     `first_observed_login_at`) — see §6. No `total_logins`, no stored 30-day counter.
  5. **The capture trigger swallows its own errors** (`raise warning`, never re-raise) so an
     analytics defect can never become a platform-wide login outage. A deliberate divergence from
     `handle_new_user()`, which *should* fail signup — a missing `profiles` row is a broken
     account, a missing login event is not. **The cost is real and is owed to phase 3:** a
     capture failure is silent, so phase 3 MUST render "newest captured login" as an honesty
     badge, with a test that renders it (§10 point 4).
  6. **The pruner is owner-only and `security invoker`** — see §11.
  **Prod facts measured read-only before deploying, not assumed:** `audit_log_entries` still
  `ins=0` (control: `users ins=12`, `sessions ins=27`, `refresh_tokens ins=51` on the same
  connection); `on_auth_user_created` still BOUND and ENABLED today, so "this mechanism is proven
  in production" is a fact about now and not about July; the session pooler really does
  authenticate as the `postgres` role, which is what makes an owner-only pruner invocable by the
  worker; **15 of this project's 24 `ALTER DEFAULT PRIVILEGES` entries name an api role**, so the
  four-role revokes are load-bearing rather than ceremony; and the cluster runs
  `statement_timeout = 120000`, which turned the review's HIGH finding from theoretical into real.
  **And the number that justifies shipping capture before any UI: of 12 prod users, 5 have ever
  signed in and 7 NEVER have.** The outreach list exists on day one.
  **Empirically verified before writing the migration** (the design rests on all three): a
  password grant advances `last_sign_in_at`; a refresh_token grant does not; and a brand-new
  `/signup` DOES fire the trigger — that last one would have been a silent hole, since if GoTrue
  set the timestamp in the INSERT no UPDATE would fire and every user's first-ever login would be
  missing.
- **2026-08-09 — the adversarial review (Fable tier), and what it changed.**
  Verdict SHIP WITH FIXES. It confirmed the ACL/ownership/policy design against the live catalog
  rather than by re-reading the file, and found two things worth the review's cost:
  1. **HIGH, and correct: PL/pgSQL's `WHEN OTHERS` does not catch `query_canceled`.** So the
     header's absolute claim that the trigger "can never break sign-in" was FALSE — a statement
     cancellation propagates and aborts GoTrue's own `UPDATE auth.users`. Prod's 120-second
     cluster `statement_timeout` (measured, above) makes it a real exposure rather than a
     theoretical one. **Fix shipped: `set lock_timeout = '50ms'` on the function.** A
     function-level SET is scoped to the function and restored on exit, so it bounds the trigger
     without touching GoTrue's transaction; a lock wait now fails after 50ms as
     `lock_not_available` (55P03), which IS ordinary and IS caught. `when query_canceled` was
     deliberately NOT added: it would not reliably help for a timeout (the deadline has already
     passed, so the cancel re-asserts) and the other source is an operator's `pg_cancel_backend`,
     which a trigger must honour rather than swallow. **The review's stated failure scenario —
     the nightly pruner blocking a sign-in — is wrong** and is recorded as such so nobody
     re-derives it: a range `delete` and an `insert` both take ROW EXCLUSIVE, which does not
     self-conflict. The real exposure is DDL on `login_events`, which the migration header now
     names.
  2. **MEDIUM, and the more embarrassing one: four comments asserted test coverage that did not
     exist yet.** The migration claimed "asserted in the RLS suite" three times and the worker job
     once, while nothing referenced the new tables — so editing `interval '90 days'` to
     `interval '1 day'` would have passed CI. This is precisely the house rule those same files
     restate: *a migration comment is an assertion a future reader trusts and acts on.* Fixed by
     writing the tests (12 new `it()`s, floor raised 104 → 116), each mapped to the claim it makes
     true. **Generalised lesson, now in docs/03: write the assertion or write the future tense —
     never document a test you have not written, even when you intend to write it in the same
     session.**
  3. Also fixed: the data-browser note stated "PRUNED AT 90 DAYS" as flat fact to an operator when
     prod retention waits on the worker; and the unreachable `coalesce` in the trigger is now
     labelled as deliberate belt-and-braces rather than left looking like a live branch.
  **PROVENANCE CAVEAT, recorded at the founder's explicit request: the review ran as a
  user-directed Fable SUBAGENT because Fable is not available as a session model, and a
  subagent's tier cannot be verified from inside the session** — self-reported identity is not
  evidence. So this review is recorded as **claimed-Fable, unverified**. A re-review on a
  confirmed Fable model is on CLAUDE.md's open list. Nothing about the findings depends on the
  tier being real; the two that mattered were checked independently against Postgres behaviour
  and the live catalog.
- **2026-08-09 — five decisions, all founder-approved in one pass.**
  1. **Logins first (phase 1); org-scoped activity is phase 2.** Rationale: one trigger, and it
     immediately answers "who has never signed in", which is most of the outreach value.
  2. **Retention: 90 days raw + permanent per-user rollup** (§6).
  3. **Disclosure: no user-facing notice; one line in the privacy policy** (§9). The founder
     pushed back on the first, stronger framing and was right to — recording that here so it is
     not re-litigated in the other direction later.
  4. **No hierarchy columns in phase 1** (a login has no org context, so they would be null on
     every row); **mandatory in phase 2**, where they are unreconstructable (§7.2).
  5. **v1 is superadmin-only.** Hierarchy-governed visibility is a named future enhancement,
     designed around from the start but explicitly not built.
- **2026-08-09 — the prod-empty finding (§2) is the reason this document exists at all.**
  Recorded before any code, because it is invisible from a developer machine and would have
  produced a feature that demos perfectly and ships broken.
