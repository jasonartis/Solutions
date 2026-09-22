# Seat authority audit — a module roster row outlives the org membership that justified it

**Status: THE ORG-MEMBERSHIP HALF IS FIXED, MERGED, ON PRODUCTION AND
PROD-VERIFIED (2026-09-11 — `migrate:prod` + `prod-verify-migration.ts` 0
failures + `scripts/prod-verify-seat-authority.mts` 25/25, covering the policies
and the trigger binding the function-only script cannot see). (2026-09-10, `cf63e77`,
`20260910040000`) — all 8 functions and all 5 inline policy arms, verified
db 183/183 then e2e 52/52 in CI's exact order.**

**AND THE MODULE-ROLE HALF IS ALSO SHIPPED AND PROD-VERIFIED (2026-09-15,
`20260915010000`).** Of the four numbered items below, **THREE ARE NOW DONE**
(1, 2 and 4) and only **#3 — the `module_roles` census leak — remains from this
list.** This header previously read "FOUR THINGS BELOW ARE STILL OPEN", which
stopped being true as those items closed; corrected 2026-09-22 because a cold
reader would otherwise treat all four as open, which is exactly the
stale-header failure this repo keeps finding.
**What is ACTUALLY open now lives in the 2026-09-15 section's "STILL OPEN"
list** — #3 below, plus four items that section records: speed dating's role
conjunct (a FOUNDER DECISION — no audience/mentor role exists), the
vm/conversation last-admin floor, `cls_set_preferred_name`'s unenrolled-student
half, and §5's `sd_in_event` status filter. **Read the dated sections at the END
of this doc, not just this one.**

1. **The MODULE-ROLE half — SHIPPED, ON PRODUCTION AND PROD-VERIFIED
   2026-09-15** for matchmaking, nail salon and classroom (`20260915010000`;
   `migrate:prod` applied, then `prod-verify-module-role.mts` **85/85** and
   `prod-verify-migration.ts` **0 failures / 0 warnings**, all five function
   bodies md5-matching). Speed dating's
   role conjunct is the one piece deliberately deferred, and it is now a
   **FOUNDER DECISION** (there is no audience or mentor module role to require —
   see the 2026-09-15 section). db 217/217 → e2e 52/52 in CI's order.
2. **Four more items in the same class — ALL FOUR FIXED 2026-09-15 in the same
   migration**, including the live WRITE (an offboarded peer reviewer could
   still grade a current student's work) per founder decision 3.
3. **`module_roles` reads are org-wide** (the adjacent census leak) — descoped by
   Track A (blocked on rank-mapping three modules), and **reclaimed by the
   Public Square session on 2026-09-13**, which re-verified it still live.
4. **DONE (2026-09-14).** `assignMatchmaker` and `addGroupMember`
   (`modules/matchmaking/ui/manage/actions.ts`) now verify active org
   membership before minting a seat (app-side, no migration), matching the
   pattern already used in classroom's `enrollClassMember` and visual
   messaging's `addMember`. The owed RLS test proving a non-member's seat
   confers nothing was also written once the database and `rls.test.ts` were
   free — db 206/206, CI-verified. See the dated entries at the end of this
   doc for both.

*Original 2026-09-04 header, kept for context: findings, verified, not fixed;
produced as a follow-on to `20260904010000`, which fixed one instance of this
class in visual messaging. Nothing here is a founder decision except one flagged
item (§5).*

## The class of bug

docs/03 #20: *a per-entity SEAT is not authority — it must also require org
membership.* A predicate that derives authority from the existence of a row in
a module-owned roster (`*_participants`, `*_assignments`, `*_members`, a
`worker_id` column) — keyed on `auth.uid()` and **without** a conjunct
requiring `is_org_member()` of that row's org — makes the roster row a
complete, standalone, non-expiring capability.

Visual messaging's `vm_conversation_members` was found and fixed this way. This
audit asked whether it was one instance or a class. **It is a class.**

## Why it is reachable WITHOUT any malicious insert — the important part

The visual-messaging instance needed someone to insert a seat for an outsider.
Every finding below needs nothing of the kind, because of two facts that
compose:

1. **`removeOrgMember` deletes exactly one row** — `apps/web/lib/org-members.ts:89-92`:
   ```ts
   await supabase.from('org_members').delete().eq('org_id', orgId).eq('user_id', userId)
   ```
2. **Nothing in the schema has a foreign key to `org_members`** — verified:
   `grep -rn "references public.org_members" supabase/migrations/*.sql` returns
   **0** matches. So that delete cascades to nothing.

Therefore: revoke a person's org membership (or re-invite them, which leaves
`status = 'pending'`) and **every module roster row they hold survives**.
`is_org_member()` now returns false while the roster row still says "member,"
and any predicate reading that row bare still grants access — permanently.

This is precisely the hole `20260727010000_org_invite_accept.sql` closed for
`module_roles`-derived authority (it patched seventeen predicates to require
active membership) and **never closed for module-OWNED rosters**, because those
are per-module tables that migration did not touch.

The ordinary "an employee leaves / a student is removed / a participant is
ejected" path is the exploit. No insider action required.

## Verification method, and its control

Claims here were checked three ways, and the method's own reliability was
tested before its results were trusted:

- Every `create table` (74) → every module column referencing `auth.users` (51)
  → the 9 tables whose rows semantically mean *this user belongs to this
  entity*. Enumerated from the migrations, not guessed from names.
- Every function definition traced to its **latest** `create or replace`. This
  matters: `cls_is_class_member` reads as vulnerable in its original migration
  (`20260708010000:371-383`) and was silently cured by `20260727010000:352-370`.
  A single-migration grep produces a false positive here.
- **Confirmed against the LIVE database**, not just the files:
  ```sql
  select p.proname, case when pg_get_functiondef(p.oid) ilike '%is_org_member%'
      or pg_get_functiondef(p.oid) ilike '%is_org_admin%'
      or pg_get_functiondef(p.oid) ilike '%has_module_role%'
    then 'ORG-GATED' else 'BARE ROW' end
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in (...);
  ```
  **The control that makes this credible:** the two functions known to be cured
  — `cls_is_class_member` (July) and `vm_is_conv_member` (today) — both return
  ORG-GATED, while all eight below return BARE ROW. The method distinguishes
  fixed from unfixed, so the positives are not an artifact of the query.

