# Public Square — an ordinary org, made safe by fixing the general case

**Status: PROPOSED DESIGN v4, 2026-09-10. NOT BUILT. REGRESSION REVIEW COMPLETE.**
Written to be attacked. Everything is a claim except where marked FOUNDER
DECISION or **VERIFIED LIVE** (a `pg_catalog` read or a file read, dated).

**Review state, stated honestly:** v1 (2026-09-06) was reviewed by four agents
and abandoned. v2 (2026-09-08) was sent to six; three returned and three died on
a session limit. v3 (2026-09-09) folded in the three that returned and was
**killed on 2026-09-10 by a live check of its own central mechanism** (§9.3).

**The two reviews that had never completed are now COMPLETE (2026-09-10) — §11.**
The regression question ("what breaks in the six shipped modules") is answered
for the first time in this document's history. **v4 is the design that answer
supports.** **v4 has NOT survived its own adversarial security review — that
review was spawned and DIED ON A SESSION LIMIT, the fourth review of this
design to do so (§14). v4 is measured, not vetted.** No migration has been
written or applied.

**Adversarial review RAN 2026-09-11: SURVIVES WITH CHANGES — four blocking items in §17.8, including one this design missed in its own documented failure pattern (§17.1).**

**Build status: BLOCKED ON THE LOCAL DATABASE, deliberately.** A concurrent
session (Track A) holds it for the `module_roles` census fix, the docs/19 seat
authority fix, the `vm_layers` cascade and self-block. Everything below was
established with read-only catalog queries. **No migration is written; a
migration nobody has run is the same mistake in SQL that killed v1–v3.**

---

## 0. THE PRINCIPLE (founder's, 2026-09-08), and its corrected reading

> **Never write a special rule for one org. Fix the general case so the Public
> Square case is covered as a consequence.**

**Corrected reading, from v2's review:** *fix the general MECHANISM — do not give
every user a general SETTING.* v2 obeyed the letter of this and broke its spirit:
it turned "stop strangers reading each other's email" into a per-membership
preferences feature with a settings page, a backfill, four definers and a
carve-out in the platform's consent trigger. A one-line privilege revoke is a
general mechanism. A preferences system is a product.

Also corrected: v2 justified the principle by claiming a per-org exception "must
be remembered by every future policy author." **Measured, that was weak for the
profile case** — `shares_org_with` is referenced by exactly ONE policy and zero
other functions, so a conjunct inside that helper is not forgettable by anyone
who calls it. The principle still holds as a default, and it holds strongly for
`org_members` / `module_roles` (which gate on `is_org_member` in several places),
but it was not the reason v1 failed. **v1 failed because its guards were
circular and incomplete, not because exceptions are unrememberable.**

`orgs.kind` survives as an **identifier only** (which org is the public one).
See §7.6 — v3 no longer claims that *nothing* branches per-org.

---

## 1. History — THREE reversals and one mechanism change. Read before proposing a fourth.

- **2026-07-16.** Two shapes sketched: per-pair lightweight orgs vs. one shared
  "everyone" org. Undecided.
- **2026-07-20.** [docs/16](16-network-features-review.md), an independent
  Fable-tier review of the shared-org shape ("Public Square"): P1-1 (CRITICAL,
  platform-wide email directory), P1-2 (auto-invite = auto-join), P1-4 (roster
  enumeration), P1-5 (unvetted defaults). Checklist **blocking and undecided**.
- **2026-09-04.** A session chose the shared org, found docs/16, **reversed to
  per-pair** because docs/16's items were undecided.
