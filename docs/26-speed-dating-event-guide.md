# Speed dating — running an event, step by step (AS BUILT, 2026-10-16)

Written after the founder's first real walkthrough. This describes what the screens
**actually do today**, not the spec's intent. Gaps are marked **GAP** and are the input to the
next build slice. Spec and decisions: [module-6-speed-dating.md](modules/module-6-speed-dating.md).

## The three things people mix up

| Word | Meaning | Has a timer? |
|---|---|---|
| **Event** | The whole evening: registration -> rounds -> reveal. States: draft, open, closed (registration closed, event still on), running, complete, cancelled. | No end timer. Only an optional start time and lobby-open time. |
| **Round** | One slot where everyone is paired up, one pair per video room. Default 7 min (column `round_duration_seconds`). | Yes: "Ends in mm:ss" on the participant's page. |
| **Break** | Short gap after a round (default 30 s) before the next. | Yes. |

With N registered people a round makes N/2 pairs (odd one out gets a **bye**). Without
"allow repeat pairings", nobody meets the same person twice, so there are at most N-1 rounds.
**Two people = exactly one round** (that is why a two-person test cannot run a second round).

## Who does what

| Person | Role | What they can do |
|---|---|---|
| **Organizer** (e.g. alice) | `organizer` | Create an event, open registration, start it, run rounds, complete it, reveal matches, review safety reports, clear a removal so a removed person may register again (an organizer can NEVER put a withdrawn or removed person back — only that person can), close and reopen registration, move an event with nobody registered back to draft, cancel or (if empty) delete the event. Cannot take a seat in their own event. |
| **Host** | `host` | Sees the roster and safety reports; may remove a participant. No setup rights. |
| **Dater** (e.g. charlie, dana) | `participant` | Register, withdraw, join video, mark interest, write private notes, report, block. |

Audience and mentor seats exist in the schema but have no UI. **GAP.**

## One evening, in order

1. **Organizer: create** — module page -> *Create event* (name; optional start time, **round length
   and break length**, "let people meet more than once", resume-review, share-contact, two sides).
   A live line under the timing boxes reads e.g. "14 people, up to 13 rounds, about 1.5 hours"
   (the number of rounds is fixed by who is registered, not typed in; personal blocks can only
   shorten it). Event is a **draft** nobody else sees. A draft, open or closed event has an *Edit details*
   button on its page: name, description, start time, timing, switches and sides can change until
   a round has run; the **sides lock once anyone has registered** (they chose one).
2. **Organizer: open registration** — event page -> *Open registration*. Daters now see it under
   "Open for registration" on their events list. *Close registration* stops new sign-ups and keeps the event (daters see "Registration is closed";
   registered people can still withdraw; the organizer can still promote from the waitlist and clear a
   removal); *Reopen registration* undoes it. *Start event* works from open or closed. *Back to draft*
   is offered only while nobody is registered or waiting and no round has run (the database refuses it
   otherwise, so people who signed up are never silently dropped). To fix a wrong time or name, *Edit
   details* (nobody is notified); to end it, *Cancel event*. (Since 2026-10-27, `20261027010000`.)
3. **Daters: register** — event page -> *Register for this event* (pick a side only if the
   organizer enabled two sides; nothing is read from profiles). The list shows their status
   (registered / waitlisted / withdrawn / removed). Withdrawing is possible while the event is
   open or closed. **A person who withdrew registers again THEMSELVES** with the *Register again* button while registration is open (live since 2026-10-19; the database decides registered vs waitlisted by capacity, and a rejoiner goes to the back of the waitlist). An organizer cannot re-seat them; for someone the organizer REMOVED, the roster offers *Allow to register again*, which only clears the removal, and the person must then register themselves.
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
   told). Organizers with the manage tier see how many pairings personal blocks are
   skipping ("3 pairings are being skipped…"), never who blocked whom — so a bye is explainable.
   A plain organizer cannot read blocks (RLS), so sees no figure rather than a wrong zero.
7. **Next round** — if the background **worker** is running it closes the round, waits out the
   break and builds the next one automatically; otherwise the organizer clicks *Run next round*
   each time. **Production has no worker running unless `pnpm worker:prod` is up.** When
   everyone has met everyone, *Run next round* says so instead of starting one.
8. **Organizer: finish** — *Complete event*, then *Reveal mutual matches*. A pair where **both**
   marked "interested" now sees "It's a match!" (and contact details if the event shares them).
   Anything else stays invisible to the other person, forever.

## Things the screens do not tell you today

- ~~Whether you are the organizer or a participant in the events list~~ — the list now shows
  "you organize" and, for events you hold a seat in, "you participate".
- Check-in: the lobby says "check in at the front desk", but **no screen sets checked-in** and
  pairing uses everyone *registered*, so it has no effect. **GAP.**
- A round that ran out is treated as ended by the page, but its stored state stays `active`
  until the worker (or the next manual round) closes it.

## Test accounts on production (`demo-dating`)

alice = organizer; charlie, dana, eve, frank = participants. Shared demo password is in
`.env.deploy` (`PROD_DEMO_PASSWORD`). Scripts that drive these flows end to end:
`scripts/prod-verify-event-lifecycle.mjs`, `scripts/prod-verify-video-controls.mjs`,
`scripts/prod-verify-video-call.mjs`.

## Testing it by hand (added 2026-10-22 so the walkthrough is not re-invented)

**The demo data on production.** After the 2026-10-22 cleanup the only speed-dating event in `demo-dating` is **Friday Night Mixer** (open, empty): it is the SEEDED demo event, not test clutter — keep it. Every test event you create should be removed afterwards (`node scripts/prod-setup-live-event.mjs --delete "<name>"`, or the Delete event button when it has no registrations and no rounds).
**Set up:** `node scripts/prod-setup-live-event.mjs 180` (see the module-6 spec, "OPERATIONAL RECIPES"). Do the AUTOMATED checks first (`scripts/prod-verify-*.mjs`, a fake-media mock of both sides) and hand a human only what needs real hardware.
**Only one camera and microphone?** Best: a laptop plus a phone (separate devices, and cellular gives a second network). Next: two Chrome windows (one normal, one Incognito) on the same machine, with headphones on at least one side to avoid echo. Chrome plus Edge usually FAILS on Windows because the camera is exclusive to one browser app. Two tabs of one profile are not a real test.
**The human call, step by step.** (1) Computer A: sign in as `dana@demo.local`, open the module page, open the event — "Round 1 — you're with Charlie C". (2) Computer B: sign in as `charlie@demo.local`, open the same event. (3) Both: **Join video**, allow camera and microphone. (4) Check each side sees and hears the other. (5) **Mute microphone** on one side: the other's status line should read "Charlie: microphone off (they muted it)"; **Turn camera off** should show a black panel with a crossed-out camera and "Charlie's camera is off", NOT a frozen frame. (6) **Leave**, then **Rejoin video**. (7) Under **People you met**, change interested / not interested / no show on both sides, add a private note, and (if wanted) file a report. Organizers (alice) cannot take a seat in their own event, so an organizer cannot be one of the two callers.
**The `?notice=` messages on the event page** (a thrown server-action message is redacted in production, so refusals redirect with a fixed code the page renders): `rotation-complete` (Run next round when everyone has already met everyone), `rejoin-refused` (Register again / registration refused: closed event, banned, or not eligible), `register-closed` (also a closed event), `register-side`, `draft-refused` (Back to draft with someone registered), `state-refused` (any other refused state change), `edit-saved`/`edit-locked` (two-sided event, no side chosen). Anything else is ignored.
