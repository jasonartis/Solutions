# Zmanim cache and globally-shared API batches

**Status: DESIGNED, NOT BUILT (2026-09-23).** The connector bugs this work
uncovered ARE fixed and shipped — see the module spec's 2026-09-23 entry — but
nothing below exists yet. Founder decisions are recorded in §1 and are not to be
re-litigated.

## 0. Why this exists

The synagogue module calls myzmanim once per date, per page render — **7 serial
calls for a cold week view**, paid, with no persistence beyond a per-process
`Map` that dies with each serverless instance. The member page, the public page
and the export job each pay it separately.

myzmanim returns **one large JSON per date containing everything** (`Place` 20
fields, `Time` 42, `Zman` 89). The API's `getDay` accepts an `InputDate` in the
range **"Current date +/- 1 year"** (their documentation) and there is **no bulk
endpoint** — so a year costs 365 single calls per location. That combination is
the whole opportunity: even temporary API access can be converted into a year of
locally-held data.

## 1. Founder decisions (2026-09-23) — settled

1. **Store the RAW response**, not the parsed times. The `Place` and `Time`
   sections (Daf Yomi, Jewish date, Parsha, Holiday, Omer, the `Is*` flags,
   candle-lighting minutes, elevation) arrive in the same paid call and are
   currently **discarded**. Storing raw means a future feature costs no refetch.
2. **The cache is per LOCATION, shared across every org/module combination.**
   Not per org. This is already how `syn_zmanim_cache` was designed.
3. **Surface when a schedule is serving fallback data — but only to a user who
   can run the batch**, not to ordinary members.
4. **A rolling one-year horizon**, topped up daily, and the same daily batch must
   **fill any gap in the forward year**, not just the newest day. If the horizon
   job fails for three days, the fourth run catches all four up; if random days
   at 1 month and 2.5 months out are missing, the same run collects them.
5. **The year-out batch can be turned on and off from the UI** by the same level
   of user who can run the batches — for when we know the API is uncredentialed.
6. **Authority is split by blast radius** (§3), because these batches affect
   every org at once and are not a per-org/module surface.

## 2. What already exists, unused

`public.syn_zmanim_cache (location_key, date, source, times jsonb, fetched_at)`,
PK `(location_key, date, source)` — created in the module's FIRST migration
(`20260707030000:97-106`) with the comment *"one myzmanim call per (location,
date), shared across orgs"*, granted to `service_role` only, RLS enabled with
**zero policies**. **No TypeScript anywhere reads or writes it.** The mechanism
was anticipated on day one and never wired up.

Two consequences for the build:

- The column is named `times` and was meant for parsed times. Decision 1 makes it
  a whole response, so a forward migration renames it to `payload`. **The table
  has never held a row**, so there is nothing to migrate.
- The table is `service_role`-only, and the hard rule is that the service-role key
  lives in the worker. **So the web app cannot read it as it stands.** Add a
  `security definer` read function rather than granting the table to
  `authenticated` — it keeps the table locked exactly as its comment promises and
  matches the definer pattern already used for the email surface.

`source` is part of the PK, so myzmanim and hebcal results can coexist per date
without collision. Keep that.

## 3. Authority — the part that is NOT per org

A location comes from `org_modules.settings.myzmanimLocationId` (per org), while
the cache has **no `org_id`**. So the batch's work list is derived from every org
at once, and any UI over it is inherently cross-tenant. Two concrete failures if
that is handed to a module-level `maker`:

- **Shul A's maker flips "year-out prefetch: OFF."** Shul B's schedules quietly
  stop being prefetched; nobody at Shul B can see why or turn it back on. One
  client disabled infrastructure for another.
- **Shul A's maker clicks "backfill the full year."** 365 paid calls on the
  platform's card, triggered by a client user, with no quota tracking anywhere.
  Clicking it four times costs four times as much and looks identical.

**Therefore (founder decision 6):**

| Surface | Who | Why |
|---|---|---|
| On/off switch, horizon, per-run budget, full-year backfill, cross-location status | **Superadmin, Owner Console** (`/console/...`, `if (!profile?.is_superadmin) notFound()`) | blast radius is every org |
| "Fetch this date range for MY location", bounded (≤ 31 days) and rate-limited | **`maker`**, in the module | a maker must fix their own board before Shabbos; it is **purely additive** — it can only fill cache, never disable or subtract, and filling a location helps every org on it |
| Fallback/degraded badge | **`maker` and above** | founder decision 3 |

The asymmetry is the point: the maker-level action cannot take anything away
from another tenant.

## 4. The daily job

All three of founder decision 4's cases collapse into one query:

```
window  = [today, today + 365]         -- the API's own documented cap
missing = generate_series(window) LEFT JOIN syn_zmanim_cache
          USING (location_key, date) WHERE source = 'myzmanim' IS NULL
fetch missing NEAREST-DATE-FIRST, up to a per-run budget
```

Horizon advance is one missing day; a three-day outage leaves four; random holes
are just more rows. **Nearest-first matters** — a hole next week is needed long
before a hole in eleven months. The per-run budget bounds cost and prevents a
stampede; the first fill legitimately needs ~365, so that is the explicit
superadmin backfill, not the daily tick.

Locations to sweep = the distinct `myzmanimLocationId` across all orgs with the
module enabled. Registered like the other pg-boss cron jobs in
`apps/worker/src/index.ts`.

## 5. THE TRAP: never cache a failure

**This is the one that would hurt.** The API returns **HTTP 200** with `ErrMsg`
set and a full schema skeleton whose values are the `0001-01-01` sentinel. A
naive fill run today would write **365 poisoned rows per location**, and the
read-through would then serve them forever without ever calling the API again.
The failure is silent in both directions: pages render, and the cache looks full.

So a row is written **only if** the response has no `ErrMsg` **and** carries real
(non-sentinel) times. The captured error stub makes an excellent negative
fixture — it is a real response, not an invented one.

Related and already live before any of this: the hebcal fallback has **no
`candle-lighting` at all**, though it is in the rule vocabulary — so any line
using it renders nothing while myzmanim is down. That is what founder decision 3
is for.

## 6. Where the on/off switch lives — OPEN

There is **no platform-global settings store**: settings exist only on `orgs`,
`org_modules` and `user_private`. Founder's steer is a superadmin-level settings
area, possibly general enough to hold future globally-shared API batches rather
than being zmanim-specific.

Recommendation, splitting the cheap half from the speculative half:

- **Build** a small generic superadmin-only key/value store (namespaced keys such
  as `zmanim.prefetch.enabled`). A key/value table is not a speculative
  abstraction — it is one table, and a second global switch later costs a row
  rather than a migration.
- **Do not build** a general "batched API framework". `job_requests` + pg-boss
  already exist and are the batching mechanism; a second one would be
  speculation (CLAUDE.md's standing rule).

Per docs/03 #27, the new table must `revoke` before it `grant`s.

## 7. Prerequisite

**The myzmanim account is not authorized.** The connector's own bugs are fixed
(module spec, 2026-09-23) and the request shape is now proven correct against
myzmanim's published demo credential, but our key is still refused. Nothing can
be prefetched until that is resolved — though the whole mechanism can be built
and tested against an empty cache, and will fill on the first tick once the key
works. Re-check with `pnpm exec tsx scripts/verify-myzmanim-request-shape.mts`.
