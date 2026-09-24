# Zmanim cache and globally-shared API batches

**Status: HALF BUILT (2026-09-23/24). The SCHEMA IS ON PRODUCTION and
prod-verified; the two UIs are not built.** Founder decisions are recorded in §1 and are not to be re-litigated.

| Piece | State |
|---|---|
| Connector bugs that this work uncovered | **SHIPPED** (module spec, 2026-09-23) |
| Migration `20260923010000` — cache `payload`, `platform_settings`, `syn_zmanim_fetch_log`, `syn_zmanim_cached()` | **ON PRODUCTION 2026-09-24**, two adversarial reviews, prod-verified 33/33 |
| Read-through cache in `buildWeek` | **BUILT AND WIRED** to all three call sites (member page, public page, worker render), 12 unit tests + an end-to-end check |
| The sweep (`synagogue.zmanim-prefetch`) with gap-fill + 3-day breaker | **BUILT**, 24/24 — both an induced failure AND the real happy path |
| Owner Console screen (`/console/zmanim`) | **NOT BUILT** |
| Maker panel + degraded badge | **NOT BUILT** |
| Production cache populated | **367 days, 2026-09-23 .. 2027-09-24**, for `US11210` (2026-09-24) |
| `migrate:prod` + prod verification | **DONE 2026-09-24** — `prod-verify-zmanim-schema.mts` **33/33** on prod, `prod-verify-migration.ts` **0 failures** |

The sweep is registered but **seeded OFF** on production, and stays off until a
paid plan exists (§7). **It does not need to run for a year**: production already
holds 367 days of real data, copied from the dev fill on 2026-09-24, so every
schedule renders from cache with **no myzmanim credentials on production at
all**. The credentials are deliberately NOT in Vercel.

**FOUNDER'S READING OF THE TRIAL LICENCE (2026-09-24), recorded because it is a
judgement call and not a fact:** the clause is *"the API may not be used in a
production enviroment"*, and the API was used from the DEVELOPMENT environment —
only the resulting rows were copied to production. Zmanim for a (location, date)
are a fixed astronomical fact, so a copied row is the same answer the API would
give again. `scripts/zmanim-backfill.mts` implements exactly that split, and
production never holds a credential. A paid plan is intended before a real
client (§7).

**The two scripts that tell you the truth about all of this**, neither of which
needs a working subscription:

| script | answers |
|---|---|
| `pnpm exec tsx scripts/verify-myzmanim-request-shape.mts` | is our REQUEST right, and is the ACCOUNT alive? Separates two causes of one error string. **5/5 since 2026-09-24.** |
| `pnpm exec tsx scripts/verify-zmanim-prefetch.mts` | **24/24.** Both paths: an INDUCED failure writes nothing, and a real fetch stores whole payloads (89 `Zman` fields + `Place` + `Time`) and advances to the next gaps on a second run. LOCAL ONLY — it mutates the switch and the log, restoring both in a `finally`. |
| `pnpm exec tsx scripts/prod-verify-zmanim-schema.mts` | the tables, grants, RLS policies, the seeded row and both functions, on PROD (33/33). `prod-verify-migration.ts` is function-only and would pass this migration vacuously. |

## 0. Why this exists

The synagogue module calls myzmanim once per date, per page render — **7 serial
calls for a cold week view**, paid, with no persistence beyond a per-process
`Map` that dies with each serverless instance. The member page, the public page
and the export job each pay it separately.

myzmanim returns **one large JSON per date containing everything** (`Place` 20
fields, `Time` 42, `Zman` 89). The API's `getDay` accepts an `InputDate` in the
range **"Current date +/- 1 year"** (their documentation) and there is **no bulk
endpoint** — so a year costs 365 single calls per location. That combination is
the whole opportunity for LATENCY and RESILIENCE. **It is not a cost saving** —
billing is per LOCATION per month, not per call (§7), so a location we look up
at all costs the same whether we call once or ten thousand times. And note the
"convert temporary access into a year of data" framing this doc started with
is exactly what a TRIAL licence forbids: see §7 before acting on it.

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
7. **The sweep AUTO-PAUSES after 3 days without a successful call**, and that
   number is a **superadmin UI input** alongside horizon and budget. Measured in
   DAYS rather than in consecutive failures: the sweep makes many calls per run,
   so "3 failures" could trip within one bad minute, while "no success since
   <date>" is the condition that actually means the API is gone. Implemented as
   `now() - last_success_at > N days`, which also survives the worker restarting.
   The switch a human flips and the switch the breaker flips are **the same
   switch**, so the console always shows one honest state — with a reason line
   (*"auto-paused after 3 days without a successful call, 2026-09-24"*).
