-- Seat authority: a module ROSTER row no longer grants access on its own — the
-- holder must also be an ACTIVE member of that row's ORG (2026-09-10).
--
-- THE FINDING (docs/19-seat-authority-audit.md, produced 2026-09-04 as the
-- follow-on to 20260904010000, which fixed exactly one instance of this class
-- in visual messaging). docs/03 #20: a per-entity SEAT is not authority. A
-- predicate that derives authority from the mere existence of a row in a
-- module-owned roster (`*_participants`, `*_assignments`, `*_members`, a
-- `worker_id` column), keyed on auth.uid() and WITHOUT a conjunct requiring
-- is_org_member() of that row's org, makes the roster row a complete,
-- standalone, NON-EXPIRING capability.
--
-- WHY IT IS REACHABLE WITH NO MALICIOUS INSERT — the important part. Two facts
-- compose: (1) removeOrgMember deletes exactly one row
-- (apps/web/lib/org-members.ts:89-92 — a delete on org_members alone), and
-- (2) NOTHING in the schema has a foreign key to org_members (verified: zero
-- matches for `references public.org_members` across every migration), so that
-- delete cascades to nothing. Therefore ordinary offboarding — or a re-invite,
-- which leaves status = 'pending' — revokes org membership while every module
-- roster row survives intact and keeps granting access, permanently. An
-- ex-stylist keeps every customer's name/phone/email/notes; an ex-matchmaker
-- keeps each assigned single's full intimate questionnaire; an ejected
-- speed-dating participant keeps the live event, their revealed matches and the
-- contact details attached to them; an ex-student peer reviewer keeps read of a
-- current student's submission AND the storage prefix its files live under.
-- requireOrgModule() 404s all of them in the UI, but the UI is not the gate
-- (docs/03 hard rule 6) — every one of those reads is reachable directly
-- against the API with an ordinary session.
--
-- This is precisely the hole 20260727010000_org_invite_accept.sql closed for
-- module_roles-derived authority (it patched seventeen predicates to require
-- active membership) and never closed for module-OWNED rosters, because those
-- are per-module tables that migration did not touch.
--
-- WHY `<roster>.org_id` AND NOT A JOIN TO THE PARENT: every roster table here
-- carries its OWN org_id, stamped by a BEFORE INSERT/UPDATE scope-sync trigger
-- (docs/03 #10) that derives it from the parent entity and raises on an unknown
-- one — verified live, one per table: mm_sync_assignment_org
-- (mm_matchmaker_assignments), mm_sync_from_group (mm_group_members),
-- sd_sync_from_event (sd_participants), sal_appointments_before_write
-- (sal_appointments), sal_sync_from_location (sal_worker_profiles),
-- cls_sync_from_homework (cls_review_assignments). So the roster row's org_id
-- IS the parent's org, server-derived and unspoofable — the cheaper form is
-- also the authoritative one.
--
-- WHY THE ORG TAILS ARE ALREADY SAFE AND ARE LEFT VERBATIM: every staff /
-- manage / operate arm sitting alongside these seat arms resolves through
-- has_module_role, is_org_admin, sal_can_operate_location or
-- module_caller_covers_*, all of which have required ACTIVE org membership
-- since 20260727010000. Only the bare seat arms were unguarded, so only they
-- are touched.
--
-- METHOD (docs/19 "Verification method, and its control", re-run against the
-- LIVE CATALOG for this migration, 2026-09-10 — never from the original
-- migration files, because a function can be silently cured by a later
-- `create or replace`: cls_is_class_member reads as vulnerable in
-- 20260708010000 and was cured by 20260727010000, so a single-migration grep
-- produces a false positive). Every body below was read with
-- pg_get_functiondef() and every policy expression with pg_policies.
-- CONTROL: the five predicates known to be CURED — vm_is_conv_member,
-- vm_can_post, vm_can_moderate, vm_is_conv_admin (20260904010000) and
-- cls_is_class_member (20260727010000) — all classify ORG-GATED, while all
-- eight below classify BARE ROW. The method discriminates fixed from unfixed,
-- so these positives are not an artifact of the query.
-- NONE OF THE EIGHT WAS FOUND ALREADY FIXED. The count stands at 8 + 5.
--
-- SCOPE OF THE CHANGE: forward-only and additive — eight `create or replace`s
-- and five policy replacements, no schema change, no backfill, no new
-- mechanism (docs/19: "KEEP IT TO THE ONE-LINE CONJUNCT"; docs/15 §4's fold of
-- these rosters into module_roles is what fixes the class structurally, and
-- this is the stopgap on the way there). Each function restates its FULL
-- signature, language, STABLE and SECURITY DEFINER attributes and
-- `set search_path = public` — a replace does NOT inherit them — and each was
-- checked against its live definition. Existing EXECUTE grants are untouched:
-- `create or replace` preserves them, and all eight currently hold
-- postgres=X, authenticated=X, service_role=X, which must stay, because
-- `authenticated` needs EXECUTE on anything named in an RLS policy (policy
-- expressions are permission-checked as the querying role, docs/03 #17).
-- The five policies are replaced with `drop policy` + `create policy`, the
-- convention every prior policy edit in this repo uses (e.g.
-- 20260726010000:288, :316); no `to` clause, matching their live roles = PUBLIC.
--
-- DELIBERATELY NOT INCLUDED — docs/19 §5, A FOUNDER DECISION:
-- sd_in_event has NO `status` filter at all. sd_pin_participant
-- (20260709050000:1103-1145) exists precisely so a host can flip a disruptive
-- attendee to status = 'removed', yet that removal does not revoke their
-- event/round read even while they remain in the org. Adding
-- `and p.status in ('registered','waitlisted')` would fix that — but it is a
-- BEHAVIOURAL change to what ejection MEANS, orthogonal to this migration's
-- offboarding bug, so it wants an explicit answer rather than riding along.
-- sd_in_event below therefore gets the org conjunct and NOTHING ELSE; its
-- status semantics are unchanged. (Related standing note from docs/19 §5: do
-- not build Jitsi room authorization on sd_in_event — it is both too broad and
-- about to change; room-join authority must key on the sd_pairings row for the
-- current round.)
--
-- ALSO NOT INCLUDED, recorded rather than silently changed (docs/19 §6, LOW —
-- same missing conjunct, but every row reached is the caller's OWN history, so
-- no cross-tenant escalation): sal_owns_customer / sal_owns_appointment /
-- sal_owns_bill, and the own-data arms cls_owns_submission,
-- cls_submission_open, cls_exam_papers_select, cls_survey_answers_select,
-- sd_notes_all_own, smp_items_update_own, mm_answers' own arm. Likewise
-- mm_assignment_covers_me's first branch (`check_target_user_id = auth.uid()`)
-- is left verbatim — it is the caller reading their own coverage and the
-- function has no org in scope there.
--
-- TEST DEBT THIS DOES NOT PAY (docs/19's closing section): a targeted grep
-- found that NO test asserts a roster row stops conferring authority once org
-- membership ends, for ANY module — the 13 `org_members ... delete()` sites in
-- packages/db/src/rls.test.ts are all fixture teardown. The per-module
-- assertions owed are enumerated in
-- docs/history/20260910040000-seat-authority-notes.md; each needs a
-- non-emptiness control (docs/03 vacuity rule), because "she sees nothing" is
-- otherwise satisfied by an empty table.

-- ===========================================================================
-- 1. MATCHMAKING — HIGH
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1.1 mm_matchmaker_can_see — gates mm_answers_select (each assigned single's
--     full intimate questionnaire) and mm_pair_scores_select (their
--     compatibility scores). The seat row is the mm_matchmaker_assignments
--     row; a.org_id is stamped by mm_sync_assignment_org.
--     LIVE CATALOG: BARE ROW (not previously fixed).
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
-- 1.2 mm_assignment_covers_me — gates mm_assignments_select (which matchmakers
--     are assigned to me / to a group I am in). Only the GROUP branch is a
--     seat: gm is an mm_group_members row, gm.org_id stamped by
--     mm_sync_from_group. The first branch is the caller's own coverage and is
--     preserved verbatim (see header).
--     LIVE CATALOG: BARE ROW (not previously fixed).
-- ---------------------------------------------------------------------------
create or replace function public.mm_assignment_covers_me(check_matchmaker_id uuid, check_target_group_id uuid, check_target_user_id uuid)
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
        )
      );
$$;

-- ---------------------------------------------------------------------------
-- 1.3 mm_groups_select_assigned — an assigned matchmaker reads the group row.
--     Inline arm over mm_matchmaker_assignments, so no function change reaches
--     it. Rest of the policy preserved verbatim.
-- ---------------------------------------------------------------------------
drop policy mm_groups_select_assigned on public.mm_groups;
create policy mm_groups_select_assigned on public.mm_groups
  for select using (
    exists (
      select 1 from public.mm_matchmaker_assignments a
      where a.target_group_id = mm_groups.id
        and a.matchmaker_id = auth.uid()
        and public.is_org_member(a.org_id)
    )
  );

-- ---------------------------------------------------------------------------
-- 1.4 mm_group_members_select_assigned — an assigned matchmaker reads the
--     group's ENTIRE roster of user_ids. Same inline arm, same fix.
-- ---------------------------------------------------------------------------
drop policy mm_group_members_select_assigned on public.mm_group_members;
create policy mm_group_members_select_assigned on public.mm_group_members
  for select using (
    exists (
      select 1 from public.mm_matchmaker_assignments a
      where a.target_group_id = mm_group_members.group_id
        and a.matchmaker_id = auth.uid()
        and public.is_org_member(a.org_id)
    )
  );

-- ===========================================================================
-- 2. SPEED DATING — HIGH
--    sd_participants is the structural twin of vm_conversation_members,
--    status column and all. All four predicates below were written in
--    20260709050000 and deliberately preserved VERBATIM by 20260726030000,
--    which rewrote only the STAFF arms and says so at :277-278. p.org_id /
--    m.org_id / me.org_id are stamped by sd_sync_from_event.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 2.1 sd_owns_participant — gates sd_participants_select (own row),
--     sd_interest_select/_insert_own/_update_own, sd_matches_select (revealed
--     mutual matches WITH shared contact details) and
--     sd_reports_select/_insert_own.
--     LIVE CATALOG: BARE ROW (not previously fixed).
-- ---------------------------------------------------------------------------
create or replace function public.sd_owns_participant(check_participant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.sd_participants p
    where p.id = check_participant_id
      and p.user_id = auth.uid()
      and public.is_org_member(p.org_id)
  );
$$;

-- ---------------------------------------------------------------------------
-- 2.2 sd_in_event — gates sd_events_select, sd_rounds_select (the live round
--     clock), sd_participants_select and sd_pairings_select.
--     ORG CONJUNCT ONLY. Its missing `status` filter is docs/19 §5, a FOUNDER
--     DECISION, and is deliberately NOT added here — see the header.
--     LIVE CATALOG: BARE ROW (not previously fixed).
-- ---------------------------------------------------------------------------
create or replace function public.sd_in_event(check_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.sd_participants p
    where p.event_id = check_event_id
      and p.user_id = auth.uid()
      and public.is_org_member(p.org_id)
  );
$$;

-- ---------------------------------------------------------------------------
-- 2.3 sd_paired_with — gates sd_participants_select for the counterparty (their
--     opt-in profile card and pool side) and sd_interest/sd_matches arms. The
--     seat is `me`, the caller's own sd_participants row.
--     LIVE CATALOG: BARE ROW (not previously fixed).
-- ---------------------------------------------------------------------------
create or replace function public.sd_paired_with(check_participant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.sd_pairings pr
    join public.sd_participants me on me.user_id = auth.uid()
    where public.is_org_member(me.org_id)
      and (
        (pr.participant_a_id = check_participant_id and pr.participant_b_id = me.id)
        or (pr.participant_b_id = check_participant_id and pr.participant_a_id = me.id)
      )
  );
$$;

-- ---------------------------------------------------------------------------
-- 2.4 sd_mentors — a mentor seat reads their mentee's participant row and the
--     mentee-scoped interest/match arms. The seat is `m`, the mentor's own
--     sd_participants row.
--     LIVE CATALOG: BARE ROW (not previously fixed).
-- ---------------------------------------------------------------------------
create or replace function public.sd_mentors(check_participant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.sd_participants m
    where m.mentee_participant_id = check_participant_id
      and m.user_id = auth.uid()
      and m.seat_type = 'mentor'
      and public.is_org_member(m.org_id)
  );
$$;

-- ===========================================================================
-- 3. NAIL SALON — MEDIUM (customer PII, and a lingering WRITE)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 3.1 sal_worker_sees_customer — gates sal_customers_select, i.e. the
--     customer's full_name, phone, email and notes. The seat is the
--     sal_appointments row's worker_id; a.org_id is stamped by
--     sal_appointments_before_write.
--     LIVE CATALOG: BARE ROW (not previously fixed).
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
  );
