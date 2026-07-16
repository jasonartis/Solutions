# Module 7 (proposed): Redt-It — matchmaker-suggestion network

> **STATUS: DRAFT / NOT SCOPED — do not build.** Captured from the founder's
> 2026-07-16 proposal so nothing is lost before the real planning session.
> Nothing here is a decision; anything phrased as a recommendation is this
> session's opinion, offered because the founder asked for it, not something
> to build without confirmation. Follows the module-spec format used by
> modules 1–6 (docs/03) so it slots in as `module-7-redt-it.md` once real.

## Problem & context (as described)

A lighter-weight alternative to Make-a-Match's algorithmic scoring: instead
of a compatibility engine ranking every pair, a human (a "shadchan"/
matchmaker) makes a quick, low-effort suggestion — "I think A and B should
meet" — and the platform handles the back-and-forth (notify both sides,
collect yes/no, reveal contact info on mutual yes, track the outcome). The
founder's framing: today, suggesting a match to someone you know requires
tedious individual outreach to both sides; this collapses that to "make the
suggestion, done" and lets the platform carry the rest.

## Roles

- **Single** — receives suggestions, responds thumbs up/down/not-now, sees
  matches + follow-up questionnaire.
- **Matchmaker** — searches the single pool, makes suggestions, can attach a
  note (to one side, to both together, or a separate note per side). No
  admin assignment of matchmaker→single (unlike module 1) — any matchmaker
  can suggest any pair.
- A user can hold **both** roles simultaneously.

## Core flow (as described)

1. Matchmaker searches for a single. If not found, sends a **platform
   invite** to join. (New primitive — see Open Questions: nothing today lets
   a matchmaker invite someone who doesn't have an account yet into a
   specific pool.)
2. Matchmaker picks Person A + Person B, optionally writes a note (to A, to
   B, to both, or different notes to each) — submits. That's the entire
   matchmaker action; no further step required of them.
3. Each single gets a notification: sees the suggestion, who it's from, and
   (per the info-sharing model, still undecided — see below) enough about
   the other person to decide.
