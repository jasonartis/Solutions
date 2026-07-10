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
