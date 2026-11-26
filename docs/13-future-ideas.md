# Future ideas & enhancements

The parking lot for ideas worth building *someday* — captured so they survive
sessions, models, and memory. It holds two kinds of entries: **cross-cutting
platform ideas** (features/behaviors that span modules) and **future module
ideas** (whole new modules not yet committed to the build plan). Per-module
enhancements to *existing* modules stay in that module's own spec.

**Rules for this list:** every entry is dated and attributed; an idea here is
NOT a commitment (extract-don't-speculate still governs). When a cross-cutting
idea gets built, move its entry to the module spec / CLAUDE.md state log with
the build date. When a **future module idea** graduates to committed work, it
gets a real `docs/modules/module-N-*.md` spec and a slot/ordering decision in
`docs/04-build-plan.md` — this list is only its holding pen.

---

## Interactive guided tours (in-app spotlight walkthroughs)

*Founder, 2026-07-10 — inspired by the walkthrough pattern in his Artis
Energy Intelligence product (screenshot reviewed: a dimmed overlay
spotlights one UI control, an arrow connects it to a floating explanation —
"These options allow you to connect/link the graphs via Cluster Quantity,
Date Range, Colors and/or Color scale." — with Previous / Next / Got It!
buttons stepping through the tour).*

**The idea:** evolve the role-level walkthroughs (docs/03 "User walkthroughs")
from written numbered guides into interactive in-app tours: each step
highlights the actual DOM element it talks about (spotlight cut-out over a
dimmed page), draws an arrow/callout with the step's text, and offers
Previous / Next / Got it!. The user learns by looking at the real control on
the real page, not a description of it.

**Why it fits this platform unusually well:** the written guides already
exist per module per role, are role-visibility-aware, and live in
`modules/<key>/help/guides.ts` — they are effectively tour scripts waiting
for a renderer. A tour step ≈ a guide step + a CSS selector + optional
arrow placement. The founder has shipped this pattern before (prior art in
docs/06), so the UX target is proven, not speculative.

**Sketch when the time comes:**
- Extend `HelpGuide` steps with optional `selector` / `placement` fields.
- A small client-side tour runner (dimmed overlay with a cut-out, positioned
  callout, Previous/Next/Got it!, progress dots); libraries exist
  (driver.js, Shepherd — license-check first, docs/02 rhythm) or ~200 lines
  hand-rolled to stay dependency-light.
- Entry points: a "Show me" button on each guide page, and optionally a
  first-visit auto-tour per module with a "don't show again" flag
  (per-user, per-module — a small `user_flags` table or profile jsonb).
- The same-commit update rule extends naturally: a UI change that moves an
  element updates the selector alongside the guide text.

**Status:** parked. Revisit after the founder's testing round settles the
written guides' content (tours should animate *stable* guides, not churning
ones).

---

## Fully responsive / adaptive layout across phones, tablets, and desktop

*Founder, 2026-07-10 — "decide what and how all of the platform should
display on phones and tablets. We want everything to eventually be dynamic
enough that the view adapts to the device and works well across devices."
Explicitly a future improvement, captured now so it isn't lost.*

**The idea:** every screen in the platform should render well on any device —
phone, tablet, desktop — with layouts that adapt rather than a desktop page
squeezed onto a small screen (or vice versa). The goal is one codebase whose
UI reflows by device, not separate mobile/desktop builds.

**Why it's not trivial (nuances worth documenting now):**

- **Two different design targets, not one.** Module 4 (visual messaging) was
  spec'd mobile-first and gesture-driven (swipe/tap/pinch). Most other
  modules (classroom gradebook, salon day-board, matchmaking admin, synagogue
  rule-builder, speed-dating organizer console) are **data-dense operator
  tools** that were built desktop-first with wide tables and multi-column
  forms. "Works on a phone" means something different for each: the canvas
  needs finger gestures; the gradebook needs a table that becomes readable
  cards or horizontally scrolls without breaking. There is no single
  breakpoint rule that serves both — each module needs a per-view decision.
- **Tables are the hard part.** Wide tables (gradebook, revenue summary, day
  board, approval queues) are the recurring pain: options are horizontal
  scroll within a bounded container, collapse-to-cards below a breakpoint, or
  column priority (hide non-essential columns on narrow screens). Pick a
  *platform-standard* pattern so every module solves it the same way instead
  of ad hoc — a shared `<ResponsiveTable>` primitive is the likely extraction.
- **Touch vs. pointer affordances.** Hover-only controls (the press-and-hold
  X-ray, hover tooltips, tight icon buttons) need touch equivalents and
  larger tap targets (44px min). Anything relying on `:hover` or precise
  mouse position needs a tap/long-press fallback.
- **Forms and modals.** Multi-column forms should stack; fixed-width modals
  should go full-screen on phones; date/time pickers should use native mobile
  inputs where possible.
- **Navigation shell.** The top nav / dashboard org cards / module sidebars
  need a mobile pattern (hamburger, bottom tab bar, or collapsible) — a
  platform-level shell decision, made once, inherited by every module.
- **Tailwind already gives us the tools** (`sm:`/`md:`/`lg:` breakpoints,
  container queries) — the work is disciplined *application* and a small set
  of shared responsive primitives, not new infrastructure. Cheapest if done
  as a consistent convention (add to docs/03) rather than retrofitted screen
  by screen later.
- **Testing dimension.** Playwright can emulate device viewports; a
  responsive pass should add a few mobile-viewport e2e checks (or at least
  visual snapshots) so layouts don't silently regress — otherwise "works on
  mobile" rots the moment a desktop-focused change lands.
- **Sequencing.** Best tackled as its own milestone *after* the module set and
  conventions are stable (retrofitting churning UIs wastes the effort), and
  ideally folded into the docs/03 module checklist so every *new* module is
  born responsive and only the existing ones need a catch-up pass.

**Sketch when the time comes:**
- Audit every existing view, tag it phone / tablet / desktop-primary, and
  record the intended adaptive behavior per view.
- Extract shared responsive primitives (`ResponsiveTable`, a mobile nav
  shell, a full-screen-on-mobile modal wrapper).
- Add a "responsive behavior" line to the docs/03 new-module checklist.
- Add mobile-viewport e2e coverage to lock it in.

**Status:** parked (founder: "not for now"). A cross-cutting UI milestone, not
a per-module task; revisit once the modules and their conventions have settled
through the testing round.

---

# Future module ideas

Whole new modules floated for *someday*. Each stays here (not in
`docs/modules/`) until the founder commits it to the build plan.

## Personal health analytics module

*Founder, 2026-07-10 — "A health app with visualizations and charts on blood
work, tests, echos, hospital stays, doctor visits etc. over time, compared to
your peers, compared to yourself etc. Lots of data analytics and data
visualization. It will be beautiful and can save lives." Explicitly for the
future, not now.*

**The idea:** a personal (and family/caregiver) longitudinal health record
that turns scattered medical data — lab/blood-work results, imaging and echo
reports, vitals, hospital admissions, doctor visits, medications, procedures —
into beautiful, trend-first visualizations. The core value is *time and
comparison*: seeing a metric move over years against its reference range,
against your own baseline, and against a peer cohort — surfacing slow drifts
(e.g. a gradually declining kidney marker) that any single snapshot hides.
Founder's framing: beautiful, analytics-heavy, and potentially life-saving.

**Why this one is unusually heavy — nuances to weigh before committing:**

- **This is the most sensitive data the platform would ever hold (PHI).**
  It triggers a different legal/compliance tier than anything built so far:
  HIPAA (US), GDPR "special category" health data (EU), and likely a Business
  Associate Agreement with Supabase/hosting. Tenancy isolation stops being
  "existential" in the architectural sense and becomes existential in the
  legal/human sense. Realistically this gates feasibility: encryption at rest,
  full access-audit logging, breach protocol, data-residency, and a compliance
  review are prerequisites, not polish. **Decide the compliance posture before
  writing a line of schema** — it shapes everything.
- **Not medical advice — a liability line.** The app can *display* data and
  flag out-of-range values informationally, but must not diagnose or advise.
  Clear disclaimers, "consult your clinician," and careful language around any
  trend "alerts" (informational, non-diagnostic). Getting this wrong is a
  safety and legal problem.
- **"Compared to peers" is its own hard problem.** Two paths: (a) licensed
  reference-population data (age/sex-adjusted normals) — cleaner legally; or
  (b) aggregating platform users' own data into cohorts — powerful but demands
  explicit consent, rigorous de-identification, and minimum cohort sizes to
  prevent re-identification. Option (b) is a privacy minefield; option (a) is
  the safer start.
- **Ingestion is the real work, not the charts.** Manual entry is tedious and
  error-prone for clinical data. The value unlock is importing: standards-based
  feeds (FHIR / HL7 from EHRs and patient portals), Apple Health / Google Fit /
  wearables, and — most demanded — uploading documents and *parsing* them.
  Plan the connectors as the bulk of the effort.
