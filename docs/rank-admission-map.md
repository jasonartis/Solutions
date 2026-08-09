# Rank admission map

**GENERATED — do not edit by hand.** Written by `packages/db/src/rank-admission.test.ts`
from the live local database. Regenerate with
`pnpm --filter @platform/db exec vitest run src/rank-admission.test.ts -u`, and read the diff
as a security question: *did I mean to change who gets in?*

One ladder, `module_position_rank()`, is read by the functions in the first table below.
Each turns a rank number into an authority decision, so moving any number in the ladder
moves every one of these answers at once. This file is the record of what those answers
currently are; the test fails when they change.

Four conventions worth knowing before reading it:

- **A gate whose module cannot be resolved from a call site is listed under EVERY
  module.** Such a gate really can be invoked with any `module_key`, so listing it
  narrowly would understate its reach. Where the module CAN be read off the call site
  (`module_caller_covers_rank` is instantiated with a literal by four wrappers) it is
  listed only under those modules — note that the function itself is still
  `EXECUTE`-granted to `authenticated`, so that narrowing describes the callers that
  exist today, not a restriction the database enforces.
- **`director` / `coordinator` / `lead` / `position` appear in every module.** They are the
  generic vocabulary the 2-arg ladder falls back to, so they carry ranks 4/3/2/1 even in
  modules whose own positions are all rank 0. `module_position_rank('sample', 'lead')` is 2.
- **"Satisfies" is not the same as "is granted something".** For most gates the two
  coincide. For `module_roles_guard_last_director` they are opposites: satisfying its
  `rank < 4` arm means the guard EXEMPTS you, and satisfying `rank >= 4` means you are one
  of the Directors it refuses to let a module run out of. Read the gate, not the verb.
- **A gate can have non-rank arms, and this map does not track them.**
  `sal_can_operate_location` also admits by the role NAME `cashier`, and
  `module_caller_covers_rank` short-circuits on `is_org_admin`. Those are deliberately out
  of scope: they do not move when the ladder moves, which is the only thing this file
  watches. So **nobody** in a rank column means "no rank opens this", never "nobody can
  get in".

## The rules that read the ladder

| function | comparison | resolves to | note |
| --- | --- | --- | --- |
| `cls_can_manage(uuid)` | `module_position_rank('classroom', g.role) >= 2` | rank >= 2 (classroom) | module pinned in the body |
| `module_caller_can_manage_seat(uuid,text,text,uuid)` | `module_position_rank(check_module_key, g.role) > module_position_rank(check_module_key, seat_role)` | rank(a) > rank(b) | rank vs rank |
| `module_caller_can_manage_seat(uuid,text,text,uuid)` | `module_position_rank(check_module_key, seat_role) = 3` | rank = 3 | module supplied by the caller |
| `module_caller_covers_rank(uuid,text,uuid,integer)` | `module_position_rank(check_module_key, g.role) >= min_rank` | rank >= 2 (classroom); rank >= 2 (nail-salon); rank >= 2 (speed-dating) | module supplied by the caller; threshold instantiated by cls_can_manage_class, cls_can_manage_course, sal_can_manage_location, sd_can_organize_event |
| `module_has_manager_grant(uuid,text)` | `module_position_rank(check_module_key, role) >= 2` | rank >= 2 | module supplied by the caller |
| `module_roles_guard_last_director()` | `module_position_rank(module_key, role) >= 4` | rank >= 4 | module supplied by the caller |
| `module_roles_guard_last_director()` | `module_position_rank(new.module_key, new.role) < 4` | rank < 4 | module supplied by the caller |
| `module_roles_guard_last_director()` | `module_position_rank(old.module_key, old.role) < 4` | rank < 4 | module supplied by the caller |
| `sal_can_manage(uuid)` | `module_position_rank('nail-salon', g.role) >= 2` | rank >= 2 (nail-salon) | module pinned in the body |
| `sd_can_organize(uuid)` | `module_position_rank('speed-dating', g.role) >= 2` | rank >= 2 (speed-dating) | module pinned in the body |
| `view_as_guard_session()` | `module_position_rank(new.module_key, a.role) > target_rank` | rank(a) > rank(b) | rank vs rank, via the local `target_rank` |

