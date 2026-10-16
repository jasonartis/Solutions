# Speed dating — running an event, step by step (AS BUILT, 2026-10-16)

Written after the founder's first real walkthrough. This describes what the screens
**actually do today**, not the spec's intent. Gaps are marked **GAP** and are the input to the
next build slice. Spec and decisions: [module-6-speed-dating.md](modules/module-6-speed-dating.md).

## The three things people mix up

| Word | Meaning | Has a timer? |
|---|---|---|
| **Event** | The whole evening: registration -> rounds -> reveal. States: draft, open, running, complete, cancelled. | No end timer. Only an optional start time and lobby-open time. |
| **Round** | One slot where everyone is paired up, one pair per video room. Default 7 min (column `round_duration_seconds`). | Yes: "Ends in mm:ss" on the participant's page. |
| **Break** | Short gap after a round (default 30 s) before the next. | Yes. |

With N registered people a round makes N/2 pairs (odd one out gets a **bye**). Without
"allow repeat pairings", nobody meets the same person twice, so there are at most N-1 rounds.
**Two people = exactly one round** (that is why a two-person test cannot run a second round).

## Who does what

| Person | Role | What they can do |
|---|---|---|
| **Organizer** (e.g. alice) | `organizer` | Create an event, open registration, start it, run rounds, complete it, reveal matches, review safety reports, reinstate a withdrawn person, cancel or (if empty) delete the event. Cannot take a seat in their own event. |
| **Host** | `host` | Sees the roster and safety reports; may remove a participant. No setup rights. |
| **Dater** (e.g. charlie, dana) | `participant` | Register, withdraw, join video, mark interest, write private notes, report, block. |

Audience and mentor seats exist in the schema but have no UI. **GAP.**

## One evening, in order

1. **Organizer: create** — module page -> *Create event* (name; optional start time, resume-review,
   share-contact, two sides). Event is a **draft** nobody else sees. **GAP:** round/break length,
   number of rounds and total duration cannot be set or previewed here (set directly in the
   database for tests); a draft has no detail/edit view.
2. **Organizer: open registration** — event page -> *Open registration*. Daters now see it under
   "Open for registration" on their events list. **GAP:** an open event cannot be closed or
   returned to draft.
3. **Daters: register** — event page -> *Register for this event* (pick a side only if the
   organizer enabled two sides; nothing is read from profiles). The list shows their status
   (registered / waitlisted / withdrawn / removed). Withdrawing is possible while the event is
   open. **GAP (in build):** a person who withdrew cannot register again by themselves; today only
   the organizer's *Reinstate* does it.
4. **Organizer: start** — *Start event*, then *Run next round (pair everyone)*. This builds the
   pairs, creates one private video room per pair, and starts the round clock.
5. **Daters: the round** — "Right now: Round 1 — you're with X. Ends in …". *Join video* ->
   allow camera and microphone. In the call: mute, camera off/on, a status line showing whether
   the partner's mic/camera are on, off, or not connected, and *Leave* / *Rejoin video*.
   Video ends by itself at round end (the join token expires).
6. **Daters: after the round** — under *People you met*: **interested / not interested / no
   show** (changeable until matches are revealed), a **private note** (visible only to you,
   survives across events, invisible even to organizers), **Report** (goes to the organizer's
   triage list; the reported person never sees it), **Never pair me with them again** (the
   rotation skips that pair in every future round and event in this org; the other person is not
   told). **GAP:** organizers cannot see *why* someone got a bye.
7. **Next round** — if the background **worker** is running it closes the round, waits out the
   break and builds the next one automatically; otherwise the organizer clicks *Run next round*
   each time. **Production has no worker running unless `pnpm worker:prod` is up.** When
   everyone has met everyone, *Run next round* says so instead of starting one.
8. **Organizer: finish** — *Complete event*, then *Reveal mutual matches*. A pair where **both**
   marked "interested" now sees "It's a match!" (and contact details if the event shares them).
   Anything else stays invisible to the other person, forever.

## Things the screens do not tell you today

- Whether you are the organizer or a participant in the events list (the Organizer console only
  appears for organizers). **GAP.**
- Check-in: the lobby says "check in at the front desk", but **no screen sets checked-in** and
  pairing uses everyone *registered*, so it has no effect. **GAP.**
- A round that ran out is treated as ended by the page, but its stored state stays `active`
  until the worker (or the next manual round) closes it.

## Test accounts on production (`demo-dating`)

alice = organizer; charlie, dana, eve, frank = participants. Shared demo password is in
`.env.deploy` (`PROD_DEMO_PASSWORD`). Scripts that drive these flows end to end:
`scripts/prod-verify-event-lifecycle.mjs`, `scripts/prod-verify-video-controls.mjs`,
`scripts/prod-verify-video-call.mjs`.
