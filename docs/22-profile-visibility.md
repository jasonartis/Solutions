# Profile visibility — where a user's email actually lives

**Status, 2026-09-16: DESIGN DRAFT. NOTHING IS BUILT. NO MIGRATION EXISTS.**
**REVIEW A (the mechanism) HAS RUN — §13, verdict OPTION B HOLDS.**
**REVIEW B (the blast radius) HAS RUN — §14, verdict §3 WAS INCOMPLETE; two
corrections applied. BOTH REVIEWS ARE IN. THE DESIGN IS READY FOR F1.**

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

**This design recommends the second**, and notes it is a *widening of the brief*
the founder should approve explicitly rather than have assumed. `settings` and
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

### 15.4 THE FINDING — the founder's own model REQUIRES a trust class, for NAMES

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
than an exception to it. **So F3 is not documentation-only after all: the
founder's own model needs the distinction to EXIST, not merely to be written
down.**

**This is NOT a reversal of §4 and does not reopen the reviewed design.** Email
and names are separable and the founder chose to separate them (§15.1). Option B
ships as reviewed. **But §6's claim that moving three columns leaves `orgs.kind`
with "nothing left to do" is now WRONG, and is corrected here:** it has nothing
left to do **for email**, and something real to do **for names** — which is
precisely the deferred slice. F3 and §15.3 should be settled together, in that
slice, not in this one.

---

## 16. Decisions log

- **2026-09-16 — this document created, reviewed twice, and corrected.** Design
  drafted, **not built; no SQL written.** Both adversarial reviews ran (§13,
  §14). Option B's mechanism holds; §3's site table did not, and is fixed.
  **F1 is put to the founder in §9 and is OPEN.**
- **2026-09-16 — F2 and F3 were asked; NEITHER IS ANSWERED.** The founder asked
  for a fuller explanation of the trust-class idea before deciding F3, and for
  the industry evidence before deciding F2. **The F2 evidence was gathered and
  is recorded in §16.1 below** — it did not previously exist in writing
  anywhere, and the founder's decision should be made against it.
- **2026-09-16 — docs/00 insertion point for F3 identified, not edited.** The
  trust-class paragraph (docs/20 §32.1) belongs in **docs/00 §"Core
  principles", beside principle 7** (*"Tenancy isolation is the existential
  risk"*), which is the only principle it qualifies. **Nothing was written to
  docs/00** — F3 is unanswered. Recorded so the next session does not re-derive
  where it goes.

### 16.1 THE F2 EVIDENCE — what other products do, gathered 2026-09-16

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