## What each gate guards

Every function that reaches a rank test, directly or by calling something that does, with
the tables whose RLS policies name it, **one row per table and command**. A new row here
means a rank number now decides access it did not decide before — which is the whole
signal, so it gets its own line in the diff rather than one more word inside a long cell.

Rows reading _no policy_ are reached from triggers or SECURITY DEFINER functions instead.
That is not the same as harmless: `cls_survey_results`, `sd_reveal_matches` and
`sal_guard_bill` RETURN or GATE data, they are not plumbing. GRANTs and column privileges
are out of scope here entirely.

| gate | rank test(s) | reached via | guards |
| --- | --- | --- | --- |
| `cls_can_manage` | rank >= 2 | direct | cls_courses (insert) |
| `cls_can_manage` | rank >= 2 | direct | storage.objects (delete) |
| `cls_can_manage` | rank >= 2 | direct | storage.objects (insert) |
| `cls_can_manage` | rank >= 2 | direct | storage.objects (select) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_announcements (all) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_announcements (select) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_class_members (all) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_class_members (select) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_classes (delete) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_classes (select) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_classes (update) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_exam_papers (all) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_exam_papers (select) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_exams (all) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_exams (select) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_grades (all) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_grades (select) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_homeworks (all) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_homeworks (select) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_publications (all) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_publications (select) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_review_assignments (all) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_review_assignments (select) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_review_comments (all) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_review_comments (select) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_submission_files (all) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_submission_files (select) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_submissions (all) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_submissions (select) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_survey_answers (all) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_survey_answers (select) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_surveys (all) |
| `cls_can_manage_class` | rank >= 2 | `module_caller_covers_rank` | cls_surveys (select) |
| `cls_can_manage_course` | rank >= 2 | `module_caller_covers_rank` | cls_classes (insert) |
| `cls_can_manage_course` | rank >= 2 | `module_caller_covers_rank` | cls_courses (delete) |
| `cls_can_manage_course` | rank >= 2 | `module_caller_covers_rank` | cls_courses (select) |
| `cls_can_manage_course` | rank >= 2 | `module_caller_covers_rank` | cls_courses (update) |
| `cls_can_manage_course` | rank >= 2 | `module_caller_covers_rank` | cls_materials (all) |
| `cls_can_manage_course` | rank >= 2 | `module_caller_covers_rank` | cls_materials (select) |
| `cls_material_storage_visible` | rank >= 2 | `cls_can_manage` | storage.objects (select) |
| `module_caller_can_manage_seat` | rank = 3; rank(a) > rank(b) | direct | _no policy — triggers/functions only_ |
| `module_caller_covers_rank` | rank >= 2 | direct | _no policy — triggers/functions only_ |
| `module_has_manager_grant` | rank >= 2 | direct | module_roles (delete) |
| `module_has_manager_grant` | rank >= 2 | direct | module_roles (insert) |
| `module_has_manager_grant` | rank >= 2 | direct | module_roles (update) |
| `module_roles_guard_last_director` | rank < 4; rank >= 4 | direct | _no policy — triggers/functions only_ |
| `sal_can_manage` | rank >= 2 | direct | _no policy — triggers/functions only_ |
| `sal_can_manage_location` | rank >= 2 | `module_caller_covers_rank` | sal_appointments (all) |
| `sal_can_manage_location` | rank >= 2 | `module_caller_covers_rank` | sal_bill_items (all) |
| `sal_can_manage_location` | rank >= 2 | `module_caller_covers_rank` | sal_bills (all) |
| `sal_can_manage_location` | rank >= 2 | `module_caller_covers_rank` | sal_customers (all) |
| `sal_can_manage_location` | rank >= 2 | `module_caller_covers_rank` | sal_earnings_ledger (all) |
| `sal_can_manage_location` | rank >= 2 | `module_caller_covers_rank` | sal_earnings_ledger (select) |
| `sal_can_manage_location` | rank >= 2 | `module_caller_covers_rank` | sal_expenses (all) |
| `sal_can_manage_location` | rank >= 2 | `module_caller_covers_rank` | sal_locations (delete) |
| `sal_can_manage_location` | rank >= 2 | `module_caller_covers_rank` | sal_locations (update) |
| `sal_can_manage_location` | rank >= 2 | `module_caller_covers_rank` | sal_promotions (all) |
| `sal_can_manage_location` | rank >= 2 | `module_caller_covers_rank` | sal_services (all) |
| `sal_can_manage_location` | rank >= 2 | `module_caller_covers_rank` | sal_shopping_list (all) |
| `sal_can_manage_location` | rank >= 2 | `module_caller_covers_rank` | sal_worker_profiles (all) |
| `sal_can_manage_location` | rank >= 2 | `module_caller_covers_rank` | sal_worker_time_off (all) |
| `sal_can_operate_location` | rank >= 2 | `sal_can_manage_location` | sal_appointments (all) |
| `sal_can_operate_location` | rank >= 2 | `sal_can_manage_location` | sal_appointments (select) |
| `sal_can_operate_location` | rank >= 2 | `sal_can_manage_location` | sal_bill_items (all) |
| `sal_can_operate_location` | rank >= 2 | `sal_can_manage_location` | sal_bill_items (select) |
| `sal_can_operate_location` | rank >= 2 | `sal_can_manage_location` | sal_bills (all) |
| `sal_can_operate_location` | rank >= 2 | `sal_can_manage_location` | sal_bills (select) |
| `sal_can_operate_location` | rank >= 2 | `sal_can_manage_location` | sal_customers (all) |
| `sal_can_operate_location` | rank >= 2 | `sal_can_manage_location` | sal_customers (select) |
| `sal_can_operate_location` | rank >= 2 | `sal_can_manage_location` | sal_expenses (all) |
| `sal_can_operate_location` | rank >= 2 | `sal_can_manage_location` | sal_expenses (select) |
| `sal_can_operate_location` | rank >= 2 | `sal_can_manage_location` | sal_promotions (select) |
| `sal_can_operate_location` | rank >= 2 | `sal_can_manage_location` | sal_shopping_list (all) |
| `sal_can_operate_location` | rank >= 2 | `sal_can_manage_location` | sal_shopping_list (select) |
| `sal_can_operate_location` | rank >= 2 | `sal_can_manage_location` | sal_worker_time_off (select) |
| `sd_can_organize` | rank >= 2 | direct | _no policy — triggers/functions only_ |
| `sd_can_organize_event` | rank >= 2 | `module_caller_covers_rank` | sd_events (delete) |
| `sd_can_organize_event` | rank >= 2 | `module_caller_covers_rank` | sd_events (update) |
| `sd_can_organize_event` | rank >= 2 | `module_caller_covers_rank` | sd_interest (all) |
| `sd_can_organize_event` | rank >= 2 | `module_caller_covers_rank` | sd_interest (select) |
| `sd_can_organize_event` | rank >= 2 | `module_caller_covers_rank` | sd_matches (all) |
| `sd_can_organize_event` | rank >= 2 | `module_caller_covers_rank` | sd_matches (select) |
| `sd_can_organize_event` | rank >= 2 | `module_caller_covers_rank` | sd_pairings (all) |
| `sd_can_organize_event` | rank >= 2 | `module_caller_covers_rank` | sd_participants (all) |
| `sd_can_organize_event` | rank >= 2 | `module_caller_covers_rank` | sd_reports (all) |
| `sd_can_organize_event` | rank >= 2 | `module_caller_covers_rank` | sd_rounds (all) |
| `sd_can_staff_event_of` | rank >= 2 | `sd_can_organize_event` | sd_events (select) |
| `sd_can_staff_event_of` | rank >= 2 | `sd_can_organize_event` | sd_pairings (select) |
| `sd_can_staff_event_of` | rank >= 2 | `sd_can_organize_event` | sd_participants (select) |
| `sd_can_staff_event_of` | rank >= 2 | `sd_can_organize_event` | sd_participants (update) |
| `sd_can_staff_event_of` | rank >= 2 | `sd_can_organize_event` | sd_reports (select) |
| `sd_can_staff_event_of` | rank >= 2 | `sd_can_organize_event` | sd_reports (update) |
| `sd_can_staff_event_of` | rank >= 2 | `sd_can_organize_event` | sd_rounds (select) |
| `view_as_guard_session` | rank(a) > rank(b) | direct | _no policy — triggers/functions only_ |