8. **The maker's preset must know what is already cached.** If the week is
   already complete, say so and do not offer to re-fetch it; if it is partial,
   the button names exactly what it would do (*"Fetch 2 missing days"*). Never
   present a button that would spend money re-fetching data we already hold.
9. **Count the calls.** No quota tracking exists anywhere today, so a
   month-to-date call counter (successes and failures both — a refused call is
   still a call) goes on the console from the start. Cheap now, impossible to
   backfill later.

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

```sql
-- `today - 1` on purpose: `date` here is a LOCAL CIVIL date, but the database's
-- current_date is UTC, so after ~19:00 in America/New_York the window would skip
-- today entirely and every page render of "today" would pay a live API call.
with window as (
  select generate_series(current_date - 1, current_date + 365, interval '1 day')::date as d
)
select w.d
from window w
left join public.syn_zmanim_cache c
       on c.location_key = $1
      and c.date = w.d
      and c.source = 'myzmanim'   -- IN THE JOIN, NOT THE WHERE
where c.date is null
order by w.d                      -- nearest-date-first
limit $2                          -- the per-run budget
```

**`source` belongs in the JOIN condition, not the WHERE** (adversarial review,
2026-09-23). In the `WHERE` it turns the anti-join inside out: rows covered only
by hebcal stop being NULL-extended, so they vanish from "missing" and would never
be fetched from myzmanim.

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

## 5a. One append-only log answers three questions at once

Decisions 7 and 9 both need facts that `syn_zmanim_cache` cannot supply, because
that table records only what SUCCEEDED. A failed call leaves no trace, so neither
"has anything worked in 3 days?" nor "what did this cost?" is answerable from it.

One small append-only table — `(location_key, date, ok, err_msg, fetched_at)`,
one row per API call — answers all three:

| question | query |
|---|---|
| circuit breaker (decision 7) | `max(fetched_at) where ok **and origin = 'sweep'**` |
| call counter (decision 9) | `count(*) this month`, ok and not-ok, **grouped by origin** |
| what is wrong right now | latest row `where not ok` → its `err_msg` |

**`origin` is load-bearing, and leaving it out would have silently voided
decision 7** (adversarial review, 2026-09-23). A maker's manual "fetch my
location" succeeds and writes `ok = true`, which resets a naive
`max(fetched_at) where ok` — so the breaker would never trip while the sweep was
dead, which is precisely the situation it exists to catch. Demonstrated on the
live schema with one sweep success 5 days old, one sweep failure, and one maker
success just now:

| query | answer |
|---|---|
| `max(fetched_at) where ok` | **0 seconds** — "healthy" |
| `... and origin = 'sweep'` | **5 days** — breaker trips |

Same rows, opposite conclusions. `origin` is therefore `not null` with a CHECK
(`sweep` / `maker` / `backfill`), so a row that cannot say where it came from is
impossible to write. It also makes the counter answer the question §3 actually
worries about — *who* spent the money.

That last one is what puts `NotAuthorizedSeeApiDashboardForDetails` on the
console in words, instead of leaving a superadmin to guess why coverage is 0.
Volume is ~365 rows per location per year; prune with the existing retention
pattern if it ever matters.

## 5b. A note for whoever rank-maps synagogue-schedules

`view-as-coverage.test.ts` enumerates a module's real tables from `pg_catalog`
by the prefix it reads off that module's own view-as declaration, and **skips a
module that has no declaration**. synagogue-schedules has none yet (it is one of
the three modules CLAUDE.md records as not rank-mapped), which is the only
reason adding `syn_zmanim_fetch_log` did not trip the ratchet.

**It will trip the moment that module is rank-mapped.** Both `syn_zmanim_cache`
and `syn_zmanim_fetch_log` belong in `excluded`: neither carries `org_id`, both
are platform-wide operational data rather than anything a position can "see", and
the log is superadmin-only. Recorded here so it reads as an expected two-line
edit rather than a mystery failure.

## 5c. THE UI SHAPE — agreed with the founder 2026-09-23, not yet built

Recorded here because it existed only in conversation, which is the state most
likely to be lost at a handoff. §3 settles WHO; this settles WHAT THEY SEE.

### The Owner Console screen (`/console/zmanim`, superadmin)

The question this page exists to answer is *"is the next year covered, and if
not, where are the holes?"*