4. Each single responds independently: **thumbs up**, **thumbs down**, or
   **not right now**.
   - A thumbs-up, once given, **cannot be reversed** by the person who gave
     it.
   - Any other response **can** be changed later (re-reading this needs
     confirming — see Open Questions #1).
5. When **both** sides have thumbed up: contact info trades automatically in
   both directions, and each single gets a message prompting them to reach
   out.
6. **Matches** section: the revealed pair, going forward.
7. **Follow-ups** section: a short questionnaire per match — did you reach
   out? did you meet? phone call? video call? text conversation? (open to
   more channels) — plus a 1–N "how on-target was this suggestion" scale.
   This is explicitly meant to feed the ranking mechanism below.

## Info shown when viewing a suggestion (undecided — two candidate designs)

- **(a) Reuse Make-a-Match's data**: the same question/answer database,
  share-flagged answers exactly as module 1 already does.
- **(b) Independent**: singles upload/share a "resume" (PDF or similar);
  that's what's shown instead of question answers.
- **Either way**: the matchmaker must be able to glance at this same info
  *before* making the suggestion — which is a materially different privacy
  posture from module 1 (there, a matchmaker only ever sees *scores* for
  singles an admin assigned them; here, ANY matchmaker needs some level of
  read access to ANY single's dossier to judge a potential match). This is
  its own design decision, not a detail — worth treating as a first-class
  open question, not an implementation afterthought.
- Regardless of (a)/(b): **contact info must be explicitly filled in and
  consented to for sharing** by each single, independent of whatever
  descriptive info is shown pre-match.

## Anti-abuse / suggestion ranking (as described, needs precision)

The founder's stated concern: without a check, matchmakers could spam every
male-female combination. Two rules were described to counter this:

1. "The more you own from a person, the lower on the list their suggestions
   should move" — **best-guess reading**: the more suggestions a given
   matchmaker has already made *about* a particular single, the lower that
   matchmaker's *future* suggestions rank in that single's queue (a
   frequency throttle, not a hard block). **Needs confirmation** — "own"
   may not be the intended word; could also mean something about how much
   of that single's info/history the matchmaker has already seen.
2. "The more you say yes to a person's suggestions, the more their
   suggestions should move up your list" — a per-(matchmaker, single) trust
   score that rises with accepted suggestions and (presumably, symmetric to
   #1) falls with rejections — surfacing a trusted matchmaker's future
   suggestions more prominently.

Together these describe a **reputation/ranking system per (matchmaker,
single) pair**, not just a suggestion table — this is a genuinely new
primitive, closer to a recommendation-ranking algorithm than anything else
on the platform. It deserves its own design pass (formula, decay, gaming
resistance) before scaffolding, and per the standing model-choice rule
(CLAUDE.md), the algorithm-design piece is a reasonable candidate for a
higher-effort session even though the CRUD/UI around it is routine.

## Scope: matchmaking-specific vs. general networking (founder's own framing)

The founder explicitly frames this as potentially two things layered:

- A **general** "suggest two people who might benefit from knowing each
  other" primitive (e.g., "you're an architect, meet this other architect
  with a similar background") — no gender restriction, general networking.
- A **matchmaking-specific configuration** on top, switched on per
  deployment, that restricts to male↔female suggestions (mirroring module
  1's gender-dealbreaker precedent) and frames the UI around dating.

**Worth flagging directly**: docs/00's first principle is "extract the
platform from real modules; never build it speculatively" — building the
general version *before* a second concrete client need exists is a
deliberate, informed exception to that rule, not an accidental one. That's
a legitimate call to make (the founder is the one who gets to decide the
business tradeoff), but it should be made consciously: either (a) build
matchmaking-only now and extract the general form later if/when a real
networking client shows up, or (b) build the general form now because the
two use cases are already both intended. Recommend confirming which,
explicitly, before scaffolding — don't let it default to "build both" by
inertia.

## Open questions (need the founder's answers before scoping)

1. **Thumbs-up irreversibility, precisely**: does "can't be reversed" mean
   the giver can never retract their own yes (even before the other side
   answers), or does it just mean a MUTUAL yes (both sides) becomes
   permanent? These have very different DB-trigger designs (an immutable-
   once-written column vs. an immutable-once-both-sides-agree state).
2. **Invite-a-stranger flow**: today, every module's onboarding assumes the
   person already has a platform account (an admin adds an existing user by
   email). "Search the database, and if not there, invite them" is a new
   growth primitive — does an invite create a pending/placeholder record, an
   email-magic-link signup flow, or something else? Who can see/manage
   pending invites?
3. **Tenancy/pool scope — the founder's own open question, with a
   recommendation**: should Redt-It, Speed Dating, and Make-a-Match share
   users/profiles, or stay fully separate? **Recommendation: keep them
   separate**, agreeing with the founder's own lean, for reasons grounded in
   the existing architecture rather than just agreement:
   - Every other module scopes its data to an **org** (one client
     engagement = one org, docs/00 principle #2). Redt-It's own description
     — "assuming all singles are in the app," "no specific matchmaker to a
     single," "a matchmaker can search for a single in the database" —
     implies a single, platform-wide pool, not an org-scoped one. That's
     already a different tenancy shape than every existing module, before
     even asking about sharing with two OTHER org-scoped modules.
   - Make-a-Match's algorithmic scoring and Speed Dating's rotation engine
     are both **automated matching engines**; Redt-It is a **human-curated
     suggestion engine**. Even if the "answer these questions about
     yourself" data *could* theoretically be shared, the action model
     differs enough that coupling the three risks violating the hard rule
     that modules never import each other (docs/03) — you'd end up with a
     shared users/profiles table three modules all depend on, which is
     exactly the kind of premature shared-platform surface docs/00
     principle #1 warns against building before a real second need forces
     it.
   - If a specific client later wants "my Make-a-Match users should also be
     my Redt-It users, one profile," that's a concrete second need — extract
     a shared profile primitive *then* (extract-don't-speculate), not now on
     spec.
4. **Tenancy/pool scope, part 2 (follows from #3)**: if Redt-It really wants
   one platform-wide pool rather than per-org, what IS the org for it? A
   single dedicated "Redt-It" org everyone joins (breaking the "org = one
   client engagement" pattern deliberately, on purpose, for this module
   only)? This needs to be decided explicitly, not left implicit.
5. **Matchmaker pre-suggestion visibility**: how much of a single's info can
   ANY matchmaker see before suggesting (not just an assigned one, per
   module 1's model)? Full resume/answers, or a redacted preview?
6. **Follow-up questionnaire ownership**: who sees follow-up answers — just
   the two singles, or also matchmakers/admins (to measure their own
   suggestion quality, feeding the ranking system)?
7. **Resume/PDF option, if chosen**: what happens to a resume after a
   suggestion is declined — deleted, retained, versioned? Same retention
   question the platform already had to answer for classroom submissions.

## What already exists on the platform this can likely reuse

- The **mutual-agreement → introduction** pattern (module 1's
  `mm_interests` / `mm_mutual_matches`, shipped 2026-07-16) is structurally
  very close to "two thumbs-up reveal contact info" — worth reviewing as a
  starting point for the RLS/definer-function shape even if the schema
  itself stays independent per the "keep separate" recommendation above.
- The platform's existing **export** primitive (authorship-first) would
  cover a single exporting their own answers/resume/follow-up responses.
- If gender-restriction is switched on, module 1's admin-locked
  care/dealbreaker pattern is the direct precedent.