## Per module: the ladder, and who satisfies each rank test

### classroom

Ladder: **4** director · **3** coordinator · **2** lead, professor · **1** ga, position, student

| gate | rank test | positions satisfying it | which lets them at |
| --- | --- | --- | --- |
| `cls_can_manage` | rank >= 2 | coordinator, director, lead, professor | cls_courses, storage.objects |
| `cls_can_manage_class` | rank >= 2 | coordinator, director, lead, professor | cls_announcements, cls_class_members, cls_classes, cls_exam_papers, cls_exams, cls_grades, cls_homeworks, cls_publications, cls_review_assignments, cls_review_comments, cls_submission_files, cls_submissions, cls_survey_answers, cls_surveys |
| `cls_can_manage_course` | rank >= 2 | coordinator, director, lead, professor | cls_classes, cls_courses, cls_materials |
| `cls_material_storage_visible` | rank >= 2 | coordinator, director, lead, professor | storage.objects |
| `cls_pin_assignment_columns` | rank >= 2 | coordinator, director, lead, professor | _no policy names it — reached through triggers/functions_ |
| `cls_pin_grade_author` | rank >= 2 | coordinator, director, lead, professor | _no policy names it — reached through triggers/functions_ |
| `cls_pin_submission_columns` | rank >= 2 | coordinator, director, lead, professor | _no policy names it — reached through triggers/functions_ |
| `cls_survey_results` | rank >= 2 | coordinator, director, lead, professor | _no policy names it — reached through triggers/functions_ |
| `module_caller_can_manage_seat` | rank = 3 | coordinator | _no policy names it — reached through triggers/functions_ |
| `module_caller_covers_rank` | rank >= 2 | coordinator, director, lead, professor | _no policy names it — reached through triggers/functions_ |
| `module_has_manager_grant` | rank >= 2 | coordinator, director, lead, professor | module_roles |
| `module_roles_guard_hierarchy` | rank = 3 | coordinator | _no policy names it — reached through triggers/functions_ |
| `module_roles_guard_last_director` | rank < 4 | coordinator, ga, lead, position, professor, student | _no policy names it — reached through triggers/functions_ |
| `module_roles_guard_last_director` | rank >= 4 | director | _no policy names it — reached through triggers/functions_ |