```
Zmanim prefetch                                    [ Daily prefetch: ●ON  ]
─────────────────────────────────────────────────────────────────────────
API health   ✕ NOT AUTHORIZED — last success: never
             ErrMsg: NotAuthorizedSeeApiDashboardForDetails
             Request shape verified OK · check the myzmanim dashboard
             Every schedule is serving hebcal fallback (no candle-lighting).

Horizon [365] days · budget [40] calls/run · auto-pause after [3] days
Calls this month: 412  (sweep 380 · maker 28 · backfill 4)
Last sweep 04:40, 0 written, 7 failed

LOCATION    ORGS                  COVERAGE            FIRST GAP    ACTIONS
─────────────────────────────────────────────────────────────────────────
US11210     Pozna, Demo Shul      0 / 366   ▱▱▱▱▱▱▱▱  today        [Fill gaps] [Backfill year]
IL-Jeru…    Demo Synagogue      181 / 366   ▰▰▰▰▱▱▱▱  2027-03-22   [Fill gaps] [Backfill year]
                                                      ↑ 12 months →
                                            [ Run sweep for all locations now ]
```

- **The coverage strip earns its place.** Founder decision 4's scenario — *"it
  failed to collect 1 month out and 2.5 months out on random days"* — is
  invisible as a number (`363/366` reads as fine) and obvious as two gaps in a
  bar. One segment per week; the title attribute names the dates.
- **Horizon, budget and pause-after-days are INPUTS**, not constants (founder,
  2026-09-23). They live in the `zmanim.prefetch` settings row, so changing them
  needs no migration. Write them through `platform_setting_merge()`.
- **The three counters are split by `origin`**, which is the only way to answer
  the question §3 actually worries about: who spent the money.
- **`Backfill year` states its cost before it runs** — *"This will make up to 366
  API calls for US11210"* — and disables itself while a backfill for that
  location is already queued.
- **API health is read from `syn_zmanim_fetch_log`**, latest `not ok` row, so the
  vendor's own error string appears verbatim rather than being paraphrased.

### The maker panel (in the module, `maker` and above)

Makers think in *the week I am publishing*, not in years. This sits beside the
existing Export panel on `/o/<slug>/m/synagogue-schedules`.

```
Times source                                        ⚠ Backup source in use
─────────────────────────────────────────────────────────────────────────
This week (Sep 21–27) is using hebcal, not myzmanim.
Candle-lighting is unavailable from the backup source.

              [ Fetch this week ]  [ Fetch next 4 weeks ]
```

- **Healthy state is a quiet one-liner** — *"Times from myzmanim, cached
  2026-09-23"* — and the warning simply does not render. Ordinary members see
  neither (founder decision 3).
- **Presets, not a date-range picker** (founder, 2026-09-23): they bound the cost
  naturally and match how makers think.
- **Founder decision 8 is a UI rule, not just a backend one.** If the week is
  already complete, say so and do not offer to re-fetch; if it is partial, the
  button must name exactly what it would do — *"Fetch 2 missing days"*. Never
  render a button that would spend money re-fetching data we already hold.
- Both buttons go through `job_requests` → worker, exactly like the Export
  button, so the panel shows *Queued… → Updated* and re-renders. A maker's
  action can only ADD cache rows for their own location.

### The walkthrough this is designed to produce

1. The key is fixed; `verify-myzmanim-request-shape.mts` goes 5/5.
2. `/console/zmanim` — API health flips to green.
3. **Backfill year** on US11210: ~366 calls, the strip fills.
4. The daily sweep takes over — one new day at the horizon, plus any holes.
5. A maker opens their schedule: warning gone, and the page makes **zero** API
   calls because everything is served from cache.

## 6. Where the on/off switch lives — DECIDED AND BUILT (2026-09-23)

**`public.platform_settings` exists** (migration `20260923010000`), seeded with
one `zmanim.prefetch` row holding `enabled`, `horizonDays`, `budgetPerRun` and
`pauseAfterDays`. Written through `platform_setting_merge()`, which merges in a
single statement so the console and the circuit breaker cannot clobber each
other. Read booleans with `->>`, never a `::boolean` cast.

The reasoning is kept below because it is the part that generalises to the next
global switch — which should cost a ROW in this table, not a migration.

Before it was built, the context was: there is **no platform-global settings
store** — settings exist only on `orgs`, `org_modules` and `user_private`. The
founder's steer was a superadmin-level settings area, possibly general enough to
hold future globally-shared API batches rather than being zmanim-specific.

Recommendation as given, splitting the cheap half from the speculative half:

- **Build** a small generic superadmin-only key/value store (namespaced keys such
  as `zmanim.prefetch.enabled`). A key/value table is not a speculative
  abstraction — it is one table, and a second global switch later costs a row
  rather than a migration.
