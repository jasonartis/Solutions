# Seat authority audit — a module roster row outlives the org membership that justified it

**Status: FINDINGS, VERIFIED, NOT FIXED. Produced 2026-09-04 (Opus) as a
follow-on to `20260904010000`, which fixed one instance of this class in
visual messaging. Eight SQL functions and five inline policy arms across FOUR
modules are still affected. Nothing here is a founder decision except one
flagged item (§5); the rest is straightforward remediation awaiting a
session.**

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

## Two things this audit did NOT establish

- **Whether any of it is live on prod.** That needs read-only row counts: are
  there `sd_participants` / `mm_matchmaker_assignments` / `sal_appointments.worker_id`
  rows whose holder has no active `org_members` row? Cheap; the
  `scripts/prod-verify-*.mts` pooler template fits. **Not run.** A local exploit
  probe was also deliberately not run, because a second session was using the
  shared local database at the time.
- **Test coverage.** A targeted grep of `packages/db/src/rls.test.ts` found the
  13 `org_members ... .delete()` call sites are all fixture teardown, not
  assertions — i.e. **no test asserts that a module roster row stops conferring
  authority once org membership ends**, outside the one `20260904010000` adds.
  Stated as a negative result from a targeted search, not a proof of absence.
  Whatever fixes the above should add that assertion per module.
