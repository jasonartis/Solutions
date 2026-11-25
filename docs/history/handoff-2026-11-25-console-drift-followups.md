# Handoff — console drift follow-ups 3 and 4 (founder: "do your recommendations", 2026-11-25)

Source: [console-drift-audit-2026-11-24.md](console-drift-audit-2026-11-24.md). Follow-ups 1 and 2 (label "person-linked
only"; "last verified" dates) were handed to a Sonnet agent in the planning chat; check `git log` for them before starting.
Follow-up 5 (real view-as for more modules) belongs to the View-as session (migrations `20261125010000`, `20261126010000`
claimed by `solutions-platform-b0`) — do not touch it.

## Chat — Opus 5.5: data-browser indirect links + "every table is classified" test (no migration)

Why Opus: it decides what counts as person data in the platform's privacy tooling. Do NOT use a cheaper model for the
classification judgement. A Sonnet agent may write the test boilerplate after the rules are decided.

Paste-ready prompt (fresh chat):

> Read CLAUDE.md, docs/03 (Test discipline), docs/history/console-drift-audit-2026-11-24.md, and
> `packages/db/src/data-browser-coverage.test.ts`. Two jobs, no migration. (A) Run the data-browser coverage test's
> tier-2 report (tables that reach a person only through a child row). For each reported table decide: really a
> person-link → add a `via` declaration in `packages/platform/src/data-browser-modules.ts` (and check the view-as
> declarations for the same table); or not person data → record why in an explicit allowlist. Prove each decision with a
> control (the table has rows for a seeded user and the data browser now shows them). (B) Add a ratchet test that EVERY
> `public` table is classified somewhere: data browser, table view-as, or an explicit "no person data" list with a
> one-line reason; a new unclassified table must fail CI. Follow the vacuity rule (the test must fail when a table is
> added). Then adversarial review (two agents), update docs/13 and the journal, commit by pathspec; ask before pushing.

Known facts to save re-deriving: the data browser catalog test only fails on FK columns to `auth.users`/`profiles` that
are undeclared; indirect links are only REPORTED; `/console/overview` record counts come from the same declarations (a table
with no person column is never counted — that is why the overview says "person-linked only"). `tests-floor.json` ratchets
the test counts: a new test file must be added to its `requiredFiles` if it guards schema coverage (see commit `fec1a4f`).
