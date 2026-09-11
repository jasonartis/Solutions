# Notes — `20260910040000_seat_requires_org_membership.sql`

**DRAFT. Not applied. Nothing was run against the database except read-only
catalog queries (`pg_proc`, `pg_policies`, `pg_trigger`,
`information_schema.columns`, `pg_get_functiondef`).** No `db reset`, no seed,
no tests, no writes.

Spec: [`docs/19-seat-authority-audit.md`](../../docs/19-seat-authority-audit.md).
Exemplar: `20260904010000_vm_seat_requires_org_membership.sql`.

---

## 0. Method and its control

Every body and every policy expression below was read from the **live catalog**
of `supabase_db_Solutions_Platform`, never from the migration file that first
defined it — docs/19 and docs/03 both record that a function can be silently
cured by a later `create or replace` (`cls_is_class_member` reads as vulnerable
in `20260708010000:371-383` and was cured by `20260727010000:352-370`), so a
single-migration grep produces false positives.

Classification query (docs/19's own, re-run 2026-09-10):

```sql
select p.proname,
       case when pg_get_functiondef(p.oid) ilike '%is_org_member%'
              or pg_get_functiondef(p.oid) ilike '%is_org_admin%'
              or pg_get_functiondef(p.oid) ilike '%has_module_role%'
            then 'ORG-GATED' else 'BARE ROW' end
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in (...);
```

### Control result — the method discriminates

| function | expected | live result |
|---|---|---|
| `vm_is_conv_member` | fixed by `20260904010000` | **ORG-GATED** |
| `vm_can_post` | fixed by `20260904010000` | **ORG-GATED** |
| `vm_can_moderate` | fixed by `20260904010000` | **ORG-GATED** |
| `vm_is_conv_admin` | fixed by `20260904010000` | **ORG-GATED** |
| `cls_is_class_member` | cured by `20260727010000` | **ORG-GATED** |

All five known-cured predicates return ORG-GATED; all eight targets return BARE
ROW. A green result on the targets is therefore a property of the targets, not
of a broken query. (This also confirms the local database has `20260904010000`
applied, so the "not previously fixed" verdicts below are read against an
up-to-date catalog.)

### Headline

**NONE of the eight functions was found already fixed. The count stands at
8 functions + 5 inline policy arms = 13 items, exactly as docs/19 states.**

### Supporting facts verified live

- **`org_id` exists on every roster table touched**: `mm_matchmaker_assignments`,
  `mm_group_members`, `mm_groups`, `sd_participants`, `sd_pairings`,
  `sal_appointments`, `sal_worker_profiles`, `sal_worker_time_off`,
  `cls_review_assignments`. So the one-line conjunct never needs a join to the
  parent.
- **Every one of those tables carries a BEFORE INSERT OR UPDATE scope-sync
  trigger** (`pg_get_triggerdef`), which is what makes `org_id` server-derived
  and unspoofable rather than caller-supplied:
  `mm_assignments_scope → mm_sync_assignment_org`,
  `mm_group_members_scope → mm_sync_from_group`,
  `sd_participants_scope → sd_sync_from_event`,
  `sd_pairings_scope → sd_pairings_before_write`,
  `sal_appointments_scope → sal_appointments_before_write`,
  `sal_worker_profiles_scope → sal_sync_from_location`,
  `sal_worker_time_off_scope → sal_sync_from_worker_profile`,
  `cls_review_assignments_scope → cls_sync_from_homework`.
- **EXECUTE ACLs, captured before drafting** — all eight are identically
  `postgres=X/postgres, authenticated=X/postgres, service_role=X/postgres`.
  `create or replace` preserves `proacl`, and the migration adds no `grant` or
  `revoke`, so `authenticated` keeps EXECUTE on all eight (required: each is
  named in an RLS policy, and policy expressions are permission-checked as the
  querying role — docs/03 #17).
- **No overloads.** The eight names resolve to exactly eight `pg_proc` rows, so
  each `create or replace` targets a unique signature.
- **Attributes restated, each checked against the live definition.** All eight
  are live as `LANGUAGE sql / STABLE / SECURITY DEFINER / SET search_path TO
  'public'`, and all eight replacements restate exactly that (a replace does not
  inherit them).
- **`is_org_member(uuid)`** is `sql / stable / security definer / search_path =
  public`, and its body is `org_members` where `user_id = auth.uid() and status
  = 'active'` — i.e. the conjunct denies both a deleted seat and a `pending`
  re-invite, which is the whole point.
- **Policy replacement form.** `pg_policies` shows all five live with
  `roles = {public}` and `permissive`. The repo has **zero** uses of `alter
  policy`; the established convention is `drop policy X on T; create policy X on
  T ...` (e.g. `20260726010000:288`, `:316`), which the migration follows, with
  no `to` clause so the roles stay PUBLIC.
- **Timestamp ordering, re-checked at drafting time.** The last *committed*
  migration is `20260904010000`, but the migrations directory also holds
  `20260910030000_vm_self_block.sql` — an **unapplied, untracked draft from a
  CONCURRENT session** (it touches only `vm_` predicates: no overlap with any of
  these thirteen). This migration is therefore numbered **`20260910040000`** so
  it sorts after everything present, committed or not. Neither draft is applied:
  `supabase_migrations.schema_migrations` tops out at `20260904010000` locally.
  **If the other session's file lands with a different timestamp, re-check this
  before applying.**

---

## 1. Per-item evidence (8 functions)

### 1.1 `mm_matchmaker_can_see(check_org_id uuid, check_single_id uuid)` — BARE ROW

**Live body (before):**
```sql
select exists (
  select 1
  from public.mm_matchmaker_assignments a
  where a.org_id = check_org_id
    and a.matchmaker_id = auth.uid()
    and ( a.target_user_id = check_single_id
          or ( a.target_group_id is not null
               and exists ( select 1 from public.mm_group_members gm
                            where gm.group_id = a.target_group_id
                              and gm.user_id = check_single_id ) ) )
);
```
**Change:** one conjunct `and public.is_org_member(a.org_id)` after the
`matchmaker_id` predicate. Nothing else.

**Gates:** `mm_answers_select` (the assigned single's full intimate
questionnaire), `mm_pair_scores_select`.

*Note:* since `a.org_id = check_org_id` is already asserted, `is_org_member(a.org_id)`
and `is_org_member(check_org_id)` are equivalent here. `a.org_id` is used
deliberately — it is the roster row's own trigger-stamped column, which is the
form the remediation shape specifies and the form that stays correct if the
`check_org_id` predicate is ever relaxed.

### 1.2 `mm_assignment_covers_me(uuid, uuid, uuid)` — BARE ROW

**Live body (before):**
```sql
select check_target_user_id = auth.uid()
    or ( check_target_group_id is not null
         and exists ( select 1 from public.mm_group_members gm
                      where gm.group_id = check_target_group_id
                        and gm.user_id = auth.uid() ) );
```
**Change:** `and public.is_org_member(gm.org_id)` inside the group branch only.

**Gates:** `mm_assignments_select` — which matchmakers are assigned to me / to a
group I am in (docs/19 §6 rates it LOW: staff assignment, not content).

**Where the one-line conjunct is NOT applicable:** the first branch,
`check_target_user_id = auth.uid()`. It is the caller reading their own coverage
(docs/19 "Adjacent but NOT this bug"), and the function has no org in scope on
that branch — there is no `org_id` to test without adding a parameter, i.e.
new mechanism. Left verbatim, noted in the migration header.

### 1.3 `sd_owns_participant(check_participant_id uuid)` — BARE ROW

**Live body (before):** `sd_participants p where p.id = check_participant_id and
p.user_id = auth.uid()`.
**Change:** `and public.is_org_member(p.org_id)`.

**Gates:** `sd_participants_select`, `sd_interest_select` / `_insert_own` /
`_update_own`, `sd_matches_select` (revealed mutual matches **with shared
contact details**), `sd_reports_select` / `_insert_own`.

**Behavioural consequence worth naming at review** (not a reason to change the
fix): `sd_reports_insert_own` is a *safety report* insert. After this migration
a participant whose org membership has been revoked can no longer file one. That
is the correct reading of "you are no longer in this org," and it matches how
every `module_roles`-derived path has behaved since `20260727010000` — but it is
a real product-visible edge (someone ejected *because* of an incident loses the
ability to report it), so it should be stated to the founder rather than
discovered later. It is **not** the §5 question and does not block this
migration.

### 1.4 `sd_in_event(check_event_id uuid)` — BARE ROW

**Live body (before):** `sd_participants p where p.event_id = check_event_id and
p.user_id = auth.uid()` — **no `status` filter of any kind.**
**Change:** `and public.is_org_member(p.org_id)` **and nothing else.**

**Gates:** `sd_events_select`, `sd_rounds_select` (the live round clock),
`sd_participants_select`, `sd_pairings_select`.

**Deliberately out of scope:** docs/19 §5's `and p.status in
('registered','waitlisted')`. It changes what host-ejection *means*
(`sd_pin_participant`, `20260709050000:1103-1145`, exists to flip
`status → 'removed'`), which is a founder decision and orthogonal to the
offboarding bug this migration fixes. The absence of the status filter is
preserved exactly.

### 1.5 `sd_paired_with(check_participant_id uuid)` — BARE ROW

**Live body (before):**
```sql
select exists (
  select 1
  from public.sd_pairings pr
  join public.sd_participants me on me.user_id = auth.uid()
  where (pr.participant_a_id = check_participant_id and pr.participant_b_id = me.id)
     or (pr.participant_b_id = check_participant_id and pr.participant_a_id = me.id)
);
```
**Change:** `public.is_org_member(me.org_id)` added as a leading conjunct, with
the two-way pairing test parenthesised so the `or` still binds only to itself.
**This parenthesisation is load-bearing** — appended without it, `and ... or ...`
would leave the second disjunct ungated. The two disjuncts are otherwise
character-identical to the live body.

**Gates:** the counterparty's `sd_participants_select` (their opt-in profile card
and pool side), plus interest/match arms.

**Where the one-line conjunct is SUFFICIENT but not COMPLETE — flagged, not
fixed:** the join `me on me.user_id = auth.uid()` is scoped to nothing but the
caller — no event, no org correlation with `pr`. So *any* participant row the
caller holds, in any event in any org, can satisfy the join, and the pairing row
`pr` is never required to be in the same org as `me`. After this change the
caller must at least be an active member of *some* org in which they hold a
participant row; a tighter form would also require `pr.org_id = me.org_id` (and
arguably `pr.round_id`'s event to match). That is a second predicate, i.e. new
mechanism, and docs/19 explicitly says keep it to the one-line conjunct — so it
is **recorded here as pre-existing looseness, unchanged by this migration**, and
belongs either in the docs/15 §4 roster fold or its own reviewed change.

### 1.6 `sd_mentors(check_participant_id uuid)` — BARE ROW

**Live body (before):** `sd_participants m where m.mentee_participant_id =
check_participant_id and m.user_id = auth.uid() and m.seat_type = 'mentor'`.
**Change:** `and public.is_org_member(m.org_id)`.

**Gates:** the mentor's read of their mentee's participant row and the
mentee-scoped interest/match arms.

### 1.7 `sal_worker_sees_customer(check_customer_id uuid)` — BARE ROW

**Live body (before):** `sal_appointments a where a.customer_id =
check_customer_id and a.worker_id = auth.uid()`.
**Change:** `and public.is_org_member(a.org_id)`.

**Gates:** `sal_customers_select` — the customer's `full_name, phone, email,
notes`.

### 1.8 `cls_reviews_submission(check_submission_id uuid)` — BARE ROW

**Live body (before):**
```sql
select exists (
  select 1 from public.cls_review_assignments
  where submission_id = check_submission_id
    and reviewer_id = auth.uid()
);
```
**Change:** table aliased `ra` (the live body has no alias) and
`and public.is_org_member(ra.org_id)` added. The alias is cosmetic — unqualified
`org_id` would resolve to the same column — but it makes the new conjunct's
subject explicit and guards against a future column collision. No other change.

**Gates:** `cls_submissions_select`, `cls_submission_files_select`,
`cls_review_comments_insert_own`, and — verified live in the `storage` schema —
`storage.objects`' `cls_submissions_storage_read` (SELECT), so the **actual
submission files are downloadable by path**, not merely the row readable. This
is the only item in the set that reaches Storage.

---

## 2. Per-item evidence (5 inline policy arms)

Read from `pg_policies`, not from files. All five are PERMISSIVE with
`roles = {public}`.

### 2.1 `mm_groups_select_assigned` on `mm_groups` (SELECT)

**Live `qual` (before):**
```sql
EXISTS (SELECT 1 FROM mm_matchmaker_assignments a
        WHERE a.target_group_id = mm_groups.id AND a.matchmaker_id = auth.uid())
```
**Change:** `and public.is_org_member(a.org_id)`.

### 2.2 `mm_group_members_select_assigned` on `mm_group_members` (SELECT)

**Live `qual` (before):**
```sql
EXISTS (SELECT 1 FROM mm_matchmaker_assignments a
        WHERE a.target_group_id = mm_group_members.group_id AND a.matchmaker_id = auth.uid())
```
**Change:** `and public.is_org_member(a.org_id)`. Gates the group's **entire
roster of user_ids**.

### 2.3 `sal_appointments_select` on `sal_appointments` (SELECT)

**Live `qual` (before):**
```sql
sal_can_operate_location(org_id, location_id)
OR (worker_id = auth.uid())
OR sal_owns_customer(customer_id)
```
**Change:** the middle disjunct becomes
`(worker_id = auth.uid() and public.is_org_member(org_id))`. The first disjunct
already resolves through `sal_can_operate_location` (org-gated since
`20260727010000`); the third is the customer's own history — docs/19 §6, LOW,
own-data — and is preserved verbatim. `org_id` is `sal_appointments`' own
trigger-stamped column.

### 2.4 `sal_appointments_update_worker` on `sal_appointments` (UPDATE)

**Live (before):**
```sql
USING      ((worker_id = auth.uid()) AND (state = ANY (ARRAY['checked_in','in_progress'])))
WITH CHECK ((worker_id = auth.uid()) AND (state = ANY (ARRAY['checked_in','in_progress','complete','no_show'])))
```
**Change:** `and public.is_org_member(org_id)` added to **both** USING and WITH
CHECK. The state lists are unchanged. This is the only **write** in the set — an
ex-stylist can otherwise still advance state and write `notes` on any of her old
appointments still in `checked_in`/`in_progress`.

*Both* clauses must be patched: USING alone would still let a non-member's UPDATE
pass its check if the row were reachable another way, and WITH CHECK alone would
not stop the row from being selected for update. Neither is redundant.

### 2.5 `sal_worker_time_off_select` on `sal_worker_time_off` (SELECT)

**Live `qual` (before):**
```sql
sal_can_operate_location(org_id, location_id)
OR EXISTS (SELECT 1 FROM sal_worker_profiles w
           WHERE w.id = sal_worker_time_off.worker_profile_id AND w.user_id = auth.uid())
```
**Change:** `and public.is_org_member(w.org_id)` inside the EXISTS. `w.org_id`
is stamped by `sal_sync_from_location`. The operate arm is preserved verbatim.

---

## 3. Items where the one-line conjunct is NOT sufficient or NOT applicable

Summarised in one place, since these are the review-worthy exceptions:

1. **`mm_assignment_covers_me`, first branch** (`check_target_user_id =
   auth.uid()`) — NOT APPLICABLE. Own-data; no org in scope without adding a
   parameter. Left verbatim.
2. **`sd_paired_with`'s unscoped `me` join** — the conjunct is applied and is
   correct, but does NOT close the pre-existing looseness that `pr` and `me` are
   never required to share an org/event. Recorded, not fixed (would be a second
   predicate).
3. **`sd_in_event`'s missing `status` filter** — deliberately out of scope,
   docs/19 §5, FOUNDER DECISION.
4. **Classroom's second-order re-mint path** — the conjunct denies the *access*,
   but `moveToPeerReview`
   (`modules/classroom/ui/manage/grading/[homeworkId]/actions.ts:103`) still
   *mints* review assignments for a student who is off the org but still on
   `cls_class_members`. Those rows will now be inert, which is the right
   outcome, but the app keeps creating them. Worth a follow-up filter on that
   select; not part of this SQL.
5. **docs/19 §6 LOW items, all deliberately excluded**: `sal_owns_customer` /
   `sal_owns_appointment` / `sal_owns_bill`, and the own-data arms
   `cls_owns_submission`, `cls_submission_open`, `cls_exam_papers_select`,
   `cls_survey_answers_select`, `sd_notes_all_own`, `smp_items_update_own`,
   `mm_answers`' own arm. Same missing conjunct, but the actor is the data
   subject, so no cross-tenant escalation. Also excluded: §6's separate wrinkle
   that `sal_customers_write_operate` places no constraint on which uuid staff
   may write into `sal_customers.user_id` — a *different* bug (an unconstrained
   write, not a stale seat) that must not ride along.
6. **`vm_conversations_select`'s `created_by = auth.uid()` arm** — already
   recorded as the known, deliberate remainder of `20260904010000` (load-bearing
   for the creator's own `INSERT ... RETURNING` bootstrap, docs/03 #15).
   Unchanged.

---

## 4. The two app write paths (docs/19 "2 app write paths") — NOT edited

Both live in `modules/matchmaking/ui/manage/actions.ts`. Neither file was
modified; this section states exactly what to add.

### The precedent to copy — `modules/classroom/ui/manage/actions.ts:66-80`

```ts
  // The target must be a member of THIS org (review Note 4): the email lookup
  // above resolves anyone sharing ANY org with the caller, so verify org
  // membership before minting a classroom grant — otherwise a non-member could
  // be enrolled and read class content via the grant-based RLS. (Readable to
  // the caller: org_members_select_member lets any org member read the roster.)
  const { data: member } = await supabase
    .from('org_members')
    .select('user_id')
    .eq('org_id', klass.org_id)
    .eq('user_id', profile.user_id)
    .eq('status', 'active')
    .maybeSingle()
  if (!member) {
    throw new Error(`No user found with email ${email} in this organization — add them as an org member first (and they must have accepted the invite)`)
  }
```

### The shared hole — `resolveUserId` (`:92-100`)

```ts
async function resolveUserId(supabase: Awaited<ReturnType<typeof createClient>>, email: string) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('user_id')
    .eq('email', email.trim().toLowerCase())
    .maybeSingle()
  if (!profile) throw new Error(`No user with email ${email}`)
  return profile.user_id as string
}
```

It resolves an arbitrary email through `profiles`, which under
`profiles_select_shared_org` means **anyone sharing *any* org with the caller** —
exactly the shape vm's `addMember` had. That is a bound on who can be *named*,
not on what the resulting seat exposes.

### 4a. `assignMatchmaker` (`:143-163`) — current code

```ts
  const supabase = await createClient()
  const orgId = await resolveOrgId(supabase, orgSlug)
  const matchmakerId = await resolveUserId(supabase, matchmakerEmail)
  const targetUserId = targetType === 'individual' ? await resolveUserId(supabase, targetEmail) : null

  const { error } = await supabase.from('mm_matchmaker_assignments').insert({
    org_id: orgId, // group-target rows get this overwritten by mm_sync_assignment_org
    matchmaker_id: matchmakerId,
    target_type: targetType,
    target_user_id: targetUserId,
    target_group_id: targetType === 'group' ? targetGroupId : null,
  })
```

**Guard to add** — after the two `resolveUserId` calls and before the insert.
`orgId` is already in scope. **Both** resolved ids need checking, not just the
matchmaker: `targetUserId` is the person whose questionnaire gets exposed.

```ts
  // The email lookups above resolve anyone sharing ANY org with the caller
  // (profiles_select_shared_org), so verify org membership before minting an
  // assignment — otherwise a non-member becomes a matchmaker over this org's
  // singles, or an outsider is made a "target" of it. Mirrors the classroom
  // guard (modules/classroom/ui/manage/actions.ts:66-80).
  for (const [label, userId] of [
    ['Matchmaker', matchmakerId],
    ...(targetUserId ? [['Target single', targetUserId] as const] : []),
  ] as const) {
    const { data: member } = await supabase
      .from('org_members')
      .select('user_id')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle()
    if (!member) {
      throw new Error(`${label} is not an active member of this organization — add them as an org member first (and they must have accepted the invite)`)
    }
  }
```

*(If the founder prefers no loop, two copies of the classroom block read fine
too — "explicit over clever", docs' code style. The loop is offered only because
the check is verbatim-identical twice.)*

### 4b. `addGroupMember` (`:118-132`) — current code

```ts
export async function addGroupMember(orgSlug: string, groupId: string, formData: FormData) {
  const email = String(formData.get('email') ?? '').trim()
  if (!email) throw new Error('Email is required')

  const supabase = await createClient()
  const userId = await resolveUserId(supabase, email)
  const { error } = await supabase.from('mm_group_members').insert({
    org_id: DERIVED_SCOPE_PLACEHOLDER, // derived from the group by mm_sync_from_group
    group_id: groupId,
    user_id: userId,
  })
```

**Note it does not currently resolve `orgId` at all** — it relies on
`mm_sync_from_group` to stamp it. So the guard needs one extra line:

```ts
  const supabase = await createClient()
  const orgId = await resolveOrgId(supabase, orgSlug)
  const userId = await resolveUserId(supabase, email)

  // Same reason as assignMatchmaker: the email lookup resolves anyone sharing
  // ANY org with the caller, and a group membership row is read authority over
  // the group and its roster. Mirrors modules/classroom/ui/manage/actions.ts:66-80.
  const { data: member } = await supabase
    .from('org_members')
    .select('user_id')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle()
  if (!member) {
    throw new Error(`No user found with email ${email} in this organization — add them as an org member first (and they must have accepted the invite)`)
  }
```

**Both guards are defence in depth, not the gate.** The migration is the gate
(docs/03 hard rule 6 — the app layer is not one); the guards stop a bad row
being created in the first place, and give a comprehensible error instead of a
silently inert seat.

---

## 5. RLS tests owed (`packages/db/src/rls.test.ts`)

docs/19's closing finding: **no test asserts that a roster row stops conferring
authority once org membership ends, for ANY module** — the 13 `org_members
... .delete()` sites in the suite are all fixture teardown, not assertions. The
only such assertion in the repo is the one `20260904010000` added for vm.

**Every test below needs a non-emptiness CONTROL** (docs/03 vacuity rule): assert
the *same read succeeds* while membership is active, then revoke, then assert it
fails. "She sees nothing" is otherwise satisfied by an empty table, and would
pass even if the fix were absent and the fixture broken.

**The shape, per module:** create the module entity → seat the user on the roster
→ **assert the read WORKS** (control) → `delete from org_members` for that
(org, user) → **assert the same read now returns zero rows / is denied** → the
roster row still exists (assert it, via an owner-level or staff read), proving
the denial comes from the conjunct and not from the seat having vanished.

1. **Matchmaking, `mm_matchmaker_can_see`** — an assigned matchmaker reads a
   single's `mm_answers` and `mm_pair_scores`; after their org seat is deleted,
   both return zero while `mm_matchmaker_assignments` still holds the row.
2. **Matchmaking, the two inline arms** — same ex-matchmaker reads `mm_groups`
   and the full `mm_group_members` roster before / after. These must be asserted
   *separately* from #1: no function change reaches them, so a test that only
   exercised `mm_matchmaker_can_see` would pass with the policies still broken.
3. **Matchmaking, `mm_assignment_covers_me`** — a group member reads
   `mm_assignments_select`; after org removal, denied. Include a positive case
   that the **own-target branch still works** (`check_target_user_id =
   auth.uid()`), pinning the deliberate exception so a later "tidy-up" that
   gates it is caught.
4. **Matchmaking, `pending` status** — re-invite rather than delete: set
   `org_members.status = 'pending'` and assert the same denial. This is the case
   `is_org_member`'s `status = 'active'` covers and a delete-only test misses.
5. **Speed dating, `sd_owns_participant`** — an ex-member participant reads
   their own `sd_participants` row, `sd_interest` and `sd_matches` (the contact
   details) before / after.
6. **Speed dating, `sd_in_event`** — reads `sd_events`, `sd_rounds`,
   `sd_pairings` before / after. **Also assert the §5 boundary explicitly**: a
   participant with `status = 'removed'` who is STILL an org member CAN still
   read the event — i.e. pin the deliberately-unchanged behaviour, so the
   founder decision is visible in the suite rather than silently drifting.
7. **Speed dating, `sd_paired_with`** — the counterparty's participant row
   before / after.
8. **Speed dating, `sd_mentors`** — a mentor's read of their mentee before /
   after.
9. **Nail salon, `sal_worker_sees_customer`** — a worker reads
   `sal_customers` (name/phone/email/notes) before / after; assert
   `sal_appointments.worker_id` and `sal_worker_profiles` are both untouched by
   the org delete, which is the mechanism of the bug.
10. **Nail salon, `sal_appointments_select`** — the worker's own appointment
    history before / after (inline arm, needs its own assertion).
11. **Nail salon, `sal_appointments_update_worker`** — the only WRITE: an
    ex-worker's `update` on a `checked_in` appointment must now fail. Assert the
    update SUCCEEDS while a member (control), then fails after. Cover both
    clauses if practical: a `checked_in → in_progress` transition exercises
    USING and WITH CHECK together.
12. **Nail salon, `sal_worker_time_off_select`** — before / after.
13. **Classroom, `cls_reviews_submission`** — a peer reviewer reads
    `cls_submissions` and `cls_submission_files` before / after. **And the
    Storage arm separately**: `cls_submissions_storage_read` on
    `storage.objects` is a different policy on a different table and would not
    be exercised by a row-level test — assert the object listing/read by path,
    since the downloadable file is the worst of this item's exposure.
14. **A negative-control that the fix does not over-reach** — a roster holder
    who IS an active org member still reads everything they should, for at least
    one module per file touched. Cheap insurance that eight `create or replace`s
    did not accidentally narrow a working path.

**Ordering caution for whoever writes these:** CI runs
`pnpm --filter @platform/db test` immediately before `pnpm test:e2e` on the SAME
database with no reset between (`.github/workflows/ci.yml`). A test that deletes
a seeded user's `org_members` row and does not restore it will break e2e
deterministically — the same class of failure as the grace/`login_events` one
fixed 2026-08-20. **Restore the membership in `afterAll`, or use purpose-built
fixture users rather than seeded demo accounts.**
