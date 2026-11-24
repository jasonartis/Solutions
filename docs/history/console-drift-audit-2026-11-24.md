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

**Recommendations (small, not scheduled; none started):** triage the tier-2 indirect-link report and promote real
person-links to `via`; label overview's "records" as "person-linked only" in the UI; add a "last verified" date beside cost
prices, vendor rows and vendor limits; treat table view-as as an audit aid, not a mirror, and extend real view-as to more
modules (whole-account design: docs/13); optionally a test that every `public` table is classified somewhere (data browser,
view-as, or an explicit "no person data" list).
