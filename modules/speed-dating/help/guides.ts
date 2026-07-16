// Speed-dating walkthroughs (docs/03 user-walkthrough decision). UPDATE RULE:
// a UI change updates the matching steps here in the same commit.
import type { ModuleHelp } from '@platform/core'

export const speedDatingHelp: ModuleHelp = {
  moduleKey: 'speed-dating',
  guides: [
    {
      role: 'participant',
      title: 'Participant — from registration to "It\'s a match!"',
      body: `
## Register

1. From the Dashboard, click **Speed Dating**, then an event whose status is
   *open*.
2. Click **Register for this event**. You can **Withdraw** any time before it
   starts.

## During the event

3. Once the organizer starts the event, rounds run on a timer — each round
   pairs you with someone new; sitting out a round ("bye") just means you're
   back in the next one. If you arrive before it starts, a banner tells you
   the lobby is open and when the event begins.
3a. **Right now** shows who you're currently paired with (or that you have a
   bye, or that you're not checked in yet) with a live countdown to when the
   round ends — no need to guess or ask; it refreshes on its own.
3b. If the organizer enabled **resume-review** for this event, you'll see
   **My profile card** — a short line about yourself. Fill it in before the
   event; anyone you're paired with sees it next to your name (and you see
   theirs) instead of going in blind.
4. **People you met** lists everyone you've been paired with. After each
   meeting, mark them: **interested**, **not interested**, or **no show**.
   You can change a mark until results are revealed.
5. **Private note**: jot anything you want to remember about them — only you
   ever see it, not the organizer or host.
6. **Report**: if something made you uncomfortable, click it, pick a reason,
   and submit. Only the organizer/host see reports (never the person you
   reported).
7. **Never pair me with them again**: a personal, permanent block — it
   applies to every future event too, and the other person is never told.
   Manage your list (and remove a block) from the **People you've blocked**
   section on the main Speed Dating page.

## Privacy — how matching works

8. Your marks are private. Nobody ever learns you marked them one way or the
   other — unless you BOTH marked **interested** AND the organizer reveals
   results. Then each of you sees **It's a match!** with the other's name.
   Not seeing a match tells you nothing about what anyone chose.
`,
    },
    {
      role: 'organizer',
      title: 'Organizer — create and run an event',
      staff: true,
      body: `
## Create and open

1. Open **Speed Dating**, fill **Create event** (name + date/time), check
   **Resume-review** if you want participants to see each other's profile
   cards instead of going in blind. **Two sides** (expand it) is optional —
   turn it on and give each side a label (e.g. "Men"/"Women") plus an
   optional capacity if you want participants split into two groups with
   their own waitlist; leave it off for one open pool (the default). Click
   **Create (draft)**.
2. Open the event and click **Open registration** — participants can now
   register (choosing a side first, if you set up two sides). The roster
   shows who's in, and — for a two-sided event — each side's count against
   its capacity and anyone waitlisted.
2a. **Known limitation**: per-side capacity is currently soft — registering
   past a side's capacity doesn't yet actually land someone on the waitlist
   (a real bug the team caught before calling it done; fix in progress).
   The roster, labels, and **Promote next waitlisted** button all work
   correctly once a waitlisted row exists.

## Run the rounds

3. Click **Start event**. From here the automatic round clock takes over:
   each round runs its configured length, then the next round pairs
   checked-in participants — never repeating a pairing (unless the event
   allows it), never pairing anyone against their personal block list, byes
   handled automatically.
4. **Run next round (pair everyone)** manually advances if you don't want to
   wait out the clock.
5. The console shows **Rounds run**, **Matches: X revealed / Y total**, and
   the current round's countdown (or the break before the next one) as the
   event progresses. When everyone has met, rounds stop advancing.
6. **Roster & reports** (below the console) shows who's registered and every
   safety report filed for this event — **Mark reviewed / actioned /
   dismiss** to triage. The reported person is never told they were reported.
   For a two-sided event, **Promote next waitlisted** moves the
   longest-waiting person on that side into a seat that's opened up
   (organizer-only — a host can remove a participant but can't promote one).

## Finish and reveal

7. Click **Complete event**, then **Reveal mutual matches** — every mutual
   pair sees "It's a match!"; one-sided interest reveals nothing to anyone.
`,
    },
    {
      role: 'host',
      title: 'Host — lobby & safety duty (no event-setup rights)',
      staff: true,
      body: `
A host handles the room, not event setup — you won't see **Create event** or
the lifecycle buttons an organizer has.

1. Open an event you're hosting. **Roster & reports** shows who's registered
   and every safety report filed for this event.
2. **Mark reviewed / actioned / dismiss** to triage a report. The reported
   person is never told they were reported, and you never see who reported
   whom beyond what's shown here (reporter identity is staff-only, same as
   the reported side never seeing it at all).
`,
    },
  ],
}