## 1. Matchmaking — HIGH (the closest analogue to the vm bug: SQL *and* app write path)

- `mm_matchmaker_can_see` — `20260709020000_matchmaking.sql:275-297`, defined
  once, never redefined. Reads `mm_matchmaker_assignments` on
  `a.matchmaker_id = auth.uid()` with no org conjunct.
- **Two INLINE policy arms** that read the assignment table directly, so no
  function change reaches them: `mm_groups_select_assigned` (`:565-571`) and
  `mm_group_members_select_assigned` (`:573-579`).
- **The app write path is unguarded, and it is the exact shape vm's `addMember`
  had**: `modules/matchmaking/ui/manage/actions.ts:92-100` resolves an
  arbitrary email through `profiles` (i.e. anyone sharing *any* org with the
  caller, via `profiles_select_shared_org`), and `:143-163` inserts the
  assignment with no membership verification. Same in `addGroupMember`
  (`:118-132`).

**Exploit.** Org A's matchmaking admin types the email of someone who shares
only org B with him. One insert. That person is 404'd from every org-A page by
`requireOrgModule`, yet against the API reads each assigned single's full
intimate questionnaire (`mm_answers_select`), their compatibility scores
(`mm_pair_scores_select`), and the group row plus its **entire roster of
user_ids**. Second variant, no insert at all: any *former* matchmaker whose org
seat was deleted keeps all of it indefinitely.

## 2. Speed dating — HIGH (`sd_participants` is the structural twin of `vm_conversation_members`, `status` column and all)

