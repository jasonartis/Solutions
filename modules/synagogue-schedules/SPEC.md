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
- **PARKED 2026-07-07 — myzmanim credentials rejected (resume when founder gets new/verified credentials).** Full context for pickup:
  - Connector is DONE and integrated everywhere (`src/myzmanim.ts` → `buildWeek()` used by worker render, schedule view, public page). hebcal fallback active and correct meanwhile.
  - Request format PROVEN correct 3 ways (GET querystring works; doc-exact POST + `Accept: application/json` works; both parse fine). Error is `ErrMsg: NotAuthorizedSeeApiDashboardForDetails` = account-side. Docs: core.myzmanim.com/site/common/apidocumentation.
  - Credentials live in `.env.deploy`: `MYZMANIM_USER=0017599341` + `MYZMANIM_KEY` (80 chars). Note: an editor stale-buffer save merged the two lines once (fixed); re-verify both lines exist before debugging.
  - Founder to check: (a) does the Google Sheet's `MyZmanim → Get Zmanim` still work (if yes → IP/origin restriction in their dashboard); (b) API dashboard key status/restrictions; (c) key value vs Script Properties.
  - When creds work: run `pnpm exec tsx apps/worker/scripts/test-myzmanim.ts` (compares live API vs the founder's December dump — expects 7/7). Then add `MYZMANIM_USER`/`MYZMANIM_KEY` to Vercel env (project `prj_reUQNNvf0XcjS6YcRGEYRXBC8XYM`) and redeploy — zero code changes needed.
  - Debug helpers: `apps/worker/scripts/debug-myzmanim{,2,3}.ts`.
- **⚠ 2026-09-23 — THE 2026-07-07 ENTRY ABOVE IS HALF WRONG, AND THE WRONG HALF
  WOULD HAVE COST A DAY.** Its conclusion ("account-side") is correct and still
  correct. But its supporting claim — *"Request format PROVEN correct 3 ways (GET
  querystring works; doc-exact POST … both parse fine)"* — is **false**, and so
  is the promise on the pickup line that *"zero code changes needed"* once the
  key works. Two real bugs were found and fixed today; **restoring the
  subscription alone would have produced visibly wrong schedules.**
  1. **CREDENTIALS WERE BEING SENT WHERE THE API IGNORES THEM.** The connector
     sent `user`/`key` as GET **query parameters**. The documentation is explicit
     — *"Credentials are not accepted via URL path or query parameters"* — so
     they arrived BLANK and the API answered
     `NotAuthorizedSeeApiDashboardForDetails`, which reads exactly like a dead
     subscription. **"Both parse fine" measured the wrong thing:** a clean JSON
     response proves the request was well-formed, NOT that the credentials were
     read. The distinguishing oracle is myzmanim's own published demo
     credentials (pre-filled on their public demo form), which return
     **`DoNotUseDemoCredentials` over POST form-urlencoded** but the generic
     **`NotAuthorized…` over GET query params** — same key, same account, two
     different errors, so the difference is the SHAPE. Fixed to
     `POST application/x-www-form-urlencoded`, which is what the founder's
     original Apps Script did and what their demo form posts. (The 2026-07-07
     note that "form-POST trips the WCF backend" is true only of a JSON *body*,
     which still 401s with a WCF stack trace — not of form-urlencoded.)
     Re-runnable: **`pnpm exec tsx scripts/verify-myzmanim-request-shape.mts`**,
     which needs no subscription of ours.
  2. **THE MISSING-VALUE SENTINEL FILTER NEVER MATCHED.** The parser skipped
     `'0001-01-01T00:00:00Z'`; the API sends it **without the trailing `Z`**. So
     every absent time became a valid **year-1 `Date`** and flowed into the
     schedule as real. Measured against a live response: the old filter kept
     **81 of 89 fields as year-1 dates**, the new one keeps 0. Worse than the
     stray times: `buildWeek` only falls back to hebcal when the parsed map is
     EMPTY, so a sentinel-filled response **suppressed the fallback entirely**.
     Masked today only because `ErrMsg` throws first — it would have fired on the
     first successful call. Now filtered by YEAR, robust to either spelling, with
     6 unit tests (`src/myzmanim.test.ts`) built from the real field names.
  **Account status is unchanged and still the blocker:** with the shape proved
  correct, our key is still refused. Dashboard: https://www.myzmanim.com/apidemo.aspx.
  Endpoint `api.myzmanim.com/engine1.json.aspx` is NOT deprecated (verified
  live); `core.myzmanim.com` is the docs portal, not a new API host.
  **Also captured while probing:** the error stub is a full schema skeleton, so
  the complete field inventory is known without a subscription — `Place` 20
  fields, `Time` 42 (DafYomi, DateJewish, Parsha, Holiday, Omer, Is* flags),
  `Zman` 89. The connector currently keeps **only `Zman`** and discards `Place`
  and `Time`, which arrive in the same paid call.
- **Still open:** myzmanim **account** authorization (the connector itself is now
  correct — see above) · acceptance validation against the founder's real schedule
  + Sheets rules (waiting on materials) · line edit-in-place (currently
  delete+recreate) · Hebrew rendering polish on exports.
