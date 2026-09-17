# Profile visibility — where a user's email actually lives

**Status, 2026-09-17: THE EMAIL SLICE IS SHIPPED — both migrations applied to
PRODUCTION and prod-verified (§23.6 has the evidence and the procedure).** The
naming model is designed but unreviewed; two further items are blocked or
deferred.

> **⚠ §16.7's acceptance sentence OVERSTATES the outcome and is corrected in
> §23.3.** It says the two calls must afterwards return *"Charlie's own row and
> nothing else"*. They do not, and should not: §20.3 — written LATER — says the
> email slice does not touch `profiles_select_shared_org` at all. Charlie still
> reads eight NAMES; what he can no longer read is an address, a settings blob,
> or who the superadmin is.

> ### → START AT §0. It is the whole thing on one screen.
> The sections below it are in the order things were DISCOVERED, so reading
> front-to-back means meeting four superseded positions before their
> corrections. **§0.5 maps which sections are still true.**

This is the design slice docs/20 §31 commissioned, founder-agreed 2026-09-15:
*move `profiles.email` out of `profiles` into its own row-policied table, and
determine whether that removes v4's `kind = 'public_square'` carve-out entirely.*

Written to be attacked. **Everything is a claim except where marked VERIFIED
LIVE**, which means a `pg_catalog` read or a file read, dated, against the named
database. Every negative result below carries a control.

> **THE HEADLINE, and it contradicts the brief's own title.** The measurements
> say the best answer is **not to create a table at all**. `profiles.email` is
> a mirror of `auth.users.email` that no trigger ever refreshes; a second mirror
> one table over inherits that flaw and adds a sync obligation on the signup
> path. The alternative — **delete the column, keep no copy, and read
> `auth.users.email` through the SECURITY DEFINER functions that already do
> every other email job** — is smaller, strictly stronger, and closes a recorded
> latent bug by construction. See §4.

---

## 0. READ THIS FIRST — the whole session on one screen

**Everything below §1 is in the order it was DISCOVERED, not the order it should
be read.** Several sections were overturned by later ones (the map in §0.5 says
which). **This section is the current state. Nothing else needs reading unless
you want the evidence behind a line.**

### 0.1 THE PROBLEM, demonstrated live (§16.7)

`charlie@demo.local` — a **rank-0 nail-salon customer**, the lowest-privilege
real account seeded, holding no role of any kind — signed in and ran one query
against `profiles`. He got back **eight people's names AND email addresses**,
including the salon admin's. That is today's production behaviour.

**Cause:** `profiles_select_shared_org` grants read of the *whole row* to anyone
sharing an org. **A policy filters ROWS, never COLUMNS**, so the email came
along with the name. Nobody chose to expose it. The app never shows those
addresses on a screen — but the browser can ask the database directly with the
token the app already issued, so that is not a defence.

### 0.2 WHAT WAS DECIDED — eleven decisions, all yours

| # | decision | where |
|---|---|---|
| **0** | **NO PER-ORG BRANCHING, restated by the founder as the governing constraint:** *"I want every organization to follow the same code and structure so I don't want any `if org=xyz` then something unique."* **Everything below is checked against this.** | §16.1 |
| **1** | **CONFIRMED 2026-09-16 (*"I will take your recommendation"*). `profiles.email` is DELETED, not moved to a new table.** It is a copy of `auth.users.email` that no trigger ever refreshes — a cache with no invalidation. A second copy inherits that bug. `auth.users` becomes the single source of truth. | §4 |
| **2** | **`settings` and `is_superadmin` ride along** — **into a new PRIVATE COMPANION TABLE (§21), which §6 originally forgot to name** — they leave `profiles` in the same slice. Near-zero app cost; nothing reads either for anyone but the caller. | §6, §0.3 |
| **3** | **A lookup never confirms a name.** Not on an invite, not on a typo. *"if we should suggest to them, no we should not."* | §15.2 |
| **4** | **The ORG declares what is SEARCHABLE. The USER has a checkbox per field, always stored.** Searchable forces it shared and makes it mandatory to fill; the user's choice goes inert, not away, and takes effect the moment the org turns search off. `visible = user_checked OR org_searchable`. | §17.1, §18.1 |
| **5** | **"Shared" means shared with someone who successfully searched** — they already had the value. Never displayed to someone who did not. **This is what saves decision 1 in Public Square.** | §19.1 |
| **6** | **No org lets you browse its members.** Measured: already true everywhere except the policy in §0.1. | §19.2 |
| **7** | **A person is an ID.** The same view renders different names depending on who is looking. Platform name for platform reports; org name parenthetically for org leaders. | §17.4 |
| **8** | **Email first; the naming model second.** Entity-level visibility is a separate question entirely. | §15.1, §20 |
| **9** | **The global platform name is NOT declared a legal name.** *"I am not sure yet, for now its just user entered."* Current behaviour is unchanged — it is free text the user supplies. **A deliberate deferral, not an oversight.** | §17.3 |
| **10** | **v4 IS WITHDRAWN.** `orgs.kind` is never created; docs/20 §12 is dead. Follows from decision 0 and from deleting the column instead. | §19.1, docs/20 §12 |

**Note: rows 4 and 8 each carry more than one decision** (row 4: the org declares
searchable, searchable implies mandatory, and the user's checkbox is stored but
inert; row 8: email-before-naming, and entity-level as a separate question).

### 0.3 WHAT THIS ACTUALLY CHANGES, in plain terms

`profiles` ends up holding **`user_id`, `display_name`, `created_at`,
`updated_at`** — a public identity row and nothing else. **Everything that left
it has a named home (§21): the address lives in `auth.users.email` where the
authoritative copy always was; `settings` and `is_superadmin` move to a private
per-user companion table, which is also the designated home for anything private
added later. The rule — `profiles` is public by definition — goes into docs/03
and gets a ratchet test (§21.3).**

- **Nobody reads anyone else's email address**, in any org. Not Sarah of Dana in
  Public Square, not Frank's cashier of Frank in the salon.
- **You still read your own** — it is in your session already, so it need not
  come from the database at all.
- **The superadmin console still sees everything**, through one new
  superadmin-gated function rather than a policy.
- **An invite still works**: you type an address, it says *"that address has an
  account"*, and nothing more.
- **`orgs.kind` is never created.** No org is special-cased anywhere.

### 0.4 WHAT IS AND IS NOT READY

| | status |
|---|---|
| **The email slice** (decisions 1–3) | **SHIPPED 2026-09-17** — both migrations on PRODUCTION, prod-verified 70/70, acceptance test 7/7 against prod. Two migrations, ~22 call sites, both ratchets, a prod-verify script. §23. |
| **The naming model** (decisions 4, 5, 7) | **DESIGNED, NOT REVIEWED.** Three new tables, a resolver, three UIs — **module-sized, not a slice** (§16.4). |
| **Killing the member directory** (§19.4) | **BLOCKED** on the item below. Do not start (§20.2). |
| **Entity-level visibility** — who you see because you share a *class / event / conversation*, not an org | **DEFERRED BY YOU.** Belongs with docs/15 §11's entity-level `joinPolicy`. May need more modules before it can be settled (§20.1). |

**Nothing has been built. No SQL was written. No migration exists.**

### 0.5 WHICH SECTIONS ARE STILL TRUE — read before citing anything below

Four sections were overturned during the session. They are kept, bannered, because
the reasoning inside them is what later sections rest on — but **do not quote them
as current:**

| section | status |
|---|---|
| **§15.4** | **WITHDRAWN.** Argued the model needs a trust-class *mechanism* in code. Your own proposal (§16.2) gets there by configuration instead. |
| **§17.2** | **RESOLVED by §18.** Both readings it offered were wrong; yours was a third. |
| **§18.3** | **RESOLVED by §19.1.** It flagged a blocking conflict; decision 5 closed it. |
| **§19.4** | **BLOCKED by §20.2.** Sound reasoning, but it depends on the deferred entity-level question. |

**Two errors of mine, corrected in place rather than deleted:** §3 R4 originally
said seven call sites would "dissolve" on their own — they do not, and the honest
total is ~22 (§14.1); and §6 claimed `orgs.kind` would have "nothing left to do"
full stop, when it is nothing left to do **for email** (§15.4). I also asserted
three times that *"Frank's staff need to see each other on a roster"* — **measured
and false** (§19.2).

### 0.6 STILL OPEN

- ~~**F3 — does the TRUST-CLASS paragraph go into docs/00?**~~ **ANSWERED AND
  WRITTEN 2026-09-17 — docs/00 "Core principles" now has a principle 8.** Asked
  three times across two workstreams; settled in the same conversation that
  built the email slice. **The founder rejected the drafted wording and was
  right to**: it said the org's trust class decides what a member may learn,
  and his objection was that *"just the knowledge of how they were admitted"*
  does not always dictate the result — self-grant may be fine for one purpose
  and not another, and the same is true of an invitation. **So join method is
  EVIDENCE, and the decision is PER-PURPOSE configuration** (his proposal: an
  org setting toggling whether membership assumes a relationship for a given
  purpose). That is §16.2's move — configuration instead of a branch —
  generalised from "which fields are searchable" to "for which purposes".
  **Scope note, flagged before it went in: F3 was "one paragraph, no code" and
  this version points at a MECHANISM** (a code-enumerated purpose list plus an
  org setting). The principle is written as DESCRIBED-NOT-BUILT; the build
  belongs with the deferred naming slice.

- **§17.3** — is the global platform name a legal name? *"not sure yet, for now
  its just user entered."* Bears on the privacy page and docs/21.
- **§16.6** — may an org ever make email a *shareable* field rather than only a
  searchable one? Decision 5 makes this mostly moot; worth a line when the
  naming model is built.
- ~~**§21.4** — does the companion table's policy recurse through
  `is_superadmin()`?~~ **CLOSED 2026-09-17: DEMONSTRATED, not reasoned about,
  before any SQL was written. No recursion** — the superadmin read all 11 rows,
  with an ordinary user seeing exactly 1 as the control proving the policy was
  ENFORCED rather than switched off. The fallback was not needed. See §23.2.
- ~~**§17.6** — the 1 production user with no display name.~~ **CLOSED
  2026-09-17.** Measured: it is `jasonartisenergy@gmail.com`, the founder's own
  account, so the backfill carries no third-party privacy question.
  `20260917020000` seeds a NULL name from the email local-part generically,
  signup now collects one, and the new `/account` page lets anyone change theirs.
  **The wider "searchable implies mandatory" question stays with the deferred
  naming slice** — only its display-name tail is closed.

---

## 1. What this supersedes, and what it does not

- **It supersedes docs/20 §12 (v4)** if the founder accepts it — that is
  **F1**, docs/20 §33.1, and it is put to him in §9 below with the answer
  argued, not assumed.
- **It does not reopen v1, v2 or v3.** docs/20 §9 and §9.3 record why each
  died; §2.4 below checks this proposal against all three, as §1 of that
  document requires of any successor.
- **It does not touch the ad-hoc-groups product decisions** — invite-only,
  two consents, 30-day expiry, delegated moderation. Those are founder
  decisions already recorded (docs/20 §16, §18, §20, §24) and nothing here
  moves them.

---

## 2. The finding that reframes the brief

### 2.1 `profiles.email` is a stale, unmaintained copy — VERIFIED LIVE

`handle_new_user()` is the **only** writer of `profiles.email`, anywhere. Its
whole body, read from `pg_get_functiondef` on the local database 2026-09-16:

```sql
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  insert into public.profiles (user_id, email, display_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'display_name');
  return new;
end;
$function$
```

It is bound `AFTER INSERT ON auth.users` (`on_auth_user_created`,
`tgenabled = 'O'`). There is **no** UPDATE path — no second trigger, no
`on conflict`, no `update public.profiles set email`. **Control for that
negative:** the same catalog read finds two live triggers on `auth.users` and
names both (`on_auth_user_created`, `on_auth_user_login`), so the query works
and the absence of a third is a real absence.

This is the latent bug CLAUDE.md already records: *"`profiles.email` IS NEVER
SYNCED after a user changes their auth email."* It has not bitten only because
the product has no email-change UI.

**So `profiles.email` is not data. It is a cache with no invalidation.** Any
design that moves it moves a cache; any design that keeps it keeps the bug.

### 2.2 `authenticated` cannot read `auth.users` — and that is a grant that was never issued

VERIFIED LIVE against **PRODUCTION** (project `jbjqrkxdoiolwlglvoki`,
read-only probe, 2026-09-16) and identically against local:

```
auth.users relacl: {supabase_auth_admin=arwdDxtm/…, dashboard_user=arwdDxtm/…,
                    postgres=ar*wdDxtm/supabase_auth_admin}
has_table_privilege('postgres',      'auth.users','select') = true
has_table_privilege('authenticated', 'auth.users','select') = false
has_table_privilege('service_role',  'auth.users','select') = false
pg_roles: postgres rolbypassrls = true, authenticated rolbypassrls = false
```

**Control:** the same connection counted 73 tables in `public`, so the catalog
read is live and the two `false` results are real answers, not an empty read.

Three consequences, and the second is the load-bearing one:

1. A `SECURITY DEFINER` function owned by `postgres` **can** read
   `auth.users.email`. Proven directly, not inferred — the probe executed
   `select count(*), count(email) … from auth.users` on production and got
   `{n: 12, with_email: 12}`.
2. `authenticated` **cannot**, and **no policy can give it that** — RLS
   subtracts from a grant, it never adds one. This is the property v3 wanted and
   could not have. **v3 died trying to SUBTRACT a column from a table-level
   grant that already existed. This design subtracts nothing: it relies on a
   grant that was never given in the first place.**