_Relative gates (`module_caller_can_manage_seat`, `view_as_guard_session`) read straight off the ladder above: a position outranks exactly those below it._

### matchmaking

Ladder: **4** director · **3** coordinator · **2** lead · **1** position · **0** admin, matchmaker, single

| gate | rank test | positions satisfying it | which lets them at |
| --- | --- | --- | --- |
| `module_caller_can_manage_seat` | rank = 3 | coordinator | _no policy names it — reached through triggers/functions_ |
| `module_has_manager_grant` | rank >= 2 | coordinator, director, lead | module_roles |
| `module_roles_guard_hierarchy` | rank = 3 | coordinator | _no policy names it — reached through triggers/functions_ |
| `module_roles_guard_last_director` | rank < 4 | admin, coordinator, lead, matchmaker, position, single | _no policy names it — reached through triggers/functions_ |
| `module_roles_guard_last_director` | rank >= 4 | director | _no policy names it — reached through triggers/functions_ |

_Relative gates (`module_caller_can_manage_seat`, `view_as_guard_session`) read straight off the ladder above: a position outranks exactly those below it._

### nail-salon

Ladder: **4** director · **3** admin, coordinator · **2** lead, manager · **1** cashier, position, worker · **0** customer

| gate | rank test | positions satisfying it | which lets them at |
| --- | --- | --- | --- |
| `module_caller_can_manage_seat` | rank = 3 | admin, coordinator | _no policy names it — reached through triggers/functions_ |
| `module_caller_covers_rank` | rank >= 2 | admin, coordinator, director, lead, manager | _no policy names it — reached through triggers/functions_ |
| `module_has_manager_grant` | rank >= 2 | admin, coordinator, director, lead, manager | module_roles |
| `module_roles_guard_hierarchy` | rank = 3 | admin, coordinator | _no policy names it — reached through triggers/functions_ |
| `module_roles_guard_last_director` | rank < 4 | admin, cashier, coordinator, customer, lead, manager, position, worker | _no policy names it — reached through triggers/functions_ |
| `module_roles_guard_last_director` | rank >= 4 | director | _no policy names it — reached through triggers/functions_ |
| `sal_can_manage` | rank >= 2 | admin, coordinator, director, lead, manager | _no policy names it — reached through triggers/functions_ |
| `sal_can_manage_location` | rank >= 2 | admin, coordinator, director, lead, manager | sal_appointments, sal_bill_items, sal_bills, sal_customers, sal_earnings_ledger, sal_expenses, sal_locations, sal_promotions, sal_services, sal_shopping_list, sal_worker_profiles, sal_worker_time_off |
| `sal_can_operate` | rank >= 2 | admin, coordinator, director, lead, manager | _no policy names it — reached through triggers/functions_ |
| `sal_can_operate_location` | rank >= 2 | admin, coordinator, director, lead, manager | sal_appointments, sal_bill_items, sal_bills, sal_customers, sal_expenses, sal_promotions, sal_shopping_list, sal_worker_time_off |
| `sal_guard_bill` | rank >= 2 | admin, coordinator, director, lead, manager | _no policy names it — reached through triggers/functions_ |
| `sal_pin_appointment` | rank >= 2 | admin, coordinator, director, lead, manager | _no policy names it — reached through triggers/functions_ |

