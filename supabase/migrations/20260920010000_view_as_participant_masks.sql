-- View-as MODE 1 for speed-dating's `participant` position: per-row "is this
-- row mine?" masks, so an admin can experience the module as an ordinary
-- participant without their own admin reach spoiling it (2026-09-20).
--
-- FOUNDER DECISION, 2026-09-20. An admin who registers for a real event wants
-- the genuine participant experience — the suspense of not knowing who liked
-- them back. Today they cannot have it: RLS hands an org admin every
-- sd_interest row for every event in the org (is_org_admin is the first
-- disjunct of module_caller_covers_rank, so admin authority does not depend on
-- holding any speed-dating role at all), and the participant screen would show
-- it. The founder's framing: a VOLUNTARY BLINDFOLD — "I choose not to know."
--
-- WHY THIS IS A MASK AND NOT A PERMISSION CHANGE. Two layers, and only the
-- second one moves here:
--   1. RLS decides what the caller MAY read. Untouched by this migration. No
--      policy, no predicate, no grant is altered. An admin still may read
--      everything; nothing is revoked from anyone.
--   2. The view-as renderer decides what to DISPLAY, and can only ever SUBTRACT
--      from what layer 1 returned (packages/platform/src/view-as.ts's header:
--      "a declaration can only ever narrow what that client already returns").
-- So this is an honesty/UX feature, NOT a security boundary — the same admin
-- can open the organizer console in another tab and see everything. That is
-- accepted and recorded, because the blindfold is chosen, not imposed. Nothing
-- here may be cited as an access control.
--
-- WHY FUNCTIONS INSTEAD OF A COLUMN FILTER — the problem these solve. The
-- renderer narrows "to me" with `eq(subjectColumn, <caller's user id>)`, so a
-- surface table needs a column naming the person as a USER. sd_participants
-- (user_id) and sd_notes (author_user_id) have one. The three tables that
-- carry the actual suspense do NOT: sd_interest keys on rater_participant_id
-- and sd_matches/sd_pairings on participant_a_id/participant_b_id — all
-- PARTICIPANT SEAT ids, one hop away from a user id, and the match/pairing
-- case needs "a OR b", which a chain of equality filters cannot express.
-- Declaring `subjectColumn: null` is not an option: null means "not per-person,
-- unfiltered in BOTH modes by design", which for an admin renders the entire
-- interest graph on a screen labelled "as a participant" — worse than having no
-- feature, because it looks blinded.
--
-- WHY THESE FUNCTIONS ARE ONE LINE EACH, AND THAT IS THE POINT. Each simply
-- calls the module's OWN seat predicate — the very expression already sitting
-- in that table's RLS policy as the participant's arm:
--     sd_interest_select : sd_can_organize_event(...) OR sd_owns_participant(rater_participant_id)
--                                                        ^^^^^^^^^^^^^^^^^^^^ this arm
-- sd_owns_participant already performs the user -> seat hop internally
-- (`p.id = check_participant_id and p.user_id = auth.uid()`), which is exactly
-- the indirection the renderer lacks — already written, already audited,
-- already deployed since 20260709050000 and org-gated since 20260910040000.
-- Reusing it means the mask cannot drift from the real definition of "mine",
-- and no second implementation of seat ownership exists to go stale. A parity
-- test asserts each mask's predicate still appears in that table's live policy.
--
-- SELF-ONLY BY CONSTRUCTION, which is what keeps the review small. Every
-- predicate below keys on auth.uid() inside sd_owns_participant. There is no
-- parameter for "whose rows" — these functions CANNOT be pointed at a third
-- party even by a caller who wants to. That matters because view-as mode 2
-- ("see what Smith sees") stays permanently OFF for `participant` (docs/15
-- §8.1 point 7's end-user ban, which bans impersonation of an end user and
-- says in the same breath "Mode 1 stays available everywhere"). So these masks
-- only ever answer "is this row MINE", never "is this row Smith's".
--
-- WHAT THEY EXPOSE: nothing new. A caller can already read these rows — that is
-- the premise of masking them. The boolean answers "is this row mine", about
-- the caller's own seat, which the caller necessarily already knows. Computed
-- columns are evaluated per returned row, so the answer is only ever produced
-- for rows RLS already released.
--
-- ACLs stated explicitly (docs/03 #1 — prod's ALTER DEFAULT PRIVILEGES grants
-- EXECUTE to anon/authenticated on CREATE, which `revoke from public` does not
-- remove, and local does not reproduce that). `authenticated` needs EXECUTE
-- because PostgREST evaluates a computed column as the querying role. `anon`
-- holds nothing: every one of these is meaningless without a session, and an
-- unauthenticated caller reaches no sd_ row anyway.
--
-- STABLE, not IMMUTABLE: they read tables and auth.uid().

-- ---------------------------------------------------------------------------
-- sd_interest — "did I mark this interest?" The rater side only. The TARGET
-- side is deliberately NOT masked into visibility: a participant may never
-- learn who marked interest in THEM (that is the one-sided secret whose RLS
-- gives the rated person no read path at all, and the entire reason the
-- suspense exists). This mask narrows; it never reveals.
-- ---------------------------------------------------------------------------
create or replace function public.sd_interest_mine(public.sd_interest)
returns boolean
language sql
stable
as $$
  select public.sd_owns_participant($1.rater_participant_id);
$$;

revoke execute on function public.sd_interest_mine(public.sd_interest) from public, anon;
grant execute on function public.sd_interest_mine(public.sd_interest) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- sd_matches — "am I either side of this match?" Mirrors the policy's own
-- `sd_owns_participant(participant_a_id) OR sd_owns_participant(participant_b_id)`
-- shape. Note the policy ALSO requires `revealed` for the participant arm;
-- that is left to the surface declaration's own filter rather than baked in
-- here, so this function answers exactly one question — ownership — and the
-- reveal rule stays visible where a reader expects it.
-- ---------------------------------------------------------------------------
create or replace function public.sd_matches_mine(public.sd_matches)
returns boolean
language sql
stable
as $$
  select public.sd_owns_participant($1.participant_a_id)
      or public.sd_owns_participant($1.participant_b_id);
$$;

revoke execute on function public.sd_matches_mine(public.sd_matches) from public, anon;
grant execute on function public.sd_matches_mine(public.sd_matches) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- sd_pairings — "was I in this pairing?" Same two-sided shape.
-- ---------------------------------------------------------------------------
create or replace function public.sd_pairings_mine(public.sd_pairings)
returns boolean
language sql
stable
as $$
  select public.sd_owns_participant($1.participant_a_id)
      or public.sd_owns_participant($1.participant_b_id);
$$;

revoke execute on function public.sd_pairings_mine(public.sd_pairings) from public, anon;
grant execute on function public.sd_pairings_mine(public.sd_pairings) to authenticated, service_role;

-- PostgREST caches the schema; without this the computed columns are invisible
-- until the next reload and every masked query fails with an unknown-column
-- error rather than degrading quietly.
notify pgrst, 'reload schema';
