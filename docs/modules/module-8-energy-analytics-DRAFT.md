# Module 8 (proposed): Energy Analytics

> **STATUS: DRAFT / NOT SCOPED — do not build.** Captured from the founder's
> 2026-07-16 proposal. By the founder's own framing this one "needs planning
> even more than the others" — this document records what was asked and what
> was verified by a quick look at the referenced codebases, but a real
> file-level investigation of the legacy app is still needed before this can
> be scoped into a build plan. Nothing here is a decision.

## Problem & context (as described)

Port a slice of an existing internal C# energy-monitoring platform (NEAT,
built for the founder's day job at Artis Energy — the same prior art
referenced in docs/06) into this platform as a new module, starting with a
small number of analysis views rather than a full port. NEAT displays usage
data and runs analyses; some pages read from its own database, others call
out to separate analysis servers.

## Corrected facts (verified 2026-07-16, quick read-only check — not a full audit)

The founder asked to be corrected if a codebase assumption was wrong. One was:

- **`NEAT Project\NEAT\NEAT`** — confirmed **C#**. A large legacy .NET
  solution: an ASP.NET web app (`NEAT.Web`), a business-logic/DAL layer
  (`NEAT.BusinessLogic`, `NEAT.DAL`, `NEAT.DataAccess`), many nightly batch
  processes (demand, capacity tags, WattTime, precooling logic, billing,
  anomaly monitoring), and Windows Services for real-time notifications.
  This is a mature, sprawling production system — the "simplify/port a
  small slice" framing is the right instinct, not an underestimate.
- **`artispy Project`** — **NOT C#; this is Python** (Flask apps, Jupyter
  notebooks, plain `.py` modules). The two specifically named analyses exist
  exactly where described:
  - `artispy Project/volatility_profile/core/volatility_profile_library.py`
    (+ a `_consts.py` alongside it)
  - `artispy Project/cluster_and_pattern_analysis/core/
    cluster_and_pattern_analysis_library.py`
  This matters for the porting strategy: Python analysis code is far easier
  to either (a) call from a small Python service the Next.js app talks to,
  or (b) port the math directly into TypeScript, than anything involving
  the C# side would be. Worth deciding early which of those two paths this
  takes — it changes the shape of the module considerably.

**Not yet done** (deliberately, out of scope for a document-only pass): reading
NEAT.Web's actual page/chart implementations to know exactly what "Load
Duration Curve"'s three charts are and which two to port, or how weather data
is currently sourced/joined (a `NOAAWeatherServiceClient` console project
exists in NEAT, suggesting NOAA is the current weather source — unconfirmed).
That file-level read is real investigation work for the first step of an
actual planning session, not something to guess at here.

## Requested scope (first slice)

Three specific views, organized under a sidebar/hamburger nav "like NEAT"
(a genuinely new UI pattern for this platform — every existing module uses a
flat page + a "Manage" link; nothing has a multi-item collapsible nav today):

- **Trend Analysis → Volatility Profile**
- **Trend Analysis → Cluster & Pattern**
- **Historical Energy Profile → Load Duration Curve** — only the top two of
  (apparently) three charts on that page; the third is explicitly out.

Explicitly left open for later, same nav: more tabs pulled from the same
`artispy` analysis files as they're identified.

## Roles (as described)

- **Module Admin**, **Analyst**, **Client**.
- Unlike NEAT's UI (which shows a customer-selector to everyone), a
  **Client** here sees only their own data — no selector.
- **Analyst/Admin** see a customer selector and can view any client's data.