_Relative gates (`module_caller_can_manage_seat`, `view_as_guard_session`) read straight off the ladder above: a position outranks exactly those below it._

### sample

Ladder: **4** director · **3** coordinator · **2** lead · **1** position · **0** manager, member

| gate | rank test | positions satisfying it | which lets them at |
| --- | --- | --- | --- |
| `module_caller_can_manage_seat` | rank = 3 | coordinator | _no policy names it — reached through triggers/functions_ |
| `module_has_manager_grant` | rank >= 2 | coordinator, director, lead | module_roles |
| `module_roles_guard_hierarchy` | rank = 3 | coordinator | _no policy names it — reached through triggers/functions_ |
| `module_roles_guard_last_director` | rank < 4 | coordinator, lead, manager, member, position | _no policy names it — reached through triggers/functions_ |
| `module_roles_guard_last_director` | rank >= 4 | director | _no policy names it — reached through triggers/functions_ |

_Relative gates (`module_caller_can_manage_seat`, `view_as_guard_session`) read straight off the ladder above: a position outranks exactly those below it._

### speed-dating

Ladder: **4** director · **3** admin, coordinator · **2** lead, organizer · **1** host, position · **0** participant

| gate | rank test | positions satisfying it | which lets them at |
| --- | --- | --- | --- |
| `module_caller_can_manage_seat` | rank = 3 | admin, coordinator | _no policy names it — reached through triggers/functions_ |
| `module_caller_covers_rank` | rank >= 2 | admin, coordinator, director, lead, organizer | _no policy names it — reached through triggers/functions_ |
| `module_has_manager_grant` | rank >= 2 | admin, coordinator, director, lead, organizer | module_roles |
| `module_roles_guard_hierarchy` | rank = 3 | admin, coordinator | _no policy names it — reached through triggers/functions_ |
| `module_roles_guard_last_director` | rank < 4 | admin, coordinator, host, lead, organizer, participant, position | _no policy names it — reached through triggers/functions_ |
| `module_roles_guard_last_director` | rank >= 4 | director | _no policy names it — reached through triggers/functions_ |
| `sd_can_organize` | rank >= 2 | admin, coordinator, director, lead, organizer | _no policy names it — reached through triggers/functions_ |
| `sd_can_organize_event` | rank >= 2 | admin, coordinator, director, lead, organizer | sd_events, sd_interest, sd_matches, sd_pairings, sd_participants, sd_reports, sd_rounds |
| `sd_can_staff_event` | rank >= 2 | admin, coordinator, director, lead, organizer | _no policy names it — reached through triggers/functions_ |
| `sd_can_staff_event_of` | rank >= 2 | admin, coordinator, director, lead, organizer | sd_events, sd_pairings, sd_participants, sd_reports, sd_rounds |
| `sd_pin_interest` | rank >= 2 | admin, coordinator, director, lead, organizer | _no policy names it — reached through triggers/functions_ |
| `sd_pin_participant` | rank >= 2 | admin, coordinator, director, lead, organizer | _no policy names it — reached through triggers/functions_ |
| `sd_pin_report` | rank >= 2 | admin, coordinator, director, lead, organizer | _no policy names it — reached through triggers/functions_ |
| `sd_reveal_matches` | rank >= 2 | admin, coordinator, director, lead, organizer | _no policy names it — reached through triggers/functions_ |

