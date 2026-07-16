// Synagogue-schedules walkthroughs (docs/03 user-walkthrough decision).
// UPDATE RULE: a UI change updates the matching steps here in the same
// commit. (docs/08 holds the founder's original production walkthrough.)
//
// Founder feedback (2026-07-11): this module had TWO help documents with
// different content — this generic registry guide, and a bespoke
// module-owned setup page (`modules/synagogue-schedules/ui/help/page.tsx`,
// built 2026-07-07 as the very first module, before this registry existed).
// Folded the bespoke page's richer setup detail (org/onboarding context,
// name-templating tokens, worked rule examples, publish/export/public-link
// steps) into this ONE guide and deleted the duplicate — every other
// module already has exactly one help document, this one now matches.
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
2. If your synagogue shares a public link (\`/s/<slug>\`), anyone can read the
   published schedule there without signing in — no account needed.
`,
    },
    {
      role: 'maker',
      title: 'Maker — build rules, publish weeks, export',
      staff: true,
      body: `
## Before you start

Your synagogue is an **organization** with a name, a short **slug** (used in
web addresses and the public link), and a location (latitude/longitude,
timezone, and myzmanim location ID that zmanim are computed from). An **org
owner/admin** can edit the location themselves: from the dashboard, click
**Settings** on the organization card and fill in the synagogue location
form. Creating the organization and enabling this module is done by the
**platform owner**. Adding people or changing roles (maker can edit
schedules; viewer can only look; congregants who just check times need no
account at all) is done by an org owner/admin from the dashboard's
**Members** link.

## One-time setup: the rule builder

1. Open **Synagogue Schedules → Setup**.
2. Create a **schedule type** for each board you print (e.g. "Weekday
   Schedule", "Shabbat Schedule — {shabbatTitle}") — the trigger decides
   which days it covers. Names can include live tokens: \`{shabbatTitle}\`
   becomes the parsha + special Shabbos name automatically each week; also
   \`{parsha}\`, \`{hebrewYear}\`, \`{moladText}\`.
3. Inside a type, **Add section** (e.g. שחרית, מנחה ומעריב, שיעורים), then
   **Add line** per entry. A line's time is either:
   - **Fixed clock time** — e.g. name "Shachris (2)", time \`06:50\`, checked
     Mon–Fri (leave Sunday off so a different Sunday minyan can be its own
     line).
   - **Zman-based time** — e.g. name "Mincha & Maariv", zman \`sunset\` (or
     type any myzmanim name like \`Night50fix\`), offset \`-20\`, round down to
     \`5\`. Optional day anchor/clamps, a "not before" floor (e.g. Mincha
     Gedolah never before 1:30 PM), or reference another line by its exact
     name.
   Optional condition (season/day types) with fallback text for days it
   doesn't apply; Hebrew text optional per line.
4. Check the result immediately on the **Schedules** page — it recomputes
   live as you edit, and ← / → moves between weeks.

## Weekly rhythm

5. Under **Weekly message** (bottom of Setup), add any free-text
   announcements for the week (e.g. "Kiddush sponsored by…") — Hebrew
   supported, shown only on that week's schedule.
6. Click **Publish week** in Setup → **Published weeks** — the week appears
   on every member's Schedules page and on your public link
   (\`solutions-platform.vercel.app/s/<slug>\`, no login needed).
7. On the **Schedules** page, **Export this week** renders your configured
   formats (print PDF, lobby-screen JPG, WhatsApp JPG) in one click — files
   appear with download links, typically under a minute.

Something you can't express with the rule builder? Tell the platform owner —
the rule engine likely supports it already (line references, holiday
conditions, fallback text).
`,
    },
  ],
}
