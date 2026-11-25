# Handoff — whole-account View as (2026-11-25, paused on the usage limit)

**State:** built, reviewed four ways, review fixes IN PROGRESS (both fix agents died on the 5-hour limit mid-edit;
their partial edits are in the working tree, UNVERIFIED). Nothing of this is on prod. Snapshot of the working tree:
branch `view-as-wip` (NOT master; never merge it as-is). Design + every review: docs/13 "WHOLE-ACCOUNT VIEW AS"
sections (THE DESIGN → FOUR-WAY REVIEW → Founder answers 2026-11-24).

**Founder decisions (all recorded in docs/13 / docs/15 §8.1 pt 12 / docs/12):** whole account incl. matchmaking +
speed dating; private notes show `‹private note · N characters›` (existence/length/subject/date OK, never words);
privacy option 1A (`view_as_real_sessions` = permanent staff-access record, never pruned; /privacy reworded — the
edit is in the working tree); go on build; adversarial review of the finished work (DONE, findings below).

**Files (uncommitted):** migration A `supabase/migrations/20261125010000_view_as_whole_account.sql`; migration B
`supabase/pending/20261126010000_view_as_widen.sql` (+ ROLLBACK file); `packages/db/src/view-as-whole-account.test.ts`;
`scripts/prod-verify-view-as-whole-account.mts`; app: `lib/view-as-real.ts`, `proxy.ts`, `components/view-as-*`,
`(app)/layout.tsx`, `view-as/start/route.ts`, `console/view-as/real/*`, speed-dating `device-reporter.tsx`,
`video-room.tsx`, `page.tsx`, matchmaking `page.tsx`, `e2e/real-view-as.spec.ts` (`MODULES_WIDENED=false`),
`privacy/page.tsx`, docs/03 #38, docs/12, docs/13.

**Verified before the fix round:** local fresh reset (A only) + seed → db suite 29/29 files green. Not yet run: build,
e2e (Windows virtual memory was 1.2 GB free — too low; ask the founder to close apps first).

**Review findings being fixed (check each in the diff; finish what is missing):**
- SQL/tests (Opus agent): (1) MEDIUM `mm_ensure_answer` view branch must call `view_as_may_read(q.org_id,'matchmaking')`
  first (else it reads matchmaking past the module darkness); (2) `view_as_may_read` also checks target not
  superadmin/deleted/departed/banned; (3) A ends open v1 sessions; (4) note anon grants as intentional in
  `verify-acl-hardening.ts`; (5) rename rollback to `supabase/pending/ROLLBACK-view-as-widen.sql` (not a migration);
  (6) verifier: `sd_notes` probe on a target WITH notes + control, skip-not-crash when the 1-arg start is missing
  (before run), positive probes, explicit A/B state; (7) allowlist test also catches supabase-js `createClient` in
  `'use client'` files; (8) docs/12 never-do lists `in_view_as()`/`view_as_may_read()`.
- App (Sonnet agent): (1) MEDIUM guard uses the v1 prefix for an org session (else reload loop); (2) MEDIUM layout
  `viewing={!!realView}`; (3) VM canvas Send (`action-form.tsx` runAction) shows the read-only notice; (4) submit
  blocker lets GET forms through; (5) client-side countdown in local time; (6) proxy deletes the dropped cookie from
  the request too + "your view ended" note; (7) start route: `Origin: null` → 403; (8) e2e: first-after-start key,
  header comment, `/feedback` page, professor content controls.

**SHIP ORDER (rollout review HIGH — do not change):** backup:prod → migrate:prod `--dry-run` lists ONLY
`20261125010000` → founder go-ahead → apply → run the new verifier (before AND after) + `prod-verify-real-view-as.mts`
→ ONLY THEN commit + push the app (pushing first blanks every dater's note box, since the page reads `sd_my_notes`).
Then, after Vercel READY: move B into `supabase/migrations/`, flip `MODULES_WIDENED`, consider `workers: 1` or a
dedicated seed person for the widened e2e (flake risk), push, migrate B with its own go-ahead.

**Docs still to write at ship:** docs/13 "AS BUILT (whole account)", docs/15 §8.1 pt 12 (done for the decision),
CLAUDE.md current-state line, journal entry.

**Resume:** when the limit resets, the two fix agents can be continued by message from the session that started
them; from a fresh chat, read this file, `git diff`, and redo whatever item above is not yet in the code.
