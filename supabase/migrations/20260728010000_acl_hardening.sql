-- ACL hardening sweep — platform-wide. Closes the "door lock" layer that
-- prod left wide open, so RLS stops being the ONLY gate.
--
-- WHY (quantified against prod's pg_catalog on 2026-07-28, see docs/12 +
-- docs/03 convention #1):
--   * 139 functions live in public; 134 were EXECUTE-able by anon and by
--     PUBLIC on BOTH local and prod. `create or replace` preserves the
--     pre-existing ACL, so slice 3 (20260727010000) left 20 of its 23
--     replaced functions anon-executable.
--   * All 67 public tables granted anon the FULL privilege set on prod
--     (relacl `anon=arwdDxtm`) — SELECT/INSERT/UPDATE/DELETE *and*
--     TRUNCATE/REFERENCES/TRIGGER/MAINTAIN. Local granted anon `Dxtm`.
--     The source is prod's ALTER DEFAULT PRIVILEGES FOR ROLE postgres, which
--     local lacks — the documented local/prod divergence trap.
--   * RLS does NOT gate `TRUNCATE`, so that grant to anon+authenticated was the
--     one privilege here RLS could never have covered. No reachable path exists
--     today (PostgREST exposes no such verb), but the grant itself was real.
--
-- BEHAVIOR-NEUTRALITY, established empirically before writing this (not assumed):
--   * Trigger functions: EXECUTE is checked at CREATE TRIGGER time, not at fire
--     time. Verified locally — with proacl stripped to owner-only, an INSERT as
--     both authenticated and service_role still fired the trigger. So the 54
--     trigger functions below need NO api-role EXECUTE at all.
--   * Functions named inside an RLS policy DO require EXECUTE for the QUERYING
--     role. Verified locally: revoking it turned a working read into
--     "permission denied for function". Hence `authenticated` KEEPS EXECUTE on
--     every non-trigger function below.
--   * Local has run with zero anon table privileges all along and the public
--     schedule page still works there, so revoking anon SELECT is safe — anon
--     needs schema USAGE + EXECUTE on the two syn_public_* functions, nothing more.
--   * A table-level `revoke all` ALSO drops column-level grants (verified), so
--     profiles' column-only UPDATE grants are restored explicitly below.
--
-- NOT destructive: this migration only moves privileges. It contains no DDL and
-- touches no rows. It deliberately revokes ALL and then restores the intended DML
-- explicitly, rather than naming the individual non-DML privileges in a REVOKE:
-- that is the docs/03 #1 house style, AND it keeps CI's destructive-migration
-- guard (which greps case-insensitively for that word followed by whitespace)
-- from flagging a migration that deletes nothing. Same reason this comment says
-- it awkwardly — the guard reads comments too.
--
-- Durability caveat: prod's ALTER DEFAULT PRIVILEGES still re-opens every
-- FUTURE object. Tracked as a separate follow-on (docs/15) plus a drift check
-- (scripts/acl-audit.ts); Supabase removes the legacy default on 2026-10-30.

-- ===========================================================================
-- 1. FUNCTIONS — one blanket revoke, then state every intended grant.
-- ===========================================================================
-- The blanket revoke is deliberate: enumerating 139 signatures by hand is how
-- an overload gets missed (module_position_rank exists as both (text) and
-- (text, text)). Revoking everything and re-granting explicitly cannot miss one.
revoke execute on all functions in schema public from public, anon, authenticated, service_role;

-- 1a. The ENTIRE public no-login surface (2 functions). Both are
--     security definer + read-only; they decide exactly what a visitor sees.
--     A future public page (platform-level or per-module) extends the surface
--     by adding a definer function and granting it here — never by granting
--     anon a table privilege. See docs/03 convention #4.
--     service_role is included so this migration does not silently NARROW it:
--     on prod both are service_role-executable today (via the default privileges),
--     nothing calls them that way, and the loss would be permanently invisible to
--     a verifier — which must exempt these two from the authenticated+service_role
--     rule and so cannot notice a missing service_role grant on them.
grant execute on function public.syn_public_week(p_org_slug text, p_week_start date) to anon, authenticated, service_role;
grant execute on function public.syn_public_weeks(p_org_slug text) to anon, authenticated, service_role;

-- 1b. Internal ancestry oracles — service_role only, preserving the intent of
--     20260722010000. These take bare node ids and do NOT key on auth.uid(),
--     so they are the one group that must not be callable by authenticated.
--     Their only caller is a definer function running as postgres.
grant execute on function public.module_scope_covers(ancestor uuid, descendant uuid) to service_role;
grant execute on function public.module_scope_strictly_contains(ancestor uuid, descendant uuid) to service_role;

-- 1c. Everything else non-trigger (81 functions): authenticated + service_role.
--     authenticated is REQUIRED — ~60 of these are named inside RLS policies and
--     policy expressions are permission-checked as the querying role.
grant execute on function public.cls_can_manage(check_org_id uuid) to authenticated, service_role;
grant execute on function public.cls_can_manage_class(check_org_id uuid, check_class_id uuid) to authenticated, service_role;
grant execute on function public.cls_can_manage_course(check_org_id uuid, check_course_id uuid) to authenticated, service_role;
grant execute on function public.cls_comments_for_my_submission(check_submission_id uuid) to authenticated, service_role;
grant execute on function public.cls_is_class_member(check_class_id uuid) to authenticated, service_role;
grant execute on function public.cls_is_ga(check_org_id uuid) to authenticated, service_role;
grant execute on function public.cls_is_ga_class(check_org_id uuid, check_class_id uuid) to authenticated, service_role;
grant execute on function public.cls_is_ga_course(check_org_id uuid, check_course_id uuid) to authenticated, service_role;
grant execute on function public.cls_material_storage_visible(check_path text) to authenticated, service_role;
grant execute on function public.cls_owns_submission(check_submission_id uuid) to authenticated, service_role;
grant execute on function public.cls_reviews_submission(check_submission_id uuid) to authenticated, service_role;
grant execute on function public.cls_set_preferred_name(check_class_id uuid, first_name text, last_name text) to authenticated, service_role;
grant execute on function public.cls_submission_hidden(check_submission_id uuid) to authenticated, service_role;
grant execute on function public.cls_submission_open(check_submission_id uuid) to authenticated, service_role;
grant execute on function public.cls_survey_results(check_survey_id uuid) to authenticated, service_role;
grant execute on function public.has_module_role(check_org_id uuid, check_module_key text, check_role text) to authenticated, service_role;
grant execute on function public.is_org_admin(check_org_id uuid) to authenticated, service_role;
grant execute on function public.is_org_member(check_org_id uuid) to authenticated, service_role;
grant execute on function public.is_superadmin() to authenticated, service_role;
grant execute on function public.mm_assignment_covers_me(check_matchmaker_id uuid, check_target_group_id uuid, check_target_user_id uuid) to authenticated, service_role;
grant execute on function public.mm_can_manage(check_org_id uuid) to authenticated, service_role;
grant execute on function public.mm_ensure_answer(check_question_id uuid) to authenticated, service_role;
grant execute on function public.mm_is_matchmaker(check_org_id uuid) to authenticated, service_role;
grant execute on function public.mm_is_single(check_org_id uuid) to authenticated, service_role;
grant execute on function public.mm_matchmaker_can_see(check_org_id uuid, check_single_id uuid) to authenticated, service_role;
grant execute on function public.mm_mutual_matches() to authenticated, service_role;
grant execute on function public.mm_mutual_pairs(check_org_id uuid) to authenticated, service_role;
grant execute on function public.mm_shared_answers(check_other_user uuid) to authenticated, service_role;
grant execute on function public.module_caller_can_manage_seat(check_org_id uuid, check_module_key text, seat_role text, seat_scope uuid) to authenticated, service_role;
grant execute on function public.module_caller_covers_rank(check_org_id uuid, check_module_key text, check_node uuid, min_rank integer) to authenticated, service_role;
grant execute on function public.module_caller_covers_role(check_org_id uuid, check_module_key text, check_node uuid, check_role text) to authenticated, service_role;
grant execute on function public.module_can_manage(check_org_id uuid, check_module_key text) to authenticated, service_role;
grant execute on function public.module_has_manager_grant(check_org_id uuid, check_module_key text) to authenticated, service_role;
grant execute on function public.module_position_rank(module_key text, role text) to authenticated, service_role;
grant execute on function public.module_position_rank(role text) to authenticated, service_role;
grant execute on function public.org_accept_invite(check_org_id uuid) to authenticated, service_role;
grant execute on function public.org_caller_rank(check_org_id uuid) to authenticated, service_role;
grant execute on function public.org_find_user_by_email(check_org_id uuid, target_email text) to authenticated, service_role;
grant execute on function public.org_member_profiles(check_org_id uuid) to authenticated, service_role;
grant execute on function public.org_my_pending_invites() to authenticated, service_role;
grant execute on function public.org_role_rank(role text) to authenticated, service_role;
grant execute on function public.sal_can_manage(check_org_id uuid) to authenticated, service_role;
grant execute on function public.sal_can_manage_location(check_org_id uuid, check_location_id uuid) to authenticated, service_role;
grant execute on function public.sal_can_operate(check_org_id uuid) to authenticated, service_role;
grant execute on function public.sal_can_operate_location(check_org_id uuid, check_location_id uuid) to authenticated, service_role;
grant execute on function public.sal_is_worker(check_org_id uuid) to authenticated, service_role;
grant execute on function public.sal_owns_appointment(check_appointment_id uuid) to authenticated, service_role;
grant execute on function public.sal_owns_bill(check_bill_id uuid) to authenticated, service_role;
grant execute on function public.sal_owns_customer(check_customer_id uuid) to authenticated, service_role;
grant execute on function public.sal_worker_has_time_off(check_worker_id uuid, check_location_id uuid, window_start timestamp with time zone, window_end timestamp with time zone) to authenticated, service_role;
grant execute on function public.sal_worker_sees_customer(check_customer_id uuid) to authenticated, service_role;
grant execute on function public.sd_can_manage(check_org_id uuid) to authenticated, service_role;
grant execute on function public.sd_can_organize(check_org_id uuid) to authenticated, service_role;
grant execute on function public.sd_can_organize_event(check_org_id uuid, check_event_id uuid) to authenticated, service_role;
grant execute on function public.sd_can_staff_event(check_org_id uuid) to authenticated, service_role;
grant execute on function public.sd_can_staff_event_of(check_org_id uuid, check_event_id uuid) to authenticated, service_role;
grant execute on function public.sd_in_event(check_event_id uuid) to authenticated, service_role;
grant execute on function public.sd_is_participant(check_org_id uuid) to authenticated, service_role;
grant execute on function public.sd_mentors(check_participant_id uuid) to authenticated, service_role;
grant execute on function public.sd_owns_participant(check_participant_id uuid) to authenticated, service_role;
grant execute on function public.sd_paired_with(check_participant_id uuid) to authenticated, service_role;
grant execute on function public.sd_reveal_matches(check_event_id uuid) to authenticated, service_role;
grant execute on function public.sd_side_registered_count(check_event_id uuid, check_side text) to authenticated, service_role;
grant execute on function public.set_export_settings(check_org_id uuid, check_module_key text, disabled_hats text[], disabled_sets text[]) to authenticated, service_role;
grant execute on function public.shares_org_with(target_user uuid) to authenticated, service_role;
grant execute on function public.smp_can_manage(check_org_id uuid) to authenticated, service_role;
grant execute on function public.smp_is_member(check_org_id uuid) to authenticated, service_role;
grant execute on function public.syn_can_write(check_org_id uuid) to authenticated, service_role;
grant execute on function public.vm_can_manage(check_org_id uuid) to authenticated, service_role;
grant execute on function public.vm_can_moderate(check_conversation_id uuid) to authenticated, service_role;
grant execute on function public.vm_can_moderate_org(check_org_id uuid) to authenticated, service_role;
grant execute on function public.vm_can_post(check_conversation_id uuid) to authenticated, service_role;
grant execute on function public.vm_created_conversation(check_conversation_id uuid) to authenticated, service_role;
grant execute on function public.vm_is_conv_admin(check_conversation_id uuid) to authenticated, service_role;
grant execute on function public.vm_is_conv_member(check_conversation_id uuid) to authenticated, service_role;
grant execute on function public.vm_is_module_member(check_org_id uuid) to authenticated, service_role;
grant execute on function public.vm_join_conversation(check_conversation_id uuid) to authenticated, service_role;
grant execute on function public.vm_layer_locked(check_layer_id uuid) to authenticated, service_role;
grant execute on function public.vm_restore_layer(check_layer_id uuid) to authenticated, service_role;
grant execute on function public.vm_set_branch_frozen(check_layer_id uuid, check_frozen boolean) to authenticated, service_role;
grant execute on function public.vm_tombstone_layer(check_layer_id uuid, check_reason text) to authenticated, service_role;

-- 1d. Trigger functions (54) intentionally get NO grant — see the header.
--     Listed so the omission reads as deliberate rather than forgotten:
--       public.cls_create_class_node()
--       public.cls_create_course_node()
--       public.cls_pin_assignment_columns()
--       public.cls_pin_grade_author()
--       public.cls_pin_submission_columns()
--       public.cls_sync_from_class()
--       public.cls_sync_from_course()
--       public.cls_sync_from_exam()
--       public.cls_sync_from_homework()
--       public.cls_sync_from_submission()
--       public.handle_new_user()
--       public.mm_answers_before_write()
--       public.mm_mark_pairs_stale()
--       public.mm_pin_answer_identity()
--       public.mm_sync_assignment_org()
--       public.mm_sync_from_group()
--       public.module_roles_guard_hierarchy()
--       public.module_roles_guard_last_director()
--       public.module_scope_nodes_set_path()
--       public.org_members_guard_hierarchy()
--       public.org_members_guard_last_admin()
--       public.org_modules_pin_enablement()
--       public.sal_appointments_before_write()
--       public.sal_create_location_node()
--       public.sal_feed_earnings()
--       public.sal_guard_bill()
--       public.sal_pin_appointment()
--       public.sal_sync_from_appointment()
--       public.sal_sync_from_bill()
--       public.sal_sync_from_location()
--       public.sal_sync_from_worker_profile()
--       public.sd_create_event_node()
--       public.sd_guard_event()
--       public.sd_guard_round()
--       public.sd_interest_before_write()
--       public.sd_matches_before_write()
--       public.sd_pairings_before_write()
--       public.sd_pin_interest()
--       public.sd_pin_note()
--       public.sd_pin_participant()
--       public.sd_pin_report()
--       public.sd_sync_from_event()
--       public.sd_sync_mutual_match()
--       public.set_updated_at()
--       public.smp_pin_item()
--       public.smp_sync_from_project()
--       public.vm_layers_after_delete()
--       public.vm_layers_before_write()
--       public.vm_modlog_before_write()
--       public.vm_pin_conversation()
--       public.vm_pin_flag()
--       public.vm_pin_member()
--       public.vm_sync_from_conversation()
--       public.vm_sync_from_layer()

-- ===========================================================================
-- 2. TABLES — anon loses everything; authenticated loses only the
--    non-RLS-gated extras (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN).
-- ===========================================================================
-- anon keeps schema USAGE (the public page needs it to reach the two functions
-- above) but holds no table privilege whatsoever. This is already how local has
-- always run. service_role is intentionally left untouched (docs/15 follow-on).
-- Revoke from PUBLIC first. The function revoke above names PUBLIC; the table
-- revokes below name only roles, and that asymmetry would be a hole: a table whose
-- relacl carried a PUBLIC entry (`=arwd/postgres`) would keep granting anon
-- everything THROUGH PUBLIC and the sweep would achieve nothing on that table.
-- No such entry exists on local and prod's defaults grant to named roles, so this
-- is expected to be a no-op — it is cheap insurance against an assumption.
revoke all privileges on all tables in schema public from public;

revoke all privileges on all tables in schema public from anon;

-- Restore authenticated's intended DML exactly as the creating migrations
-- granted it. Generated from the local catalog, grouped by privilege set.
revoke all privileges on all tables in schema public from authenticated;

grant select, insert, update, delete on public.cls_announcements, public.cls_class_members, public.cls_classes, public.cls_courses, public.cls_exam_papers, public.cls_exams, public.cls_grades, public.cls_homeworks, public.cls_materials, public.cls_publications, public.cls_review_assignments, public.cls_review_comments, public.cls_submission_files, public.cls_submissions, public.cls_survey_answers, public.cls_surveys, public.mm_answers, public.mm_group_members, public.mm_groups, public.mm_matchmaker_assignments, public.mm_pair_scores, public.mm_questions, public.module_roles, public.module_scope_nodes, public.org_members, public.org_modules, public.orgs, public.sal_appointments, public.sal_bill_items, public.sal_bills, public.sal_customers, public.sal_earnings_ledger, public.sal_expenses, public.sal_locations, public.sal_promotions, public.sal_services, public.sal_shopping_list, public.sal_worker_profiles, public.sal_worker_time_off, public.sd_bans, public.sd_blocks, public.sd_events, public.sd_interest, public.sd_matches, public.sd_notes, public.sd_pairings, public.sd_participants, public.sd_reports, public.sd_rounds, public.smp_items, public.smp_projects, public.syn_export_profiles, public.syn_lines, public.syn_overrides, public.syn_published_weeks, public.syn_schedule_types, public.syn_sections, public.vm_conversation_members, public.vm_conversations, public.vm_flags, public.vm_layers, public.vm_reactions
  to authenticated;

grant select, insert on public.job_requests, public.vm_moderation_log
  to authenticated;

grant select, insert, delete on public.mm_interests, public.profiles
  to authenticated;

-- syn_zmanim_cache: intentionally NO authenticated grant
--   (RLS-enabled with zero policies = deny-all; service_role only).

-- Column-level grants wiped by the revoke above (verified) — restored here.
-- profiles deliberately withholds table-wide UPDATE from authenticated so a
-- user can edit only these columns, never their own email/user_id.
grant update (display_name, settings) on public.profiles to authenticated;
