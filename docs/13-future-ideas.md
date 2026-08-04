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
to the superadmin read-only view; do them together if either is picked up.

---

## Superadmin "view as anything" console + a per-person data browser

> **STATUS 2026-08-03: the DATA BROWSER half is BUILT** (`/console/data-browser`,
> superadmin-only, zero migrations). Rules extracted to docs/03 **#19**; the dated
> record is in docs/15's decisions log and the journal. The **Owner Console view-as**
> half is next, founder-sequenced. Everything below is kept as the reasoning that
> produced it — where the build sharpened or corrected it, docs/15's 2026-08-03 entry
> says so.
>
> **Build order changed, founder 2026-08-03:** data browser first, Owner Console
> after. The reason is in the sizing note at the bottom of this entry, sharpened by
> reading the code: the console's edge bypass can only render positions that have a
> declared SURFACE, and today that is classroom `student` and `ga` alone. The banned
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
  not a permission. Today only classroom `student` and `ga` have one; a
  `professor` surface would need writing. Every other module is blank until its
  per-module surface review (§8.1 point 9) happens.

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

**Sizing:** the console view against classroom alone is small (the renderer is
already generic — `renderSurface` in `apps/web/lib/view-as.ts` takes a surface
and a subject). Writing surfaces for the remaining modules is the substantial
part, and speed-dating's are the delicate ones (interest marks, safety reports).