$$;

-- ---------------------------------------------------------------------------
-- 3.2 sal_appointments_select — the worker's own-appointment READ arm (their
--     whole appointment history at that salon). Inline `worker_id = auth.uid()`,
--     so no function change reaches it. The operate arm and the customer's own
--     arm are preserved verbatim (sal_owns_customer is docs/19 §6, own-data).
--     org_id here is sal_appointments' own column.
-- ---------------------------------------------------------------------------
drop policy sal_appointments_select on public.sal_appointments;
create policy sal_appointments_select on public.sal_appointments
  for select using (
    public.sal_can_operate_location(org_id, location_id)
    or (worker_id = auth.uid() and public.is_org_member(org_id))
    or public.sal_owns_customer(customer_id)
  );

-- ---------------------------------------------------------------------------
-- 3.3 sal_appointments_update_worker — the worker's WRITE arm: advance state
--     and write notes on their own appointments. Both USING and WITH CHECK get
--     the conjunct; the state lists are preserved verbatim.
-- ---------------------------------------------------------------------------
drop policy sal_appointments_update_worker on public.sal_appointments;
create policy sal_appointments_update_worker on public.sal_appointments
  for update using (
    worker_id = auth.uid()
    and public.is_org_member(org_id)
    and state in ('checked_in', 'in_progress')
  )
  with check (
    worker_id = auth.uid()
    and public.is_org_member(org_id)
    and state in ('checked_in', 'in_progress', 'complete', 'no_show')
  );

