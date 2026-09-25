-- Rank-map the last three module vocabularies: matchmaking, synagogue-schedules
-- and visual-messaging (2026-09-25). Completes docs/15 §11 slice 2, which has
-- been PARTIAL since 2026-07-26 (3 of 6 modules mapped).
--
-- WHAT WAS WRONG. module_position_rank(module_key, role) carries a per-module
-- `case` arm for classroom, nail-salon and speed-dating and NOTHING for the
-- other three, so every real role string they grant — 'admin', 'matchmaker',
-- 'single', 'maker', 'member', 'moderator' — fell through to the generic
-- fallback, which only recognises the literal words director/coordinator/lead/
-- position. None of those is ever granted by any module. So EVERY grant in
-- these three modules resolved to rank 0.
--
-- MEASURED BEFORE WRITING THIS (docs/24 §1.1, and docs/rank-admission-map.md,
-- which is generated from this same live function so it is not a second,
-- divergent reading):
--   matchmaking          admin / matchmaker / single    -> 0 / 0 / 0
--   synagogue-schedules  maker / viewer                 -> 0 / 0
--   visual-messaging     admin / moderator / member     -> 0 / 0 / 0
-- CONTROL: classroom professor -> 2, nail-salon manager -> 2, speed-dating
-- organizer -> 2 in the same query, proving the zeros are a missing case arm
-- rather than a broken function.
--
-- THE CONSEQUENCE THAT MADE THIS BLOCKING, not cosmetic (docs/19's "ADJACENT,
-- FOUND 2026-09-10" section): module_has_manager_grant() requires rank >= 2, so
-- it is FALSE for a matchmaking admin and a visual-messaging admin. That makes
-- module_roles_{insert,update,delete}_module_manager DEAD POLICIES for those
-- modules today, and it is why the module_roles census leak (any org member
-- reads every grant row, i.e. who is in the dating pool) cannot be closed by
-- narrowing the read policy: there would be no replacement read path for the
-- people who legitimately administer grants. Ranks first, leak second.
--
-- FOUNDER DECISIONS THIS IMPLEMENTS (docs/24 §4, decided 2026-09-25):
--   * matchmaking 'matchmaker' = 1 — assignee, not a manager. Deliberately
--     BELOW the rank-2 manager-grant threshold, so a matchmaker administers
--     nobody and (once the leak is closed) enumerates nobody. Her console reads
--     mm_matchmaker_assignments, never raw module_roles.
--   * synagogue-schedules 'maker' = 1 — org admins grant makers; a maker cannot
--     mint another maker. Verified below that the ladder actually delivers this.
--
-- THE ONE RANK NOT PUT TO THE FOUNDER, and why it is 1 rather than docs/24 §2's
-- proposed 3: visual-messaging 'moderator'. Its moderation power comes from
-- vm_can_moderate_org(), which is a role-NAME check (has_module_role(...,
-- 'moderator')) and does not read rank at all. Rank would only add
-- grants-administration it has never needed, so 3 would hand a content-
-- moderation role the ability to write module_roles. 1 keeps it out of
-- module_has_manager_grant entirely while letting the vm admin (3) appoint and
-- remove moderators (3 > 1), which is what "delegated moderator" (docs/20)
-- should mean. It also matches the convention every already-mapped module uses:
-- operational staff = 1 (ga, cashier, worker, host), end users = 0 (student is
-- the documented exception at 1, a peer of ga by founder decision, docs/15 §5).
--
-- WHAT THIS CHANGES IN PRACTICE — derived from docs/rank-admission-map.md's
-- enumeration of every rank reader. These three modules reach FIVE rank
-- consumers. Four are below; the fifth (view_as_guard_session) was MISSED by
-- the first draft of this header and is written up after them, because the way
-- it was missed is worth more than the fact:
--
--   1. module_has_manager_grant (rank >= 2)  -- THE ONLY REAL WIDENING.
--      Becomes TRUE for a matchmaking 'admin' and a visual-messaging 'admin'
--      (both 3). They gain what the three already-mapped modules' admins have
--      had since July: the module_roles_{insert,update,delete}_module_manager
--      policies, i.e. the ability to administer grants in their OWN module
--      without being an org admin. This is docs/15 §9's model working as
--      designed (module admin = Coordinator tier), not a side effect.
--      Everything else stays 0 or 1 and gains nothing.
--
--   2. module_caller_can_manage_seat (rank(a) > rank(b), and a rank = 3 branch).
--      INERT AT RANK 1. A rank-1 holder (matchmaker, maker, moderator) passes
--      no module_roles WRITE policy at all — insert/update/delete each require
--      module_has_manager_grant (>= 2) or is_org_admin — so the trigger that
--      calls this is never reached by them. The rank=3 same-role branch is also
--      inert here: it additionally requires module_scope_strictly_contains, and
--      all three modules are single-global-entity with ZERO module_scope_nodes
--      rows, so every grant is global. VERIFIED LIVE:
--        module_scope_covers(null,null)            = true
--        module_scope_strictly_contains(null,null) = false
--      Hence an admin(3) may manage seats BELOW them but may NOT mint another
--      admin — only an org admin can. Same answer nail-salon and speed-dating
--      already give, now for the same reason.
--
--   3. module_roles_guard_hierarchy. No EXISTING write path changes behaviour:
--      its step (2) bypasses the whole rank ladder for the service role, a
--      superadmin and an org admin, and those are exactly the parties who write
--      module_roles today. Precision owed to the adversarial review, which
--      pushed back on an earlier "unchanged in effect": step (3), the non-admin
--      ladder branch, becomes NEWLY REACHABLE by a matchmaking or vm admin.
--      That is not a separate change — it is consumer 1's widening arriving at
--      the trigger — but "unchanged" was the wrong word for it.
--
--   4. module_roles_guard_last_director (rank >= 4 / rank < 4). Inert: no module
--      grants the literal role 'director', and the highest rank assigned here is
--      3, so every grant stays on the `< 4` (exempt) side exactly as it was at 0.
--
--   5. view_as_guard_session — THE ONE THIS HEADER ORIGINALLY MISSED, found by
--      adversarial review and confirmed independently. It is generic (its
--      module_key comes from the inserted row, not a literal), it is BOUND and
--      ENABLED (view_as_sessions_guard, tgenabled = 'O'), and it matters because
--      view_as_sessions_insert_actor's WITH CHECK is only
--      "actor_user_id = auth.uid() AND is_org_member(org_id)" — ANY org member
--      may attempt an insert, so this trigger is the entire authority gate.
--      ITS RANK ARM FLIPPED false -> true FOR ALL SEVEN newly rank-differential
--      pairs. Measured, as alice (matchmaking admin, rank 3) targeting mel
--      (matchmaker, rank 1): rank arm now TRUE, was FALSE.
--      THE OUTCOME IS UNCHANGED — the insert is still refused, because the
--      guard needs rank AND scope AND a declared edge, and module_view_as_edge
--      returns false for all seven (verified; controls classroom
--      professor->ga and nail-salon admin->worker both return true, so the
--      probe can detect a yes).
--      WHAT CHANGED IS DEPTH, NOT OUTCOME, and that is the part worth keeping:
--      these pairs used to be blocked by TWO independent conjuncts and are now
--      blocked by ONE — and that one denies by the ABSENCE of a case arm via
--      coalesce(..., false), not by an explicit rule. So adding an edge arm to
--      module_view_as_edge() in future is now SUFFICIENT on its own to open a
--      session for these modules, where previously the rank conjunct would have
--      independently refused it. Nothing is wrong today; the belt-and-braces is
--      simply gone, which is exactly what rank-mapping MEANS (these modules move
--      from "categorically impossible" to "possible iff someone declares it").
--      A regression test pins all seven refusals precisely because they are now
--      single-conjunct protected.
--      THE LESSON: the four-item list above was written from the rank map's
--      PER-MODULE sections, which list only gates whose module can be resolved
--      from a call site. A GENERIC gate is listed under every module in that
--      file's first table and is easy to skim past when you are reading one
--      module's section. Read both tables.
--
-- WHAT THIS DOES NOT CHANGE: no view-as edge turns on. The TypeScript manifest
-- gains an explicit {mode1:false, mode2:false} entry for each of the SEVEN newly
-- rank-differential pairs (matchmaking 3, synagogue-schedules 1,
-- visual-messaging 3), which is the 2026-07-30 amendment working as designed —
-- rank-mapping a module FAILS THE BUILD until every implied pair is consciously
-- answered. They are answered OFF, pending each module's own docs/15 §8.1
-- point 9 surface review. module_view_as_edge() needs no change: it fails closed
-- through its coalesce, so an unlisted pair already returns false, which is what
-- the TS/SQL parity test asserts for every ordered pair.
--
-- NOT IN THIS MIGRATION, deliberately (docs/24 §6): the module_roles census-leak
-- fix itself, which this unblocks but which needs a read path for the view-as
-- target picker that rank alone cannot express (a mode-1-only edge like
-- speed-dating's host -> participant is not in the SQL edge mirror, which
-- carries mode 2 only); and the fold of sd_participants / vm_conversation_members
-- into scoped grants. Each is its own slice, review and test.
--
-- ROLLBACK POSTURE: forward-only like every migration here, but note this one is
-- genuinely reversible in effect — re-applying the previous function body
-- restores rank 0 everywhere. It adds no column, table, policy or trigger.

-- ---------------------------------------------------------------------------
-- The ladder. Existing arms are preserved VERBATIM; only the three new
-- `when` blocks and this comment differ from the 20260720010000 /
-- 20260726030000 body.
-- ---------------------------------------------------------------------------
create or replace function public.module_position_rank(module_key text, role text)
returns integer
language sql
immutable
as $$
  select coalesce(
    case module_key
      when 'classroom' then case role
        when 'professor' then 2
        when 'ga' then 1
        when 'student' then 1
        else null end
      when 'nail-salon' then case role
        when 'admin' then 3       -- global salon authority (Coordinator tier)
        when 'manager' then 2     -- runs a location (Lead)
        when 'cashier' then 1     -- operate (position)
        when 'worker' then 1      -- operate (position; peer of cashier)
        else null end             -- 'customer' -> 0 via fallback (end user)
      when 'speed-dating' then case role
        when 'admin' then 3       -- global speed-dating authority (Coordinator tier)
        when 'organizer' then 2   -- runs an event (Lead)
        when 'host' then 1        -- lobby/rooms helper (position)
        else null end             -- 'participant' -> 0 via fallback (end user)
      when 'matchmaking' then case role
        when 'admin' then 3       -- global matchmaking authority (Coordinator tier)
        when 'matchmaker' then 1  -- assignee: sees who is ASSIGNED to her, and
                                  -- administers nobody. Founder decision
                                  -- 2026-09-25 (docs/24 §4.2) — deliberately
                                  -- below the rank-2 manager-grant threshold.
        else null end             -- 'single' -> 0 via fallback (end user)
      when 'synagogue-schedules' then case role
        when 'maker' then 1       -- writes the schedule (syn_can_write keys on
                                  -- the role NAME, not on rank). Founder
                                  -- decision 2026-09-25 (docs/24 §4.3): a maker
                                  -- may NOT mint another maker, which rank 1
                                  -- delivers twice over — 1 > 1 is false, and
                                  -- the same-role branch needs rank 3 plus
                                  -- strict scope containment this module has
                                  -- no nodes to express.
        else null end             -- 'viewer' -> 0 via fallback (implicit, never granted)
      when 'visual-messaging' then case role
        when 'admin' then 3       -- global vm authority (Coordinator tier)
        when 'moderator' then 1   -- org-wide content moderation. Its authority
                                  -- is vm_can_moderate_org()'s role-NAME check,
                                  -- which never reads rank; 1 keeps it out of
                                  -- module_has_manager_grant while letting the
                                  -- admin (3) appoint and remove it.
        else null end             -- 'member' -> 0 via fallback (end user)
      else null
    end,
    public.module_position_rank(role)
  );
$$;

-- ---------------------------------------------------------------------------
-- ACL restated explicitly rather than relied upon (docs/03 #1). `create or
-- replace` preserves the existing ACL, and the pre-change ACL was measured as
--   {postgres=X/postgres, authenticated=X/postgres, service_role=X/postgres}
-- i.e. anon already held nothing. Restating it means this migration states its
-- full intended ACL instead of inheriting one, and keeps the prod/local default-
-- privileges divergence (docs/03 #1, #27) from ever granting anon EXECUTE here.
-- ---------------------------------------------------------------------------
revoke execute on function public.module_position_rank(text, text) from public, anon;
grant execute on function public.module_position_rank(text, text) to authenticated, service_role;

comment on function public.module_position_rank(text, text) is
  'Immutable position ladder, per module. All six real modules are now mapped '
  '(matchmaking, synagogue-schedules and visual-messaging added 2026-09-25). '
  'Convention: 3 = global module authority (Coordinator tier), 2 = runs one '
  'entity (Lead), 1 = operational staff, 0 = end user. Unmapped strings fall '
  'through to the generic director/coordinator/lead/position fallback and then '
  'to 0. Changing a number here moves every authority answer that reads it at '
  'once — see docs/rank-admission-map.md, which is generated from this body.';
