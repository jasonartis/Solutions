-- Seat authority, THE MODULE-ROLE HALF: a module roster row no longer grants
-- access on its own even to a current ORG member — the holder must also still
-- hold the MODULE ROLE that justifies the seat (2026-09-15).
--
-- THE FINDING (docs/19-seat-authority-audit.md "THE SECOND GAP"). Raised by the
-- founder on 2026-09-10, immediately after 20260910040000 closed the
-- org-membership half: *"What if he is still part of the org but no longer part
-- of the module within the org? Is that the same or similar issue?"* It is the
-- same class one level down. Measured against the live catalog after that
-- migration, ZERO of the eight seat predicates consulted the module role — all
-- eight checked only is_org_member. So revoking someone's MODULE role while
-- leaving their org membership intact left every seat fully functional.
--
-- WHY THIS IS THE MORE COMMON REVOCATION, not the rarer one: removing one
-- module's access is a smaller, more routine administrative act than removing a
-- person from the organisation entirely, and it is the one an admin reaches for
-- first. "Take Mel off matchmaking" is a Tuesday; "remove Mel from the company"
-- is an offboarding.
--
-- FOUNDER DECISIONS THIS IMPLEMENTS (docs/19, 2026-09-11):
--   1. FULL SYMMETRY — a seat requires the module role that justifies it, with
--      no per-module exceptions. The salon CUSTOMER was checked as the feared
--      counter-example and is not one: a customer holds a module_roles row like
--      everyone else. The thing that looked like an exception is a different
--      kind of record — sal_customers.user_id is NULLABLE, so a walk-in with no
--      account is *a record about a person*, not *a seat held by a user*, and no
--      auth.uid() predicate ever touches it.
--   3. The live WRITE is folded IN, not deferred (§3.3 below). Founder: *"this
--      obviously needs to be fixed."*
--
-- THE BLOCKING MEASUREMENT, RUN BEFORE A LINE OF THIS WAS WRITTEN. docs/19
-- requires it: if any seat's holder does NOT hold the role this migration starts
-- requiring, the conjunct REVOKES LIVE ACCESS instead of closing a hole. It is
-- now scripted rather than ad hoc — scripts/prod-verify-seat-authority-orphans.mts
-- gained a ROLE dimension and a --local mode (docs/19 clean-room finding #4 asked
-- for exactly this, so the query is not re-derived a third time).
-- RESULT, 2026-09-15, PROD and LOCAL identical, 0 would-lose-access:
--   mm_matchmaker_assignments  2 rows, 2 hold 'matchmaker'   clean
--   sal_appointments           2 rows, 2 hold 'worker'       clean
--   sal_worker_profiles        1 row,  1 holds 'worker'      clean
--   cls_review_assignments     2 rows, 2 cover the class     clean
--   mm_group_members           0 rows                        VACUOUS
--   sd_participants            0 rows                        VACUOUS
-- CONTROL that makes the zero mean something (docs/03 vacuity rule): the script
-- asserts at least one roster row POSITIVELY holds its mapped role, so "0
-- missing" cannot be a silently broken join. Five controls pass.
-- HONEST CAVEAT, stated because the clean sheet is partly structural: two of the
-- six rosters are EMPTY on both databases, so their mapping is unvalidated by
-- data and rests on reading the code alone.
--
-- SCOPE SEMANTICS DIFFER PER PREDICATE AND THAT IS THE WHOLE DIFFICULTY —
-- verified against the live catalog, not assumed:
--   * has_module_role() requires `scope_ref is null`, i.e. a GLOBAL grant. A
--     SCOPED grant of the same role does NOT satisfy it. mm_is_single /
--     mm_is_matchmaker / sd_is_participant are thin wrappers over it, so they
--     are global-only. Measured: every matchmaking and speed-dating grant in
--     existence is global, so this is correct for them today.
--   * sal_is_worker() checks role only and IGNORES scope_ref — so a
--     location-scoped worker passes. Measured: the one worker grant is global
--     anyway.
--   * cls_is_class_member() requires a grant whose scope COVERS the class's
--     node (module_scope_covers). Classroom enrolment is deliberately SCOPED
--     (slice 2b), and measured: both reviewers' grants are scoped and cover.
--     This is why classroom uses a different predicate shape from the others,
--     and why cls_review_assignments.class_id (NOT NULL, verified) is what
--     makes the one-liner possible at all.
--
-- EVERY ROLE PREDICATE SUBSUMES is_org_member, AND THE ORG CONJUNCT IS STILL
-- KEPT. has_module_role / sal_is_worker / cls_is_class_member each call
-- is_org_member internally (they have since 20260727010000), so the org
-- conjunct added by 20260910040000 becomes logically redundant here. It is
-- deliberately NOT removed: it keeps 20260910040000's property textually
-- visible and independently testable at each site, it costs nothing (the
-- planner short-circuits), and removing it would make the two dimensions
-- impossible to regression-test separately. Redundant-but-harmless is the
-- documented expectation (docs/19 "The shape of the fix").
--
-- ADVERSARIAL REVIEW (docs/03 #12), two independent narrow reviewers run
-- against the LIVE database before this was applied anywhere. Both simulated
-- every affected predicate as every seeded user, old expression vs new. Result:
-- ZERO row-count deltas for dana, mel, charlie, alice, gabe, eve, grace and
-- frank across all seven seat surfaces — no current user loses anything. Three
-- findings were acted on and are folded in above:
--   (a) §1.4/1.5 were MISSING — mm_groups_select_assigned and
--       mm_group_members_select_assigned are the same shape as §1.3 and were
--       not in the draft or in any "not included" block. Added.
--   (b) §3.4 would have caused a REAL latent false revocation (a professor
--       renaming herself). Rewritten to the org conjunct; the full reasoning is
--       at §3.4 because it is the most instructive failure in this migration.
--   (c) the three fragilities below, recorded rather than "fixed", because each
--       is a property of the existing grant model and not of this change.
--
-- THREE LATENT FRAGILITIES THIS MIGRATION CREATES OR SHARPENS. None is live —
-- each needs a row that does not exist today — but each turns a working feature
-- off SILENTLY if that row ever appears, so they are named here rather than
-- discovered later:
--   1. GLOBAL-vs-SCOPED IS A CLIFF, not a gradient. mm_is_matchmaker and
--      mm_is_single resolve through has_module_role, which demands
--      `scope_ref is null`. Matchmaking has no scoped-grant UI at all (zero
--      scope_ref references under modules/matchmaking) so every grant is
--      global today — but ONE scoped matchmaker grant would silently kill that
--      matchmaker's entire console (mm_answers, mm_pair_scores), and the admin's
--      mm_can_manage FOR ALL arm would NOT save them, because they are not an
--      admin.
--   2. Classroom STAFF grants are GLOBAL, so cls_is_class_member is false for a
--      professor or GA. §3.1-3.3 are safe only BY CONSTRUCTION: peer reviewers
--      are drawn exclusively from cls_class_members rows with role 'student'
--      (modules/classroom/ui/manage/grading/[homeworkId]/actions.ts:103) and
--      enrolByEmail always mints a CLASS-SCOPED grant
--      (modules/classroom/ui/manage/actions.ts:92). A GA ever assigned as a
--      reviewer would lose the reviewer arm on both the select and the update.
--      Staff are unaffected today because they read and write through the
--      separate cls_can_manage_class / cls_*_write_staff arms, which this
--      migration does not touch.
--   3. sal_appointments.worker_id FKs to auth.users, NOT to sal_worker_profiles,
--      and holding a worker profile does not require the 'worker' module role —
--      only the assignment dropdown constrains it. So a manager or cashier
--      assigned as worker_id survives only via sal_can_operate_location; grace
--      (manager scoped to Uptown) assigned at another location would lose both
--      the read and the §2.3 write. No such row exists.
--
-- DELIBERATELY NOT INCLUDED — 1: SPEED DATING'S ROLE CONJUNCT, because the
-- mapping is genuinely unanswerable today and guessing it would bake in a
-- future break. sd_participants.seat_type is participant | audience | mentor
-- (CHECK constraint, verified live) and THERE IS NO audience OR mentor MODULE
-- ROLE — speed-dating's only roles are 'organizer' and 'participant'. So
-- conjoining sd_is_participant onto sd_owns_participant / sd_in_event /
-- sd_paired_with would revoke every audience and mentor seat outright, and
-- sd_mentors keys on `seat_type = 'mentor'` explicitly, so requiring the
-- 'participant' role there would be simply wrong rather than merely strict.
-- Three facts pin this down: (a) sd_participants is EMPTY on prod and local, so
-- the measurement is VACUOUS for it and can neither confirm nor refute any
-- mapping; (b) no application code anywhere sets seat_type (grepped across
-- modules/, apps/, seed.ts — zero non-test matches), so audience/mentor is
-- schema-only and unbuilt, which is why nothing is broken TODAY; (c) an
-- organizer CAN already mint any seat_type for anyone via
-- sd_participants_write_organize (FOR ALL on sd_can_organize_event) with no
-- requirement that the holder hold any speed-dating role at all. Recorded as an
-- open founder decision in docs/19 rather than answered here. Speed dating gets
-- its ORG-dimension gap closed below (§4) and nothing else.
--
-- DELIBERATELY NOT INCLUDED — 2: the last-admin floor in vm_pin_member and in
-- 20260914020000's new conversation-admin guard. Both count
-- `role = 'admin' and status = 'active'` with NO is_org_member conjunct, so a
-- seat whose holder has left the org — conferring no authority at all after
-- 20260910040000 — still holds the floor open and lets the effective last admin
-- leave. Handed over by the Public Square session that found it (it recorded it
-- in its own migration header rather than fixing it). It IS this class, but it
-- is a different failure mode — availability/lockout, not confidentiality — in a
-- module that took two migrations hours before this one, so it gets its own
-- change rather than widening this one's review surface. Recorded in docs/19.
--
-- DELIBERATELY NOT INCLUDED — 3: docs/19 §5's status filter on sd_in_event,
-- still a founder decision (it changes what host-ejection MEANS), unchanged
-- from 20260910040000's own deferral of it.
--
-- METHOD. Every body below was read from the LIVE CATALOG with
-- pg_get_functiondef() and every policy expression with pg_policies, never from
-- the original migration files — a function can be silently cured by a later
-- `create or replace` (cls_is_class_member reads as vulnerable in 20260708010000
-- and was cured by 20260727010000), so a single-migration grep produces false
-- positives. Each function restates its FULL signature, language, STABLE and
-- SECURITY DEFINER attributes and `set search_path = public`, because a replace
-- does NOT inherit them.
--
-- ACLs: no new functions are created, and `create or replace` preserves existing
-- EXECUTE grants, so this introduces no new ACL surface (docs/03 #1's local/prod
-- divergence cannot bite here). Verified before writing that `authenticated`
-- holds EXECUTE on every helper named in a policy expression below —
-- mm_is_matchmaker, mm_is_single, sal_is_worker, cls_is_class_member,
-- is_org_member all hold postgres=X, authenticated=X, service_role=X and NO
-- anon — because policy expressions are permission-checked as the querying role
-- (docs/03 #17). All four helpers are STABLE, so they are safe in policies.
--
-- Policies are replaced with `drop policy` + `create policy`, the convention
-- every prior policy edit in this repo uses; no `to` clause, matching their live
-- roles = PUBLIC.

-- ===========================================================================
-- 1. MATCHMAKING
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1.1 mm_matchmaker_can_see — gates mm_answers_select (each assigned single's
--     full intimate questionnaire) and mm_pair_scores_select (their
--     compatibility scores). The seat is the mm_matchmaker_assignments row.
--     ADDS: mm_is_matchmaker(a.org_id).
--     An ADMIN who holds an assignment holds role='admin', not 'matchmaker',
--     so this predicate stops returning true for them — they lose NOTHING,
--     because a matchmaking admin reads all six mm_ tables through the
--     mm_can_manage FOR ALL policy's read arm instead. That arm is load-bearing
--     and must not be split (measured by the FOR ALL sweep, 2026-09-14:
--     mm_matchmaker_can_see has no mm_can_manage disjunct, so the FOR ALL arm is
--     the admin's ONLY read path). Not touched here.
-- ---------------------------------------------------------------------------
create or replace function public.mm_matchmaker_can_see(check_org_id uuid, check_single_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.mm_matchmaker_assignments a
    where a.org_id = check_org_id
      and a.matchmaker_id = auth.uid()
      and public.is_org_member(a.org_id)
      and public.mm_is_matchmaker(a.org_id)
      and (
        a.target_user_id = check_single_id
        or (
          a.target_group_id is not null
          and exists (
            select 1 from public.mm_group_members gm
            where gm.group_id = a.target_group_id and gm.user_id = check_single_id
          )
        )
      )
  );
$$;

-- ---------------------------------------------------------------------------
-- 1.2 mm_assignment_covers_me — a single (or group member) reading WHICH
--     matchmakers are assigned to them. docs/19 §6 rates this LOW: staff
--     assignment, not content.
--     ADDS: mm_is_single(gm.org_id) to the GROUP arm only.
--     THE FIRST ARM IS LEFT VERBATIM AND THAT IS DELIBERATE. docs/19's
--     clean-room review flagged this function as unable to take the prescribed
--     one-line fix: the signature is (check_matchmaker_id,
--     check_target_group_id, check_target_user_id) with NO org_id to pass, and
--     arm 1 (`check_target_user_id = auth.uid()`) is a bare scalar comparison
--     with nothing to join against. Resolved WITHOUT the signature change that
--     review feared, by touching only arm 2, which has gm.org_id in scope. Arm 1
--     is the caller reading their own coverage and is PINNED by an existing RLS
--     test ("PIN (not teeth)", citing docs/19 §6) precisely so that gating it
--     later is a deliberate act that fails a test rather than a silent change.
--     Unchanged here; the pin still passes.
--     NOTE mm_group_members is empty on both databases, so 'single' as the role
--     that justifies a group seat rests on reading the code, not on measurement.
-- ---------------------------------------------------------------------------
create or replace function public.mm_assignment_covers_me(
  check_matchmaker_id uuid,
  check_target_group_id uuid,
  check_target_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select check_target_user_id = auth.uid()
      or (
        check_target_group_id is not null
        and exists (
          select 1 from public.mm_group_members gm
          where gm.group_id = check_target_group_id
            and gm.user_id = auth.uid()
            and public.is_org_member(gm.org_id)
            and public.mm_is_single(gm.org_id)
        )
      );
$$;

-- ---------------------------------------------------------------------------
-- 1.3 mm_assignments_select — the HALF-FIXED policy docs/19 lists as unaccounted
--     for: 20260910040000 gated this policy's mm_assignment_covers_me arm (by
--     fixing the function) and left its sibling `matchmaker_id = auth.uid()`
--     arm completely bare — no org conjunct, no role conjunct. So a matchmaker
--     removed from the org entirely still read their own assignment rows.
--     ADDS: is_org_member(org_id) AND mm_is_matchmaker(org_id) to that arm.
--     Staff keep reading through the separate mm_can_manage FOR ALL policy.
-- ---------------------------------------------------------------------------
drop policy if exists mm_assignments_select on public.mm_matchmaker_assignments;
create policy mm_assignments_select on public.mm_matchmaker_assignments
  for select using (
    (
      matchmaker_id = auth.uid()
      and public.is_org_member(org_id)
      and public.mm_is_matchmaker(org_id)
    )
    or public.mm_assignment_covers_me(matchmaker_id, target_group_id, target_user_id)
  );

-- ---------------------------------------------------------------------------
-- 1.4 / 1.5 mm_groups_select_assigned and mm_group_members_select_assigned —
--     the two INLINE arms that no function change reaches. 20260910040000 gave
--     both the org conjunct; both were still bare of any role check, so an
--     ex-matchmaker still in the org kept reading every assigned group row and
--     that group's ENTIRE ROSTER of user_ids (in demo-match, the dating pool's
--     membership). Added after the adversarial review named the second one and
--     the first turned out to be identical in shape — the migration would
--     otherwise have claimed matchmaking's role half was closed while leaving
--     two of its reads open, which is precisely the "one policy is now
--     half-fixed" complaint docs/19 makes about mm_assignments_select.
--     ADDS: mm_is_matchmaker(a.org_id) to both.
-- ---------------------------------------------------------------------------
drop policy if exists mm_groups_select_assigned on public.mm_groups;
create policy mm_groups_select_assigned on public.mm_groups
  for select using (
    exists (
      select 1 from public.mm_matchmaker_assignments a
      where a.target_group_id = mm_groups.id
        and a.matchmaker_id = auth.uid()
        and public.is_org_member(a.org_id)
        and public.mm_is_matchmaker(a.org_id)
    )
  );

drop policy if exists mm_group_members_select_assigned on public.mm_group_members;
create policy mm_group_members_select_assigned on public.mm_group_members
  for select using (
    exists (
      select 1 from public.mm_matchmaker_assignments a
      where a.target_group_id = mm_group_members.group_id
        and a.matchmaker_id = auth.uid()
        and public.is_org_member(a.org_id)
        and public.mm_is_matchmaker(a.org_id)
    )
  );

-- ===========================================================================
-- 2. NAIL SALON — the worker side. sal_worker_sees_customer gates the WORKER
--    reading a CUSTOMER, so the role that justifies the seat is the worker's.
--    (docs/19's own table left this as an instruction rather than an answer;
--    resolved by reading the body: the caller is `a.worker_id = auth.uid()`.)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 2.1 sal_worker_sees_customer — gates sal_customers_select: every served
--     customer's full_name, phone, email and notes.
--     ADDS: sal_is_worker(a.org_id). A stylist re-badged to cashier — still an
--     org member, no longer a worker — stops reading the PII of customers she
--     used to serve.
-- ---------------------------------------------------------------------------
create or replace function public.sal_worker_sees_customer(check_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.sal_appointments a
    where a.customer_id = check_customer_id
      and a.worker_id = auth.uid()
      and public.is_org_member(a.org_id)
      and public.sal_is_worker(a.org_id)
  );
$$;

-- ---------------------------------------------------------------------------
-- 2.2 sal_appointments_select — the worker arm. Inline, so no function change
--     reaches it. ADDS: sal_is_worker(org_id).
--     The sal_can_operate_location and sal_owns_customer arms are left VERBATIM:
--     the first resolves through module_caller_covers_* (active membership since
--     20260727010000), the second is the customer reading their OWN history
--     (docs/19 §6, LOW, out of scope).
-- ---------------------------------------------------------------------------
drop policy if exists sal_appointments_select on public.sal_appointments;
create policy sal_appointments_select on public.sal_appointments
  for select using (
    public.sal_can_operate_location(org_id, location_id)
    or (
      worker_id = auth.uid()
      and public.is_org_member(org_id)
      and public.sal_is_worker(org_id)
    )
    or public.sal_owns_customer(customer_id)
  );

-- ---------------------------------------------------------------------------
-- 2.3 sal_appointments_update_worker — a WRITE: advancing appointment state and
--     writing notes. ADDS: sal_is_worker(org_id) to USING and WITH CHECK.
--     The asymmetric state lists are preserved EXACTLY (USING allows acting on
--     checked_in/in_progress; WITH CHECK also permits landing on
--     complete/no_show) — that asymmetry is the feature, not an oversight.
-- ---------------------------------------------------------------------------
drop policy if exists sal_appointments_update_worker on public.sal_appointments;
create policy sal_appointments_update_worker on public.sal_appointments
  for update using (
    worker_id = auth.uid()
    and public.is_org_member(org_id)
    and public.sal_is_worker(org_id)
    and state = any (array['checked_in', 'in_progress'])
  )
  with check (
    worker_id = auth.uid()
    and public.is_org_member(org_id)
    and public.sal_is_worker(org_id)
    and state = any (array['checked_in', 'in_progress', 'complete', 'no_show'])
  );

-- ---------------------------------------------------------------------------
-- 2.4 sal_worker_time_off_select — inline sal_worker_profiles read.
--     ADDS: sal_is_worker(w.org_id).
-- ---------------------------------------------------------------------------
drop policy if exists sal_worker_time_off_select on public.sal_worker_time_off;
create policy sal_worker_time_off_select on public.sal_worker_time_off
  for select using (
    public.sal_can_operate_location(org_id, location_id)
    or exists (
      select 1 from public.sal_worker_profiles w
      where w.id = sal_worker_time_off.worker_profile_id
        and w.user_id = auth.uid()
        and public.is_org_member(w.org_id)
        and public.sal_is_worker(w.org_id)
    )
  );

-- ===========================================================================
-- 3. CLASSROOM — including the live WRITE (founder decision 3).
--    cls_is_class_member is the role predicate here, and it is SCOPE-AWARE:
--    enrolment is a scoped module_roles grant pinned to the class's scope node,
--    and the function requires a grant whose scope COVERS that node. So this
--    conjunct revokes on unenrolment from THAT CLASS, not merely on losing some
--    classroom role org-wide — which is the correct granularity and is only
--    possible because cls_review_assignments carries class_id (NOT NULL).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 3.1 cls_reviews_submission — reaches cls_submissions_select,
--     cls_submission_files_select, cls_review_comments_insert_own and — worst —
--     cls_submissions_storage_read, so the actual source FILES are downloadable
--     by path, not merely the row readable.
--     ADDS: cls_is_class_member(ra.class_id).
-- ---------------------------------------------------------------------------
create or replace function public.cls_reviews_submission(check_submission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.cls_review_assignments ra
    where ra.submission_id = check_submission_id
      and ra.reviewer_id = auth.uid()
      and public.is_org_member(ra.org_id)
      and public.cls_is_class_member(ra.class_id)
  );
$$;

-- ---------------------------------------------------------------------------
-- 3.2 cls_review_assignments_select — bare `reviewer_id = auth.uid()` arm, the
--     second of docs/19's unaccounted-for four. ADDS org + class membership.
--     The cls_can_manage_class arm is left VERBATIM (staff, already gated).
-- ---------------------------------------------------------------------------
drop policy if exists cls_review_assignments_select on public.cls_review_assignments;
create policy cls_review_assignments_select on public.cls_review_assignments
  for select using (
    public.cls_can_manage_class(org_id, class_id)
    or (
      reviewer_id = auth.uid()
      and public.is_org_member(org_id)
      and public.cls_is_class_member(class_id)
    )
  );

-- ---------------------------------------------------------------------------
-- 3.3 cls_review_assignments_update_reviewer — THE LIVE WRITE, and the sharpest
--     item in docs/19's unaccounted-for four. It gates submitPeerGrade, and it
--     was `reviewer_id = auth.uid() AND locked = false` with NO membership and
--     NO role conjunct. The pin trigger protects homework_id / reviewer_id /
--     submission_id / locked but leaves `grade` and `grade_submitted_at`
--     writable. So after 20260910040000 an offboarded student could no longer
--     READ the submission but could still WRITE a peer grade onto a CURRENT
--     student's work — a read fix that left the write open.
--     ADDS: is_org_member(org_id) AND cls_is_class_member(class_id) to USING and
--     WITH CHECK. `locked = false` preserved exactly.
-- ---------------------------------------------------------------------------
drop policy if exists cls_review_assignments_update_reviewer on public.cls_review_assignments;
create policy cls_review_assignments_update_reviewer on public.cls_review_assignments
  for update using (
    reviewer_id = auth.uid()
    and locked = false
    and public.is_org_member(org_id)
    and public.cls_is_class_member(class_id)
  )
  with check (
    reviewer_id = auth.uid()
    and locked = false
    and public.is_org_member(org_id)
    and public.cls_is_class_member(class_id)
  );

-- ---------------------------------------------------------------------------
-- 3.4 cls_set_preferred_name — a SECURITY DEFINER function with NO authority
--     check of ANY kind: it updated cls_class_members for `user_id =
--     auth.uid()` and nothing else, so an ex-ORG-member could still rename
--     themselves on a live class roster that current students read. docs/19
--     rates it LOW; docs/03 #13 is the rule it breaks — a definer function
--     bypasses RLS entirely, so any gate the table's policies enforce must be
--     restated INSIDE the function.
--
--     ADDS THE ORG CONJUNCT ONLY, AND DELIBERATELY NOT THE ROLE ONE. This
--     section originally used cls_is_class_member(check_class_id) and BOTH
--     adversarial reviews independently caught the same latent regression, from
--     opposite directions: cls_is_class_member requires `g.scope_ref is not
--     null`, and classroom STAFF hold GLOBAL grants — so it is FALSE for a
--     professor or GA even though they sit on the roster. Verified live: alice
--     is a cls_class_members row with role 'professor' and a global grant, and
--     the function returns false for her. (A trap worth naming: module_scope_
--     covers(NULL, node) returns TRUE — a global grant does cover everything —
--     so the exclusion comes from the explicit `scope_ref is not null` filter,
--     not from coverage failing. Reading coverage alone would mislead you.)
--     The role version would therefore have silently stopped a professor
--     renaming HERSELF, which is a worse outcome than the LOW-rated hole it
--     would close, and it fails silently: the function is `returns void`, so a
--     refused rename is indistinguishable from a successful one to the caller.
--     The org conjunct closes exactly the hole docs/19 recorded (an EX-MEMBER
--     renaming themselves) and revokes nobody who legitimately belongs.
--
--     DISCLOSED, not fixed here: an unenrolled-but-still-in-org student who is
--     still listed on a roster can still rename themselves on it. That needs
--     `class member OR class manager`, i.e. two predicates and an org_id
--     derivation this function does not have — new mechanism, which docs/19
--     explicitly rules out for this remediation. Recorded in docs/19 instead.
--     ALSO DISCLOSED: the silent no-op above. There are ZERO application
--     callers today (grepped: only rls.test.ts), so nothing renders a false
--     "saved". If a caller is ever added, docs/03 #22's `{ok, reason}` return
--     convention applies and this signature should change with it.
-- ---------------------------------------------------------------------------
create or replace function public.cls_set_preferred_name(
  check_class_id uuid,
  first_name text,
  last_name text
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.cls_class_members
  set preferred_first_name = first_name,
      preferred_last_name = last_name,
      updated_at = now()
  where class_id = check_class_id
    and user_id = auth.uid()
    and exists (
      select 1 from public.cls_classes c
      where c.id = check_class_id
        and public.is_org_member(c.org_id)
    );
$$;

-- ===========================================================================
-- 4. SPEED DATING — ORG DIMENSION ONLY. The role conjunct is deliberately
--    deferred (see the header: no audience/mentor role exists). This section
--    closes the one speed-dating gap that is NOT entangled with that question.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 4.1 sd_participants_update_self — `user_id = auth.uid()` with no org conjunct
--     at all, the third of docs/19's unaccounted-for four. The pin trigger
--     blocks the dangerous columns, but an ex-ORG-member could still flip their
--     own checked_in and edit the opt-in profile card that paired participants
--     read. ADDS: is_org_member(org_id) to USING and WITH CHECK — the ORG
--     dimension, matching what 20260910040000 did everywhere else. No role
--     conjunct: that is the deferred question, and adding one here would revoke
--     audience/mentor seats exactly as described above.
-- ---------------------------------------------------------------------------
drop policy if exists sd_participants_update_self on public.sd_participants;
create policy sd_participants_update_self on public.sd_participants
  for update using (
    user_id = auth.uid()
    and public.is_org_member(org_id)
  )
  with check (
    user_id = auth.uid()
    and public.is_org_member(org_id)
  );
