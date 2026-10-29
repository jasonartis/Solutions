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
**SINCE FIXED, 2026-09-06 (CLAUDE.md's exFAT bullet) — local `pnpm dev`/`build` both work
again on D:.** Practical consequence for whoever picks up "the actual call unverified" next:
that verification is no longer blocked by this for the app side — `docker-jitsi-meet` running
locally is still needed to test a real call (a separate, still-open prerequisite, unrelated to
the exFAT issue), but the app itself can now be run and clicked through locally again.

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

**That CI run found a second, more real bug — not a text mismatch this
time.** The server log showed the right error ("The room is not ready
yet") being thrown, but carrying a `digest` field, and the client-side
assertion still couldn't find the text. Cause: `node_modules/next/dist/
docs/01-app/01-getting-started/10-error-handling.md` splits errors into
two categories with opposite handling — *"expected errors... avoid using
try/catch blocks and throw errors. Instead, model expected errors as
return values"* vs. uncaught exceptions, which "will then be caught by
error boundaries" and get their message REDACTED to a generic one in a
production build (the `digest` is Next's server-side correlation id for
that redaction). Every refusal `getVideoJoinToken` produced (not seated,
round ended, video unconfigured) is a normal, anticipated state — a THROW
was the wrong shape for all of them, and the client would never actually
see why in production, however correct the reason string was. **Fixed**:
`getVideoJoinToken` now returns `{ok:true, ...} | {ok:false, reason}`
instead of throwing for any of those cases; `video-room.tsx`'s `join()`
checks `result.ok` directly rather than relying on a caught exception.
Genuine client-side failures (the `lib-jitsi-meet` connection sequence
itself) are unaffected — they're real thrown JS exceptions that never
cross the Server Action boundary, so Next's redaction doesn't apply to
them. **Worth keeping as a platform lesson**: no other action in this
module (or, by the same reasoning, likely the platform) has ever needed a
thrown error's exact message to reach the client inline — every existing
action is invoked via `<form action>`, where an uncaught throw just
crashes to the nearest error boundary, and nothing in any existing test
asserts a specific thrown message's text. This module's video UI is the
first place attempting that pattern, which is exactly why nobody had hit
the redaction before.

**Confirmed green**: commit `61551ab` (the return-value fix) came back
`completed success` on GitHub Actions — the full pipeline (typecheck,
build, seed, db tests, e2e including the corrected "Join video" assertion)
passed on the first try after the fix. This closes out module 6's three
remaining items for this session. What's left is named above and is
infrastructure-gated (a real Jitsi server), not code-gated.

---

## 2026-10-02 — JaaS adopted as the default video provider; nine latent client bugs fixed

**Founder decision, after a priced comparison (full table in docs/02 "Video" — do not
re-derive): JaaS (8x8-hosted Jitsi) is the default, self-hosting stays one env var away.**
The reasoning in one line: the free tier is 25 monthly active users, this module's own default
event is 7v7 = 14 people, and a repeat attendee inside one billing cycle still counts once — so
a monthly event costs nothing and needs no VPS, no TLS renewal, no coturn and no OS patching.
Self-hosted becomes cheaper past ~32 MAU/month and is selected with
`SPEED_DATING_VIDEO_PROVIDER=jitsi`.

**The question that prompted it was "I thought Jitsi is free, are you saying it will cost?" —
and the honest answer corrected a conflation worth keeping.** The software is free in every
scenario; only the machine costs money. The old "~$20–40/mo Jitsi VPS" figure in docs/05 had
also gone stale: **Hetzner's 2026-06-15 price adjustment made the cheap CX/CAX plans
Germany/Finland only, and moved US entry from $6.99 to $20.49.**

### What shipped

- **`src/video/jaas.ts`** — a SECOND provider beside `jitsi.ts`, not a replacement. Everything
  that differs is forced by 8x8's published JWT contract, and each is asserted by a test as a
  LITERAL so a "tidying" refactor fails locally rather than in production: **RS256 with a `kid`
  header** (not HS256 + shared secret); **`aud`/`iss` are the hardcoded strings `jitsi` and
  `chat`**, not our identifiers; `sub` is the AppID; `nbf` is required, and is set 10s in the
  past because our clock and 8x8's are not synchronised and a not-yet-valid token is
  indistinguishable to a dater from a broken room.
- **`context.features` refuses `transcription` and `outbound-call`** as well as recording and
  livestreaming. JaaS exposes both and self-hosted does not. "No recording, ever" (Safety) is a
  promise about there being no durable artefact of the conversation, and **a transcript is one.**
- **`connectionOptions(roomRef)` is new on the provider interface.** The client had the
  self-hosted BOSH/MUC values hardcoded; JaaS uses an XMPP websocket carrying the AppID and
  room, a different MUC host and an explicit focus. The browser must never learn which provider
  it is talking to — that is what makes docs/02's "swapping is config, not rewrite" true rather
  than aspirational.
- **The default is a real decision, not a search.** An env still carrying only `JITSI_*` now
  fails loudly rather than quietly pointing at a server nobody meant to use — asserted by a test.

### NINE BUGS, all found by READING — none reachable by any test that can run today

Three were found writing the slice; **six more by two narrow adversarial review agents**, run
per docs/03 #12. Every one would have fired on a real call, and this module has never made one.
**Two of the nine were in work done THIS session, one of them a blocker** — which is the
argument for the review step, not a footnote to it.

**Found by review, and the most important thing in this entry:**

1. **`JAAS_PRIVATE_KEY`'s newline unescaping was a NO-OP, and the test that covered it was
   VACUOUS.** `rawKey.replace(/\n/g, '\n')` replaces real newlines with themselves — one
   backslash away from the intended `/\\n/g`. A `.env` file and Vercel's dashboard both store a
   PEM as escaped `\n`, so `importPKCS8` would have received a one-line key and **every single
   join in production would have failed.** The test asserted `rejects.toThrow()` against a stub
   PEM — which passes whether or not the conversion ran. **The vacuity rule (docs/03) in its
   purest form: the test did not merely miss the bug, it reported the bug's absence.** Rewritten
   against a REAL generated keypair, asserting a token is actually MINTED from the mangled form,
   with a multi-line key as the control. The production code now uses `split`/`join` on a
   constant built from `String.fromCharCode(92)`, so no escape sequence appears in the file at
   all and the failure cannot recur silently.
2. **`provider.issueToken()` was unguarded, so the above would also have been UNREADABLE.** Only
   `getVideoProvider()` sat in a try/catch. Because JaaS parses its key lazily, a bad key throws
   from `issueToken` — an uncaught Server Action exception, whose message Next REDACTS to a
   digest in production. That is docs/03 #22, the exact lesson this module's own first CI run
   taught, reintroduced. The gap existed because the self-hosted provider's HS256 signing cannot
   fail, so nothing had ever thrown from that line. Its reason is deliberately GENERIC with the
   detail logged server-side: it is the one path whose error could conceivably carry key
   material.
3. **Remote media was dropped for whichever dater joined SECOND, and the first fix for it was
   still wrong.** The media elements rendered only when `status === 'in_call'`, set after
   `room.join()` resolves — but `TRACK_ADDED` fires *during* the join when the partner is already
   in the room. Mid-session this was "fixed" by mounting from `joining`; **review showed that is
   still a race**, because `setStatus` runs inside `startTransition` and its commit is DEFERRED,
   not ordered against the join at all. The elements are now mounted UNCONDITIONALLY — the race
   is removed rather than narrowed. Separately, `remoteTracks.push` sat *after* the null-ref
   guard, so a dropped track was invisible to `TRACK_REMOVED` and to teardown as well; it is
   now recorded before the guard, always.
4. **`room.addTrack()` returns a Promise and was never awaited** (the local TS shim wrongly typed
   it `void`). A rejection published nothing: the partner would see a black tile with no error
   anywhere but an unhandled rejection. Now awaited via `Promise.all`, before `join()`, which is
   the order `ljm-getting-started` states explicitly.
5. **Teardown's `try/catch` caught nothing.** `dispose`, `leave` and `disconnect` all return
   Promises; a synchronous `catch` around an un-awaited promise swallows no rejection, so the
   "already gone" comments were false comfort. All teardown now goes through one `settle()`
   helper that absorbs both a sync throw and a rejection, and through a single `teardownCall()`
   — three ad-hoc teardowns is how the camera came to stay on in three different ways.
6. **Unmount mid-join orphaned the entire session.** `page.tsx` keys this component on the
   pairing id, so a round advancing unmounts it *while joining*; the unmount's `leave()` saw a
   null session and returned, and `join()` carried on against a dead component — camera light
   on, MUC presence live, nothing left to stop it. Now a `cancelledRef` is checked after every
   await and tears down on the spot.
7. **Local tracks leaked on any failure after `createLocalTracks`** (they were block-scoped
   inside the `try`, so the `catch` could not dispose them — camera stays on behind the error).
8. **Both join awaits were unbounded**, so a dead token or unreachable host left the UI on
   "Connecting…" forever with no way out but a reload — the Try-again button renders only in the
   `error` state. Both are now raced against a 20s timeout.
9. **"Try again" had no `disabled={isPending}`**, so two clicks ran `join()` concurrently and the
   second session assignment orphaned the first connection and its camera.

**Found while writing, before review:** the partner's audio was never attached at all (a
`<video>` element plays only the track attached to it, and there was no `<audio>` element — the
call would have been **silent**); `loadJitsiScript` cached a REJECTED promise forever, so "Try
again" was structurally incapable of recovering from a failed library load; and no
`TRACK_REMOVED` handling, so a partner who dropped left a frozen last frame reading as a live
call.

### One review finding REJECTED, with the evidence, so it is not "fixed" later

Review argued `context.user.moderator` should be the STRING `"true"`/`"false"`, since 8x8's own
PHP sample emits strings, and that the reserved `moderator: true` staff path would silently fail
as a boolean. **Checked against the real Prosody plugins (`token_affiliation`,
`token_owner_party`): both compare `== "true"` AND `== true` explicitly.** Either type grants
correctly, so the claim does not hold — and, more importantly, **neither is a Lua TRUTHINESS
check**, which is the thing actually worth knowing: in Lua the string `"false"` is truthy, so had
it been a truthiness check, "fixing" this would have granted every dater in-call moderator
rights. 8x8's docs say it should be a boolean. It stays a boolean, and the reasoning is in the
code.

### Verification, and what it honestly does not cover

**43/43 module tests** (was 21 video + rotation), **typecheck 9/9**, **web build clean**. Test
teeth proven twice, as docs/03 requires: changing `aud` to our AppID and deleting the
`transcription` feature failed **4 tests**; reverting the newline fix to a no-op failed **exactly
1** — the right one — while the multi-line control stayed green.

> A local `turbo run build` exiting **134** is the documented host OOM, not a type error
> (CLAUDE.md gotchas). `NODE_OPTIONS=--max-old-space-size=6144` with a direct `pnpm run build`
> in `apps/web` completes clean.

**NONE OF THIS PROVES THE CALL WORKS.** There is still no video provider anywhere — `JAAS_*`
and `JITSI_*` are unset on this machine, in CI and on prod. All nine bugs were found by reading,
which is exactly the point: **no unit test can observe a `<video>` element with no sound coming
out of it.** What remains unverified is what was unverified before — the `lib-jitsi-meet`
sequence against a real server. The honest next step is a JaaS account and one real two-browser
call, and it is reasonable to expect that call to find more.

**`p2p: { enabled: true }` is passed to `initJitsiConference` and is UNVERIFIED.** The low-level
API reference does not list the key, though every option it does list is a `config.js` key and
P2P is on by default for two participants. Harmless if ignored. **Do not cite docs/02's "P2P
mode for 1:1 calls barely loads the server" as measured until a real call has been inspected** —
that claim is the basis of the whole bandwidth argument and has never been observed.

### STILL NOT BUILT — four client-side gaps, none needing an account

These were identified during this slice and deliberately not built; they are the natural next
session (**Sonnet tier — no migration, no RLS, no DB**) and none of them needs a JaaS account,
because they are all testable by the same reading discipline that found the nine bugs.

1. **TOKEN EXPIRY CAN KILL A LONG ROUND MID-CALL — the one worth doing first.** The join-token
   TTL is hardcoded at 900s (`DEFAULT_TTL_SECONDS` in both `jaas.ts` and `jitsi.ts`), and
   `tokenTtlSeconds` is **never passed from `config.ts`** — verified, not assumed. Meanwhile
   `sd_events.round_duration_seconds` (`20260709050000:135`) defaults to 420 but its CHECK is
   only `> 0`, so **an organizer can legitimately configure a 20-minute round and the token
   will expire while two people are talking.** The fix is to derive the TTL from the round
   rather than hardcode it, with a floor and a ceiling (a token must not outlive its round by
   much — it is the only thing standing between a slug and a stranger).
2. **No mute or camera-off control.** The UI has Join and Leave and nothing else. (The `muted`
   attribute on the LOCAL preview is echo-cancellation, not a control — do not mistake it for
   one.) For an event where two strangers meet, this is a real product gap, not polish.
3. **No reconnection handling.** Zero `CONNECTION_INTERRUPTED` / `CONNECTION_RESTORED`
   listeners. The 20s timeouts added this slice make the component fail FAST and cleanly, which
   is the opposite of recovering from a blip mid-round.
4. **No device selection** (which camera / which microphone).

### Also still not built, and BLOCKED rather than merely pending

- The **audience/mentor observer video surface** — blocked on docs/24 §4's
  seat-becomes-the-grant decision (decided, not built).
- The **pre-round "up next" profile preview** — needs the orchestrator to precompute a future
  round, a real structural change.

### Two research facts from this slice, recorded so they are not re-derived

- **`lib-jitsi-meet` IS fully supported on JaaS** — this is the fact the whole provider choice
  rests on, and it was checked, not assumed: 8x8 publish `jitsi/ljm-getting-started` precisely
  for LJM-against-JaaS. Had JaaS been IFrame-only, our custom chrome (timer, notepad, partner
  list wrapped around a bare video surface) would have needed a rewrite and the decision would
  have gone the other way.
- **There is a newer, higher-level `JitsiMeetJS.joinConference(room, appId, jwt, options)`
  helper** that collapses our hand-rolled connect → initJitsiConference → join sequence, and
  8x8's own sample uses it. **Deliberately NOT adopted:** its availability across LJM versions
  is undocumented, self-hosted and JaaS would have to agree on it, and it hides exactly the
  connection config that `connectionOptions()` exists to vary per provider. Worth revisiting
  only AFTER a real call has proven the explicit path works — not before.

## 2026-10-08 — JaaS configured on production; first real call connected (synthetic media only)

**Done:** JaaS app created, RS256 key generated (2048-bit PKCS#8, public/private pair verified to match), `JAAS_APP_ID` / `JAAS_API_KEY_ID` / `JAAS_PRIVATE_KEY` set in Vercel Production via the API, `SPEED_DATING_VIDEO_PROVIDER` left unset, production redeployed (READY). The private key and values also live in `.env.deploy` (gitignored).
**Test:** `scripts/prod-verify-video-call.mjs` — three signed-in browsers (alice organizer, charlie and dana daters) on `demo-dating` in PRODUCTION, a real event created through the UI, a round started, both daters clicked **Join video**. Both reached `in_call` first try; each had a live local video track, a live remote video track (`currentTime` advancing) and a live remote audio track. **No bug was found by the call.**
**Hardening shipped first (`25475eb`):** `JAAS_PRIVATE_KEY` now also accepts PKCS#1 (`BEGIN RSA PRIVATE KEY`, which `importPKCS8` rejected), CRLF and wrapping quotes — each tested by minting a token from a real key.
**NOT yet established — do not call this fully verified:** the media was Chromium's FAKE camera/microphone in headless browsers on one machine, so it proves tokens, signalling, the websocket and track exchange through JaaS, not real hardware, real audio being audible, or two different networks. Audio was checked as a live track, not as non-silent samples. A human two-device call is still the final check. The orchestrator-driven round clock (worker) was not exercised; the round was started manually.


## 2026-10-08 (later) — first real-use findings: event lifecycle and "what am I registered for"

Found by the founder trying to run the call test by hand. No migration. **Shipped (`a0f4ea3`), prod-verified 11/11 by `scripts/prod-verify-event-lifecycle.mjs`:**
- **Delete event** (organizer): offered ONLY when the event has no live registrations (registered/waitlisted) and no rounds; the action re-checks. Irreversible → refused otherwise; **Cancel event** (state `cancelled`, already in the CHECK) keeps the record. RLS's `sd_events_delete_organize` already existed; only the UI was missing.
- **[REMOVED 2026-10-19 by the consent rule: an organizer can no longer re-seat anyone; the roster now offers "Allow to register again" for REMOVED seats only]** **Reinstate** (organizer, on the roster, for withdrawn/removed). A person CANNOT re-register themselves: `sd_pin_participant` allows a self-editor only `→ withdrawn` ON PURPOSE (self-reactivation would let anyone jump a full side's waitlist), and `unique (event_id, user_id)` blocks a fresh insert. The withdrawn person is now told to ask the organizer.
- **Duplicate event names are ALLOWED** (as Eventbrite/Meetup/Google Calendar do); every list row now shows its date (scheduled, else created).
- **Events list shows the caller's own status** (registered / waitlisted / withdrawn / removed badge) and groups "Your events" / "Open for registration" / "Other events" for non-organizers.
**[SUPERSEDED 2026-10-19: BUILT, ON PRODUCTION AND PROD-VERIFIED — see the "2026-10-19" entries; the organizer Reinstate button described below was REMOVED] STILL OPEN — needs a MIGRATION, deliberately not done (another session owns `supabase/migrations/` right now):** self re-registration after a SELF-withdrawal (not after `removed`). Right shape: a definer RPC that flips own `withdrawn → registered|waitlisted`, deciding capacity server-side. Until then, reinstate is organizer-only.

## 2026-10-16 — FIRST REAL HUMAN CALL: VERIFIED; and the founder's walkthrough findings

**VERIFIED:** a human two-computer call on production (dana and charlie, `demo-dating`, event "Live call test 62564") — each side saw the other move and heard the other. This closes the "synthetic media only" caveat of the 2026-10-08 entry. (One computer first failed on its own camera/mic permissions — a local machine issue, not the code.) Not yet exercised: the worker-driven round clock, and more than one pair.
**Gaps found by the call, NOT built:** (1) no mute / camera on-off controls; (2) once you leave the room there is no way back in this round (`status === 'left'` renders only text); (3) nothing to tell the other side "I can't hear/see you" — a status line or small chat would help debugging; (4) round-vs-event timing is unclear on screen ("Ends in 49:43" is the ROUND, not the event).
**Organizer-side gaps found by walking the flow, NOT built:** a draft event has no detail/edit view; an open event cannot be closed or returned to draft; round/break length and event-level planning (how many rounds, total time, who meets whom) are not settable or previewable from the UI (round length is an `sd_events` column the create form does not expose — it was set directly for these tests); the events list does not say whether you organize or participate; interest/verdict buttons give no sign they can be changed. Needs a designed walkthrough of one or two real events before building piecemeal.

**SHIPPED the same day (`fd77847`, prod-verified 9/9 by `scripts/prod-verify-video-controls.mjs`, fake media):** gaps (1)-(3) above. Mute/camera toggles; a "You / Them: microphone, camera" line where `not connected` (no track ever arrived) is told apart from `off (they muted it)`; **Rejoin video** after leaving (the media elements now stay mounted in the `left` state — returning early had unmounted them). **Deliberately NOT built: free-text in-call chat** — chat text is a durable record of the conversation (the same reason transcription is switched off on JaaS), and a dating context adds a harassment channel with no moderation path.
**Founder reports "cannot change interest" — NOT REPRODUCED.** On prod as charlie, a click moved `interested` -> `not_interested` and the page showed it within 4s; the DB allows it by design (`sd_interest_update_own`, and `sd_sync_mutual_match` deletes an unrevealed match when a verdict moves off interested). Needs the exact symptom (button does nothing / error / reverts after refresh). Also unexamined: nothing stops a change AFTER reveal.
**Block visibility:** a "never pair me with them again" block silently removes that pair from rotation; the organizer's console shows nothing about why a person got a bye. Proposal: show organizers a COUNT ("N possible pairings excluded by personal blocks"), never names — the blocker's choice stays private.


## 2026-10-18 — self re-register: built and reviewed (NOT yet on prod); a PRE-EXISTING INSERT hole found by the review

**Built locally, uncommitted until the migration is on prod:** `20261017010000_sd_self_rejoin.sql` (inside `sd_pin_participant`: a person who withdrew THEMSELVES may rejoin themselves; the database overwrites the status with registered/waitlisted by capacity; refused unless the event is `open`, the person is eligible and not banned; `removed -> anything` stays organizer-only; `created_at` is now pinned below organizer tier so nobody can back-date into the queue, and a rejoiner goes to the back). 12 new tests in `packages/db/src/sd-self-rejoin.test.ts` (9 fail against the old body), full db suite 407/407 by the building agent. UI built: **Register again** (dater) and **Allow to register again** (organizer, removed seats only — the old organizer Reinstate is gone, consent principle). **Ordering rule: migration on prod FIRST, then push the UI**, or the button raises.
**Two independent adversarial reviews (Opus):** (A) forgery attempts, ~20 concrete attacks as a signed-in user — the new trigger branch held every time; (B) regression diff old vs new body + every UPDATE path — none unintended. Small items: `id` is not pinned for self/host (low: FKs protect referenced rows); a withdrawn mentor/audience seat can rejoin (no UI reaches it).
**FOUND, PRE-EXISTING, NOT FIXED — `sd_participants_insert_self` is far too permissive.** It checks only own `user_id`, the participant role and `status in (registered, waitlisted)`. Reproduced locally in rolled-back transactions as an ordinary participant: (1) a BANNED user registers fresh; (2) a full side is taken, back-dated to 1970, with `seat_type='mentor'` and `checked_in=true`; (3) registration into an event that is `running`; (4) **READ LEAK: inserting `seat_type='mentor', mentee_participant_id=<someone else's seat>` makes the SELECT policy's `sd_mentors()` arm return that person's whole row — `profile` and `profile_card` — to the inserter** (same org). The "no waitlist jump" guarantee therefore holds only for REJOINERS; a first-time registrant bypasses it. **Fix shape (own slice, Opus, full rhythm):** a BEFORE INSERT guard on `sd_participants` for non-organizers that forces `seat_type='participant'`, `mentee_participant_id` null, `checked_in` false, `created_at = now()`, event `open`, not banned, and computes registered/waitlisted by capacity — the same decision the rejoin branch makes, ideally ONE shared helper (docs/03 #31). Pin `id` in `sd_pin_participant` in the same slice. Check first that no app path legitimately inserts a non-`participant` seat (earlier note: none does).

## 2026-10-19 — security sweep: three migrations ON PRODUCTION and prod-verified; app side committed

**Applied to prod 2026-10-19** (backup `backups/2026-10-19T15-44-08`; dry run listed exactly these three; follow-up dry run "up to date"): `20261017010000_sd_self_rejoin`, `20261017020000_sd_hardening`, `20261017030000_insert_pins_other_modules`. **BEFORE/AFTER on prod (controls green both times):** `prod-verify-sd-self-rejoin.mts` 92 pass/79 fail -> 171/0; `prod-verify-insert-pins.mts` 46/52 -> 271/0; `prod-verify-migration.ts` 0 failures x3 (3/6/20 benign trigger-function warnings); db suite 471/471, local ACL checker 17/17 (on prod it fails only on another session's not-yet-applied pending-invite entries). Prod holds only demo speed-dating data, so BEHAVIOUR is proven locally, structure on prod.
**Rules now in the database (headers have the reasoning):** a self-withdrawn person re-registers THEMSELVES (outcome registered/waitlisted from ONE shared helper `sd_registration_status`, advisory lock per event+side); an organizer can never move withdrawn/removed -> registered/waitlisted (may clear removed -> withdrawn); fresh registration forced to a participant seat, event open, not banned, back of queue; a mentor pointer must name a consenting participant in the same event (write trigger AND `sd_mentors()`); interest needs a pairing and a registered rater (a withdrawn rater may RETRACT); removed seats frozen; `id`/`created_at` pinned; reports/notes/bans/pairing errors oracle-free; `sd_can_organize_event` derives the org from the event. App: video token refused for non-registered seats / non-live round / non-running event and capped at round end; Register again + Allow to register again; registration refusals shown as notices; synagogue Export shown to makers only.
**Review history (the lesson is the process):** round 1 = five attack reviews (seats; events/rounds/video; interest/notes/reports/blocks/bans; functions+app; every other module). Round 2 re-reviews found a blocker EACH in the fixes (a notes oracle the fix opened; a coarse "manager anywhere in the org" exemption on the update pins). Round 3 found the withdrawn -> removed -> registered consent bypass and a notes enumeration. Every guard has a test with a control and was mutation-checked.
**Open:** an organizer can still INSERT a brand-new seat for an org member without their say-so (no screen does; observer seats need it) — founder: defer, build the consent flow with audience/mentor seats. The last two fixes were read by the orchestrator, not re-reviewed by an agent. Local e2e not run (CI first). Empty-database apply not testable locally (assertion blocks read only the catalog).
**App side LIVE (pushed 2026-10-19 after the pending-invites migration landed; deploy READY, so CI's db+e2e passed) and verified on PROD with real browsers:** `prod-verify-event-lifecycle.mjs` 12/12 (withdraw -> the person registers again; the organizer has no re-seat button), `prod-verify-video-controls.mjs` 9/9, `prod-verify-video-refusals.mjs` 4/4 (a removed seat is refused a join token with "You are not registered for this event"; the registered partner joins; no Withdraw/Register again for a removed seat). Hazard for the future: on a shared master ANY session's push ships every session's local commits.

## 2026-10-21 — founder's real-browser run: what it found, what changed

**CLOSED: "I cannot change my interest mark."** The founder re-tried on both sides and switched all three buttons back and forth without issue; the production mock (`scripts/prod-verify-interest-change.mjs`, 7/7, including a mutual match and a round whose clock had run out) agreed. Never reproduced; the earlier report is put down to that session's state.
**FIXED: "Create (draft)" gave no feedback, so repeated clicks made SIX identical drafts.** A slow server action looks like a dead button. New `ui/submit-button.tsx` (`useFormStatus`): the button disables and shows "Creating…"; also used on **Register for this event** and **Run next round** where a double click does harm. (Considered redirecting to the new event after creating — rejected for now: three e2e tests and five scripts rely on staying on the list.) Duplicate NAMES stay allowed by decision (2026-10-08); the founder can delete the extra empty drafts with the Delete event button.
**FIXED: turning a camera off left a frozen last frame.** A muted camera track keeps painting its last frame. The tile is now covered by a black panel with a crossed-out camera and a caption ("Dana's camera is off" / "Waiting for Dana's camera…" / "Your camera is off").
**FIXED: the status line says the partner's name** ("You: …" / "Dana: …") instead of "Them" (`partnerName` prop from the event page).
**WORKS (founder, 2026-10-21):** create event, register two daters, run a round — "the flow works nice".
**FUTURE (founder): organizer INVITES the daters and they ACCEPT** (instead of the organizer relying on people finding the event) — this is a consumer of the generalised pending-invite machinery (docs/25) and should be built with that generalisation, not as a speed-dating special case. It also answers the open question below: an invite-and-accept flow IS the consent mechanism for an organizer-created seat. **Founder reminder: an organizer should not be able to register people without their approval; defer building until the invite work.**

## HANDOFF 2026-10-22 — NEXT: the ORGANIZER SCREENS (nothing started; design facts measured)

**State (refreshed 2026-10-22):** everything is committed, pushed, deployed (READY) and prod-verified; the working tree was CLEAN at the end of the session. **Entries written AFTER this handoff that you must also read:** "2026-10-22 final adversarial check of the consent rule", "2026-10-22 final adversarial check of the notes guard" (incl. the queued SECURITY FOLLOW-UP migration), "2026-10-22 OPERATIONAL RECIPES" and "2026-10-22 RESIDUAL ITEMS AND GOTCHAS". The db test files now run SERIALLY (docs/12 addendum). Sonnet-tier UI work unless a migration is needed (see Q1).
**Read first:** the "2026-10-21" and "2026-10-19" entries above, and `docs/26-speed-dating-event-guide.md` (the as-built walkthrough; its GAP markers are this list). Prod checks that still pass and must keep passing: `scripts/prod-verify-event-lifecycle.mjs`, `prod-verify-video-controls.mjs`, `prod-verify-video-refusals.mjs`, `prod-verify-interest-change.mjs`.
**The five items (founder-approved 2026-10-21 "yes please"):** (1) a DRAFT event gets a detail/edit view (today clicking it shows only the organizer console); (2) a way to CLOSE an open event / return to draft; (3) round length, break length and number of rounds settable at creation WITH a preview ("14 people, 7 rounds, about 1 hour") — today round length is a column the create form does not expose (tests set it by PATCH); (4) a "you organize / you participate" label in the events list; (5) organizers see a COUNT (never names) of pairings excluded by personal blocks, so a bye is explainable.
**MEASURED FACTS (do not re-derive):**
- `sd_events` columns an organizer may edit: `name`, `description`, `scheduled_at`, `lobby_opens_at`, `round_duration_seconds` (>0, default 420), `break_duration_seconds` (>=0, default 30), `rounds_planned` (null or >0), `format` (jsonb: two-sided labels + capacities, Zod-validated at the write site — `ui/event-format.ts`), `allow_repeat_pairings`, `resume_review_enabled`. RLS `sd_events_update_organize` already allows the organizer to UPDATE them; no migration needed for editing.
- **The state machine (`sd_guard_event`, SQL) allows ONLY** draft -> open|cancelled, open -> running|cancelled, running -> complete|cancelled. **There is NO open -> draft and NO "close registration" state.** So item (2) as worded ("put an open event back into draft") NEEDS A MIGRATION (relax the guard, Opus, full rhythm) — OR is met without one by: edit details while draft/open, and **Cancel** (already built) as the way to end an open event. **Q1 for the founder, as a scenario:** "Alice opened registration, 5 people signed up, then she spots a wrong start time" — editing the time in place (no state change) covers it; "Alice wants to stop new signups but keep the event" has NO state today (would need a new state, e.g. a `closed` between open and running).
- Editing rules to enforce in the action (RLS will not): length/break/format/repeat settings may change only while NO round has run; `format` (sides/capacities) is risky once people have registered on a side — refuse or warn when registrants exist.
- `rounds_planned` exists but nothing reads it (the rotation ends when everyone has met everyone — `rotation.ts`). A preview can compute N-1 rounds for N people when repeats are off; with sides, N = min side ... check `rotation.ts` before promising a number.
- Round length drives BOTH the participant countdown and the video-token expiry (token is capped at the round end) — a very short length makes calls end early.
- The events list's role label: an org member who can organize is detected with `rpc('sd_can_organize', {check_org_id})` (already used in `ui/page.tsx`); seat status per event is already fetched there for the "Your events" grouping.
- Blocks count (5): organizers can read `sd_blocks` (org admins by design); the rotation applies blocks via `blockedUserPairs` in `runPairingRound`. Show ONLY a number of excluded pairs, never who blocked whom.
**Conventions that bite here:** a THROWN server-action message is redacted in production — return a notice/redirect instead (docs/03 #22; `?notice=` pattern is in the event page); new buttons use `ui/submit-button.tsx` (double-click guard); commit with explicit pathspecs ONLY, and a `git push` pushes EVERY session's local commits; `pnpm` is not on PATH (shim via corepack in the scratchpad); CI deploys only after its db + e2e tests pass.
**Deferred by the founder:** organizer-invites-then-person-accepts (consent), built with the generalised pending-invites work (docs/25); an always-on worker host to advance rounds by itself (also unblocks retention pruning, synagogue export, zmanim refresh) — decide when a real client is signed.

## 2026-10-22 — final adversarial check of the consent rule: HELD on every status route; one organizer-only gap RECORDED (not shipped)

A fresh Opus reviewer attacked the consent rule in `sd_pin_participant` (20261017010000): single/multi-row UPDATEs, `INSERT ... ON CONFLICT DO UPDATE`, every intermediate-status two-step, scoped organizers, hosts, org admins, superadmin, an organizer who also holds a seat, the holder's own rejoin in every closed/banned state, and the no-JWT path. **Every status route was blocked; the legitimate paths (remove, clear a removal, promote waitlisted -> registered, own rejoin on an open event) all work.**
**ONE GAP, LOW, ORGANIZER-ONLY, SAME FAMILY AS THE FOUNDER-DEFERRED "ORGANIZER CAN SEAT SOMEONE" QUESTION — recorded, deliberately NOT shipped:** an organizer can REASSIGN the person on a seat (`update sd_participants set user_id = ...`) and so land a self-withdrawn person on a registered seat, in order: (a) move P's withdrawn seat to another event, then `update ... set user_id = P where id = <someone else's registered seat>` (P is now registered in E1); or (b) launder through the holder rule — move the organizer's own seat to E2, `set user_id = O` on P's seat, `set status = 'registered'`, then `set user_id = P` — which brings back P's ORIGINAL seat id and `created_at`, hiding that they withdrew. No screen reaches it; it needs the organizer role.
**FIX (one line, bundle it with the organizer-seating consent work, Opus tier, own migration + backup + prod apply):** in `sd_pin_participant`, refuse a `user_id` change from ANY JWT caller, organizers included (`if new.user_id is distinct from old.user_id then raise ...`); optionally refuse an `event_id` change too. No legitimate organizer flow needs either. The no-JWT account-deletion silhouette is unaffected (first branch).
**Also noted, not a breach:** an organizer who HOLDS a seat can rejoin their own withdrawn seat while the event is running (the organizer branch returns before the open/ban checks) — the holder's own act, consistent with the rule.

## 2026-10-22 — final adversarial check of the notes guard: error text HELD; two LOW items recorded; ONE FOLLOW-UP MIGRATION QUEUED

A fresh Opus reviewer attacked `sd_notes_guard` (20261017020000) for any way to learn who is registered/paired at an event. **26 probes across callers (no seat, seated-unpaired, other org, no org) and subjects/events/pairings (absent, unpaired, withdrawn, removed, made-up ids, unknown/null/cross-org event, someone else's or a made-up pairing, ON CONFLICT, forged author): every refusal returned the IDENTICAL error (P0001, same text, no detail/hint/constraint) — the primary oracle is CLOSED.** Legitimate flows (a paired participant inserts/edits/upserts a note; staff notes; own-key duplicate 23505) all work; only the author reads a note (organizer, host and the subject read 0 rows).
**TWO LOW ITEMS, recorded, not shipped:** (1) TIMING — a refused insert by a seated non-staff author takes ~0.2-0.3 ms when the subject is absent and ~1.5-2.2 ms when the subject is registered/withdrawn/removed (the guard's `OR` short-circuits before the costlier staff/pairing checks); measured inside the database, ~1.4 ms is unlikely to survive network jitter but is not proven undetectable. (2) `pairing_id` is never tied to the AUTHOR: a note about W was saved attached to the pairing between two OTHER people; the account-deletion sweep keeps any pairing a note points to, so a stray note blocks that pairing's deletion, and a guessed UUID can be confirmed as belonging to the event.

### SECURITY FOLLOW-UP — ONE small migration, Opus tier (own session; backup, dry run, prod apply, prod verifier). Three one-line-class fixes, all specified:
1. `sd_pin_participant`: refuse a `user_id` change from ANY JWT caller, organizers included (closes the organizer reassignment route recorded in the entry above); optionally refuse an `event_id` change too. **The `event_id` half is DONE (2026-10-27, `20261027010000` — it was a real bypass of the closed gate); the `user_id` half remains.** The no-JWT silhouette is unaffected.
2. `sd_notes_guard`: compute EVERY check into a boolean first (always run the staff and pairing lookups), then raise once — no short-circuit timing difference.
3. `sd_notes_guard`: require `pairing_id` (when given) to be a pairing between the AUTHOR's seat and the SUBJECT's seat.
Each needs a test with a control and a mutation check, then `prod-verify-sd-self-rejoin.mts` updated for the changed bodies. **Bundle with, or do just before, the founder-deferred organizer-seating consent work (invite-and-accept, docs/25) — same root.** Founder-decided triage 2026-10-22: low severity, organizer/seat-holder only, no screen reaches any of them, so not worth a separate prod change on their own.

## 2026-10-22 — OPERATIONAL RECIPES (written down so none of this is re-derived)

**1. A live event for a HUMAN test.** `node scripts/prod-setup-live-event.mjs [roundMinutes=180] ["name prefix"]` creates an event in prod `demo-dating` as alice, registers charlie and dana, starts it and runs round 1 with a LONG round; it prints the name and the end time. Clean up with `node scripts/prod-setup-live-event.mjs --delete "<name or id>"`. WHY the long round: the default is 7 minutes, **Join video disappears when the round's clock runs out** (the page treats the round as ended and the token is capped at the round end), and the create form does not expose round length, so the script PATCHes `sd_events.round_duration_seconds` with the service role. Sign in as dana/charlie with `PROD_DEMO_PASSWORD` from `.env.deploy` (NOT `.env.accounts`'s 74-char value).
**2. Setting or ROTATING the JaaS key.** `node scripts/prod-set-jaas-env.mjs` upserts `JAAS_APP_ID` / `JAAS_API_KEY_ID` / `JAAS_PRIVATE_KEY` on Vercel Production from `.env.deploy` (never printing a value) and redeploys (env vars apply only to NEW deployments). Rotation: JaaS console (jaas.8x8.vc) -> API Keys -> generate a pair -> download the `.pk` -> AppID, Key ID (`vpaas-magic-cookie-…/xxxxxx`) and the key (joined to ONE line with literal backslash-n; `config.ts` also accepts a multi-line PEM, PKCS#1, CRLF and wrapping quotes) into `.env.deploy` -> run the script -> `scripts/prod-verify-video-call.mjs` -> delete the `.pk` PERMANENTLY (Shift+Delete, so it skips the Recycle Bin) -> delete the old key in the console. `SPEED_DATING_VIDEO_PROVIDER` stays UNSET. An `env-backups/2026-10-22T06-16-45` snapshot (`node node_modules/tsx/dist/cli.mjs scripts/backup-envs.ts`, same drive, git-ignored) holds the key lines; `.env.deploy` is the only unrecoverable copy besides Vercel, so keep it in a password manager too (docs/12). The first key (2026-10-07) was set up this way; its `.pk` files were PERMANENTLY deleted from Downloads 2026-10-22 (bypassing the Recycle Bin, confirmed by the founder).
**3. The prod check scripts (all demo data, they create then delete their own events; all need `.env.deploy`):** `prod-verify-event-lifecycle.mjs` (duplicates allowed and dated, Delete, withdraw -> Register again, organizer has no re-seat button), `prod-verify-video-call.mjs` (a fake-media call connects both ways), `prod-verify-video-controls.mjs` (mute/camera, the named status line, the camera-off cover, Leave/Rejoin), `prod-verify-video-refusals.mjs` (a REMOVED seat is refused a token; the registered partner joins), `prod-verify-interest-change.mjs` (a mark can be changed, including with a mutual match and after the clock ran out), plus the read-only structural verifiers `prod-verify-sd-self-rejoin.mts` and `prod-verify-insert-pins.mts`. Run the `.mjs` ones with `node scripts/<x>.mjs`; if `pnpm` is off PATH run the `.mts` ones with `node node_modules/tsx/dist/cli.mjs scripts/<x>.mts`. A trailing Node/Windows "UV_HANDLE_CLOSING" assertion after a script exits is harmless.
**4. WHY ROUNDS DO NOT ADVANCE BY THEMSELVES, and the options (founder asked 2026-10-21).** Production is Vercel serverless: code runs only when a request arrives, so nothing can close a round or start the next one on a timer. The `apps/worker` orchestrator does it but needs an always-on process (`pnpm worker:prod` from the founder's PC is the stopgap). Built-in alternatives and why they are not free: **pg_cron inside the database** (what account-deletion expiry uses) cannot run the pairing, because the rotation (`src/rotation.ts`: history, blocks, repeats, sides) is TypeScript, so it would have to be ported to SQL; **advancing on demand when someone loads the page** needs write rights a participant does not have, i.e. a SECURITY DEFINER SQL function (the same port) or the service-role key in the web app, which docs/03 hard rule 5 forbids. **Recommendation (founder: decide when a real client is signed):** keep the manual **Run next round** button for first real events; then ONE small always-on worker host, which ALSO unblocks retention pruning (docs/17), the synagogue export queue (`job_requests`) and the zmanim sweep and console buttons.
**5. Phone sign-in ("fields go blank, no message", URL ends `/login?`).** It is a page whose scripts never ran, NOT a login bug. Repro/diagnosis: `node node_modules/playwright-core/cli.js install webkit`, then `webkit.launch()` with `devices['iPhone 13']` — **current WebKit 26.5 signs in fine on prod** (also as Chromium with an iPhone profile), so the founder's phone is an older or restricted browser. The login page now shows "This page hasn't finished loading…" after about 4 s if hydration never happens (verified with JavaScript disabled in WebKit; absent when scripts run). Not retested on a capable phone.
**6. Test-environment facts.** `scripts/verify-acl-hardening.ts` targets **PROD by default** (read-only); for local run `VERIFY_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres node node_modules/tsx/dist/cli.mjs scripts/verify-acl-hardening.ts` (17/17). On prod it fails only on entries for migrations not yet applied there. After any migration that adds a rank-gate function, regenerate `docs/rank-admission-map.md` with `node ../../node_modules/vitest/vitest.mjs run src/rank-admission.test.ts -u` from `packages/db`.

## 2026-10-22 — RESIDUAL ITEMS AND GOTCHAS FROM THE 2026-10-19 SECURITY SWEEP (previously only in the builders' chat reports)

**Decisions still OPEN (found by the sweep, deliberately not changed):**
- **A GA can set `is_final` and `visible` on their OWN GA-source grade** under `cls_grades_write_ga` (classroom). Found by the other-modules builder; not changed because it changes what a GA may do — a founder/product call.
- **`sal_appointments.notes` stays client-writable** for a customer. No screen shows appointment notes; only the view-as manifest calls it staff/worker-authored (admin-only display). Borderline — pin it if a screen ever starts reading it as staff authority.
- **`sd_side_registered_count`** (per-side registration count) answers any ORG MEMBER with no speed-dating role, drafts included — counts only, never names. Left as is (staff also use it).
- **`sd_matches_before_write`** still raises pre-RLS error text. Gating it to organizers would BREAK mutual matches, because `sd_sync_mutual_match` inserts matches while `auth.uid()` is still the participant.
- **A participant's own-report export** is described in a comment in `ui/export.ts` but not built (completeness, not security); the roster export includes `user_id`.
**Gotchas a future builder will hit:**
- **A NEW `job_requests` KIND must be added to `job_requests_guard_insert`** (20261017030000): an unknown kind from a signed-in user is REFUSED, and `synagogue-schedules.render` needs `syn_can_write`. The zmanim "Backfill/Run sweep now/Fetch this week" buttons (docs/23) will need their kinds classified there.
- **The `auth.uid() is null` path bypasses every new insert/update guard BY DESIGN** (seed, worker, migrations, the pending-invite appliers). Any SECURITY DEFINER RPC that clears the JWT claims and then writes to a guarded table skips the guard; as of 2026-10-19 the only such functions are the two pending-invite appliers, which write `org_members`, `vm_conversation_members` and `module_roles` only.
- **`registerForEvent`'s app-side capacity check is now ADVISORY**: the database (`sd_registration_status`) decides registered vs waitlisted, including "someone is already waiting on this side, so you wait too" (stricter than the old count-only rule). The page shows the stored status.
- **Mentor and audience seats can now be created only by an organizer** (the insert guard forces `seat_type = 'participant'` for everyone else, and a mentee pointer must name a consenting participant in the same event). No UI creates one today; build the consent flow with the audience/mentor work.
- **rls.test.ts fixtures changed for the new rules:** marking interest or writing a note now needs a PAIRING between the two seats, and a mentee needs `allows_mentor`. Any new test that marks interest without a pairing will fail by design.
- **A waitlisted seat can still self-check-in** (harmless: pairing filters on `registered`); the waitlist order is `created_at` and a rejoiner is re-stamped to the back.
- **Notes need an author seat and a pairing; the vm/cls/sal/mm insert guards are `<table>_zz_insert_guard` (they fire after the scope trigger) and the survey one is `cls_survey_answers_a_class_from_survey` (before it)** — name any new guard so it sorts correctly relative to the table's `*_scope` trigger.

## 2026-10-26 — THE ORGANIZER SCREENS ARE BUILT (Sonnet, no migration)

All five handoff items, UI only. **(1) Edit view** `events/[eventId]/edit` + `updateEvent`: draft/open only, nothing after a round has run; the action re-checks state, rounds run, and **sides vs. live registrants** (sides locked once anyone is registered/waitlisted; unchanged sides never trip it). `lobby_opens_at` is NOT exposed (nothing in the UI sets it, and editing would wipe a value). The start time is entered and shown in UTC, like `createEvent` always did (server render, no viewer zone). **(2) Close / back to draft: NOT BUILT — needs the founder's Q1.** Without a migration the answer is *Edit details* (wrong time/name) and *Cancel* (end it); "stop new signups but keep the event" has no state (`sd_guard_event` would need a `closed` state between open and running — Opus, full rhythm). **(3) Timing at creation** (`ui/event-plan.ts`, `timing-fields.tsx`, `event-settings-fields.tsx`, shared by create and edit): round minutes (1–60), break seconds (0–600), repeat-meetings switch, and a live preview. **The round count is computed, never stored** (`rounds_planned` is still read by nothing): single pool N even -> N-1, N odd -> N; two sides -> the larger side; repeats allowed -> no number promised; always worded "up to" because blocks only remove meetings. Expected people is a planning box (not submitted); with sides on, a capacity feeds the preview. **(4) "you organize" / "you participate" labels** on the events list. **(5) Blocked-pairs count** on the organizer console, `sd_blocks` read as the caller, **shown only when `sd_can_manage` is true** — the table is readable by the blocker and the manage tier only, so a plain organizer would see an undercount, and a wrong zero is worse than no figure. Counts unordered pairs of registered participants (cross-side only when there are two sides); never names. Console also shows "Rounds of N min with Ns breaks".
**Gotchas worth keeping.** (a) **A native listener on a FORM that calls `setState` synchronously breaks React controlled inputs inside it**: it runs before React's root handler for the same event, React re-renders the field with its old value, and `onChange` never fires — the typed character vanishes. Found by the e2e test, not by reading; fixed by deferring (`setTimeout(read, 0)`). (b) Expected refusals redirect with `?notice=` (docs/03 #22): the list page now takes `create-timing`/`create-format`, the edit page `edit-*`, the event page `edit-saved`/`edit-locked`. (c) New activity action `event.updated` (packages/platform/src/activity.ts). **Verified:** module vitest 64/64 (7 new, incl. a worked 7-round/52-minute case), `apps/web` tsc clean (covers the module via the alias; turbo not run), a new e2e test (create with timing -> preview -> label -> edit -> cancel -> edit refused) and the four other speed-dating e2e tests pass locally; the long "register -> round -> reveal" test failed only because a previous run left the seeded Friday Night Mixer `complete` (documented stale-seed trap; it needs reset + seed). **Blocked-pairs count (item 5) verified 2026-10-27 by a local e2e test** (`organizer console counts pairings skipped by personal blocks`, passes): 0 before charlie blocks dana, "1 pairing is being skipped" after, the line carries no names, and a block between two people on the SAME side of a two-sided event reads 0. **Teeth demonstrated 2026-10-27:** deleting the same-side skip makes the same-side assertion fail (restored, no diff). Not seen on prod (the demo data has no blocks). **Not checked on a phone.**

## HANDOFF 2026-10-26 — NEXT (Opus): a `closed` EVENT STATE ("registration closed, event still alive")

**Founder said yes to Q1 on 2026-10-26.** Prior art (Eventbrite pause/end sales, Meetup close RSVPs, Luma close registration) was compared in chat; the decided shape is below. **Opus tier, full docs/03 #12 rhythm, own migration; claim a version with any concurrent session first (`ListAgents`).**
**Decided state moves (`sd_guard_event`):** draft -> open|cancelled; open -> closed|running|cancelled; **closed -> open (reopen)|running|cancelled**; **open|closed -> draft ONLY when the event has zero live seats (registered or waitlisted) and no round** (pulling an event from people who signed up is irreversible, so refuse); running -> complete|cancelled; complete and cancelled stay terminal. No un-cancel.
**Decided behaviour (founder to veto if wrong):** closed = NO new registrations, including a withdrawn person registering again and waitlist promotion by a person's own act; **withdrawing while closed is still allowed**; an organizer clearing a removal still works; "Start event" works from open or closed. Daters see "Registration is closed" instead of a missing button; the organizer console and the events list show the state.
**Audit list (a missed call site = people registering into a closed event):** every `state = 'open'` / `'open'` test in `supabase/migrations` — at least `sd_registration_status`, `sd_pin_participant` (rejoin and own-seat rules, 20261017010000), the participant INSERT guard, the `sd_participants_*` policies, `sd_side_registered_count`, any `job`/worker code in `apps/worker/src/jobs/speed-dating-orchestrator.ts` that filters on state; in the UI `registerForEvent`, `rejoinEvent`, `promoteNextWaitlisted` in `ui/actions.ts` and the page's `event.state === 'open'` branches (`ui/page.tsx` "Open for registration" grouping, `ui/events/[eventId]/page.tsx`, `ui/events/[eventId]/edit/page.tsx` which allows draft/open only — decide whether closed is editable: recommended YES, same rules). Also `view-as` / rank-map / `rank-admission-map.md` if a function changes, and the `prod-verify-sd-self-rejoin.mts` / `prod-verify-insert-pins.mts` bodies.
**Tests:** a db test per route into a closed event (insert, rejoin, status update, waitlist promotion by organizer vs by self) each with a control (the same act succeeds when open) and a mutation check; back-to-draft refused with one live seat and allowed with none; reopen restores registration. e2e: close -> dater sees closed -> reopen -> dater registers. Then backup, dry run, `migrate:prod`, a new `prod-verify-*` for the state machine (before/after scores), and the existing prod checks listed in the 2026-10-22 handoff must still pass.
**Deliberately NOT in this slice (decided 2026-10-26, do not build):** registration deadline/auto-close (needs the always-on worker or a read-time comparison — decide with the worker question), pausing a running event, un-cancel, approval-required join (belongs with docs/25 consent), notifying registrants (blocked on a mail provider; the edit screen should say nobody is told).
**DONE 2026-10-27 (carried from the organizer-screens session): the blocked-pairs count test now has demonstrated teeth** — with the same-side skip line deleted in `ui/events/[eventId]/page.tsx`, `organizer console counts pairings skipped by personal blocks` FAILS on the two-sided "No pairings are being skipped" assertion; the line was restored and `git diff` on the file is empty. Still unseen: the count on PROD (demo data has no blocks).
**Context:** the organizer screens (edit view, timing preview, labels, blocked-pairs count) shipped in `291f316` — see the 2026-10-26 entry above. After the build, give the founder a click-by-click walkthrough (lettered steps, demo users alice = organizer, charlie/dana = daters) covering BOTH the organizer screens and the closed state — he asked for one at the end.

## 2026-10-27 — THE `closed` EVENT STATE IS BUILT (Opus, `20261027010000`) — STATUS: see the last line of this entry

Built exactly as the 2026-10-26 handoff decided. **Moves (`sd_guard_event`):** draft -> open|cancelled; open -> closed|running|cancelled|draft; closed -> open|running|cancelled|draft; running -> complete|cancelled; terminal otherwise. **-> draft only with zero registered/waitlisted seats and no round** (withdrawn/removed seats do not block it; they stay and may rejoin once reopened). While closed: no fresh self-registration and no rejoin (the gates already tested `is distinct from 'open'`, so they refused `closed` by construction — now with the message "Registration for this event is closed"); withdrawing allowed; organizer promotion and clearing a removal unchanged; Start works from open or closed; **closed is editable** (same rules as open).
**What the audit found that a new state actually breaks:** only `sd_events_select`'s participant arm, which LISTED visible states — a closed event would have vanished for daters. Fixed. Account deletion (`not in ('complete','cancelled')`), `sd_side_registered_count`, the worker and video auth (`'running'`) are correct as they are. App: `registerForEvent` mapped refusals to `register-closed` only on the text "not open" (now also "is closed"); `setEventState` now redirects with `?notice=draft-refused|state-refused` instead of throwing (docs/03 #22).
**Two things beyond the handoff, both found by the build's reviews:** (1) **THE BACK-TO-DRAFT RACE.** A dater's INSERT takes only the FK's FOR KEY SHARE lock on the event, which does NOT conflict with the organizer's state UPDATE (FOR NO KEY UPDATE), so "count 0 live seats -> draft" and "see open -> insert" could both commit. Both registration gates now read the event `FOR SHARE`; proven by a two-connection test plus a mutation test showing the slip without it. (2) **A PRE-EXISTING HOLE THAT DEFEATED THE NEW GATE (adversarial review A):** an organizer SCOPED to event X could `update sd_participants set event_id = <closed Y>` and land a REGISTERED seat in Y — `sd_pin_participant`'s organizer early return is decided on OLD's event, and Y's gates live in the INSERT guard. **Fixed: a seat's `event_id` can no longer change for any JWT caller** (this is the `event_id` half of the 2026-10-22 SECURITY FOLLOW-UP item 1; the `user_id` half STAYS queued with the consent work — it cannot bypass the closed gate, and two consent tests deliberately exercise organizer reassignment). Recorded, not changed: an organizer may INSERT an event already `closed`/`running` (not a hole — a new event has no seats or rounds, so the state is reachable legally anyway).
**UI:** organizer console — *Close registration* / *Reopen registration* / *Back to draft* (offered only when empty; a hint otherwise) / *Start event* from open or closed / *Cancel* from closed / *Edit details* for closed; daters with no seat see "Registration is closed for this event."; *Withdraw* shows for registered AND waitlisted while open or closed; the state reads "registration closed" on the page and the events list; the edit page says nobody is notified.
**Verified:** `sd-closed-state.test.ts` 19 tests (every route with a control; 12 legal + 11 illegal moves; back-to-draft refused per live-seat kind and per round; participant visibility; 4 mutation checks incl. the race and the event_id move); db suite **490/490**; ACL 17/17 local; module vitest 64/64; `apps/web` tsc clean; e2e (CI mode, prebuilt) all 7 speed-dating tests incl. the new close/reopen/back-to-draft one (two older tests flaked once on a slow first click and passed on retry and again alone). New `scripts/prod-verify-sd-closed-state.mts` (37 checks); `prod-verify-sd-self-rejoin.mts` now reads the new bodies. **PROD BEFORE: 24/37, 13 failures, every control green.**
**STATUS: ON PRODUCTION AND PROD-VERIFIED 2026-10-27** (founder go in chat; backup `backups/2026-10-27T04-45-06`; dry run listed only this file; `prod-verify-sd-closed-state.mts` **24/37 -> 37/37**; `prod-verify-sd-self-rejoin.mts` 171/0 (now reads the new bodies); `prod-verify-insert-pins.mts` 271/0; `verify-acl-hardening.ts` 17/17 on prod). App pushed with it (`afed2cc`, master `82192f3`). Coordinated with the organizer-screens chat: its work is UI-only, no SQL overlap, kept separate. CI went green on the THIRD attempt (attempts 1-2 died in `supabase start` on registry rate limits pulling `supabase/imgproxy` — no test ran; not this diff), deploy READY. **On the live site:** new `scripts/prod-verify-closed-state.mjs` **17/17** (real browsers as alice/charlie/dana: back to draft while empty, close, dater sees closed, withdraw while closed, reopen + register control, back to draft after everyone withdrew; deletes its own event), and the existing `prod-verify-event-lifecycle`, `-video-controls`, `-video-refusals`, `-interest-change`, `-organizer-screens` all pass. Add `prod-verify-closed-state.mjs` to the OPERATIONAL RECIPES #3 list.

## 2026-10-28 — VIDEO RESILIENCE (Sonnet, no migration): reconnect banner + device picker; and the decisions this raised

**Built and pushed (`965ae18`, CI green, deploy READY):** in `ui/events/[eventId]/video-room.tsx`. **(a) Reconnecting banner:** on the library's `CONNECTION_INTERRUPTED` the call shows "Connection lost — reconnecting…", `CONNECTION_RESTORED` clears it, and after 20 s without recovery the room falls to the existing 'left' state with Rejoin and the note "Your connection to the video room was lost…". Both events are optional keys (absent on older builds = old behaviour). **(b) Camera/microphone picker:** two selects, shown only when the browser lists more than one device of that kind, re-read on `devicechange`; switching creates the new track first, `room.replaceTrack`s it, disposes the old, keeps a muted track muted, and on any failure leaves the old device in use with "Could not switch to that device…".
**VERIFIED ON PROD with real calls** (`scripts/prod-verify-video-resilience.mjs`, fake media, real JaaS; `prod-verify-video-controls.mjs` re-run as the join regression, 11/11): the microphone SWITCH works (selection changes, the partner still hears, a muted mic stays muted); the camera picker is hidden with one camera, appears when a second shows up, and choosing an unopenable one shows the error while the old camera keeps working; no banner in a healthy call. **NOT VERIFIED — the reconnect banner itself:** an emulated drop (Playwright `setOffline` for 75 s) triggered NOTHING, most likely because offline emulation does not sever an established peer-to-peer media connection, so the library was never told. That is INCONCLUSIVE, not a pass. **TO DO BY HAND on two real devices:** join a call, switch one device's Wi-Fi off for ~10 s and back (expect the banner, then it disappears), then off for 30 s (expect the banner, then "Your connection… was lost" with Rejoin). A camera SWITCH between two real cameras is likewise unverified (Chromium's fake device exposes one).
**Item 5 of the organizer follow-ups (exports) is NOT Sonnet work — moved to Opus.** `ui/export.ts` replaces nothing yet: swapping `user_id` for names in the roster export, and adding "reports I filed" (which names the reported person), decide whose data leaves the system in a file = export/privacy rules. Bundle with the feedback slice or the security follow-up.
**DECISIONS WAITING ON THE FOUNDER (asked 2026-10-28):** (1) **Number of rounds.** Round and break length are exact, but the ROUND COUNT is not organizer-set: the rotation runs until everyone has met everyone (14 people = 13 rounds, ~1.5 h). Proposal: an optional "number of rounds" cap (`sd_events.rounds_planned` already exists, no migration) read by `runPairingRound` AND the worker orchestrator, which makes the plan exact (6 rounds x 7 min + 5 x 30 s = 45 min). (2) **Check-in.** Today nothing sets `checked_in` and pairing ignores it, so the lobby line "check in at the front desk" does nothing. Options: A) reword it; B) real check-in — staff tick "arrived", pairing uses only checked-in people, per-event switch (off for online events); touches pairing in two places. The dater-screen "Round N of up to M" line (item 1) waits on decision 1.
**IDEA, PLATFORM-WIDE, NOT STARTED (founder 2026-10-28): in-product "Send feedback" — bug reports with the context needed to reproduce, and suggestions.** Sketch: a button on every page (Bug / Suggestion); captured automatically: page, org + module, user + role, time, browser + viewport, app version (commit), and the user's recent activity trail from `activity_events` (docs/17 — already captured, the key to reproducing); a superadmin inbox `/console/feedback` with statuses. NOT session replay. Privacy: personal data, so a `/privacy` line and docs/21 account-deletion handling; a new table + RLS = Opus tier, the button/inbox UI = Sonnet. Needs its own design note and an Opus starter prompt; do not start unprompted.

## 2026-10-28 (later) — ROUND CAP, CHECK-IN, EXACT DATER TIMING (Sonnet, no migration); decisions recorded

**Founder decisions this session:** (1) the creator MUST state a maximum number of rounds OR a maximum event length, and the other fills in; (2) check-in matters: a person who is registered but not checked in must be told, loudly, that they are not in the rounds; (3) the dater screen can now be exact; (4) feedback/tickets are platform-wide (docs/27, design note only).
**ROUND CAP (built).** `sd_events.rounds_planned` (existed, read by nothing) is now REQUIRED at creation/edit (prefilled: the natural count for the expected people, at most 8). The form has two linked boxes, "Number of rounds (at most)" and "Event length (at most)": typing one fills the other from round + break length; only the round count is saved. `ui/event-plan.ts` holds the maths (`naturalRounds`, `totalMinutesFor`, `roundsForLength`, `planEvent` with `maxRounds`). A cap below the natural count makes the length EXACT; a cap makes a repeat-meetings event plannable. Enforced in `runPairingRound` (notice `rounds-cap-reached`) AND the worker orchestrator (stops building once `rounds_planned` rounds exist and the last is closed). **Verified:** `scripts/verify-orchestrator-round-cap.mts` (local; cap 1 -> no round 2, CONTROL cap 2 -> round 2; fails when the cap line is removed — mutation-checked). Older events keep `rounds_planned` null = no cap.
**EXACT DATER TIMING (built).** The "Right now" panel shows "(round 2 of 6 · about 25 min left)" when a cap is set (not otherwise: a dater cannot see how many others registered, so no "natural" figure is knowable to them). Time left = current round's end + (rounds still to come) x (break + round) - now.
**CHECK-IN (built; format-driven, no migration).** `sd_events.format.checkIn` = `'staff' | 'self'` (absent = off). **A LATENT BUG THIS CLOSED:** the worker orchestrator filtered `checked_in = true` ALWAYS, the manual button never did, and NOTHING in the app set `checked_in` (default false) — a running worker would have paired nobody at any event. Both paths now apply ONE rule: only where the event uses check-in are only checked-in people paired. New actions `checkInParticipant` (organizer marks anyone; stamps `checked_in_at` because the organizer branch of `sd_pin_participant` returns before the trigger would) and `checkInSelf`. UI: the amber "You are NOT checked in yet" box (role=alert), a badge on the events list, a changed "not in this round" line, an organizer summary + per-person Mark arrived/Undo arrival, and `checkin-needed` / `checkin-refused` notices. **Known limits:** a HOST cannot check others in (`sd_pin_participant` pins another person's `checked_in` for hosts) — organizer only in v1; 'staff' mode hides the self button but the database would still let a person check themselves in (UI is not a gate; harmless — it only affects their own pairing). Mid-event arrivals join at the next round; the rotation tolerates the changed seat set (history prevents repeats, irreparable pairs become byes). **Verified:** the worker half with controls (`scripts/verify-orchestrator-round-cap.mts`: used + nobody arrived -> no round; used + arrived -> round; not used + nobody arrived -> round). **The UI half is covered by two new e2e tests that have NOT been run locally** (the machine's Windows commit limit was exhausted: `memory allocation of 16777216 bytes failed`, free virtual memory 1.5 GB — see CLAUDE.md's gotcha); CI is their first run.
**NOT BUILT / OPEN:** Opus list — export manifest changes (names in the roster export, "reports I filed"; privacy rules), the feedback/ticket primitive (docs/27), the security follow-up (user_id refusal, notes guard), organizer-seating consent. Hand-test still owed: the video reconnect banner on two real devices, and a camera switch between two real cameras.
**UPDATE 2026-10-28 (same day): the round cap and staff check-in are VERIFIED — CI green on `30a392b` (the three new e2e tests ran for the first time there and passed; deploy READY) and a real-browser run on PRODUCTION, `scripts/prod-verify-checkin-and-cap.mjs`, 10/10:** a cap of 1 reads as an exact plan; the NOT-checked-in box and the events-list badge appear; *Run next round* is refused until two are arrived; the round then starts; the dater sees "(round 1 of 1 · about 7 min left)"; a second press is refused by the cap. Regression on prod: `prod-verify-organizer-screens.mjs` 9/9 and `prod-verify-closed-state.mjs` all pass against the changed create form. **Still not seen on prod:** SELF check-in mode (covered by CI e2e only), a host's inability to check others in, and a mid-event arrival joining the next round.
**UPDATE 2026-10-29 — THE RECONNECT BANNER IS NOW VERIFIED AGAINST THE REAL LIBRARY ON PROD, BY A FAITHFUL SIMULATION (`scripts/prod-verify-video-reconnect.mjs`, 12/12).** A real network drop cannot be produced from a script (Playwright's offline mode never reaches an established peer-to-peer connection — the 2026-10-28 attempt), so the browser's `RTCPeerConnection` objects are hooked before the page loads and made to REPORT `iceConnectionState = 'disconnected'` and fire the real `iceconnectionstatechange` event; the REAL lib-jitsi-meet then decides for itself. Result: it emits its interrupted event (banner appears, "Connection lost — reconnecting…"); reporting the real (connected) state again makes it emit RESTORED (banner clears, charlie still in the call, dana still sees him); a second interruption that never recovers gives up after 20 s (measured 20 s) into "Your connection to the video room was lost…" with Rejoin, and Rejoin works. **What this does NOT prove:** that a physical Wi-Fi drop makes the browser report 'disconnected' — that is the browser's behaviour, not ours. A hand test on two real devices is now a nice-to-have, not a blocker.
**Local browser tests work again (2026-10-29):** after the restart free virtual memory was 19 GB, but the dev server still failed with `Compaction failed` / `Persisting failed` — Turbopack's cache under `apps/web/.next/dev` was corrupted by the earlier out-of-memory death. Deleting `apps/web/.next/dev` (git-ignored, regenerable; only with no server running) fixed it: the five new/related e2e tests (round cap, staff check-in, self check-in, organizer timing, blocked-pairs count) pass locally, 5/5.