- **Document interpretation is likely its own subsystem** *(founder,
  2026-07-10: "we may need something to interpret documents like bloodwork
  print-outs and x-ray reports to get the data into our database").* Patients
  mostly have PDFs, scans, and photos — a blood-work printout, a radiology /
  x-ray / echo report — not clean structured feeds. Turning those into
  database rows means: OCR for scans/photos, layout parsing across wildly
  varying per-lab/per-hospital formats, and extraction of the actual values
  (test name → LOINC, value, units, reference range, date) or, for narrative
  reports (x-ray/echo impressions), pulling structured findings out of prose.
  This is realistically an **LLM/vision-model-assisted extraction pipeline**
  with a human confirmation step (the patient verifies/corrects what was
  extracted before it's trusted — medical data errors can harm). It is a
  substantial capability in its own right, shared conceptually with the
  idea-capture module's "help me write it up" need (both are document/text
  understanding) — a candidate for a common **document-understanding / AI
  primitive** rather than module-specific code. Provenance stays attached:
  the original file is kept and every extracted value links back to it.
- **Clinical data modeling needs standards.** Adopt LOINC (lab test identity),
  units + reference ranges per test, SNOMED/ICD-10 (conditions/procedures) so
  that the same test from different labs reconciles (unit normalization,
  differing reference ranges) and interop/peer-comparison is even possible.
  Provenance matters: which lab, which date, verified vs. self-reported —
  wrong medical data can cause harm, so validation and source-tracking are
  first-class.
- **Test-name normalization via a canonical dictionary + "bring-your-own-LLM"
  mapping** *(founder, 2026-07-10).* The same analyte has many names
  ("Hemoglobin A1c" / "HbA1c" / "Glycated hemoglobin" / "A1c") — the single
  biggest obstacle to comparing one upload to the next. Founder's proposal:
  give the user a **prompt they run in their own LLM** alongside their
  bloodwork; the prompt maps each result to the platform's canonical test list
  and, for anything not found, emits it as a new tagged entry — output in a
  strict defined format the platform ingests. Over time the canonical list
  grows into a crowd-built synonym dictionary; every future upload either maps
  to an existing test (clean comparison) or extends the list. **Evaluation —
  worth considering, with four guardrails that make or break it:**
  1. **The growing list needs a curation gate, or it self-defeats.** Auto-
     adding every "unknown" as first-class canon fragments the data ("Vitamin
     D" vs "25-OH Vitamin D" vs "Vitamin D, 25-Hydroxy" as three tests) and
     destroys the comparison the feature exists for. New names must land as
     *candidates* — similarity-checked against existing entries, reconciled
     (auto-suggest a likely match for the user to confirm, or a curator/staff
     review) — not promoted to canon on sight.
  2. **Anchor the canonical list to LOINC**, not a purely home-grown list: the
     LLM maps free-text → LOINC code + friendly name + known synonyms;
     home-grown tags only for genuine gaps LOINC doesn't cover. Keeps the
     dictionary principled and interoperable instead of an ad-hoc pile, and
     de-dup becomes "same LOINC = same test."
  3. **Map more than the name.** The prompt's output format must be a strict,
     *versioned* schema carrying canonical-id-or-NEW, the reported name, value,
     unit, reference-range low/high, date, and a confidence flag — so ingest is
     deterministic and units normalize for comparison (name alone is
     insufficient; mg/dL vs mmol/L will silently corrupt trends).
  4. **Mandatory human-confirmation step.** The user is the extractor here and
     LLMs hallucinate; the platform shows the parsed/mapped result for the user
     to verify and correct before anything is stored. Low-confidence mappings
     surface for explicit resolution rather than silent guessing.
  **Why the approach is attractive:** it offloads the hard extraction+mapping
  to a capable model the user already has — a **zero-infra bootstrap** that
  sidesteps our no-GPU constraint (see the SLM analysis under the idea-capture
  module), and it's privacy-cleaner for us (the raw document goes to the
  *user's* LLM, not ours). UX friction (copy prompt → paste into external tool
  → paste result back) is the cost; the smoother long-term form is the
  integrated document-understanding pipeline above calling an LLM directly, with
  this prompt approach as the bootstrap and offline fallback. The canonical
  dictionary itself is a durable platform asset either way.
- **Roles beyond the usual ladder.** Patient (owns their data), caregiver /
  proxy (parent managing a child's or an elderly relative's record — a real,
  common case), and clinician (time-limited, consented, read-only shared
  access, e.g. an export bundle for an upcoming appointment). Granular,
  revocable, audited sharing is central, not an afterthought.
- **Visualization depth.** Trend lines with shaded reference-range bands,
  event annotations (hospital stay, medication change) overlaid on the
  timeline, multi-metric correlation, and personal-baseline vs. peer-percentile
  overlays. This is the "beautiful" the founder wants — and the one place a
  future charting/dataviz primitive would pay off across the platform (ties to
  the responsive-layout idea above: dense charts must also work on phones).
- **Export/authorship fit.** The platform's authorship-not-visibility export
  rule (docs/03) maps well: the patient exports everything they entered/uploaded
  plus their derived records — a natural "take your health data with you."

**Sketch when the time comes:**
- Start with a compliance/feasibility decision (can we legally hold PHI on this
  stack? BAA? what jurisdiction?). Everything else waits on that.
- MVP could be *single-user, manual + PDF-import of blood work only*, with
  self-vs-self trend charts and reference-range bands — deferring peers, EHR
  feeds, and sharing until the core proves valuable and the compliance base is
  solid.
- Likely forces a real charting/dataviz primitive and a document-parsing
  pipeline — both reusable platform assets.

**Status:** parked (founder: "not now, document for a future time"). The
compliance weight means this is probably the platform's most serious
undertaking — worth doing *because* it can save lives, but only on a
deliberately built legal/security foundation, never bolted on.

## Idea / thought-capture module (with optional AI assist)

*Founder, 2026-07-10 — "a to-do app? Something to keep track of these ideas…
product module ideas, product development todos or to-considers. Maybe not a
direct software-development app but a general app to get ideas out of your
head and stored and retrieved. Maybe an SLM to help you discuss it and help
you write it up for later? This one really needs to be thought about — see if
we can generalize it." Nice dogfooding angle: this very backlog (docs/13)
could be its first real use.*

**The idea:** a general-purpose capture tool for getting a thought out of your
head fast, storing it, and finding it again later — with an optional
conversational assistant that helps you talk an idea through and writes it up
into a clean, structured entry (exactly what's happening in this doc, by hand,
right now). Generalize beyond software: personal notes, to-dos,
"to-consider" items, project ideas — with tags/categories, search, and a
"promote this to real work" path.

**Nuances to think about before building:**

- **Generalize the core, specialize with templates.** The reusable core is
  capture → store → tag/categorize → search/retrieve → (optional) status
  (idea / considering / committed / done). "Software product ideas" is then
  just one *template/category* on top — matching how docs/13 already separates
  cross-cutting ideas, future modules, and per-module enhancements. Don't hard-
  wire it to software.
- **Capture friction is the whole game.** The value dies if it's slow to jot
  something down. Fast entry (one box, optional voice-to-text later), defer
  organizing until after — "get it out of your head" first, structure second.
- **Retrieval matters as much as capture.** Full-text search, tags, and
  filtering by status/date; otherwise it becomes a write-only graveyard.
- **The AI-assist piece is optional and additive — build the plain app
  first.** The capture/store/retrieve app is valuable with zero AI and is
  fully within the current stack. The "discuss it / write it up" assistant is
  a *layer* on top, added once the base proves useful. Treat it as an optional
  enhancement, not a dependency.
- **This would be the platform's first AI-inference integration** — a new
  connector primitive (like the myzmanim/hebcal API connectors, but for text
  generation) that other modules could later reuse (classroom feedback drafts,
  the medical module's document extraction, matchmaking summaries). Worth
  designing as a shared **AI/LLM connector primitive**, not module-local code.

### On the SLM question (founder asked directly: is an SLM enough? too much for this platform?)

Short answer: **an SLM is capability-sufficient for what you described, but
"self-hosting one" is more infrastructure than this platform has today — so
the right path is a hosted API, not running your own model.**

- **Capability:** "help me talk an idea through and write it up cleanly" is
  brainstorming + summarizing + restructuring text — a *modest* ask. A small
  language model (a few-billion-parameter class, or a small hosted model like a
  Haiku-tier) handles that well. You don't need a frontier model to tidy notes
  and ask clarifying questions. The quality gap between small and large models
  shows up in *deep critique/reasoning* about an idea — nice-to-have here, not
  essential. So: SLM = sufficient for the core assist.
- **Infrastructure is the real constraint.** The current stack (Supabase +
  Vercel + one small ~$5/mo worker VPS) has **no GPU**, and that VPS is far too
  small to run even a small model for interactive chat. So *self-hosting* an
  SLM is "too much" for the platform as it stands — it would mean a GPU host
  (much pricier) or a serverless-GPU provider.
- **The pragmatic answer:** call a **hosted model API** (Anthropic/OpenAI/etc.,
  or a cheap small-model endpoint). No new infra, pay-per-use, and it slots in
  as a connector the worker or a server action calls. Trade-offs to weigh:
  per-token cost, and — importantly for an idea-capture tool that might hold
  personal or sensitive thoughts — that text leaves our system to a third-party
  model provider (privacy + a data-processing-terms review; the same concern
  is *much* sharper for the medical module). A self-hosted SLM's one real
  advantage is keeping data in-house; if that ever becomes a hard requirement
  (e.g. for the health module), revisit self-hosting on a GPU host then.
- **Recommendation:** build the plain capture/retrieve app first (no AI,
  zero new infra); add the assistant as a hosted-API connector layer when
  wanted; only consider self-hosting an SLM if in-house data handling becomes
  a firm requirement.

**Status:** parked (founder: "really needs to be thought about"). Strong
dogfooding candidate and the cleanest on-ramp to a shared AI-connector
primitive — build the non-AI core first, layer AI via a hosted API second,
self-host only if privacy demands it.

---

## Superadmin config UI for the user model — and where the line goes

> **STATUS 2026-08-06: the READ-ONLY half — the highest-value row in the table
> below — is BUILT**, folded into `/console/view-as` rather than given its own
> page. Positions, ranks, each position's declared surface and the full pair grid
> with every note render in a collapsible panel at the foot of that screen. That
> placement is the point: the operator is there to bypass an edge, and the grid is
> what tells them which rule they are stepping over and why it was written. Zero
> queries — it is all manifest data. Everything about the WRITABLE rows below is
> unchanged and still refused; turning an edge on is deliberately not a switch,
> because the completeness check's whole value is that flipping one drags the
> decision through a diff, a reviewer and a test run.

*Founder question, 2026-08-02, immediately after slice 5 (view-as) was built:
"The config edges that we discussed that must be filled out and the module
position hierarchy — should we make a superuser UI for setting these configs?
Are there other things the superuser should have a config to set?" Asked for
consideration only; nothing built.*

**The organising principle (the reusable part of the answer):**

> **Anything that WIDENS reach belongs in code. Anything that only NARROWS it
> can be a runtime switch.**

This one line settles most versions of the question, and it is already the rule
docs/15 §8.1 point 5 arrived at independently for view-as edges ("per-org tuning
may only DISABLE manifest edges, never add them"). Recording it here because it
generalises well beyond view-as.

**Applying it to the three things slice 5 introduced:**

| Config | Verdict | Why |
|---|---|---|
| **Read-only view** of positions, ranks, the pair grid + notes, and each position's declared surface | **Yes — highest-value follow-on** | All of it is real, reviewed and tested, but buried in `packages/platform/src/view-as-modules.ts`. Surfacing it costs nothing and lets the decisions be audited without reading TypeScript. Build this first. |
| Turning a view-as edge **ON** | **No — not even for the superadmin** | The completeness check's value is not the switch, it's that flipping it drags the decision through a diff, a reviewer, a test run and (for anything novel) an adversarial review. A UI makes it a click with no record of reasoning. Mechanically it also breaks the guard: the ON pairs are mirrored in an IMMUTABLE SQL function the trigger trusts; make it a UI-writable table and the fail-closed property that caught the organizer→participant hole in review 1 is gone. |
| Turning a view-as edge **OFF** | **Yes, per-org** | Only narrows. A client who says "our professors do not look through student accounts" should be able to enforce that without a code change. |
| Editing **position ranks** | **No — the most dangerous of the three** | Ranks do not only drive view-as; they drive who may appoint and remove whom (the hierarchy guard). docs/15 §4.1 item 5 bans a tenant-writable rank table outright: `student = 5` inverts the ladder. Ranks stay a migration. |

**Other superadmin config candidates identified in the same conversation**
(none urgent, all genuinely open):
- **Whether view-as targets are notified.** §8.1 point 6 deliberately left this
  a per-module product decision; per-org is probably the right level.
- **View-as session length** — currently a hardcoded 30 minutes in
  `20260731010000`. Harmless to make configurable, low value.
- Nothing else looked like a real gap: the console already covers entitlements,
  `org_modules.settings`, and `profiles.settings.superadminDefaultAddActive`.

**Caution worth keeping:** every new superadmin switch is a new writable surface
that needs its own RLS thinking. The console being superadmin-only keeps the
blast radius small today, but it also means nobody else can self-serve — so
"add a config" is rarely as cheap as it looks.

---

## Generalising per-position visibility (a documented map, NOT generated RLS)

*Founder, 2026-08-02, on confirming that a classroom GA sees peer-review
comments but not peer marks: "If this type of flexibility can be generalized to
be made easier to flip on/off for all module parts, that is something to
consider."*

**What the flexibility actually is:** a per-position, per-table, sometimes
per-column read rule. Today those live as hand-written RLS policy SQL spread
across migrations, so answering "can a GA see peer grades?" means reading policy
bodies in three files. That is the real pain, and it is worth fixing.

**The tempting move, and why to resist it.** Slice 5's surface declaration is
already a declarative per-position table/column map, so the obvious next step is
to make it the source of truth and **generate** the RLS from it. Two reasons not
to:

1. **It inverts the failure direction.** Today a wrong declaration shows too
   *little* — annoying. If it generated RLS, a wrong declaration shows too
   *much*. That moves the tenancy boundary onto a code generator, in a platform
   whose first principle is that tenancy isolation is existential.
2. **A table×position grid cannot express the real policies.** `is_final AND
   visible`, `graded_by = auth.uid()`, `cls_submission_hidden`'s retention
   window, `sd_paired_with` — these are row predicates involving the caller. You
   would end up with a grid plus escape hatches, which is worse than either.

**The version worth building instead — proven, not speculative.** Keep RLS as
the authority; add a declaration that DOCUMENTS it and a test that PROVES the
documentation true. That is exactly the three-list model slice 5 shipped
(`personal` = viewer cannot read / `excluded` = viewer can, we decline /
`unreadableByPosition` = the position cannot read), each separately asserted
against the live database. It earned its keep immediately: the split caught a
real misclassification within a day of existing, and the non-emptiness control
caught a test that would have passed vacuously.

Extending that from "view-as surfaces" to "every position × every table in every
module" gives one screen answering who-sees-what, it cannot drift (the tests
fail), and nothing security-critical moves. It also feeds the read-only
superadmin page in the entry above — same data, one renderer.

**Status:** parked, founder-raised. Recommended shape is
documentation-plus-tests, explicitly NOT generated policies. Natural companion
to the superadmin read-only view — which is now BUILT (see the entry above), so
this is the remaining half.

### The concrete gap this entry should close — **CLOSED 2026-08-09**

> **STATUS: BOTH PIECES ARE BUILT.** `packages/db/src/rank-admission.test.ts`
> discovers every rank reader from `pg_proc.prosrc`, refuses to skip a comparison
> it cannot classify, computes who satisfies each rank test by asking the
> DATABASE, and snapshots the answer to **[rank-admission-map.md](rank-admission-map.md)** —
> which is simultaneously piece 2 (the failing test) and piece 1 (the readable
> "what does rank 2 mean in this module?" table). Proven against the motivating
> example: `cashier` remapped 1 → 2 in the live database fails the test, and the
> diff names `sal_earnings_ledger` on the `sal_can_manage_location` row. The
> original text is kept below because its reasoning is what produced the design.
>
> **THE AUDIT CORRECTED THE ANSWER THIS ENTRY RECORDED, in four ways** — the
> "one ladder, FOUR rules" line below is right as a count of *mechanism families*
> and wrong as a count of *code*, which matters because a fix aimed at four
> places would have missed four others:
>
> 1. **It is EIGHT functions, not four.** `module_caller_can_manage_seat`,
>    `module_caller_covers_rank`, `module_has_manager_grant`, `cls_can_manage`,
>    `sal_can_manage`, `sd_can_organize`, `module_roles_guard_last_director`,
>    `view_as_guard_session`.
> 2. **"RLS tier thresholds" is not one rule.** It is five functions carrying
>    **four independently hardcoded `2`s** plus the parameterized
>    `module_caller_covers_rank(min_rank)`. Guarding only the parameterized one —
>    the obvious target, since it is the generic — would have left
>    `cls_can_manage`, `sal_can_manage`, `sd_can_organize` and
>    `module_has_manager_grant` uncovered.
> 3. **The last-Director guard was missing from the list entirely,** and it is
>    the only reader of rank **4**. It also fails OPEN: remap `director` below 4
>    and "a module must keep at least one Director" silently stops firing for
>    everyone, with no error anywhere.
> 4. **The `= 3` peer arm was missing,** a third comparison shape beyond `>` and
>    `>= N`. Remapping any position TO exactly 3 silently grants peer-appointment
>    into a strictly-contained sub-scope. A threshold check would not have found
>    it, because it is an equality.
>
> Also corrected: this entry names `viewAsRankParity()` as one of the two checks
> that "might be mistaken for" the missing one. **`viewAsRankParity()` has no
> callers anywhere in the repo** — the TS↔SQL parity it describes is done by an
> inline loop in `rls.test.ts:1382`, which iterates `moduleRegistry` and so
> inherits the `MODULES`-env shrinkage hole `data-browser-coverage.test.ts`
> deliberately avoids. The new check does not use `moduleRegistry`.
>
> **Still open, deliberately, and now written down rather than assumed:** the map
> tracks only what RANK opens. Gates with non-rank arms — `sal_can_operate_location`
> also admitting the role NAME `cashier`, `module_caller_covers_rank`
> short-circuiting on `is_org_admin` — are out of scope on purpose, because they
> do not move when the ladder moves. The generated file says so in its own header
> so a reader cannot mistake a **nobody** cell for "nobody can get in".

_(Original entry, 2026-08-06/07, kept verbatim:)_

A founder question — *how many hierarchies are there, and are they unified?* —
produced a specific answer and one real hole.

**The answer: ONE rank table (`module_position_rank`), read by FOUR different
rules.** Appointment (strict `>`), view-as pair DOMAIN (strict `>`), RLS tier
thresholds (`rank >= N`), and nothing at all for log reads. Plus two things that
are NOT rank and must not be confused with it: view-as edges (hand-declared per
pair — this MUST stay separate, §8.1 point 11: rank is cheap to change, view-as
must never change silently), and name-based `has_module_role()` checks in
never-rank-mapped modules (`vm_can_moderate_org` is the live example).

**THE HOLE: tier thresholds are magic numbers scattered across per-module
wrappers, and NOTHING verifies that a rank remap did not silently change what a
tier wrapper admits.** Promote nail-salon `cashier` from rank 1 to 2 and it
silently gains the earnings ledger — the module's single most documented
asymmetry, the one its whole §8.1 point 9 review turned on. Today that case is
caught only **BY ACCIDENT**: manager and cashier becoming equal rank breaks
their view-as pair entry and fails typecheck. **Remap a position that has no
pair entries and nothing catches it at all.** Verified for salon and classroom
only — the other six modules are unchecked.

Note how this differs from the checks that already exist and might be mistaken
for it: the view-as completeness type and `viewAsRankParity()` prove the TS rank
table matches SQL's `module_position_rank` and that every rank-differential PAIR
is answered. Neither says anything about what a `rank >= N` wrapper ADMITS. The
guarantee is missing exactly where the consequence is a silent widening of read
access.

**Two pieces, in order:** (1) an audit producing one table of every rank use
across all eight modules — which wrapper, which threshold, which tables it
gates; (2) a test that fails when a rank remap changes what a tier wrapper
admits. Piece 1 is worth doing even if piece 2 is deferred, because right now
nobody can answer "what does rank 2 mean in this module?" without reading SQL.
Opus — it is RLS-adjacent reasoning even though it ships no policy.

---

## Superadmin "view as anything" console + a per-person data browser

> **STATUS 2026-08-06: BOTH HALVES ARE NOW BUILT.** The data browser shipped
> 2026-08-03 (`/console/data-browser`, superadmin-only, zero migrations); the
> **Owner Console view-as** shipped 2026-08-06 (`/console/view-as`, one migration,
> `20260806010000`), with all three founder-specified modes modelled as one axis
> and docs/13's own read-only pair-grid viewer folded in. Rules extracted to
> docs/03 **#19** and **#18**; the dated record is in docs/15's decisions log
> (2026-08-03 and 2026-08-06/07 entries) and the journal. **Three answers this
> entry gave were revised by the build and are corrected in docs/15's 2026-08-06/07
> entry, not here:** "unlogged" was a description of what shipped on 2026-08-06
> rather than the platform's answer — **the log was BUILT 2026-08-07/08
> (migration `20260807010000`), so every "unlogged" statement below this line is
> historical and none of it describes the live system**; the
> scope intersection needed an explicit AUTHORITY parameter, and naming it was not
> enough — it needed a token the check alone can mint; and the bypass turned out to
> be four things, not three. Everything below is kept as the reasoning that
> produced it.
>
> **Build order changed, founder 2026-08-03:** data browser first, Owner Console
> after. The reason is in the sizing note at the bottom of this entry, sharpened by
> reading the code: the console's edge bypass can only render positions that have a
> declared SURFACE, and at the time of writing that was classroom `student` and `ga`
> alone (since 2026-08-04, plus nail-salon `manager`/`cashier`/`worker`). The banned
> speed-dating `participant` pair it was meant to bypass has no surface, so the console
> renders it blank regardless. The data browser needs no surfaces and worked on all
> eight modules on day one — so it delivers first.
>
> **Two founder answers added 2026-08-03**, both resolving questions the original entry
> did not ask:
> - **Show every column, not a chosen list** — the tool exists to be complete, and an
>   allow-list would hide the new data it should surface. Paired with search, per-section
>   column hide/show, and collapse, since the answer can be large.
> - **Audit/history rows ARE included, under their own heading.** `view_as_sessions` and
>   `vm_moderation_log` name people, and "professor X viewed your account on Tuesday" is
>   genuinely part of what the platform holds about someone — so they are shown, but under
>   an "Activity about this person" heading rather than mixed in with their own data. The
>   founder asked whether this would expose staff activity to a GA or student; it does not,
>   and RLS is the reason rather than anything the browser does:
>   `view_as_sessions` is readable only by the actor and by org admins, `vm_moderation_log`
>   only at moderator tier, so a lower position simply gets nothing back. The one real
>   (pre-existing) consequence is that one org admin can see another's view-as history —
>   already true since slice 5, and the open scope question above is about exactly that.
> - **Walk-in salon customers stay out of scope.** Most `sal_customers` rows identify a
>   person by free-text name/phone/email with no account, and the browser keys on a user
>   account. Requiring accounts was considered and rejected as the wrong fix (it works
>   against how a salon actually operates); the clean fix, if ever needed, is letting a
>   salon LINK an existing walk-in record to an account when that person signs up.
>   Recorded as a known gap. Note this is narrower than it sounds — a review found that
>   customers who DO have an account were also missing their bills, for an unrelated
>   structural reason (a two-hop path), and that one was a bug and is fixed.
>
> **Small follow-ons the two adversarial reviews raised and the build did NOT act on**
> (recorded so they are not lost; none is a correctness or security problem):
> - The coverage test's **tier 2 has no non-triviality floor**, unlike tier 1's
>   `expect(rows.length).toBeGreaterThan(40)`. A *fully* broken tier-2 query is still
>   caught indirectly (every declared via-link would show as phantom), but a *partially*
>   broken one would under-report its triage list silently. Cheap to add.
> - **No e2e exercises a via-only section's happy path.** The two-hop chain is proved at
>   the data layer by `verify-data-browser.mts` probes [2] and [5], but the browser e2e
>   only asserts direct-column sections, so a `resolveViaIds` regression would be caught
>   by the manual probe script rather than by CI.
> - **`truncated` is a safe-direction false positive**: `rows.length >= limit` marks a
>   section truncated when exactly `limit` rows exist and there is no more. Over-cautions
>   rather than under-reports, which is the correct side of this feature's asymmetry, so
>   it was left alone deliberately.
>
> **Also settled 2026-08-03 (founder asked, answer verified against the live policies):**
> the view-as session log is NOT scope-based. `view_as_sessions_select_org_admin` is
> `is_org_admin(org_id)` — whole-org. Scope lives on module positions; org admin has no
> scope dimension. So a course-scoped professor who is *not* an org admin sees only
> sessions they started, while one who *is* an org admin sees every session in the org
> regardless of which course it concerned. Left as-is deliberately: narrowing it is a
> real RLS change with its own migration and review, and faking the narrowing in the UI
> would look like a boundary without being one. **Open question, parked here:** should
> org-admin log reading be scope-narrowed? The browser makes this data findable where
> before it was merely readable.

*Founder, 2026-08-02, deciding the superadmin question left open by slice 5.
Parked deliberately — NOT built. Sequenced after the slice-5 prod push so a
god-mode surface does not ride along in a deploy of already-reviewed work.*

**Decision taken:** option (b) — the platform superadmin gets a **separate**
surface that **bypasses every declared edge**, including pairs banned on purpose
(speed-dating participant). Kept out of the normal in-module tab strips so those
stay strictly by-the-rules. **Unlogged**, by founder decision. Lives in the Owner
Console.

Founder rule this sits under (2026-08-02): *org position does not enable view-as,
module position does* — the superadmin is not an org position at all (it is a
flag on `profiles`, not a seat in `org_members`), so it sits outside that rule
rather than contradicting it.

**What it can and cannot do — worth re-reading before building:**
- It bypasses the **edges**, not **RLS**. The renderer runs on the superadmin's
  own client, which is what stops this becoming a second unaudited read path.
  A superadmin passes `is_org_admin` everywhere, so nearly all module data is
  reachable — but `sd_notes` is author-only with no staff arm anywhere and stays
  invisible even here. Making it visible would need a service-role read path,
  which breaks the keystone; the Supabase dashboard exists for that.
- **Unlogged has one non-obvious consequence:** logging would have surfaced
  superadmin activity to ORG ADMINS, who can read their org's session log. Fine
  with a single owner-operator superadmin; revisit if there is ever a second
  superadmin or an external audit, since an unlogged god-mode read path is
  exactly what an auditor asks about.
- **Surfaces gate the content, and are separate from edges.** A position with no
  declared surface renders BLANK, because a surface is the content definition,
  not a permission. **Updated 2026-08-04:** five positions now have one — classroom
  `student`/`ga` plus nail-salon `manager`/`cashier`/`worker`. A classroom
  `professor` surface would still need writing, and speed-dating is blank until
  its per-module surface review (§8.1 point 9) happens.

**The companion idea — a per-person data browser ("C").** Founder: *"C sounds
valuable too and perhaps should go along with view-as, wherever view-as goes."*
Rather than rendering a declared surface, dump every row in the module that
references that person. Never blank, works before any surface review exists, and
answers "what do you hold about me?" directly. Crude and NOT faithful to "what
they see" — it is a different question and should be labelled as one in the UI so
the two are never confused.

**ANSWERED by the founder, 2026-08-02 — the five questions above, resolved:**

1. **Superadmin-only for now, but design it to expand to module positions.** And
   the key correction to my framing: a professor's data browser would **not
   bypass the surface allow-list — it is a different question entirely.** It
   shows *what the viewer already has the right to see* about that person,
   bounded by their own RLS, "like we said with speed dating, no notes." So the
   two tools answer two different questions and neither is a weaker version of
   the other:
   - **view-as** = *what does THIS PERSON see?* Curated by the surface
     declaration, deliberately narrower than the viewer's own reach (survey
     answers and reviewer identity are excluded on purpose).
   - **data browser** = *what do I hold about this person?* Everything the
     VIEWER may read, bounded by RLS and nothing else. A professor therefore
     WOULD see survey answers here — legitimately, because they can already read
     them. `sd_notes` stays invisible to everyone including a superadmin,
     because no staff arm exists anywhere.
   **Consequence that solves the blank-page problem:** the data browser needs no
   surface declarations, so it works for every module on day one and never
   renders blank. That inverts the earlier sequencing worry entirely.
   **UI requirement:** it must never be labelled "what they see". It is "what I
   can see about them". Presenting one as the other is the only way this
   combination becomes misleading.

2. **Build ONE query shape: rows that REFERENCE the person.** Founder flagged
   over-engineering risk explicitly, and this is the answer to it — "rows they
   can see" is what view-as already does, curated, so building both would be
   duplicating view-as badly. Two tools, two questions, no overlap. A later
   "combined view" is then just a UI convenience putting the two side by side,
   not a third mechanism.

3. **Honour the target grant's scope, but allow moving between scopes.** A scope
   picker rather than a fixed scope. Founder's stated use: *"I can ask a user to
   describe what they see and debug why something is working the way it is."*
   Debuggability is the primary requirement here, not least because this is a
   one-person team supporting the whole platform.

4. **Superadmin picks any org.** If the tool later expands beyond superadmin, it
   follows **view-as access** — so a professor could browse student and GA data
   in their own scope, and eventually toggle between "rows referencing them",
   "rows they can see", or a combined view.

5. Overlap with the existing per-hat data export: unresolved, but likely the
   same underlying query with a different renderer. Check `modules/*/ui/export.ts`
   before writing new query code.

**Superseded — the original open questions, kept for the reasoning:**

**OPEN QUESTIONS to settle before building** (asked 2026-08-02, unanswered):
1. **Is the data browser superadmin-only, or does it follow view-as edges?**
   The security fork. If a professor gets a data browser for a student it
   bypasses the surface allow-list, which is the mechanism keeping survey
   answers and reviewer identity off that surface. Strong recommendation:
   superadmin-only.
2. **"Everything about this person" = rows REFERENCING them, or rows they CAN
   SEE?** Different queries and different meanings; the first is a subject-access
   answer, the second is a support answer.
3. **Does the superadmin view honour the target grant's SCOPE?** Viewing a
   course-scoped professor: only their course, or the whole module? (Recommend
   honouring scope — the scope is part of what defines their view.)
4. **Cross-org:** does the org picker list every org on the platform, or only
   ones the superadmin is a member of? (RLS already permits any.)
5. Does the data browser overlap the existing per-hat data export (docs/03 "Data
   export")? Possibly the same query with a different renderer.

**Sizing:** the console view against the surfaces that exist is small (the renderer is
already generic — `renderSurface` in `apps/web/lib/view-as.ts` takes a surface
and a subject). Writing surfaces for the remaining modules is the substantial
part — **as of 2026-08-04 that is speed-dating only**, and its are the delicate ones
(interest marks, safety reports; a host deliberately cannot read what an organizer can).

## REAL VIEW-AS: SEE THE CLIENT'S ACTUAL SCREEN (founder decision, 2026-11-10 — BUILT for classroom, ON PROD 2026-11-15; see "AS BUILT" at the end)

**The ask.** Today "View as anything" (`/console/view-as`) shows the rows a position or named person can read, as labelled
tables (`SectionTable`), not the screen. The founder wants the REAL thing: to see exactly what a client's user sees, the way
they see it, for three reasons — (1) **diagnosis**: see when something is wrong for a client; (2) **demonstration**: show the
platform with real shapes of data; (3) **product ideas**: design better enhancements from the client's view and data.
**Hard requirement: the SAME components that render the screen for the user must render it here, so there is no drift** — no
second, view-as-only layout (a cheaper "make the tables look like the page" copy was offered and declined).

**Tier: Opus to design and build, with a Fable adversarial review (a novel mechanism; tenancy isolation is existential). It
was deliberately NOT started in the Sonnet session that recorded it.**

**What it collides with, so the design session must decide it on purpose:** (a) the 2026-08-02 ruling "viewing, not
impersonating" (docs/15 §8.1: read-only, cannot act on anyone's behalf, no row may name anyone but the true actor). Real
view-as stays read-only, but the pages would execute with the target's identity, so the ruling needs a dated
re-statement, not silence. (b) `docs/15` point that mode 2 is read-only "until a dated decision" says otherwise.

**Draft questions for that session (a starting list, NOT decisions):**
1. *How to run a page as the target.* Every module page queries through the caller's RLS client. Options: a read-only
   database transaction with `set local role authenticated` + the target's `request.jwt.claims` (the pattern the prod
   verifiers already use, kept per request); a server-minted short-lived token for the target (needs signing material we may
   not hold on hosted Supabase); or per-surface definers (the current approach, which is what the tables are). The first
   needs a client factory the pages can be handed instead of `createClient()`.
2. *Writes must be impossible, not merely hidden:* read-only transaction, server actions refused while viewing, and
   `recordActivity`, login capture, "last read", feedback "staff_read_at" and every other side-effect write suppressed — a
   superadmin looking must not change what the client's own screen or the engagement numbers say.
3. *Things nobody may read stay unreadable even here* (`neverReadable` in the data-browser declarations, e.g. `sd_notes`;
   speed-dating safety reports; the 2026-08-02 rule that a host cannot read what an organizer can). The real view must not be
   a back door past a rule the tables view already honours.
4. *Logging:* reuse `view_as_sessions` / `superadmin_lookup_log`; a real view is at least as loggable as the tables view.
5. *Visible banner on every screen* saying whose screen it is and that it is read-only, so a screenshot cannot be mistaken.
6. *Who may be viewed:* any member of any org (the console's current reach) — confirm, and whether the person is told
   (docs/13 "whether view-as targets are notified" is already an open founder item).
7. *Scope of v1:* pick one module's screens first, prove the no-drift property with a test that renders the same page both
   ways, then widen.

### THE DESIGN (Opus, 2026-11-12) — answers to the draft questions, written before any code

**Founder decisions for this design (2026-11-12, in the session that wrote it):** the web server MAY hold the key that
signs a user token ("allow it"), so a page can truly run as the person; **classroom** is the first module. Everything
else below is a design choice made here, each with its reason, for the Fable review to attack.

**In one paragraph.** The superadmin starts a "real view" of one person in one org's classroom from the console. While
it is open, every classroom page that person can open renders **through the very same route and components**, but its
database client carries a short-lived token **for that person**, signed on the server, marked `view_as`, and never sent
to the browser. The database treats every request with that mark as a **read-only transaction** (it refuses every write,
including side-effect writes inside functions), the proxy refuses every non-GET request while a view is open, file
storage refuses writes for that mark, and every viewed page is logged. A banner on every screen says whose screen it
is, that it is read-only, and offers Stop.

**Q1 — How a page runs as the target. Chosen: a server-minted token.** `lib/supabase/server.ts`'s `createClient()` is
the one place every page, layout and helper gets its database client, so it is the single switch. When the proxy has
marked the request as an in-scope real view (below), `createClient()` returns a supabase-js client whose
`Authorization` is a fresh HS256 JWT for the target: `sub` = target, `role` = authenticated, `aud` = authenticated,
`exp` at most 5 minutes away (never past the session's own expiry), plus `view_as: {session, actor}`. It is signed with
`SUPABASE_JWT_SECRET`. Prod uses legacy HS256 keys (anon key is a JWT, read 2026-11-12), and PostgREST accepts the
shared secret. That client reads and writes no cookies, so the superadmin's own session is untouched.
*Measured locally 2026-11-12:* such a token reads Charlie's class through PostgREST, and GoTrue's `/user` returns
Charlie's own user object. So `auth.getUser()` in the app shell and in pages returns the real target, which is what
makes "no drift" achievable rather than approximated.
*Rejected:* (a) `set local role` + claims inside a server-held SQL transaction: pages talk HTTP to PostgREST, not SQL,
so every page would need a second data path, which IS drift; (b) per-surface definers: that is today's tables view;
(c) the service-role key: forbidden (docs/03 #14).
*How a request becomes "in a real view":* starting a view sets an httpOnly cookie `sp_view_as=<session id>`. On every
request `proxy.ts` **first deletes any incoming `x-sp-view-as` header** (so a browser cannot forge one). Then, if the
cookie is present, it calls `view_as_real_check(session, path, log)` **as the superadmin's own session**: the database
confirms the session belongs to the caller, the caller is still superadmin, and the session is open and unexpired, and
it returns the target, org slug and module. Only if the path is inside `/o/<that org's slug>/m/classroom` does the proxy
set `x-sp-view-as` on the forwarded request. Anywhere else the superadmin is themselves, and the banner says the view
is paused. A missing or failed check means no header, which means the superadmin's own view: the failure direction is
"less", never "more".

**Q2 — Writes are impossible, not hidden. There are four independent layers, any one of them sufficient for its path:**
1. *Database (every PostgREST request, including POST RPC and GraphQL):* a PostgREST pre-request function
   (`pgrst.db_pre_request`, set on the `authenticator` role; prod has none today, read 2026-11-12) sets
   `transaction_read_only = on` whenever the JWT carries `view_as`. Postgres then refuses every INSERT/UPDATE/DELETE,
   including writes inside any SECURITY DEFINER function, for the rest of that request. A function cannot switch it
   back after the first query. *Measured locally:* with the mark, a POST RPC that updates returns `25006 cannot execute
   UPDATE in a read-only transaction`; without the mark, the same call gets past the update. This is the layer that
   catches SIDE-EFFECT writes (a "last read" stamp, an activity row, a lazily created record) without having to find
   them all first.
2. *File storage:* Supabase Storage is a separate service, and the hook above does not run there. So `storage.objects`
   gets RESTRICTIVE policies for INSERT/UPDATE/DELETE: `not public.is_view_as_request()`.
3. *The web app:* while the cookie is set, the proxy answers every non-GET/HEAD request with 403, except `POST
   /view-as/stop`. No server action and no route-handler write runs at all, including non-database side effects
   (emails, exports). `recordActivity` is only ever called from server actions (grepped 2026-11-12), so it never runs.
4. *Auth:* GoTrue accepts the token, so the token COULD change the person's password or email. The token therefore
   exists only inside the Next.js server process for one request: never in a cookie, a response header or the HTML.
   The view-as client's `auth` object allows `getUser` only, and every other auth method throws. Layer 3 already stops
   every code path that would call one, since they are all server actions.
A page that tries to write during render will therefore FAIL LOUDLY with an error page. It will never succeed and
never silently show stale data, and the no-drift test would catch it.

**Q3 — What stays unreadable.** The real view shows exactly the target's RLS reach, which is not automatically inside
the superadmin's. The rule, a dated restatement of docs/15 §8.1 point 1 for the SUPERADMIN (2026-11-12): *a real view
may show only what the superadmin could already read through the data browser.* It is enforced two ways:
- (a) A module is allowed only after a check that its per-person reach adds nothing beyond the data browser. Classroom
  passes: its data-browser `neverReadable` list is empty, and its view-as `personal` lists are empty (every
  student-readable row is also professor-readable in scope, docs/15 §8 2026-07-31).
- (b) Every table in ANY module's `neverReadable` list (today only `sd_notes`) gets a RESTRICTIVE policy `not
  public.is_view_as_request()`, so the strictest table stays dark even when a later module is allowed. A db test fails
  if a `neverReadable` table lacks it.

The module allowlist is hard-coded in the start function (classroom only); widening it is a migration plus that
module's own review. **Speed-dating and matchmaking end users stay banned** (§8.1 point 7): a real view would show
interest marks and match lists.

**Q4 — Logging.** Two new tables, readable by the superadmin only and append-only: `view_as_real_sessions` (actor,
target, org, module, created, expires = created + 30 min, ended) and `view_as_real_page_views` (session, path, at; one
row per non-prefetch page load inside scope). They do not reuse `view_as_sessions`: its rows are a (person, position,
scope) grant triple checked by a guard trigger against declared edges. A real view is of a PERSON in a module, not a
position, and forcing it into that shape would weaken the existing guard. Writes go only through definers that
re-check `is_superadmin()`. Foreign keys are `set null`, so the log outlives the people it names (the same reasoning as
`view_as_sessions`). The console lists recent real views.

**Q5 — Banner.** The `(app)` layout renders `ViewAsBanner` above `<main>` whenever the request is in a real view (or a
view is paused): "You are viewing **Charlie**'s screen in **Demo A**, read-only · ends 14:32 · Stop viewing". It is
amber, fixed at the top, carries `data-testid="view-as-banner"`, and sits outside `<main>`, so the drift test can compare
`<main>` exactly. Screenshots of a viewed screen always carry it.

**Q6 — Who may be viewed.** An ACTIVE member of the org, in an org with classroom ON. Never a superadmin (a real view
of a superadmin would carry superadmin reach) and never oneself. The person is NOT notified; that stays the open founder
item it already is (CLAUDE.md "whether view-as targets are notified"). The log exists either way (§8.1 point 6).

**Q7 — Scope of v1.** Classroom pages under `/o/<slug>/m/classroom/**`, plus the shared app shell (the header) on those
pages, which also renders as the person. **The no-drift test** (e2e):
1. Sign in as Charlie, open the classroom home and a homework page, and keep each page's `<main>` HTML.
2. Sign in as the superadmin, start a real view of Charlie, and open the same paths.
3. Assert the `<main>` HTML is identical, and that a write attempted while viewing is refused and changes nothing.

**Re-statement of the 2026-08-02 ruling ("viewing, not impersonating"; docs/15 §8.1 points 2–4), dated 2026-11-12.**
Real view-as executes pages AS the target. §8.1 point 3 ruled that out for the tables view because the queries would
have returned the caller's rows; with a target-signed token that reason no longer holds, so point 3's "NOT a
re-execution" does not apply to real view-as. Points 2 (read-only; no row may name anyone but the true actor) and 6
(logged) apply in full, enforced by the database rather than the UI. For the superadmin's real view only, point 4 (the
grant triple) is replaced by (person, org, module), because the real screen shows all of the person's classroom roles
together, exactly as they see it.

**Known limits, accepted for v1:**
- Client components that query the database from the browser would run as the superadmin, because the browser holds
  the superadmin's session. Classroom has none (grepped 2026-11-12); any module allowed later must be checked for them.
- Realtime is not used by classroom.
- The token secret on Vercel can sign as anyone. It lives only in server env (never `NEXT_PUBLIC_`), and without it the
  feature refuses to start rather than degrade.

### FABLE REVIEW (2026-11-12) — design, draft migration `20261116010000`, and the uncommitted code

**Reviewed on a confirmed Fable session** (`/model fable`; a fork of it died twice on the 5-hour limit, so the judgement
below is the main session's own, after reading `20261116010000_real_view_as.sql`, `lib/view-as-real.ts`, `proxy.ts`,
`lib/supabase/server.ts`, `app/view-as/stop/route.ts`, `console/view-as/real/actions.ts` and
`packages/db/src/real-view-as.test.ts`; local rolled-back probes). Full status of the other ten re-reviews:
[docs/history/fable-review-2026-11-12.md](history/fable-review-2026-11-12.md).

**Verdict: no ship-blocker. The four write layers are independent and each is real; the token cannot leave the server
by any path read here; Q3 holds for classroom (measured). Findings are hardening and record-keeping.**

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| 1 | — | **Q3(a) measured, holds.** The catalog lists 24 tables with a self-read arm (`auth.uid()`) and no `is_superadmin()` in any policy TEXT, six of them classroom (`cls_submissions`, `cls_grades`, `cls_review_comments`, `cls_review_assignments`, `cls_survey_answers`, `cls_exam_papers`). As the local superadmin, counts are identical to `postgres` (4/2/2/2/2/1) — the superadmin arm lives inside `cls_can_manage…`. | rolled-back probe | CONFIRMED |
| 2 | **LOW → make it a test** | Finding 1 was proven by MEASUREMENT, not by the db suite. `real-view-as.test.ts` asserts only the `neverReadable` policies (Q3 b). Add: for the allowed module, every `<module>_*` table's superadmin row count equals the owner count on the seed (non-vacuous: seed rows > 0). Widening to a module later must re-run it — the other 18 self-arm tables (`mm_*`, `sd_*`, `sal_*`, `vm_*`) are exactly where the next module will fail this. | catalog query above | OPEN (test gap) |
| 3 | **LOW (operational, record in docs/12)** | `alter role authenticator set pgrst.db_pre_request` makes EVERY API request depend on `view_as_pre_request()` existing and succeeding. A later migration that drops or renames it, or an `is_view_as_request()` that raises (e.g. a non-JSON `request.jwt.claims` set by a test — `::jsonb` would raise; PostgREST always sets valid JSON) takes the whole platform down, not just view-as. Never-do: drop/rename either function; prod verifier must assert `pg_db_role_setting` for `authenticator` AND call `view_as_pre_request()` as `anon` and `authenticated` with empty claims (control: returns, no error). | `:62-79` | OPEN (docs + verifier) |
| 4 | — | "A function cannot switch read-only back off" is Postgres's documented rule (`transaction_read_only` on→off only before the transaction's first snapshot; the pre-request call itself takes one). PostgREST runs `db_pre_request` inside the request transaction after the role switch, for RPC and GraphQL (`/graphql/v1` is an RPC) alike. GET/HEAD are already read-only in PostgREST by default; the hook's real work is POST RPC. | design "measured locally"; db test `:172-180` | CONFIRMED by rule + the suite's own control |
| 5 | — | Storage: three RESTRICTIVE policies, all three verbs, `to authenticated` — right, since the token's `role` is `authenticated`; service-role paths (worker) untouched. A bucket's permissive `to public` arms do not escape a restrictive `to authenticated` policy for that role. | `:84-93`; db test `:183-185` | CONFIRMED |
| 6 | — | Token: minted fresh per `createClient()` (`:121-124`), `exp = min(now+5m, session end)`, `persistSession:false`, `auth` proxied so only `getUser(token)`/`getSession()` work; `getUser` is GoTrue `GET /user`, a pure read. The signed `x-sp-view-as` header is deleted from every inbound request before anything else (`proxy.ts:29-30`, case-insensitive) and is forwarded only server-side. Cookie is httpOnly/lax/secure-in-prod (`actions.ts:24-30`) and holds only a session id. | code | CONFIRMED |
| 7 | **LOW** | `client.storage`, `client.functions` and `client.realtime` carry the same target token. Storage writes are blocked (5); classroom uses no realtime (design); **edge functions are not addressed** — none are deployed today (state it, and add "no `functions.invoke` under an allowed module" to the per-module allow check). | `view-as-real.ts:125-128` | OPEN (one sentence + a grep in the allow check) |
| 8 | **LOW (fail-closed, record it)** | The token is HS256 on the legacy shared secret. If the Supabase project is ever moved to the new asymmetric signing keys, PostgREST/GoTrue reject it and `createClient()` STILL returns the view client (no fallback to the superadmin's own reach), so every viewed page errors. That is the right direction; record it in docs/28 (vendor) and docs/12 so the symptom is not misdiagnosed. | `view-as-real.ts:96-113`; design Q1 | OPEN (docs) |
| 9 | INFO | The token carries no `email`/`session_id`/`iss`. Any policy or definer using `auth.jwt() ->> 'email'` / `auth.email()` sees NULL → the viewed page shows LESS than the person sees (drift in the safe direction). The no-drift e2e covers two pages; list every classroom route and render each both ways, or the next GET-time side effect (`25006` on render → error page by design) is found by the founder, not the suite. | design Q7 | OPEN (widen the e2e) |
| 10 | INFO | Anyone can set an `sp_view_as` cookie by hand: they 403 their OWN non-GET requests and trigger one `view_as_real_check` per request that returns no row and clears the cookie (`proxy.ts:61-91`). Self-inflicted, harmless. A real view's page log over-counts: an RSC navigation can issue more than one in-scope GET per screen (only `prefetch` is excluded). | code | no action |
| 11 | INFO | `view_as_real_check` runs per request as the superadmin's OWN session (no `view_as` claim), so its page-view INSERT is not read-only — correct; the design's layer 1 and the log do not fight. | `:231`, `proxy.ts:65` | CONFIRMED |

**What was NOT checked here:** the Next 16 `proxy.ts` matcher behaviour for route handlers under `/api` (assumed matched);
whether any classroom GET route handler has a non-database side effect (email/export) — grep before widening;
PostgREST's handling of a `Prefer: tx=…` header against a pre-request read-only mark (not used by the app); prod (the
migration is not on prod and must not go until the founder's go-ahead, with a per-migration verifier that includes
finding 3's two checks).

### AS BUILT (Opus, 2026-11-12 → 11-15) — classroom v1, commit `a1bdbac`; migration `20261116010000` ON PROD 2026-11-15

**Where it lives:** `lib/view-as-real.ts` (signed header, token, read-only client), `lib/supabase/server.ts` (the one
switch), `proxy.ts`, `app/view-as/start` and `app/view-as/stop` (route handlers), `components/view-as-banner.tsx` +
`view-as-guard.tsx`, `/console/view-as/real` (pick a person, recent views; also a Tools card on the console home).
Tests: `packages/db/src/real-view-as.test.ts` (10), `apps/web/e2e/real-view-as.spec.ts` (2: the no-drift tests),
`scripts/prod-verify-real-view-as.mts` (38 locally; prod "before" run: controls pass, and the migration's `ALTER ROLE
authenticator` was proven PERMITTED on hosted Supabase in a rolled-back transaction).

**Changed from the design while building (each found by a test or a review):**
- *Start is a plain form POST to a route handler, not a server action.* A server action's redirect renders the next page
  inside the same request, before the cookie exists, so the first "viewed" screen was the superadmin's own with no
  banner. The handler checks `Origin` (route handlers get no automatic cross-site check).
- *Banner/header across link clicks: a client guard, not the proxy.* The `(app)` layout is kept across client-side
  navigation, so after a click out of the module the header still named the person. The plan was to make the proxy
  refuse client navigations (forcing full loads), but **Next 16 strips its router headers and `_rsc` before the proxy
  runs** (`server/web/adapter.js`, measured — the 409 never fired). `ViewAsGuard` reloads the page in full when the
  path crosses the module boundary or the view's end time passes. Known residual: for a moment between the click and
  the reload the old banner shows over the new page. The page log counts prefetches too (they cannot be told apart).
- *The pre-request hook has NO exception handler.* Adding one (to "never raise") silently turned the gate OFF: a
  plpgsql EXCEPTION block is a subtransaction, and leaving it reverts the `set_config`. Caught by the db test.
  `is_view_as_request()` instead cannot raise (`pg_input_is_valid` before the JSON cast).
- *The database also keeps other modules dark* (SQL review): the token reads through the person's RLS, which reaches
  every module they use, so all 46 non-classroom module tables carry a RESTRICTIVE `<table>_no_view_as` (plus
  `sd_notes`). A db test fails for any later module table without it; allowing a module = dropping its policies in a
  migration after that module's own review.
- *Smaller:* the signed header must match the browser's own `sp_view_as` cookie; `auth.admin`/`auth.mfa` are blocked;
  the log sequence's default grants revoked; storage policies `to public`; policies use `(select
  is_view_as_request())` (evaluated once per query); a page path under `/o/` ending in `.png` no longer skips the proxy.
- *The no-drift comparison* masks two things that differ between two renders for the SAME person: signed-file tokens,
  and React's render-order counters on server-action hidden inputs (their values still compare). The viewer's page must
  be a full load like the person's, or the test compares React's client and server output instead of the screen.

**Fable review dispositions:** 2 (Q3 as a test) DONE — superadmin row count = owner count for every `cls_` table, non-
vacuous on the seed. 3 (hook dependency) DONE — docs/12 never-do item; the verifier asserts `pg_db_role_setting` and
calls the hook as anon/authenticated with empty and non-JSON claims. 7 (edge functions) RECORDED: none are deployed;
before allowing a module, grep its UI for `functions.invoke` (the token would reach an edge function as the person).
8 (asymmetric keys) RECORDED in docs/12: if the project ever moves off the legacy HS256 secret, viewed pages ERROR
(PostgREST rejects the token; no fallback to the superadmin's own reach) — fail-closed, the symptom is every viewed page
failing. 9 (no `email` in the token): classroom policies do not read `auth.email()`; a module that does would show LESS.
10/11: no action.

**Founder decisions, 2026-11-15:** (1) APPLIED — `migrate:prod` after a backup and a dry run listing only this file; prod verifier 4/29 → 38/0; the live API checked straight after (anon RPC 200, a demo sign-in and read 200). (2) The JWT secret was put on Vercel by Claude (production only, type "sensitive"): read from the Supabase Management API and proven to be the right one by verifying the anon key's signature with it, never printed or written to disk. It takes effect at the next production deploy. (3) **No notification and NO per-page log**, his words: "Telling them every time will be annoying. I will be checking in all the time to see if everything looks right... Informing them each time and even logging it each time is ridiculous - no." So the proxy calls `view_as_real_check` with `p_log = false` and the console's "Recent real views" list is gone. **What remains, and why:** one `view_as_real_sessions` row per Start. It is the on/off switch the database reads on every request (who is viewing whom, until when, stopped or not), not a log; nothing displays it. `view_as_real_page_views` stays in the schema, unused. This overrides docs/15 §8.1 point 6 for the superadmin's real view only (docs/15 point 12).

**Founder decision, 2026-11-23 — widen to the WHOLE account, every module.** Pick a person, see what they see when they
log in: every org they belong to, every module, matchmaking and speed dating included (docs/15 §8.1 point 12, the
"SUPERSEDED" note, has his words). This is his user-testing method. Not built yet; each module still needs the per-module
checks below. Known hard parts to design first: client components that query from the BROWSER (they would run as the
superadmin, not the person, which is drift), realtime (speed dating), and video (joining a JaaS room as the person must be
impossible, since others would see "them" arrive).
**Same day, second decision — private text shows as a placeholder, not blank and not readable.** Where the platform
decided nobody but the author reads something (today only `sd_notes`, the dater's private notes — the one
`neverReadable` table), the real view shows the row in its place with filler such as "‹private note · 212 characters›",
so he can see the feature is in use and working without reading it. It must be generalised (one mechanism, the same
page code for the person and the viewer, only the masked column differs), most likely in the database: the page reads
through one view/function that returns the text to the author and the placeholder to a view-as request.
**The mechanism must be adoptable by the future résumé builder's private "vault"** (module-9 spec: the second thing the
superadmin does not see) — design it as a general "private field" rule, not an `sd_notes` special case.
**Where the decision happens (founder, same day):** at the last possible stage, so everything above it is identical for
the person and the viewer. "Last stage" = the database (the function/policy that hands rows back), NOT the page
component: if a component chose, the real text would already have reached the server's page code, and one bug would
show it. Pages and components never branch on "am I being viewed".
**For the later STAFF version (org staff viewing a person, trimmed to the viewer's own area):** a whole page outside the
viewer's area renders a placeholder ("‹Math 101 · outside your area›"); a private field renders a placeholder; rows
outside the area are decided PER TABLE — a placeholder count where harmless, removed outright where the count itself
is the secret (speed-dating interest marks: "‹3 marks hidden›" would reveal them).
**Renames (agreed):** "See their real screen" → **"View as"**; the tables tool ("View as anything") → a name with
**"Readable table data"** (founder, 2026-11-23). The staff's in-module "View as" (tables) keeps its name until the
staff real-screen version replaces it.

### WHOLE-ACCOUNT VIEW AS — THE DESIGN (Opus, 2026-11-23; founder go-ahead to design; NOT BUILT, awaiting his OK)

**In one paragraph.** The superadmin picks a PERSON (not an org, not a module). Until Stop or 30 minutes, every page
outside `/console` renders as that person, through the same routes, components and database client switch as v1
(`createClient()` → a 5-minute token for the person, read-only at the database). Their dashboard, every org, every
module, their account, feedback and help pages. The only differences from what the person sees are listed in "What you
will see differently" below, and each one is decided in the database or at a browser-side writer, never in a display
component.

**Measured before writing this (two read-only surveys of every module and platform page, 2026-11-23):**
- *Browser-side database access:* none that reads. No Realtime anywhere, no `functions.invoke`, no browser `fetch` to
  app routes. Speed dating's "live" updates are `router.refresh()` polling (`live-round-refresh.tsx`), which re-renders
  on the server, i.e. as the person: correct for free. The one browser-side caller is `DeviceReporter`
  (`events/[eventId]/device-reporter.tsx`), a WRITE (`sd_report_device_status`) through the browser's own session,
  i.e. as the superadmin, not the person.
- *Video:* the JaaS token comes from the server action `getVideoJoinToken` (a POST), which the proxy already refuses
  while a view is open, so the superadmin cannot enter a call as the person. (Minting does not write to the
  database, so the read-only gate alone would NOT have stopped it; the proxy's non-GET refusal does.)
- *Email in the token:* no policy or function reads `auth.email()`/the JWT email; `getUser(token)` asks GoTrue, which
  returns the stored email. No change needed.
- *Writes during render (these fail with 25006 under read-only; supabase-js returns `{error}`, which these callers
  ignore, so the screen silently DIFFERS rather than erroring):*
  | Caller | Function | What it writes |
  |---|---|---|
  | `dashboard/page.tsx:22` | `account_deletion_resume` | cancels a pending self-deletion on sign-in |
  | `dashboard/page.tsx:25` (via `lib/platform.ts:73`), vm `ui/page.tsx:25`, vm `conversations/[id]/page.tsx:84` | `pending_invites_claim_mine` | turns invites addressed to their email into seats |
  | `matchmaking/ui/page.tsx:106` | `mm_ensure_answer` | lazily creates a default answer row per question |
  | `feedback/[ticketId]/page.tsx:40` | `feedback_mark_read` | stamps `user_read_at` |
  Plus one non-database side effect: synagogue's `buildWeekWithProvenance` calls the paid myzmanim API on a cache miss
  (the same call the person's own visit would make; accepted, no change).

**Database (one migration, Opus; version claimed with other sessions first):**
1. *Sessions are per person.* `view_as_real_start(p_target)` (new 1-argument form): superadmin only, never oneself,
   never a superadmin, the target must be a live (non-deleted) account. `org_id`/`module_key` become nullable on
   `view_as_real_sessions`. `view_as_real_check` keeps its return columns (org/module null for a whole-account view)
   and returns `in_scope = true` for every path except `/console…` and `/view-as/…`. The 3-argument start is kept
   unchanged until the app deploy that stops calling it, then dropped in a later migration (so the minutes between
   the migration and the deploy do not break the live console).
2. *Drop the 46 `<table>_no_view_as` policies* (4b in `20261116010000`) on every module table EXCEPT the private
   ones (today `sd_notes`). The db test inverts: every table on the private list HAS the policy, and no other table
   does (catches both a missed private table and a stale block).
3. *The private-field mechanism (general; the résumé vault adopts it unchanged).*
   - The private table keeps its restrictive `_no_view_as` policy, so a direct read with a view token returns
     nothing, whatever a page asks for.
   - The page reads through ONE reader function per private table (`sd_my_notes(p_event)`), a definer that applies
     the table's own owner rule (`author_user_id = auth.uid()`) and returns each private column through
     `public.private_text(value, label)`: the real value normally, `‹private note · 212 characters›` for a view-as
     request.
   - The person and the viewer run the SAME page code (`events/[eventId]/page.tsx:137` switches from
     `.from('sd_notes')` to the reader for both). Adding a private field later = one line in a reader, no page change.
   - The data-browser `neverReadable` list stays the single list of private tables; the db test reads it.
4. *Render-time writers become view-aware, in the database.* Each function in the table above starts with
   `if public.is_view_as_request() then … end if` and returns what the page needs WITHOUT writing:
   `account_deletion_resume` reports the pending deletion without cancelling it; `pending_invites_claim_mine`
   claims nothing; `mm_ensure_answer` returns the default answer it would have created, unsaved; `feedback_mark_read`
   does nothing. A db test calls each one with a view token and asserts no error and no row change. New convention
   for docs/03: a function a page calls during render must be view-aware.
5. ACLs: revoke-before-grant on the new functions; classify them in `verify-acl-hardening.ts` and the data browser.

**App:**
- `proxy.ts`/`lib/view-as-real.ts`: scope from the check (`in_scope`), no module list. `ViewAsGuard`'s boundary
  becomes "/console and /view-as" (crossing it = a full reload; the superadmin is themselves inside the console).
- Console: the page now called "View as" picks a person from every account (search by name, shows their orgs).
- `DeviceReporter` does not mount while a view is open. This is the ONE app-side branch, allowed because it is a
  browser-side WRITER, not display: the database cannot tell it apart (it carries the superadmin's own session).
- Clicking Join video / any button while viewing gets the proxy's 403 today; it should instead show a plain
  "Read-only view: this doesn't do anything while you're viewing" notice (the click result, not the screen).

**What you will see differently from the person (the complete list):**
1. Private notes show `‹private note · N characters›`.
2. Invites they have not yet signed in to accept are not claimed, so a new org appears for them but not yet for you.
3. A pending self-deletion is shown as pending (their real sign-in would cancel it).
4. Buttons and forms do nothing (a notice says so).
5. Their camera/mic status is not reported to the organizer's Ready board.
6. Opening a feedback ticket does not mark it read for them.

**Tests:** the no-drift e2e (render as the person, render as the viewer, compare) widened from 2 classroom pages to
one page per module plus dashboard, account, feedback; the db tests above; a prod verifier copied from
`prod-verify-real-view-as.mts`, run before and after.

**Review:** Fable adversarial review of the MIGRATION DRAFT (not of this doc), since the private-field reader is a
new mechanism and dropping 46 policies widens what a view token reads (founder-decided, but the review checks
nothing ELSE widens, e.g. the token reaching a write path the four layers miss). Then local verify → prod verifier
before → founder go-ahead for `migrate:prod` → after.

### WHOLE-ACCOUNT VIEW AS — FOUR-WAY REVIEW OF THE DESIGN (2026-11-24) AND THE REVISIONS IT FORCES

Four independent read-only reviewers (security; drift; rollout/product; plus the back-link commit). **No BLOCKER, no
HIGH security finding**: writes as the person stay closed (the proxy signs the view header for GET/HEAD only, and
`createClient()` gives the person's client only with that header, `lib/supabase/server.ts:14-15`; a POST that skipped
the proxy would run as the superadmin, never as the person). Everything below AMENDS the design above; where they
conflict, this section wins.

**Revisions (decided here; technical):**
1. *Two migrations, not one (rollout HIGH).* **A — additive, safe with the old app live:** the 1-argument start;
   nullable `org_id`/`module_key`; `view_as_real_check` rewritten with a LEFT JOIN to orgs and a per-request liveness
   check for a whole-account session (account not deleted, not banned, not a superadmin), while a session that HAS an
   org keeps the old path scope (so the old `ViewAsGuard` cannot reload forever in the gap); the view-aware readers and
   writers (5–8 below); the second view flag (9). Then push the app and confirm Vercel READY. **B — the widening:**
   replace the 46 `<table>_no_view_as` policies (11). The rollback migration (re-create them) is written before B
   applies. The 3-argument start is dropped in a later cleanup.
2. *Scope = the `(app)` pages only (drift 4, security L1).* In scope: `/dashboard`, `/account`, `/feedback…`,
   `/o/…`. OUT: `/console…`, `/view-as/…`, `/auth/…`, `/login`, and the public pages `/`, `/privacy`, `/report`,
   `/s/…` (they have no banner or guard, and the superadmin's own email links must use his own client).
   `ViewAsGuard`'s boundary is the same list. The proxy and banner handle a null org/module (today they would build
   `/o/null/m/null`).
3. *Proxy matcher (security L4):* the "image paths skip the proxy" exception is removed for every in-scope path, so a
   POST to a path ending `.png` is still refused while viewing.
4. *Read-only clicks (drift):* one notice for every refused action — server actions AND plain form POSTs (Sign out,
   export, report) — instead of the raw 403 text page; Join video shows the notice instead of hanging on
   "Connecting…" (`video-room.tsx:393` does not catch the rejection).
5. *Matchmaking (drift 1, security M3):* the page throws away `mm_ensure_answer`'s return and re-reads `mm_answers`
   (`matchmaking/ui/page.tsx:104-111`), so "return the default unsaved" would not reach the screen, and the page's own
   stand-in ignores admin locks. Fix: one reader `mm_my_answers(org)` returning stored rows plus the computed defaults
   (locks applied) for missing questions, used by the person and the viewer alike; creating the row moves to save.
   ~~**And a PRE-EXISTING tenancy gap …** `mm_ensure_answer` … no membership check (`:447`)~~ **WITHDRAWN 2026-11-24
   — NOT A GAP.** The reviewer and the orchestrator both read only the FIRST definition (line 447); the same migration
   re-creates the function at line 608 with `if not public.mm_is_single(q.org_id) then raise`. Reproduced as a test
   (`view-as-whole-account.test.ts`): a single of another org and a plain member of org B both get "Only singles answer
   questions" with 0 rows; the control (a single of B) succeeds. Lesson: a `create function` is not the latest
   definition until the rest of the file AND later migrations are searched for `create or replace`.
6. *Invites (drift 3):* claiming makes a PENDING seat (an amber "You've been invited to join X" card, and in chat the
   "You're invited to…" page), not an org. Fix entirely in the database: under a view, `org_my_pending_invites` and
   `vm_my_pending_invites` also return the person's unclaimed `pending_invites` rows (for their confirmed email),
   writing nothing; `pending_invites_claim_mine` returns 0 **before** its `FOR UPDATE` loop (a locking read fails in a
   read-only transaction for the whole function). The screen then matches exactly.
7. *Account deletion (drift 2):* no in-scope page shows a pending deletion; `account_deletion_resume` only acts after
   a real sign-in and the dashboard ignores its return. It becomes a plain no-op under a view, and the old "item 3"
   difference is removed (there is none).
8. *Branch placement (security M3):* every view-aware branch goes AFTER the function's own identity/scope checks and
   immediately before the write, never first, so a view branch cannot return data the checks would refuse.
9. *A second, sticky view flag (security M1):* some definers blank `request.jwt.claims` while they run
   (`pending_invites_chat.sql:527`, `pending_invites_org.sql:364`), which would make `is_view_as_request()` answer "not
   a view" inside them and let a reader return a real private value. The pre-request hook also sets
   `sp.view_as = 'on'` for the transaction; `private_text` and every view branch mask when EITHER is true. A db test
   calls the reader from inside a claims-blanking definer.
10. *Private FILES, not only text (security M2; needed for the résumé vault):* signed URLs minted with the person's
    token are 1-hour links that outlive Stop. A private bucket gets a RESTRICTIVE SELECT policy on `storage.objects`
    for a view (same shape as the existing write policies), and the page shows a placeholder instead of the link. No
    private bucket exists today; the rule is written so the vault adopts it unchanged.
11. *Do not just drop the 46 policies; replace them with ONE shared rule (rollout F5).* Each becomes `using
    (public.view_as_may_read(org_id, '<module>'))`, which is `true` for a superadmin session today and is where the
    later STAFF version adds "within the viewer's area". The token carries the session id so the viewer is looked up.
    The data-browser promise in docs/15 point 12 ("a real view shows only what the superadmin reads in the data
    browser") is RETIRED for the superadmin's real view by his 2026-11-23 decision (recorded there); the per-module
    superadmin-count test is kept anyway as a check that nothing ELSE widened.
12. *What a masked note still shows (security L5):* that a note exists, its length, whom it is about (it sits beside
    that partner), and when it was written. Placement is the screen itself, so hiding "whom" would be drift; the
    founder is asked to confirm.
13. *Browser-client allowlist (security L6):* a test allows the browser database client only in listed files (today
    `login/page.tsx`, `device-reporter.tsx`), so a future browser-side writer cannot silently write as the superadmin.

**Tests (rollout HIGH 2):** the no-drift e2e renders as the VIEWER FIRST (otherwise the person's render runs the
writers and the later comparison matches by accident), over seeded fixtures that make each case non-vacuous (a
pending invite, an unanswered locked mm question, an unread feedback reply, an `sd_notes` row), with before/after row
counts around the viewer's render, a "has content" control per page, and the placeholder mask scoped to the notes
element only.

**Known differences that remain (the revised complete list):** private text and files show placeholders;
buttons/forms show the read-only notice; camera/mic status is not reported; opening a feedback ticket does not mark it
read; the in-module staff "View as" picker state (a browser cookie, `lib/view-as.ts:226`) shows the superadmin's, not
the person's (drift 5); and **it is looking, not doing** — he cannot test a flow by clicking through it as the person
(demo accounts remain the way to test actions).

**Founder decisions this review raises (shown text that becomes untrue; his call):**
- `/privacy` says staff look only when someone "needs" it ("for example, to help with a support question") and that
  "there's always a record of who looked, and when", kept permanently. Real use is routine checking, and the only
  record is the `view_as_real_sessions` row, which docs/13 calls "not a log". Either declare that row the permanent
  access record (never pruned; docs/12) and reword "needs", or reword both.
- The speed-dating note box says "Only you can see this": still true of the words, not of the note's existence,
  length, subject and date (12).
- Lawyer questions B5 / B10 (docs/31) are open while the feature widens.

### WHOLE-ACCOUNT VIEW AS — AS BUILT (Opus + agents, 2026-11-24/25; migration A `20261125010000` ON PROD 2026-11-25, verified 24/33 → 81/0 and v1 38/2 → 40/0; migration B `20261126010000` ON PROD 2026-11-26, verifier state A → state B, 81/0 both, v1 40/0)

**Files:** migration A `supabase/migrations/20261125010000_view_as_whole_account.sql`; migration B
`supabase/migrations/20261126010000_view_as_widen.sql` (kept in `supabase/pending/` until A + the app were live; moved 2026-11-26);
rollback `supabase/pending/ROLLBACK-view-as-widen.sql` (not a migration — copy it in with a NEW version to use it);
tests `packages/db/src/view-as-whole-account.test.ts`, `browser-client-allowlist.test.ts`, `e2e/real-view-as.spec.ts`
(`MODULES_WIDENED = true` since B; each page is rendered by the viewer and then at once by the person, re-taken up to 3 times, because other e2e files change Charlie's data in parallel); prod verifier `scripts/prod-verify-view-as-whole-account.mts` (reports which
state prod is in, A or B, and fails only on a mixed state). Convention: docs/03 #38.

**Changed while building (each from a review or a test):**
- *A ends every open v1 (org-scoped) session*, since the new app no longer understands v1 scope.
- *`mm_ensure_answer` returns NULL to every view under A* (A keeps matchmaking dark); B re-creates it to return the
  stored row or the unsaved default when `view_as_may_read` allows. The page ignores its result and reads
  `mm_my_answers` (invoker, so table policies decide). The render-time lazy-create stays (client spec: a locked
  dealbreaker counts from first sight), it is just view-aware.
- *`view_as_may_read`* also re-checks the person on every call (not a superadmin, not deleted/departed, not banned),
  so an already-minted token stops reading at once if any of those changes.
- *Under A alone*, `sd_my_notes` (masked) and the invite view branches already answer a whole-account view; the
  module tables stay dark until B. Accepted: masked or invite-shaped data only, and the gap lasts one deploy.
- *The proxy sends the database a DECODED path*; an undecodable path, `.`/`..` segments, a backslash or NUL become
  `/invalid` (in scope nowhere → the superadmin's own view).
- *App:* any open view (paused or not) stops browser-side writers (`DeviceReporter`); the submit blocker lets GET
  forms through; visual-messaging's canvas Send and image upload show the read-only notice; the banner counts down in
  local time; an expired view lands on the console with "Your view of <name> ended"; `Origin: null` → 403.
- *Not a gap after all:* the `mm_ensure_answer` "cross-org insert" (see revision 5's WITHDRAWN note).

**Final adversarial review (2026-11-24/25, four reviewers: SQL security, app code, tests/rollout, plus the earlier
plan reviews):** no BLOCKER, no HIGH except the ship order below; every MEDIUM/LOW closed in the code above. A Fable
SQL review was attempted and refused for lack of usage credits; it was re-run on Opus.

**SHIP ORDER (do not change):** `pnpm backup:prod` → `migrate:prod --dry-run` lists ONLY `20261125010000` → founder
go-ahead → apply → verifier + `prod-verify-real-view-as.mts` (before AND after) → ONLY THEN commit + push the app
(the pages read `sd_my_notes`/`mm_my_answers`; pushed first, every dater's note box renders empty and a save would
overwrite the real note). After Vercel READY: move B into `migrations/`, flip `MODULES_WIDENED`, push, and apply B with
its own go-ahead.

**Open follow-ups (not started):** a cleanup migration that drops the 3-argument `view_as_real_start` (kept for one
deploy) and removes the temporary overload exception in `packages/db/src/rank-admission.test.ts`; the STAFF version
(org staff see a trimmed real screen, replacing table-style view-as — see "For the later STAFF version" above). Handoff + prompt: docs/history/handoff-2026-11-26-view-as-staff.md (founder chose it as next, 2026-11-26).

**Founder answers, 2026-11-24:** (1) **A** — `view_as_real_sessions` IS the permanent staff-access record (never
pruned; docs/12 never-do), and `/privacy` now reads "Platform staff regularly look at accounts the way their owners see
them, to check that everything works. That's tracked too — so there's always a record of who looked, and when."
(2) Masked notes may show existence, length, subject and date — never the words. (3) **Go** on building migration A +
the app, with adversarial reviewers over the finished work.

**Open, by design:** one view at a time per superadmin; a token
already minted lives until its 5-minute expiry after Stop (server-side only); widening to another module needs its own
review plus the per-module checks above (client components querying from the browser, realtime, edge functions, GET
route handlers with side effects).

**Turning it on in production — DONE 2026-11-15, deploy included** (checked on prod that day: the page loads without the
"Not configured" banner). (Migration applied; secret set on Vercel by
Claude, decision (2) above). It works once a production deploy built after 2026-11-15 is live. If the secret ever has to
be set again by hand (e.g. rotated): Supabase dashboard → Project Settings → API / "JWT Keys" → "Legacy JWT secret" →
copy (never paste it into a chat) → Vercel → Settings → Environment Variables → `SUPABASE_JWT_SECRET`, Production only,
not a `NEXT_PUBLIC_` name → Save → Redeploy. Rotating the JWT secret also invalidates every user's session.
