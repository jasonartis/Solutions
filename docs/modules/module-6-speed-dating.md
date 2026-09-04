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

**Remaining for module 6 (2026-07-09 snapshot, since superseded — see below):** all UI, the orchestrator worker, the Jitsi provider interface, waitlist auto-promotion, contact-share population on reveal.

## UI + orchestrator worker shipped (2026-07-09)

Event setup, registration, lifecycle controls, the real rotation engine +
automatic round-clock worker (replacing the manual organizer stand-in), and
the mutual-interest reveal all shipped — see the CLAUDE.md state log entries
for 2026-07-09. Module 6 became event-runnable minus video.

## Notes/reports/blocks UI + a real host-tier gap fixed (2026-07-11)

The three tables that had schema but no UI (`sd_notes`, `sd_reports`,
`sd_blocks` — all security-reviewed 2026-07-09) are wired up, no migration
needed. Participants get **Private note** (author-only, never visible to
staff) and **Report** on every person in "People you met", plus **Never pair
me with them again** — a personal, cross-event block managed from a new
**People you've blocked** section on the main page. Staff (organizer OR
host — `sd_can_staff_event`) get a **Roster & reports** section with triage;
the reported person never has a read path.

**Real gap fixed:** the event page previously gated everything on
`sd_can_organize`, so a pure **host** (a distinct module role with lobby/
safety duty but no event-setup rights) saw nothing but the page header — not
even the roster. Now gates roster+reports on the broader `sd_can_staff_event`,
and a `host` walkthrough guide was added.

**Latent platform bug found, NOT fixed here (flagged for its own pass):** the
generic help-guide route gates `staff: true` guides on `module_can_manage`
(org-admin tier), but every module's "staff" guide actually means
"operational tier" (organizer/host here; professor/GA, matchmaker-admin,
cashier/manager, moderator elsewhere) — a real non-admin staff member would
404 on their own guide. Masked in every demo seed because the demo
organizer/professor/etc. also happens to be an org admin. Cross-cutting
(one shared route, every module) — deliberately not rushed into this slice.

**Still remaining:** Jitsi video (needs the VPS), lobby/live-round UI,
resume-review profiles, waitlist auto-promotion, contact-share population on
reveal.

## Lobby/live-round UI shipped (2026-07-16)

Closed the "lobby/live-round UI" item above — a fresh survey (not stale
notes) confirmed video specifically needs the VPS decision, but a live
pairing display doesn't. No migration: `sd_rounds`/`sd_pairings` already had
schema + RLS letting a participant read their event's rounds and their own
pairings; this was pure app-logic work reading data nobody had surfaced yet.

**"Right now" panel** (participant's event page, shown while the event is
`running`): who you're currently paired with (or a bye, or "not in this
round" if not checked in), with a live countdown to the round's end —
computed from `sd_rounds.ends_at`, not from the `state` column. Real finding:
the `'break'` state in the schema's CHECK is never actually written by the
orchestrator — a round stays `'active'` through its whole round+break window,
and only `ends_at` distinguishes "still going" from "on break" (the
orchestrator computes the break deadline inline and only flips to
`'complete'` once BOTH have elapsed). So the panel infers round-vs-break from
`now` vs `ends_at`/`ends_at + break_duration_seconds` client-side, matching
the orchestrator's actual behavior rather than the unused schema state.

**Real bug found and fixed before it shipped as "working":** the manual
"Run next round" button (`runPairingRound`, the pre-worker stand-in used by
organizers and by e2e) never set `ends_at` on the round it created — only
the orchestrator did. The new countdown would have silently shown nothing
for every manually-run round (i.e., every deployment without the worker
running). Fixed by mirroring the orchestrator's `ends_at` calculation in the
manual action too, so both paths produce an equivalent round. The display
also degrades gracefully (shows the pairing without a timer) if `ends_at` is
ever still null, rather than disappearing.

