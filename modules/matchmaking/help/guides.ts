// Make-a-Match walkthroughs (docs/03 user-walkthrough decision). UPDATE RULE:
// a UI change updates the matching steps here in the same commit.
import type { ModuleHelp } from '@platform/core'

export const matchmakingHelp: ModuleHelp = {
  moduleKey: 'matchmaking',
  guides: [
    {
      role: 'single',
      title: 'Single — answer questions and see your matches',
      body: `
## What you can do
Answer the community's questions about yourself and what you care about in a
match, then see your top matches by compatibility.

1. From the Dashboard, click **Make-a-Match** on your organization's card.
2. **Your matches** (top of the page) lists your best matches with a
   compatibility percentage. *(recompute pending)* next to a match means your
   recent answers haven't been rescored yet — an admin runs the recompute.
3. Under **Your answers**, every approved question shows:
   - **Your answer** — pick the option that describes you.
   - **The care slider** — how much your match's answer matters to you:
     **+10** = they should answer like you, **0** = don't care,
     **−10** = they should answer the opposite.
   - **Dealbreaker** — check it to exclude anyone who doesn't fit this
     question entirely.
   - **Share this answer with a potential match** — whether a match may see
     this answer about you.
4. Click **Save** on each question you change. Questions marked
   *(not yet answered — default)* still count with a neutral middle answer
   until you set them.
5. Some questions show **Locked by admin** — the community fixed that answer
   or care level for everyone (e.g. gender matching); you can't change it.
`,
    },
    {
      role: 'matchmaker',
      title: 'Matchmaker — review matches for your singles',
      body: `
1. Open **Make-a-Match**. As a matchmaker you see **Matches for your
   assigned singles**: every scored pair involving someone assigned to you,
   best first.
2. Use the percentages to decide who to introduce. (The introduction /
   mutual-agreement flow is coming; today you contact people directly.)
`,
    },
    {
      role: 'admin',
      title: 'Admin — questions, locks, and recomputes',
      staff: true,
      body: `
1. Open **Make-a-Match → Manage**.
2. **Pending proposals** lists member-suggested questions — click **Approve**
   (it goes live for everyone) or **Reject**.
3. **Add a question**: text plus 2–5 comma-separated scale labels. To make a
   question a forced criterion, set **Lock care at** (e.g. −10) and check
   **Lock as dealbreaker** — the classic use is a gender question locked to
   "opposite, dealbreaker".
4. After answers change, click **Recompute all matches** — every pair's
   percentage refreshes and *(recompute pending)* flags clear.
`,
    },
  ],
}
