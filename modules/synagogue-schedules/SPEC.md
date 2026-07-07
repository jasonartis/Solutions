# Module: Synagogue Schedules (key: `synagogue-schedules`)

The authoritative specification lives at [docs/modules/module-3-synagogue-schedules.md](../../docs/modules/module-3-synagogue-schedules.md) — all client decisions are recorded there as dated entries.

## Build-time notes (implementation decisions layered on the spec)

- **2026-07-07:** Data model started before the founder's sample schedule arrives; the rule grammar implements the spec's confirmed examples (Maariv = sundown − 15; Mincha1 = fixed 6:00 PM; Mincha2 = winters only, sunrise + 1 hr) plus offsets/rounding/week-aggregates. The acceptance fixture (a real week matching the founder's current Sheets output) is added as soon as the sample is provided.
- Calendar facts come from `@hebcal/core` locally (no API); zmanim come from myzmanim via the connector with a per-(address, date) cache table, with hebcal's zmanim as fallback.
- **2026-07-07 (built):** evaluator + generator (15 unit tests) · schedule view (`/o/<slug>/m/synagogue-schedules`) · maker setup UI (`…/setup`: types/sections/lines rule builder, publish weeks, weekly messages) · export pipeline (Export button → `job_requests` → worker renders every enabled profile via Playwright → `syn-exports` bucket, signed-URL downloads) · public viewer (`/s/<slug>`, security-definer functions, published weeks only). Zmanim currently hebcal fallback from org settings lat/long.
- **Still open:** myzmanim connector (waiting on founder's API key) · acceptance validation against the founder's real schedule + Sheets rules (waiting on materials) · line edit-in-place (currently delete+recreate) · Hebrew rendering polish on exports.