3. `service_role` cannot either, despite `rolbypassrls = true` — bypassing RLS
   is not a table privilege. **The worker cannot read email.** Recorded because
   it is counter-intuitive and would otherwise be re-derived.

### 2.3 `profiles` today — the complete picture, VERIFIED LIVE

```
 attnum | attname       | type        | notnull | column ACL (attacl)
      1 | user_id       | uuid        | t       | —
      2 | email         | text        | f       | —
      3 | display_name  | text        | f       | {authenticated=w}
      4 | is_superadmin | boolean     | t       | —
      5 | created_at    | timestamptz | t       | —
      6 | updated_at    | timestamptz | t       | —
      7 | settings      | jsonb       | t       | {authenticated=w}

table ACL: {postgres=arwdDxtm, service_role=arwdDxtm, authenticated=ard}
constraints: profiles_pkey (user_id), profiles_email_key UNIQUE (email),
             profiles_user_id_fkey → auth.users(id) ON DELETE CASCADE
policies (all three, all PERMISSIVE, therefore OR-ed):
  profiles_select_own        r  using ((user_id = auth.uid()) OR is_superadmin())
  profiles_select_shared_org r  using (shares_org_with(user_id))
  profiles_update_own        w  using (user_id = auth.uid())
                                check (user_id = auth.uid())
triggers: profiles_updated_at BEFORE UPDATE → set_updated_at()  (the only one)
```

**`authenticated=ard`** is INSERT, SELECT, DELETE — note `r` is **table-level**,
which is exactly why v3's column revoke was a no-op. There is **no `w`** at
table level; UPDATE exists only as the two column grants shown. **No policy is
`FOR ALL`** — checked because docs/20's failure pattern demands it, and the
control is that the same query returns 230 policies platform-wide.

### 2.4 Checked against v1, v2, v3 — as docs/20 §1 requires

- **v1** was a per-org carve-out in `shares_org_with`. This removes the carve-out
  and does not add one. It touches `shares_org_with` **not at all**.
- **v2** put per-membership flags on `org_members`, which an org admin can write.
  This adds no column to `org_members` and no user-facing setting.
- **v3** tried to remove ACCESS to the `email` column while leaving the column in
  place, and died on three counts (docs/20 §9.3). All three are inapplicable:
  it **removes the column** rather than revoking on it; `profiles`' own ACL and
  `scripts/verify-acl-hardening.ts`'s expected set for `profiles` change only by
  a column ceasing to exist; and the superadmin is served by an explicit
  definer (§4.4), not by a grant that must survive a revoke.
- **v4** (docs/20 §12) is a `kind <> 'public_square'` conjunct inside
  `shares_org_with`. §6 argues it becomes unnecessary.

**This is not a fifth mechanism. It is the removal of the thing all four were
trying to guard.**

---

## 3. What actually reads an email — measured, not estimated

Two independent surveys (TypeScript across `apps/web`, `modules`, `packages`,
`scripts`; and SQL across `supabase/migrations`), both reconciled against the
live catalog. **The catalog is the arbiter:** exactly **four** functions in
`public` mention `email` in their body, and all four are `SECURITY DEFINER`
owned by `postgres` — `handle_new_user`, `mm_mutual_matches`,
`org_find_user_by_email`, `org_member_profiles`. **Control: 148 functions exist
in `public`**, so that is a filtered result, not an empty catalog. The same four,
same owners, same `prosecdef`, VERIFIED on prod.