-- ---------------------------------------------------------------------------
-- 3.4 sal_worker_time_off_select — a worker reads their own time-off rows via
--     an inline sal_worker_profiles read. w.org_id is stamped by
--     sal_sync_from_location. The operate arm is preserved verbatim.
-- ---------------------------------------------------------------------------
drop policy sal_worker_time_off_select on public.sal_worker_time_off;
create policy sal_worker_time_off_select on public.sal_worker_time_off
  for select using (
    public.sal_can_operate_location(org_id, location_id)
    or exists (
         select 1 from public.sal_worker_profiles w
         where w.id = sal_worker_time_off.worker_profile_id
           and w.user_id = auth.uid()
           and public.is_org_member(w.org_id)
       )
  );

-- ===========================================================================
-- 4. CLASSROOM — MEDIUM (reaches Storage)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 4.1 cls_reviews_submission — gates cls_submissions_select,
--     cls_submission_files_select, cls_review_comments_insert_own and — the
--     worst of them — storage.objects' cls_submissions_storage_read
--     (20260709080000:63-77), so the ACTUAL SOURCE FILES are downloadable by
--     path, not merely the row readable. The seat is the cls_review_assignments
--     row; ra.org_id is stamped by cls_sync_from_homework.
--     LIVE CATALOG: BARE ROW (not previously fixed).
--     NOTE, not fixed here (docs/19 §4, second-order): moveToPeerReview sources
--     reviewers from cls_class_members, and removeOrgMember does not delete
--     that row — so a student removed from the ORG but still on the class
--     roster is freshly MINTED new review assignments on the next round. This
--     conjunct denies the resulting access, but the app-side minting is a
--     separate fix (see docs/history/20260910040000-seat-authority-notes.md).
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
  );
$$;
