# Handoff — the Owner Console session of 2026-11-09 → 11-12 (Sonnet)

Everything BUILT in that session is in the journal (2026-11-10 / 2026-11-12 entries), docs/25 §13–14, module-9 spec §H, docs/13
"REAL VIEW-AS", and CLAUDE.md's shipped list. This file holds what those do not: the next-session prompts, how the work was
verified locally on this host, and small known issues. Read it before continuing the console work.

## 1. The next sessions (founder: "do these one by one"; a fresh chat each, this one was far too long)

Order: chat 1, then 2, then 3. Chats 2 and 3 are different heavy jobs and must not share a chat.

### Chat 1 — Sonnet 5.5: module-role cleanup, then the Limits tile

> Continue the Solutions Platform Owner Console work. Read CLAUDE.md, then the 2026-11-12 and 2026-11-10 entries at the top of
> docs/history/platform-journal.md, docs/history/handoff-2026-11-12-console-session.md, then module-9 spec §H
> (docs/modules/module-9-photos-DRAFT.md).
>
> Two jobs, in order, committing after each (use `git commit -- <paths>`; other sessions share this tree):
> 1. Module roles: add a confirmation popup and clear refusal messages to removing a module role (the × on a member's chip)
>    and to "Grant a module role", in the shared components used by both the org Members page and the console. Follow
>    `components/org-member-controls.tsx`: return the refusal rather than throwing, using `ActionResult` and
>    `memberActionFailure` from `lib/org-members.ts`, and show it inside the popup. Update every e2e file that clicks those
>    controls — grep ALL of `apps/web/e2e`, not just `platform.spec.ts`; CI failed once because another spec was missed.
> 2. Limits tile: a "Limits" tile on the console dashboard for the agreed watch list: active people per month, database size
>    and storage, and the 25-active-people-a-month video cap (docs/02 "Video"). Build only what is measurable now (active
>    people from existing tables; video people from speed-dating tables) and mark database size and storage "not measurable
>    yet". First confirm the vendors' exact free-tier numbers (Supabase, Vercel) from their own pages and record the source; do
>    not hard-code a number you have not confirmed.
>
> No migrations. If one seems needed, stop and tell me to switch to Opus. Verify with a prebuilt local server and the e2e tests
> as the handoff file describes, push only when I say "push", and write the journal entry.

### Chat 2 — Opus: real bytes per organization

> Read CLAUDE.md, the 2026-11-10 journal entry "DASHBOARD PLATFORM TILE + ROW COUNTS", and docs/03 #12.
>
> Build real storage size per organization and per module: a superadmin-only definer (a migration) over
> `pg_total_relation_size` and `storage.objects`, shown beside the "records" counts in `/console/overview` and feeding the
> Limits tile's database-size and storage rows. Postgres does not track size per org, so choose and justify an estimate (rows ×
> average row size per table, plus storage objects by org path) and label it as an estimate. Follow the full migration rhythm:
> draft, adversarial review, verify as real users, RLS tests, docs. Run `pnpm backup:prod` by hand before `migrate:prod` and ask
> me for the go-ahead in the turn you apply it.

### Chat 3 — Opus, with a Fable adversarial review of the design: "Real" view-as

> Read CLAUDE.md and docs/13-future-ideas.md "REAL VIEW-AS" plus docs/15 §8.1.
>
> Design, then build one module first: the superadmin sees a client's actual screen, rendered by the same components the client
> sees, with no second layout. Before any code, write the design and the answers to the draft questions in docs/13, including how
> pages run as the target, how writes and side-effect writes are made impossible, what stays unreadable, logging, and a banner on
> every viewed screen. Get a Fable adversarial review of the design. Build one module and add a test that renders the same page
> both ways, proving no drift.

### Not yet scheduled (needs a founder conversation, not a chat)

- the founder's ORIGINAL, wider ask (gitignored `founder-feedback.md` ~line 119: "analyse what statistics should be monitored, create charts, visualizations and metrics … the expandable table-tree would be one way to visualise what is happening but let's analyse and think of others … actions listed based on critical points like when reaching 100 users we need to migrate from xyz") is only PARTLY done — the headcount trees and the agreed Limits tile are the first slices; charts, other visualizations, and threshold-triggered "do this next" actions are NOT scheduled and need a founder conversation first.

## 2. How the work was verified on this host (pnpm is NOT on PATH — this worked, with no shim)

Run from `apps/web` unless stated. Each is a single plain command.

- Typecheck: `node ../../node_modules/typescript/bin/tsc --noEmit`
- Lint: `node ../../node_modules/eslint/bin/eslint.js <files>`. **One lint error already exists and is not new:** the apostrophe in
  "it's used in existing links" in `app/(app)/console/page.tsx` (react/no-unescaped-entities).
- A one-off script: `node ../../node_modules/tsx/dist/cli.mjs script.mts` — the script must live INSIDE `apps/web` (module
  resolution) and be deleted after.
