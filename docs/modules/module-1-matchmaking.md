# Module 1: Make-a-Match (key: `matchmaking`, prefix `mm_`)

## Problem & context

Matchmaking platform for dating. WhatsApp-style app (mobile-first PWA). Platform starts from an empty slate — all questions, including hard filters like gender, are created through the same question mechanism by the admin.

## Roles

- **Single** — answers questions, submits question proposals, sees own top matches, messages admins.
- **Matchmaker** — submits question proposals; selects a single from those they have access to (admin assigns individuals or groups); sees that single's matches, including ranked queries ("show the 10 highest-percentage matches"); messages admins.
- **Admin** — everything the others can do, plus: change user roles; review/tweak/approve submitted questions (notified of pending approvals); review messages from all users; define groups of singles and assign matchmakers to individuals or groups; set all algorithm/display settings.

## Questions & answers

- A question = text + a scale of **up to 5 labeled points** (submitter provides lower-bound text, upper-bound text, up to 5 total labels). Example: "I exercise" → Never / sometimes / monthly / daily / All day long.
- **Answer slider:** the user's own position on the scale.
- **Care slider (recentered, decided 2026-07-06):** **−10 … +10**. Sign = what you want (negative = opposite of me, positive = same as me); magnitude = how much you care; **0 = don't care**. (Replaces the original 0–20 formulation whose midpoint/endpoints were ambiguous.) UI renders one slider with labels at −10 / 0 / +10; default label text admin-tweakable.
- **Dealbreaker flag:** a checkbox beyond the slider that upgrades the preference to a hard filter. A failed dealbreaker in either direction excludes the pair entirely (no scoring, no list appearance).
- **Admin locks:** per question, admin can lock any combination of {answer, care, dealbreaker}. Hard filters are ordinary locked questions — e.g., "I am: Male / Female" with care locked at "opposite + dealbreaker" enforces male↔female matching. Some criteria left to users, some forced/locked by admin, all through the same mechanism.
- **Approval workflow:** singles and matchmakers submit; admin tweaks (text, labels, defaults, locks) and approves; admin notified of pending items.

## Auto-answers (decided 2026-07-06)

- Every user gets a vanilla auto-answer per question: middle-of-scale answer + care 0 (which, on the recentered scale, means untouched questions demand nothing of others).
- Answers are marked `auto` vs `touched`; the user sees which is which.
- A newly approved question materializes for a user **only after they log in and see it** — until then it doesn't exist for pairs involving them.

## Matching algorithm