_Relative gates (`module_caller_can_manage_seat`, `view_as_guard_session`) read straight off the ladder above: a position outranks exactly those below it._

### stub

Ladder: **4** director · **3** coordinator · **2** lead · **1** position · **0** admin, user

| gate | rank test | positions satisfying it | which lets them at |
| --- | --- | --- | --- |
| `module_caller_can_manage_seat` | rank = 3 | coordinator | _no policy names it — reached through triggers/functions_ |
| `module_has_manager_grant` | rank >= 2 | coordinator, director, lead | module_roles |
| `module_roles_guard_hierarchy` | rank = 3 | coordinator | _no policy names it — reached through triggers/functions_ |
| `module_roles_guard_last_director` | rank < 4 | admin, coordinator, lead, position, user | _no policy names it — reached through triggers/functions_ |
| `module_roles_guard_last_director` | rank >= 4 | director | _no policy names it — reached through triggers/functions_ |

_Relative gates (`module_caller_can_manage_seat`, `view_as_guard_session`) read straight off the ladder above: a position outranks exactly those below it._

### synagogue-schedules

Ladder: **4** director · **3** coordinator · **2** lead · **1** position · **0** maker, viewer

| gate | rank test | positions satisfying it | which lets them at |
| --- | --- | --- | --- |
| `module_caller_can_manage_seat` | rank = 3 | coordinator | _no policy names it — reached through triggers/functions_ |
| `module_has_manager_grant` | rank >= 2 | coordinator, director, lead | module_roles |
| `module_roles_guard_hierarchy` | rank = 3 | coordinator | _no policy names it — reached through triggers/functions_ |
| `module_roles_guard_last_director` | rank < 4 | coordinator, lead, maker, position, viewer | _no policy names it — reached through triggers/functions_ |
| `module_roles_guard_last_director` | rank >= 4 | director | _no policy names it — reached through triggers/functions_ |

_Relative gates (`module_caller_can_manage_seat`, `view_as_guard_session`) read straight off the ladder above: a position outranks exactly those below it._

### visual-messaging

Ladder: **4** director · **3** coordinator · **2** lead · **1** position · **0** admin, member, moderator

| gate | rank test | positions satisfying it | which lets them at |
| --- | --- | --- | --- |
| `module_caller_can_manage_seat` | rank = 3 | coordinator | _no policy names it — reached through triggers/functions_ |
| `module_has_manager_grant` | rank >= 2 | coordinator, director, lead | module_roles |
| `module_roles_guard_hierarchy` | rank = 3 | coordinator | _no policy names it — reached through triggers/functions_ |
| `module_roles_guard_last_director` | rank < 4 | admin, coordinator, lead, member, moderator, position | _no policy names it — reached through triggers/functions_ |
| `module_roles_guard_last_director` | rank >= 4 | director | _no policy names it — reached through triggers/functions_ |

_Relative gates (`module_caller_can_manage_seat`, `view_as_guard_session`) read straight off the ladder above: a position outranks exactly those below it._