This maps cleanly onto a pattern the platform already has, rather than
needing a new tenancy model: nail-salon's manager/cashier/worker/customer
ladder within **one org** is structurally the same shape (staff who operate
across the org's data vs. a customer scoped to their own row). The likely
fit is: **one org** (e.g. "Artis Energy," since these clients are literally
Artis's own energy customers being serviced by Artis staff — this reads as
an internal tool, not a per-client engagement in the usual module sense),
with `client` as a location-scoped module role and `analyst`/`admin` as
org-wide roles — **but confirm this reading before building**; if these
"clients" are meant to be genuinely separate organizations rather than one
shared client base, the tenancy shape is different and needs its own design
pass (closer to nail-salon's org→location model, which already exists as
precedent for exactly this scenario).

## Data model (as described)

- **Client location info**: Location Name, Address, City, State, Zip,
  Timezone. The founder explicitly asked for this to become **general
  user/org settings shared across modules**, not module-eight-specific.
  **This is a real, concrete extraction candidate** (docs/00 principle #1:
  extract when a second module needs the same thing) — `sal_locations`
  (nail salon) already has name/address/timezone, and
  synagogue-schedules' `org_modules.settings` already carries
  latitude/longitude/timezone. This would be the **third** module wanting
  a location shape, which is exactly the threshold this platform's own
  convention treats as "now extract it," not "keep duplicating." Worth
  designing as a shared `packages/platform` primitive when this module is
  actually built, rather than a fourth bespoke copy.
- **Usage data upload**: 15-minute interval time series, e.g.:
  ```
  Time              kW
  1/1/2023 1:00     1,324.80
  1/1/2023 1:15     1,267.20
  1/1/2023 1:30     1,382.40
  1/1/2023 1:45     1,267.20
  ```
  Uploaded by the client (or higher tier). **No existing module does
  structured CSV/tabular ingestion** — classroom/exams upload opaque files
  to storage, but nothing today parses a CSV into rows. This is a genuinely
  new primitive to design (validation, expected-format messaging to the
  user, how malformed rows are handled, unit/format normalization for
  numbers like `1,324.80`).
- **Weather data upload**: also client-uploaded; exact shape not yet
  specified — needs to be pinned down against what
  `volatility_profile_library.py` / `cluster_and_pattern_analysis_library.py`
  actually expect as input (real investigation needed).
- **Export**: expected to reuse the platform's existing authorship-first
  export primitive (already built into every module) — likely with the same
  wrinkle nail-salon's cashier hit: an analyst/admin can *see* every
  client's data to do their job, but that visibility shouldn't
  automatically mean they can bulk-export another client's raw usage data.
  Worth deciding explicitly, following the nail-salon precedent, rather than
  defaulting export scope to "whatever you can see."

## Computation (as described, sources confirmed to exist)

- **Volatility profile**: `artispy Project/volatility_profile/core/
  volatility_profile_library.py`
- **Cluster & pattern**: `artispy Project/cluster_and_pattern_analysis/core/
  cluster_and_pattern_analysis_library.py`

Both are Python. Whether this module ports the math to TypeScript or calls
a small Python analysis service is an open, load-bearing decision — it
affects hosting (a new service to deploy/maintain vs. none), and should be
made after actually reading these two files, not guessed at now.

## Open questions (need real investigation + the founder's answers)

1. **Tenancy shape**: one shared "Artis Energy" org with client/analyst/admin
   roles inside it, or genuinely separate client organizations? (See Roles
   above — this is the load-bearing architecture call.)
2. **Porting strategy for the Python analysis code**: direct TS port of the
   math, or a small Python service the Next.js app calls? Each has real
   hosting/maintenance implications this platform hasn't taken on before
   (the worker is Node/pg-boss; there's no Python runtime anywhere in the
   stack today).
3. **Load Duration Curve's three charts**: which two are "the top two," and
   what does the third (excluded) one show? Needs an actual read of the
   NEAT.Web page.
4. **Weather data source and shape**: NEAT has a `NOAAWeatherServiceClient`
   console project, suggesting NOAA — is that the intended source here too,
   or does the client always upload their own weather file?
5. **CSV upload primitive**: validation rules, error messaging, and whether
   this becomes a reusable platform primitive (structured tabular upload)
   given this appears to be the first module that needs one.
6. **Location settings as a shared primitive**: confirm the founder wants
   this actually extracted into `packages/platform` now (three modules
   would then want it) rather than a fourth bespoke copy.
7. **Simplifications**: the founder already flagged that some ported pages
   "may need to be simplified" — this needs a concrete list, page by page,
   once the actual NEAT.Web implementations are read. Nothing to guess at
   here.

## Suggested first step of the real planning session

Before writing a module spec: read `NEAT.Web`'s actual Volatility
Profile / Cluster & Pattern / Load Duration Curve page implementations
(controllers + views) and the two named Python analysis files in full, to
ground the spec in what the code actually does rather than the founder's
description of it from memory. That read is exactly the kind of research
this platform already delegates well to an Explore agent — worth doing as
the opening move of the dedicated session, not folded into this doc.
