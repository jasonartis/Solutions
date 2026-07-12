# Module 3: Synagogue Schedules (key: `synagogue-schedules`, prefix `syn_`)

## Problem & context

Schedule builder for synagogues. Each synagogue (an org: name, address/zipcode) configures sections, lines, time algorithms, conditions, and overrides; the system generates dated schedule documents and exports them in multiple formats. Replaces the founder's current Sheets solution. **First module to be built** (see docs/04) and the intended canonical exemplar.

## Roles

- **Maker** — configures everything, generates/exports schedules, controls which dates viewers may see.
- **Viewer** — picks a date from maker-allowed dates and views the schedule. **Both access modes (decided 2026-07-06):** public page with no login (congregants checking times) *and* optional logged-in viewers for future expanded features.

## Schedule types (decided 2026-07-06)

Typed documents; a date/week can trigger several:

- **Weekday sheet** (Sunday–Friday, one weekly document),
- **Shabbat sheet**,
- **Special full-day sheets** triggered by conditions (e.g., Yom Kippur on a Thursday gets its own complete schedule, while the weekday sheet may carry a reference line to it).

## Structure & rules

- Schedule type → named **sections** → named **lines** (events).
- **Visibility conditions** per section/line over: English date, Hebrew date, day of week, holidays on this day or in this week, combinations (e.g., extra line when a holiday coincides with Shabbat). Day-type vocabulary from hebcal: weekday, Shabbat, Yom Tov, Yom-Tov-on-Shabbat, Rosh Chodesh, fasts, Chol Hamoed, Erev-X, etc.
- **Line time rule = condition + time (decided 2026-07-06):** an optional condition (season / date-range / day-type) plus a time that is either a fixed clock time or a zman ± offset with rounding, including earliest/latest-of-week aggregates. The rule grammar must express the founder's real examples:
  - Maariv = sundown − 15 min
  - Mincha1 = fixed 6:00 PM
  - Mincha2 = winters only, sunrise + 1 hour
  - (also typical: candle lighting = sunset − 18; "earliest sunset of the week − 20, rounded down to 5")
- **Free-form override lines** for specific dates/weeks, in English and/or Hebrew (RTL) — e.g., section xyz for week of 7/5/2026: "This week's coffee sponsored by John Doe."

## Data sources (decided 2026-07-06)

- **`@hebcal/core`** (local, free): all calendar facts/conditions; zmanim fallback.
- **myzmanim.com API** (founder has a free account): primary/authoritative zmanim per synagogue address; fetched via the connector primitive and **cached per address+date** (one API call per location-day, not per render).

## Output & export (decided 2026-07-06)

- One structural template: event-name/time columns; full-width merged rows for messages; per-synagogue branding (logo, colors, fonts) — no per-synagogue layout redesign.
- **Export profiles** = named render presets over that layout: e.g., "Lobby screen" (large high-resolution JPG), "WhatsApp" (small JPG), "Print" (PDF, margins, B&W). "Export" runs all enabled presets at once (`schedules.render` worker job → Playwright + sharp).
- Bilingual rendering (Hebrew RTL) throughout.

## Primitives used

Public pages (owner), external API connector + cache (owner), export/render pipeline (owner), settings+locks, i18n/RTL (owner), job queue.

## Acceptance (from docs/04)

A real synagogue configured end-to-end; generated week matches the founder's existing Sheets output; public page works with no login; all export presets render correctly.

## Future enhancements

Logged-in viewer features (subscriptions/reminders); additional layout templates if a second synagogue truly needs one; email/WhatsApp distribution of exports.

## 2026-07-12 — two help documents merged into one

Founder feedback: this module had a bespoke in-module setup guide
(`ui/help/page.tsx`, built 2026-07-07 as the very first module, before the
platform-wide walkthrough registry existed) AND the generic registry guide
(`help/guides.ts`, built 2026-07-10) — two different "Help" links with
different, drifting content. Folded the bespoke page's richer detail
(name-templating tokens, worked rule examples, publish/export/public-link
steps) into the one registry guide and deleted the duplicate page/route —
this module now matches every other module's one-help-document convention.

Also surfaced, not fixed: the location settings this module's zmanim depend
on (address/lat-long/timezone/myzmanim location id) are **seed-only** —
`org_modules.settings.location`, no UI to view or edit them anywhere. Same
gap as "who can add people to an org" — belongs to a future self-serve
org-settings design pass, not a quick patch here.

## 2026-07-12 — location settings now editable (superadmin console)

Closed the gap above. `org_modules.settings` for this module (`latitude`,
`longitude`, `timezone`, `israel`, `myzmanimLocationId` — flat fields, not
nested under a `location` key as the note above assumed) is now editable
from the superadmin Owner Console (`apps/web/app/(app)/console/page.tsx`,
`updateSynagogueSettings` action) whenever synagogue-schedules is enabled
for an org. No migration was needed: `org_modules`'s existing superadmin
RLS policy is `for all` and already covers the `settings` column — the
same write path `toggleModule` already used for `enabled`. **Deliberately
superadmin-only, not org-admin self-serve**, matching the founder's
explicit 2026-07-12 decision that module-level configuration (like module
enablement itself) stays a platform-owner action — org self-management
(docs/03 "Control hierarchy" level 2) only covers membership/module-role
grants, not settings. **Module 3 has no other known remaining gaps** short
of the parked myzmanim live-auth item and the explicitly-future items
(subscriptions/reminders, extra layout templates, distribution) already
listed above. e2e coverage added to the existing console test.
