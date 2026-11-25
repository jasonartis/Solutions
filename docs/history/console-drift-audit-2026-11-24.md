# Console drift audit — do superadmin tools follow live activity? (2026-11-24, read-only, Sonnet)

Founder's worry: a console page that rests on a declared list can drift from what clients see. The audit opened each
console page's imports and data calls and the key libraries. **Not read in depth:** full page bodies, `console/actions.ts`,
`console/layout.tsx`, `console-report-banner.ts`, `vendor-accounts.ts`, `vendor-limits.ts`, `cost-model.ts`.

| Page | Data source | Drift guard / what drift looks like |
|---|---|---|
| /console | live SQL + `getDashboard`; module list from `moduleRegistry` (declared) | a module missing from the registry is not toggleable; tile internals not checked |
| /console/accounts, engagement, feedback, reports, zmanim, org delete, view-as/real list | live reads | none needed |
| /console/costs | static dated prices (`cost-model.ts`); "real numbers" are live counts | tests check internal consistency, NOT price currency: prices go stale silently |
| /console/data-browser | declared lists (`data-browser-modules.ts`), rows queried live | `data-browser-coverage.test.ts` reads the catalog: fails on any undeclared FK to `auth.users`/`profiles`; indirect links only REPORTED (tier 2) |
| /console/overview | bytes live (`platform_storage_usage`); record counts from the declared list (tables with a person column), capped 5,000 rows per table | same test; a table with no person column is never counted ("a floor") |
| /console/positions | ranks live (`module_position_rank()`); role vocabulary from the declared registry; TS-vs-SQL mismatch flagged | a role added in SQL but not in the TS vocabulary does not appear; `docs/rank-admission-map.md` is a generated file that can go stale |
| /console/vendors | DB rows entered by hand; limits hardcoded in `vendor-limits.ts` (read from vendor pages 2026-11-12) | only as current as the founder's edits |
| /console/view-as (table style) | declared surface per module (`view-as-modules.ts`), row data live | `view-as-coverage.test.ts` (baseline-and-ratchet, KNOWN_GAPS empty) |
| /console/view-as/real | the real app pages (classroom only) through a signed token | no-drift e2e |

**Answers.** (1) Only the real view-as renders the same components the person sees; the table-style view-as is a generic
rendering of a declared surface and CAN differ from the person's screen. (2) A new table reaches the data browser only if it
has an FK to a person; otherwise it needs a `via` declaration by hand. (3) Cannot go stale: pages marked live. Can: overview
counts and data browser for tables with no direct person column; table view-as for an unclassified surface (CI blocks it);
cost prices; vendor rows and limits; the module list if a module is not registered; `rank-admission-map.md`.

**STATUS 2026-11-25 (founder: "do your recommendations"):** items 1 (label) and 2 (last-verified dates) DONE in `6d51dbc`;
items 3 (triage indirect links) and 4 (every-table-classified test) are docs/04 row 10 with a paste-ready Opus prompt in
[handoff-2026-11-25-console-drift-followups.md](handoff-2026-11-25-console-drift-followups.md); item 5 is the View-as
session's work (docs/13). The original list follows.

**Recommendations (originally small, not scheduled):** triage the tier-2 indirect-link report and promote real
person-links to `via`; label overview's "records" as "person-linked only" in the UI; add a "last verified" date beside cost
prices, vendor rows and vendor limits; treat table view-as as an audit aid, not a mirror, and extend real view-as to more
modules (whole-account design: docs/13); optionally a test that every `public` table is classified somewhere (data browser,
view-as, or an explicit "no person data" list).

## Detail recovered from the planning chat (2026-11-25)

- **Why the table view-as is a declared-surface tool on purpose (assistant reasoning, accepted by the founder moving on):** it answers a
  SECURITY question, "what can this role read?". If it rendered the client's real screens, a screen that hides a column the
  database still allows would look safe while the leak stays open. "What does their screen look like?" is the REAL view-as (or a
  later support sign-in). So the drift is a property to manage, not a bug to remove.
- **The data browser's tiers, exactly:** tier 1 fails `pnpm test` on any column with a foreign key to `auth.users`/`profiles`
  that no declaration covers (declare it, omit it, or mark it unreadable); tier 2 only REPORTS indirect links (a table that reaches
  a person only through a child row) and these must be declared by hand as `via` entries; the test also fails if a declaration
  names a column the database lacks. A real example of a gap: a note linked to a booking, which is linked to a person.
- **Limits tile:** its database and storage rows are live; only the vendor caps beside them are hardcoded
  (`VENDOR_LIMITS_CHECKED = '2026-11-12'` in `apps/web/lib/vendor-limits.ts`; the video cap carries its own older date). The
  vendors page already showed "Last edited <time> UTC" from `vendor_accounts.updated_at`, which is why follow-up 2 left it unchanged.
- **Follow-up 1+2 verification:** the costs page shows the oldest-to-newest price `checked` dates (2026-11-09 to 2026-11-20 at the
  time); a browser check found a missing space ("2026-11-20(each", a JSX line break), fixed in `6da263d` and confirmed by reading
  the source only; the amber hint on the overview was seen in a screenshot but its exact colour was not measured.
