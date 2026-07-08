# Module 6: Speed Dating (key: `speed-dating`, prefix `sd_`)

## Problem & context

Live video speed-dating events. Related to module 1 but kept separate (decided); shares primitives (question engine, orgs, matches) through `packages/platform`, never by importing module 1's code. Built **last** (docs/04): depends on stable platform + the two heaviest new pieces (video, live orchestration).

## Roles

- **User** — signs up, fills basic questions/criteria (question-engine primitive), requests to join organizations, signs up for events.
- **Organizer** — event setup: time, eligible users, email alerts to sign up, all timing details, recurring events; live console during events; post-event stats.
- **Host/floater** — organizer's helper: greets the lobby, handles reported rooms; no event-setup rights.
- **Admin** — sets up organizations, organizers, users; platform-wide bans.
- **Observer seats (decided 2026-07-06):** audience members (watch the active room — dating-show format) and mentors (observe + private feedback to their participant). Both require participant consent collected at event signup.

## Event formats (decided 2026-07-06)

Format is configuration, not code: pool definitions (**default: hetero two-sided**, but arbitrary), **counts per side flexible** (7v7 typical; 1v7 dating-show style supported), who rotates, round length (e.g., 7 min), break length (e.g., 30 s) — all set by the organizer at event setup. The same engine can later run networking/mentorship events (keep in mind, don't build for).

## Event experience (user)

- Pre-event **lobby** opens ~15 min early: camera/mic test, waiting room.
- Partner list (e.g., 7 names) on the left; event starts at the designated time; video on; current partner's name highlighted; countdown timer.
- Round ends → video off → break timer → **private notepad** for notes on the last encounter → next round, next name highlighted. Same experience on both sides.
- **Byes** (odd counts / asymmetric pools) get a decent "you're back in next round" screen.
- Notes persist to private history; re-encounter at a future event shows "you met on <date> — your note: …". Organizer setting controls whether repeat pairings are allowed at all.
- End of event, per person met: **interested / no-show / not interested**.
- **Pre-event resume review (decided 2026-07-06):** per-event organizer option, off by default (classic blind format). Opt-in event profile (question answers + short free-text card) shown to scheduled partners before the event or during breaks ("up next: Sarah — her card").

## Matching & reveal

- Mutual interest → both notified; contact shared per user preferences or organizer designation for the event. **One-sided interest reveals nothing.**
- Matches stored in the match DB; feeds the next event's algorithm; future synergy: module 1 compatibility scores seed the rotation (pair high scores in early rounds), and results feed back as signal.

## Orchestration engine (the real module)

- Server-authoritative state machine in the worker: rounds, clock, pairings; Postgres-persisted state + in-memory hot path; **Socket.IO** broadcasts (`round_started`, `break`, `pairing`, announcements) to all participants simultaneously.
- Rotation = round-robin (balanced two-sided: everyone meets everyone in N rounds); handles byes; **enforces block lists and no-repeat-pair settings**; supports live re-pairing.

## Video (decided 2026-07-06 — "take a look at Jitsi": evaluated, adopted)

- **Jitsi, self-hosted** (open-source; one modest VPS; P2P mode for 1:1 calls barely loads the server). Embedded via `lib-jitsi-meet` so our chrome (timer, notepad, partner list) wraps a bare video surface.
- Behind the **video-provider interface** (create room / issue token / close room) — Daily/LiveKit/JaaS swap is config, not rewrite. Local dev: `jitsi/docker-jitsi-meet`.
- Ops notes: TURN server for restrictive networks; VPS can be suspended between events.

## Organizer live console

Grid of all rooms with **connection status only (never video feeds)**; who dropped/never showed; pause/extend current round; re-pair on the fly; broadcast banner announcements; remove a disruptive user instantly. Post-event: attendance, match-rate stats, feedback survey (module 2's survey primitive).

## Safety (first-class)

Report button on every encounter (during call + end-of-event form); personal block list ("never pair me with them again", enforced in rotation across all future events); organizer report review; admin platform ban list; **no recording, ever** — an explicit product promise.

## Waitlist & balance

Capacity per side; waitlist auto-promotes only when it preserves the event's configured balance.

## Primitives used

Question engine, orgs/membership (join requests), video provider interface (owner), Socket.IO orchestration (owner), notifications, email (event alerts), surveys, match records, audit log.

## Future enhancements

Paid ticketing (Stripe, shared with module 5's payments slot); networking/mentorship event skins; module 1 score-seeded rotations.

## Schema integrated (2026-07-09)

`sd_` tables live (`supabase/migrations/20260709050000_speed_dating.sql`, local + prod): `sd_events`, `sd_participants`, `sd_rounds`, `sd_pairings`, `sd_interest`, `sd_matches`, `sd_notes`, `sd_reports`, `sd_blocks`, `sd_bans`. Manifest registered but **not enabled for any org** — schema only, no UI, fully dark. Drafted by a background agent (`modules/speed-dating/schema-draft.sql`), hand security-reviewed (`schema-fixes.sql`), all guards verified live (24/24 assertions).

Key design choices (agent, reviewer-confirmed): observer seats (audience/mentor) are `sd_participants.seat_type` values, not roles; consent flags live on the observed row; one pairing row per meeting with NULL b = bye; roster visibility limited to scheduled partners via `sd_paired_with()`; notes are a strictly private cross-event notepad keyed by user pair (invisible even to organizers); interest read excludes hosts; bans org-scoped (true cross-org bans = superadmin tooling, deferred); no question engine yet (`profile_card`/`profile` stand in until the platform primitive is extracted — spec'd as shared between modules 1 and 6).

Security-review pass built all nine flagged guards (T1–T9): event/round state-machine triggers + single-active-round partial unique; participant column pins (self-editor = check-in/consents/profile/withdraw only — no waitlist self-promotion, no pool switching; host = removal only); pairing cross-slot double-booking check + per-round partial uniques; interest identity pin; note/report pins with server-side `reviewed_by` stamps; and **the mutual-interest reveal mechanism**: an AFTER trigger on `sd_interest` upserts a canonical unrevealed `sd_matches` row when interest becomes reciprocal (deletes it if retracted pre-reveal), and `sd_reveal_matches(event_id)` — organizer-gated definer function — is the single audited reveal path. RLS hides unrevealed matches from both parties; a rejected side is indistinguishable from an undecided one.

Two reviewer findings beyond the flagged TODOs: (a) `sd_can_manage` now delegates to the platform's `is_org_admin()` (docs/03 convention #9); (b) **a live-discovered RLS gotcha** — the draft's own-row SELECT policy used `sd_owns_participant(id)`, a definer function querying the same table, which breaks `INSERT … RETURNING` (the function's snapshot excludes the row being inserted); replaced with a direct `user_id = auth.uid()` comparison. Rule for docs/03: a table's own policies use direct column checks, never self-referential lookups.

**Remaining for module 6:** all UI (event setup, registration, lobby, live rounds, interest submission, match reveal, organizer live console), the `speeddating.event-orchestrator` worker (round clock, rotation build honoring blocks/repeats, room provisioning), the Jitsi provider interface, waitlist auto-promotion, contact-share population on reveal.
