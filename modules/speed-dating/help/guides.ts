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
   back in the next one.
4. **People you met** lists everyone you've been paired with. After each
   meeting, mark them: **interested**, **not interested**, or **no show**.
   You can change a mark until results are revealed.

## Privacy — how matching works

5. Your marks are private. Nobody ever learns you marked them one way or the
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

1. Open **Speed Dating**, fill **Create event** (name + date/time), click
   **Create (draft)**.
2. Open the event and click **Open registration** — participants can now
   register. The roster shows who's in.

## Run the rounds

3. Click **Start event**. From here the automatic round clock takes over:
   each round runs its configured length, then the next round pairs
   checked-in participants — never repeating a pairing (unless the event
   allows it), never pairing anyone against their personal block list, byes
   handled automatically.
4. **Run next round (pair everyone)** manually advances if you don't want to
   wait out the clock.
5. The console shows **Rounds run** and **Matches: X revealed / Y total** as
   the event progresses. When everyone has met, rounds stop advancing.

## Finish and reveal

6. Click **Complete event**, then **Reveal mutual matches** — every mutual
   pair sees "It's a match!"; one-sided interest reveals nothing to anyone.
`,
    },
  ],
}
