# Module: Synagogue Schedules (key: `synagogue-schedules`)

The authoritative specification lives at [docs/modules/module-3-synagogue-schedules.md](../../docs/modules/module-3-synagogue-schedules.md) — all client decisions are recorded there as dated entries.

## Build-time notes (implementation decisions layered on the spec)

- **2026-07-07:** Data model started before the founder's sample schedule arrives; the rule grammar implements the spec's confirmed examples (Maariv = sundown − 15; Mincha1 = fixed 6:00 PM; Mincha2 = winters only, sunrise + 1 hr) plus offsets/rounding/week-aggregates. The acceptance fixture (a real week matching the founder's current Sheets output) is added as soon as the sample is provided.
- Calendar facts come from `@hebcal/core` locally (no API); zmanim come from myzmanim via the connector with a per-(address, date) cache table, with hebcal's zmanim as fallback.
- **2026-07-07 (built):** evaluator + generator (15 unit tests) · schedule view (`/o/<slug>/m/synagogue-schedules`) · maker setup UI (`…/setup`: types/sections/lines rule builder, publish weeks, weekly messages) · export pipeline (Export button → `job_requests` → worker renders every enabled profile via Playwright → `syn-exports` bucket, signed-URL downloads) · public viewer (`/s/<slug>`, security-definer functions, published weeks only). Zmanim currently hebcal fallback from org settings lat/long.
- **2026-07-07 — founder's real sample analyzed** (weekday sheet, Parshas Matos-Masei 5786). Confirms the shape and demands five grammar/render extensions before acceptance:
  1. **Specific weekday conditions** — "Shachris Sunday–Friday 6:10 / Monday–Friday 6:50": conditions need `daysOfWeek` (0–6 ranges), not just day *types*.
  2. **Day-anchored zmanim** — "Mincha & Maariv – Plag (8 minutes before **Sunday's** Plag)": a zman taken from a *specific weekday's* value, held for the whole week. New aggregate form alongside earliest/latest-of-week.
  3. **Grouped per-day rendering** — "Mincha Gedolah Sun–Mon 1:38 / Tue–Fri 1:39": collapse consecutive days sharing a time into ranges instead of listing all seven.
  4. **Civil ("Legal") holiday condition** — "Shachris (Sunday & Legal Holidays)": needs a US-legal-holiday calendar source in conditions.
  5. **Title templating from calendar facts** — the sheet title carries parsha + Mevorchim + Hebrew year ("זמני ימי חול פרשת מטות-מסעי - מברכים תשפ"ו"); hebcal provides parsha/mevorchim, so schedule-type names need placeholder support (e.g. `{parsha}`, `{mevorchim?}`).
  Also noted: lines are numbered minyanim per section; "Shkia*" carries a footnote qualifier (definition nuance to confirm with the rules sheet).
- **2026-07-07 — full source materials received** (Shabbos template formulas, myzmanim data dump + Apps Script, section list, layout spec — preserved in `client-materials/synagogue/NOTES.md`, git-ignored). Engine extensions required for acceptance, in build order:
  1. **Open zman vocabulary**: zman references become strings mapped to myzmanim field names (~90: MinchaGra, Night50fix, Candles, NightShabbos, PlagGra…); hebcal fallback maps a subset. myzmanim API shape known (`getDay` POST, zip-based locationid); key pending from founder.
  2. **Time-spec extensions**: min/max clamp vs fixed time; day-anchored zman (Friday's Candles, Sunday's Plag); reference another line's time ± offset.
  3. **Condition extensions**: specific weekdays (Sun–Fri vs Mon–Fri); holiday flags incl. Chanukah; US legal holidays; per-week manual toggles; conditional text output ("Will resume next week") instead of a time.
  4. **Title templating** from hebcal facts: parsha, Hebrew year (gematria), Mevorchim, Chazak, Chanukah, Rosh Chodesh, Shira, Arbah Parshiyos, Hagodol, Chol Hamoed, Chazon, Nachamu, Shuva.
  5. **Molad block + kiddush levana windows** (hebcal Molad, chalakim text).
  6. **Export styling per object kind** (brand colors, alternating event rows, per-column language/alignment) — template work, not engine.
- **Still open:** myzmanim connector (waiting on founder's API key) · acceptance validation against the founder's real schedule + Sheets rules (waiting on materials) · line edit-in-place (currently delete+recreate) · Hebrew rendering polish on exports.
