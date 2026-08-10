# 17 — Engagement monitoring (superadmin)

**Status: PHASES 1 AND 3 BUILT 2026-08-09** (`20260809010000_login_events.sql`; the console page
at `/console/engagement`, no migration). Phases 2 and 4 are specced or sketched only and are NOT
approved to build. Login capture is live: an `AFTER UPDATE OF last_sign_in_at` trigger on
`auth.users` appends to `public.login_events` and maintains a permanent `public.login_rollup`
summary; a 90-day pruner trims the raw detail. The console page reads both tables and answers §1's
two directions — see §8b's decisions-log entry for what phase 3 actually built, its test coverage,
and the schema-friction it reports back per item 12.
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
| **2** | Org-scoped activity, written by the app as the user under RLS, carrying org/module/role/scope stamped at write time | Specced here, not approved |
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

## Decisions log (dated)

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