Four bare predicates in `20260709050000_speed_dating.sql`, none redefined by
`20260726030000` — which deliberately rewrote only the *staff* arms and says so
at `:277-278` (*"every ownership / seat-holder / reveal arm is preserved
VERBATIM"*):

- `sd_owns_participant` `:530-544` · `sd_in_event` `:546-563` ·
  `sd_paired_with` `:565-580` · `sd_mentors` `:582-606`

Seven live policies depend on them: `sd_events_select`, `sd_rounds_select`,
`sd_participants_select`, `sd_pairings_select`, `sd_interest_select`,
`sd_matches_select`, `sd_reports_select`/`_insert_own`.

**Exploit.** An organizer ejects a disruptive attendee and the org admin deletes
their org seat. Neither touches `sd_participants`. They still read the event,
the live round clock, every participant they were paired with (including that
person's opt-in profile card and pool side), their own revealed mutual matches
**with shared contact details**, and can still insert safety reports as that
seat.

**Note the write path is NOT the weak link here** — `sd_participants_insert_self`
(`:800-806`) correctly conjoins `sd_is_participant(org_id)` → `has_module_role`
→ `is_org_member`. The exposure is persistence after revocation.

## 3. Nail salon — MEDIUM (customer PII, and a lingering write)

- `sal_worker_sees_customer` — `20260709030000_nail_salon.sql:527-551`, bare
  `sal_appointments` read on `a.worker_id = auth.uid()`. Gates
  `sal_customers_select` (`20260726010000:303-309`) — the customer's
  `full_name, phone, email, notes`.
- Two inline arms in the CURRENT policies: `sal_appointments_select`'s
  `worker_id = auth.uid()` (`20260726010000:316-322`) and
  `sal_worker_time_off_select`'s inline `sal_worker_profiles` read (`:288-296`).
- Plus a **write**: `sal_appointments_update_worker` (`20260709030000:861-866`)
  still lets them advance state and write `notes`.

**Exploit.** A stylist quits; the manager deletes her org seat and revokes her
`nail-salon.worker` grant. `sal_worker_profiles` and `sal_appointments.worker_id`
are untouched. She permanently retains the name/phone/email/notes of every
customer she ever served, plus their appointment history — and write access to
any of her old appointments still in `checked_in`/`in_progress`.

## 4. Classroom — MEDIUM (reaches Storage, and has a second-order re-mint path)

- `cls_reviews_submission` — `20260708010000_classroom.sql:401-414`, bare. Reaches
  `cls_submissions_select`, `cls_submission_files_select`,
  `cls_review_comments_insert_own`, and — worst — `cls_submissions_storage_read`
  (`20260709080000:63-77`), so the **actual source files are downloadable by
  path**, not merely the row readable.
- **Second-order, and the more interesting path:** `moveToPeerReview` sources
  reviewers from the class roster —
  `modules/classroom/ui/manage/grading/[homeworkId]/actions.ts:103` selects from
  `cls_class_members`. `removeClassMember` deletes that row but
  `removeOrgMember` does not, so a student removed from the **org** but still on
  the class roster is **freshly minted** new review assignments on the next
  round, granting a non-member read of a current student's code.

## 5. FOUNDER DECISION FLAGGED (do not bundle it with the fix)

**Consequence for the Jitsi video work happening in parallel (2026-09-04): do
NOT build room authorization on `sd_in_event`.** It answers "is this person in
the event," which is both too broad (a host-ejected participant still passes it,
per the finding below) and about to change. Room-join authority must key on the
specific `sd_pairings` row for the current round — that is the only predicate
that expresses "this person belongs in THIS video room right now."

`sd_in_event` has **no `status` filter at all**. `sd_pin_participant`
(`20260709050000:1103-1145`) exists precisely so a host can flip
`status → 'removed'` for a disruptive attendee — but that removal does not
revoke the event/round read, even for someone still in the org. Adding
`and p.status in ('registered','waitlisted')` is a **separate behavioural
decision** from the org conjunct (it changes what ejection means), so it wants
an explicit answer rather than riding along.

## 6. LOW — recorded, not urgent

- `mm_assignment_covers_me` (`20260709020000:304-320`) — an ex-member of a group
  learns which matchmakers are assigned to it. Staff assignment, not content.
- `sal_owns_customer` / `sal_owns_appointment` / `sal_owns_bill`
  (`20260709030000:475-515`) — same missing conjunct, but every row is the
  caller's OWN history, so no cross-tenant escalation. One wrinkle worth a
  conjunct eventually: `sal_customers_write_operate` places no constraint on
  which uuid staff may write into `sal_customers.user_id`, so a cashier could
  point a walk-in record (with existing notes and history) at any user id,
  including one outside the org.

## CLEAN — demonstrated, not assumed

`cls_class_members` (cured by `20260727010000:352-370`, and **it is the exact
remedy the findings above need** — it reads grants with `is_org_member(c.org_id)`
explicit, and `20260724010000:369` says outright *"the roster survives as a
name/badge store"*); `smp_` (no roster table); `syn_` (no roster table at all);
`mm_interests`; `vm_join_conversation` (`20260709100000:1161-1188` refuses
before inserting — the correct model for a self-join RPC); and the platform
tables `job_requests`, `view_as_sessions`, `activity_events`, plus
`sd_blocks_write_own` (`20260709050000:979-983`) — **all of which conjoin
`is_org_member` explicitly, proving the convention was known and applied
selectively.**

## Adjacent but NOT this bug

Bare `auth.uid()` predicates over **own data only** — `cls_owns_submission`,
`cls_submission_open`, `cls_exam_papers_select`, `cls_survey_answers_select`,
`sd_notes_all_own`, `smp_items_update_own`, `mm_answers`' own arm. Same missing
conjunct, no confidentiality escalation, since the actor is the data subject.
Also `vm_members_select`'s `user_id = auth.uid()` arm survives today's fix by
design (docs/03 #15's bootstrap), so nobody should read `20260904010000` as
total.

## Remediation shape

Every finding takes the same one-line conjunct `20260904010000` used, with the
same justification: each roster carries its own `org_id`, stamped by a
scope-sync trigger (docs/03 #10 — `mm_sync_from_group`/`mm_sync_assignment_org`,
`sd_sync_from_event`, `sal_sync_from_location`, `cls_sync_from_*`), so
`is_org_member(<roster>.org_id)` is server-derived and unspoofable — no join to
the parent needed.

- **8 functions**: `mm_matchmaker_can_see`, `mm_assignment_covers_me`,
  `sd_owns_participant`, `sd_in_event`, `sd_paired_with`, `sd_mentors`,
  `sal_worker_sees_customer`, `cls_reviews_submission`.
- **5 inline policy arms** no function change reaches: `mm_groups_select_assigned`,
  `mm_group_members_select_assigned`, `sal_appointments_select`,
  `sal_appointments_update_worker`, `sal_worker_time_off_select`.
- **2 app write paths**: copy classroom's org-membership check
  (`modules/classroom/ui/manage/actions.ts:66-80`) into `assignMatchmaker` and
  `addGroupMember`.
- **§5's status filter** — ask first.

Four modules, RLS + policies → **Opus, full docs/03 #12 rhythm.** Not a quick
follow-up commit.

**KEEP IT TO THE ONE-LINE CONJUNCT — do not build new mechanism here.**
[docs/15 §4](15-user-model.md) already plans to fold these per-module roster
tables into `module_roles` as proper entity-scoped grants, and that fold would
fix this class *structurally* (grants resolve through the
`module_caller_covers_*` family, which has required active org membership since
`20260727010000`). So this remediation is the stopgap on the way there: add the
conjunct, add the missing tests, and leave the redesign to that slice.

## Two things this audit did NOT establish

- ~~**Whether any of it is live on prod.**~~ **MEASURED 2026-09-04 (Sonnet),
  read-only, `scripts/prod-verify-seat-authority-orphans.mts`
  (`pooler + SUPABASE_DB_PASSWORD`, no app credentials, no writes, local DB
  untouched).** Counted, for each roster, rows whose holder has no `org_members`
  row for that row's org with `status = 'active'` — the exact predicate
  `is_org_member()` uses. **Result: ZERO orphaned rows found, across all 8
  tables, on prod as of 2026-09-04.**

  | table | total rows | orphaned |
  |---|---|---|
  | `sd_participants` | 0 | 0 |
  | `mm_matchmaker_assignments` | 2 | 0 |
  | `mm_group_members` | 0 | 0 |
  | `sal_worker_profiles` | 1 | 0 |
  | `sal_appointments` (worker_id not null) | 2 | 0 |
  | `cls_review_assignments` | 2 | 0 |
  | `cls_class_members` | 3 | 0 |
  | `vm_conversation_members` | 0 | 0 |

  **Control (docs/03 vacuity rule): `org_members` has 30 rows, all `status =
  'active'`, 0 pending** — proves the query engine and the join condition both
  work against real data, so the zero-orphan result is not an artifact of a
  broken read.

  **But read the per-table total, not just the headline zero — three of the
  eight tables (`sd_participants`, `mm_group_members`,
  `vm_conversation_members`) currently hold ZERO rows on prod at all**, so
  their "0 orphaned" is vacuous by the same rule: there is nothing there that
  *could* be orphaned yet, not evidence the class can't occur. The other five
  tables (`mm_matchmaker_assignments`, `sal_worker_profiles`,
  `sal_appointments`, `cls_review_assignments`, `cls_class_members`) hold real
  rows and their zero-orphan result is a genuine, non-vacuous negative.

  **Conclusion: the class is confirmed real (the missing-conjunct finding
  above is unchanged), but as of this measurement it has NOT yet been
  triggered on prod** — no org membership revocation has yet left a roster row
  behind on any table with live data. This is exposure-by-construction, not a
  currently-exploited hole; it will trigger the moment a real `removeOrgMember`
  happens against any of these five populated tables, or once the three
  currently-empty tables gain rows. Re-run the script periodically or before
  the remediation slice ships, since prod data changes underneath this
  snapshot. Script kept in `scripts/` as the durable before/after regression
  check for that remediation.

- A local exploit probe was not run — it would mutate shared local state
  (revoking a seeded user's org membership) mid-session, and the catalog
  evidence above plus the prod measurement are already conclusive as to the
  missing conjunct and its current (non-)exposure. *(An earlier revision of
  this line claimed the probe was skipped because a second session was using
  the local database. That was an assumption stated as fact — no second
  session existed. Corrected 2026-09-04; the docs/03 tally rule applies to a
  doc's own stated reasons, not just its numbers.)*
- **Test coverage.** A targeted grep of `packages/db/src/rls.test.ts` found the
  13 `org_members ... .delete()` call sites are all fixture teardown, not
  assertions — i.e. **no test asserts that a module roster row stops conferring
  authority once org membership ends**, outside the one `20260904010000` adds.
  Stated as a negative result from a targeted search, not a proof of absence.
  Whatever fixes the above should add that assertion per module.

---

# FIXED 2026-09-10 — and a SECOND, NARROWER GAP THE FIX DOES NOT CLOSE

## What shipped

`20260910040000_seat_requires_org_membership.sql` applied the one-line
`public.is_org_member(<roster>.org_id)` conjunct to all 8 functions and all 5
inline policy arms listed above. Verified live: none of the 8 was already cured
(the control — the four `vm_` predicates from `20260904010000` plus
`cls_is_class_member` — came back correctly ORG-GATED, so the method
discriminates). Parse-checked server-side in a rolled-back transaction before
applying. **`packages/db/src/rls.test.ts` now carries 34 tests** covering every
one of the 13 items across all four modules, including the classroom case that
reaches Storage, plus the class-level assertion this audit asked for and a
CI-order guard that fails by name if the block leaves `org_members` dirty.

Two things worth keeping from the build:

- **A boolean predicate can legitimately return NULL, and RLS denies on NULL.**
  Two tests initially failed asserting `.toBe(false)` and receiving `null`:
  `mm_assignment_covers_me` takes a `check_target_user_id` that is *genuinely
  null* for a group-targeted assignment, so `NULL = auth.uid()` makes the whole
  expression `NULL or false` = NULL. That is a correct denial. The assertions are
  now `.not.toBe(true)` with the reasoning inline — a test demanding `false`
  there would have been wrong about how RLS decides.
- **`sd_pin_participant` and `sal_pin_appointment` silently discard
  service-role updates** — both `return old` when `auth.uid()` is null, with no
  error. A fixture that tried to reset state between assertions would have
  passed while testing nothing. The tests are structured around this.

## THE SECOND GAP — revoking a MODULE ROLE does not revoke the seat

**Founder-raised, 2026-09-10, and verified:** *"What if [he] is still part of the
org but no longer part of the module within the org? Is that the same or similar
issue?"*

It is the same class, one level down. Measured against the live catalog after the
fix:

```
mm_matchmaker_can_see    :: is_org_member=1 :: module_role_check=0
mm_assignment_covers_me  :: is_org_member=1 :: module_role_check=0
sd_owns_participant      :: is_org_member=1 :: module_role_check=0
sd_in_event              :: is_org_member=1 :: module_role_check=0
sd_paired_with           :: is_org_member=1 :: module_role_check=0
sd_mentors               :: is_org_member=1 :: module_role_check=0
sal_worker_sees_customer :: is_org_member=1 :: module_role_check=0
cls_reviews_submission   :: is_org_member=1 :: module_role_check=0
```

**Zero of the eight consult the module role.** So an org admin who revokes
someone's speed-dating role — while keeping them in the org — leaves their
`sd_participants` seat fully functional: the live event, their revealed matches
and the shared contact details all still read.

**This is arguably the MORE common revocation.** Removing one module's access is
a smaller, more routine administrative act than removing someone from the
organisation entirely, and it is the one an admin reaches for first.

### The shape of the fix, and why it is NOT a sweep

Every module already has the right predicate, and each one **subsumes**
`is_org_member` (because `has_module_role` requires active org membership since
`20260727010000`), so the conjunct added in `20260910040000` would become
redundant-but-harmless rather than needing removal:

| Module | Predicate to conjoin | Note |
|---|---|---|
| matchmaking | `mm_is_single` / `mm_is_matchmaker` | two different seats, two different roles |
| speed dating | `sd_is_participant` | |
| nail salon | `sal_is_worker` | but `sal_worker_sees_customer` gates the WORKER reading a CUSTOMER — check which side the role belongs to |
| classroom | `cls_is_class_member` | already scope-aware; there is no generic `cls_is_student` |

**The blocking measurement, which must come first:** does every current seat
holder actually hold the corresponding module role? If any seat exists whose
holder has no `module_roles` row, adding this conjunct revokes LIVE access. That
is exactly the check that made `20260910040000` safe (0 orphans across all six
rosters, none vacuous) and it must be repeated for the role dimension before a
line of SQL is written.

**Second thing to decide, not assume:** some seats may legitimately outlive a
role. A salon customer, for instance, is a person with appointments rather than
a role-holder. Do not assume symmetry with the org-membership case.

### Honest caveat on the org-membership fix's own evidence

The zero-orphan result that cleared `20260910040000` is **structurally forced,
not independent**: every one of the 28 `org_members` rows on the local database
is `status = 'active'`, so the orphan count could not have been anything else.
The class is real and simply not yet triggered — consistent with the 2026-09-04
production measurement. The same caveat will apply to the module-role check
unless the data has changed by then.

### Also still open, from the correctness review of `20260910040000`

Four items in the same class, found by the adversarial review, in **neither**
this audit's remediation list nor its "adjacent but NOT this bug" list — so
genuinely unaccounted for rather than consciously deferred:

- **`cls_review_assignments_update_reviewer`** (`reviewer_id = auth.uid() AND
  locked = false`) — the worst of the four, because it is a **WRITE**: an
  offboarded reviewer can no longer *read* the submission but can still write a
  peer grade onto a current student's work. Same shape this audit already
  accepted as in-scope for nail salon's "lingering write".
- **`mm_assignments_select`** — its `matchmaker_id = auth.uid()` arm is bare
  while `20260910040000` gated its sibling arm, so one policy is now half-fixed.
- **`cls_review_assignments_select`** — bare `reviewer_id = auth.uid()` arm.
- **`sd_participants_update_self`** and **`cls_set_preferred_name`** — LOW; the
  pin triggers block the dangerous fields, but an ex-member can still flip
  `checked_in`, edit a profile card paired participants read, or rename
  themselves on a live class roster.

## FOUNDER DECISIONS on the module-role gap, 2026-09-11

**1. FULL SYMMETRY. A seat requires the module role that justifies it — no
per-module exceptions.** Founder: *"Let's try to make as much symmetry as
possible."*

**The salon customer is NOT the counter-example this audit feared.** Verified
live: a customer holds a `module_roles` row like everyone else —

```
frank :: admin    eve   :: cashier    charlie :: customer
alice :: manager  grace :: manager    dana    :: worker
```

So the uniform rule applies to them too. The thing that looked like an exception
is a **different kind of record**: `sal_customers.user_id` is NULLABLE, and a
walk-in with no account has no `user_id` at all — so no predicate keyed on
`auth.uid()` ever touches them. A walk-in is *a record about a person*, not *a
seat held by a user*. Those two were never required to be symmetric.

**2. Related, and the founder's framing is the fix for a gap already on the
books** (the "walk-in salon customers are not findable" item): the schema already
does half of the supermarket-loyalty model — link to a user when we can, else
hold name/phone/email. **What is missing is the moment of matching**: when a
walk-in later signs up, nothing connects their existing history to the new
account. Founder: *"As much as possible, they want to connect me to a user in
their system, existing or new. Shouldn't we match that model?"* → match on email
or phone at signup, offer to link, history follows the person. **Separate work
from this security fix; do not bundle.**

**3. The live WRITE is folded INTO this fix, not deferred.**
`cls_review_assignments_update_reviewer` is `reviewer_id = auth.uid() AND locked
= false`, with no membership or role conjunct, and it gates `submitPeerGrade`.
The pin trigger protects `homework_id` / `reviewer_id` / `submission_id` /
`locked` but leaves `grade` and `grade_submitted_at` writable. So after
`20260910040000` an offboarded student can no longer READ the submission but can
still WRITE a grade onto a current student's work. Founder: *"this obviously
needs to be fixed."* Same migration, same review, same tests.

**4. NOTE THE DISTINCTION the founder raised** — an ex-member and a deleted user
are both "a different type of user", but they are NOT the same mechanism and must
not be merged:

| | Removed from an org / module | Deleted (docs/21) |
|---|---|---|
| Account | still live, still a full user elsewhere | scrubbed to a silhouette |
| Fix | authority must track CURRENT standing (this audit) | identity detached, human-made content kept (docs/21 §7) |

The shared principle is worth stating once: **authority follows current standing,
never past standing.** The two fixes compose — docs/21 §7.4 records that
revoking memberships is only *sufficient* for a silhouette because this audit's
fix made seats inert when membership ends.

## ADJACENT, FOUND 2026-09-10, DESCOPED AND NOT FIXED — `module_roles` reads are ORG-WIDE

Found while planning the seat-authority fix, raised with the founder, then
**descoped mid-session because its fix is blocked on unrelated work.** Recorded
here because it existed only in conversation, and open state that lives only in
a chat is how it gets lost.

**The leak, verified live:**

```
module_roles_select_member :: SELECT :: (is_org_member(org_id) OR is_superadmin())
```

No module filter, no role filter, no self filter — **any active member of an org
reads every `module_roles` row for that org**: `user_id`, `module_key`, `role`,
`scope_ref`. Measured in `demo-match`: 6 active members, 4 of whom hold `single`.
So an org member can enumerate **who is in the dating pool**. It is the same
census shape docs/16 P1-4 names, on a table nothing else guards.

**Why it was NOT fixed, and this is the part worth keeping — the obvious fix
breaks a working page:**

1. Narrowing `module_roles_select_member` to `user_id = auth.uid() OR
   is_superadmin()` **does nothing on its own**, because
   `module_roles_write_org_admin` is `ALL USING is_org_admin(org_id)` and a
   `for all` policy's USING also governs SELECT. So an org admin keeps reading
   the whole table through the other door. Both policies must change together.
2. The natural replacement read path for people who legitimately administer
   grants is `module_has_manager_grant(org_id, module_key)` — which requires
   `module_position_rank(...) >= 2`. **Verified:**

   ```
   matchmaking admin      -> 0
   matchmaking matchmaker -> 0
   visual-messaging admin -> 0
   classroom professor    -> 2
   ```

   Matchmaking, visual messaging and synagogue-schedules were **never
   rank-mapped** — every position is rank 0 — so that predicate is FALSE for a
   matchmaking admin, and narrowing the policy would break
   `modules/matchmaking/ui/manage/page.tsx:48-49` for anyone who administers
   that module without also being an org admin (`mm_can_manage` admits both).

3. The clean fix is therefore **rank-map those three modules first** — which
   CLAUDE.md already records as OPTIONAL, a real behaviour change, and something
   that **will FAIL THE BUILD until every newly-implied view-as pair is
   explicitly answered**. That is its own slice, not a side quest inside a
   security fix.

**Severity, stated honestly rather than inflated:** everyone in `demo-match` is
there *for* matchmaking, so the practical exposure today is low. It is real,
worth fixing, and not urgent — and it is entangled with the Public Square roster
question (docs/20), which is being designed separately.

**Do not attempt this as a one-line policy narrowing.** Either rank-map first, or
design a per-module manage predicate deliberately.

## POST-MIGRATION PROD MEASUREMENT, 2026-09-11 — nobody lost access

Run AFTER `migrate:prod` applied `20260910040000` (it should have been run
BEFORE — see docs/03 #1's NARROWING-vs-SHAPE bullet, added because of this).

```
sd_participants            total=0   orphaned=0      cls_review_assignments   total=2  orphaned=0
mm_matchmaker_assignments  total=2   orphaned=0      cls_class_members        total=3  orphaned=0
mm_group_members           total=0   orphaned=0      vm_conversation_members  total=0  orphaned=0
sal_worker_profiles        total=1   orphaned=0      sal_appointments         total=2  orphaned=0
```

**Zero orphaned rows across all 8 rosters, with 5 of the 8 holding real rows.**
So the narrowing revoked nothing from anyone on production.

### How much that zero actually proves — the precise reading

Prod's `org_members` is **30 rows, ALL `active`** (measured the same day). An
orphan can arise two ways, and the evidence differs for each:

- **Re-invite (status flips to `pending`)** — **impossible on prod today**, since
  no non-active row exists. The zero is STRUCTURALLY FORCED for this path and
  proves nothing about it.
- **Removal (the `org_members` row is DELETED)** — a deleted row leaves no trace
  in that status breakdown, so it does NOT force the result. The orphan probe
  would have caught any seat left behind, and found none. **For this path the
  zero IS genuine evidence: nobody has been removed from an org while holding a
  module seat on production.**

Stated this way because the blunt version ("all active, so the zero is forced")
is wrong in one direction and the flattering version ("zero orphans, so the class
never fired") is wrong in the other. The honest summary: **the removal path is
genuinely clean; the re-invite path is untested on prod and will stay untested
until someone is actually re-invited.**

## CLEAN-ROOM HANDOFF TEST, 2026-09-11 — six gaps a fresh session actually hit

Rather than judging the handoff, it was **tested**: an agent with no session
context was given only "read CLAUDE.md, then docs/19, plan the module-role half"
and asked to report every place it had to guess. Its plan was sound — which is
the good news — but it hit six gaps, listed worst-first. **The technique is worth
reusing: a doc's author cannot audit their own handoff, because they cannot
un-know what it omits.**

### 1. THE TWO APP WRITE PATHS FELL OFF THE LEDGER — genuinely lost state

This audit's "Remediation shape" requires copying classroom's org-membership
check into **`assignMatchmaker`** and **`addGroupMember`**
(`modules/matchmaking/ui/manage/actions.ts`). The 2026-09-10 FIXED header claims
"all 8 functions and all 5 inline policy arms" and then enumerates three open
items — **the write paths are in NEITHER list.** Verified still unguarded: the
resolver takes an arbitrary email through `profiles` and inserts the assignment
with no membership check. A reader of that header would conclude the remediation
is complete but for three named items, and these would vanish. **They are open.**

**RESOLVED — this paragraph is now HISTORY, kept for the lesson not the status
(marker added 2026-09-22).** Both write paths were guarded on 2026-09-14
(`2ef05fc`, app-side, no migration) and the owed RLS test followed the same day
(`53c8a5a`) — it proves a seat minted for someone who was NEVER a member confers
nothing, which is this section's exploit sentence rather than the revocation case
the other tests cover. See open item 4 in the header and the 2026-09-14 section.
The paragraph is not deleted because the *failure* it describes — an item
dropping out of both the FIXED list and the open list, and surviving only
because a clean-room reader went looking — is the reusable part.

### 2. `mm_assignment_covers_me` CANNOT TAKE THE PRESCRIBED ONE-LINE FIX

The module-role table below assigns matchmaking `mm_is_single` /
`mm_is_matchmaker` and says "KEEP IT TO THE ONE-LINE CONJUNCT." But the live
signature is **`(check_matchmaker_id, check_target_group_id, check_target_user_id)`
— there is no `org_id` to pass**, and its first arm is a bare scalar comparison
(`check_target_user_id = auth.uid()`) with nothing to join against. Either the
signature changes (which touches `mm_assignments_select`) or the function joins
`mm_matchmaker_assignments` internally. **Decide which before writing SQL**; the
table as written sends a builder into a wall.

### 3. THE SEAT→ROLE MAPPING IS UNDER-SPECIFIED, AND SPEED DATING IS A TRAP

`sd_participants.seat_type` has **THREE** values — `participant`, `audience`,
`mentor` (`20260709050000:57-59`: observers are rows *with* `seat_type in
('audience','mentor')`, not `participant` rows). The module-role table says
"speed dating → `sd_is_participant`" with a **blank Note**. Applied literally,
that conjunct would **revoke every mentor and audience seat** unless those
holders also carry the `participant` module role — which nothing guarantees and
no local row exists to test against (zero mentor/audience rows seeded, so the
measurement is VACUOUS for them).

Two smaller versions of the same gap: nail salon's Note is *"check which side the
role belongs to"* — an instruction, not an answer (it is the worker side); and
classroom's one-liner works only because `cls_review_assignments` carries
`class_id`, which the table never says.

### 4. THE BLOCKING MEASUREMENT IS MANDATED BUT NOT SCRIPTED

The module-role section says to repeat the orphan check "for the role dimension
before a line of SQL is written" and names the org-dimension script — without
saying whether it extends or what the role query is. The clean-room agent wrote
it from scratch. **Extend `scripts/prod-verify-seat-authority-orphans.mts` with a
role-dimension mode**, or paste the query here, so the next session does not
re-derive it a third time.

### 5. §5 READS AS THOUGH THE 2026-09-11 SYMMETRY DECISION SUBSUMES IT. IT DOES NOT.

The founder decision opens "FULL SYMMETRY … no per-module exceptions," which sits
close enough to §5 (`sd_in_event` has no `status` filter, so host-ejection does
not revoke event reads) to read as having answered it. **It has not: §5 is about
`status`, symmetry is about `role`.** Different axes, and §5 remains a founder
decision. Stated here because the clean-room agent flagged it as something it
would have had to re-ask.

### 6. What the docs got RIGHT, recorded so it is not "improved" away

The agent named these as genuinely sufficient: the class-of-bug statement; the
verification method **with its control**; the `20260727010000` precedent; the
honest "what the prod zero does and does not prove" section; the NULL-denial and
service-role-discarded-by-pin-trigger lessons; and — singled out as the best
thing it found — **`modules/speed-dating/src/video/authorize.ts` carrying an
inline LANDMINE comment citing docs/19 §5.** That comment is the only place a doc
reached the code *before* the code needed it. More of that.

## 2026-09-14 — open item 4 (the app write paths) fixed, no migration

`assignMatchmaker` and `addGroupMember`
(`modules/matchmaking/ui/manage/actions.ts`) now both verify the resolved
user is an ACTIVE member of the target org before inserting the
`mm_matchmaker_assignments` / `mm_group_members` row — copied from
`modules/classroom/ui/manage/actions.ts:66-80` and
`modules/visual-messaging/ui/actions.ts:181-192`, same shape and same error
message ("add them as an org member first (and they must have accepted the
invite)"). A shared `resolveOrgMemberUserId` helper replaced the bare
`resolveUserId` call at both mint sites; `addGroupMember` additionally now
looks up the target group's `org_id` first (it previously relied entirely on
`mm_sync_from_group` to derive it, with nothing read app-side).

Checked before pushing whether any existing fixture assigns a matchmaker or
group member to a non-active-org-member: **none does.**
`apps/web/e2e/platform.spec.ts`'s groups/assignment block
(around line 636) adds `eve@demo.local` to a group and assigns
`mel@demo.local` as matchmaker — both are seeded as `active` `org_members` of
`demo-match` (`packages/db/src/seed.ts:591-597`). `packages/db/src/seed.ts`'s
own two seeded `mm_matchmaker_assignments` rows (`:668-671`) insert directly
via the service-role `admin` client, bypassing this action entirely, so they
are unaffected either way. No fixture needed changing.

Verified with `pnpm exec turbo run typecheck --concurrency=1 --force`: 9/9
clean. The RLS suite and db-backed verification were NOT run — another
session held the database per this session's instructions; CI carries its own
database and is the verification of record for this change.

**OWED test above — DONE 2026-09-14, once the database and `rls.test.ts` were
free.** Two new `it()`s in the existing `seat authority: a module roster row
requires ACTIVE org membership` describe block in `packages/db/src/rls.test.ts`
(matchmaking section), using `bob@demo.local` — admin of Demo Org B, never a
`demo-match` member at all. Deliberately a DIFFERENT scenario from every test
above it: those all prove the conjunct denies access AFTER a real membership
is revoked; these two prove it denies a seat minted for someone who was NEVER
a member — docs/19 §1's literal exploit sentence ("someone who shares only
org B with him"), not the revocation case. Both freshly INSERT a
`mm_matchmaker_assignments` row via the service-role client (bob as
matchmaker, over charlie individually and over the fixture group), then
assert bob's own RLS client reads nothing — `mm_answers`, `mm_pair_scores`,
`mm_matchmaker_can_see`, `mm_groups`, `mm_group_members` all empty/false —
with non-vacuity controls (the row exists, charlie's data exists), cleaned up
in a `finally`. **Worth stating plainly: RLS itself does NOT block the
INSERT** — `mm_can_manage` is a broad staff write policy with no
target-membership check, so the insert succeeds exactly as it would for a
real member. The only thing that stops this seat from ever being minted in
practice is the app-level `resolveOrgMemberUserId` check shipped earlier this
session. These two tests prove the second layer: if that app check is ever
bypassed, weakened, or has a bug, the SQL-side conjunct still makes the seat
worthless. Verified: db suite 206/206 (204 baseline + 2), typecheck clean,
then pushed and confirmed green on the actual CI run — see the commit for the
run id.

## 2026-09-15 — THE MODULE-ROLE HALF, SHIPPED AND PROD-VERIFIED (`20260915010000`)

Open items 1 and 2 are closed for three of the four modules, in one migration,
with the four previously-unaccounted-for findings folded in per founder decision
3. **CI-green, then applied to production the same day and verified there** —
so this one satisfies the 2026-09-11 correction (nothing is "shipped" until
`migrate:prod` has run AND prod verification passed) rather than tripping it.

**Prod verification, both halves:**
- `scripts/prod-verify-module-role.mts` — **85/85, 0 failures.** NEW script,
  written because `prod-verify-migration.ts` parses `create function` blocks
  only and this migration is mostly POLICIES (nine of them), so a function-only
  run would have reported "0 failures" while asserting nothing about them.
- `prod-verify-migration.ts` — **0 failures, 0 warnings**, all five function
  bodies md5-matching, `definer`, `search_path=public`, `anon=no`.
- **The before/after is the actual evidence, not the pass.** The same policy
  script scored **18 FAILURES against prod before the apply** (naming each
  missing conjunct) and **85/85 after**, with every CONTROL passing in both
  runs — so the failures were genuine absences and the passes are a genuine
  change of state, not a script that always agrees with itself.
- **Data half on prod: 0 seats lost access** (2/2/2 rows across the three
  rosters, every holder holding the now-required role).

One cosmetic scare worth recording so the next `migrate:prod` is not misread:
the push printed a long `pgdelta` stack trace about a missing
`pgdelta-target-ca.crt`. It is prefixed **"Warning: failed to cache migrations
catalog"** — the CLI failing to write its own local catalog cache, AFTER
`Applying migration ...` and before `Finished supabase db push`. The migration
applied fine; the verification above is what proved it.

### What changed

Four predicates gained the role conjunct — `mm_matchmaker_can_see`
(+`mm_is_matchmaker`), `mm_assignment_covers_me`'s GROUP arm (+`mm_is_single`),
`sal_worker_sees_customer` (+`sal_is_worker`), `cls_reviews_submission`
(+`cls_is_class_member`) — plus five policies: `mm_assignments_select`'s bare
matchmaker arm, the two inline matchmaking group arms
(`mm_groups_select_assigned`, `mm_group_members_select_assigned`), the three
salon worker arms, `cls_review_assignments_select`, and **the live WRITE
`cls_review_assignments_update_reviewer`**. `cls_set_preferred_name` gained an
ORG conjunct (see below). `sd_participants_update_self` gained the org conjunct
it never had.

### The blocking measurement is now SCRIPTED, not ad hoc

Clean-room finding #4 asked for exactly this.
`scripts/prod-verify-seat-authority-orphans.mts` gained a **ROLE dimension** and
a **`--local` mode**, so the mapping is reviewable in one place and re-runnable
before the next migration instead of being re-derived a third time. It encodes
the seat→role mapping explicitly, including the three different scope semantics.
**Result, PROD and LOCAL identical: 0 would-lose-access.** Caveat kept in view:
`mm_group_members` and `sd_participants` are EMPTY on both databases, so two of
six mappings rest on reading code, not on data. The script carries a control
asserting at least one row POSITIVELY holds its mapped role, so a clean sheet
cannot be a silently broken join.

### GLOBAL vs SCOPED is a cliff, and it nearly shipped a regression

`has_module_role` requires `scope_ref is null`. So `mm_is_*` and
`sd_is_participant` are **global-only**, `sal_is_worker` ignores scope, and
`cls_is_class_member` requires scope COVERAGE. **Both adversarial reviewers
independently caught the same latent false revocation from opposite
directions:** the draft gated `cls_set_preferred_name` on
`cls_is_class_member`, and classroom STAFF hold GLOBAL grants — so a professor
who sits on her own class roster would have silently lost the ability to set her
own preferred name, with no error, because the function is `returns void`.
Verified live: alice is a `cls_class_members` row with role `professor` and a
global grant, and the predicate is false for her.

**The trap inside the trap, worth keeping:** `module_scope_covers(NULL, node)`
returns **TRUE** — a global grant does cover everything — so the exclusion comes
from the explicit `scope_ref is not null` filter, NOT from coverage failing.
Reading coverage alone would tell you the opposite of the truth. That is now
pinned by a test ("PIN: a PROFESSOR can still rename herself").

### A CORRECTION to this audit's own §"Also still open": `sd_participants_update_self` was already blocked

The policy really was bare (`user_id = auth.uid()`, no org conjunct), but the
hole was **not reachable**, and the reason is mechanical rather than lucky:
`sd_sync_from_event` is a BEFORE INSERT OR UPDATE trigger that re-derives
`org_id` by SELECTing `sd_events`, and it is **NOT `security definer`** — so once
the caller loses org membership no `sd_events_select` arm matches for them, the
select finds nothing, and the trigger raises `Unknown event` before the policy is
ever the deciding factor. Found by the test failing in an unexpected WAY, not by
reading. **This is the same mechanism recorded for visual messaging's
`vm_members_scope`** (CLAUDE.md: a non-definer scope-sync trigger silently
becomes an access check) — and unlike visual messaging there is no
`created_by`-style carve-out, so it blocks uniformly. The org conjunct added here
is therefore **defence in depth, not the closing of a live hole.** The test
accepts either refusal shape and asserts the row does not move.

### STILL OPEN after this migration

1. **FOUNDER DECISION — speed dating's role conjunct.**
   `sd_participants.seat_type` is `participant | audience | mentor`, and **there
   is no audience or mentor module role** (speed-dating has only `organizer` and
   `participant`). So requiring `sd_is_participant` on `sd_owns_participant` /
   `sd_in_event` / `sd_paired_with` would revoke every audience and mentor seat,
   and `sd_mentors` keys on `seat_type = 'mentor'` explicitly, where requiring
   `participant` would be simply wrong. Nothing breaks TODAY: `sd_participants`
   is empty everywhere and **no app code sets `seat_type` at all** (grepped:
   zero non-test matches), so audience/mentor is schema-only and unbuilt. But an
   organizer CAN already mint any `seat_type` for anyone via
   `sd_participants_write_organize`, with no requirement that the holder hold any
   speed-dating role. **The question: what role justifies an audience or mentor
   seat — a new role per seat type, "any speed-dating role", or does the seat
   genuinely stand alone for observers?** Answering it is a prerequisite for the
   audience/mentor observer surface, which is already on module 6's list.
2. **The vm/conversation last-admin floor** — handed over by the Public Square
   session. **RE-VERIFIED STILL OPEN 2026-09-22**: neither
   `public.vm_pin_member` nor `public.vm_guard_last_conversation_admin` (the
   `20260914020000` DELETE guard) mentions `is_org_member` anywhere in its body.
   Both count the floor with the identical predicate:
   ```sql
   where conversation_id = old.conversation_id
     and role = 'admin' and status = 'active' and id <> old.id
   ```
   **THE CONCRETE FAILURE, spelled out because the mechanism alone does not
   convey it.** A conversation has two admins, Alice and Bob. Bob leaves the org.
   Since `20260910040000` Bob's seat confers *nothing* — he cannot read or do
   anything in that conversation. But the floor still COUNTS him, so Alice, the
   only effective admin, is allowed to leave. **What you are left with is a
   conversation whose sole remaining "admin" cannot administer it**: nobody can
   add a member, rename it, or moderate it. The guard that exists precisely to
   prevent orphaning is what permits it.
   **The fix is one conjunct in two places** — but note it makes the guard fire
   MORE often, so someone who could previously leave now cannot. That is a
   user-visible behaviour change, which is why it wants its own migration,
   review and tests rather than riding along with a read-side fix.
   **Read docs/03 #23 before touching either function.** These are trigger
   functions carrying `pg_trigger_depth()` cascade escapes and a self-block
   carve-out; `vm_pin_member`'s status pin is what makes self-block work, and
   `20260914020000`'s header explicitly warns against "tidying" it to
   `security definer`, which would remove the platform's only user-level block.
   Different failure mode from the rest of this audit (lockout, not
   confidentiality) — same class of cause.
3. **`cls_set_preferred_name`'s remaining half:** an unenrolled-but-still-in-org
   member who is still listed on a roster can still rename themselves on it.
   Needs `class member OR class manager`, i.e. two predicates and an `org_id`
   derivation the function does not have — new mechanism, which this remediation
   explicitly rules out. Also still `returns void`, so a refusal is silent; there
   are zero app callers today, and docs/03 #22's `{ok, reason}` convention
   applies if one is ever added.
4. **§5's status filter on `sd_in_event`** — unchanged, still a founder decision.

### THREE LATENT FRAGILITIES, recorded rather than "fixed"

None is live (each needs a row that does not exist), but each turns a working
feature off SILENTLY if that row appears:

1. **One scoped matchmaker grant would kill that matchmaker's whole console.**
   `mm_is_matchmaker` is global-only; matchmaking has no scoped-grant UI at all,
   so every grant is global today. The admin's `mm_can_manage` FOR ALL arm would
   NOT save them — they are not an admin.
2. **A GA ever assigned as a peer reviewer loses the reviewer arm** on both the
   select and the update, because classroom staff grants are global.
   §3.1–3.3 are safe only BY CONSTRUCTION: reviewers are drawn exclusively from
   `cls_class_members` rows with role `student`
   (`grading/[homeworkId]/actions.ts:103`) and `enrollClassMember` always mints a
   CLASS-SCOPED grant (`manage/actions.ts:92`). Staff are unaffected today
   because they read and write through the separate `cls_can_manage_class` /
   `cls_*_write_staff` arms.
3. **`sal_appointments.worker_id` FKs to `auth.users`, not to
   `sal_worker_profiles`**, and holding a worker profile does not require the
   `worker` role — only the dropdown constrains it. A manager or cashier
   assigned as `worker_id` survives only via `sal_can_operate_location`; grace
   (manager scoped to Uptown) assigned at another location would lose both the
   read and the write.

### Verification

Adversarial review: two independent narrow reviewers (per CLAUDE.md's lesson
that one broad review agent dies on session limits), each run against the LIVE
database BEFORE the migration was applied anywhere — which is why the migration
file had to be reviewed before `db reset`, since applying it first would have
erased the "before" they were comparing to. Both simulated every affected
predicate as every seeded user, old expression vs new: **zero row-count deltas
for all eight seeded users across all seven seat surfaces.** Three findings were
acted on: the two missing inline group arms (§1.4/1.5, added), the
`cls_set_preferred_name` regression (rewritten), and the three fragilities
(recorded). **13 new RLS tests**, every one asserting org membership is still
ACTIVE during a role-only revocation — without that assertion a passing negative
could just be `20260910040000` working. Pre-migration 8 of them FAIL (teeth);
the two PINs pass before and after by design. The block's CI-ORDER GUARD gained a
second test asserting `module_roles` is byte-identical to its pre-block
snapshot, **including `scope_ref`** — a scoped grant restored as global is a
WIDER grant wearing the right name, and a presence-only check misses it.
Verified in CI's exact order on one database with no reset: **db 217/217 → e2e
52/52**, typecheck 9/9, clean build. Ratchet floor raised 200 → 211.