- E2E, CI-style against a prebuilt app (the dev server is memory-hungry here): (1) make sure port 3000 is free
  (`netstat -ano | grep LISTENING | grep ":3000 "`; if busy, it may be another session's server — do not touch it);
  (2) `NODE_OPTIONS=--max-old-space-size=4096 node ../../node_modules/next/dist/bin/next build`; (3) start
  `node ../../node_modules/next/dist/bin/next start -p 3000` in the background; (4)
  `node ../../node_modules/@playwright/test/cli.js test e2e/<file> -g "<pattern>" --workers=1 --reporter=list > log` (redirect to a
  file, then grep it; never pipe through `tail`); (5) stop only a server whose command line matches `next start -p 3000`.
  **The server is PREBUILT: rebuild after every source change.** `playwright.config` reuses a server already on :3000 when not in CI.
- A database fact from the real database as the real user: sign in over the API (`owner@demo.local` / `password123` locally) with
  supabase-js, or replay a statement inside a rolled-back transaction (`set_config('request.jwt.claims', …)` + `set local role
  authenticated`, then throw to roll back). That is how "an org's last owner/admin cannot be removed" was found (8 of 28 seeded
  members), and how `getOverview` was checked (8 orgs / 10 people).
- A failed or timed-out e2e test can LEAVE STATE and fail the NEXT test with a misleading message (the received value is the tell):
  Org Test Member left as `admin` in Platform Self-Test broke "org settings … non-admins are locked out" (a 404 test); the synagogue
  location left at `US99999` breaks the next test. Restore with owner SQL, or `db:reset` + `seed`, before judging the next failure.
- CI after a push takes ~12–14 minutes (db suite, then e2e). A red `check` skips `deploy`. Poll CI with the GitHub REST API and
  Vercel with `VERCEL_TOKEN` as CLAUDE.md "CI/deploy without `gh`" describes. When CI fails, download the job log
  (`GET /actions/jobs/<id>/logs`) and read the end of the e2e section.
- `git commit -- <paths>` refuses a NEW untracked file unless it has been `git add`-ed first; add it by explicit path, then commit
  with the pathspec. Do not leave anything staged that you did not mean to (the index is shared).

## 3. Console test conventions that are easy to break

- The org cards start CLOSED. A test that works inside a card opens it by address: `page.goto('/console?expand=all')`. A test that
  RELOADS must use that address too (the Expand all BUTTON opens cards in place and a reload re-closes them). A "not visible"
  check on a closed card passes for the wrong reason — open the cards first.
- A member's Remove opens a popup: click Remove, then `Yes, remove` (or `Yes, withdraw` for a pending person).
- The role dropdown's Update is disabled until the value differs from the saved one; `selectOption` first.
- `e2e/console-overview-rules.spec.ts` pins the Overview's COUNTING RULES (active only; a person once across orgs; pending apart;
  role holders must be active) with no page or database. Change `lib/console-overview.ts`'s rules and that test with it.
- Search ALL of `apps/web/e2e` (`platform.spec.ts`, `visual-messaging.spec.ts`, `content-reports.spec.ts`, …) when a shared control
  changes; the 2026-11-12 CI failure was a second spec file.

## 4. Known small issues and limits (found, deliberately not fixed)

- The "Expiring soon" dashboard tile links to `/console` (itself); only its zmanim priority line links to `/console/zmanim`.
- `toggleModule` in `app/(app)/console/actions.ts` is now unused (the console uses `applyModuleChanges`); delete it when convenient.
- The 48-hour banner lives in `app/(app)/console/layout.tsx`, which is not re-rendered when moving between console pages: it shows
  the state at the last load or reload.
- Each console org card renders the shared invite section, which makes three reads per org (invitation list, pruner time, member
  names). Fine at 8 orgs; revisit when there are dozens. The Overview "records" scan reads up to 5,000 rows per table and names any
  table that hit the cap on the page. "Records" counts only tables that name a person — a floor, not the total size.
- Module-role removal (the × chip) and "Grant a module role" still throw into the generic error page on a refusal and have no
  confirmation. That is chat 1, job 1.
- Turning a module OFF only flips `org_modules.enabled`; nothing is deleted (checked in the action's code, not in the UI by hand).

## 5. State at the end of the session

**PENDING PUSH — handed over by the founder (2026-11-12): whichever session finishes first and pushes master should carry these.**
The console session could not push: the pre-push typecheck died twice with exit 134 because free virtual memory was 0–1.7 GB with
many sessions open (CLAUDE.md "memory allocation … failed" gotcha; the hook was NOT skipped). These local commits are mine, docs plus
one pure test, no migration, and were cleared by the founder ("push") in the console session: `58a24f1` (CLAUDE.md shipped line),
`e3ea447` (this handoff, docs/25 §14, `e2e/console-overview-rules.spec.ts`), `7808459` (wider-ask note), `387ee94` (docs/13 heading).
A plain `git push origin master` also sends every other session's commits — run `git log --oneline origin/master..HEAD` first and ask
the owner of any that is not yours (notably `09c8cc0`, the module-roles popups, which is NOT the console session's). The founder's own
"push" in YOUR session is what authorises it. Delete this paragraph once pushed.

**CHECK FIRST — chat 1's job 1 may already be under way.** While this file was being written (2026-11-12) another session had UNCOMMITTED
edits in `apps/web/lib/org-members.ts` adding module-role refusal messages to `SHOWN_REFUSALS`. Run `git status` and `git log` before
starting job 1, and ask whoever owns those edits; do not duplicate or overwrite them.

On prod (CI green, Vercel READY `558ba39`): the dashboard, banner, Overview trees, shared invite section, closed org cards, staged
modules, role colours, Remove popup, Tools cards. Local, NOT pushed at the time of writing: `58a24f1` (CLAUDE.md shipped line)
and the commit that adds this file. The founder must say "push" in the session that pushes; a peer session cannot authorise it.
No migration was added in this session. Founder's open items: Limits tile (agreed, unbuilt), real bytes per org, REAL view-as,
module-role confirmation; the prod check of staged modules, the role dropdown, and inviting an address with no account was not
yet reported back.