A small `lobby_opens_at`-driven banner ("The lobby is open — starts at …")
was added too — that column existed in schema since 2026-07-09 but was never
read anywhere. Auto-refresh (`LiveRoundRefresh`, a tiny client component
polling `router.refresh()` every 15s while the panel is showing) keeps the
countdown current without a full reload — matching the platform's existing
poll-not-push rhythm (matchmaking rescore, this module's own orchestrator)
rather than wiring up Realtime for one panel. The organizer console's summary
line also gained the same round/break countdown.

e2e extended (not a new test): charlie's event page now asserts the "Right
now" panel and its countdown text; the organizer's summary line assertion
extended to check for the countdown too.

**Still remaining:** Jitsi video (needs the VPS decision), resume-review
profiles beyond the profile card already shipped, contact-share population
on reveal.

## Two-sided capacity + waitlist (2026-07-16, base built on Sonnet — capacity check needs Opus)

Founder-directed follow-up after discovering, mid-scope, that "waitlist
auto-promotion" depended on a feature that didn't exist yet: **pool sides
were never actually used anywhere in the app** — `pool_side` was never set
by any registration flow, so every real event ran as a single undifferentiated
pool regardless of the schema's two-sided support. Rather than build waitlist
promotion in a vacuum, this pass built the side-selection feature it actually
depends on, with the founder's explicit answers to four design questions:

1. **Side assignment**: participant self-selects at registration (not
   organizer-assigned).
2. **Opt-in per event**: single-pool stays the default (unchanged); an
   organizer can enable "two sides" with custom labels + optional
   per-side capacity at event creation (a `<details>` disclosure on the
   create-event form, collapsed by default).
3. **Labels**: fully custom text (not hard-coded Men/Women) — matches the
   schema's existing support for other pool shapes (e.g. mentor/mentee).
4. **Capacity lowered after registration**: already-registered people are
   grandfathered in; a new lower cap only affects future registrations.

**Concrete failure mode this replaces** (walked through with the founder
before building): with a single overall cap and no side awareness, a real
event could accept, say, 5 women and 0 men purely by whoever clicked
register first — unusable for hetero pairing, since the rotation engine
needs both sides present to form any pairing at all. Per-side capacity
guarantees the accepted pool always matches the organizer's intended split
regardless of registration order. (A genuinely uneven but *accepted* pool,
e.g. 4 men/2 women both within cap, is a *different*, already-solved
problem — the rotation engine already pads the smaller side with byes and
rotates, unit-tested since 2026-07-09. Per-side capacity only prevents
over-acceptance; it doesn't manufacture participants.)

**Shipped** (`modules/speed-dating/ui/event-format.ts`, no migration — format
is Zod-validated-at-write-site jsonb, docs/03 rule #7): event creation's
optional two-sides config; a side selector on registration; per-side
registered/waitlisted counts + labels in the staff roster; a
`promoteNextWaitlisted` action.

**Two real bugs caught by e2e before shipping as working, same shape as the
nail-salon customer/time-off gap (2026-07-16)**: (1) a plain participant
cannot write another participant's row (`sd_participants_update_self` is
`user_id = auth.uid()` only) — so promotion CANNOT be triggered from the
withdrawing participant's own action; it's staff/organizer-triggered instead
(mirroring the module's existing manual-round-advance-stands-in-for-worker
pattern). (2) The capacity check itself: `registerForEvent`'s per-side
capacity count ran under the REGISTERING PARTICIPANT's own session, and
`sd_participants_select` only lets a participant see their own row (or
staff, or someone they've actually been paired with — neither applies to a
fresh registrant). The count therefore always saw zero other registrants,
and capacity enforcement silently never triggered — confirmed live when a
second registrant on a size-1-capacity side was wrongly accepted as
`'registered'` instead of `'waitlisted'`.

**Capacity check fixed (Opus session, `20260716020000`, full docs/03 #12
rhythm).** New `SECURITY DEFINER` function `sd_side_registered_count(event,
side) → integer` returns ONLY the count of registered participants on a side
— never the rows, identities, or statuses — so a registrant's own session
gets the true number without `sd_participants_select` being widened (which
would expose participant identities to every co-registrant). The count is
taken only when the caller is a member of the event's org (`is_org_member`
inside the WHERE, org derived through the event row, not caller-supplied), so
a non-member always gets 0 and can't probe another org's event sizes.
Independently security-reviewed (SHIP AS-IS — no cross-tenant leak, only an
integer escapes, count filters `status='registered'` correctly), live-
verified 5/5 as real users (the load-bearing case: a *different* member gets
the true count via the RPC while their direct query — RLS-scoped — sees 0),
and covered by a tracked RLS test (non-member gets 0) plus the now-un-skipped
e2e (register → capacity forces waitlist → withdraw → organizer promotes).
`registerForEvent` and `promoteNextWaitlisted` both route the count through
the RPC (one source of truth). RLS 16/16, e2e 33/33. The promotion mechanism
(`promoteNextWaitlisted`) was already correct and staff-safe.

## Video-provider interface, JWT join tokens, and contact-share population (2026-09-04, Sonnet — no migration)

The three items CLAUDE.md's "Still remaining" line carried forward. Ordered
per the founder's brief: the non-UI half first, because local `next dev`/
`next build` are both blocked on this machine (exFAT/Turbopack/`@sentry/
nextjs` junction-point issue) — verified via `pnpm exec turbo run typecheck
--force` (9/9 packages clean) and the db/module test suites (147 db tests,
21 new speed-dating unit tests), never via a running browser.

**1. Jitsi video — the provider interface + JWT issuance (the largest
unbuilt item, still not deployed).** `modules/speed-dating/src/video/`:
`provider.ts` (the interface: `createRoom`/`issueToken`/`closeRoom`, matching
the schema's `room_ref`/`room_provider` slots verbatim), `jitsi.ts` (the
self-hosted implementation — `createRoom` is synchronous-in-spirit and makes
no network call, since self-hosted Jitsi creates rooms lazily on first join;
`issueToken` signs a short-lived (15 min) `jose` HS256 JWT in Jitsi's
documented auth shape, `context.user.moderator` always `false` for a
participant, `context.features.{recording,livestreaming}` always `false` —
belt-and-suspenders alongside the "no recording, ever" product promise),
`config.ts` (env-driven factory: `JITSI_DOMAIN`/`JITSI_APP_ID`/
`JITSI_APP_SECRET`, none set anywhere today since the VPS is a paused
go-live item), `authorize.ts` (pure authorization logic — see the landmine
note below). 21 unit tests (`jitsi.test.ts`, `authorize.test.ts`) verify JWT
claims/expiry/round-trip and every refusal branch.

**The docs/19 landmine, respected by construction:** `authorizeVideoJoin`
keys the join decision on the SPECIFIC PAIRING (the caller's own seat must be
one of the pairing's two seats), never on `sd_in_event()` — which has no
`status` filter and is inside a pending platform-wide remediation. None of
the four frozen functions (`sd_owns_participant`/`sd_in_event`/
`sd_paired_with`/`sd_mentors`) were touched. Staff/observer seats are refused
a join token even though RLS lets staff SELECT every pairing for the rooms
grid — "connection status only, never video feeds" (spec) is enforced at the
authorization layer, not by RLS, because RLS's read scope for staff is
deliberately broader than what staff may actually be handed.

**Wiring, no migration:** both places that create a real (non-bye) pairing —
the worker orchestrator (`apps/worker/src/jobs/speed-dating-orchestrator.ts`)
and the manual "run next round" action (`runPairingRound`) — now call
`tryCreateVideoRoom()` and stamp `room_ref`/`room_provider` on insert.
`tryCreateVideoRoom` returns `null` **silently** when video is unconfigured
(true everywhere today) so the already-shipped, video-less rotation engine
is unaffected; a configured-but-failing provider still logs loudly (the
same discipline the orchestrator already carries for `?? []`). A new server
action, `getVideoJoinToken(orgSlug, eventId, pairingId)`, issues the
per-user token on demand — not yet wired to any button (no UI this pass).

**NOT done, and worth naming explicitly:** standing up
`jitsi/docker-jitsi-meet` locally (JWT auth config to match the env vars
above), the actual `lib-jitsi-meet` embed / call UI, and the audience/mentor
observer video surface (`authorizeVideoJoin` explicitly refuses non-
`participant` seat types — a deliberate exclusion, not an oversight).

**2. Resume-review profiles beyond the profile card.** The existing card was
only ever shown AFTER an encounter, in "People you met" — the spec's actual
ask ("shown to scheduled partners before the event or during breaks") was
unmet. Fixed the one moment the schema can actually support today: the
"Right now" live-round panel now shows the CURRENT partner's card WHILE
paired (not after). **A true "up next" preview (spec: "up next: Sarah — her
card") remains unbuilt and is a real structural gap, not an oversight**: the
rotation engine builds one round at a time (the worker orchestrator only
creates round N+1 once round N's break fully elapses), so there is no future
pairing to preview during a break. Building it would mean pre-computing the
next round before the current one ends — a real change to the orchestrator's
own timing model, out of scope for this pass. The pre-event full "partner
list on the left" (spec line 22) has the same structural blocker and is
likewise unbuilt.

**3. Contact-share population on reveal.** `sd_matches.contact_shared`
turned out to need NO migration: the table already carries a real
client-side `sd_matches_write_organize` "for all" policy gated on
`sd_can_organize(org_id)` (`20260709050000:751-757`) — an organizer's own
RLS-enforced UPDATE, not a definer bypass. Per the schema's own header note
("no share-prefs column in v1"), the spec's "per user preferences OR
organizer designation for the event" resolves entirely to the second half:
a new per-event toggle, `format.shareContactOnMatch`
(`modules/speed-dating/ui/event-format.ts`, Zod-validated-at-write-site
jsonb — docs/03 rule #7, no migration), off by default. When on,
`revealMatches` (`ui/actions.ts`) populates each newly-revealed match's
`contact_shared` with both sides' display name + email (from `profiles`),
keyed by user id — idempotent (only touches matches whose `contact_shared`
is still the RPC's `{}` default, so a re-reveal never clobbers). Rendered in
the "It's a match!" section when present.

**RLS-suite verified (`packages/db/src/rls.test.ts`, extends the "speed-
dating scoped authority" describe block), and it caught a real test-design
bug before it shipped:** the first draft reused the block's own `dana`/
`frank` fixtures — but that describe block's `beforeAll` grants dana a
GLOBAL organizer role and an earlier `it` grants frank a scoped host seat,
so the "a participant cannot write contact_shared" assertion passed for the
wrong reason (a real staff grant, not RLS refusing an ordinary participant).
Rewritten with charlie/eve (demo-dating participants untouched by any other
test in the block) — the vacuity rule bit a second time inside the same
test: an UPDATE from a non-staff caller matches **zero rows** under RLS
rather than erroring, so "no error" proves nothing; the assertion checks the
value is unchanged, not merely that the call didn't throw a JS exception.

Full suite verified clean after all three items: `pnpm exec turbo run
typecheck --force` 9/9, `pnpm exec turbo run test --force` 147 db tests + 21
new speed-dating unit tests (rotation's existing 7 unaffected), all green.

## The video UI itself (same session, immediately after) — click-to-join wired, the actual call unverified

Checked whether the exFAT/Turbopack local-build blocker (CLAUDE.md) had been
fixed by the other session working in parallel: **it has not, and cannot be
fixed in place** (`81d4840`, investigated same-day — four workarounds tried,
all dead ends; the only real fix is an NTFS repo move, a founder call, not
attempted here). Proceeded anyway, verifying via CI per that commit's own
established pattern ("verify UI via CI's e2e, which does work").

`modules/speed-dating/ui/events/[eventId]/video-room.tsx` — a client
component wrapping `getVideoJoinToken`, `lib-jitsi-meet` loaded at join time
from the CONFIGURED provider's own domain (never bundled — self-hosted Jitsi
serves it at a fixed path), with a minimal hand-written type shape for the
handful of `lib-jitsi-meet` calls actually used (there is no official/
bundled TS package for it). Idle → joining → in_call → left/error states;
auto-leaves at the round's `ends_at` (mirroring `authorizeVideoJoin`'s own
server-side cutoff) and on unmount. **A real breaking-change trap avoided by
reading the vendored docs first** (`apps/web/AGENTS.md`'s standing warning —
this Next version differs from training data): `node_modules/next/dist/docs`
states a Server Action must be invoked "from a form, or from an event
handler or `useEffect` **wrapped in `startTransition`**" — training data's
bare `async onClick` pattern is not the sanctioned one here, so the join
button uses `useTransition`.

Wired into the "Right now" panel (`page.tsx`), gated on the same shape
`authorizeVideoJoin` re-checks server-side — real pairing, not on break, a
genuine `participant` seat — with an explicit comment that this render gate
is UX, not the security boundary (the server action is). Keyed on the
pairing id so the next round's fresh pairing mounts a new instance instead
of reusing a stale connection.

**e2e extended, not new** (`platform.spec.ts`'s existing speed-dating flow):
clicks "Join video" and asserts an error surfaces. **CI caught a real bug in
the test itself, not the code, on the first real run — exactly why "verify
via CI" is the standing rule, not a formality.** The first version asserted
"Jitsi video is not configured" (the provider factory's throw), which never
fires in this environment: `tryCreateVideoRoom` (called when
`runPairingRound` created the pairing) silently returns `null` for
unconfigured video, so `room_ref` stays `null`, and `authorizeVideoJoin`'s
"room not ready" check refuses the join a step EARLIER than the test
assumed. Fixed to assert "The room is not ready yet" — genuinely the most
that can be proven anywhere right now, since `JITSI_DOMAIN`/`JITSI_APP_ID`/
`JITSI_APP_SECRET` are unset on this machine, in CI, and on prod alike (the
VPS is still a paused go-live item). Still proves the real wiring — button →
server action → `authorizeVideoJoin` → the error surfacing correctly in the
UI — without attempting a WebRTC connection `lib-jitsi-meet` has nowhere
real to make. **What remains genuinely unverified by anything in this
repo:** whether the `lib-jitsi-meet` call sequence itself (connection →
conference → track attach) is correct against a REAL Jitsi server — that
needs either a local `docker-jitsi-meet` (Docker is available on this
machine; not stood up this pass) or the deployed VPS, neither of which
exists yet.

Typecheck verified (`pnpm --filter web exec tsc --noEmit` clean, then the
full `turbo run typecheck --force` 9/9). The corrected e2e assertion has
**not yet** been observed passing — pushed for the next CI run to be the
first real proof, per this session's own established "verify via CI" path.
