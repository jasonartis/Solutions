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