- **Do not build** a general "batched API framework". `job_requests` + pg-boss
  already exist and are the batching mechanism; a second one would be
  speculation (CLAUDE.md's standing rule).

Per docs/03 #27, the new table must `revoke` before it `grant`s.

## 7. Prerequisite

**⚠ RESOLVED, BUT THE NEW KEY IS A TRIAL AND TRIALS FORBID PRODUCTION USE.**

The founder supplied working credentials on **2026-09-24** (user `0018345559`).
`verify-myzmanim-request-shape.mts` is **5/5**, and the acceptance script went
**0/7 → 7/7** against his own printed sheet. Everything works.

But the dashboard says, verbatim:

> Account status: **Trial** (as of 9/24/2026) · Trial period ends: **10/24/2026**
> Note: Trial period is granted for evaluation purposes only. **During this
> period the API may not be used in a production enviroment.**

**This bears directly on the whole point of the cache.** The design's own pitch
in §0 is that *"even temporary API access can be converted into a year of
locally-held data"* — and doing that on a trial key, for production schedules, is
precisely what that sentence forbids. So:

- **Do NOT enable the sweep or run a backfill against production while the
  account is on trial**, and do not put the trial key in Vercel. Local
  development and testing are evaluation use and are fine — that is what the
  trial is for.
- A paid plan removes the restriction. **Starter is $15/month and includes 10
  locations**; extras are $1/location/month. Production uses ONE location
  (`US11210`, shared by both synagogue orgs).
- **Worth re-reading their Terms of Service even on a paid plan**, since the
  "bank a year then stop paying" strategy is the thing this restriction exists to
  discourage, and the docs are silent on storage/redistribution.

**THE PRICING MODEL CHANGES THE COST ARGUMENT, and it is worth being honest about
this.** Billing is **per LOCATION per month, not per call** — "if you lookup
zmanim for 13 locations during October you will be charged 15 + 3 = $18". So
caching does **not** reduce the bill for a location we look up anyway: one call
and ten thousand calls cost the same. What the cache actually buys is **latency
and resilience** — one database query instead of 7 serial paid HTTP calls per
render, and correct schedules when the API is unreachable or the subscription
lapses, which is exactly the failure the module just spent two months in. Those
are good reasons. "It saves money" is not, and should not be repeated.

**The end-to-end acceptance step already exists**, and is better than anything
written from scratch: `apps/worker/scripts/test-myzmanim.ts` holds **seven real
values from the founder's own December sheet** (2025-12-12, US11210) and checks
them against a live call. It imports `fetchMyzmanimDay`, so it inherited the
request-shape fix automatically. **It has a shelf life:** its fixture date falls
outside the API's rolling "current date +/- 1 year" window on **2026-12-12**,
after which it will fail for a reason that has nothing to do with the connector.
Move the fixture forward, or re-dump against a current date, before then.

**⚠ A SECOND PREREQUISITE NOBODY WOULD THINK TO CHECK: THE WORKER DOES NOT RUN
ON PRODUCTION.** The sweep is a pg-boss cron job registered in
`apps/worker/src/index.ts`, and production has no continuously-running worker —
`pnpm worker:prod` is still the stopgap, which is the same reason docs/17's
retention prunes have never enforced anything on prod. **So even with a working
key AND `migrate:prod` applied, the nightly sweep will not fire on production
until the worker runs there.** The cache would stay empty and every render would
keep paying live API calls, with no error anywhere to explain it — a feature that
is structurally perfect and functionally dead, which is precisely the failure
docs/17 exists to catch. The Owner Console's "Run sweep now" button is the
mitigation in the meantime: it goes through `job_requests`, which the prod worker
does drain when it is run by hand.

**FOUNDER DECISION 2026-09-24: KEEP THE MANUAL STOPGAP, do not stand up the VPS
for this.** Same trigger as the paused go-live items — real cost for a problem
that only bites with a real client. It is the right call here specifically
because **this feature does not need a 24/7 worker**: one 366-call backfill, then
roughly one call per location per day, so running `pnpm worker:prod` occasionally
is genuinely adequate. The cases that WILL force a VPS are speed dating (its
orchestrator advances rounds every 10 seconds, so a live event on prod cannot run
unattended) and enforcing the retention windows — not this.

**HOLD `migrate:prod` UNTIL THE CONSOLE EXISTS.** The migration is safe and CI
is green, but on its own it creates a global switch with no way to turn it on
except hand-written SQL, and a sweep that is seeded OFF. Deploying the screen and
the schema together is what makes the feature operable; there is no benefit to
landing the schema early, and docs/03 #28 means the migration cannot be amended
once pushed anyway.