| # | class | sites | what happens if `profiles.email` is deleted |
|---|---|---|---|
| **R1** | Reads through one of the four definers | `org_member_profiles` (org members page, `org-members-panel`), `mm_mutual_matches` (matchmaking mutual-match reveal), `org_find_user_by_email` (`lib/org-members.ts:20` and its two callers) | **Unaffected in behaviour.** Each definer changes one `FROM` clause: `public.profiles p` → `auth.users u`. |
| **R2** | Caller's OWN email, via the RLS client | `lib/platform.ts:187`, `app/(app)/layout.tsx:31` | **Should not touch the database at all.** The address is already in the session — `supabase.auth.getUser()` returns `user.email`. Strictly fewer moving parts than today. |
| **R3** | Superadmin console reads ANOTHER user's email | `console/page.tsx:36`, `lib/data-browser.ts:366`, `lib/engagement.ts:97`, `:233`, `:250` | **Break, loudly.** Five call sites, but **one** new superadmin-gated definer serves all five. This is Option B's real cost and §4.4 states it plainly. |
| **R4** | `display_name ?? email` fallback chains | speed-dating `ui/page.tsx:39` and `events/[eventId]/page.tsx:96`; visual-messaging `conversations/[conversationId]/page.tsx:163`; classroom `manage/page.tsx:243`, `grading/[homeworkId]/page.tsx:82`, `exams/[examId]/page.tsx:53`; matchmaking `manage/page.tsx:69` | **Seven — and they BREAK LOUDLY. ⚠ CORRECTED after review B (§14.1): an earlier draft of this row said they “dissolve”. They do not.** All seven name `email` in an explicit PostgREST column list, so every one raises 42703 whether or not the fallback value is still wanted. Display-name-at-signup removes the *need for the value*; it does **not** remove the code edit, which stays mandatory and inside this slice. **Measured on PROD 2026-09-16: 1 of 12 users has a NULL `display_name`.** (This runs docs/20 §33.4's §22.5 item, offered and never run.) |
| **R5** | Email→user_id resolvers hitting `profiles` DIRECTLY | visual-messaging `ui/actions.ts:169`, classroom `manage/actions.ts:52`, matchmaking `manage/actions.ts:96` | **Break, loudly** (`42703 column profiles.email does not exist`). These are docs/20 §12.1's three resolvers. They re-route to a definer — `find_module_peer`, which docs/20 §3.4 already designed and this design still needs. **Note the blast-radius change in §5.2.** |
| **R6** | A real product surface, not a port | matchmaking `manage/page.tsx:72–74` — a `<datalist>` autocomplete listing every matchmaker's and single's email | **Breaks.** docs/20 §22.3 already flagged it as a product question, not a mechanical port. §7.2 answers it. |
| **R7** | A WRITE that copies an email elsewhere | speed-dating `ui/actions.ts:351,363,367` — reads **both** users' emails and writes them into `sd_matches.contact_shared` | **Breaks SILENTLY, and this is the dangerous one.** docs/20 §11.3 records that it is a **write-once snapshot that never retries**. §5.1 answers it. |
| **R8** | Own email into a JWT claim | speed-dating `ui/actions.ts:441,454` (Jitsi) | Own row → R2. Unaffected. |
| **R9** | Tests, seed, scripts | `packages/db/src/seed.ts:79`, `scripts/prod-promote-superadmin.ts:28`, ~20 sites in `rls.test.ts` | **`service_role` cannot read `auth.users` (§2.2)** — so `seed.ts` needs the owner connection it already uses elsewhere, or a definer. **Do not assume `service_role` suffices; it does not.** |

| **R10** | **A DEAD `email` in an otherwise-live select — MISSED by the first survey, found by review B (§14.1)** | matchmaking `ui/page.tsx:45` and `:117` | **Breaks loudly, and it is the highest-traffic page in that module.** Both fetch `user_id, display_name, email` to build a `nameOf` map — and `nameOf` reads **only** `display_name` (VERIFIED: it returns `p?.display_name || 'A match'`). The `email` is fetched and never read: dead weight left behind by a 2026-07-16 privacy fix that removed the fallback but not the column from the select. Dropping the column 42703s the whole participant matchmaking page for every single and matchmaker. **Fix is deleting two words**, but it had to be found first. |

**Why R10 escaped the first survey, and the lesson:** it produces **no visible
UI difference** and matches neither `.email` property access nor a
`display_name || email` fallback pattern — the two shapes the survey searched
for. **A column can be load-bearing for a query without being load-bearing for
the product.** Grep for the column inside the SELECT LIST, not for its use.

**Ruled out, with a control — the silent-breakage class does not exist here.**
`select('*')` on `profiles` appears **nowhere** in `apps/web` or `modules`;
every one of the 25 `from('profiles')` call sites uses an explicit column list.
**Control: 13 `select('*')` calls do exist elsewhere in the app**, so the search
works and the zero is a real absence. This matters because `select('*')` is the
one shape that would have stopped returning the field **silently** instead of
erroring.

**R7 is the finding a reviewer should attack first.** It is the one place where
deleting a column produces a wrong *product outcome* rather than an error.

---

## 4. The two options, and why the brief's own option is the weaker one

### 4.1 Option A — a new row-policied table (what §31 literally asked for)

```sql
create table public.profile_emails (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email   text not null,
  ...
);
alter table public.profile_emails enable row level security;
create policy profile_emails_select_own on public.profile_emails
  for select using (user_id = auth.uid() or public.is_superadmin());
grant select on public.profile_emails to authenticated;
alter table public.profiles drop column email;
```

plus a backfill, plus `handle_new_user` writing two tables, plus **a new
`AFTER UPDATE OF email ON auth.users` trigger** to keep the mirror honest.

### 4.2 Option B — no table. Delete the column; `auth.users` is the source of truth

```sql
alter table public.profiles drop column email;   -- takes profiles_email_key with it
-- handle_new_user stops writing email (one fewer column, one fewer failure mode)
-- the three existing definers change one FROM clause each
-- one new superadmin-gated definer serves the five console sites
-- one new definer (find_module_peer) serves the three module resolvers
-- one new definer serves the contact_shared write (§5.1)
```

### 4.3 Option A′ — the table, granted to nobody — collapses into B

Worth stating because it is the obvious "best of both" and it is not one. If
`authenticated` is **not** granted SELECT on `profile_emails`, then RLS on it is
moot and every read goes through a definer — which is Option B, plus a copy of
the data and a sync obligation. **The table only earns its keep if
`authenticated` IS granted SELECT on it — and the moment you grant that, you
have recreated a widenable surface one table over from the one you just fixed.**

### 4.4 The trade, stated honestly

| | **A — new table** | **B — no table** |
|---|---|---|
| matches docs/20 §31's literal brief | yes | **no — it supersedes it** |
| the stale-email bug (CLAUDE.md, latent) | **needs a new `auth.users` UPDATE trigger** to fix; skipping it carries the bug into a new table | **impossible by construction** — there is no copy to go stale |
| what enforces the boundary | a row policy | **a table privilege that was never granted** (§2.2) |
| can a future author widen it by writing a policy? | **yes** — the exact mistake being fixed, one table over | **no.** They would have to be granted a privilege on a schema `postgres` does not own |
| superadmin console | **untouched** (the `is_superadmin()` policy arm) | **5 call sites re-route through 1 new definer** |
| backfill | yes (11 local / **12 prod** rows) | none |
| new failure mode on the SIGNUP path | **yes** — a second INSERT inside the `auth.users` trigger, plus a sync trigger. docs/03's auth-trigger criticality rules apply | **fewer than today** — it also deletes `profiles_email_key`, removing a UNIQUE-violation path that can abort a signup. **See §4.6: the review found this is not merely theoretical.** |
| how it is audited | `pg_policy` | the enumerable list of definers (`pg_proc.prosrc ~* 'email'`, with a count-all control — the query used throughout this document) |
| view-as surface map (`view-as-coverage.test.ts`) | ~~a new table to classify on every surface~~ **⚠ MY OWN OVERSTATEMENT, corrected 2026-09-16.** That test enumerates MODULE tables by prefix; **`profiles` is not in it at all** (VERIFIED: 0 occurrences of `profiles`, and 0 of `email` in `apps/web/lib/view-as.ts` — control: `display_name` appears twice there). A `profile_emails` table carries no module prefix, so it would not be enumerated either. **This row is NOT a real cost of Option A.** | nothing to classify |
| depends on the `auth` schema | only the sync trigger | every read |

**Recommendation: Option B.** It is smaller, it removes a recorded bug instead
of relocating it, and its guarantee is of a strictly stronger kind. Its one real
cost — five console sites behind one new definer — is a cost this design would
partly pay anyway, because `find_module_peer` is already required.

### 4.5 The honest case against B, so the reviewer does not have to find it

1. **It moves the boundary from the policy surface to the function surface.**
   docs/20 §7.11 criticised v2 for exactly this: *"the definers must never return
   `settings`, and nothing enforces that."* Under B the same sentence applies to
   email. **Mitigation is a ratchet test, not a promise** — see §11.6.
2. **`auth` is a Supabase-managed schema.** The repo's dependency on it is
   already deep (an FK from every `profiles` row, two triggers on `auth.users`,
   `20260809010000`'s backfill from `auth.users`), so this adds depth, not a new
   class of risk — but it is depth.
3. **A grant we do not control is doing the work.** `has_table_privilege(
   'authenticated','auth.users','select') = false` is true today on prod. If it
   ever became true, the protection would vanish silently. **This belongs in a
   `prod-verify` script as a permanent, re-runnable assertion**, the same way
   the worker's `current_user` claim was made permanent (CLAUDE.md, 2026-08-16).
4. **`auth.users` has `deleted_at`, `banned_until` and `is_anonymous`.** Any
   definer reading it must decide about each. Measured on prod 2026-09-16:
   `deleted_at is not null` = **0**, `is_anonymous` = **0**, `email is null` =
   **0**, of 12 users. **Those three zeros are vacuous as evidence of
   correctness** — they prove nothing is broken today, not that the filters are
   unnecessary. State the filters explicitly.
5. **Local/prod index divergence, minor:** prod carries an extra
   `idx_users_email` that local does not. Both carry `users_email_partial_key`
   (UNIQUE on `email` where `is_sso_user = false`) and
   `users_instance_id_email_idx` on `lower(email)`, so an exact-match lookup is
   indexed in both environments and no new index is needed.


### 4.6 The SSO asymmetry — a signup abort that exists TODAY. Found by review A, VERIFIED

`profiles_email_key` is a **non-partial** UNIQUE constraint. `auth.users`'
own email uniqueness is **partial**:

```
auth.users      | users_email_partial_key | unique | WHERE (is_sso_user = false)
public.profiles | profiles_email_key      | unique | (no predicate)
```

So GoTrue will happily create an SSO user whose address duplicates an existing
one — and `handle_new_user`, firing `AFTER INSERT`, will then hit a UNIQUE
violation on `profiles_email_key` and **abort the entire `auth.users` insert**.
The signup fails, in a case `auth.users` alone was designed to tolerate.

Zero rows are affected today (`is_sso_user` is false for all 11 local / 12 prod
users, and no SSO provider is configured) — **a vacuous negative, recorded as
such.** It is a latent trap, not an outage.

**Option B deletes the constraint along with the column, so this disappears as a
side effect.** Option A must decide whether to reproduce `profiles_email_key` on
the new table — and reproducing it carries the trap forward.

---

## 5. Two things a reviewer should hit hardest

### 5.1 R7 — the speed-dating contact share fails SILENTLY

`modules/speed-dating/ui/actions.ts:351–367` reads both users' emails through
the **caller's RLS client** and writes them into `sd_matches.contact_shared`.
docs/20 §11.3 records it as **write-once, never retried**. Under either option
that read returns nothing for the *other* user, and the snapshot is written with
a missing address that no later run repairs.

**This is the only site in the whole survey where the failure is silent**, and
docs/20's own history says a silent wrong outcome is what kills a design. It
needs a definer that returns both parties' addresses **only** on a genuine
mutual-reveal event — i.e. the same authority test `mm_mutual_matches` already
encodes for matchmaking. **Treat it as part of this slice, not a follow-on.**

### 5.2 The blast radius is LARGER than v4's, and that cuts both ways

v4 broke the three direct resolvers (R5) **inside Public Square only**. This
design deletes the column, so they break **in every org, immediately**.

- **Against:** it is a bigger change to shipped behaviour, touching six live
  client-facing modules rather than one unbuilt org.
- **For:** it fails at build time or with `42703`, loudly and uniformly, in
  front of a developer — whereas v4's failure was a **silent zero-row result**
  in production, in one org, which docs/20 §12.1 had to reproduce by hand to
  find. A uniform loud break is the better failure.

The reviewer should say which of those two readings is right. **This design
asserts the second and may be wrong.**

---

## 6. Does this remove the `kind = 'public_square'` carve-out? — PARTLY, and the remainder is measured

This is the question §31 was commissioned to answer, so it gets a precise answer
rather than a yes.

After email is gone, `profiles_select_shared_org` still hands **every co-member
in every org** the rest of the row:

| column | exposed to a co-member after this design | verdict |
|---|---|---|
| `display_name` | yes | **Correct, and intended.** docs/20 §31.1's industry check: a name is essentially always visible to co-members — Discord, Slack, Meetup, LinkedIn. This is the norm, not a leak. |
| `settings` (jsonb) | yes | **The remainder.** CLAUDE.md already parks this: *"Anything placed in `profiles.settings` is readable by every org-mate."* Today it holds one console preference (`superadminDefaultAddActive`), so exposure is nil — but in an org of 50,000 strangers it is a standing invitation. |
| `is_superadmin` | yes | **A lesser remainder.** Every co-member learns which account is the platform superadmin. A targeting hint, not a disclosure of personal data. |
| `created_at` / `updated_at` | yes | Account age. Accept. |

**VERIFIED LIVE 2026-09-16:** no application code reads another user's
`settings` or `is_superadmin` — every one of the nine hits
(`lib/platform.ts:164,187`, `console/actions.ts:28,100`,
`console/page.tsx:25,28`, `layout.tsx:23`) reads the **caller's own** row. So
both columns could move by the same mechanism at **zero** app-side cost. The
exposure is through raw RLS, not through any screen.

**Therefore the honest answer to F1 (docs/20 §33.1):**

- **Moving `email` alone** removes the carve-out's *reason for existing* —
  docs/16's P1-1, the platform-wide email directory — but leaves the carve-out
  incidentally covering two lesser exposures it was never designed for.
- **Moving `email`, `settings` and `is_superadmin`** reduces `profiles` to
  `user_id, display_name, created_at, updated_at` — a genuinely public identity
  table. At that point `shares_org_with` means only *"are you co-members"* and
  gates a row containing nothing a co-member should mind seeing. **⚠ CORRECTED 2026-09-16 (§15.4): the carve-out is then
  unnecessary FOR EMAIL, and `orgs.kind` has no remaining justification FOR
  EMAIL** — but the founder's own model needs an open/closed distinction for
  NAMES, which is the deferred slice. An earlier draft of this bullet said
  "completely unnecessary" full stop, and that was wrong.** — docs/20 §17.4 already records that its last one (the
  auto-invite uniqueness index) died when the founder chose invite-only.

**This design recommends the second** — and **the founder APPROVED it on
2026-09-16: *"let them ride along."* So `settings` and `is_superadmin` leave
`profiles` in the same slice as `email`.** `is_superadmin()` is a SECURITY
DEFINER reading the caller's OWN row (VERIFIED LIVE), so moving that column is a
one-line change to one function; the nine other functions call `is_superadmin()`
rather than the column and are untouched. `settings` is only ever read and
written for oneself. `settings` and
`is_superadmin` are one `alter table … drop column` and one small definer each;
they are not a second project.

---

## 7. The five questions §31.4 asked, answered

**Q0 — "per org" cannot be the whole answer.** Correct, and this design makes it
sharper: if email is not co-member-readable in *any* org, there is **nothing
about email left to choose per-org**. The founder's instruction (*"I do want the
info shared to be a choice of the user, per org"*) survives, but the *thing being
chosen* changes — see Q1. The separate **global findability** control §31.4
anticipated is designed in §8 and is **conditional on F2's answer**.

**Q1 — where does a per-org display NAME live?** In its own table
(`org_member_names(org_id, user_id, nickname)`), never on `org_members` — v2
died because a column on `org_members` is **admin-writable**, and this one's
write policy must be self-only (`user_id = auth.uid()`) while org admins can
write that table. **It is NOT part of this slice.** It is a product feature, not
a security fix; the founder chose invite-only, so no stranger sees your name
without your having accepted an invite. Recorded so it is not re-derived;
extract-don't-speculate says build it when a user asks for it.

**Q2 — what happens to the ~14 read sites?** §3, fully enumerated: 7 dissolve
with display-name-at-signup, 5 console sites take one new definer, 3 resolvers
take `find_module_peer`, 1 (`contact_shared`) needs its own definer and is the
dangerous one, 1 (the matchmaking datalist) is a product decision — §7.2.

**Q3 — does v4 survive?** §6. It becomes unnecessary if the scope is the three
columns; partly unnecessary if it is email alone. **F1 is the founder's.**

**Q4 — does it close docs/20 §8.3** (`org_find_user_by_email` has no org join)?
**NO, and this matters.** §8.3 is a *function-surface* problem, not a column
problem: the function is `SECURITY DEFINER` and keeps working identically after
the column moves. Moving email neither widens nor narrows it. §8.3 is closed by
**F2's answer plus logging**, not by this design. Saying otherwise would
overstate what this slice delivers.

**Q5 — the 30-day-expiry orphan and the privacy copy.** The copy rule is already
decided (docs/20 §21): **describe the mechanism, never a named org.** Under this
design the sentence is simple and true in every org: *"Other members of an
organization can see your name. They cannot see your email address."* The
30-day-expiry orphan (docs/20 §7.7 / §33.3 P3) is untouched by this slice.

### 7.2 The matchmaking `<datalist>` (R6) — a product answer

`modules/matchmaking/ui/manage/page.tsx:72–74` builds a browser autocomplete
from every matchmaker's and every single's email address so the matchmaker can
type one into a form. **The email is being used as a person-picker, not as
contact information.** The fix is not to restore email access — it is to make
the picker pick a **person** (`user_id` + `display_name`), as every other roster
in the platform already does. That removes the site rather than porting it, and
it is the same conclusion docs/20 §22.3 reached for a different reason.

### 7.3 `contact_shared` (R7) — see §5.1. A definer, in this slice, not after it.

---

## 8. Global findability — designed, CONDITIONAL, not recommended for v1

docs/20 §31.4 Q0 predicted this would be needed. It may not be.

**If F2 is answered "drop the name from both lookups", no findability control is
needed for v1.** The lookups then return only *"this address has an account"* —
the enumeration oracle docs/20 §3.4 already accepts as the irreducible cost of
invite-by-email, and which every product surveyed also accepts.

**If F2 is answered "keep the name", a subject-controlled toggle becomes the
mitigating control** — precisely what Notion does, and Notion is the only one of
six products surveyed that reveals a name at all. Its shape here is cheap and
already safe:

```sql
alter table public.profiles add column findable_by_email boolean not null default false;
grant update (display_name, settings, findable_by_email) on public.profiles to authenticated;
```

Safe because `profiles_update_own` is `user_id = auth.uid()` on **both** clauses
and `profiles` has **no table-level UPDATE grant** — only the two column grants
(§2.3). So it is self-writable and **not** admin-writable, which is exactly the
flaw that killed v2. Default `false` matches LinkedIn's "who can download your
email" default and Notion's opt-in posture.

**Do not build this unless F2 goes that way.** Recorded so the shape is not
re-derived.

---

## 9. FOR THE FOUNDER — F1, stated as a scenario

*Put after the design is on paper, as docs/20 §31.5 requires.*

**Today.** Dana joins Public Square. Sarah, whom Dana has never met, is also a
member. Sarah's browser can run one query and get Dana's email address — along
with everyone else's. That is docs/16's P1-1.

**Under v4 (docs/20 §12).** We add a column `orgs.kind`, set it to
`'public_square'` on exactly one row, and teach `shares_org_with` to skip orgs
of that kind. Sarah sees nothing of Dana. In every *other* org nothing changes —
Frank's salon staff still read each other's email addresses, exactly as now.

**Under this design.** We delete `profiles.email`. Nobody's email is readable by
a co-member **in any org, ever** — not Sarah of Dana, not Frank's cashier of
Frank. Email is read only by the caller themselves, by the superadmin console,
and by the specific functions that have a reason (a mutual match reveals contact
details; an invite resolves an address). `orgs.kind` is never created, and
`shares_org_with` is left exactly as it is today.

**The cost of the second, stated plainly — ⚠ CORRECTED after review B, and it
is BIGGER than an earlier draft of this section said.** Six shipped modules have
code that reads an email and it stops working until fixed: **about 22 call
sites, and NONE of them disappear on their own.** The earlier figure ("17, of
which 7 dissolve once display-name-at-signup ships") was wrong — those seven
name `email` in an explicit column list, so they raise 42703 regardless of
whether the fallback value is still wanted (§3 R4). Display-name-at-signup makes
the *value* unnecessary; every one of the seven still needs editing. Three more
sites were missed entirely and found by review (§3 R10, §14.1).
Against that, v4's cost is a column and a conjunct, but it leaves "co-members
read each other's email" true everywhere except one org.

**The recommendation is the second, extended to `settings` and `is_superadmin`
as well (§6)** — because that is the version where the carve-out has genuinely
nothing left to do.

---

## 10. What is explicitly NOT in this slice

- Per-org display names / nicknames (§7 Q1).
- `join_module` (docs/20 §33.2 D1) — unbuildable as specified, its own slice.
- `org_find_user_by_email`'s missing org join — **do not add one**; docs/20 §25.2
  is emphatic and correct: it breaks every invite.
- Account deletion (docs/21), the abuse posture (docs/20 §33.3 P1), the
  `module_roles` census (docs/20 §8.4).
- The global findability toggle, unless F2 goes that way (§8).

---

## 11. If this is approved — the shape of the work, NOT a migration

**No SQL is committed until the adversarial review returns.** Recorded as a
sequence so the review has something to attack:

1. **Display-name-at-signup first** (docs/20 §16.1). **No migration.** It removes
   7 of the 17 call sites before any schema moves, and shrinks the riskiest
   step. **Backfill question for the 1 prod user with a NULL `display_name`** —
   decide what they get.
2. **The definers, added while the column still exists.** `find_module_peer`, the
   superadmin-email definer, the `contact_shared` definer; the three existing
   definers re-pointed at `auth.users`. **Reversible, and nothing breaks yet** —
   this is the step that makes step 4 safe.
3. **Re-point every call site** at the definers. Still nothing breaks.
4. **Only then `alter table public.profiles drop column email;`** — and
   `settings` / `is_superadmin` with it, if §6's wider scope is approved.
   **THE ORDERING IS LOAD-BEARING AND IT IS THE OPPOSITE OF THIS REPO'S NORMAL
   HABIT — review B's sharpest operational point (§14.2).** A dropped column is
   the one schema change that is **not** additive, so code and migration cannot
   be decoupled the way docs/03 normally allows. On this platform they are
   already separate steps by construction: `git push` deploys the app through
   Vercel, and **`pnpm migrate:prod` is a manual step nothing in CI runs**
   (CLAUDE.md is emphatic). That separation is the safety here, **but only in
   one direction**: steps 2–3 must be DEPLOYED AND LIVE first, so that no
   running code reads the column, and only then does `migrate:prod` drop it.
   Reversed — migration first — it is a simultaneous app-wide outage across all
   six modules, which would be a worse blast radius than v4 ever had.
5. **Tests before prod:** `rls.test.ts` gains a case asserting a co-member
   **cannot** obtain another user's address by any route — with a **control**
   proving the caller can read their own, so the negative is not vacuous
   (docs/03's vacuity rule). ~20 existing `rls.test.ts` sites touch email and
   must be re-read, not just re-run.
6. **A ratchet test** — §4.5's mitigation. Enumerate from `pg_proc` every
   function whose body touches `auth.users.email`, and fail the build on any
   function not on an explicit allow-list. This is what makes the function
   surface auditable rather than a promise.
   **Two precision requirements the review surfaced, both VERIFIED 2026-09-16 —
   do not write the regex naively:**
   - **`email` and `auth.users` match DIFFERENT SETS.** Today
     `prosrc ~* 'email'` returns the four definers and
     `prosrc ~* 'auth[.]users'` returns exactly **one** function — a different
     one. The ratchet must search **both**, because after this design ships the
     four definers will contain `auth.users` and today they do not.
   - **`prosrc` includes COMMENTS.** That one `auth.users` hit is
     `vm_guard_last_conversation_admin`, and its match is inside a comment
     line — it reads no such table. A ratchet that does not account for this
     starts life with a false positive, and a ratchet whose baseline is a
     known-wrong entry is how an allow-list stops being read.
7. **A `prod-verify-profile-visibility.mts`**, copied from
   `scripts/prod-verify-superadmin-log.mts` (the table/policy/grant template;
   `prod-verify-migration.ts` is function-only and would be vacuous here). It
   must assert, permanently and with controls:
   `has_table_privilege('authenticated','auth.users','select') = false`
   **AND `has_column_privilege('authenticated','auth.users','email','select')
   = false`** — the review's addition, and it is a genuinely independent
   signal, since a column grant could be issued without a table grant
   (VERIFIED 2026-09-16: both are `false` for `anon`, `authenticated` **and**
   `service_role`; `true` for `postgres`, which is the control); the
   column is gone; the definer allow-list matches; and — per
   `prod-verify-login-events.mts`'s lesson — that a real email read through a
   definer actually **returns data** on prod, not merely that the schema is
   right.

---

## 12. THE REVIEW BRIEF

Two **narrow** agents, capped output, per CLAUDE.md's four-failures rule. The two
questions:

- **A — the mechanism.** Is Option B's guarantee real? Attack §2.2 (the grant
  that was never issued), §4.3 (does A′ really collapse?), §4.5's five
  self-identified weaknesses, and the `deleted_at` / `is_anonymous` /
  `email is null` filters whose zero-counts are admittedly vacuous. Does
  deleting a column carrying a UNIQUE constraint have consequences not listed
  here?
- **B — the blast radius.** Is §3's site table complete and correctly classified?
  Is §5.2's claim (a loud uniform break is better than a silent narrow one)
  right? Is §5.1 the only silent failure, or are there others? What breaks in the
  six shipped modules that §3 missed?

**Both must check the SIBLINGS** — the other policies on the table, the other
tables of the module, the other call sites. Four designs have failed on exactly
that.

---

## 13. ADVERSARIAL REVIEW A — THE MECHANISM. RAN 2026-09-16. VERDICT: OPTION B HOLDS

Narrow agent, capped output, Fable tier requested. **Provenance caveat, stated
because it cannot be resolved from inside the session: there is no way here to
verify which model actually served a subagent** — a self-report is generated
text, and the founder had already flagged this. **The mitigation was structural,
not a claim of trust:** the agent was required to return `pg_catalog` results
and `file:line` references rather than judgements, and **every load-bearing
finding below was then independently re-run by the orchestrator** before being
written down. What follows is the orchestrator's own measurement; the review
gets credit for asking the question.

### 13.1 Verified, with controls — all five claims held

| claim | measurement | control | verdict |
|---|---|---|---|
| §2.2 — no grant, and no policy can add one | `has_table_privilege` false for `authenticated`, `anon`, `service_role`; true for `postgres`. **`has_column_privilege(…,'email','select')` false for all three too** | `postgres` = true on both; `dashboard_user`/`supabase_auth_admin` = true | **SOUND** |
| no view or replication path around it | **3 non-system views exist and all are in `vault`/`extensions`** — none in `public`, none over `profiles`. `supabase_realtime` publication carries **0 tables** | 146 views exist in total, so the filtered result is real | **SOUND**, with the caveat in §13.3 |
| §4.3 — A′ collapses into B | RLS filters rows a grant already permits; a table with no grant makes its policies inert, so reads must go through a definer — which is B | — | **SOUND** |
| dropping the column is contained | `pg_depend` on `profiles.email` (attnum 2) returns **exactly one row**: an `auto` dependency from `profiles_email_key` | the identical query on `user_id` (attnum 1) returns **6** rows — PK, FK and **three policy dependencies** — proving the query does surface policy dependents when they exist | **SOUND** |
| the definer plan works | in a ROLLED-BACK transaction: a `postgres`-owned SECURITY DEFINER function called as `authenticated` returned `{n: 11, with_email: 11}`, while a direct `select` in the same transaction failed `permission denied for table users` | the rollback was confirmed clean (`pg_proc` shows 0 rows for the test function) | **SOUND** |

### 13.2 One genuinely NEW finding — §4.6, the SSO signup abort

Not in the draft, not previously recorded anywhere. See §4.6. It **strengthens**
Option B rather than threatening it, and it is the kind of thing that only
surfaces from reading the two unique indexes side by side.

### 13.3 What the review did NOT establish — recorded so it is not assumed

- **The publication and view checks were run against LOCAL ONLY.** Prod was
  probed for grants and data, not for `pg_publication_rel` or `pg_views`.
  Supabase Realtime is configured per-project, so **prod may well have tables
  in `supabase_realtime` where local has none.** This is exactly the
  local-cannot-catch-prod-drift class CLAUDE.md records. **Add both to
  §11.7's prod-verify script; do not carry the local zero forward as a fact
  about prod.**
- The two additions the review made to §11.6 and §11.7 were verified and are
  now folded in, including the finding that **`prosrc` matches on comments** —
  today's single `auth[.]users` hit is a comment inside
  `vm_guard_last_conversation_admin`, which reads no such table.

---

## 14. ADVERSARIAL REVIEW B — THE BLAST RADIUS. RAN 2026-09-16. VERDICT: §3 WAS INCOMPLETE

Same provenance caveat as §13, and the same mitigation: **every finding below
was independently re-verified by the orchestrator against the actual files**
before being accepted. Two were accepted and **both corrected this document**;
one was accepted with a qualification.

### 14.1 ACCEPTED — §3 missed a site, and mis-stated another

1. **matchmaking `ui/page.tsx:45` and `:117` — MISSED.** Now §3 R10. VERIFIED by
   reading the file: the select fetches `email`, and `nameOf` at `:52` / `:124`
   returns `p?.display_name || 'A match'` — the email is never read. Dead weight
   from a 2026-07-16 privacy fix, and a real 42703 on the module's
   highest-traffic page. **The survey missed it because it searched for
   `.email` USE and for fallback chains, and this is neither.**
   **⚠ AND IT WAS NOT A NEW DISCOVERY — found 2026-09-16 while auditing the
   handoff, and this is worth more than the bug: docs/20 §22.3 ALREADY LISTED
   BOTH LINES, on 2026-09-11, under the heading `SELECTED-UNUSED`.** The
   information existed in this repo the whole time; neither my survey nor the
   review found it, and the review re-derived it from the code. **That is
   docs/03 #21 exactly — *search docs/ by MECHANISM before designing one* — and
   it is the second time in this workstream a prior finding was re-derived
   rather than read.** Credit the record, not the review.
2. **R4's seven sites do NOT "dissolve" — my wording was wrong.** VERIFIED: all
   seven name `email` in an explicit column list, so all seven raise 42703
   whether or not display-name-at-signup has shipped. §3 R4 and §9's cost figure
   are both corrected; the honest total is **~22 call sites, none of which
   fall away on their own.**

### 14.2 ACCEPTED WITH A QUALIFICATION — §5.2's "loud is better"

The review agrees loud-and-uniform beats silent-and-narrow **conditionally**:
only if the schema drop and the call-site fixes are coordinated, because
dropping a column deliberately forfeits the additive-first safety net this repo
relies on. **That condition is met by §11's build order** — steps 2–3 add the
definers and re-point every call site while the column still exists — but the
review is right that it must be stated as a *deployment ordering*, not just a
task ordering. §11 step 4 now says so explicitly.

### 14.3 CONFIRMED by the review, each re-verified here

- **R1, R3, R5, R6, R7, R8, R9 are correctly classified.** R5's three resolvers
  are `.eq('email', …)` lookups, which a naive `\.email` grep misses — worth
  keeping, since that is how a future audit would miss them too.
- **R7 stands alone as the only SILENT failure.** The review's control: every
  `.insert(`/`.update(` mentioning `email` (zero hits) and every object-literal
  `email:` key across `apps/web` + `modules` (18 hits) — all resolve to a read
  fallback, a JWT claim on the caller's own row, or `sd_matches.contact_shared`.
- **No `select('*')` on `profiles` exists** — see §3. Control: 13 elsewhere in
  the app. The silent-breakage class is ruled out, not merely unobserved.
- **`profiles` is absent from the view-as surface map**, which corrected one of
  this document's own claims against Option A (§4.4).

### 14.4 What BOTH reviews leave open

- The publication / view checks are **LOCAL ONLY** (§13.3). Prod unverified.
- Neither review examined the **worker** (`service_role` cannot read
  `auth.users` — §2.2/§3 R9). Nothing found suggests the worker reads an email,
  but that is an absence of evidence, not a cleared check. **Verify before
  building.**
- Neither review priced the **`settings` / `is_superadmin` widening** of §6.
  That scope is a founder decision (F1) and would need its own pass.

---

## 15. FOUNDER DECISIONS, 2026-09-16 — and one finding that came OUT of them

### 15.1 DECIDED — EMAIL FIRST, the username slice second

**FOUNDER DECISION.** Ship the reviewed email work as its own slice; design the
per-org display identifier afterwards. His words: *"email first. The per org
username still needs hashing out."* So §7 Q1's deferral **stands**, but for a
different reason than it was written: not "a product feature we don't need yet"
but "a design question that is genuinely open."

### 15.2 DECIDED — F2: do NOT suggest a name on a mistyped address

**FOUNDER DECISION**, and it settles docs/20 §33.1's F2. Asked whether a lookup
should confirm *"did you mean Sarah Cohen?"* before a user mails something to a
typo'd address, he answered: *"Are we asking if they mistype the email address,
if we should suggest to them, no we should not."*

**So the name is dropped from BOTH lookups** — `org_find_user_by_email` and
`find_module_peer` — which keeps them consistent, as docs/20 §3.4 required.
This **overturns §3.4's own recommendation**, which had deliberately kept the
name on `find_module_peer` for exactly this confirmation. The trade was put to
him with the cost named and he chose the other way.
It also aligns with five of the six products in §15.4 and with OWASP
WSTG-IDNT-04. **§8's `findable_by_email` toggle is therefore NOT needed** — it
was conditional on keeping the name. Do not build it.

### 15.3 NEW, FROM THE FOUNDER — a THIRD shape for the per-org identifier

Raised 2026-09-16 and **not previously considered anywhere in docs/20 or this
document.** Both shapes on the table so far were **subject-side**: the person
chooses the name others see (a `display_name`, or Discord's per-server
nickname). The founder raised a **viewer-side** alternative:

> *"I am not sure if a user should give a per-org username or if the contact
> that they are reaching out to should make a name and store it that way,
> similar to WhatsApp using personA's local contact info of personB to display
> on personA's phone."*

**This is a materially different mechanism, not a variant.** Under viewer-side
naming the label lives with the VIEWER, so it is not a disclosure by the subject
at all — which sidesteps the whole "what may a co-member see" question for
names, exactly as WhatsApp does. It also has real costs (two people see
different labels for the same person; moderation and abuse reports lose a shared
referent; nothing is shown until the viewer names them). **Neither shape is
chosen. This is the substance of the deferred slice §15.1 names.**

### 15.4 A FINDING THAT WAS WITHDRAWN THE SAME DAY — read §16.2 first

> **⚠ The conclusion of this subsection is WRONG and is superseded by §16.2.**
> It argued that the founder's model requires a trust-class MECHANISM in code.
> His own follow-up proposal achieves the same distinction as per-org
> CONFIGURATION, so no mechanism is needed. **The analysis of WHY email and
> names split is still correct and still useful — the remedy it proposed is
> not.** Kept rather than deleted because the split is the reasoning §16 rests
> on.

Asked whether reaching out differs between Public Square and a client org, the
founder framed his model as: *"the only way that Sarah can see anything from
Dana is if she knows [Dana's] email, similar to how the only way I can connect
with personA on whatsapp is knowing their phonenumber."*

**Followed through, that model splits in two — and only half of it is universal.**

| | EMAIL | NAME / ROSTER |
|---|---|---|
| **rule** | **the same in every org** — nobody reads anyone's address, ever | **genuinely different by org** |
| **client org (salon)** | hidden | **visible, and must be** — Frank assembled the roster and his staff need to see each other to work |
| **Public Square** | hidden | **should be hidden** under the founder's model — you should need the address, as on WhatsApp |
| **is it in the reviewed design?** | **yes** — Option B, §4 | **NO** |

**The consequence, and it is uncomfortable but has to be said plainly: Option B
does NOT deliver the founder's model for names.** `profiles_select_shared_org`
is untouched by Option B, so in Public Square a stranger could still enumerate
every member's `display_name`. Getting the founder's stated behaviour requires
the database to distinguish the two kinds of org — **which is the mechanism v4
proposed and the founder rejected as a special rule for one org (docs/20
§31.1).**

**The resolution is the trust class, and this is now its strongest argument.**
v4's flaw was never the conjunct; it was that `kind='public_square'` names ONE
ORG, and a class with cardinality 1 is an identity with an indirection
(docs/20 §17.4 conceded this). A **trust class** — open vs closed — is a real
class with a stated rule, and the carve-out becomes an application of it rather
than an exception to it. **WITHDRAWN SAME DAY BY §16.2** — the founder's own proposal (org-declared
lookup fields) achieves the distinction as CONFIGURATION, so no trust-class
MECHANISM is needed in code. The reasoning above stands as the argument for the
doc paragraph; the claim that a mechanism is required does not.

**This is NOT a reversal of §4 and does not reopen the reviewed design.** Email
and names are separable and the founder chose to separate them (§15.1). Option B
ships as reviewed. **But §6's claim that moving three columns leaves `orgs.kind`
with "nothing left to do" is now WRONG, and is corrected here:** it has nothing
left to do **for email**, and something real to do **for names** — which is
precisely the deferred slice. F3 and §15.3 should be settled together, in that
slice, not in this one.

---

## 16. THE FOUNDER'S MODEL, 2026-09-16 — org-declared lookup fields + three name layers

**This supersedes §15.4's conclusion that the founder's model requires a trust
class. It does not. His own proposal removes the need.** Recorded in his terms,
then assessed.

### 16.1 The proposal

Restated principle, unchanged and reaffirmed: *"I want every organization to
follow the same code and structure so I don't want any `if org=xyz` then
something unique."*

Scope, in his words: *"the issue we are discussing is looking up existing
members to have a discussion with or have an interaction with and what info is
shared along with the lookup info."* **Note this scopes to EXISTING members —
see §16.3 on why that leaves the invite lookup untouched.**

1. **The ORG declares which fields are LOOKUP-ABLE**, at setup. A company might
   tick *name, title, email*; **Public Square ticks email only.**
2. **The USER fills an in-org profile** and chooses, **from the items NOT in the
   org's lookup set**, what is shared with other members. If the org allows
   lookup by email only, the user chooses whether their name is displayed.
3. **THREE NAME LAYERS, which compose:**
   - a **global platform name** — *"perhaps will be a legal name, we never
     discussed this part"* (his words; a genuinely new question — §16.5);
   - a **per-org name** the user picks — Matt at work, Mathew globally;
   - a **per-viewer alias** — *"each user has the ability to give the users they
     communicate with a per org alias"*. The WhatsApp model he drew explicitly:
     a stranger shows the name they chose for themselves; a contact shows the
     name YOU saved.
4. **A per-user contacts / phone-book** to hold those aliases.
5. **Storage note, his:** most users use one name everywhere, so design it so the
   same name need not be repeated per org.

### 16.2 THE KEY PROPERTY — it replaces `orgs.kind` with CONFIGURATION

**The org's lookup configuration IS the open/closed distinction, expressed as
DATA rather than as code.** The salon ticks name+title+email; Public Square ticks
email only. **The same code reads the same setting in both.** No `orgs.kind`, no
privileged org, no branch — which satisfies §0's principle in a way v4 and my
own §15.4 did not. Both of those still branched; they merely branched on a
better-named column.

**VERIFIED LIVE 2026-09-16 — the mechanism already exists and has precedent:**
`orgs.settings` is an existing `jsonb not null` column, and **four tables already
carry a per-org / per-entity `settings` jsonb** (`orgs`, `org_modules`,
`profiles`, `vm_conversations`). Control: the same catalog query returns only
those four, run against a database holding 230 policies. **So the lookup config
needs no new column.**

### 16.3 Fit against the four decisions

| | decision | fit |
|---|---|---|
| **A** | email never visible to co-members | **compatible and SUBSUMED** — email becomes a lookup KEY, never a displayed field. **Caveat: §16.6.** |
| **B** | can a co-member see your name? | **ANSWERED GENERALLY.** Not by org kind, but by the org's lookup config plus the user's own per-org choice. **This closes what §15.4 left open and withdraws §15.4's trust-class requirement.** |
| **C** | which name, who picks it | **answered by taking ALL THREE** (§15.3's shapes) rather than choosing one. They compose. |
| **D** | the invite lookup returns existence only | **UNTOUCHED — and these are TWO DIFFERENT LOOKUPS.** The founder's model governs finding someone **already in the org**; D governs finding someone **not yet in it**, where there is no membership to configure and no per-org profile to consult, so it can only ever be by email. §15.2 stands. **Do not conflate them.** |

### 16.4 Doability — measured, and it is MODULE-SIZED, not a slice

**Cheap, precedent exists:**
- **Org lookup config** -> `orgs.settings`. No new column (§16.2).
- **Per-viewer alias table** -> the SIMPLEST object in the design:
  `(owner_user_id, subject_user_id, org_id nullable, alias)` with one policy,
  `owner_user_id = auth.uid()`. Nobody else ever reads it, so there is no
  visibility question to get wrong.
- **Name resolution** -> one function: viewer's alias -> subject's per-org name
  -> subject's global name -> a fallback that is **never an email**.

**Moderate, with two traps MEASURED LIVE 2026-09-16:**
- **The in-org profile needs its OWN TABLE. It cannot live on `org_members`** —
  `org_members_write_org_admin` is a **`for all`** policy with
  `is_org_admin(org_id)` on **both** USING and WITH CHECK, so an org admin can
  write every column of that table. **That is exactly what killed v2** (docs/20
  §9). Its write policy must be self-only.
- **`org_member_profiles` is already a FUNCTION name** — a table cannot reuse it.

**Honest size: three new tables, a resolver, and three UIs (org setup, in-org
profile, contacts), on top of the ~22 email call sites. This is module-sized
work, not a slice** — materially larger than anything currently designed.

### 16.5 FIVE THINGS THE MODEL LEAVES OPEN — **FOUR ANSWERED 2026-09-16, see §17**

1. **DEFAULTS — the most important one.** If a user shares nothing, what does a
   co-member see? At Public Square scale, default-ON leaks names by default.
   WhatsApp's own answer implies the per-org name is **mandatory** and only the
   extra fields optional — but the proposal says the name itself may be hidden,
   so something must fill the gap.
2. **SEARCHABLE vs VISIBLE-IN-CONTEXT.** WhatsApp forbids browsing users but
   shows a name once someone messages you. Does the org's lookup config govern
   what is **findable**, or also what is **shown to someone you are already
   talking to**? They should probably be separate settings.
3. **Is the global platform name a LEGAL name?** The founder raised this and
   correctly noted it has never been discussed. It bears on the privacy page
   (docs/12 item 6) and on docs/21's departed-user silhouette.
4. **MODERATION LOSES ITS SHARED REFERENT.** If one person sees "Tennis-Master"
   and another sees "Matt", an abuse report is hard to action. Staff likely need
   the per-org name as canonical. **A real cost of viewer-side naming, and it
   was not in the proposal.**
5. **STORAGE** (the founder's own point). Cleanest answer: the per-org name is
   OPTIONAL and falls back to the global one, so nothing is stored unless it
   differs.

### 16.6 THE CAVEAT ON DECISION A — flagged, not smuggled

If an org may tick email as a **shareable** field rather than only a lookup key,
a client org could re-enable today's leak for itself. The founder's wording
implies lookup-only, but the model does not say so.

**Worth knowing this is what Slack and Google Groups actually do** (§22.1: where
email is visible at all it is an ORG-level admin setting, never a per-user
opt-in), so either answer is defensible — **but it changes decision A, so it
must be deliberate.**

### 16.7 THE LEAK, DEMONSTRATED — not asserted, 2026-09-16

The founder asked *"Sarah's browser can run one query and get Dana's email
address? How so? I don't understand. Is this a mistake?"* It is not. Run live
against the local database as **charlie@demo.local — a rank-0 salon CUSTOMER**,
the lowest-privilege real account seeded:

```
GET /rest/v1/profiles?select=display_name,email,is_superadmin
-> 8 rows: Alice A, Charlie C, Dana D, Eve E, Frank F (the salon ADMIN),
           Gabe G, Grace G, Mel M — each with their email address.
```

**To reproduce** (local stack up, seeded) — sign in for a real token, then query
as that user, exactly as the browser would:

```
POST http://127.0.0.1:54321/auth/v1/token?grant_type=password
     apikey: <NEXT_PUBLIC_SUPABASE_ANON_KEY from apps/web/.env.local>
     {"email":"charlie@demo.local","password":"password123"}
GET  http://127.0.0.1:54321/rest/v1/profiles?select=display_name,email,is_superadmin
     apikey: <anon>   Authorization: Bearer <access_token>
```

**This is the acceptance test for the whole slice**: after it ships, the same two
calls must return Charlie's own row and nothing else. Keep it — it is the one
check a non-engineer can run and read.

**Cause:** `profiles_select_shared_org` (`20260708020000`) grants read of the
whole ROW to anyone sharing an org — added deliberately, to stop rosters
rendering raw UUIDs. **A policy filters ROWS, never COLUMNS**, so the email came
along with the name. Nobody chose to expose it.

**Why "the UI does not show it" is not a defence:** the app queries as the user,
so anything the database will answer, the browser can ask for directly with the
token the app already issued. docs/03 hard rule 6 — *UI hiding is convenience,
not security.*

---

## 17. THE MODEL'S FIVE OPEN QUESTIONS — FOUNDER-ANSWERED 2026-09-16

§16.5 listed five. **Four are now answered, one is deliberately deferred.** His
answers close the model's largest gap (defaults) and add a general architectural
rule that reaches well beyond this design (§17.4).

### 17.1 DECIDED — defaults, and "searchable implies mandatory"

> *"Defaults are whatever the org marks they can search by."*
> *"the org's lookup config is controlling what's findable, and anything they
> mark is required by the user, so if name is searchable for orgA then every
> member must fill out their name. If they mark additional fields visible,
> beyond the org search fields, then those are shown to someone you are talking
> to."*

**This resolves §16.5's most important gap.** There is no "what if the user
shares nothing" hole, because the searchable set is not optional:

- **SEARCHABLE (org-declared) -> MANDATORY for every member, and findable by any
  member of that org.** If orgA makes `name` searchable, every member of orgA
  must have a name.
- **VISIBLE (org-declared, beyond the searchable set) -> shown to someone you
  are ALREADY INTERACTING WITH**, not findable by search.
- **Everything else -> private.**

**So §16.5's question 2 (searchable vs visible-in-context) is answered by
SEPARATING them into two org-declared sets**, which is what that question
proposed and the founder confirmed.

**WORKED EXAMPLE — the two shapes, in one mechanism and no branch:**

| | `demo-salon` (closed) | Public Square (open) |
|---|---|---|
| **searchable** | name, title | **email only** |
| **visible in context** | — | **name** |
| a member can BROWSE/FIND by | name, title | nothing but an address they already have |
| what you see once you are talking | name, title | the name they chose |
| **is this the WhatsApp model?** | no, and correctly not — Frank assembled the roster | **yes, exactly** — a number finds you, a name identifies you once you are talking |

**That table contains no code difference. It is two rows of configuration.**

### 17.2 THE ONE AMBIGUITY — **RESOLVED SAME DAY, see §18. Neither reading below was right.**

The founder's two messages can be read two ways and the design must not pick
one quietly.

- **Message 1:** *"a user gets to fill out a within organization profile and
  needs to select, from those items on their profile, not in the organizations
  lookup, what information is shared."* -> the USER chooses what is shared.
- **Message 2:** *"If they mark additional fields visible ... those are shown to
  someone you are talking to."* -> **"they" is the ORG**, so the org chooses.

**The reading this document adopts, pending confirmation:** the **org** declares
which fields *may* be visible; the **user** decides whether to actually provide
or share each of those, plus anything outside both sets. So the org sets the
ceiling and the user chooses within it. **The searchable set is the exception —
that one is mandatory and not a user choice (§17.1).**

**If instead the org can FORCE a field visible, then "visible" is a second
mandatory set and the user's choice shrinks to the leftovers.** Both are
coherent; they differ in who holds the last word. **FOUNDER CONFIRMATION NEEDED,
not blocking.**

### 17.3 DEFERRED — is the global platform name a legal name?

> *"I am not sure yet, for now its just user entered."*

**Current behaviour is unchanged and already matches:** `profiles.display_name`
is free text the user supplies. **Recorded as deferred, not resolved** — it
still bears on the privacy page (docs/12 item 6) and docs/21's departed-user
silhouette, so it must be revisited before either is finished.

### 17.4 DECIDED — the moderation referent, and a GENERAL RULE that outgrows this design

> *"The report should be their platform name. That's their main master name for
> this type of thing for the platform higherups. A report to org leaders can
> have their org name parenthetically. In general, a person is an id and it
> should be easy to display the same views/reports with swaping names depending
> on veiwer."*

- **Platform-level reports -> the PLATFORM name.** One master referent, so a
  superadmin and a moderator are always talking about the same person.
- **Org-level reports -> the org name, with the platform name parenthetically.**
- **The general rule, and it is the important half:** *a person is an ID, and
  the same view or report should render different names depending on who is
  looking.*

**This is a platform architecture directive, not a detail of this design.** It
says the name resolver (§16.4) is **not a display convenience — it is the
general mechanism**: every surface renders a `user_id`, and exactly one place
decides which name that becomes for this viewer.

**It also changes the TARGET of the email slice, and improves it.** §11 step 3
said "re-point every call site at the definers." Under this rule the target is
sharper: **the ~22 sites stop rendering `display_name || email` and start
rendering a user_id through the resolver.** Same work, better end state — and
the resolver then already exists when the naming slice lands. **This is now a
founder-stated rule, not an inference.**

### 17.5 STORAGE — the founder's own point, recommendation unchanged

§16.5 item 5. The per-org name should be **optional**, falling back to the
platform name, so nothing is stored for the (large) majority who use one name
everywhere. Not contradicted; carried forward as the working answer.

### 17.6 ONE MIGRATION CONSEQUENCE of "searchable implies mandatory"

**Turning this on is not purely additive for existing orgs.** If an org declares
`name` searchable, every existing member must have one — and **1 of 12 prod
users has a NULL `display_name`** (§3 R4, measured). So the naming slice needs a
backfill or a prompt-on-next-login for members who predate the rule. Small
today; it will not stay small. **Recorded so it is not discovered late.**

---

## 18. §17.2's AMBIGUITY — RESOLVED BY THE FOUNDER, 2026-09-16, and it is a THIRD answer

**Neither of the two readings §17.2 offered. A better one.**

> *"The org is not marking what is shared, but what is searchable, but that makes
> it shared. For example, a user will see a check mark next to name and email
> allowing them to make it shared, but if the org makes email searchable, them
> will see something additional next to email implying that it is shared since
> the org set search by email on. The user can still select whether or not to
> display it but that selection will only have impact if the org shuts off
> search by email."*

### 18.1 The mechanism, stated precisely

- **The org declares only what is SEARCHABLE.** It never declares what is
  shared. There is no second org-level "visible" list to maintain.
- **The user always has a checkbox per field, and it is ALWAYS STORED.**
- **A searchable field is force-shared while the org keeps it searchable** — and
  **the user's stored choice is not destroyed, only inert.**
- **If the org later turns search off for that field, the user's stored choice
  takes effect immediately.**

**So the effective rule is one expression, with no branch:**

```
visible_to_co_member(field) = user_checked(field) OR org_searchable(field)
```

**Why this is better than both readings §17.2 proposed.** "Org sets the ceiling"
would have let a user hide a field the org can search by — a promise the
platform cannot keep. "Org forces, user gets leftovers" would have thrown the
user's preference away, so turning search off would silently leave the field
exposed until every user re-visited their settings. **This keeps the user's
intent recorded at all times and lets the org's setting override it
temporarily.** Reversible, honest, and one boolean expression.

### 18.2 TWO REQUIREMENTS THAT FALL OUT — both are design obligations, not polish

1. **THE UI MUST SAY WHY.** The founder specified this directly: the user sees
   *"something additional next to email implying that it is shared since the org
   set search by email on."* **A greyed-out checkbox is not sufficient** — the
   user must be able to tell that their choice is recorded, currently overridden,
   and by whom. This is the platform telling a user the truth about their own
   privacy, so it belongs in the design, not in a later polish pass.
2. **TURNING SEARCH OFF IS A LIVE VISIBILITY CHANGE.** The moment an org
   un-ticks `email` as searchable, every member who had left the box unchecked
   goes from visible to hidden, at once, with no migration and no deploy. That is
   the intended behaviour — but it means an **org admin's settings toggle
   silently changes what every other member can see.** It should be logged
   (`superadmin_lookup_log` is the worked precedent for making a legitimate but
   consequential action accountable rather than blocking it), and the admin
   should be told what the toggle will do before they confirm.

### 18.3 THE CONFLICT THIS CREATES — **RESOLVED SAME DAY: reading (i). See §19.1.**

**"Searchable makes it shared" collides with the Public Square configuration the
founder himself proposed, and the collision is exactly on decision A (email is
never visible to a co-member).**

Public Square was specified as **email searchable, and nothing else** (§16.1,
§17.1). If searchable makes it shared, then **every Public Square member's email
address is shared with every other Public Square member** — which is docs/16's
P1-1 verbatim, the single finding this entire workstream exists to close.

**That cannot be the intent**, because the same founder framed Public Square as
the WhatsApp case: *"the only way that Sarah can see anything from Dana is if
she knows [Dana's] email."* **Knowing an address is not the same as being shown
it.**

**The two readings of "shared", and only the first preserves decision A:**

| | reading | what Mark (a Public Square member who does NOT know Dana's address) can do |
|---|---|---|
| **(i) shared WITH WHOEVER SUCCESSFULLY SEARCHES** | the lookup confirms *"yes, that address is Dana"* to someone who already typed it. Nothing is listed or displayed. | **Nothing.** He cannot obtain Dana's address, because he must supply it to use it. **This is WhatsApp, and decision A survives intact.** |
| **(ii) shared = DISPLAYED** | the address appears on Dana's profile / in the member list | **He reads it straight off her profile.** docs/16 P1-1 is back, in the one org it was written about. |

**Reading (i) is almost certainly what was meant**, and it also explains the
founder's own wording: a user cannot honestly be promised their email is private
in an org where anyone can confirm it by typing it — **which is an enumeration
oracle (§22.1's F2 evidence, OWASP WSTG-IDNT-04), not a directory listing.** The
checkbox would be making a promise the platform cannot keep, so the UI tells the
truth instead. **That is a statement about honesty, not about display.**

**FOUNDER CONFIRMATION REQUIRED, and this one IS blocking** — it decides whether
decision A holds in the one org it was written for. Everything else in §16–§18
is unaffected either way.

### 18.4 A note on the OTHER fields, so (i) is not over-applied

Reading (i) is specific to a field whose value the searcher must already possess.
**For `name` or `title` it does not apply**: if an org makes `name` searchable, a
member can search common names and enumerate the roster without knowing anything
in advance. **There, searchable really does mean shared, in the plain sense.**

So the honest general statement is: **"searchable implies shared" is true for
every field; what differs is how much a searcher must already know to exploit
it.** An address is high-entropy and must be supplied; a name is not.
`demo-salon` making `name` searchable is a roster and is intended. Public Square
making `name` searchable would be a directory of strangers and must not happen —
which the founder's own configuration already avoids.

---

## 19. DECIDED 2026-09-16 — "shared" means (i), AND a stronger platform rule

### 19.1 §18.3 ANSWERED — decision A survives

> *"Yes, shared means shared with a user you successfully are in contact with.
> No organization lets you see a list of its members. You can only reach out if
> you know the information about the member that you can search on, An email
> address, potentially a name etc"*

**FOUNDER DECISION: reading (i).** A searchable field is confirmed to someone who
already supplied it; it is never displayed to someone who did not. **Decision A
holds in Public Square**, and §18.3's blocking conflict is closed.

### 19.2 THE SECOND SENTENCE IS A BIGGER RULE — and it contradicted ME, not the codebase

> *"No organization lets you see a list of its members."*

**This document repeatedly asserted the opposite** — that *"Frank's staff need to
see each other on a roster"* was the reason the salon and Public Square must
behave differently (§15.4, §16.3, and the §9 founder scenario all lean on it).
**That was asserted from plausibility and never measured. It is false.**

**MEASURED 2026-09-16** — every screen in `apps/web/app/` and `modules/*/ui/`
that renders a list of other people, with its actual gate read rather than
inferred from the filename:

| question | answer | gate |
|---|---|---|
| ordinary org member sees an **org member list**? | **NO** | both rosters are behind `is_org_admin` (`org_member_profiles`) or `requireSuperadmin()` |
| classroom **student** sees classmates? | **NO** | rosters are `cls_can_manage` / `cls_is_ga` only; peer review is anonymous |
| speed-dating **participant** sees other participants? | **NO** | full roster is `sd_can_staff_event`; a participant sees only partners they were actually paired with |
| matchmaking **single** sees other singles? | **YES, scoped** | `mm_is_single`; their own top-X scored matches only — never a directory |
| visual-messaging user sees **conversation** members? the **org**? | **partially / NO** | author names on layers in that one conversation; the "Members" block is an add-member FORM with no roster |
| nail-salon **customer** sees workers? other customers? | **YES / NO** | see §19.3 |

**So the founder's rule is already the platform's design, and my roster argument
was wrong.** The salon and Public Square do not differ in whether browsing is
possible. They differ only in **which field you may search on** — which is
exactly what §16 said, and it is now the whole story rather than half of it.

### 19.3 THE TWO EXCEPTIONS — verified, and both are purpose-bound

Neither is a directory; each is the product doing its job.

1. **Matchmaking (`ui/page.tsx:181`)** — a single sees their own top-X scored
   matches by name. **That is the module.** Gated on `mm_is_single`, scoped to
   the caller's own scores, and email appears only on mutual interest via
   `mm_mutual_matches`.
2. **Nail salon (`ui/page.tsx:~340`, `CustomerConsole`)** — **VERIFIED by reading
   the file:** it renders when `!canOperate && !isWorker`, i.e. for an ordinary
   customer, and lists **every active worker's `display_name`** in a booking
   dropdown. **Its only gate is `requireOrgModule`, which proves org membership
   and module enablement but is NOT a role gate.** So this is literally an
   ordinary member seeing a list of other people.
   **Judged against the rule: legitimate.** These are staff offering a service
   and you must pick one to book — the same as a clinic listing its doctors. **But
   it is the one place that would need an explicit carve-out** if the rule is ever
   enforced mechanically, so it is recorded rather than waved through.

### 19.4 THE ESCALATION — **BLOCKED, see §20.2.** The rule argues for a bigger change than deleting a column

**`profiles_select_shared_org` is the only platform-wide member directory that
exists, and under this rule it should not exist at all.**

Every surface above is gated by role or narrowed to a scope. **The single
exception is the raw policy** — which is precisely what §16.7 demonstrated:
Charlie, a rank-0 customer with no role of any kind, enumerated eight people
including the salon admin. **That is not a leak of the `email` column. It is a
member directory, and `email` is merely the worst thing in it.**

**So the founder's rule strengthens the email work and also outgrows it.** The
argument until now was *"email should not be visible."* The stronger and more
consistent argument is: **an ordinary member should not be able to enumerate the
org at all, and one policy is the only thing on the platform that lets them.**

**The end state this implies**, and it is the same direction §17.4 already
pointed: replace the blanket row-read with the **name resolver** — you may
resolve a name for a person you are legitimately interacting with; you may not
browse everyone. A per-relationship lookup, not a blanket policy.

**Why this is NOT v1 returning (checked, because §9 requires it):** v1 died
because it **carved one org out** of `profiles_select_shared_org` and thereby
broke the invite lookup that depended on that policy. This carves out no org —
it replaces the read path **platform-wide and uniformly** — and the invite
lookup is `org_find_user_by_email`, a SECURITY DEFINER that never consulted the
policy in the first place. **The circularity that killed v1 is structurally
absent.**

**Scope warning, stated plainly and NOT decided here:** this is larger than the
reviewed email slice, it touches every roster-rendering screen in six shipped
modules, and **the two adversarial reviews in §13/§14 examined the column
deletion, not this.** It should not be folded into the email slice by momentum.
**§11's build order still stands as the safe path** — the resolver is built in
step 2 either way, so nothing done for the email slice is wasted if this is
adopted afterwards.

---

## 20. THE SCOPE BOUNDARY — FOUNDER-DRAWN 2026-09-16, and it BLOCKS §19.4

> *"single sees their own top-X scored matches, potentially seeing a list of
> classmates, or potentially adding seeing a list of speeddating participants for
> your event or seeing every active worker name so they can book one would be a
> completely different module specific and more importantly most likely
> submodule (like a specific event or a specific class) feature. completely
> separate from this and needs its own discussion and generalization looking
> across the apps and may even need more future modules to fully hash out."*

### 20.1 The line

**Two different questions, and only the first belongs to this workstream:**

| | **ORG-LEVEL visibility** | **ENTITY-LEVEL visibility** |
|---|---|---|
| the question | who may I see **by virtue of sharing an org**? | who may I see **by virtue of being in the same class / event / conversation / booking**? |
| the mechanism | `profiles_select_shared_org`, `shares_org_with` | per-module, and **more precisely per-ENTITY** — one class, one event |
| examples | Charlie enumerating eight people (§16.7) | §19.3's two exceptions; a classmate list; an event roster |
| **status** | **IN SCOPE.** This document. | **DEFERRED by the founder.** Needs its own discussion, a generalization across the apps, and *"may even need more future modules to fully hash out."* |

**This is extract-don't-speculate applied by the founder to his own model**, and
it is right: §19.3's exceptions are not counter-examples to his roster rule, they
are a different rule that has not been written yet.

**Existing home for it:** docs/15 §11's **entity-level `joinPolicy`** (slice 3
remainder — *invite-only / request-approval / open, per class / location /
event*), already deferred there and cross-referenced from CLAUDE.md and
docs/04. **Entity-level VISIBILITY is the same granularity as entity-level
JOINING and should be worked in the same pass, not invented separately.**

### 20.2 THE CONSEQUENCE — §19.4 is BLOCKED, and that is correct rather than a problem

**§19.4 proposed replacing `profiles_select_shared_org` with a name resolver:
*you may resolve a name for a person you are legitimately interacting with; you
may not browse everyone.* That phrase contains the deferred question.**

"Legitimately interacting with" **is** the entity-level relationship — same
class, same event, same conversation. So the resolver cannot be narrowed beyond
today's org-wide rule until the entity-level rules exist. Concretely:

- **Resolver rule A (org-wide):** *resolve a name for anyone you share an org
  with.* Identical reach to today. Buildable now.
- **Resolver rule B (entity-scoped):** *resolve a name only for someone you share
  an entity with.* **Requires the deferred generalization.**

**§19.4 assumed B. B is blocked. Therefore §19.4 is blocked** — and the founder's
scoping decision, made independently, is what surfaces it. Recorded here so a
future session does not attempt §19.4 and discover the dependency halfway
through a migration.

### 20.3 THE EMAIL SLICE IS UNAFFECTED — verified, not assumed

**This matters, because it is the only reason the reviewed work can still
proceed.**

The email slice **does not touch `profiles_select_shared_org` at all.** It
deletes a column. The entity-level surfaces that read `profiles` — the seven
`display_name || email` chains in §3 R4, on classroom rosters, speed-dating
events and vm conversations — **need the NAME, and email was only ever a
FALLBACK.** After the slice they read `display_name` through the same unchanged
policy and simply stop having an email to fall back to.

**So the email slice has no dependency on the deferred question.** It is
independent, adversarially reviewed (§13, §14), and ready. **The wider change
(§19.4) is not, and the two must not be merged.**

### 20.4 The three-way split, for the next session

1. **Email — designed, reviewed, ready.** Delete `profiles.email`; `auth.users`
   is the single source of truth; ~22 call sites. §4, §11. **Open: whether
   `settings` / `is_superadmin` ride along (§6) — founder's call, near-zero cost,
   not a live leak.**
2. **The org-level directory (§19.4)** — kill the blanket row-read. **BLOCKED on
   (3).** Do not start.
3. **Entity-level visibility** — the founder's deferred generalization. Belongs
   with docs/15 §11's entity-level `joinPolicy`. **Needs its own discussion; may
   need more modules before it can be settled.**

---

## 21. WHERE THINGS LIVE AFTERWARDS — a GAP the founder found, 2026-09-16

**Founder: *"what about email addresses? What if we want to add something later,
are we making provisions for that?"*** **The answer to the second half was NO,
and this section exists because of that question.**

### 21.1 The gap, stated plainly

§6 and §0.2 say `settings` and `is_superadmin` "leave `profiles`". **They never
said where they go.** They cannot simply vanish: `settings` holds a live console
preference (`superadminDefaultAddActive`) and `is_superadmin` is the flag the
whole Owner Console depends on. **A destination was required and was never
named** — and that destination is exactly the provision for future fields.

### 21.2 THE THREE HOMES — and the rule is the durable part

| home | holds | who can read it | is it new? |
|---|---|---|---|
| **`auth.users.email`** | the authoritative email address | the caller (from their own session); SECURITY DEFINER functions with a reason | **no** — it is where the real address has always been. `profiles.email` was a write-once copy no trigger ever refreshed (§2.1) |
| **`profiles`** | **the PUBLIC identity row** — `user_id`, `display_name`, `created_at`, `updated_at` | any co-member, by `profiles_select_shared_org` | no, but its MEANING becomes explicit |
| **a private companion table**, one row per user | `settings`, `is_superadmin`, and anything added later that must not be public | the user themselves, plus `is_superadmin()` | **YES — NEW, and §6 omitted it** |
| **the in-org profile** (the founder's model, §16) | org-scoped, shareable attributes — title, department, a per-org name | per the org's searchable set + the user's checkbox (§18.1) | yes, but in the DEFERRED naming slice, not this one |

**THE RULE, which is worth more than any of the tables:**

> **`profiles` is PUBLIC. Anything added to it is visible to every co-member, by
> definition. Private per-user data goes in the companion table. Shareable
> org-scoped data goes in the in-org profile.**

**This is the durable output of the whole exercise, and it is what would have
prevented the original bug.** `settings` was added to `profiles` in
`20260727010000` and became org-mate-readable the same day. **Nobody decided
that; nobody noticed.** The column was added to a table whose public nature was
never written down.

### 21.3 MAKE IT ENFORCEABLE, not merely documented

Documentation did not stop `settings` and will not stop the next one. **Two cheap
mechanisms, both in the style this repo already uses:**

1. **A ratchet test** that enumerates `profiles`' columns from `pg_catalog` and
   **fails the build if the set changes** without the allow-list being updated.
   Identical in shape to `view-as-coverage.test.ts` and to §11.6's definer
   ratchet. The failure message should say *"`profiles` is public to co-members —
   if this column is private, it belongs in the companion table."*
2. **A `comment on table public.profiles`** carrying the rule, so it is visible
   to anyone reading the schema rather than only to someone who found this
   document.

**Add the rule to docs/03's conventions** — that is where platform-wide rules of
this kind live, and it belongs there more than here.

### 21.4 ONE THING THE BUILD MUST PROVE, NOT REASON ABOUT

`is_superadmin()` **reads** the `is_superadmin` column; the companion table's own
SELECT policy would **call** `is_superadmin()`. **VERIFIED LIVE 2026-09-16: nine
other functions in `public` reference `is_superadmin`** — `is_org_admin`,
`module_roles_guard_hierarchy`, `module_roles_guard_last_director`,
`org_accept_invite`, `org_caller_rank`, `org_members_guard_hierarchy`,
`org_modules_pin_enablement`, `superadmin_log_guard` — **and they call the
FUNCTION, not the column**, which is why moving the column is a one-line change
to one function rather than a nine-function edit. That looks circular and is
probably not — the function is `SECURITY DEFINER` owned by `postgres`
(VERIFIED LIVE 2026-09-16), so it bypasses RLS entirely and never re-enters the
policy.

**But "probably not" is not the standard here.** This must be demonstrated live
in a rolled-back transaction before the migration is written, the same way §13's
definer plan was. **If it does recurse, the fix is to keep `is_superadmin` on
`profiles`** — it is the least sensitive of the three columns (§6 rates it a
targeting hint, not personal data) and moving it is optional.

### 21.5 Does this re-open Option A?

**No, and the distinction is worth stating because it looks like a reversal.**

Option A was rejected for creating **a second copy of email** — data that already
has an authoritative home in `auth.users`, kept in sync by nothing (§4.4). **The
companion table copies nothing.** `settings` and `is_superadmin` have no other
home; they are simply moving, once, off a row that turned out to be public.

**No backfill trigger, no sync obligation, no staleness** — which were the three
arguments against Option A. **A one-time move of data that exists in exactly one
place is not the same as a mirror that must be maintained.**

---

## 22. Decisions log

- **2026-09-16 — this document created, reviewed twice, and corrected.** Design
  drafted, **not built; no SQL written.** Both adversarial reviews ran (§13,
  §14). Option B's mechanism holds; §3's site table did not, and is fixed.
  **F1 is put to the founder in §9 and is OPEN.**
- **2026-09-16 — F2 and F3 were asked; NEITHER IS ANSWERED.** The founder asked
  for a fuller explanation of the trust-class idea before deciding F3, and for
  the industry evidence before deciding F2. **The F2 evidence was gathered and
  is recorded in §22.1 below** — it did not previously exist in writing
  anywhere, and the founder's decision should be made against it.
- **2026-09-16 — docs/00 insertion point for F3 identified, not edited.** The
  trust-class paragraph (docs/20 §32.1) belongs in **docs/00 §"Core
  principles", beside principle 7** (*"Tenancy isolation is the existential
  risk"*), which is the only principle it qualifies. **Nothing was written to
  docs/00** — F3 is unanswered. Recorded so the next session does not re-derive
  where it goes.

### 22.1 THE F2 EVIDENCE — what other products do, gathered 2026-09-16

The founder asked for this explicitly before deciding whether
`org_find_user_by_email` (and `find_module_peer`) should keep returning the
display name. **It is recorded here because it existed nowhere in writing.**

| product | does an email invite resolve the address to a NAME? |
|---|---|
| **Slack** | **No.** Workspace invites are address-only; pending invites list the address you typed. Name autocomplete only for people already on the roster. |
| **Google Workspace / Groups** | **No for external addresses.** Autocomplete is fed by your own domain directory; external members are a separate, permission-gated path. |
| **Microsoft Teams / Entra B2B** | **No — the clearest evidence.** The portal asks the INVITER to supply the display name as well as the address. Microsoft holds the real name in the home tenant and does not disclose it. |
| **Figma** | **No.** External addresses are labelled "(guest)" beside the address. |
| **Discord** | **No email lookup exists at all**, anywhere in the product. |
| **Notion** | **Yes — and it is the ONLY one, and it ships a per-user opt-out for exactly this disclosure.** |

**Facebook and LinkedIn** both carry a dedicated *"who can look you up by your
email address"* setting, separate from any group display setting — which is
what docs/20 §31.4 Q0 predicted. LinkedIn's "who can download your email"
defaults to **No**.

**Three conclusions that bear on the decision:**

1. **The norm is EXISTENCE, not identity.** Notion is the single exception, and
   it pairs the disclosure with a user-controlled toggle — an admission that
   email→name is a privacy disclosure rather than a convenience. §8 designs that
   toggle and marks it conditional on this decision.
2. **Where a name IS revealed, something always bounds it:** same domain/tenant,
   already on the roster, the subject's own consent, or social distance.
   **"Is an admin of some org" is nowhere sufficient** — and that is exactly
   what `org_find_user_by_email` gates on today, with no org filter at all
   (docs/20 §8.3).
3. **OWASP treats this as a finding.** WSTG-IDNT-04 (account enumeration) covers
   invite flows that distinguish registered from unregistered addresses. An
   invite box returning a NAME is strictly worse than the classic oracle — an
   attribute rather than a boolean, and trivially scriptable. The standard
   mitigation is the uniform response.

**The one thing the evidence does NOT settle:** `find_module_peer`'s typo case
(docs/20 §3.4 — confirming *"did you mean Sarah Cohen?"* before mailing a
private picture to a wrong address). **No surveyed product has that feature**,
so the industry is silent on it. Discord's answer is the closest analogue and is
instructive: it removed email lookup entirely and made you type an exact
username — which is the same move §7.2 recommends for the matchmaking picker.


---

## 23. WHAT WAS BUILT, 2026-09-17 — and what "done" does NOT yet mean

**Written by the session that built it.** §11's build order was followed in
order and nothing was merged in from §20.4 items 2 or 3.

### 23.1 THE ARTEFACTS

| # | what | where |
|---|---|---|
| 1 | **Display-name-at-signup** (§11 step 1, no migration) | `apps/web/app/login/page.tsx` — a required field in signup mode, passed as `options.data.display_name`, which is where `handle_new_user` already looked |
| 2 | **An `/account` page** — NOT in §11, and it is a gap the build found | `apps/web/app/(app)/account/*`. `grant update (display_name)` has existed since `20260706120000` and **no screen had ever used it**, so a display name was write-once-at-signup. Once it is the ONLY label a co-member sees, that is not tenable — and the one prod user with a NULL name is the founder's own account |
| 3 | **The definers** (§11 step 2), additive, reversible | `supabase/migrations/20260917010000_email_definers.sql` |
| 4 | **The drop + the companion table** (§11 step 4) | `supabase/migrations/20260917020000_profiles_is_public.sql` |
| 5 | **~22 call sites re-pointed** (§11 step 3) | all of §3's R1–R10 |
| 6 | **RLS cases with controls** (§11 step 5) | `rls.test.ts` — a new 8-case block, plus every one of the 16 `.eq('email', …)` fixtures re-pointed at an owner-connection resolver |
| 7 | **Both ratchets** (§11 step 6, §21.3) | `packages/db/src/profiles-public-columns.test.ts` |
| 8 | **The prod-verify script** (§11 step 7) | `scripts/prod-verify-profile-visibility.mts` — 62 checks, `--local` supported |
| 9 | **The acceptance test a non-engineer can run** (§16.7) | `scripts/verify-profile-visibility-local.mts` |

**Verified in CI's exact order** (reset → seed → db → e2e, same database, no
reset between): **db 231/231 → e2e 52/52**, typecheck 9/9, module suites 4/4,
clean build. RLS floor raised 211 → 221.

### 23.2 §21.4 IS DISCHARGED — the recursion was DEMONSTRATED, not reasoned about

The doc required this before any SQL was written, and it was done first.
`is_superadmin()` reads the `is_superadmin` column; the companion table's SELECT
policy calls `is_superadmin()`. Run in a ROLLED-BACK transaction against the
exact shape: **the superadmin read all 11 rows — no recursion, no 42P17.**

**The controls are what make that a result rather than an anecdote:** an
ordinary user in the same transaction saw exactly **1** row (their own) and got
`false` from the function, proving the policy was genuinely ENFORCED rather than
switched off; and the rollback was confirmed clean with its own control query.
Re-demonstrated afterwards on the DEPLOYED objects. **The recorded fallback —
leave `is_superadmin` on `profiles` — was not needed.**

### 23.3 ⚠ §16.7's ACCEPTANCE SENTENCE WAS WRONG, and §20.3 is the correct reading

§16.7 says that after the slice the same two calls *"must return Charlie's own
row and nothing else."* **They do not.** Charlie still gets **eight rows of
`display_name`**; the three moved columns 42703.

This is not a shortfall, it is §16.7 having been written BEFORE the scope
boundary in §20. **§20.3 is explicit that the email slice does not touch
`profiles_select_shared_org`**, and killing that blanket directory is §19.4,
which is **BLOCKED** on the founder-deferred entity-level question (§20.2).
Decision 6 keeps the name visible deliberately. The acceptance script asserts
the eight names ON PURPOSE, labelled "NOT IN SCOPE", so a future reader cannot
mistake it for a regression.

### 23.4 FOUR THINGS THE BUILD FOUND THAT THE DESIGN AND BOTH REVIEWS MISSED

1. **`org_accept_invite` reads ANOTHER USER's `profiles.is_superadmin`.** §6
   measured that no application code reads another user's `settings` or
   `is_superadmin` and that measurement was *correct* — it searched TypeScript.
   **A SQL function body is also a call site.** Found by the RLS suite failing
   with `column p.is_superadmin does not exist`. It could not use
   `is_superadmin()` because that helper answers only about the caller, and this
   asks about the INVITER. → docs/03 #25.
2. **`find_module_peer` failed OPEN on an ambiguous address.** `auth.users`'
   uniqueness is PARTIAL (`WHERE is_sso_user = false`), so two accounts may
   share one address — and a SQL function declared to return a SCALAR over a
   two-row query **does not raise; it silently returns the first**
   (demonstrated). Minting a module seat for an arbitrary one of two accounts is
   a wrong PRODUCT outcome. Now returns NULL unless the match is unique. *Found
   by adversarial review A.*
3. **`sd_match_contacts` would have raised `22023` on a stringified toggle.**
   `sd_events.format` is unconstrained jsonb; `(format -> 'k')::boolean` raises
   on a JSON string and would abort the query **for the whole event** — and this
   is the write-once-never-retried path, so the failure would have been
   permanent. Now `->>` with a text compare; all four shapes run live. *Found by
   adversarial review A.*
4. **The companion table's `for all` superadmin policy was an unintended
   widening.** Its SELECT half duplicated an arm that already existed; its
   UPDATE half let a superadmin overwrite **any user's** `settings`. Its own
   comment claimed it existed to administer the `is_superadmin` FLAG — a
   capability `authenticated` never had, since the column grant is `settings`
   only. Policy **removed**; nothing needs it (promotion runs as `service_role`).
   This is docs/20 §8.1's already-shipped lesson arriving somewhere new. *Found
   by adversarial review A.*

5. **THE MOST SERIOUS ONE, AND NEITHER REVIEW NOR THE LOCAL SUITE FOUND IT — CI
   DID.** `20260917020000` created `public.user_private` and granted `select` +
   `update (settings)` **without revoking first**, on the reasoning that a table
   created by a CLI migration inherits no API-role grants. Measured:
   `pg_default_acl` for `grantor=postgres, schema=public` gives `authenticated`
   only `Dxtm` **locally** — but the default varies by schema and environment
   (`schema=storage` gives the full `arwdDxtm`), and **in CI the effective grant
   included TABLE-LEVEL UPDATE, which covers every column.** A column grant
   cannot narrow a table grant, so `update (settings)` defended nothing.
   **`bob@demo.local`, an ordinary seeded user with no role anywhere, set his own
   `is_superadmin` to true** — then satisfied `is_org_admin` everywhere and took
   **23 further tests** down with him across org self-management, invite-accept
   and all four scoped-authority suites. The local suite had passed 231/231.
   Fixed by `revoke all privileges … from public, anon, authenticated,
   service_role` before the grants, and the ACL is now asserted DIRECTLY from
   `pg_catalog` in the ratchet test and the prod-verify script rather than only
   through behaviour. → docs/03 #27.

**And two defects reviewer B found in files the survey never listed:**
`scripts/verify-console-view-as.mts` and `scripts/verify-data-browser.mts` both
read `profiles.is_superadmin` as a probe PRECONDITION — so each would have
reported a FAILING precondition rather than crashing, which is the worse
failure. Both re-pointed.

**One claim of this document is FALSIFIED, and it matters for the next audit.**
§3 and §14.3 both state, with a control, that *"no `select('*')` on `profiles`
exists anywhere."* At the SQL level that is **not true**:
`apps/web/lib/data-browser.ts:190` runs `supabase.from(lookup.table).select('*')`
generically, and `profiles` is a declared lookup. It is harmless after the drop
(fewer columns return; the UI derives its columns from the row), but **the
measurement was of literal source text, not of what the database is asked** — a
generic query built from a declaration table is invisible to that grep.

### 23.5 THE CONSOLE'S `.rpc()` BAN HAD TO BE REPLACED, and the replacement is stronger

`rls.test.ts` carried a source scan banning `.rpc()` outright on the Owner
Console path: every query the surface issued had to be one the superadmin could
already issue as themselves, so `requireSuperadmin()` granted nothing (docs/03
#18). **Deleting `profiles.email` removes the RLS route to another user's
address on purpose, so the console MUST now go through a definer** — there is
nothing else left.

The ban was a PROXY for the invariant, not the invariant. It is replaced by:
every `.rpc()` on that path must name an allow-listed function, and **each one
must carry `is_superadmin()` in its own body, read from `pg_proc`** rather than
trusted from a comment — with `is_org_member` as a control proving the predicate
can fail. `lib/data-browser.ts` and `console/page.tsx` were ADDED to the scanned
surface, since they now carry a definer too.

### 23.6 THE DEPLOY — DONE 2026-09-17, IN TWO SITTINGS, AND IT NEEDED A PROCEDURE

> **SHIPPED. Both migrations are on PRODUCTION and prod-verified.** Evidence:
> `prod-verify-profile-visibility.mts` **70/70**; `prod-verify-migration.ts`
> **0 failures** on both files; the **acceptance test run against PROD as
> charlie@demo.local 7/7**; **8/8 live as real users**, including a
> self-promotion attempt refused `42501` and the founder's account still reading
> as superadmin. `pnpm backup:prod` taken before each sitting, and the second
> backup was checked to actually contain all 12 `profiles` rows WITH the three
> columns before anything was dropped.
>
> **SPLIT INTO TWO SITTINGS, founder's decision, and it is the part to copy.**
> The drop is the only step that cannot be undone, so sitting one stopped after
> the additive migration + the code deploy: production ran the new code for a
> while with the old columns still present and unread, which is a fully working
> state. Sitting two applied the drop. **That separation is worth more than the
> ordering rule itself** — it converts "get the order right" into "you can stop
> and look before anything is destroyed."
>
> **A NEAR-MISS WORTH RECORDING.** Before dropping, the backup was checked for
> the `profiles` rows and the check came back **ZERO** — which would have been a
> stop-everything result. It was a **VACUOUS NEGATIVE**: `pg_dump` writes
> `INSERT INTO "public"."profiles"` with quoted identifiers and the grep looked
> for the unquoted form, so the pattern could not have matched whatever the file
> contained. The data was there all along (12 rows, all three columns). **A
> backup check is exactly where a search that cannot match looks like a
> catastrophe** — or, worse on a different day, where a real absence looks like
> a pass. Prove the search works before trusting its answer.

**THE TOOLING DOES NOT SUPPORT THE ORDER THE DESIGN REQUIRES, and this was found
at deploy-planning time rather than mid-deploy.** §11 step 4 prescribes: additive
migration first, then code, then the drop. Splitting the work into two migration
files was supposed to make that expressible. **It does not, on its own:**
`pnpm migrate:prod` wraps `supabase db push`, which applies EVERY pending
migration and offers no way to stop at one (`--help` lists `--include-all`,
`--include-roles`, `--include-seed`, `--dry-run`, `--db-url`, `--linked`,
`--local`, `--password` — and nothing that targets a version).

**⚠ CORRECTED 2026-09-17, SAME DAY, AND THE CORRECTION MATTERS BOTH WAYS.** An
earlier version of this section called both naive orders an "outage" and said
push-first would 500 **every authenticated page**. **That was reasoned, not
measured, and it is wrong.** Measured against the live stack:

```
MISSING RPC    -> did NOT throw. data = null, error.code = PGRST202
MISSING COLUMN -> did NOT throw. data = null, error.code = 42703
CONTROL: an existing rpc -> data = true, error = null
CONTROL: an existing column -> 1 row, error = null
```

**`supabase-js` returns `{data: null, error}`; it does not throw.** So a missing
function or column DEGRADES a page instead of crashing it, and most of these
call sites already handle a null with a fallback. Neither order takes the site
down. The real picture, traced call site by call site:

| if you… | what actually happens |
|---|---|
| **push first**, then `migrate:prod` | `getProfile()` gets `null` from `current_user_private()`, so **`is_superadmin` reads as false**: the Owner Console link disappears and `/console` `notFound()`s — **a 404, not a 500**. `find_module_peer` is missing, so the three "add a member by email" admin actions raise *"No user found with email X"* — a WRONG but contained message. `superadmin_user_emails` is missing, so console/data-browser/engagement show blank addresses. `sd_match_contacts` is missing, so a speed-dating reveal throws. **Ordinary member pages in all six modules are UNAFFECTED** — they read only `display_name`, which still exists. |
| **`migrate:prod` first** (applies BOTH), then push | the live OLD code's `profiles` selects all name `email`, so they 42703 and return null — and the fallbacks turn that into **names rendering as "Someone" / raw UUIDs across every roster in all six modules**, plus the same console 404 and the same broken add-by-email. |

**So the ranking is the opposite of "one is an outage and one is not": neither
is, and the WORSE of the two is `migrate:prod` first**, because it degrades
**member-facing** pages in every module, whereas push-first mostly degrades
**admin and superadmin** surfaces. The procedure below avoids both, and is still
the thing to follow — but if a step fails halfway, this table is what you are
actually looking at, and it is recoverable by completing the sequence rather
than by rolling back.

**THE PROCEDURE THAT ACTUALLY WORKS — the drop is held out of the migrations
directory for one step.** It is a working-tree move only; the file stays in git,
so nothing is reverted and the pushed commit is unchanged.

```
# 0. Back up first — this is beyond additive (docs/12).
pnpm backup:prod
pnpm migrate:prod --dry-run          # expect BOTH 20260917010000 and 20260917020000

# 1. Hold the DROP back, apply only the ADDITIVE migration.
mv supabase/migrations/20260917020000_profiles_is_public.sql <somewhere outside supabase/migrations/>
pnpm migrate:prod --dry-run          # MUST now list 20260917010000 ONLY — check before proceeding
pnpm migrate:prod

# 2. Deploy the code and WAIT for it to be live. The app is fine here: the new
#    definers exist, and the old columns still exist but are simply unread.
git push
#    …confirm a READY production deployment for this commit (Vercel /v6/deployments,
#    VERCEL_TOKEN is in .env.deploy) and sign in to a real page before continuing.

# 3. Only now the drop.
mv <the file> back into supabase/migrations/
pnpm migrate:prod --dry-run          # MUST now list 20260917020000 ONLY
pnpm migrate:prod

# 4. Verify against prod.
pnpm exec tsx scripts/prod-verify-profile-visibility.mts
```

**Step 2 is the load-bearing wait.** If the code is not actually serving when
step 3 runs, step 3 is the app-wide outage §14.2 warned about.

**Do not write SHIPPED or CLOSED for either migration until `migrate:prod` has
run AND that script has passed against prod** — CLAUDE.md is emphatic, and this
file has been burned by exactly that before.

**A GENERAL LESSON FOR ANY FUTURE COLUMN DROP (→ docs/03 #26):** splitting a
destructive change into two migrations makes each half's ordering *statable*,
but it does not make it *executable* — `supabase db push` is all-or-nothing, so
the split must be paired with physically holding the destructive file back for
one step. Plan that before the deploy window, not during it.

### 23.7 PROD MEASUREMENTS TAKEN THIS SESSION — §13.3's open item is CLOSED

§13.3 recorded that the publication and view checks had been run **on LOCAL
ONLY**, and warned against carrying the local zero forward. Both were run
against PROD on 2026-09-17:

- **`pg_publication_tables` on prod: 0 rows.** Control: `supabase_realtime`
  exists, so the empty list is a real absence, not a missing publication.
- **Prod's only non-system views are in `extensions` and `vault`** — none in
  `public`, none over `profiles`. Control: 146 views exist in total.
- `profiles.email` vs `auth.users.email` divergence on prod: **0 of 12**, so
  re-pointing the three existing definers is behaviour-preserving today.
- The **1 NULL `display_name` is `jasonartisenergy@gmail.com`** — the founder's
  own account. That makes §11 step 1's backfill question concrete and free of
  any third-party privacy dimension: the migration seeds it from the email
  local-part, generically, and `/account` lets him change it in one screen.

Both checks are now permanent in `prod-verify-profile-visibility.mts`, so the
local-cannot-catch-prod-drift class does not reopen.

### 23.8 STILL OPEN AFTER THIS SLICE

- ~~**F3** (§0.6)~~ **ANSWERED AND WRITTEN 2026-09-17: docs/00 principle 8.** The
  drafted wording was rejected by the founder and replaced — join method is
  EVIDENCE, the decision is PER-PURPOSE configuration. See §0.6.
- **§19.4 / §20.4 item 2** — killing the blanket member directory. Still
  BLOCKED. Not started, deliberately.
- **§20.4 item 3** — entity-level visibility. Still founder-deferred.
- **docs/20 §8.3** — `org_find_user_by_email` still resolves a user who is not
  in the org, because it is an INVITE lookup and an org join would break every
  invite. This slice **narrowed what it returns** (id only, no name, no address)
  but did not close §8.3, which needs logging. §7 Q4 already said so.
- **The privacy line.** §7 Q5's sentence is now literally true in every org and
  cheap to add: *"Other members of an organization can see your name. They
  cannot see your email address."* `/privacy` exists; this was NOT added here.
