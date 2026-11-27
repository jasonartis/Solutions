# Handoff — "View as" for org staff (the STAFF version), written 2026-11-26

> **DONE 2026-11-26.** Built, reviewed (Opus only; Fable re-review queued in docs/30 §4 Step C #7) and migration
> `20261127010000` ON PROD, verified. Everything this note asked for — answers, decisions, review record, what is still
> open (the 3-argument start cleanup, LOW items, signed-link lifetime) — now lives in docs/13 "STAFF VIEW AS" (DESIGN,
> THREE-WAY REVIEW, FOUNDER ANSWERS, AS BUILT). Kept as the record of the ask.

**Model: Opus 5.5** for the whole chat (migrations, RLS, a new privacy rule). **Fable is NOT available (founder,
2026-11-26)**, so the design's adversarial security review (a NEW mechanism: trimming a person's real screen to the
viewer's area) runs on Opus as **two or three independent reviewers, each with ONE narrow question and a word cap**
(e.g. "can a viewer reach a row outside their area?", "can a page outside the area leak through a shared component,
link or count?", "does anything write during a view?"). Record in docs/13 that the review was Opus-only, so a Fable
re-review can be run later if credits return.

## Paste this into a fresh chat

> Build the STAFF version of "View as": org staff (e.g. Alice, a professor and org admin) get the real-screen view of a
> person in their area, trimmed to what they govern, replacing the table-style in-module "View as". Read first:
> `docs/history/handoff-2026-11-26-view-as-staff.md`, then docs/13 "WHOLE-ACCOUNT VIEW AS" (DESIGN, FOUR-WAY REVIEW,
> AS BUILT) and the earlier view-as sections it builds on. Start by writing the design into docs/13 and bringing me the
> open decisions as concrete scenarios. Do not build until I say go.

## What the founder asked for (his words, 2026-11-23)

"When changing the current 'See their real screen' we need to think about this carefully since anyone who has the
'View-As', like Alice, should also have this 'See their real screen' functionality, in fact it should probably replace
the current 'View-As' as it's much more useful than seeing table data, they are not data base people or coders."

It was step 3 of the plan he said "Go" to (step 1 = superadmin whole-account View as, ON PROD 2026-11-26; step 2 =
the private-field placeholders, ON PROD the same day).

## Already decided (docs/13, "For the later STAFF version", founder 2026-11-23)

- The real screen runs as the person, who can see MORE than Alice may (e.g. Charlie's grades in Professor Smith's Math
  course, which Alice does not govern). So the staff view shows the person's screen **trimmed to the viewer's area**.
- A whole page outside the area renders a placeholder (`‹Math 101 · outside your area›`) in the same page frame.
- A private field renders its placeholder exactly as for the superadmin (`‹private note · N characters›`).
- Rows outside the area are decided **per table**: a placeholder count where harmless, removed outright where the count
  itself is the secret (speed-dating interest marks: "‹3 marks hidden›" would reveal them).
- The decision happens at the last stage, in the database; pages never branch on "am I being viewed".
- Naming: the staff's table tool keeps the name "View as" until this replaces it; the superadmin's table tool is
  "Readable table data".

## What exists to build on (all ON PROD)

- `view_as_may_read(p_org_id, p_module)`: the shared rule in all 45 module-table policies (migration
  `20261126010000`). **Its two arguments are unused today, on purpose**: the staff version narrows by them.
- `view_as_real_sessions`, the token (`view_as` claim, 5 minutes, HS256), the pre-request read-only hook, the proxy,
  the banner and guard, `private_text()`, `sd_my_notes()`, `mm_my_answers()` (migrations `20261116010000`,
  `20261125010000`). The superadmin path must keep working unchanged.
- The table-style staff view-as and its hierarchy rules (who may view whom): docs/13 earlier sections, docs/15 §8.1.

## Open questions to bring to the founder (as scenarios, one at a time)

1. **Notification and logging for staff.** The founder waived both for HIMSELF only (no notification, no per-page
   log). For Alice viewing Charlie: is Charlie told? Is every page logged? (CLAUDE.md "Next / open" lists "whether
   view-as targets are notified".)
2. **Who may view whom**: reuse the table view-as hierarchy as is, or narrow it (`view_as_sessions` hierarchy
   narrowing is also open in CLAUDE.md).
3. **Per-table row decisions**: the list of tables where even a count is secret.
4. **Retiring the table view**: when the staff real screen replaces it, and whether the superadmin keeps "Readable
   table data".

## Process (CLAUDE.md standing rules)

Design into docs/13 → adversarial review of the design (2–3 narrow Opus reviewers, see top) → founder go → migration draft → two adversarial reviews
→ db tests + verifier (`scripts/prod-verify-*.mts`, run before AND after) → e2e no-drift test as Alice →
`backup:prod` → dry run → founder go-ahead for the apply → push with his "push". Claim the migration version with other
sessions first. Every new function: revoke then grant; never let `in_view_as()` / `view_as_may_read()` raise (docs/12).

## Also open from the same work (small, not founder-gated)

- A cleanup migration that drops the 3-argument `view_as_real_start` and removes the temporary overload exception in
  `packages/db/src/rank-admission.test.ts` (docs/13 AS BUILT, "Open follow-ups"). Fold into the staff migration or do
  it alone.
