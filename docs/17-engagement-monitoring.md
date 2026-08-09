# 17 — Engagement monitoring (superadmin)

**Status: SPECCED, NOT BUILT.** Founder-raised and decided 2026-08-09; phase 1 approved to
build in a later session (Opus — it ships a migration and a trigger on `auth.users`). Nothing
in this document is live.

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

**Locally that same table is fully populated** — 160 rows, one per sign-in, with a clean
`payload.actor_id` joining to `auth.users`.

> This is the ACL trap in a new costume, and it is the reason this document exists before any
> code does. Build the feature on `audit_log_entries` and it works perfectly on the developer's
> machine and is permanently, silently empty in production — an engagement dashboard reading
> "nobody has ever logged in", which looks exactly like a true answer.

### What production actually has

| Source | What it gives | Usable? |
|---|---|---|
| `auth.users.last_sign_in_at` | The LAST login. No history. | Yes, but it answers "when", never "how often" |
| `auth.sessions` | `created_at`/`refreshed_at`, ~15 live rows | No — lossy by construction; 12 of 27 rows already deleted by logout / token rotation |
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
auth.users  --AFTER UPDATE OF last_sign_in_at-->  public.login_events (append)
                                             \->  profiles.last_sign_in_at (mirror, for cheap reads)
```

The mirror onto `profiles` matters because it lets the console answer "when did this person last
sign in" through ordinary RLS, with no definer call and no `auth` access — satisfying
constraints 2 and 3.

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

Raw login events are pruned at 90 days. What the pruner deletes is folded into a permanent
per-user summary row: **first seen, last seen, total logins, logins in the last 30 days.**

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
| **1** | Login capture: trigger on `auth.users`, append-only `login_events`, `profiles` mirror, prune + rollup | **Approved, not built** |
| **2** | Org-scoped activity, written by the app as the user under RLS, carrying org/module/role/scope stamped at write time | Specced here, not approved |
| **3** | The console page: org rollup → drill to people; person → their orgs | Not started |
| **4** | Hierarchy-governed visibility (a manager sees those below them) | Future enhancement, §7 |

---

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
4. **The UI must badge a failed or absent capture**, per the lookup log's badge discipline — and
   a test must assert the badge, because a badge is a claim to the operator and a test that
   keeps passing after the claim goes false is worse than no test.

---

## 11. Open questions

- **The prune mechanism** (§6): narrow `SECURITY DEFINER` function vs. monthly partitions. Needs
  costing and its own review; it is a deliberate exception to grant-layer append-only either way.
- **Phase 2's activity granularity** — every page view is too much noise and too much data; "a
  meaningful action per module" needs defining per module, which risks becoming per-module
  bespoke work.
- **Whether the rollup counters are themselves subject to a deletion request.** The raw events
  clearly are. A counter is arguably not personal data once detached from timestamps — but it is
  keyed by `user_id`, so probably yes. Unresolved, same family as docs/12's audit-log tension.
- **Phase 4's read policy**, which is the §7 trap in full. Not to be attempted without the
  founder and its own adversarial review.

---

## Decisions log (dated)

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
