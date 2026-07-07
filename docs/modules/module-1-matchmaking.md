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