- **2026-09-06.** Founder reopened: **per-pair is also a category error** (*"Dana
  messaging her sister is not being done as members of an organization"*). Design
  v1 written — shared org + five guards keyed on `orgs.kind`. **Four reviews
  found it not buildable** (§8).
- **2026-09-08.** Founder rejected retreating to per-pair and supplied §0.
  Design v2 — a platform-wide per-membership sharing preference. **Reviews found
  the mechanism disproportionate and its cost understated 7×** (§9).
- **2026-09-09.** Same shape, **simpler mechanism**: a column-level privilege
  revoke instead of a preferences system. **Design v3 — DEAD. Killed 2026-09-10
  by a live `pg_class.relacl` read: its central premise was a mis-read of
  `information_schema` and the revoke is a no-op (§9.3).**
- **2026-09-10 (v4, the design under review).** Same shape again. **A ROW policy,
  not a grant**: one conjunct inside `shares_org_with` excluding orgs of
  `kind='public_square'`, so co-membership of the Square infers no relationship
  (§12). The regression review finally completed (§11); the adversarial review
  ran 2026-09-11 and returned **SURVIVES WITH CHANGES**, with four blocking items
  (§17.8).

**The shape has been right since 2026-07-16 and the founder has been right about
it throughout. What kept failing was the mechanism chosen to secure it.**

---

## 2. The design

**Public Square is an ordinary org.** Invited to, accepted, left, carries
modules — like Pozna. Verified: consent needs NOTHING new, because since
`20260727010000` a new member of ANY org is `pending` until they accept
(`org_members.status` DEFAULT `'pending'`; the hierarchy guard forces `pending`
for every non-superadmin inserter).

**invited → pending → accept → active.** Identical everywhere.

Two consents (FOUNDER DECISION 2026-09-08):

1. **Join the space** — the existing invite/accept flow. (The founder's own
   2026-09-08 wording, kept verbatim. **"The space" means the Public Square ORG,
   i.e. an `org_members` row.** The phrase proved ambiguous in practice —
   2026-09-11 — so everywhere outside this recorded decision this document says
   **ORG** and **MODULE**. See §16.4's table for the two rows and the two
   withdrawals.)
2. **Join each activity** — per-module opt-in, which has ALWAYS been required
   (`has_module_role` needs an explicit `module_roles` row).

### The flow

1. A user signs up → a trigger creates a **pending** Public Square membership →
   they see the existing amber invite card and accept or decline. (FOUNDER
   DECISION: **auto-invite**, not self-service join — discoverable, reuses
   shipped UI.)
   > **NOT FOR v1 — SUPERSEDED BY §16.3, 2026-09-11.** The founder chose
   > **invite-only**: the org-level auto-invite trigger is **not installed**, and
   > people are added by hand. Step 1 above describes the v2 target state, kept
   > because §12.5 still specifies the trigger for the day it is switched on.
   > **Do not build it for v1.**
2. They opt into a module.
3. They type an email address to reach someone. If it belongs to an active member
   of Public Square who also holds that module, they can start a conversation.
4. The other person consents to the conversation before anything reaches them.

### What makes it safe

> **SUPERSEDED IN PART, 2026-09-10.** Fix 1 below is v3's column revoke and is
> **DEAD** (§9.3) — replaced by §12.2. Fixes 2 and 3 are correct but have moved
> to Track A (§12.8). Fixes 4, 5, 6 stand. The table is kept because §9 and §11
> refer to its numbering.

| # | Fix | Scope | Cost | Status 2026-09-10 |
|---|---|---|---|---|
| 1 | **`revoke select (email) on profiles from authenticated`** | ALL orgs | 1 line + ~14 loud app fixes | **DEAD — no-op, §9.3. Replaced by §12.2** |
| 2 | **`module_roles` reads narrow to your own rows** | ALL orgs | 1 policy + 3 app sites | Correct — **Track A owns it** |
| 3 | **Split the `for all` write policies** on `org_members` and `module_roles` so their USING stops granting SELECT | ALL orgs | 2 policies → 6 | Correct — **Track A owns it** |
| 4 | **Peer lookup: org+module-scoped, throttled** | ALL orgs | 1 definer | Stands — §12.4, **throttle has no home yet** |
| 5 | **Per-module review before enabling anything on Public Square** | process | free | Stands — §11.3 sharpens it |
| 6 | **Delegated moderation via module `moderator`, never an org admin seat** | process | free | Stands — §12.7 makes it mandatory, not preferred |

---

## 3. The pieces

### 3.1 Fix 1 — revoke the email column (replaces v2's per-membership preferences)

> **DEAD, 2026-09-10 — DO NOT BUILD THIS.** Its central premise ("column
> privileges on `profiles` are per-column") is false: `authenticated` holds a
> **table-level** SELECT grant, so the revoke is a no-op. Full post-mortem and
> the three reasons the corrected form is also dead: **§9.3**. The replacement
> is **§12.2**. Everything below is kept for the record only, including its
> genuinely useful findings (the three email resolvers, the missing org join on
> `org_find_user_by_email`, the stale-`profiles.email` bug) — those survive the
> mechanism's death and are carried into §12.1 and §8.3.

**The problem, platform-wide:** `profiles_select_shared_org`
(`20260708020000`) is `for select using (shares_org_with(user_id))`. Sharing ANY
org grants read of the WHOLE row — `display_name`, `email`, `settings`,
`is_superadmin`. In an org containing everyone, that is docs/16's P1-1 verbatim.

**The fix:**

```sql
revoke select (email) on public.profiles from authenticated;
-- consider `settings` in the same breath (see §7.5)
```

Verified: column privileges on `profiles` are per-column and `authenticated`
currently holds SELECT on all seven columns. RLS decides ROWS, column grants
decide COLUMNS, and **both must pass** — so this is enforceable in a way no
policy is.

**Why this beats v2's two-boolean design, measured against §0's own criteria:**

- **Universal, no per-org rule** — same.
- **Unforgettable — strictly stronger.** A future author cannot re-expose email
  even by writing `for select using (true)`. v2's own §7.11 admitted "the
  definers must never return `settings`, and nothing enforces that." A column
  grant enforces it.
- **`profiles_select_shared_org` STAYS**, so display names keep working through
  ordinary queries — **which removes 12 of v2's 15 breaking sites**, because what
  those screens need is the name.
- **Every remaining breakage fails LOUDLY** (`permission denied for column
  email`), never silently.
- **Zero new columns, zero backfill, zero new UI, zero trigger edits.**
- **It fixes the stale-email bug for free:** two sites that read the caller's OWN
  email from `profiles` (`apps/web/lib/platform.ts:186`,
  `modules/speed-dating/ui/actions.ts:441`) move to the auth session, which is
  the live value. `profiles.email` is never synced after an auth email change —
  no trigger exists.

**What it sacrifices, honestly:**

1. **No per-relationship granularity.** No member reads any co-member's email
   anywhere. Org admins keep it via the existing `is_org_admin`-gated
   `org_member_profiles`; module managers need the widened definer below.
2. **A user cannot hide their display NAME.** A real sacrifice in a
   stranger-facing space, and the one thing v2's design would have offered.
   FOUNDER DECISION NEEDED — see §6.
3. **The roster census stays** (docs/16 P1-4 accepted, not fixed). On a
   deliberately public square a name list is close to the premise; and fix 2 of
   v2 would not have closed it anyway, because of §3.3.
4. **A new mechanism for this platform** — no table uses column grants today. It
   needs its own prod-ACL check (the documented `ALTER DEFAULT PRIVILEGES`
   divergence is table-level, so re-verify), a docs/03 convention line so nobody
   "fixes" it with a table-level grant, and awareness that any future
   `select('*')` on `profiles` will fail (verified: zero today).

**The definers this requires (v2 named one and missed two):**

- **Widen `org_find_user_by_email`'s gate** from `is_org_admin(check_org_id)` to
  also admit module managers, and **add the missing org join** (§8.4 — today its
  body has NO join between the caller's org and the returned profile, so it is a
  platform-wide email oracle for any org admin). Three email→user resolvers need
  it and only one is in visual messaging:
  `modules/classroom/ui/manage/actions.ts:52`,
  `modules/matchmaking/ui/manage/actions.ts:94`,
  `modules/visual-messaging/ui/actions.ts:169`. A classroom **professor** and a
  matchmaking **admin** are NOT org admins — **v2 repeated its own criticism of
  v1 by covering only the VM case.**
- **One `is_superadmin()`-gated reader** for the four legitimate console email
  surfaces.
- **Matchmaking's bulk-mail lists** (`modules/matchmaking/ui/manage/page.tsx:72-74`)
  are the affirmative answer to v2's owed verification #1: *yes*, one
  member-facing surface does surface co-member email — and it is already
  `mm_can_manage`-gated, so the widened definer serves it.

### 3.2 Fix 2 — `module_roles` reads narrow to self

`module_roles_select_member` is `is_org_member(org_id) OR is_superadmin()`, so
every org member reads EVERY grant row for the org (`user_id, module_key, role,
scope_ref`). **This is a live leak today, independent of Public Square:** in
`demo-match` (6 active members; 4 hold `single`) the policy structurally lets any
org member enumerate the dating pool. In Public Square it is the
who-opted-into-what census, and **two of v1's four reviews found it
independently.**

Narrow to `user_id = auth.uid() OR is_superadmin()`. Three app sites break
(`modules/matchmaking/ui/manage/page.tsx:48,49`, `apps/web/lib/view-as.ts:151`) →
one `module_can_manage`-gated definer.

**Ship this first and standalone** — it is a bug fix that needs none of the rest.

### 3.3 Fix 3 — split the `for all` write policies

**This is the finding that kills the naive version of fix 2, and it bit BOTH v1
and v2:**

```
org_members_write_org_admin  :: ALL :: is_org_admin(org_id)
module_roles_write_org_admin :: ALL :: is_org_admin(org_id)
```

A `for all` policy's USING clause **also governs SELECT** — a lesson this
platform recorded on 2026-08-06. So narrowing either `_select_member` policy
changes nothing for an org admin: they already read the full table through the
write policy's other door. v2 spotted this for `org_members` in §3.7, wrote it up
as a lesson, and **then proposed fix 2 without checking the sibling table.**

Both must become separate `for insert` / `for update` / `for delete` policies so
their USING stops carrying a read arm. Until then, "narrow the roster" and
"narrow the grant census" are both false for anyone holding an admin seat — which
is why §3.5's delegation answer is *module moderator, never org admin*.

### 3.4 Fix 4 — peer lookup

**New definer `find_module_peer(check_org_id, check_module_key, target_email)`:**

- Caller must be an active member of the org AND hold a role in the module.
- Returns a `user_id` only if the target is an active member of the SAME org AND
  holds a role in the SAME module. **Filter the subject on `status = 'active'`**
  — otherwise it enumerates everyone ever auto-invited, before they consented
  (the P1-2 shape, recurring inside a new function).
- Exact match only; no LIKE, no listing.
- **Throttled per caller** — and the counter must increment on EVERY call, not
  only on matches. Counting only hits makes every wrong guess free, which is no
  throttle at all.
- **Returning the display name is now FINE**, because fix 1 leaves names readable
  anyway. v2 suppressed it for no gain and lost the "did you mean Sarah Cohen?"
  confirmation. At this scale, mailing a private picture to a typo'd address is
  likelier than name harvesting.

**Honest limit:** any invite-by-email feature is an existence oracle — you cannot
invite by address without learning the address is registered. This one is bounded
to within an org and module the caller already belongs to. **And the throttle does
not bound someone who creates accounts** (§7.2), so it is a speed bump, not a
control.

### 3.5 Delegated moderation, NOT delegated administration

FOUNDER-RAISED 2026-09-08: *"The public square is large and I may need to delegate
Admins."* The mechanism exists, but `is_org_admin` bundles two unrelated powers:
**moderating content**, and **administering members** (reading the whole roster,
adding and removing anyone — and per §3.3, reading every grant row too).

**Delegate visual messaging's module-level `moderator` role. Never an org admin
seat on Public Square.** That gives org-wide moderation of every conversation
with no roster enumeration and no new mechanism.

Splitting `is_org_admin` properly is a real refactor and is NOT in this design
(§7.4).

### 3.6 Auto-invite at signup

An `auth.users` AFTER INSERT trigger inserting a **pending** Public Square
membership. Shape copied from `capture_login`: **fail-OPEN** — inner
`begin…exception when others → raise warning`, plus a function-scoped
`lock_timeout`. A missed auto-invite is recoverable; a signup outage is not.

**Verified traps, all silent:**

- The trigger runs with **NO JWT**, so `org_members_guard_hierarchy`'s INSERT
  normalization (gated on `auth.uid() is not null`) does not apply. `status`,
  `role` and `invited_by` must ALL be set explicitly.
- **`org_accept_invite()` requires a non-null `invited_by` that is STILL
  authorized** — a superadmin, or an active member outranking the invited role.
  So the trigger must stamp a real account. `invited_by` is `ON DELETE SET NULL`,
  so **deleting that account makes every outstanding invite permanently
  unacceptable**, with an error that misdescribes the cause. And it dies on
  **demotion**, not only deletion.
- This creates a superadmin add path that hardcodes `pending`, **ignoring the
  recorded per-add choice** (`profiles.settings.superadminDefaultAddActive`,
  founder decision 2026-07-27). Record it as a deliberate exception.
- **`orgs.kind` needs a uniqueness constraint.** If the "which org is Public
  Square" lookup ever matches zero or two rows, the fail-open shape means
  auto-invite silently and permanently stops for every future signup, with no
  alert distinguishing broken from quiet. Same family as the swallowed-error
  worker jobs.
- **Ordering:** the backfill for existing users must land AFTER fix 1. **And it
  must insert PENDING seats** — `shares_org_with` requires BOTH sides active, so
  a pending backfill changes nothing, while an active one would break
  `rls.test.ts:53`, `:69`, `:74` and `:95` and open a real window in which
  everyone reads everyone.

### 3.7 Self-service module opt-in — MECHANISM CHANGED

`module_roles` writes require `is_org_admin`, so self-join needs a definer. But
it must not be universally available: in Pozna the admin decides who is a maker.

**v2 put this in `org_modules.settings.selfJoin` and justified it by citing
docs/13's widen/narrow rule. The review found that indefensible on three counts,
and it is correct:**

1. The rule says widening "belongs in **code**" — no actor qualifier — and the
   one worked application in the same table refuses this exact mitigation by
   name: **"No — not even for the superadmin."** The stated reason is not
   trustworthiness; it is that a switch has no diff, no reviewer, no test run and
   no record of reasoning.
2. A prior binding decision names `org_modules.settings` **specifically** as the
   wrong home for a widening declaration.
3. It reintroduces the per-org branch §0 claims to have eliminated — relocated
   from `orgs.kind` to a jsonb key.

**v3: declare self-joinable modules in the module registry (code, in a diff),
beside the view-as edge declarations.** `org_modules.settings` may only ever
**disable** it per-org — the narrowing direction the rule permits. `join_module`
hardcodes the module's lowest-rank role; it never accepts a caller-supplied role.

**Also unresolved:** `join_module` mints a **self-granted** seat, and a recorded
decision requires every grant to carry `granted_by` with system grants rendered
highlighted in a review queue until a human confirms. A self-join is neither
human-granted nor system-granted. Needs a third marker or an explicit exemption.

---

## 4. What was MEASURED (live catalog)

- **168 module policies; TEN grant on plain org membership** — 3 nail-salon, 6
  synagogue tables, 1 synagogue storage policy. visual-messaging, matchmaking,
  classroom, speed-dating: **zero**. Re-derived independently three times.
- **12 of 14 module predicate functions** using `is_org_member` conjoin it with a
  module-role check. The two that do not, both directly-callable RPCs:
  `sal_worker_has_time_off`, `sd_side_registered_count`.
- **Seven non-module surfaces grant on plain membership:** `profiles` (via
  `shares_org_with`), `org_members`, `org_modules`, `orgs`, `module_roles`,
  `module_scope_nodes`, `job_requests`. v3's fixes 1–3 address `profiles` and
  `module_roles`; `org_members`' census is accepted (§3.1 sacrifice 3).
  `module_scope_nodes` and `job_requests` become per-module review items.
- **Superadmin surfaces ARE affected by fix 1 — corrected 2026-09-09, and this
  is the biggest open question about it.** An earlier draft of this section said
  "unaffected," reasoning that `profiles_select_own` is
  `user_id = auth.uid() OR is_superadmin()`, a separate policy arm. **That
  reasoning is wrong, and wrong in the way that matters: a column privilege is
  per-ROLE, not per-row.** A signed-in superadmin is still the `authenticated`
  role, so revoking `select (email)` from `authenticated` takes email away from
  the superadmin too — RLS row arms cannot restore a column privilege the role
  does not hold. **So the console, data browser, view-as and engagement pages all
  break unless their email reads move to a SECURITY DEFINER function** (which
  runs as the function owner and is not bound by the caller's column grants).
  That definer is named in §3.1 and is NOT optional garnish; it is what keeps the
  Owner Console working. Sent for independent verification.
  **RESOLVED 2026-09-10 — this bullet is RIGHT about column privileges and MOOT
  about v4.** Per-ROLE-not-per-row is exactly correct, and it is one of the three
  reasons v3 is dead (§9.3). **But v4 touches no grant at all**, so its row arms
  are the whole story: `profiles_select_own` is PERMISSIVE and OR-ed, and the
  superadmin keeps every column of every row. Verified per-surface across ten
  console read sites in §11.5. **Keep the lesson, drop the alarm** — and note
  the general rule it yields: *a row policy can be overridden by another
  permissive policy; a column privilege cannot be restored by any policy.* That
  asymmetry is the reason v4 is a policy change and not a grant change.
- ~~**`profiles` column privileges are per-column**, all seven currently granted
  to `authenticated` — the mechanism fix 1 depends on.~~ **FALSE. VERIFIED 2026-09-10:
  `pg_class.relacl` shows `authenticated=ard`, a TABLE-level grant.** The seven
  rows this claim rests on came from `information_schema.column_privileges`,
  which expands a table grant into one synthetic row per column. §9.3. This
  single mis-read is what v3 was built on.
- **`org_members` has table-wide UPDATE for `authenticated` on every column**,
  unlike `profiles` (locked to `display_name`, `settings` in July). This is why
  v2's per-membership consent flags would have been **admin-writable for anyone's
  row** — any org admin could bulk-set the org to "share email." v3 has no such
  columns.
- **Platform scale: 8 orgs, 28 memberships, 11 local users** (~12 prod). Every
  scale concern is schedule-don't-discover.

---

## 5. Build order

**REWRITTEN 2026-09-10 for v4 and the Track A split (§12.8).**

0. **Track A, already in flight, not this document's work:** `module_roles`
   narrowing + the `for all` split (old fixes 2 and 3), docs/19's seat-authority
   fix, the `vm_layers` cascade (§8.1), self-block (§8.7). **Nothing below
   depends on them landing first** — but §12.2 must be re-measured against the
   post-Track-A schema, because every measurement in §11 predates it.
1. **§12.2 — `orgs.kind` + the uniqueness index + the one conjunct.** One
   migration. **No app changes at all in client orgs** (§11.1), which is the
   whole argument for this shape over v3's ~14 forced ports.
2. **§12.4 — `find_module_peer`, and the throttle table it needs and does not
   have.** One migration + the app change that replaces
   `visual-messaging/ui/actions.ts:169`'s direct `profiles` lookup. **These two
   must land together**, or `addMember` is broken inside Public Square (§11.2).
3. **Public Square itself** — the org row, dashboard rendering, the
   registry-declared self-join (§3.7, whose `granted_by` question is still open).
4. ~~**§12.5 — the auto-invite trigger and the PENDING backfill.**~~ **OUT OF
   SCOPE FOR v1 — §13.4 WAS answered (a), invite-only, on 2026-09-11 (§16.3).**
   The trigger is not built and not installed. §12.5's three verified traps stay
   on the page for whenever the switch is turned on; they are not v1 work.
5. **The tests in §12.6**, which are the deliverable and not a follow-up: no
   existing ratchet covers `profiles`, and **e2e gives zero coverage of this
   change** (§11.5).

**v1 wrongly claimed docs/19's fix was a prerequisite** — verified false, and
still false: it touches matchmaking/speed-dating/salon/classroom rosters and
nothing here builds on those.

### The test that matters most

**A two-stranger leak test.** Seed a Public Square org; sign in as a user who
shares ONLY that org with the target; **assert ZERO rows on every table
enumerated from `pg_catalog`**, with the target's conversation partner reading
>0 rows as the non-emptiness control. It catches ANY leak mechanism — policy,
definer, column grant, new table — rather than one textual pattern.

**This is also the first mechanism on the platform that would cover the seven
core tables at all**: the two existing ratchets derive their scope from module
prefixes, so `profiles` / `org_members` / `module_roles` are structurally outside
both.

**Fixture warning:** in an org containing everyone, every seeded user is a member
by construction, so "outsider" must be redefined — here it means *shares the org,
holds no seat and no module role*.

---

## 6. FOUNDER DECISIONS

**Recorded:**

1. Public Square is an ordinary org, not a special class (09-08).
2. Fix the general case, never a per-org rule (09-08) — §0.
3. Auto-invite at signup, pending until accepted (09-08).
4. Two consents: join the space, then join each module (09-08).
5. Profile sharing should be the user's choice (09-08). ~~**PARTLY SUPERSEDED by
   v3's mechanism**~~ — **NOT superseded. CORRECTED 2026-09-11: DEFERRED, and
   sequenced AFTER v4 (§20). It is being built; v4 simply ships first.** The
   "partly superseded" marking was wrong and had been standing since v3, which is
   itself dead. The slice needs its own tracked entry — a decision deferred
   inside a completed item is how this repo has lost open state before.
6. Delegated moderation is wanted (09-08) — §3.5.
7. Superadmin access required; disclosure in the privacy policy only,
   impersonally worded (09-06/08).
8. 30-day expiry on any email invite to a non-user (09-04). **See §7.7 — v3 has
   no such flow, so this decision is currently orphaned.**
9. Deleted users' content STAYS; author detached, marked departed (09-08) — §8.1.

**OPEN, and it is the one v3 needs answered:**

**Decision 5 asked for user-controlled sharing. v3 delivers "nobody reads anyone's
email, everybody's name is visible."** That is simpler and enforceable, but it is
not a choice — and it means a user in a stranger-facing space cannot hide their
display name. Three options:

- **(a) Ship v3 as-is.** Names public within an org, emails private everywhere.
  One line, no UI. Recommended.
- **(b) v3 plus a name-hiding option later**, if a real person asks. Adds the
  preferences surface back, but only for `display_name`, and only once wanted.
- **(c) v2's full per-membership choice.** Reviewed and found disproportionate.

**Also open, and unavoidable before launch:** §7.2.

---

## 7. KNOWN OPEN

1. **Superadmin access has no surface, bound, or log.** The module home selects
   every conversation in the org with no limit, so
   `/o/<direct>/m/visual-messaging` becomes an unpaginated list of every private
   conversation on the platform, on the page members use. The narrower data
   browser and console view-as ARE logged. **Counter-argument recorded: logging
   was deliberately omitted because it would surface the platform owner's
   activity to org admins** — which bites harder here, since §3.5 delegates
   moderation. The recorded revisit trigger was "a second superadmin or an
   external audit"; whether launching a public community is a third is unanswered.
2. **Open self-signup makes this internet-facing, with no abuse primitive.**
   Anyone can create an account today, which currently grants nothing.
   Afterwards every signup can accept into Public Square and start inviting, and
   per-caller throttles do not bound someone who creates accounts. docs/16 P1-6
   asked for a user-level ban, rate limits, an abuse-report path that is not
   per-conversation, and *"a written acknowledgment that Public Square means
   operating a public community, with the ongoing cost that implies."* **None of
   that is in this design, and no fix in §2 touches it. FOUNDER DECISION, and it
   is genuinely blocking.**
3. **Admins still read member emails** (`org_member_profiles`, `is_org_admin`-gated)
   regardless of fix 1. Deliberate — administration needs it — but the privacy
   copy must not overclaim.
4. **Splitting `is_org_admin`** into moderation vs. member administration (§3.5).
5. **`profiles.settings` is readable by every org-mate.** Fix 1 should revoke
   `select (settings)` in the same migration. Today it holds one console
   preference, so nothing sensitive — but it is the same hole and the same
   one-line fix. (Note this parked item lives only in CLAUDE.md and docs/17; it
   was never folded into the canonical user-model doc.)
6. **§0's "nothing branches per-org" is no longer claimed.** v3's registry-declared
   self-join keeps the *decision* in code, but `org_modules.settings` may still
   disable it per-org — a narrowing branch, which the rule permits. Stated rather
   than hidden.
7. **The no-account invite flow is GONE and nobody decided that.** v1 and the
   2026-09-04 design both had `vm_pending_invites` + a signup-time resolver +
   a pruner + a four-state honesty UI, to invite someone with no account.
   **Under v3 the answer is "tell them to sign up like anyone else"** — which is
   simpler and may be right, but it is a product change, it orphans founder
   decision 8, and it silently drops the two recorded privacy obligations about
   holding a non-user's email address. **Decide it explicitly.**
8. **Leaving Public Square is permanent.** Verified: `org_members` INSERT needs
   `is_org_admin`/superadmin, `org_accept_invite` needs a pre-existing pending
   row, and the trigger fires only on `auth.users` INSERT. **Cheap answer: at
   this scale the founder re-invites manually.** The recorded alternative
   (org-level request-to-join) is defined as `orgs.kind`-gated, so it would have
   to be re-derived as a general fix, not inherited.
9. **Per-module review before enabling anything on Public Square.** Not a
   blanket safe-list. Matchmaking auto-scores every pair holding the `single`
   role and its staff policies expose every opted-in single's dossier to that
   org's admins; classroom staff authority is org-wide, so one class's professor
   would read every class's submissions. Both fine in Pozna, wrong in public.
10. **The unbuilt module-defaults slice would silently reverse per-module
    opt-in** — it auto-grants visual messaging `member` on member-join AND
    backfills on module-enable (founder-confirmed 2026-07-20). **Worse: it also
    destroys fix 4's bound**, since `find_module_peer` filters on "holds the
    module" and everyone would. **Record the exception in that doc now, and treat
    it as a build prerequisite, not a known-open.**
11. **Pending seats have no notification surface.** There is no email or
    notification code anywhere in `apps/`, and the dashboard invite card reads
    org invites only. Custom SMTP is an open pre-launch item.
12. **Console fan-out at scale.** The console reads all orgs, members,
    entitlements, profiles and module_roles in one shot and renders a members
    panel per org; several helpers build `.in(...)` lists from full rosters.
    Nothing leaks; nothing matters at 11 users.
13. **Naming.** Never the word "Public" on a container holding private threads.
    The chat surface is **"Direct."** But the dashboard card renders `orgs.name`,
    the module tile renders the registry's GLOBAL module name, and the org slug
    is in every URL and documented as permanent. The literal `name` and `slug`,
    and whether the tile gets a per-org label, are unresolved.
14. **The two identity questions the reviews raised and v3 does not answer:**
    does the conversation-name definer resolve someone who has LEFT (their layers
    remain, so something must render beside them), and what does an expanded
    professor-facing data browser show once identity moves partly behind
    definers — its recorded contract is *"bounded by RLS and nothing else."*

---

## 8. LIVE BUGS FOUND ALONG THE WAY — real today, independent of this design

1. **Deleting a user destroys other people's drawings.** Verified:
   `vm_layers.author_id → auth.users ON DELETE CASCADE` **and**
   `parent_layer_id → vm_layers ON DELETE CASCADE`. Deleting a user removes their
   layers *and every descendant layer drawn by anyone else*. Deleting a
   conversation's creator removes the ROOT and cascades the whole thread, leaving
   a conversation row with zero layers — the page's `if (!root) notFound()` then
   gives the OTHER party a bare 404 on their own conversation. **There is no
   product deletion flow at all** (`deleteUser` appears only in `rls.test.ts`),
   while `/privacy:41` promises deletion on request — a landmine that fires the
   first time that promise is kept. **FOUNDER DECISION 2026-09-08: content stays,
   author detached, marked departed.** Requires making `author_id` nullable.
2. **The sole conversation admin can leave and orphan the conversation.**
   `vm_pin_member`'s last-admin-standing check is BEFORE UPDATE only; there is no
   DELETE guard and `vm_members_delete_self` permits the self-DELETE. **Founder's
   model 2026-09-08: transfer adminship before leaving, as Google Docs requires.**
   Makes module-4's parked "conversation-admin transfer" load-bearing. In a 1:1
   the only transferee is the other person, so the alternatives are
   transfer-to-them or leaving deletes the conversation.
3. **`org_find_user_by_email` has no org join on `profiles`** — its body is
   `where is_org_admin(check_org_id) and p.email = target_email`, so an admin of
   ANY org can probe any address platform-wide and get a display name. Bounded
   today only by there being few admins. **A one-line `kind = 'client'` conjunct
   was proposed in v1 and is WRONG** — it would break the lookup it guards. Fix
   it as part of §3.1's widening: add the org join.
4. **`module_roles_select_member` leaks the module-role census** (§3.2) — live in
   `demo-match` today.
5. **Invite edge cases surface as raw duplicate-key errors.** `addMember` does a
   bare INSERT against `UNIQUE (conversation_id, user_id)`: inviting yourself,
   two people inviting the same person, or inviting someone who self-banned all
   produce "duplicate key" — and the last **leaks that the person has a row.**
6. **Leaving does not make everything inert.** `vm_conversations_select` is
   `created_by = auth.uid() OR vm_is_conv_member(id)` — only the second arm got
   the org-membership conjunct, so a departed creator still reads the conversation
   ROW via PostgREST. Recorded as a deliberate remainder in `20260904010000`.
7. **Self-block is still owed and was queued to THIS build.** `vm_pin_member`'s
   self-service branch pins `new.status := old.status`, so you cannot self-ban —
   a conversation admin can re-add you indefinitely. Permitting a self-UPDATE to
   `status='banned'` only is the cheapest real abuse mitigation available, and
   there is no user-level ban anywhere on the platform. **v1 and v2 both dropped
   it; it is the cheapest thing in this document and the easiest to lose again.**

---

## 9. WHAT v1 AND v2 GOT WRONG — so neither is rebuilt

### v1 (shared org + five `orgs.kind` guards) — abandoned

- **Its central guard was circular.** Excluding network orgs from
  `profiles_select_shared_org` broke the invite lookup that depends on that
  policy, so every invite would fail — and the fix required a platform-wide email
  lookup, i.e. it **relocated the leak instead of removing it.** The in-session
  claim that the shared org was "strictly more private than per-pair" was
  withdrawn.
- Named five core tables, guarded two; the real number is seven.
- **`module_roles` unguarded** — the census verbatim, and populated by v1's own
  opt-in mechanism.
- **Guard 3 bypassable** by the `for all` USING (§3.3).
- **Self-contradicted** on whether members were `pending` or `active`, in the one
  place the design turned on.
- Guard 5 ("per-module opt-in") **was not a guard** — always true by construction.
- Invite caps **unbuildable as specified** (settings cannot hold a daily counter
  that survives deleting the row).
- Its proposed ratchet would have been **vacuous** (§5).
- **Wrongly claimed docs/19's fix was a prerequisite.** An asserted dependency is
  not a checked one.

### v2 (per-membership sharing preferences) — mechanism replaced

- **Cost understated 7×.** Claimed 2 member-facing breakages; the real count is
  **15** across four modules — 3 hard failures, 12 silent, and one that would
  **silently ship blank contact details** in speed-dating's contact-share.
- **Repeated v1's own mistake:** its replacement lookup covered visual messaging
  and left classroom's and matchmaking's resolvers broken, because a professor and
  a matchmaking admin are not org admins.
- **Its consent flags would have been admin-writable** — `org_members` has
  table-wide UPDATE for `authenticated`, so any org admin could bulk-set the org
  to "share email." "The user's choice" would not have been the user's.
- **The choice was stamped by the inviter**, not chosen by the subject.
- **Needed an uncosted carve-out in `org_members_guard_hierarchy`** — the
  platform's consent-and-rank trigger, the highest-risk edit available — because
  no policy grants a member UPDATE on their own membership row and the rank
  ladder blocks it anyway.
- **Made the same `for all` mistake it had just documented** (§3.3).
- **Cited docs/13's widen/narrow rule to justify a mitigation that rule refuses
  by name** (§3.7).
- **Claimed to close a recorded open item it did not close.** That item's rule is
  *hierarchy* narrowing; v2 backfilled `share_name = true` everywhere, so the
  rank-0 customer still read the rank-3 admin's name. It substituted an orthogonal
  rule and took the credit.
- **Presented a twice-declined question as fresh.** The founder was offered this
  narrowing on 2026-08-09 and again 2026-08-10 and both times chose not to
  decide, with the recorded lean being *leave as is* — in an entry whose stated
  purpose is that the trade-off "doesn't need re-deriving next time it comes up."
  **In v2's favour:** the consent axis genuinely resolves the tension that
  blocked the rank axis, and sidesteps the *unranked-is-not-rank-0* trap. That
  should have been argued, not omitted.

### The structural lesson, stated once

Across three designs the same failure recurred: **the author checked the
mechanism they were thinking about and not its siblings.** v1 checked
`org_members` and not `module_roles`. v2 documented the `for all` trap and then
walked into it. Both measured carefully in one place and from memory in another.
**That is what the reviews keep catching, and it is the argument for running them
before building rather than after.**

---

## 9.3 v3 (column-level revoke of `profiles.email`) — DEAD, killed by a live check

v3's entire design rested on one sentence: *"column privileges on `profiles` are
per-column and `authenticated` currently holds SELECT on all seven columns."*
**That sentence is false, and the check that produced it was the wrong check.**

**VERIFIED LIVE 2026-09-10:**

```
select relname, relacl from pg_class
 where relname='profiles' and relnamespace='public'::regnamespace;
-- profiles|{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres,authenticated=ard/postgres}
```

`authenticated=ard` is a **TABLE-level** grant: `a`=INSERT, `r`=SELECT,
`d`=DELETE. Postgres does not subtract a column privilege from a table
privilege — a table-level SELECT is SELECT on every column, present and future.
So `revoke select (email) on profiles from authenticated` is a **NO-OP**. v3's
one-line fix does nothing at all.

**Why the author believed otherwise:** they read
`information_schema.column_privileges`, which *expands* a table-level grant into
one synthetic row per column. Seven rows appeared and were read as seven
independent column grants. **Read `pg_catalog`, never `information_schema`** —
this is the third design in a row killed by verifying the wrong object.

**The corrected form is also dead**, on three independent counts:

1. It is no longer one line. It is `revoke select on profiles from
   authenticated;` followed by a column allowlist (`grant select (user_id,
   display_name, is_superadmin, created_at, updated_at) ...`) that every future
   column must be added to, silently failing closed if anyone forgets.
2. **It breaks `scripts/verify-acl-hardening.ts`** (VERIFIED: line 56 declares
   `profiles: ['SELECT','INSERT','DELETE']` as `authenticated`'s expected
   table-level set, asserted through `has_table_privilege`). That verifier is
   one of the platform's two ACL ratchets.
3. **Its superadmin remedy is machine-forbidden.** A column privilege is
   per-ROLE, not per-row: a signed-in superadmin is still `authenticated`, so
   the Owner Console loses email too, and v3's answer was a SECURITY DEFINER on
   the console read path. A source scan in `rls.test.ts` forbids exactly that.

**And docs/17:163-167 had already rejected column grants a month earlier**, with
a live demonstration. v3 re-derived a settled question and got it wrong.

**One correction in v3's favour, also verified, which does NOT save it:** v3's
§3.1 sacrifice 4 claims *"a new mechanism for this platform — no table uses
column grants today."* False, and on the same table:

```
select attname, attacl from pg_attribute
 where attrelid='public.profiles'::regclass and attacl is not null;
-- display_name|{authenticated=w/postgres}
-- settings    |{authenticated=w/postgres}
```

`profiles` already carries column-level **UPDATE** grants. The mechanism is not
new to this platform. It is simply not usable for SELECT here, for reasons 1-3.

---

## 10. DOCS THAT BECOME STALE IF THIS SHIPS (written for v3; still accurate for v4 except where noted in §12)

- **docs/16** — its 2026-09-04 update block says ad-hoc groups took the per-pair
  route and need none of items 1–3, and that `orgs.kind` is UX-only. Its
  checklist's "none made yet" is false. Its **P3** ("a network module gets its
  own org, NOT Public Square") must be reconciled with §7.9's per-module-review
  answer. **v3 answers its formally-blocking checklist item 2** — worth stating.
- **docs/modules/module-4-visual-messaging.md** — needs a superseding dated entry
  (its own precedent, not an in-place edit). The "SHAPE DECIDED 2026-09-04"
  section, the `client | personal` enum, `create_personal_org`, and "accept-first
  needs NO new mechanism" all change. **Its self-block item must be carried
  forward, not lost** (§8.7).
- **docs/04-build-plan.md:68** — every clause but the 30-day expiry is wrong, and
  that one is now orphaned (§7.7).
- **CLAUDE.md** — six places, including a pointer sending the next session to a
  superseded entry.
- **docs/15-user-model.md** — several, and one is subtle: its claim that the model
  absorbs Public Square *"with no special casing (an org where VM's default grant
  is global member)"* **names as its mechanism the very default v3 must suppress**
  (§7.10). Absorption holds at the policy layer and fails at the defaults layer;
  the parenthetical must be rewritten, not just marked true. Also: §7's defaults
  table needs the exception; the deferred request-to-join note is defined as
  `orgs.kind`-gated (§7.8); the twice-declined profile question must be closed
  with a dated pointer rather than left open beside its own answer; and the
  `profiles.settings` parked item should be folded in (§7.5).
- **docs/13-future-ideas.md** — its per-position visibility map assumes *"keep RLS
  as the authority"* and *"it cannot drift (the tests fail)."* Fix 1 moves email
  behind a **column grant** and a definer, so the map needs extending from
  policies to column privileges and definer return sets. Credit where due: §5's
  two-stranger test is the first mechanism that satisfies the map's
  cannot-drift goal for the core tables.
- **docs/12-safeguards.md item 6** — a FOURTH owed privacy line joins the three
  tracked, and §3.8's impersonal wording is its text. If §7.7 keeps the
  no-account flow dropped, the two non-user obligations come OFF the list — say
  which.
- **docs/03** — §0's corrected principle deserves a convention entry; column-level
  grants need a line so nobody "fixes" them with a table-level grant; and the
  two-stranger leak test joins the two existing catalog-driven ratchets.

### 10.1 Owed edits to docs/03 and CLAUDE.md — RECORDED HERE, NOT MADE

Track A owns those files while both sessions run, so these are written down
rather than applied. **None of them should land until §14's review clears v4.**

**docs/03 — four convention lines, three of which are already earned regardless
of whether v4 ships:**

1. **Read `pg_catalog`, never `information_schema`, for any privilege or policy
   claim.** `information_schema.column_privileges` expands a TABLE grant into one
   synthetic row per column, which reads as per-column grants and is how v3 died
   (§9.3). The check that settles it is `pg_class.relacl` plus
   `pg_attribute.attacl`. This belongs beside the existing convention #1 about
   stating the full intended ACL, because it is the same family: *the catalog you
   query determines the answer you get.*
2. **A row policy and a column privilege are not interchangeable.** A permissive
   row policy can be widened by another permissive policy; a column privilege is
   per-ROLE and cannot be restored by any policy — so revoking from
   `authenticated` also revokes from a signed-in superadmin. This is the general
   rule behind §12.3 and it is worth stating once, in code-facing terms.
3. **When excluding a class of rows by an enum-ish attribute, name the EXCLUDED
   value, never the included one** (§12.2's polarity rule), and pin the value set
   with a CHECK constraint so the set cannot grow without a migration whose author
   must revisit the predicate. Generalises beyond this design.
4. **A negative RLS assertion can be over-determined, not just vacuous** —
   §11.5's `rls.test.ts:367` case. The existing vacuity rule covers "passes
   because the subject does not exist"; this is the sibling, "passes for a
   different reason than the one it was written to prove." Add it to the same
   test-discipline section.

**CLAUDE.md — six places docs/20 §10 already names, plus two new:**

5. The "Next / open" entry for **PARKED item (a)** — *should
   `profiles_select_shared_org` be hierarchy-narrowed?* — should gain a pointer to
   this document. v4 narrows that exact policy on a different axis (org kind, not
   rank), so whoever picks up the rank question next needs to know the policy has
   moved. **The two are independent and neither closes the other** — §9 records
   that v2 was caught claiming otherwise.
6. The **LATENT BUG** entry about `profiles.email` never syncing after an auth
   email change is now **load-bearing for this design, not latent.** §12.4's
   `find_module_peer` is an email→user lookup, and it would read stale
   `profiles.email`. CLAUDE.md's own instruction there — *pick ONE source of
   truth deliberately* — has to be answered before `find_module_peer` is written,
   not after. Add that to §12.4's prerequisites when the review clears.

---

## 11. THE REGRESSION REVIEW — RUN 2026-09-10, COMPLETE

Two narrow agents, scoped deliberately so they would finish where three previous
attempts died on session limits. Both were constrained to read-only `pg_catalog`
queries and forbidden to run tests, reset or seed. **The change put to them was
v4's, stated in §12.**

### 11.1 Q1 — regression in the six shipped modules: **SAFE**

Every module reads `public.profiles` as an **unfiltered bulk fetch** that is
then joined client-side to user ids drawn from the *current org's* module rows.
Excluding Public-Square-only co-members from the readable set removes exactly
the users who are unreadable today — Public Square does not exist yet — and
removes nobody who is an active member of a client org.

**The falsification attempts that make this credible.** The instruction was to
break the claim, not to confirm it:

- **Blast radius.** `shares_org_with` is referenced by **exactly one** policy in
  the entire database (`profiles_select_shared_org`) and by **zero** functions —
  scanned across `pg_policies` and `pg_proc.prosrc`. The one module policy whose
  `qual` matched `%profiles%` (`sal_worker_time_off_select`) references
  `sal_worker_profiles`, a module-owned table, not `public.profiles`.
  **v2 asserted this from memory. It is now measured.**
- **Definer bypass.** `mm_mutual_matches`, `org_member_profiles`,
  `org_find_user_by_email`, `is_superadmin` and `handle_new_user` all read
  `profiles` as SECURITY DEFINER and bypass RLS entirely — unaffected. So
  matchmaking's mutual-match reveal, the one place a co-member's email is
  deliberately surfaced to another member, does not move at all.
- **PostgREST embeds: `grep -rn "profiles!" modules/ apps/` returns ZERO hits.**
  Nothing anywhere embeds `profiles` as a related resource, so there is no
  parent-row set that could silently shrink because an embedded profile became
  unreadable. This was the highest-risk silent failure mode and it does not
  exist in this codebase.
- **Departed and pending members.** `shares_org_with` already requires
  `status='active'` on **both** sides, so a departed author's profile is
  invisible **today** and already renders the existing fallback. v4 does not
  regress this — it *prevents Public Square from silently un-hiding it*.
- **Ids arriving from non-roster columns**, checked individually:
  `vm_layers.author_id`, `vm_flags.reporter_user_id`, `sd_notes.about_user_id`,
  `sd_matches.participant_*_id`, `cls_class_members.user_id`,
  `mm_pair_scores.user_a/user_b`. All resolve to users who are or were members
  of the same client org. None can reach a user whose only tie to the caller is
  Public Square.
- **Two modules read no profile rows at all.** nail-salon renders names
  exclusively from `sal_worker_profiles` / `sal_customers` (module-owned
  columns, verified live); synagogue-schedules renders no person names anywhere.

### 11.2 Q2 — what breaks INSIDE Public Square (visual messaging)

| Site | Today | After | Severity |
|---|---|---|---|
| `conversations/[id]/page.tsx:253` current-layer byline | author name | `Someone` | Medium |
| `:274` to `layer-grid.tsx:181` tree tiles | author name | `Someone` on every tile | Medium |
| `:348` children list "by X, N replies" | author name | `Someone` | Medium |
| `:406` flag "reported by X" (moderator-only) | reporter name | `Someone` | **HIGH** — moderation triage cannot tell repeat or malicious reporters apart |
| `actions.ts:169` `addMember` email lookup | resolves the invitee | throws *"No user with that email in your organization"* **for a legitimate co-member** | **HIGH, functional break** |

The caller's own name still resolves via `profiles_select_own`. VM has no member
roster and no avatars or initials — names are plain text only — so this list is
complete for VM.

**`addMember` is v1's named flaw reproduced exactly, and §12.4 is its fix.** The
flaw is real; it is confined to Public Square; and the peer-lookup definer that
repairs it is something this design needs anyway. That is the whole reason v4 is
not simply v1 again.

### 11.3 Forward-looking — other modules, if ever enabled on Public Square

Feeds §7.9's per-module review. **speed-dating is the dangerous one:**
`actions.ts:349-372` writes `contact_shared` as a **permanent jsonb snapshot**,
and the `pending` filter at `:340` skips any match whose `contact_shared` is
non-empty. A reveal would therefore write `{displayName: null, email: null}`
**once, irreversibly, and never retry** — a mutual match that reveals nothing,
forever. classroom would render bare UUIDs as student labels and
`enrollClassMember` would fail outright. matchmaking degrades to `'A match'` but
its reveal still works (definer). nail-salon and synagogue-schedules are
unaffected.

### 11.4 The implementation hazard the review found

**VERIFIED LIVE: `public.orgs` has columns `id, name, slug, settings,
created_at, updated_at`. There is no `kind` column.** v1 through v3 all assumed
one would exist because module-4's ad-hoc-groups work was expected to build it;
that work has not landed. v4 must introduce it, and **the polarity of the
predicate matters** — §12.2.

---


### 11.5 The platform-layer review — `apps/web`, `packages/`, tests

Run as a separate narrow agent, same read-only constraints.

**Q1 — the "one policy, zero functions" claim: CONFIRMED, with a control.**
`pg_proc.prosrc ilike '%shares_org_with%'` returns **zero rows across all
schemas**; the control (`'%org_members%'` → 10 functions, and
`proname='shares_org_with'` → 1 row) proves the empty result is a real absence
rather than a broken query. `pg_policies` with no schema filter returns exactly
one row. `pg_views` returns zero (vacuous — there are no views in `public` at
all — but moot). The only other repo hits are **comments**, in nine files.

**But the claim understates the blast radius, and this is the useful part:**
every un-annotated `.from('profiles')` in app code is an *implicit* consumer,
and there are 13 of them. Grepping the function name does not find them. That
is the real dependency surface, and §11.1 plus the table below are what actually
cover it.

**Q2 — the Owner Console: UNTOUCHED, verified per-surface.** Ten superadmin and
org-admin read sites all resolve through either `profiles_select_own`'s
`is_superadmin()` arm or a SECURITY DEFINER that bypasses policies entirely.
`requireSuperadmin` itself reads only `user_id = auth.uid()`.

**CORRECTION TO §12.3, found by this review and not by the design.** Two
`apps/web` sites depend on `shares_org_with` **as an ordinary member, not as a
superadmin**, so "the Owner Console is untouched" is true but is not the same
claim as "`apps/web` is untouched":

| site | reads | caller | after |
|---|---|---|---|
| `apps/web/lib/view-as.ts:170` | `display_name` of module_roles holders | ordinary org member holding module grants | falls back to `'Unnamed member'` |
| `apps/web/components/view-as/page.tsx:110` | the target's `display_name` | org member, mode-2 view-as | falls back to `'that member'` |

This is the **in-module** view-as path, whose own comment at
`view-as/page.tsx:101` says the Owner Console's edge-bypassing authority is
deliberately not reachable from there. It **degrades, it does not error** (both
use `?? []` / `||` fallbacks), and it only bites if Public Square ever enables a
module with view-as declared. Recorded rather than waved away: it is the one
non-superadmin dependency on this policy in `apps/web`.

**Q2's second finding, and it is the most consequential thing either review
produced.** Two SECURITY DEFINER functions return `profiles.email`, are granted
to `authenticated`, and are gated only on `is_org_admin(check_org_id)`:
`org_member_profiles(org_id)` and `org_find_user_by_email(org_id, email)`.
`is_org_admin` is *superadmin OR an active owner/admin of that org*. Therefore:

> **Any org admin of Public Square can enumerate every platform user's name and
> email, regardless of v4.** For those accounts the profiles change is
> cosmetic.

Combined with the `org_member_profiles` `status` gap in §12.7 — it has no
`status` filter, so it also returns people who never consented — **§3.5 is not a
preference, it is a requirement: Public Square gets NO org admin seat other than
the founder's superadmin.** If that is ever relaxed, v4's central fix is void
for whoever holds the seat. (A third definer, `mm_mutual_matches`, also returns
email, but requires mutual `mm_interests` in that org — reachable only if
matchmaking is enabled there, which §7.9 already forbids without review.)

**Q3 — the test suite.** No existing assertion changes result today, because no
Public Square org exists in the seed. Three things worth carrying:

1. **`rls.test.ts:97`** (`bob` reads only his own email) is the natural home for
   the new coverage: it passes today because bob shares no org, and **would fail
   without v4 once Public Square is seeded**.
2. **`rls.test.ts:367` becomes OVER-DETERMINED once Public Square is seeded.**
   It asserts `.not.toContain('orgtest@demo.local')` to prove the *active-only*
   gate on `shares_org_with`. After v4 the Public-Square exclusion satisfies it
   independently, so **the active-only regression it exists to catch stops being
   detectable.** This is the vacuity rule in a new form — a test that keeps
   passing for a reason other than the one it was written for. It needs a second
   assertion pinned to an ordinary org, or it silently stops guarding.
3. **`rls.test.ts:2506-2536` asserts that no RLS policy anywhere consults
   `org_modules`.** So keying the exclusion on entitlement or `org_modules`
   would FAIL the build. **This independently validates §12.2's choice of an
   `orgs` attribute** — arrived at for a different reason (write-authority), and
   the catalog agrees.

**And: e2e gives ZERO coverage of this change.** The members-page specs are
definer-backed, so they pass either way. `view-as-coverage.test.ts` enumerates
**module-prefixed tables only** — `profiles` never appears in it. Both existing
ratchets are structurally blind here, which is exactly why §12.6's two-stranger
test is the deliverable and not a nice-to-have.

**Q4 — the sibling surfaces, and a correction to this document's own count.**
Sweeping `qual ilike '%is_org_member%'` returns **eight** non-module tables, not
six. Two do not leak reads and were wrongly counted on the reviewer's own first
pass, then corrected by the catalog: `activity_events`' SELECT is
`is_superadmin()` only (its `is_org_member` sits in the INSERT `with_check`),
and `view_as_sessions`' SELECT is `actor_user_id = auth.uid() OR
is_org_admin(org_id)`. **So §4's "seven non-module surfaces" is right, by a
different route.**

| table | what a Public Square stranger reads | as bad as the profiles leak? |
|---|---|---|
| `org_members` | every platform user's `user_id`, role, status, `invited_by`, `invited_at`, `accepted_at` | **PARTLY.** No email or name (verified: no such column), but it is a complete platform-wide **user census** and a join key. v4 breaks UUID→identity; anyone with another UUID→identity path re-links it |
| `module_roles` | within PS: every `user_id`, `role`, `module_key`, `scope_ref`, `granted_by` | **PARTLY** — a role census keyed by UUID, joinable to the above. **Track A's fix closes it** |
| `job_requests` | `kind`, `payload` jsonb, `result` jsonb, `error`, `requested_by` for every PS job | **POTENTIALLY YES — highest-uncertainty item in either review.** `payload`/`result` are schema-unconstrained; if any PS-enabled module ever enqueues a job containing an email or a name, every PS member reads it. Cannot be ruled out by inspection |
| `orgs` | PS's `name`, `slug`, `settings` jsonb | no — but `orgs.settings` is member-readable, the same trap as the known `profiles.settings` one. Nothing per-person goes there |
| `org_modules` | `module_key`, `enabled`, `settings` jsonb | no — same `settings` caution |
| `module_scope_nodes` | scope-node `name`, `node_type`, `path` | no — caution only if node names are person-named |

**`job_requests` is new and is now a build prerequisite for §7.9's per-module
review**: before any module is enabled on Public Square, its job payloads must
be inspected for personal data. Nothing constrains that jsonb today.

**The `FOR ALL` trap, checked deliberately rather than assumed.** Six policies
are `cmd=ALL` and their USING therefore also governs SELECT:
`org_members_write_org_admin`, `module_roles_write_org_admin`,
`module_scope_nodes_write_org_admin`, `org_modules_write_superadmin`,
`module_roles_write_superadmin`, `orgs_write_superadmin`. **This adds nothing
for an ordinary member** (all gate on `is_org_admin` or `is_superadmin`) — but
it means a Public Square org admin also reads `view_as_sessions` for the org.
Same conclusion as Q2: **who administers Public Square is the load-bearing
question, not the profiles policy.**

**One claim from this review NOT accepted at face value.** It closes by saying
an auto-invite with `invited_by = null` cannot be accepted, "so auto-invited
users would sit `pending`… the proposed change has no effect until PS members
are actually `active`." The premise is correct (§12.5 trap 3 verifies the same
mechanism), but the conclusion misreads the design: §12.5 stamps a real
superadmin account precisely so acceptance works. The accurate statement is the
narrower one — **v4 has no effect on users who never accepted**, which is by
design and is also why §3.6's pending backfill is safe.

**What neither review could establish:** no Public Square org exists, so every
"after" column is a prediction from live policy text, not an observation.
Nothing was run — no test, migration, seed or e2e. And **prod was not checked**;
given this repo's documented local/prod `ALTER DEFAULT PRIVILEGES` divergence,
the EXECUTE grants on those two definer functions must be re-verified against
prod before the admin-gating in Q2 is relied on.
## 12. v4 — THE MECHANISM

**One conjunct, in one function, that no other object in the database depends
on.** v4 is v1's shape with v1's named flaw repaired. It is not a fourth
mechanism; §9 rules out proposing one, and this does not.

### 12.1 Why this is not simply v1 again

v1's central guard was judged **circular**: excluding network orgs from
`profiles_select_shared_org` broke the invite lookup that depends on that
policy, and the proposed repair was a platform-wide email lookup — relocating
the leak rather than removing it.

**The circularity was real and is now measured.** §11.2 reproduces it exactly:
`modules/visual-messaging/ui/actions.ts:169` resolves an invitee with
`supabase.from('profiles').select('user_id').eq('email', email)` through the
caller's own RLS client, so inside Public Square it returns nothing and
`addMember` throws at a legitimate co-member.

**But the repair is not a platform-wide lookup.** It is
`find_module_peer(org, module, email)` — §12.4 — which is bounded to an org and
a module the caller already belongs to, and which **this design already
required** for ad-hoc chats. v1's flaw was that its repair was worse than the
disease. v4's repair is a component it needs anyway. That is the difference, and
it is the only claim v4 makes that v1 did not.

**Verified, and it matters:** the three module-level email resolvers
(`visual-messaging/ui/actions.ts:169`, `classroom/ui/manage/actions.ts:52`,
`matchmaking/ui/manage/actions.ts:94`) query `profiles` **directly**. None of
them calls `org_find_user_by_email`. Its only product call site is
`apps/web/lib/org-members.ts:20`. So §3.1's plan to "widen
`org_find_user_by_email`" would serve those three sites **only if they were
rewritten to call it** — a step v3 stated but never costed.

### 12.2 The change

```sql
-- (a) Name the property. A CHECK constraint, so a new kind cannot appear
--     without a migration whose author is forced to revisit (b).
alter table public.orgs
  add column kind text not null default 'client'
  check (kind in ('client', 'public_square'));

-- (b) Exactly one, ever. Without this the fail-open auto-invite in §3.6
--     silently and permanently stops for every future signup.
create unique index orgs_one_public_square
  on public.orgs (kind) where kind = 'public_square';

-- (c) The one conjunct.
create or replace function public.shares_org_with(target_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.org_members mine
    join public.org_members theirs on theirs.org_id = mine.org_id
    join public.orgs o          on o.id = mine.org_id
    where mine.user_id = auth.uid()
      and mine.status  = 'active'
      and theirs.user_id = target_user
      and theirs.status  = 'active'
      and o.kind <> 'public_square'   -- NOT o.kind = 'client'. See below.
  );
$$;
```

**Attributes to preserve on replace, VERIFIED LIVE from `pg_proc`:**
`provolatile='s'` (stable), `prosecdef=true`, `proconfig={search_path=public}`,
owner `postgres`, ACL `{postgres=X, authenticated=X, service_role=X}`.
`create or replace` preserves the ACL, but docs/03 #1 requires the intended ACL
be stated explicitly anyway. There is precedent for replacing this exact
function: `20260727010000` already did it.

**THE POLARITY RULE — write it down, it is the trap.** Exclude by naming the
**excluded** kind, never by naming the included one. `o.kind <> 'public_square'`
leaves a future `kind='personal'` (module-4's per-pair ad-hoc orgs) with
ordinary profile visibility, which is what that design wants: you invited that
specific person. `o.kind = 'client'` would silently strip visibility from every
ad-hoc pair the moment that column value appeared. This hazard came out of the
regression review, not out of the design.

The opposite risk — a *second* automatic-membership kind added later and
silently NOT excluded — is what the CHECK constraint in (a) is for: the set of
kinds cannot grow without a migration, and that migration's author must answer
the question. §12.6 adds a test that fails the build if it grows unanswered.

### 12.3 Why the Owner Console is untouched — VERIFIED, not inherited

This is the claim v3 got backwards, so it is checked directly:

```
select polname, polpermissive, polcmd, pg_get_expr(polqual, polrelid)
  from pg_policy where polrelid = 'public.profiles'::regclass;
-- profiles_select_own        | PERMISSIVE | r | ((user_id = auth.uid()) OR is_superadmin())
-- profiles_select_shared_org | PERMISSIVE | r | shares_org_with(user_id)
-- profiles_update_own        | PERMISSIVE | w | (user_id = auth.uid())
```

Three policies, **all PERMISSIVE**, therefore OR-ed. `profiles_select_own`
carries its own `is_superadmin()` arm and does not call `shares_org_with`.
Narrowing `shares_org_with` cannot narrow that arm.

**The structural reason v4 works where v3 failed:** a ROW policy is evaluated
per row and can be overridden by another permissive policy; a COLUMN privilege
is per **role** and cannot be restored by any policy. v3 revoked from
`authenticated`, and the superadmin *is* `authenticated`. v4 never touches a
grant, so the superadmin keeps every column of every row through a policy arm
that is untouched. **Confirmed by the platform-layer review — §11.5.**

**There are also no `for all` sibling policies on `profiles`** (the trap that
bit v1 and v2 on `org_members`/`module_roles`): the three policies above are the
complete set, and none is `FOR ALL`. Checked because the failure pattern demands
it, not because it was suspected.

### 12.4 Fix 4 — `find_module_peer`, and the throttle gap

Unchanged in shape from §3.4, with two corrections.

**Correction 1 — returning the display name is fine, and now necessary.** Under
v4 a Public Square member cannot read a stranger's name at all, so the
confirmation *"did you mean Sarah Cohen?"* exists nowhere else. At this scale,
mailing a private picture to a mistyped address is a likelier harm than name
harvesting.

**Correction 2 — THE THROTTLE HAS NOWHERE TO LIVE, and this is unresolved.**
VERIFIED LIVE: there is no rate-limit, throttle, quota or counter table anywhere
in `public`. v1's invite caps were rejected as *"unbuildable as specified
(settings cannot hold a daily counter that survives deleting the row)"* — and v3
re-specified a throttle without saying where the counter lives, walking into the
same wall. **v4 does not solve this either. It is called out as a build
prerequisite, not hidden:** `find_module_peer` needs a small append-only
`lookup_attempts` table (caller, timestamp), superadmin-read-only, with the
counter incremented on **every** call including misses — counting only hits
makes every wrong guess free, which is no throttle at all.

### 12.5 Auto-invite at signup — three verified traps

Shape as §3.6 (fail-OPEN, inner `begin ... exception when others -> raise
warning`, function-scoped `lock_timeout`). Three things verified live that the
design must handle:

1. **`handle_new_user()` is fail-CLOSED and has no exception block** (verified:
   its body is a bare `insert ... return new`). A *separate* trigger does not
   escape this — an AFTER INSERT trigger that raises still aborts the signup
   transaction. The inner exception block is mandatory either way.
2. **No JWT at signup.** `org_members_guard_hierarchy`'s entire INSERT
   normalization block is gated on `auth.uid() is not null` (verified in the
   body). So `status`, `role`, `invited_by`, `invited_at` **and `accepted_at`**
   must all be set explicitly by the trigger. §3.6 named the first three and
   missed `accepted_at`.
3. **`org_accept_invite` revalidates the inviter, and this is a landmine at
   scale.** Verified body: acceptance fails unless `invited_by` is non-null AND
   is either a **current** superadmin or an active member of that org who
   strictly outranks the invited role. `invited_by` is `ON DELETE SET NULL`.
   So if the stamped account is deleted, or merely has `is_superadmin` set
   false, **every outstanding Public Square invite becomes permanently
   unacceptable** with the message *"ask an admin to re-invite you"* — which is
   misleading, because no admin action repairs it (a re-invite means deleting
   and re-inserting the row).

   **This fragility exists today for every pending invite in every org.** Public
   Square only multiplies the blast radius. **v4 deliberately does NOT weaken
   the guard** — narrowing it to non-lowest roles would relax a deliberate
   control recorded in docs/15 §4.1 across every org, which is exactly the
   "fixed the mechanism I was thinking about" failure. v4's answer is to make it
   **loud**: stamp the founder's superadmin account, and add an assertion to the
   prod-verify script that the stamped account is still `is_superadmin`.

### 12.6 The tests v4 owes

1. **The two-stranger leak test** (§5, unchanged and still the most valuable
   thing in this document). Two users sharing ONLY Public Square; assert ZERO
   rows on every table enumerated from `pg_catalog`, with a conversation partner
   reading >0 rows as the non-emptiness control. It is the first mechanism on
   this platform that covers the seven core tables at all — both existing
   ratchets derive their scope from module prefixes.
2. **A kinds ratchet.** Assert the CHECK constraint's value set is exactly
   `{client, public_square}`; adding a kind fails the build until §12.2's
   predicate is revisited. Same pattern as `view-as-coverage.test.ts`.
3. **A client-org non-regression control.** Two users sharing an ordinary client
   org still read each other's profile — otherwise test 1 passes vacuously the
   day someone breaks the policy outright.
4. **The `addMember`-in-Public-Square path** through `find_module_peer`,
   asserting a non-member email returns nothing and a co-member's resolves.

### 12.7 What v4 does NOT fix, stated plainly

- ~~**`profiles.display_name` stays readable to co-members**, so a Public Square
  member cannot hide their name.~~ **WRONG — CORRECTED 2026-09-11. This is v3's
  property, inherited into v4's section by mistake.** v3 revoked the `email`
  COLUMN and left the row readable, so names survived. **v4 narrows the ROW
  policy**: inside Public Square `shares_org_with` returns false, so
  `profiles_select_shared_org` grants nothing and the only policy left is
  `profiles_select_own`. **A Square co-member therefore reads NEITHER name NOR
  email** — which is why §11.2 finds five surfaces rendering "Someone," and why
  §12.4 has to return the display name from `find_module_peer` (it is the only
  place a name can come from). **v4 is materially MORE private inside the Square
  than this bullet claimed, and its real gap is elsewhere — see §19.**
- **The org roster census stays** (docs/16 P1-4). `org_members_select_member` is
  `is_org_member(org_id) OR is_superadmin()`, so any member enumerates every
  member's user id. On a deliberately public square a membership list is close
  to the premise; but see §11.5 for what that census is worth once names are
  attached elsewhere.
- **Org admins still read every member's email**, via `org_member_profiles`
  (`is_org_admin`-gated). **And VERIFIED LIVE, worse than §7.3 recorded: that
  definer has NO `status` filter** — its body joins `org_members` on `org_id`
  alone. So a delegated Public Square org admin would read the name and email of
  every person on the platform **including those who were auto-invited and never
  consented**. That is docs/16 P1-2 exactly. **This is now a hard argument for
  §3.5** (delegate the module `moderator` role, never an org admin seat), not a
  preference. The members page's own comment documents the pending exposure as
  deliberate for client orgs — correct there, wrong here.
- **`module_roles`, `org_modules`, `module_scope_nodes`, `job_requests`** — see
  §11.5. `module_roles` is Track A's, not this design's.
- **The abuse posture** (§7.2) is untouched by any of this. FOUNDER DECISION.

### 12.8 Scope boundary with Track A (2026-09-10)

Track A owns and is building: the `module_roles` census narrowing (v3's fix 2)
and the `for all` split (v3's fix 3), docs/19's seat-authority fix, the
`vm_layers` delete cascade (§8.1) and self-block (§8.7). **Those four leave this
document's scope.** Verified at 2026-09-10: Track A has written
`20260910030000_vm_self_block.sql` and
`20260910040000_seat_requires_org_membership.sql` but has **not applied them**,
and the `module_roles` census narrowing is **not written yet**. **Live policies
are unchanged, so every measurement above is against pre-Track-A state and must
be re-checked before building.** (Track A renumbered the seat-authority
migration from `20260910010000` to `20260910040000` partway through this
session — a concrete reminder that its filenames, not just its schema, move
under this document.)

v4's own scope is therefore: §12.2 (the conjunct + `orgs.kind`), §12.4
(`find_module_peer` + its missing throttle table), §12.5 (auto-invite),
§3.7 (registry-declared self-join), and the Public Square org itself.

---

## 13. FOUNDER DECISION BATCH (2026-09-10) — four, all blocking, none urgent

Framed as scenarios with named consequences, per the founder's 2026-08-11 ask.
Seed users used so each one is concrete. **Nothing in v4 is blocked on these
being answered today** — the mechanism in §12 is independent of all four — but
Public Square cannot LAUNCH without them.

### 13.1 What is a person's public display name?

**VERIFIED LIVE, and it is worse than §6 recorded.** `handle_new_user()` sets
`display_name` from `new.raw_user_meta_data ->> 'display_name'`. The one product
signup path — `apps/web/app/login/page.tsx:37` — calls
`supabase.auth.signUp({ email, password })` with **no metadata at all**, and the
magic-link path at `:25` passes none either. So **every self-signed-up user has
a NULL display name.** All 11 users have one today only because `seed.ts`
supplies it.

**Scenario.** Charlie signs up with email and password. He accepts Public
Square, opts into Direct, and Dana starts a conversation with him. Every byline
on every layer he draws reads **"Someone."** So does his name in the children
list, and so does "reported by Someone" if he files a flag.

- **(a) Collect a name at signup.** One field on the login form, passed as
  `options.data.display_name`. Everyone gets a name; nobody can be anonymous;
  existing NULL users still need a prompt. *Recommended if the square is meant
  to feel like a place with people in it.*
- **(b) Derive it from the email local-part** until they set one — Charlie shows
  as "charlie". Free, but it **publishes half of everyone's email address to
  every co-member**, which partly undoes the thing v4 exists to do.
- **(c) Prompt for a name only on accepting Public Square.** Client-org signups
  are untouched; the name is collected exactly where it is needed, and declining
  to give one is a real choice. More UI than (a).
- **(d) Ship with "Someone."** Honest, ugly, and makes moderation harder (§13.3).

### 13.2 Is declining Public Square reversible?

**VERIFIED: today it is permanent.** Decline is a hard self-DELETE of the
pending row (`dashboard/actions.ts:22`, permitted by the guard's decline
carve-out). The auto-invite trigger fires only on `auth.users` INSERT, so it
never re-fires. Re-joining needs an admin INSERT.

**And the dashboard copy is misleading about it.** It reads *"It won't appear
below until you accept"* — which sounds like "not yet." There is no confirmation
step and no undo.

**Scenario.** Charlie signs up, sees the amber card, clicks Decline because he
does not know what Public Square is. Two weeks later a friend says "message me
on there." Charlie has no route back and no error explaining why — the square
simply is not offered to him again, ever.

- **(a) Leave it permanent, fix the copy.** "Declining removes this invitation;
  ask an admin to re-invite you." One string. At 12 users the founder re-invites
  by hand. *Cheapest, and honest.*
- **(b) Make Public Square re-joinable** with a `join_public_square()` definer
  on the dashboard. Self-service, no admin in the loop — but it is a new
  self-grant path into an org, and §3.7's unresolved `granted_by` question
  applies to it too.
- **(c) Soft decline** — a `declined` status instead of a DELETE, flippable back.
  New status value, touches `org_members_guard_hierarchy` (the platform's
  highest-risk trigger) and every predicate that filters on status. *Not
  recommended for the gain.*

### 13.3 Is a delegated moderator seeing every private conversation acceptable?

§3.5's answer to "I may need to delegate Admins" is: delegate visual messaging's
module-level `moderator` role, never an org admin seat. **That is the right
call and §12.7 now makes it a hard argument** — an org admin on Public Square
would read the name and email of every person on the platform, including people
who were auto-invited and never consented.

**But the moderator role is itself org-wide, and it is worth being explicit
about what that means here.**

**Scenario.** You delegate moderation to Mel. Dana is using Direct to send
drawings to her sister — a private 1:1 that has never been reported. Mel can
open it, and every image in it, at any time. She has no reason to, and no log
records it if she does. That is the same power the founder's own superadmin
access has (§7.1), but held by someone the users have never heard of.

- **(a) Accept it.** Moderators see everything; say so in the privacy policy in
  the same impersonal wording founder decision 7 already settled for superadmin
  access. *Simplest, and consistent with what is already true of the platform
  owner.*
- **(b) Scope moderation to flagged content** — a moderator reads a conversation
  only while it carries an open flag. Genuinely better privacy, and a real RLS
  change with its own migration and review. Not in v4.
- **(c) Do not delegate.** The founder moderates alone, and the square's size is
  bounded by that. A real answer at 12 users; not one at 1,200.

**Related and unresolved either way:** §7.1's superadmin access still has no
surface, no bound and no log, and the recorded reason for not logging it — that
it would surface the platform owner's activity to org admins — bites harder once
moderation is delegated.

### 13.4 The abuse posture for open self-signup

**Scenario.** Today anyone can create an account, and it grants them nothing —
they land on a dashboard with no orgs. After Public Square, the same signup
(including the magic-link path, which needs no password) accepts into the
square, opts into Direct, and can start sending images to any address it can
guess. `find_module_peer`'s per-caller throttle does not bound someone who
creates a second account. docs/16 P1-6 asked for a user-level ban, rate limits,
an abuse-report path that is not per-conversation, and a written acknowledgment
that this means **operating a public community, with the ongoing cost that
implies.** None of that exists.

- **(a) Invite-only for v1.** Public Square exists, but the auto-invite trigger
  is not installed; the founder adds people by hand. Everything in §12 still
  ships and is still correct; the abuse question defers until there is a real
  community to abuse. *Recommended — it is the extract-don't-speculate answer,
  and it costs one omitted trigger.*
- **(b) Open, with the minimum kit first:** self-block (Track A is building it
  now — §8.7), a user-level ban, and a report path that is not
  per-conversation. Real work, none of it started.
- **(c) Open with no kit, handled reactively.** Honest only if the founder
  accepts being the on-call moderator from day one.

**Note (a) and §13.2(a) compose well:** invite-only makes decline-is-permanent a
non-issue, because there is a human in the loop for every join.

### 13.5 Still open and NOT in this batch — unchanged, listed so it is not lost

§7.7's no-account invite flow is gone from the design and nobody decided that.
It orphans founder decision 8 (the 30-day expiry) and silently drops the two
recorded privacy obligations about holding a non-user's email address. **v4 does
not resolve it either.** It is not in this batch because it only becomes live if
the answer to §13.4 is (b) or (c).

---

## 14. v4's OWN ADVERSARIAL REVIEW — ATTEMPTED 2026-09-10, DID NOT RUN

**STATUS: v4 HAS NOT SURVIVED REVIEW. IT HAS NOT BEEN REVIEWED.** Do not build
it on the strength of §11 and §12 alone.

Two independent adversarial agents were spawned against §12 — one hunting
bypasses, one testing v4 against §0's principle, docs/13's widen/narrow rule and
docs/16's blocking checklist. **Both died on a session limit before returning
anything.** That is the same failure that killed three earlier reviews of this
design (v2's regression, completeness and consistency passes). It is now four.

**The prompts are worth re-running verbatim rather than re-derived.** Their six
attack surfaces, in the order they should be run:

1. Every path by which two Public-Square-only users could still read each
   other's `profiles` row — policies, definers and their ACLs, PostgREST embeds,
   `auth.users`, views, Storage, Realtime, the worker.
2. Every other route from a `user_id` to an identity — `org_members` still
   enumerates every user platform-wide.
3. `orgs.kind`'s write authority, the partial unique index under concurrency,
   and NULL handling.
4. The polarity rule (§12.2) — find a future org that should be excluded and is
   not.
5. `create or replace` on a SECURITY DEFINER a live policy calls: attribute
   preservation, RLS recursion, and the **per-row cost of the added `orgs` join
   at 10,000 users**, which nothing here has measured.
6. The auto-invite trigger against `handle_new_user`, `capture_login`, both
   `org_members` guards and `org_accept_invite` — firing order, FK targets,
   conflicts, and what a swallowed exception hides.

### 14.1 What was self-checked instead — NOT a substitute for independence

Run by the design's own author, which is precisely the weakness §9 says to
distrust. Recorded so the reviewer knows what is already covered and can spend
its budget elsewhere. Each carries a control.

**Attack 1 — definer bypass: CLOSED, complete enumeration.** All nine functions
in `public` whose body mentions `profiles`, with their ACLs:

| function | `authenticated` may execute | returns profile data | gate |
|---|---|---|---|
| `handle_new_user` | **no** (owner only) | — | trigger |
| `sal_appointments_before_write` | **no** | — | trigger |
| `sal_sync_from_worker_profile` | **no** (and not even secdef) | — | trigger |
| `is_superadmin` | yes | boolean only | none needed |
| `org_accept_invite` | yes | **void** — reads `profiles` only for the inviter revalidation | own pending row |
| `sal_worker_has_time_off` | yes | no — `sal_worker_profiles`, a module table | — |
| `mm_mutual_matches` | yes | **email** | mutual `mm_interests` + `mm_is_single` in that org |
| `org_find_user_by_email` | yes | **email** | `is_org_admin(check_org_id)` |
| `org_member_profiles` | yes | **email** | `is_org_admin(check_org_id)` |

**So the complete definer bypass set is three functions, and all three are
gated.** Two require `is_org_admin`, one requires matchmaking enabled plus
mutual interest (which §7.9 already forbids on Public Square without review).
**This is the enumeration §11.5's conclusion was asserting; it now exists.** It
does not change that conclusion: **if Public Square ever has an org admin, v4 is
cosmetic for that account.**

**Attack 3 — can anyone but a superadmin write `orgs.kind`? CLOSED.**
`pg_policies` on `orgs`: **2 policies total, exactly 1 non-SELECT** (the count is
the control) — `orgs_write_superadmin`, `USING is_superadmin()`. And zero
functions in `public` contain an INSERT/UPDATE/DELETE against `orgs` (regex over
`pg_proc.prosrc`; the empty result is meaningful because the same technique
found 9 functions touching `profiles`). `authenticated` does hold table-level
`arwd` on `orgs`, so **RLS is the only thing standing between an org admin and
`orgs.kind`** — but it does stand, with no definer route around it.

**This is the argument for putting the attribute on `orgs` rather than on
`org_members`**, and it was not the reason the design chose it. `org_members`
carries table-wide UPDATE for `authenticated` (§4, verified) plus
`org_members_write_org_admin` as a `FOR ALL` policy — so a per-membership marker
would have been **writable by any org admin**, and a delegated Public Square
admin could have un-hidden the whole directory by editing rows. Same trap that
killed v2's consent flags. The `orgs` placement is superadmin-only by
construction.

**NOT self-checked, and these are the real gaps:** attack 2 (other uuid→identity
routes), attack 4 (polarity failure cases), attack 5 (**the per-row cost of the
added join — completely unmeasured**), attack 6 (trigger ordering and the
auto-invite interaction). Plus every question in the second reviewer's brief:
whether v4 violates founder decision 2, whether `orgs.kind` falls foul of
docs/13's widen/narrow rule, and whether docs/16's P1 checklist is actually
answered. **§12's claim to answer docs/16 item 2 is unverified.**

**One naming constraint found while reading `pg_trigger`, recorded before it is
lost:** Postgres fires AFTER triggers in **trigger-name alphabetical order**, and
`auth.users` currently carries `on_auth_user_created` and `on_auth_user_login`.
An auto-invite trigger named to sort BEFORE `on_auth_user_created` would run
while the user has no `profiles` row. It is probably harmless — `org_members`
FKs `auth.users` not `profiles`, and with no JWT the hierarchy guard returns
early — but "probably harmless" is the register this document exists to avoid.
**Name it to sort after, and let the review confirm it.**

---

## 15. STATE FOR THE NEXT SESSION

**Done this session (2026-09-10):**

- **The regression review finally ran and completed** — §11. Four attempts, three
  deaths, one success. Answer: **existing client orgs are SAFE**; Public Square
  breaks five visual-messaging surfaces, two of them badly (§11.2).
- **v3 was killed by a live catalog read** (§9.3) — its central premise was a
  mis-read of `information_schema`.
- **v4 was designed** (§12) and its superadmin claim verified directly against
  `pg_policy` rather than inherited.
- **Four founder decisions batched** with live evidence (§13).

**NOT done, and blocking in this order:**

1. **v4's adversarial review** (§14). **This is the gate.** Re-run the six
   attacks and the second reviewer's five questions. Until then v4 is a draft
   that has been measured, not a design that has survived.
2. **Re-measure everything in §11 against the post-Track-A schema.** Every
   catalog read here predates Track A's migrations being applied.
3. **No migration has been written, and deliberately so.** The failure mode of
   v1, v2 and v3 was asserting without checking; an unrun migration is the same
   mistake in SQL. §12.2 is a sketch to be reviewed, not a file to be applied.

**Track A's state as of this session's end (read-only observation):** two
migrations written and NOT applied —
`supabase/migrations/20260910030000_vm_self_block.sql` and
`supabase/migrations/20260910040000_seat_requires_org_membership.sql` (note: the
seat-authority migration was renumbered from `20260910010000` mid-session, and
its notes moved to `docs/history/20260910040000-seat-authority-notes.md`), plus
uncommitted edits to `packages/db/src/rls.test.ts`. **The `module_roles` census
narrowing is still not written.** Live policies are unchanged.

---

## 16. FOUNDER DECISIONS — ANSWERED 2026-09-11

Three of §13's four are now decided. The fourth was turned back as a question
and is answered by measurement in §16.4.

### 16.1 DECIDED — a display name is collected at signup (§13.1 option a)

Every user has a public display name, given at signup. **Cheaper than it looks:
`handle_new_user()` already reads `new.raw_user_meta_data ->> 'display_name'`, so
the database side needs NO migration** — only the login page must start sending
it (`supabase.auth.signUp({ email, password, options: { data: { display_name } } })`,
`apps/web/app/login/page.tsx:37`).

Three things this decision carries:

1. **The magic-link path needs it too.** `signInWithOtp` at `:25` creates a user
   just as `signUp` does and passes no metadata either. Both, or the gap simply
   moves.
2. **It fixes a live client-org bug, not only a Public Square one.** Any
   self-signed-up member today renders as a raw UUID on classroom rosters and
   grading consoles (`modules/classroom/ui/manage/page.tsx:243`) and as "Someone"
   in speed-dating. Nobody has hit it because every real user was seeded or
   invited. **This is worth shipping ahead of Public Square on its own merits.**
3. **Existing NULL users still need a prompt.** Zero locally (seed supplies
   names), unverified on prod — check before assuming the backfill is empty.

### 16.2 DECIDED — a delegated moderator sees everything, and it is disclosed (§13.3 option a)

Consistent with founder decision 7's treatment of superadmin access: disclosed in
the privacy policy, impersonally worded. **This makes a FOURTH owed privacy line**
(docs/12 item 6 tracked three; §10 already flagged the fourth).

**Unchanged and load-bearing: delegate visual messaging's module-level
`moderator` role, NEVER an org admin seat on Public Square.** §11.5 and §14.1
establish why this is now a requirement rather than a preference — an org admin
reaches `org_member_profiles` and `org_find_user_by_email`, both SECURITY
DEFINER, both returning email, both gated only on `is_org_admin`, and the first
has no `status` filter so it returns people who never consented. **If Public
Square ever gets a second org admin, v4's central fix is void for that account.**

### 16.3 DECIDED — invite-only for v1 (§13.4 option a)

Public Square exists; the **org-level auto-invite trigger is simply not
installed** for v1, and the founder adds people by hand. Everything in §12 still
ships and is still correct. **This makes §13.2 (is declining reversible?) moot
for v1** — with a human in the loop for every join, a permanent decline costs a
re-invite by hand.

### 16.3b DECIDED — a switch for MODULE SELF-ENROLMENT, and it breaks no rule

**Founder, 2026-09-11:** *"There should be a switch that allows/stops users to
self enrol in modules in the public square."*

**CORRECTION, recorded because getting this wrong once already cost a round
trip.** An earlier draft of this section read the founder's *"make the switch to
turn this on and off built in"* as being about the **org-level auto-invite**, and
wrote a long argument about whether such a toggle violates docs/13's widen/narrow
rule. **That answered a question the founder had not asked.** The switch he wants
is the **module-level self-enrolment** switch — the second of the two consents
(join the space, then join each activity), not the first.

**Direct answer: no, it violates no rule — in the shape §3.7 already specifies.**

docs/13's rule is *anything that WIDENS reach belongs in code; anything that only
NARROWS it can be a runtime switch.* §3.7's design already satisfies it:

- **The module registry — code, in a diff — declares which modules are
  self-joinable.** That is the widening decision, and it gets a diff, a reviewer,
  a test run and a record of reasoning, which is exactly what the rule demands.
- **`org_modules.settings` may only ever DISABLE it per-org.** That is the
  narrowing direction, which the rule explicitly permits as a runtime switch.

**What the rule actually refuses is a switch that reaches a state no diff ever
authorized.** A switch travelling only between *the maximum the registry declared*
and *less than that* never reaches an unauthorized state — in either direction of
travel. Turning self-enrolment back on returns to the code-declared maximum; it
cannot exceed it.

**It was v2 that got refused here, not this.** v2 put the *enablement itself* in
`org_modules.settings.selfJoin`, so flipping that key was what turned self-join
ON — a widening switch with no diff. §3.7 moved the enablement into code
precisely to fix that. **v4 inherits §3.7 unchanged and does not re-open it.**

**On the home for the disable switch, verified live.** `org_modules` has three
policies: `org_modules_select_member` (SELECT), `org_modules_update_org_admin`
(UPDATE, `is_org_admin`) and `org_modules_write_superadmin` (ALL). So
`org_modules.settings` is **org-admin-writable**. For the *disable* direction
that is acceptable — an org admin can only ever narrow reach, never widen it, and
narrowing cannot leak anything. Contrast `orgs`, which has **2 policies, exactly
1 non-SELECT** (`orgs_write_superadmin`) and **zero functions writing to it**:
superadmin-only. **Rule of thumb this yields, worth keeping: a narrowing switch
may live somewhere an org admin can write; a widening one may not live in data at
all.**

**Three constraints the switch does NOT relax, all from §3.7 and all still
binding:**

1. **`join_module` hardcodes the module's lowest-rank role.** It must never
   accept a caller-supplied role — that would be privilege escalation wearing a
   consent mechanism's clothes.
2. **It must verify the caller is an active member of the org and that the module
   is enabled there**, or it becomes a way to mint seats in orgs you do not
   belong to.
3. **The `granted_by` question is still open and still unanswered.** A recorded
   decision requires every grant to carry `granted_by`, with system grants
   rendered highlighted in a review queue until a human confirms. **A self-join is
   neither human-granted nor system-granted.** It needs a third marker or an
   explicit exemption, and this is now on the critical path rather than parked,
   because the founder has asked for the mechanism that creates these rows.

**Sent to the adversarial review** as a seventh attack (not §14's attack 6, which
is the auto-invite trigger — corrected 2026-09-11): what can a `join_module`
definer be abused to do — escalate, enumerate, or flood `module_roles`?
**IT CAME BACK BADLY: `join_module` is UNBUILDABLE as §3.7 specifies, because
`module_roles_guard_hierarchy` is a BEFORE trigger and a SECURITY DEFINER does
not bypass a trigger. See §17.6, including the one-line shortcut that must never
be written.**

### 16.4 MEASURED, not decided — can people leave the ORG, or a MODULE, or both?

Founder's question back, 2026-09-11: *"What does leaving a 'space' mean? Leaving
a module? Leaving an org?"*

**VOCABULARY FIX, and the question was right to catch it.** "The space" was
sloppy shorthand for the Public Square **org**, borrowed from §2's phrase *"join
the space, then join each activity."* It is ambiguous in exactly the place this
design cannot afford ambiguity, so **this document now says ORG and MODULE, and
the word "space" is retired.** The two consents map to two distinct rows:

| consent | the row | joining it | leaving it |
|---|---|---|---|
| **Join the ORG** (Public Square) | `org_members` | invite → accept | delete the row — you are out entirely |
| **Join a MODULE** (an activity inside it) | `module_roles` | a grant | delete the row — you stay in the org, you leave that activity |

**Measured answer: today only the ORG can be left, and there is no module leave
at all — because there is no module JOIN either.**

- **The ORG** — `declineInvite` (`dashboard/actions.ts:22`) and `leaveOrg`
  (`:33`) are both the same self-DELETE of the `org_members` row, permitted by
  `org_members_guard_hierarchy`'s decline/leave carve-out. Both permanent.
- **A module** — VERIFIED: `module_roles` has **no self-insert and no
  self-delete policy**. Its only write paths are `module_roles_write_superadmin`
  (ALL), `module_roles_write_org_admin` (ALL), and
  `module_roles_{insert,update,delete}_module_manager`. **A person can neither
  join nor leave a module on their own today; every module seat is granted by
  someone else.**

**This exposes a real gap in the design, found by the question.** Founder
decision 4 is *two consents: join the space, then join each activity.* §3.7
designed the JOIN half of the second consent (`join_module`, a definer, with the
module registry declaring which modules are self-joinable). **The LEAVE half was
never specified.** A consent you cannot withdraw is not a consent — and it is the
same shape as §13.2's decline question, one level down.

**So the second consent needs both halves, and the leave half is cheaper and
should not be dropped:** a self-DELETE policy on `module_roles`
(`user_id = auth.uid()`) is the narrowest possible form and grants nothing else.
**Check before writing it** whether any module treats the absence of a role row
as a state it cannot recover from — speed-dating's `contact_shared` snapshot
(§11.3) is the warning that some modules have irreversible per-person state.

**Still open for the founder, now split in two:**

- **(a) Leaving the ORG** — permanent, or re-joinable? Moot for v1 under §16.3's
  invite-only, but not moot the day auto-invite is switched on.
- **(b) Leaving a MODULE** — should opting out of an activity be possible at all,
  and does leaving destroy or preserve what you did there?

  **LARGELY ANSWERED by Track A, same day — do not re-decide it here.** Commit
  `9f56b25` records a founder decision that supersedes §8.1's simpler framing
  (*content stays, author detached, marked departed*) with a better rule, written
  up as **docs/21 §7**:

  > **Deletion detaches the person but leaves a SILHOUETTE. The silhouette keeps
  > anything a HUMAN did that touched someone else; anything an AUTOMATED process
  > derived is deleted.**

  Leaving one activity is a smaller version of leaving the platform, so the same
  line decides it without a judgement call: the drawings you sent and the grades
  you wrote stay; matchmaking's auto-computed pair scores go. **§8.1 in this
  document is now the stale statement of that decision** — read docs/21 §7, not
  §8.1.

  What is NOT answered by it, and is still owed: whether self-leaving a module is
  permitted *at all* (§16.4 establishes no mechanism exists), and the
  irreversible-state check named above.

### 16.5 Cross-track note — Track A moved under this document on 2026-09-11

Verified after Track A's commits landed: **`module_roles`' live policies are
UNCHANGED** (`module_roles_select_member` is still
`is_org_member(org_id) OR is_superadmin()`), and **`shares_org_with`'s body is
unchanged** (`prosrc` md5 `d6d4c245419bc9a2d0d469b73f587fc6` — recorded so the
next session can diff it in one command rather than re-reading). Track A's own
handoff (`ce62121`) says the same in its title: *the org half is fixed, the
module-role half is open.* **So every measurement in §11 still holds as of this
timestamp** — but the module-role half is the part §12.7 depends on, and it is
still moving.

**Two new stale-doc items for §10**, both created by Track A today:

- **docs/21 now exists** and carries the silhouette rule (its §7 supersedes its
  own §3 and §4). §8.1 of this document must point at it.
- Track A's symmetry decision quotes the founder: *"Let's try to make as much
  symmetry as [possible]"* — about predicates, not about consent. **It does not
  answer §16.4, but it argues for it:** a consent that can be given and not
  withdrawn is exactly the asymmetry that principle objects to.

---

## 17. v4's ADVERSARIAL REVIEW — RAN 2026-09-11. VERDICT: SURVIVES WITH CHANGES

Two independent agents, fifth and sixth attempts at reviewing this design; the
first four died on session limits. **Both returned SURVIVES WITH CHANGES.**
Nothing here kills v4 the way `information_schema` killed v3 — the conjunct is
sound, correctly placed, has exactly one dependent, and its cost is now measured.
**But v4 is not a complete answer to "Public Square must not be a platform-wide
identity directory," and the gap is larger than §12.7 admitted.**

### 17.1 THE BIG MISS — `vm_*`'s `FOR ALL` policies. This document's fourth instance of its own failure pattern.

**VERIFIED LIVE by the orchestrator, not taken on the reviewer's word:**

```
select tablename, policyname, cmd, qual from pg_policies
 where schemaname='public' and tablename like 'vm_%' and cmd='ALL';
-- vm_conversations        | vm_conversations_write_manage        | ALL | vm_can_manage(org_id)
-- vm_conversation_members | vm_conversation_members_write_manage | ALL | vm_can_manage(org_id)
-- vm_layers               | vm_layers_write_manage               | ALL | vm_can_manage(org_id)
-- vm_reactions            | vm_reactions_write_manage            | ALL | vm_can_manage(org_id)
-- vm_flags                | vm_flags_write_manage                | ALL | vm_can_manage(org_id)

select prosrc from pg_proc where proname='vm_can_manage';
--   select public.is_org_admin(check_org_id)
--       or public.has_module_role(check_org_id, 'visual-messaging', 'admin');
```

**A `FOR ALL` policy's USING also governs SELECT** — the trap this document
records twice (§3.3, §9) and that killed v1 and v2. So **anyone holding the
visual-messaging `admin` MODULE ROLE in Public Square reads every row of all five
tables, org-wide**: every conversation, every membership, every layer, every
reaction, every flag. That is not "a moderator can open a private conversation"
(§16.2's decided trade). **It is the complete platform-wide social graph — who
talks to whom — reachable through a WRITE policy's read arm.**

**§16.2's protection does not cover it.** §3.5's answer is *delegate the module
`moderator` role, never an org admin seat.* But `vm_can_manage` admits the
`admin` module role as well as `is_org_admin`, so the moderator/admin split only
helps if it is verified against `polcmd='*'` specifically — which nobody did.

**How this got missed, stated plainly because the pattern is the point.** §12.3
checked `profiles` for `FOR ALL` sibling policies, found none, and said so. That
check was correct and it was the wrong scope: **the siblings that mattered were
not the other policies on `profiles`, they were the other TABLES of the module
that will actually run inside Public Square.** v1 checked `org_members` and not
`module_roles`; v2 documented this trap and walked into it; v3 read the wrong
catalog; **v4 checked the right catalog on the wrong table.** Fourth instance,
same shape.

**Required before Public Square carries any conversation: split the five `vm_*`
`FOR ALL` policies into `for insert` / `for update` / `for delete`.** §12.8
assigns the `for all` split to Track A **for `module_roles` only**; `vm_*` is in
neither track's scope today. **Blocking.**

### 17.2 `org_find_user_by_email` — v4 closes the policy and leaves the oracle

**Blocking, and §14.1's own table understated it.** That table listed the gate as
`is_org_admin(check_org_id)` and stopped. The body, re-verified:

```sql
select p.user_id, p.display_name, p.email from public.profiles p
where public.is_org_admin(check_org_id) and p.email = target_email;
```

**`check_org_id` is ONLY the gate. The search is over all of `profiles`.** There
is no join to `org_members` — while its sibling `org_member_profiles` **does**
join. So **any admin of any one client org can resolve any email on the platform
to a user_id and display name**, including every Public Square member, and
`profiles_email_key` makes it a fast exact oracle. §8.3 records the bug; §12.7's
list — the one a builder trusts — omits it and frames the exposure as "org admins
still read every **member's** email," implying a scope the function does not have.

**Fix as part of v4, not later:** add the `org_members` join its sibling already
has, or revoke EXECUTE from `authenticated` and route its single product call
site (`apps/web/lib/org-members.ts:20`) through a bounded definer.

### 17.3 The honest restatement of what v4 delivers

**`find_module_peer` re-opens, by design, most of what v4 closes.** §12.4
correction 1 makes returning the display name necessary; correction 2 admits
there is nowhere for a throttle to live (re-confirmed: no rate-limit, quota or
counter table exists in `public`). Once Direct is the ordinary activity, the
lookup's bound collapses to *"the caller also holds the module"* — nearly
everyone. **So v4's real promise is not "a stranger cannot learn who you are."
It is: *a stranger cannot read your name unless they already know your email
address.*** That is materially weaker than §12's framing, it is the P1-2
existence-oracle shape recurring inside a new function, and it is **v4's own
component, not inherited debt.** Stated here so nobody discovers it after
building.

### 17.4 Founder decision 2 — v4 violates its LETTER, and §0's defence does not hold

The strongest finding of the coherence review, and it is right.

**§12.2(b)'s partial unique index constrains `kind='public_square'` to exactly
one row. A class whose cardinality is fixed at one is an identity with an
indirection.** With the CHECK pinning the set to `{client, public_square}`,
`o.kind <> 'public_square'` *is* `o.id <> <the one org>`. v1 was rejected as five
guards keyed on an org attribute; v4 is one guard keyed on the same column. **A
difference in count and in correctness — not in kind.**

**§0's "corrected reading" is a rationalization, on its own evidence.** It
substitutes *forgettability* for the founder's actual words and then measures the
substitute. The measurement is true (independently re-derived with controls: one
policy, zero functions, against 220 policies and 10 control matches) — **but
§11.5 of this same document says the real dependency surface is the un-annotated
`.from('profiles')` call sites, which that grep cannot see. There are 29.** So
"one consumer" understates the very thing it is used to prove.

**The cheap fix, and it is available because of a decision made hours ago:**
§12.2(b)'s only stated justification is that without it §3.6's fail-open
auto-invite "silently and permanently stops." **§16.3 decided invite-only for v1 —
that trigger is not installed.** The index has no live justification today, and it
is the single artifact converting the class into an identity. **Drop it, or make
it advisory, and v4's claim to be a class rule becomes materially stronger.**

**And relabel v4 honestly:** a **trust-class** rule with cardinality 1 today, not
"the general fix." docs/16's checklist item 1 — the trust-class principle into
docs/00 — is **untracked** (`grep -i "trust class\|orgs.kind\|network"` over
docs/00 returns zero hits, and §10 does not name docs/00 at all). If the founder
adopts it, v4 becomes the first application of a recorded general principle
rather than an exception. That is the honest path and costs one paragraph.

### 17.5 The self-enrolment switch — the DEFAULT is the unexamined half

**§16.3b answered the founder's question correctly and incompletely.** The
widen/narrow argument is genuine, not a rationalization — the reviewer READ
docs/15:419-422 rather than grepping it and confirms that decision **explicitly
blesses `org_modules.settings` as the home of a DISABLE** while forbidding it as
the home of a widening declaration. The home is defensible.

**But §3.7 states a requirement its own mechanism fails.** §3.7 says *"it must
not be universally available: in Pozna the admin decides who is a maker."* The
registry is **module-level code**. Declaring `visual-messaging` self-joinable in a
diff turns self-enrolment ON **in every org that has visual messaging enabled,
Pozna included** — and the only thing stopping it is Pozna's admin remembering to
flip the disable key. **That is a fail-open default: docs/16 P1-5's "unvetted
defaults" shape exactly.**

Three legs, none clean — **FOUNDER DECISION, §18.1:**

- **(i) Registry flag global, defaults ON.** Widening lives in code (rule
  satisfied), but contradicts §3.7's own Pozna sentence and ships a fail-open
  default across every shipped org.
- **(ii) Defaults OFF; `org_modules.settings` must ENABLE per-org.** A widening
  switch in org-admin-writable data — **exactly what v2 was killed for.**
- **(iii) The registry declares a module self-joinable only for
  `kind='public_square'`.** Coherent and fail-closed, but it is a second
  `orgs.kind` branch in code, feeding straight back into §17.4.

**§7.6 already concedes "nothing branches per-org" is no longer claimed**, which
makes (iii) cheaper than it looks.

### 17.6 `join_module` is UNBUILDABLE as specified — and the obvious shortcut is a full authority bypass

**`module_roles_guard_hierarchy` is a BEFORE trigger, and a SECURITY DEFINER does
not bypass a trigger.** Its INSERT branch raises *"You cannot grant a module
position to yourself"* **before** any authority check. So §3.7's `join_module`
fails for every ordinary member. Building it means amending a platform-wide
guard — a cross-cutting change to a control docs/15 records, explicitly outside
§12.8's scope.

**THE SHORTCUT MUST BE NAMED AND FORBIDDEN IN WRITING.** Calling
`set_config('request.jwt.claims', ..., true)` inside `join_module` to null out
`auth.uid()` would make **both** `module_roles_guard_hierarchy` and
`org_members_guard_hierarchy` read the caller as "service role — bypass
everything." **That is a complete authority bypass disguised as a one-line fix.**
It must never be written.

**Abuse bounds, answered:** `module_roles_identity_uniq (org_id, user_id,
module_key, role, scope_ref) NULLS NOT DISTINCT` blocks exact duplicates, so
flooding is bounded by distinct role×scope pairs — **but `module_scope_nodes` is
org-wide readable, so a caller could enumerate every scope node and mint one row
per node if `join_module` accepts a `scope_ref`.** Therefore: **`join_module`
accepts neither `role` nor `scope_ref`. Both hardcoded by the registry;
`scope_ref` forced NULL.**

### 17.7 The performance gap is CLOSED — measured, not asserted

§14 flagged the per-row cost of the added `orgs` join as "the single biggest
unmeasured gap." It is now measured:

- `shares_org_with` is `procost=100`, `security definer`, with `proconfig` set —
  **both `prosecdef` and `proconfig` independently make it non-inlinable**, so it
  is an opaque per-row call **today and after the change**. The change does not
  make it opaque; it already was.
- The proposed body plans as a clean nested loop: `org_members mine` →
  **`orgs_pkey` index scan** → `org_members_pkey`. **The added join is one PK
  probe per caller-org, and `orgs_pkey` already exists.**
- At 10k users, work per call goes from ~K probes to ~2K where K = the caller's
  org count + 1. **≈2× a very small constant.**
- **No plan change** for the unfiltered `select ... from profiles` reads — those
  were already N function calls over a platform-wide table.
- **No RLS recursion.** `org_members` and `orgs` both have RLS, but a SECURITY
  DEFINER owned by `postgres` bypasses it (`relforcerowsecurity=f` on both),
  exactly as the current two-`org_members` version does.

**The real scaling risk is not the join.** Public Square adds one `org_members`
row per user, so the `mine` side must use `org_members_status_idx (user_id,
status)`. It currently seq-scans because the table is 28 rows. **Verify the index
is used before launch, not after.** (docs/16 P1-8 named this function for scale;
v4 adds to it, so P1-8 is newly worse, not unchanged.)

### 17.8 The remaining required changes, consolidated

**Blocking before any build:**

1. Split the five `vm_*` `FOR ALL` policies (§17.1).
2. Bound `org_find_user_by_email` (§17.2).
3. Answer the self-enrolment default — (i)/(ii)/(iii) (§17.5, §18.1).
4. Decide `join_module`'s guard amendment, or drop §3.7 from v4's scope (§17.6).

**Required, non-blocking:**

5. Drop or downgrade the partial unique index; relabel v4 as a trust-class rule
   (§17.4).
6. Add `m.status = 'active'` to `org_member_profiles`.
7. Narrow or exclude `job_requests` and `module_scope_nodes` for
   `kind='public_square'`, **and note its WRITE side is open** — any member can
   insert an arbitrary `kind`, which `apps/worker/src/index.ts:85-120` polls with
   a service-role client. Whether an attacker-chosen `kind` reaches a handler was
   **not** established. Trace it.
8. §12.6 test 2 must assert every `kind` value is explicitly *classified*, not
   merely that the set has size 2; write the predicate as `not in (...)` so
   growth is syntactically visible (§17.4's polarity/uniqueness tension).
9. Restate `security definer`, `stable`, `set search_path = public` and the full
   intended ACL on the `create or replace`.
10. Read `org_members_guard_last_admin`'s body — it also fires on `org_members`
    INSERT/UPDATE and its behaviour on a null-`auth.uid()` pending insert is
    **unread by anyone**.
11. Correct §10's stale-docs list: **add docs/00** (docs/16 checklist item 1,
    which gates the rest) and **docs/21**.

**Corrections owed inside this document** — the coherence review found 12 stale
claims; **three actively mis-instruct a builder and are fixed in §17.9**: §1's
history ends at v3, §2's flow still builds the auto-invite trigger §16.3 cancelled,
and §5 step 4 still lists it as build work. The rest are listed there.

**One cross-reference error, mine:** §16.3b says `join_module` abuse was "sent to
the adversarial review as attack 6." **Wrong — §14's attack 6 is the auto-invite
trigger.** `join_module` abuse was a seventh attack, added to the brief but never
added to §14's list. It ran; the answer is §17.6.

### 17.9 docs/16's P1 checklist, re-scored against v4 — and two conflicts

| item | status after v4 |
|---|---|
| **P1-1** CRITICAL, email directory | **PARTLY CLOSED.** v4 implements option (a)'s first half verbatim. Option (a)'s *second* half — a display-name-only surface — is **unbuilt**, and §11.2's five "Someone" surfaces are that gap showing up as a product break |
| **P1-2** CRITICAL, auto-invite = auto-join | **PARTLY CLOSED.** Predicate half shipped in `20260727010000`; §16.3's invite-only removes the trigger for v1. **But it recurs through `org_member_profiles`'s missing `status` filter** |
| **P1-4** HIGH, roster enumeration | **OPEN**, accepted not fixed (§12.7) |
| **P1-5** HIGH, unvetted defaults | **OPEN** — §7.9 is a process with no mechanism, and §17.5 shows the self-enrolment default walking into this shape |
| **P1-6** MEDIUM, abuse posture | **OPEN, and now in DIRECT CONFLICT.** P1-6 asks for *"named owner/admin seats (the platform operator wearing an org hat)."* **§16.2 forbids any org admin seat on Public Square.** Both are right for their own reason. **The document must record that P1-6's owner seat is refused, and what replaces it** |
| **P1-7** | holds, under invite-only |
| **P1-8** LOW, `shares_org_with` join performance | **OPEN and newly worse** — v4 adds a join to the exact function P1-8 named. Cost now measured (§17.7); the index question is not |

**The claim "v4 answers checklist item 2" is REFUTED AS STATED**, on two counts:
it still credits **v3** (dead), and docs/16's checklist is headed *"all founder
calls, none made yet"* — §16 records four founder decisions and **item 2's shape
choice is not among them.** Correct wording: *v4 proposes P1-1 option (a); the
founder has not ratified it and the definer half is unbuilt.*

**P3 vs §7.9 — not reconcilable as written.** P3's ban ("a network module gets
its own org, NOT Public Square") is **structural** — *the platform-wide org must
not become a junk drawer where every network module's data commingles under one
membership predicate.* A per-module risk review cannot answer a structural
invariant; §7.9 silently overrides P3 rather than resolving it. **Clean fix:
narrow P3 explicitly to pool-shaped modules (the matchmaking family), in a dated
docs/16 entry** — §7.9 and P1-5 already reach those independently.

### 17.10 What neither review could establish

- **Prod.** Everything is local. The documented `ALTER DEFAULT PRIVILEGES`
  divergence means the EXECUTE ACLs on `org_member_profiles` and
  `org_find_user_by_email` must be re-checked against prod before §16.2's
  admin-gating is relied on.
- **Whether an attacker-chosen `job_requests.kind` reaches a worker handler.**
- **Whether `job_requests.payload`/`result`/`error` actually contain identifying
  strings** — columns were read, data was not.
- **`org_members_guard_last_admin`'s body.**
- **Real plan behaviour at scale** — §17.7's projection is arithmetic on a plan
  shape at 11 profiles / 28 memberships, not an `EXPLAIN ANALYZE` under a real
  `authenticated` role.
- **PostgREST error-text and Realtime channel-name leakage** — not exercised.
- **Post-Track-A state.** Both reviewers independently re-confirmed
  `shares_org_with` and `module_roles_select_member` are unchanged live, and
  Track A's two migrations remain unapplied.

---

## 18. FOUNDER CHALLENGES, 2026-09-11 — three land, one overturns a recommendation

### 18.1 "Why would a switch for auto-invite violate anything?" — IT DOESN'T. I over-applied the rule.

**The rule** is docs/13's: *anything that WIDENS reach belongs in code; anything
that only NARROWS it can be a runtime switch.*

**Why I thought it bit:** turning auto-invite ON puts every new signup into the
Square, which looked like widening from a data switch.

**Why that is wrong, verified:** auto-invite creates a **pending** row.
`is_org_member` requires `status = 'active'`; `shares_org_with` requires active on
**both** sides. **A pending row grants nothing to anybody.** The switch changes
who is *offered* membership, not who *has* it — the widening happens later, when
a human accepts. **The rule is about reach, and a pending invitation has no
reach.** So an auto-invite toggle is not a widening switch and §16.3's long
argument was aimed at a problem that does not exist. Retracted.

### 18.2 "Does joining expose the auto-joined user to the other members?" — PRECISELY, YES, IN PART

Measured, and the answer is asymmetric — worth stating exactly because "pending
is safe" is nearly true and not quite:

**While PENDING, the invitee sees nothing** (`is_org_member` is active-only, so
every member-gated policy returns zero rows for them).

**But active members already see the pending person**, because
`org_members_select_member` is `is_org_member(org_id) OR is_superadmin()` — a gate
on the *reader*, with **no status filter on the rows returned**. So every active
member reads a pending invitee's `user_id`, `role`, `status`, `invited_by`,
`invited_at`, `accepted_at`. **Not their name or email** — those need
`shares_org_with`, which is active-on-both-sides.

**And one real pre-consent leak:** `org_member_profiles` — the definer the members
page calls — joins `org_members` on `org_id` alone with **no status filter**, so a
Square org admin reads the **name and email** of people who never accepted. This
is docs/16 P1-2 recurring through a definer, and it is why §16.2's "no org admin
seat on Public Square" is load-bearing.

**Once ACTIVE, without v4:** every other member reads the whole `profiles` row —
`display_name`, `email`, `settings`, `is_superadmin` — plus the full
`module_roles` census of which activities they joined. That is the leak v4 exists
to close.

### 18.3 "I thought a user chooses per org which of their info is displayed" — YOU DECIDED THAT, AND v4 DOES NOT DELIVER IT

**The founder is right and this document buried it.** FOUNDER DECISION 5
(2026-09-08): *profile sharing should be the user's choice.* §6 marks it "PARTLY
SUPERSEDED" and §13 asked a narrower question (*what is your public name?*)
without ever saying plainly: **three designs have now failed to deliver the
choice you asked for, and v4 replaces it with "nobody reads anyone's email,
everyone's name is visible."**

**v2 tried to build it and was rejected — but read WHY, because the reasons were
about that mechanism, not about the goal:**

- Its flags lived on `org_members`, which carries **table-wide UPDATE for
  `authenticated`** plus a `FOR ALL` org-admin policy — so **any org admin could
  have set the whole org to "share email."** The user's choice would not have been
  the user's.
- The choice was **stamped by the inviter**, not chosen by the subject.
- It needed a carve-out in `org_members_guard_hierarchy`, the platform's
  highest-risk trigger.
- Cost was understated 7× (15 breaking sites, not 2).

**None of those are arguments that the goal is wrong. They are arguments that
`org_members` is the wrong home.** And there is a home that fixes the first
three, verified live: `profiles_update_own` is `user_id = auth.uid()` on both
USING and WITH CHECK, and `profiles` carries **column-level UPDATE grants limited
to `display_name` and `settings`** — so a user, and only that user, can write
their own settings. A per-user choice is already writable safely today. A
**per-org** choice needs its own small table with a self-only write policy —
which avoids `org_members` entirely and therefore avoids all three failures.

**NOT designed here, deliberately** — it is a real slice, not a conjunct. But
**the decision is live, not superseded**, and this document should stop implying
otherwise. **FOUNDER DECISION owed: does v4 ship as an interim (emails private,
names visible) with per-org choice as a later slice, or does the choice block
launch?**

### 18.4 "Why not: per-org chooses which modules are self-join, default OFF, we turn it on manually?" — THIS IS BETTER THAN MY RECOMMENDATION. ADOPTED.

**The founder's proposal beats §17.5's option (iii), and my objection to option
(ii) was too broad.**

I said a per-org enable "is what killed v2." **Read properly, the precedent does
not reach this case.** docs/15:419-422 forbids `org_modules.settings` as the home
of a widening declaration with a stated harm: *"an org-admin-writable edge list
would let an org admin mint impersonation the module designers banned."* Two
things make self-enrolment different:

1. **Nothing is being minted that designers banned.** Self-join grants the
   module's **lowest** role — the entry role the designer already defined.
2. **It creates no reach that did not exist.** Verified:
   `module_roles_write_org_admin` is `ALL / is_org_admin(org_id)`, so **an org
   admin can already grant any member a module seat by hand, today.** The switch
   changes *who initiates* the grant, from admin to member. It delegates an
   authority the admin already holds, over members they already admitted.

**The shape that satisfies the rule properly, and is GENERAL — no mention of
Public Square anywhere in code:**

- **The module registry (code, in a diff) declares which modules are ELIGIBLE to
  be self-joinable at all.** This keeps the designer's veto where the rule wants
  it: a module that must never be self-joined says so in code, and no switch can
  override it.
- **Per-org, the switch chooses within that ceiling. Default OFF.** Fail-closed,
  so Pozna is never exposed by someone else's diff.
- **A front end for the right org user types**, as the founder asks — the org
  admin flipping it for their own org is exactly the right person.
- **Public Square is turned on manually, like any other org.** No per-org branch
  in code at all.
- **`join_module` still hardcodes the lowest role and forces `scope_ref` NULL**
  (§17.6) — the abuse bound does not move.

**This is strictly better than option (iii), which I recommended.** (iii) put a
second `kind='public_square'` branch in code, feeding straight back into §17.4's
"v4 violates the letter of founder decision 2." **The founder's version removes
that branch entirely and is the more general fix — which is §0's whole point.**
§17.5's three-way question is **CLOSED**; §16.3b's "registry declares
self-joinable, settings may only disable" is **superseded by this**.

**Still true and unchanged: §17.6 — `join_module` is unbuildable until
`module_roles_guard_hierarchy` is amended, and the `set_config` shortcut must
never be written.** The founder's answer settles *where the decision lives*, not
*whether the function can be written.*

---

## 19. THE LAST OPEN DECISION, STATED PROPERLY — and a correction that reframes it

**§18.3 put the question as "does v4 ship as an interim — emails private, names
visible — with per-org choice later?" That framing was wrong**, because it
described v3's behaviour, not v4's (§12.7, corrected). The corrected picture
changes where the gap actually is.

### 19.1 What v4 actually does, per org type

| | inside **Public Square** | inside a **client org** (Pozna, Demo Salon) |
|---|---|---|
| your **email** | **nobody reads it.** `shares_org_with` returns false there | **every co-member reads it** — unchanged from today |
| your **display name** | **nobody reads it** — you render as "Someone" until someone connects with you | **every co-member reads it** — unchanged |
| your **`profiles.settings`** | nobody reads it | **every co-member reads it** — unchanged (§7.5) |
| your **module census** (which activities you joined) | every member reads it until Track A's fix lands | every member reads it until Track A's fix lands |
| how anyone learns who you are | **only `find_module_peer`** — they must type your exact email address, and then they get your name | ordinary roster reads |

**So v4 is much more private inside the Square than §12.7 claimed.** You are
invisible to strangers by default. The only route to your identity is someone who
already knows your email address typing it in — which is the founder's own
"they type an email address to reach someone" flow from §2.

**And that means the unmet half of founder decision 5 is NOT in Public Square. It
is in the client orgs, where v4 changes nothing at all.**

### 19.2 The decision, as a scenario

**Dana is a nail-salon customer at Demo Salon and also joins Public Square.**

- **In Public Square** she is anonymous. Charlie, a stranger who shares only that
  org with her, reads nothing — not her name, not her email. If he types her exact
  email he gets her name and can ask to start a conversation, which she must
  accept. **This is the behaviour the founder asked for, and v4 delivers it.**
- **At Demo Salon** nothing changes. Frank the admin, alice the manager, eve the
  cashier, **and charlie the rank-0 customer** all read Dana's name, her email,
  and her `profiles.settings`. **Charlie the customer reads Frank the admin's
  email too** — this is the recorded "rank-0 reads rank-3" hole, live since
  `20260708020000`, and it is the thing founder decision 5 was about.

**So the question is not "does Public Square launch without user choice."** It is:

> **Does fixing what a client org's co-members can see about each other block
> launching Public Square — given that v4 does not make it worse, and Public
> Square is the one place where it is already solved?**

### 19.3 The two answers

**(a) Ship v4; per-org info choice becomes its own slice.**
Public Square launches with strong privacy. Client orgs keep today's behaviour —
**no regression, no improvement.** Founder decision 5 stays open and gets built
when it is picked up, on its own migration and review. **The honest cost: a
recorded founder decision stays unbuilt for longer, and the privacy copy must not
claim more than this delivers.**

**(b) Build the per-org choice first; Public Square waits on it.**
Decision 5 is honoured before the public-facing thing ships. **The honest cost:**
it is a real slice — a new table with a self-only write policy, a settings
surface, and it touches every roster in every module (which is exactly why the
parked item in CLAUDE.md says "its own migration and review"). v2's attempt at
this was measured at **15 breaking sites across four modules**. Public Square
slips behind all of it.

### 19.4 What is NOT on the table either way

- **This is not v2.** v2 failed because it put the flags on `org_members`, which
  any org admin can write, and because the inviter stamped the choice. Any future
  version uses its own table with a `user_id = auth.uid()` write policy — verified
  as the shape `profiles_update_own` already uses successfully.
- **Neither answer changes Public Square's own behaviour.** v4 already makes
  Square members invisible to each other.
- **Neither answer touches the four blocking items in §17.8.** Those must be fixed
  before anything ships, under (a) or (b).

### 19.5 Recommendation

**(a), and the reason is that (b) inverts the risk.** The client-org exposure has
been live and accepted since 2026-07-08 among people who know each other and were
individually admitted by an admin. Public Square is the genuinely new risk —
strangers — **and it is the half v4 actually closes.** Holding the fix for
strangers behind a fix for colleagues delays the sharper problem to address the
duller one.

**With one condition: the privacy copy must not overclaim.** §7.3 already warns
this. Under (a) the true sentence is *"members of the Public Square cannot see
each other's name or email"* — and it must not be written as a statement about
orgs in general, because in a client org it is false.

---

## 20. DECIDED 2026-09-11 — (a), and it is ORDER, NOT SCOPE

**FOUNDER DECISION: ship v4 first; per-org info choice follows as its own slice.**

**The founder's framing, adopted verbatim because it is the important part:**
*"Taking (a) still has us do both — this decision is just about the order."*
Correct. **Founder decision 5 (2026-09-08, profile sharing is the user's choice)
is NOT superseded, NOT descoped, and NOT closed by this.** §6 currently marks it
"PARTLY SUPERSEDED"; that marking is **wrong** and must read *deferred, sequenced
after v4*. §19(a) is a statement about sequence only.

**The failure mode this guards against is documented in this repo:** a decision
deferred inside a completed item is how it gets lost (the 2026-08-07 lesson about
deleting working notes — open state hidden inside a finished heading). So the
per-org choice slice gets its own entry wherever open work is tracked, not a
footnote inside a shipped one.

---

## 21. THE PRIVACY COPY — the founder overturned my wording, and the reason generalises

**I proposed:** *"members of the Public Square cannot see each other's name or
email."* **The founder refused it, on two counts, and both are right.**

**Count 1 — it is a per-org rule wearing prose.** A privacy page with a
Public-Square-specific sentence is the same smell as a Public-Square-specific
branch in code. §0's principle does not stop at the schema boundary: *fix the
general case so the Public Square case is covered as a consequence.* **That
applies to the words on the page as much as to the predicate in the policy.**

**Count 2 — it is not durably true.** §20 just decided the per-org info choice IS
being built. The moment that slice ships, what a co-member can see **depends on
what the user chose to display** — so a sentence asserting "cannot see" becomes
false, on a page that is a legal commitment. **Copy that must be rewritten by a
slice already on the roadmap is copy written wrong the first time.**

### 21.1 The rule this yields

> **Write every privacy line about the MECHANISM, never about a specific
> organization.** It is then true today, true after v4, and true after the
> per-org choice slice — and it covers Public Square as a consequence.

**Applied to the line v4 owes**, the durable form is roughly:

> *Other members of an organization you belong to may be able to see your name and
> email address. Whether they can depends on that organization and, where
> offered, on your own settings.*

True in Pozna today (they can). True in Public Square after v4 (they cannot).
True after the choice slice (it depends on you). **Names no org, and survives the
roadmap.**

**Applied to §16.2's moderator disclosure**, the same discipline: not *"Public
Square moderators may review your conversations"* but the impersonal, general
form — *moderators of an organization may review content within it* — which is
also what founder decision 7 already chose for superadmin access.

### 21.2 Consequence for the tracked privacy debt

docs/12 item 6 tracks owed privacy lines; §10 adds a fourth for the moderator
disclosure. **All of them should now be drafted against §21.1's rule**, and the
count may be smaller than tracked — a single well-written general sentence about
what co-members can see may discharge both the v4 line and part of what §7.3
warns about overclaiming. **Draft them together rather than one per feature**, or
the page accumulates one clause per slice, which is how it ends up naming orgs.

**FLAGGED, not decided: this may reopen a closed question.** If the privacy page
must describe what org co-members see, it has to be accurate about the client-org
case *today* — where a rank-0 customer reads a rank-3 admin's email. That is
live, accepted, and unwritten. **Writing an honest general sentence may be the
thing that forces the client-org exposure to be fixed sooner than §19's ordering
assumes.** Worth knowing before the copy is drafted, not after.