- Directional score A→B: for each question, B's answer evaluated against A's expected answer (same or mirrored per sign of A's care) weighted by |A's care|; normalized. B→A likewise; the two combine into the pair's match percentage.
- **Pair-score table** persisted. When a user touches answers, only their rows are marked stale (O(N) recompute per update, not O(N²)). Full recompute only when admin changes algorithm-level settings. A continuous worker (`matchmaking.rescore`, pg-boss) processes stale rows — matches feel near-live; an idle population costs nothing.

## Matches, privacy, introductions

- Singles see their top **X** matches (X admin-set).
- Per-answer **"share with potential match"** checkbox controls what a match sees pre-introduction.
- Mutual agreement → introduction: via a matchmaker, or by sharing whatever contact info the single opted to share in settings. One-sided interest reveals nothing.

## Scoring decisions (founder, 2026-07-07 — answers to build-time questions)

1. Two measurements per answer: the user's own position, and how much they care that the
   other person's answer matches theirs.
2. care = 0 contributes exactly zero weight (auto-answers are mathematically inert on the
   answerer's side).
3. **No nulls anywhere**: every user has a numeric default answer on every question, and the
   pair score pools all cared-about (weight × closeness) terms from BOTH directions into one
   weighted average. Zero pooled weight (two untouched users) = 0%, displayed, never null.
4. Admin-locked question values (e.g. gender's care −10 + dealbreaker) need a materialization
   mechanism at answer-save time — the user supplies only the position; locks fill the rest.
   Build at module integration.
5. Answers referencing unknown/deleted questions are skipped defensively during scoring.
6. Top-matches list: plain descending sort by percent; no secondary tiebreak.

## Messaging

- v1: users → admins only (platform feedback / issues), via the generic conversations primitive.
- **Future enhancement (documented, not built):** peer chat between introduced singles — conversations container deliberately not hard-wired to admin inboxes.

## Settings (admin)

Top-X visible matches; care-slider label text; default locks; group definitions; matchmaker assignments.

## Primitives used

Question engine (owner), approval queues, conversations, notifications, settings+locks, pair-score worker pattern, audit log.

## Future enhancements

Peer chat; feeding module 6 (shared question primitives; compatibility scores could seed speed-dating rotations; mutual results feed back as signal).

## Schema integrated (2026-07-09)

`mm_` tables live (`supabase/migrations/20260709020000_matchmaking.sql`, local + prod): `mm_questions`, `mm_answers`, `mm_pair_scores`, `mm_groups`, `mm_group_members`, `mm_matchmaker_assignments`. Manifest registered (`packages/platform/src/modules.ts`) but **not enabled for any org yet** — no UI exists beyond the schema, so it stays dark until the question/answer/matches pages are built.

Design choices worth recording:
- **Lazy materialization, no flag**: a missing `mm_answers` row *is* the not-yet-seen state (matches `directionalScore()`'s skip-if-absent). `mm_ensure_answer(question_id)` RPC creates the vanilla auto-answer (locks applied) on first view.
- **Admin locks enforced by trigger** (`mm_answers_before_write`): overwrites any locked field from `mm_questions.admin_locks` on every insert/update — a single cannot bypass a lock by writing directly.
- **Canonical pair ordering**: `mm_pair_scores` rejects `user_a >= user_b` via CHECK; the writer (worker) is responsible for sorting before upsert.
- **No user write path to `mm_pair_scores`** at all — worker/service-role and admin only, matching "the worker computes it." An on-demand "recompute me now" button, if ever wanted, would need a `job_requests`-style request row a user CAN insert, not a direct write here.
- **Messaging deferred**: no conversations/messages primitive exists yet anywhere in the platform; building one for this module alone would violate "never build primitives speculatively." Revisit when a second module needs it.

Security-review fixes (`modules/matchmaking/schema-fixes.sql`, folded into the migration), both verified live against Postgres before merging:
1. `mm_ensure_answer()` is `SECURITY DEFINER` and bypasses RLS — the draft let *any* authenticated caller create an answer row, skipping the "only singles answer" role gate the INSERT policy enforces for direct writes. Added an explicit `mm_is_single(org_id)` check inside the function.
2. The UPDATE policy let a single repoint their own answer's `question_id`/`user_id` via UPDATE (only `user_id = auth.uid()` was checked), corrupting the one-row-per-(question,user) invariant. Added a pin-to-old-value trigger, named to fire alphabetically *before* the lock-enforcement trigger so it reverts the pointer before locks/org_id get derived from the wrong question.

## Group/matchmaker-assignment management UI (2026-07-11)

The last item on this module's "remaining" list. `mm_groups` /
`mm_group_members` / `mm_matchmaker_assignments` had schema, RLS, and even the
matchmaker's own read-scoped view since 2026-07-09 — but **no admin UI ever
existed to create the rows**; the demo seed populated them directly via the
service role, so a real admin had no way to run the "define groups... assign
matchmakers to individuals or groups" workflow this spec's Roles section
describes. Manage console now has it: create a group, add/remove members by
email, assign a matchmaker (by email) to an individual single or a group,
with a live list + remove. No migration — every write already lands on the
existing admin-only `mm_can_manage` staff policy. **Module 1's only remaining
gaps are the mutual-agreement→introduction flow and the platform-wide
conversations primitive** (still deferred — no second module has forced it
yet).

**2026-07-12 follow-up (founder testing round):** the assignment form's
individual-vs-group target fields were both always visible and fillable
regardless of which was selected, and nothing rejected filling both.
Rewritten as a client component (`assign-matchmaker-form.tsx`) that shows
exactly one target input at a time — the unselected field's `name` attribute
is entirely absent from the submitted FormData, not just visually hidden, so
mutual exclusivity is enforced at the DOM level, not just in the eye. Both
email fields also gained `<datalist>` suggestions from existing
matchmakers/singles instead of blind free-text. Also confirmed: there is
still no UI for GRANTING the matchmaker/single module roles themselves
(only for assigning an *existing* matchmaker to an *existing* single/group)
— that's the same "no self-serve org-admin management" gap recorded in
CLAUDE.md's 2026-07-12 entry, not specific to this module. (Role granting
shipped later that day as the platform-wide `/o/<slug>/members` page.)

## Mutual agreement → introduction (2026-07-12 schema, 2026-07-16 UI)

The spec line "Mutual agreement → introduction … One-sided interest reveals
nothing" (line 37) is now BUILT — this was the module's last real gap.
Migration `20260712040000_matchmaking_interests.sql`: `mm_interests` records
a single's directional interest in one specific match (insertable only for
real non-excluded scored pairs, RLS-enforced); interest is private to its
author — the SELECT policy never exposes incoming interest, so a one-sided
crush is invisible to its target, and matchmakers can't read raw rows either.
The reveal is two definer functions: `mm_mutual_matches()` (for the calling
single: every reciprocal interest, with display name + email — that IS the
introduction) and `mm_mutual_pairs(org)` (facilitation view: admins see all
mutual pairs, matchmakers only pairs involving an assigned single).
Live-verified 12/12 as real users (one-sided invisible in every direction,
mutual reveals both ways, uninvolved/excluded/impersonation all rejected).

UI (2026-07-16): each match row in the single view gets **Express interest**
/ **Withdraw interest**; an **It's a match!** section lists mutual reveals
with contact info. Matchmaker view gains **Mutual interest — make the
introduction**; the admin Manage console gains the same list. Demo seed:
Charlie↔Dana mutual, Eve→Charlie one-sided. e2e drives the full live chain
(express → nothing revealed → reciprocate → both revealed → withdraw →
reveal gone).

**DECIDED (founder, 2026-07-16):** on a mutual match, reveal name + email
directly to both sides, plus whatever else each side flagged to share —
**no matchmaker routing.** This closes the open question recorded
2026-07-12/sketched 2026-07-16 (the matchmaker-only alternative below is
kept only as a record of what was considered, not something to build):

- The matchmaker-only alternative would have dropped `email` from
  `mm_mutual_matches()` and routed every introduction through
  `mm_mutual_pairs()` instead — rejected in favor of the current direct-reveal
  design, which is already live and needs no change.
- **Live behavior already matches this decision** — no rebuild needed.
- **One loose end from the decision's exact wording** ("whatever other info
  is selected to be shared... which the other also selected to share"): the
  share-flagged answers (`mm_shared_answers()`) already surface on a
  single's regular **matches list** (visible to anyone who scores as a
  match, independent of mutual interest) — they are NOT currently
  duplicated into the "It's a match!" panel itself, which today shows only
  name + email. Flagged for the founder to confirm whether that's wanted
  too, or whether having it on the matches list above is sufficient.

**Module 1's only remaining gap is the platform-wide conversations
primitive** (users→admin messaging, still deferred — no second module has
forced it yet).
