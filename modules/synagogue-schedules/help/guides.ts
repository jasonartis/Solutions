// Synagogue-schedules walkthroughs (docs/03 user-walkthrough decision).
// UPDATE RULE: a UI change updates the matching steps here in the same
// commit. (docs/08 holds the founder's original production walkthrough.)
import type { ModuleHelp } from '@platform/core'

export const synagogueSchedulesHelp: ModuleHelp = {
  moduleKey: 'synagogue-schedules',
  guides: [
    {
      role: 'viewer',
      title: 'Viewer — read the schedule',
      body: `
1. From the Dashboard, click **Synagogue Schedules** — the current published
   week renders with every schedule (weekday, Shabbat, …) and its times.
2. If your synagogue shares a public link (\`/s/<name>\`), anyone can read the
   published schedule there without signing in.
`,
    },
    {
      role: 'maker',
      title: 'Maker — build rules, publish weeks, export',
      staff: true,
      body: `
## One-time setup: the rule builder

1. Open **Synagogue Schedules → Setup**.
2. Create a **schedule type** for each board you print (e.g. "Weekday
   Schedule", "Shabbat Schedule — {shabbatTitle}") — the trigger decides
   which days it covers; \`{shabbatTitle}\` in a name fills in the parsha.
3. Inside a type, **Add section** (e.g. "Tefillos"), then **Add line** per
   entry. A line's time is either:
   - **Fixed clock time** (e.g. 18:00), or
   - **Zman-based time**: pick the zman (or type a myzmanim name like
     \`Night50fix\`), add an offset in minutes, optional rounding, optional
     day anchor and clamps, or reference another line by its exact name.
   Optional condition (season/day types) with fallback text for days where
   it doesn't apply; Hebrew text optional per line.

## Weekly rhythm

4. Under **Weekly message**, add any free-text announcements for the week.
5. Click **Publish week** — the week appears under **Published weeks**, on
   every member's Schedules page, and on your public link.
6. On the **Schedules** page, the **Exports** section renders the week to
   your configured formats (print PDF, lobby screen, WhatsApp image). Files
   appear with download links when ready — typically under a minute.
`,
    },
  ],
}
