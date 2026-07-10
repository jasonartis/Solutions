# Future ideas & enhancements

The parking lot for platform-level ideas worth building *someday* — captured
so they survive sessions, models, and memory. Per-module enhancements stay in
that module's spec; this list is for cross-cutting ideas.

**Rules for this list:** every entry is dated and attributed; an idea here is
NOT a commitment (extract-don't-speculate still governs); when an idea gets
built, move its entry to the module spec / CLAUDE.md state log with the
build date.

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
