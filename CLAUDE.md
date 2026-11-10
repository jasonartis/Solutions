# CLAUDE.md — Solutions Platform

## What this is

A multi-tenant modular platform: each client engagement produces a **module** built on shared primitives; clients are org users entitled to modules. Full context lives in `docs/` — **treat the docs as the source of truth and keep them current; a change that makes docs stale isn't done.**

## Read before working

1. [docs/00-vision-and-strategy.md](docs/00-vision-and-strategy.md) — why, principles (extract-don't-speculate; one deployment; tenancy isolation is existential)
2. [docs/01-architecture.md](docs/01-architecture.md) — monorepo layout, multi-tenancy/RLS rules, primitives catalog, local dev, batch/live
3. [docs/03-adding-a-module.md](docs/03-adding-a-module.md) — module anatomy, hard rules, process (when touching/creating modules)
4. [docs/04-build-plan.md](docs/04-build-plan.md) — current milestone and order
5. The relevant `docs/modules/*.md` spec — every module decision is recorded there, dated

## Current state (compact — rewritten 2026-11-05)

**The previous long version of this section is preserved VERBATIM in
[docs/history/claude-md-current-state-2026-11-05.md](docs/history/claude-md-current-state-2026-11-05.md)** — search it
before re-deriving anything below; dated detail newer than that lives in
[docs/history/platform-journal.md](docs/history/platform-journal.md) and in each topic's own doc. When updating this
section, keep it a SUMMARY with pointers: add the dated story to the journal / the topic doc, and only the one-line state here.

### ⚠ Live warnings (read first)
- **NIGHTLY ENCRYPTED PROD BACKUP TO PRIVATE B2 — WORKING, RESTORE PROVEN (2026-11-09)** (`backup-b2.yml`; replaced the
  public-artifact `backup.yml`, docs/12 "FOUND 2026-11-03"). age-encrypted (private key offline with the founder), 30-day
  compliance lock per file; a restore drill matched prod on all 87 tables / 1,236 rows. **GREEN since 2026-11-10** on an
  exact write key (`github-backup-writer-exact`: writeFiles + writeFileRetentions, bucket-only — B2's web UI cannot make one;
  `scripts/b2-create-backup-key.mts`). A red run = a real failed check; docs/12 "Backups". Still run `pnpm backup:prod`
  before every `migrate:prod`.
- **`pnpm migrate:prod` applies EVERY pending file in `supabase/migrations/`, UNTRACKED ones too** (another session's
  uncommitted draft counts — measured 2026-11-10), and has no flag to stop at one. To ship one
  migration while another is in progress, move the other file OUT of the folder, `--dry-run` until only yours is listed, apply,
  move it back. A later version reaching prod first strands earlier ones. A `Failed to read certificate …pgdelta…` trace or
  "failed to cache migrations catalog" warning is the PREVIEW step — the push succeeded if a follow-up `--dry-run` says "Remote
  database is up to date". Do not write SHIPPED until `migrate:prod` ran AND the migration's own prod verifier passed.
- **Pick the verifier to match the migration's shape:** `scripts/prod-verify-migration.ts` checks FUNCTIONS ONLY and passes a
  policy/grant/table migration vacuously. Copy a per-migration `scripts/prod-verify-*.mts` (structure + controls + a rolled-back
  behaviour probe — `prod-verify-feedback.mts` is the newest template). Run it BEFORE and AFTER the apply; the evidence is the
  before/after, not the pass.
- **Revoke before grant, always** (docs/03 #27): prod's `ALTER DEFAULT PRIVILEGES` auto-grants anon/authenticated/service_role
  full rights on every new `public`/`storage` object — **re-measured 2026-11-05, still live after Supabase's 2026-10-30 change**
  (existing projects were not flipped). Every new table/function: `revoke all … from public, anon, authenticated,
  service_role` then grant exactly what is needed; classify it in `scripts/verify-acl-hardening.ts` (prod 17/17 on 2026-11-05)
  and in the data browser (`packages/platform/src/data-browser-modules.ts`, enforced by `data-browser-coverage.test.ts`).
- **A migration must meet an EMPTY database** (CI applies migrations before any seed) — assertion blocks catalog-only.
- **The shared `.git`:** several Claude sessions work in this one tree. `git commit -- <paths>` (never `-A`, and a plain
  `git add <path>` is not enough — the index may hold another session's files); before pushing, `git log --oneline
  origin/master..HEAD` and ask the owner of any commit that is not yours; claim migration version numbers with the other
  sessions first (`ListAgents` → `SendMessage`). Red CI is shared state: one bad migration blocks everyone's deploys.
  **When another session has edits (or a STAGED copy) in a file you also changed** (2026-11-05, worked several times):
  `git commit -- <path>` takes the WHOLE working-tree file, theirs included. Commit only your hunks from a private index:
  `git diff HEAD -- <path> > p` → keep only your hunks → `GIT_INDEX_FILE=<tmp> git read-tree HEAD` → `git apply --cached p`
  → commit with that `GIT_INDEX_FILE` set; then `git reset -q -- <path>` in the real index so it doesn't show a staged revert.
- **`migrate:prod` is gated by Claude Code's auto-mode check ("Production Deploy")** even after the founder approved the
  work earlier in the chat (2026-11-05): it needs his explicit go-ahead for THAT apply in the current turn. Do the backup and
  dry run first, then ask with the dry-run list in hand; never reshape the command to slip past the check.
  **`git push origin master` is gated the same way (2026-11-09), even for docs-only commits** (CI deploys master): list
  `git log origin/master..HEAD` for the founder, ask, and push in the turn where he says "push".
- **The prod Before-User-Created signup hook is ON, deliberately (2026-10-13). Do not switch it off** (docs/21 §7.12.1).
- **Dead Windows profile:** per-user state under `C:\Users\yarmishj` (no suffix) is the OLD profile — stale copies answer
  confidently and wrongly. Use `C:\Users\yarmishj.AEI-LT-JYARMISH`. Its leftover permission entries are the founder's call
  (archive file, "Host state").

### Shipped most recently (newest first; full stories in the linked docs)
- **2026-11-10 (Opus): platform legal slice BUILT — migration `20261114010000_content_reports` NOT on prod** (prod verifier
  `scripts/prod-verify-content-reports.mts` 3/32 before, local 42/1). Public `/report`, `/console/reports`, dashboard tile,
  terms/privacy text, 13+ box. To go live: apply → `scripts/set-content-report-token.mts` → deploy; and set
  `NEXT_PUBLIC_PLATFORM_CONTACT_EMAIL` on Vercel (not set — measured). Module-9 spec §I.
- **2026-11-09 (Sonnet): cost model BUILT — [docs/costs](docs/costs/README.md) + superadmin page `/console/costs`** (no
  migration; pure model `packages/platform/src/cost-model.ts`, prices dated with confidence labels, docs tables generated by
  `scripts/print-cost-model.mts`). Headline: a ~$70–100/mo fixed floor plus cents per user; AI and live video are the only
  costs that scale with people; the setup changes at ~50–300k (files to R2) and ~5M (leave Supabase/Vercel). Several prices
  are labelled assumption/third-party (price-sheet "Conflicts and gaps") — re-fetch before budgeting at 10M+.
  **Second pass same day:** pricing = base fee per org + AI/video credits (founder chose it), break-even + margin, "Use my real
  numbers" (read-only DB counts), editable price what-ifs, own-costs lines at $0 (founder fills in later). Browser-verified
  locally (page loads, button fills, override persists). Not built: actuals ledger, saved scenarios, payments/lateness (docs/costs README).
- **2026-11-09/10 (Opus): vendor accounts page (docs/28 Part A) — `20261113010000` ON PROD, verified 11/28 → 50/0.**
  `/console/vendors` + a dashboard tile; 18 seeded accounts incl. the monthly offsite-snapshot chore (B.8); four
  superadmin-only tables; the database refuses secret-shaped text in every column. Another session's content-reports
  migration (renumbered `20261114010000`, uncommitted) is NOT on prod. docs/28 "Part A AS BUILT"; docs/14's table retired to it.
- **2026-11-05 (Opus): speed-dating host un-tick + camera/mic status table `20261109010000` — ON PROD, verified** (15/22 → 46/0):
  only the person ticks in (database rule now, organizers too); `sd_device_status` + `sd_report_device_status`. The CLIENT half
  is BUILT (Sonnet, `1941f0d`, no migration): the dater's browser reports camera/mic/connection, Ready-board tiles show it
  (stale after 75 s), hosts get the Un-tick button — module-6 spec "THE CLIENT HALF"; docs/26.
- **2026-11-05 (Opus, founder's "do the decided list" session):**
  - **Speed dating "round X of N" follows who is there (`20261107010000` — ON PROD, verified 3/5 → 13/0):** the organizer's
    cap is never rewritten; `sd_events.rounds_expected` is recounted each round, block-free by construction. Module-6 spec
    2026-11-05 (later). **Then every review finding closed** (spec "latest"): the engine now fills byes, so a late
    arrival meets everyone (was 20–83% of events with unmet pairs, `562457b`); side lock `20261110010000` ON PROD 6/6 → 12/0.
  - **Speed-dating SECURITY FOLLOW-UP `20261105010000` — ON PROD, verified** (sd self-rejoin verifier 167/7 → 174/0): a seat's
    `user_id` never changes for a JWT caller; the notes guard runs every lookup and raises once; a note's `pairing_id` must join
    author and subject. Module-6 spec 2026-11-05.
  - **Late check-in bug fixed (`f6fe128`)** — at every event with a round cap, a person checking in after round 1 could never
    be paired (the cap shrank to the early arrivals); prod check 8/8. Same spec entry. (Superseded the same day: the cap is
    no longer shrunk at all — see "round X of N" above.)
  - **Feedback/ticket tool v1 — docs/27 "v1 AS BUILT"** (`20261106010000` — ON PROD, verified 7/24 → 36/0 + a real-browser check 5/5). Author +
    superadmin only, writes through four definers, no org-admin read path.
  - Speed-dating export gains "Safety reports I filed"; turbo typecheck/build for `apps/web`/`apps/worker` now see
    `modules/` and `packages/` (`apps/*/turbo.json` — the old "edits to nail-salon/visual-messaging replay FULL TURBO" gotcha
    is FIXED for typecheck/build); `scripts/verify-activity-capture.mts` fixed (dropped `profiles.email`) and cleans up grace.
- **2026-11-05 (Sonnet):** speed-dating check-in is SELF-ONLY; organizer gets a Ready board and may only un-tick
  (`10aae78`; prod 12/12). Module-6 spec 2026-11-05.
- **2026-11-03/04:** module 9 (photos) planned + four-way reviewed — [docs/modules/module-9-photos-DRAFT.md](docs/modules/module-9-photos-DRAFT.md);
  platform legal items (image takedown, quarantine, 13+ age gate, terms licence) in its §B, **founder decision pending**.
  docs/costs started (founder's cost-tracking requirements).
- **2026-10-19 → 10-29: speed dating made event-runnable on prod** — security sweep (`20261017010000/020000/030000`), closed
  state (`20261027010000`), organizer screens, round cap, check-in, video controls/reconnect (all prod-verified). The
  module-6 spec's entries from 2026-10-19 on, in order; "OPERATIONAL RECIPES" there has the human-test, JaaS-key-rotation and
  prod-check scripts.
- **2026-10-07 → 10-19:** account deletion + silhouette (pg_cron), remove-from-platform, re-signup blocks (docs/21);
  pending invites slices 1–4 (docs/25); vm accept-first seats + decline-and-block (module-4 spec); vm module-role seats
  (`20261015010000`); password recovery and the signup screen's one identical notice (docs/21 §7.12.1).
- **Earlier milestones, all on prod:** email slice / `profiles` is public (docs/22 §23), seat authority + module-role halves
  (docs/19), `module_roles` census closed (docs/24 §6b), rank maps for all six modules (docs/24), engagement monitoring phases
  1–3 (docs/17), Owner Console view-as / data browser / positions / zmanim (docs/13, docs/15, docs/23), JaaS video verified by
  a real two-computer call (module-6 spec, docs/02 "Video"), org deletion (journal 2026-09-28).

### Next / open
**Standing rules:** never start a slice or module build without the founder initiating; every migration/RLS/trigger change
runs the docs/03 #12 rhythm (draft → adversarial review → live verify as real users → RLS tests → docs); **do not block on a
founder decision** — record it where it belongs, flag it, move on (2026-08-29).

**Founder decisions pending / deferred — do NOT start these unprompted:**
- Module 9 photos (module-9 spec). Its platform legal slice (report route, terms, 13+) is BUILT 2026-11-10 — prod apply
  pending; open: §B2 quarantine, closed-report retention, reporters' email (§I). The superadmin dashboard is built.
- **"What's next" → docs/28 B.4a (ranked list) + B.4b (a brief per rank).** Founder 2026-11-10: "do them all", so
  "work on what's next" = start the lowest unfinished rank, one per chat; check its model first. Rank 1 done.
- **Vendor accounts page + dependency/evacuation plans for every external service — docs/28.** Part B is PLANNED
  (2026-11-09, "THE PLAN": build order B.4, drills B.6; costs docs/costs/resilience.md), nothing built, every plan
  UNPRACTISED. Founder decided (B.7): cold now / warm at first client, only he holds access, **no domain until the first
  customer**, Claude runs drills. **Risks R1–R4 are still open**, plus: **uploaded files have NO backup** (the dump has
  `storage.objects` rows, not the files), and **37 plaintext prod dumps sit on the travelling SSD** (F13; BitLocker
  DECLINED by the founder, don't re-propose). Backup DECRYPTION key: PC + a cloud copy, paper copy not yet (docs/28
  B.7; his step-by-step: docs/29). **GitHub two-step is OFF, deferred to the first customer** (with the domain and mail, B.4 #11).
- Two offsite-snapshot files (whole platform; credentials) — **PLANNED, docs/28 B.8** (`age`-encrypted to the B2 key,
  USB stick at home + cloud drive, auto-made, copied monthly, restore drilled quarterly). Not built.
- Speed dating: organizer-invites-then-person-accepts (consent for organizer-created seats; build with docs/25), an always-on
  worker host so rounds advance by themselves (spec "OPERATIONAL RECIPES" #4), help room / live thumbnails (spec
  2026-11-05), names in the organizer roster export. (Host un-tick + camera/mic status: database DONE `20261109010000`;
  the client half is BUILT, `1941f0d`. Open founder call: a migration to drop the stale
  status row of someone who LEAVES THE ORG mid-event — recommended no; module-6 spec 2026-11-05 "THE MIGRATION".)
- Speed dating's role conjunct / audience+mentor seats — blocked on docs/24 §7's second decision.
- Feedback routing to org admins — docs/27's open review (founder item 6).
- Go-live items 4–7 and 9 paused until a real client signs (docs/18); 2FA deferred; custom SMTP is a blocker for onboarding a
  client's users (prod's built-in sender measured at 2 emails/HOUR, docs/18 item 7).
- Wiring `verify-acl-hardening.ts` into CI (friction trade-off, founder opt-in); refining `prod-verify-migration.ts`'s
  definer check (docs/24 §4b); a second superadmin's read scope (docs/12 item 9); whether view-as targets are notified;
  `view_as_sessions` hierarchy narrowing; per-position visibility map (docs/13); whether a removed person leaves pools at once
  (docs/21 §7.11); classroom GA `is_final`/`visible` on own grade; `sal_appointments.notes` client-writable.
- `/privacy` + Terms are a DRAFT awaiting founder review of the wording (docs/18 item 3). The feedback line alone is
  APPROVED (founder 2026-11-05, his wording "Only platform staff read it.", `f576095`).
- The `corepack enable` as Administrator one-off (puts `pnpm` on PATH; workaround in the gotchas below).

**Blocked / deferred by design (do not re-derive — read the doc):** killing the blanket member directory and entity-level
visibility (docs/22 §20 — three-way split, do not merge); Public Square org (docs/20 — v4 withdrawn, `orgs.kind` never
created); principle 8 per-purpose relationship config (docs/00, described-not-built); docs/15 slice 4 defaults-on-join and
entity-level joinPolicy; zmanim action buttons and every pg-boss cron job wait on an always-on worker (prod has none —
`pnpm worker:prod` from the founder's PC is the stopgap; retention prunes do not run on prod meanwhile, docs/17).

**Open, unranked, not founder-gated (small):** `/account`'s Change password form
(`apps/web/app/(app)/account/password-form.tsx`) does not ask for the CURRENT password, so anyone at a signed-in browser
can change it (found 2026-11-04; Supabase's "secure password change"/reauthentication setting is the likely fix); walk-in salon customers cannot be linked to an account (module-5 spec
2026-08-03 finding — read before building); the residual census paths in module tables (docs/24 §6b.1, with docs/22 §20.2);
`cls_set_preferred_name`'s unenrolled-student half and §5's `sd_in_event` status filter (docs/19 2026-09-15 "STILL OPEN");
myzmanim is a TRIAL key (ended 2026-10-24) and prod serves zmanim from cache only — run `scripts/prod-verify-zmanim-schema.mts`
§[7] for the real state (docs/23).
Also open: docs/20 §8.1 (vm_layers cascades; status table docs/20 §28); vm anonymous public view-links (deferred post-v1);
"everywhere role-clarity labels" (founder testing items 31–42 — not in docs/; check `founder-todo.md` / `founder-feedback.md`,
gitignored, only if the founder asks).

### Facts that are easy to get wrong
- **CI/deploy without `gh`:** `printf 'protocol=https\nhost=github.com\n' | git credential fill` gives a bearer token for the
  GitHub REST API (runs, jobs, `curl -L …/jobs/<id>/logs`, `rerun-failed-jobs`); `VERCEL_TOKEN` in `.env.deploy` +
  `GET https://api.vercel.com/v6/deployments?limit=8` (match `meta.githubCommitSha`; READY ⇒ `check` passed). Curl the stable
  alias `https://solutions-platform.vercel.app` (per-deployment URLs 302). A red `check` in `supabase/setup-cli`/`supabase
  start` with `rate limit`/`toomanyrequests` — or `failed to bind host port … address already in use` (2026-11-05, port
  54324 on the runner) — is not your diff — re-run the failed job.
- **CI runs the db suite then e2e on the SAME database with no reset** — reproduce that order before calling a failure a flake;
  db test files run serially (`fileParallelism: false`, do not re-enable); CI e2e is stricter (prebuilt server, 5 s expect).
- **Signing in as a demo user on PROD:** password = `.env.deploy`'s `PROD_DEMO_PASSWORD` (not `.env.accounts`'s 74-char line).
  Prod's superadmin is the founder's real account; `scripts/verify-console-view-as.mts` is 34/35 on prod BY DESIGN.
- **Local migration ledger ≠ schema:** ask the catalog (`pg_proc`, `pg_policy`), not `schema_migrations`; `supabase db reset`
  before treating a local run as a deploy rehearsal (and check no other session is using the database).
- **Editing a pushed migration** costs exactly ONE red CI run (the append-only guard diffs only that push) — acceptable when a
  migration raises at apply time; never `--no-verify`.
- **`.githooks/pre-push`** runs typecheck over the WORKING TREE, so another session's half-written file can block your push —
  wait or ask the founder; never stash/revert their work.
- **The rank map** `docs/rank-admission-map.md` is generated (`node ../../node_modules/vitest/vitest.mjs run
  src/rank-admission.test.ts -u` in `packages/db`) after any rank-gate function; `/console/positions` reads ranks live.
- **`grace@demo.local` must never sign in before e2e** (the engagement e2e asserts she never has): any test/script that signs
  in as her must delete her `login_events`/`login_rollup` rows afterwards with an owner connection (see `rls.test.ts`).
- **Server actions return `{ok, reason}` for expected refusals** — a thrown message is redacted in production (docs/03 #22).
- **Founder working style, model choice, session hygiene:** sections below; the founder's own words on asking questions as
  concrete scenarios are in "Founder profile".

## Hard-won local-dev gotchas (Windows host)

- **A `git push` reporting `cannot lock ref 'refs/heads/master': is at X but expected Y` can
  mean the push actually SUCCEEDED (2026-09-23)** — this repo's `.git` directory is SHARED by
  concurrent sessions (not separate clones), so another session's own git operation can win a
  transient local lock race and produce a misleading error on an otherwise-successful push.
  Don't force-push or retry on the strength of the error text alone: `git fetch` then compare
  `git rev-parse HEAD` against `git rev-parse origin/master` — if they match, it already went
  through. **Same on 2026-10-15 for a push that HUNG for 5+ minutes and printed `Broken pipe`:
  `git ls-remote --heads origin master` showed the commit had landed** (the pre-push hook plus a
  busy machine); stuck `git`/`git-remote-https` processes can be left behind and are harmless. Full story → journal.
- **A file made executable with `chmod +x` can still land in a commit as mode `100644`
  (non-executable) on this host (2026-09-23), even after `git update-index --chmod=+x`.**
  `core.fileMode=false` here means `git commit <pathspec>` re-reads the working tree for a NEW
  file rather than trusting an already-staged index mode change — the chmod silently doesn't
  survive. Harmless for a hook Git for Windows invokes via its own shebang-detection (doesn't
  check the bit), but would matter on a real Linux/Mac clone. Not worth fighting
  `core.fileMode` repo-wide over one file; know it's cosmetic here and move on.
- **⚠ `grep -i` COMBINED WITH `-F` RETURNS ZERO MATCHES ON THIS HOST — IT MANUFACTURES A
  CONFIDENT "NOT FOUND" (GNU grep 3.0, Git Bash, measured 2026-10-07).** Not a quirk of one
  file or one pattern. Reduced to a two-line file:
  ```
  $ printf 'Hello World\nhello world\n' > /tmp/g.txt
  $ grep -F  'hello world' /tmp/g.txt | wc -l   # 1
  $ grep -i  'hello world' /tmp/g.txt | wc -l   # 2
  $ grep -iF 'hello world' /tmp/g.txt | wc -l   # 0   <-- WRONG
  ```
  Any combination containing both flags is affected (`-iF`, `-ilF`, `-rilF`, `-ilFw`); `-il`
  and `-lF` are fine. **This is the vacuity rule as a TOOL DEFECT**, and it is worse than the
  prose version because the output is an empty list rather than a wrong answer — it looks
  exactly like the thing genuinely not existing.
  **It bit a real staleness audit (2026-10-07):** a sweep for in-chat findings not yet written
  down reported `mm_shared_answers` as undocumented when it already appears in **8** places,
  and simultaneously under-reported other patterns — so it produced a false gap AND risked
  masking real ones in the same pass. **This repo audits by grep constantly** (the "is it
  already documented?" check before every doc edit, the staleness sweeps, docs/03's
  search-by-mechanism rule), so the blast radius is wide.
  → **Never pass `-i` and `-F` together.** Use `-F` alone when the pattern is literal (the
  common case — identifiers, function names, file paths), or `-i` alone and accept regex
  metacharacters, or ripgrep. → And when a documentation grep returns ZERO, confirm with a
  second command in a different shape before concluding absence; CLAUDE.md already warns that
  *a grep that HITS is not proof* — this is the inverse and it has a mechanical cause.
- **REPO-WIDE SEARCHES HANG OR TIME OUT; SCOPE THEM (2026-10-15).** The Grep/Glob tools at the repo root
  time out after 20s, and git-bash `grep -r` over `apps/web` ran past 2 minutes — both are walking
  `node_modules`/`.next` on exFAT. Point searches at a specific directory (`supabase/migrations`,
  `apps/web/app`, `packages/db/src`) or a single file. **And from PowerShell, `git commit -F -` with a
  piped here-string does NOT read stdin** — git takes the message as a PATHSPEC and commits nothing
  ("did not match any file(s)"). Write the message to a file and use `-F <file>`.
- **GIT BASH SILENTLY REWRITES ANY ARGUMENT THAT LOOKS LIKE AN ABSOLUTE POSIX PATH, AND IT
  BITES INSIDE `docker exec` AND IN `curl` FORMAT STRINGS (2026-10-02, cost two cycles).**
  MSYS path conversion turns a leading `/foo` into `C:/Program Files/Git/foo` before the
  program ever sees it — and the program is a LINUX one inside a container, or a format
  string, so the rewrite is nonsense. Two shapes seen the same session:
  1. `docker exec <c> psql ... -f /tmp/probe.sql` → **`psql: error: C:/Program Files/Git/tmp/probe.sql: No such file or directory`**. The file was copied in correctly; only the
     ARGUMENT was mangled. Reads as a failed `docker cp`, which is the wrong thing to debug.
  2. `curl -w "/privacy %{http_code}\n"` → printed **`C:/Program Files/Git/privacy 200/n`**.
     Both the leading-slash label AND the `\n` were converted, so the output looks corrupted
     rather than wrong.
  **Fix: prefix the command with `MSYS_NO_PATHCONV=1`** (or double the leading slash:
  `//tmp/probe.sql`). → The tell is `C:/Program Files/Git/` appearing in an error or output
  where you never typed it. Nothing is broken — it is the shell, one layer above the tool you
  are blaming.
  **Same family, a different layer (2026-10-07): psql's `\i file.sql` inside `docker exec`
  reads the file INSIDE THE CONTAINER**, so a script written on the host is "No such file or
  directory" and the transaction aborts — any later output is from the UNMODIFIED database,
  which can look like a successful probe. Pipe the SQL on stdin instead (`cat x.sql |
  docker exec -i ... psql`).
- **"memory allocation of N bytes failed" FROM `next dev`, OR ITS BACKGROUND TASK EXITING 127,
  OR EVEN `cat` RETURNING EXIT 45 WITH NO OUTPUT = WINDOWS' COMMIT LIMIT IS EXHAUSTED, NOT
  YOUR CODE (2026-10-14).** RAM looked free (10.5 GB) while `FreeVirtualMemory` was **0.3 GB
  of 39.4 GB** — 423 processes, led by VS Code (64 procs, 13.3 GB), Docker's `vmmem` (4.7 GB)
  and 8 Claude sessions (3.6 GB). Turbopack (Rust) dies first, then the shell. Check
  `(Get-CimInstance Win32_OperatingSystem).FreeVirtualMemory` before debugging; the fix is the
  founder closing apps/sessions — never kill processes that are not yours. CI is unaffected,
  so a pushed change still gets its e2e run there. **AFTER such a crash the dev server can keep failing even with memory back: `[WebServer] Compaction failed` / `Persisting failed` in the e2e log = Turbopack's cache is corrupted — delete `apps/web/.next/dev` (git-ignored, regenerable) with no server running and retry (2026-10-29). Playwright's own shutdown re-corrupts it, so delete it BEFORE EVERY local e2e run.**
- **NO LOG ACCESS FROM THE TERMINAL FOR PAST PROD ERRORS (tried 2026-10-14, don't retry blind):**
  the Management API `analytics/endpoints/logs.all` is REMOVED (410); its replacement
  `.../analytics/endpoints/logs` answers `Table "postgres_logs" does not exist` with our
  auth-scoped token; Vercel's `/v1/projects/{id}/deployments/{id}/runtime-logs` only STREAMS
  live lines (times out with nothing for the past). What worked instead: read the data
  read-only through the pooler, and REPLAY the failing write as `authenticated` inside a
  rolled-back transaction (`set local role authenticated` + `request.jwt.claims`) to get the
  database's real error. Sentry has the app errors but no API token is configured here.
- **Git Bash quoted heredocs (`<<'EOF'`) can still collapse `\\` to `\`** in a script body
  (hit 2026-10-14: a JS regex `/\\/g` arrived as `/\/g`). Write such files with the editor
  tool, or avoid the backslash (`String.fromCharCode(92)`).
- **NO PYTHON ON THIS HOST, AND THE PERL FALLBACK CORRUPTS FILES SILENTLY (2026-10-07).**
  `python3` opens the Microsoft Store stub. Reaching for `perl -0pi -e 's|...|...|'` instead
  mangled two source files: with `|` as the delimiter, an escaped `\|` inside the pattern
  becomes a regex ALTERNATION, so the pattern matched the empty string at offset 0 and pasted
  the replacement onto line 1. → Use the editor tool for multi-line edits, or a delimiter
  that cannot appear in the text (`s#...#...#`). Read `git diff` after any scripted edit.
- **CONCURRENT SESSIONS MUST CLAIM MIGRATION VERSIONS, AND PROD ORDER IS SHARED (2026-10-07/09).**
  Two sessions picked `20261007040000` minutes apart; it surfaced only as a failed
  `schema_migrations` insert for whichever applied second. → Before writing a migration,
  message any concurrent session with the version you are taking (`ListAgents`, then
  `SendMessage`), and pick a number with gaps. **And a later version reaching prod first
  strands earlier ones:** `db push` refuses an older pending file once a newer one is
  applied. So when another session has pending migrations that sort before yours, ship them
  in ONE `migrate:prod`, theirs first, and read the dry run before treating a go-ahead for
  "my migration" as covering the push — it covers everything pending. A go-ahead relayed by
  another session is not the founder's: get it in your own session.
  **The alternative that worked (2026-10-19), when the EARLIER-sorting set ships alone:** the
  owner of the LATER file moves it out of `supabase/migrations/` (a copy identical to its
  commit kept aside), the other session's dry run proves only its files are listed, it
  applies, then the file goes back and ships in its own push. That order is safe; the reverse
  is not. **Cross-session messages cross**: two plans were swapped back and forth twice, so
  every message should state where the file IS right now, and nobody applies until the dry run
  matches.
- **AFTER `supabase stop`, `supabase start` CAN FAIL ON STUDIO'S MOUNT (2026-10-09):**
  `failed to start docker container "supabase_studio_..." ... mkdir /run/desktop/mnt/host/d: file
  exists`. A Docker Desktop host-mount quirk on D:, not a broken stack; a retry fails the same
  way. **Use `supabase start -x studio`** — tests and the app never need Studio. Note that AUTH
  settings in `config.toml` (e.g. `[auth.hook.*]`, `enable_confirmations`) only load on a
  stop/start, not on `db reset`.
- Node module compile cache corruption makes pnpm OOM-crash at tiny heaps → delete `%TEMP%\node-compile-cache`.
- PowerShell 5.1 `-Encoding utf8` writes a BOM; the Supabase CLI refuses BOM'd `.env` files. Write env files from Node (scripts/dev.ts) or with BOM-less UTF8.
- After `supabase db reset`, Kong can hold a stale route to the recreated auth container (502 on `/auth/v1/*` while `rest` works) → `docker restart supabase_kong_Solutions_Platform`.
- **AUTO MODE'S CLASSIFIER CAN BLOCK `supabase stop`/`start`/`db reset` EVEN WITH AN EXISTING
  BROAD `Bash(pnpm exec *)` ALLOW RULE ALREADY MATCHING IT (2026-09-06).** The denial names
  "the auto mode classifier," not a permission-prefix mismatch — and adding a MORE SPECIFIC
  `permissions.allow` entry (e.g. `Bash(pnpm exec supabase stop)`) does NOT clear it either,
  because the classifier is a SEPARATE mechanism from prefix-matched Bash permissions. **The
  actual fix is a different settings key: `autoMode.allow`** (an array of natural-language
  strings describing the allowed action, evaluated by the classifier itself — include
  `"$defaults"` as the first entry to keep the built-in rules). Even after adding the right
  `autoMode.allow` entry, editing `.claude/settings.local.json` ITSELF got blocked by the same
  classifier on the first attempt — self-modifying permission grants is treated as sensitive
  too — but succeeded on retry after the founder explicitly said so in chat. This is
  session/machine-local settings, not something the repo carries.
  **REFINEMENT 2026-09-11: the `autoMode.allow` entries for `supabase db reset` / `start` /
  `stop` ARE ALREADY PRESENT in `.claude/settings.local.json` — so a block is probably NOT a
  missing permission, it is the SHAPE OF YOUR COMMAND.** `cd "D:/..." && export PATH=... &&
  corepack pnpm exec supabase db reset 2>&1 | tail -20` was blocked; the identical action as
  a bare `corepack pnpm exec supabase db reset`, with the `cd` done in a *previous* call (the
  Bash tool's working directory persists), ran fine. The classifier reads the compound form —
  chained `&&`, a PATH export pointing at a temp dir, a pipe — as a different and more
  suspicious action than the allowed one. **Run privileged/lifecycle commands PLAINLY and on
  their own line before concluding the permission is missing**, and do not add a duplicate
  `autoMode.allow` entry for something already covered.
- **Resolving a path from `import.meta.url` — TWO traps on this host, same family.**
  `import.meta.dirname` is `undefined` under tsx; and **`new URL('...', import.meta.url).pathname`
  leaves the space in `D:\Solutions Platform` PERCENT-ENCODED**, so anything written through it
  lands in a phantom `D:\Solutions%20Platform\` that git never sees and nobody ever looks in.
  Hit 2026-08-09 writing the rank map: the test reported "snapshot written" and passed, and the
  file simply was not in the repo. **Always `dirname(fileURLToPath(import.meta.url))`** — it
  decodes. The failure is silent and looks like success, which is what makes it worth a bullet.
- Docker Desktop's WSL backend crashed under parallel image pulls → `C:\Users\yarmishj\.wslconfig` caps WSL at 8GB/4CPU (delete to revert); pull images sequentially if it recurs; zero-log segfaulting containers (exit 139) = corrupted image layers, `docker rmi` + re-pull.
- **DOCKER DESKTOP CAN COME BACK UP IN *WINDOWS CONTAINERS* MODE, AND IT LOOKS EXACTLY LIKE THE
  ENGINE BEING DEAD (2026-08-11).** Symptom: every `docker` command returns
  *"request returned 500 Internal Server Error … dockerDesktop**Windows**Engine … check if the
  server supports the requested API version"*, and — the part that sends you down a rabbit hole —
  **`wsl --list --verbose` reports "has no installed distributions"** and
  `C:\ProgramData\DockerDesktop\vm-data` is MISSING. It reads as total loss of the Linux VM,
  images and volumes. **It is not: nothing is lost.** In Windows-containers mode the Linux distro
  is simply not registered. **Diagnose with `docker context ls`** — if the starred context is
  `desktop-windows` (and no `desktop-linux` exists) this is it, not the 2026-08-09 crash below.
  **Fix: `& "$env:ProgramFiles\Docker\Docker\DockerCli.exe" -SwitchDaemon`, then FULLY restart
  Docker Desktop** (stop `Docker Desktop`/`com.docker.backend`/`com.docker.build`, relaunch) — the
  switch alone left the Linux engine still 500ing. Everything returns healthy with volumes intact;
  Kong still needs its usual restart afterwards. **Distinguishing rule: a 500 naming an ENGINE PIPE
  is a mode/provisioning problem; "cannot find the file specified" on the pipe is the engine being
  genuinely gone (below).**
- **IF SEVERAL TOOLS LOOK "MISSING" AT ONCE, CHECK WHICH WINDOWS PROFILE YOU ARE IN BEFORE
  DIAGNOSING ANYTHING ELSE — `$env:USERPROFILE` (2026-08-11).** After the founder was forced to
  restart the machine, a session came up under `C:\Users\yarmishj.AEI-LT-JYARMISH` instead of the
  normal `C:\Users\yarmishj`, and THREE tools appeared to vanish simultaneously: `pnpm` off PATH,
  Playwright's browser binary gone, and `wsl --list --verbose` reporting *"no installed
  distributions"*. **NOTHING WAS LOST OR CORRUPTED.** All three are PER-USER state sitting in the
  other profile — `AppData\Local\pnpm`, `AppData\Local\ms-playwright` (holding the exact
  `chromium_headless_shell-1228` that was reported missing), and WSL's distro registration, which
  lives in **HKCU**. Docker Desktop's settings are per-user too (`%APPDATA%\Docker`), which is very
  likely why it also came up in the wrong container mode.
  **A profile name carrying a `.MACHINE`/`.DOMAIN` suffix is Windows saying it could not load the
  real profile and created a new one** — so every per-user install, PATH entry and cache is absent
  by definition, and anything saved to "Desktop"/"Documents" lands where the founder will not find
  it. **TELL THE FOUNDER IMMEDIATELY rather than working around it**, because it affects far more
  than this repo. If you must proceed anyway: corepack for pnpm, `playwright install chromium`.
  **Do NOT write this up as tool-state loss or corruption — this entry exists because that was the
  first (wrong) diagnosis, and it would have sent the next session hunting a phantom.**
  **Two more per-profile gaps found under this same new profile, 2026-08-16 — same root cause, don't
  re-diagnose as something new:**
  1. **The `docker-users` local group only listed the OLD profile's identities** (`jyarmish`,
     `NXE\YarmishJ`), not `aei-lt-jyarmish\yarmishj`, so Docker Desktop refused to treat this account
     as a Docker admin. Fix (needs an ELEVATED prompt, which Claude cannot grant itself — this is on
     the founder): `net localgroup docker-users "aei-lt-jyarmish\yarmishj" /add`, then **sign out and
     back in** (or reboot) — group membership only takes effect in a fresh login token.
  2. Separately, this Docker Desktop install had never had the Windows **Hyper-V** and **Containers**
     optional features turned on at all (`Enable-WindowsOptionalFeature -Online -FeatureName
     Microsoft-Hyper-V,Containers -All`, elevated, then a full reboot). Unclear whether this is a
     THIRD per-profile-migration casualty or just a fresh-install gap that was never hit before — not
     worth re-deriving, just know Docker Desktop will say so plainly ("Windows containers feature is
     disabled") and name the fix itself.
- **A CRASHED `com.docker.backend` CAN BALLOON TO 13+GB AND SILENTLY STARVE EVERY SUBSEQUENT LAUNCH
  ATTEMPT (2026-08-16).** Symptom: Docker Desktop shows an "unexpected error, needs to close" dialog on
  launch, the engine pipe never comes up, and each RETRY fails the same way — looking like a
  fundamentally broken install. **The actual cause: the CRASHED instance from the PREVIOUS attempt
  doesn't release its memory when the crash dialog appears** — `Get-Process com.docker.backend` showed
  13.8GB resident (normal idle is a few hundred MB), which alone accounted for the difference between
  31GB total and 1.5GB FREE. Every relaunch attempt then starved for memory and crashed again,
  indistinguishable from a genuine install problem. **Fix: before retrying a launch, always check
  first** — `Get-Process -Name "com.docker.backend","com.docker.build","Docker Desktop" | Stop-Process
  -Force`, confirm free memory recovers (`Get-CimInstance Win32_OperatingSystem` →
  `FreePhysicalMemory`), THEN relaunch. Same family as the documented "Docker Desktop dies under
  session memory pressure" gotcha below, but the causality here runs the other way — the crash caused
  the memory pressure, not the reverse — so don't assume freeing RAM elsewhere first will help; check
  for a stray `com.docker.backend` specifically.
- **DOCKER CAN FAIL TO BIND A SUPABASE PORT WITH "forbidden by its access permissions" EVEN
  THOUGH NOTHING IS USING IT (2026-08-28).** After Docker Desktop wasn't running and was started
  fresh, `supabase start` failed recreating the db container: `listen tcp 0.0.0.0:54322: bind: An
  attempt was made to access a socket in a way forbidden by its access permissions.` `docker
  inspect`/`Get-NetTCPConnection` both confirmed nothing was actually listening on that port — this
  is NOT "port in use." **Cause: Windows had 54322 inside a Hyper-V/WSL dynamic TCP port EXCLUSION
  range** (`netsh interface ipv4 show excludedportrange protocol=tcp` — look for a range spanning
  the port; ours was `54238-54337`), which blocks any process from binding it regardless of whether
  anything holds it. A full Docker Desktop restart and even `wsl --shutdown` did NOT clear it.
  **Fix (needs an ELEVATED prompt — same category as the `docker-users` group gotcha, on the
  founder): `net stop winnat` then `net start winnat`**, which resets Windows' NAT service and
  regenerates the exclusion list without that port. Confirmed the range was gone via the same
  `netsh` command immediately after, then `supabase start` succeeded on the next try with no other
  changes. **Do not mistake this for the "Kong stale route" or "Windows-containers mode" gotchas
  above — the tell is the literal string "forbidden by its access permissions" on a bind, paired
  with a confirmed-empty port.**
- **A HANGING `git push` IS USUALLY A CREDENTIAL DIALOG WAITING ON THE FOUNDER'S DESKTOP, NOT A
  NETWORK PROBLEM (2026-08-11 — cost ~10 minutes across two timeouts).** `git push` produced NO
  output and hit a 3-minute and then a 7-minute timeout, while `git ls-remote --heads origin`
  returned instantly — which rules out network and read auth and makes it look like a hung remote.
  **The tell: `Get-Process | Where-Object { $_.Name -match "git|credential" }` showed
  `GitHub.UI` with MainWindowTitle "Connect to GitHub".** Git Credential Manager
  (`credential.helper=manager-core`) had opened an interactive auth window that only the founder
  can see and complete; `GIT_TERMINAL_PROMPT=0` does NOT prevent it, because it is a GUI prompt
  rather than a terminal one. **Check for that window before diagnosing anything else, and tell the
  founder it is waiting — they cannot know otherwise.** There are no hooks in `.git/hooks`, so rule
  that out cheaply too.
- **`pnpm` MAY NOT BE ON PATH, while `corepack` is (2026-08-11).** `pnpm : The term 'pnpm' is not
  recognized`, yet `corepack pnpm --version` prints 10.34.3. **`corepack pnpm <cmd>` is NOT a
  workaround** — the repo's own scripts shell out to bare `pnpm` (`pnpm --filter @platform/db
  seed`), so it fails one level down with a confusing "'pnpm' is not recognized" from inside a
  script that appeared to start fine. **`corepack enable` needs admin** (`EPERM … 'C:\Program
  Files\nodejs\pnpx'`). **DEFERRED FOUNDER ACTION (agreed 2026-09-04, not urgent): run `corepack enable` ONCE AS ADMINISTRATOR** and this whole bullet stops applying — `pnpm` lands on PATH permanently instead of every session rebuilding a throwaway shim. Needs elevation, which Claude cannot grant itself. Until then, the workaround below is the standing procedure, not a bug.
  Non-admin fix: `corepack enable --install-directory <writable dir>` then
  prepend that dir to `$env:PATH` in EVERY command (shell state does not persist between tool
  calls). **Two details that cost time on 2026-09-04: the directory must ALREADY EXIST** (`mkdir -p`
  it first, or corepack dies with a misleading `Internal Error: ENOENT ... lstat '<dir>'` that reads
  like a corepack bug), **and put the shim OUTSIDE the repo** (the session scratchpad is ideal) —
  created inside it, it shows up as an untracked directory that a careless `git add` would commit.
  From bash, reference it by POSIX path (`/c/Users/...`), not the `C:/Users/YARMIS~1.AEI` 8.3 short
  form, which bash will not resolve on `PATH`. Appeared in the same session as the Docker mode flip, so suspect a common cause if both
  show up together. **TURBO'S SYMPTOM FOR THIS IS UNRECOGNISABLE — `x Unable to find package
  manager binary: cannot find binary path` (2026-08-29).** It names neither `pnpm` nor PATH, and
  it fails the whole `turbo run` before any task starts, so it reads as a broken turbo install.
  It is only this. Same fix: prepend the shim dir to PATH in the same command
  (`export PATH="<dir>:$PATH" && pnpm exec turbo run typecheck --concurrency=1`).
- **DOCKER DESKTOP CAN DIE OUTRIGHT UNDER A LONG SESSION'S MEMORY PRESSURE, and the symptom
  reads as a test failure (2026-08-09).** After a session of resets + builds + Playwright runs,
  the db suite reported `ECONNREFUSED 127.0.0.1:54321/54322` and 104 tests SKIPPED — which
  looks like a broken diff and is not. `docker ps` then failed with *"failed to connect to the
  docker API … dockerDesktopLinuxEngine: The system cannot find the file specified"* — the
  ENGINE was gone, not the containers. Tell-tales that precede it: `supabase db reset` hanging
  with an EMPTY log and the db container's uptime NOT resetting (a real reset recreates it),
  and `bash: fork: Resource temporarily unavailable`. **Fix: `Start-Process "$env:ProgramFiles\
  Docker\Docker\Docker Desktop.exe"`, wait ~10s, then restart Kong** (the containers
  auto-restart and Postgres keeps its volume, so reset+seed state survives — but Kong's auth
  route goes stale exactly as after a `db:reset`). Free RAM measured AFTER the crash looks
  healthy (11GB of 31GB), which is misleading: it is free BECAUSE Docker died. Same family as
  the OOM entries below — **any all-tests-fail-at-connection result is infrastructure, never
  code.**
- **A `>>> FULL TURBO` TEST RESULT AFTER A MIGRATION IS A CACHED REPLAY, NOT A RUN (2026-08-09).**
  `turbo run test` reported `Cached: 5 cached, 5 total >>> FULL TURBO` and "109/109 passed"
  immediately after a `db reset` applied a new migration — and the db suite had not executed at
  all; the timestamp in its replayed log predated the change. **Turbo's cache key cannot include
  database state**, so any suite that asserts against Postgres (the whole `@platform/db` package)
  will happily replay a stale pass after a schema change. Caught only because a reviewer noticed
  the new tables were empty when 11 seeded users should have filled them. → **After any migration,
  run `pnpm --filter @platform/db test` directly** (or `turbo run test --force`), and treat
  `FULL TURBO` on a DB-backed suite as "did not run". Same family as the tally rule in docs/03:
  before reporting a number, produce it.
- **`turbo run typecheck` DOES NOT SEE EDITS TO `modules/nail-salon` OR `modules/visual-messaging`
  — it reports `FULL TURBO` 9/9 having typechecked none of your change (2026-09-04).** Those are
  the only two modules with **no `package.json`** (the other five have one), so they are not turbo
  workspace packages; they are compiled only through `apps/web`'s `tsc` via the `@modules/*` path
  alias. `turbo.json`'s `typecheck` task declares no `inputs`, so turbo keys the cache on each
  package's OWN directory — and those two directories are outside every package, so editing them
  invalidates nothing. **After touching either module, run `pnpm exec turbo run typecheck
  --concurrency=1 --force`** (a real run is ~35s vs `151ms >>> FULL TURBO`, which is the tell).
  Same "cache cannot see the thing that changed" family as the DB-suite bullet above, different
  cause — and note the DB rule is about database state while this one is about files, so the
  usual `--force` habit for migrations does not cover it. **FIXED 2026-11-05:** `apps/web/turbo.json`
  and `apps/worker/turbo.json` declare `$TURBO_ROOT$/modules/**`, `packages/**` and
  `tsconfig.base.json` as `typecheck`/`build` inputs (it was wider than these two modules: every
  module's `ui/` is compiled only through `apps/web`). Measured: a one-line nail-salon edit now
  gives `web:typecheck: cache miss`. The DB-suite `FULL TURBO` rule above is unaffected.
- **`pnpm test` OOM-crashes on this host under turbo's 5-way parallelism** (`FATAL ERROR:
  Committing semi space failed`, at absurdly small heaps with ~7GB free). It is NOT the
  `node-compile-cache` corruption below — clearing that does not help. **Use `pnpm exec turbo
  run test --concurrency=1`.** Never read a parallel-run failure as a real one. The same
  applies to `typecheck` and `build` (exit code **134** = SIGABRT is this, not a type error).
  **⚠ BUT A 134 DOES NOT TELL YOU WHICH OF THREE THINGS IT IS, AND ONE OF THEM IS THE
  DATABASE ABOUT TO VANISH (2026-10-02, two sessions the same day).** Measured cases:
  (a) `pnpm --filter web build` exited 134 and **Docker's engine died minutes later**, taking
  Supabase with it — one memory-pressure event, not two; (b) a concurrent session's
  `turbo run build` exited 134 where **`--concurrency=1` was NOT enough** and
  `NODE_OPTIONS=--max-old-space-size=6144` with a direct `pnpm run build` in `apps/web` fixed
  it, with Docker healthy for the rest of that session (**reported by that session, not measured
  here**); (c) the same build then succeeded on a plain retry after deleting
  `%TEMP%
ode-compile-cache`. **So `--concurrency=1` is not a universal fix and "134 means
  Docker is dying" is not a rule either.** The discriminator is one command, so run it before
  choosing a remedy: **`docker ps`.** If the engine answers, it is a heap problem (clear the
  compile cache, then the heap flag). If it reports *"cannot find the file specified"* on
  `dockerDesktopLinuxEngine`, the engine is gone and your next test run will fail wholesale for
  that reason instead — see the Docker entries above, and restart Kong afterwards.
- **THE WHOLE E2E SUITE FAILING IS ALWAYS INFRASTRUCTURE, NEVER YOUR DIFF — and there are FOUR
  causes that look identical at the summary line.** (Merged 2026-08-11 from three separate entries;
  they kept being written as if each were the only one, which is exactly what makes the summary
  line misleading.) **READ THE PER-TEST ERROR FIRST — it names which of the four this is, and only
  the first two are worth any worry:**
  1. **`ERR_CONNECTION_REFUSED` + `FATAL ERROR: ... JavaScript heap out of memory` in the
     `[WebServer]` lines (2026-08-09)** — the full suite OOMs the `pnpm dev` server. A PARTIAL run
     is the same cause: tests pass until it dies, then everything after fails. Clearing
     `%TEMP%\node-compile-cache` does NOT help. **Fix: run it the way CI does —
     `CI=true pnpm --filter web exec playwright test`, having built first.** That serves the
     PREBUILT app (`pnpm start`) instead of JIT-compiling routes: far lighter on memory, and the
     STRICTER config (5s expect, 30s test, retries 1).
  2. **Stuck on `Working…` at sign-in (2026-08-06)** — auth, two sub-causes. **(a) A stale dev
     server**: the local Playwright config REUSES whatever is already on :3000, and one left from a
     session three days earlier silently served every run. `netstat -ano | grep :3000` then
     `Get-CimInstance Win32_Process -Filter "ProcessId=N"` shows its **CreationDate**; if it
     predates your work, kill it. **(b) Kong's stale auth route after `db:reset`** —
     `docker restart supabase_kong_...` must come AFTER the reset, since resetting recreates the
     auth container and re-stales the route.
  3. **`browserType.launch: Executable doesn't exist at …\ms-playwright\chromium_headless_shell-…`
     (2026-08-11)** — the browser binary is simply not installed. The app builds, the server
     starts, the seed succeeds. **Fix: `pnpm --filter web exec playwright install chromium`.**
  **A FIFTH, AND IT BLOCKS THE RUN BEFORE ANY TEST: `http://localhost:3000/login is already
  used` (2026-10-02).** Under `CI=true` the config sets `reuseExistingServer: false`, so
  Playwright refuses to start when anything holds :3000 — and its OWN `next start` webserver
  **outlives a killed or timed-out run**, so the usual cause is your own previous attempt, not a
  stale dev server. **Check whose it is before killing it:** `netstat -ano | grep ":3000"` for
  the pid, then `Get-CimInstance Win32_Process -Filter "ProcessId=N"` and read `CommandLine` —
  **`next start` is a Playwright orphan and safe to kill; `next dev` is a live session's server
  and is not yours to touch** (with two sessions sharing this tree, that distinction matters).
  **(2026-10-26) A `next start` that is NOT yours may be ANOTHER SESSION'S live e2e run** (its Playwright
  processes are running too): do not kill it. Serve YOUR build on another port — `pnpm exec next start -p 3100`
  plus a throwaway `playwright.config` with `baseURL: 'http://localhost:3100'` and no `webServer` — and delete both
  afterwards. **And do not run `pnpm build` while another session's server is up: you overwrite the `.next` it is
  serving.**
  4. **Docker not actually running** — see the Docker entries above; a dead or wrong-mode engine
     takes the database with it.
  **Measure, don't theorise** (the 2026-08-06 lesson cost an hour): `curl -X POST
  "$SUPABASE_URL/auth/v1/token?grant_type=password" -H "apikey: $ANON" -d
  '{"email":"owner@demo.local","password":"password123"}'` — 502 is Kong, 400 means the seed did
  not run, 200 means auth is fine and the problem is the app server. **Working order: `db:reset` →
  restart Kong → `seed` → curl says 200 → build → run.**
  **And do NOT pipe the run through `Select-Object -Last N` / `tail`** — it truncates away the
  per-test error (the only thing that distinguishes the four) and leaves a trailing list of test
  names that reads as a mysterious mass failure. Redirect to a file and grep it; the same rule
  already stated below for exit codes applies to diagnosing causes.
- **A PLAYWRIGHT FAILURE THAT PRINTS THE ELEMENT IT SAYS IS NOT VISIBLE IS A STRICT-MODE
  AMBIGUITY, NOT A MISSING ELEMENT (2026-10-02).** `expect(locator).toBeVisible() failed` whose
  body then lists `1) <td ...>6:00 PM</td> ... 2) <td ...>6:00 PM</td>` is saying the locator
  matched TWO elements, so strict mode refused — the content is right there on the page. Read
  the candidate list: if it enumerates matches, the fix is a narrower locator, never a timeout,
  a retry, or a hunt for a rendering bug.
  **The worked case, because it recurs ANNUALLY and reads as a real break:** the two synagogue
  tests assert `getByText('6:00 PM')`, which is the weekday `Mincha` FIXED 18:00 rule. Shabbat's
  `Mincha & Kabbolas Shabbos` is `sunset - 20, rounded DOWN to 5 minutes` — so in the weeks when
  sunset lands in 18:20-18:24 it renders *exactly* 6:00 PM and collides. **Measured 2026-10-02:
  sunset 6:24 PM, two cells reading 6:00 PM, both tests red on a diff that could not possibly
  touch them — and the DRIFT IS DEMONSTRATED, not just asserted: the same two tests were GREEN
  two days earlier on `2c90590`, when the zman landed on 6:05** (one of the two needs NO LOGIN at all, which is the tell that it is not your
  auth/RLS change). It passes again as soon as sunset drifts a few minutes — so it will look
  like a flake that "fixed itself", and come back next autumn and each spring.
  **Fixed properly rather than waited out:** both now match the row whose label cell is exactly
  `Mincha`, which also excludes `Mincha (winter)` and is strictly STRONGER than the old
  assertion — it proves the fixed rule rendered, not merely that some cell says 6:00 PM.
  **The general rule: an assertion on a formatted TIME or other computed display value is a
  collision waiting to happen** — scope it to its row, and remember a zman-derived value can
  wander onto a fixed one on any given date.
- **A RED `check` JOB DYING IN `pnpm exec supabase start` WITH `toomanyrequests` (2026-10-27, twice in a row, on `supabase/imgproxy`) IS A REGISTRY RATE LIMIT, NOT YOUR DIFF** — no db/e2e test ran and `deploy` is skipped, so prod keeps the previous build. Re-run the failed job (`POST .../actions/runs/<id>/rerun-failed-jobs`); the third attempt passed. **DONE 2026-10-29 (founder approved): ci.yml now runs `supabase start -x imgproxy`** (nothing uses image transforms). Other images can still hit the limit; the rerun advice stands.
- **A RANDOM RED `check` JOB AT THE rls.test.ts "CI-ORDER GUARD" ("org_members differs from snapshot") WAS PARALLEL DB TEST FILES (2026-10-22):** several files commit rows to the shared database while that block snapshots `org_members`. Fixed by `fileParallelism: false` in `packages/db/vitest.config.ts` (docs/12 addendum 2026-10-22). Do not re-enable parallelism; scope a file's writes to a throwaway org in a rolled-back transaction instead.
- **Do NOT edit app source while the e2e suite is running** (the local config serves
  `pnpm dev`, so an edit lands mid-run on a half-compiled app). Editing `docs/*.md` is safe.
  Related: piping the run through `| tail -N` swallows its exit code, so a failing suite
  reports success to the shell — redirect to a file and check `$?` instead.
- **Reproducing a flaky/order-dependent e2e failure: `db:reset` + `pnpm seed` immediately before the reproduction run, not just once at the start of the session.** Several e2e tests are documented non-idempotent (assume fresh seed state). Running a suspect test in isolation first (to confirm it currently passes) mutates that seed data; a subsequent full-suite reproduction attempt then fails for the mundane reason of stale state from your OWN prior run — which looks like the bug you're chasing but isn't (hit in a 2026-07-30 session validating the speed-dating flaky-test fix: an isolated run advanced the seeded event to `complete`, then the very next full-suite run failed at the first "Register" step instead of reproducing the real timing issue).
  **THE SAME TRAP APPLIES TO RUNNING THE FULL SUITE TWICE IN A ROW, not just an isolated test then the
  full suite (2026-08-16).** Running the complete e2e suite once, then again immediately without a
  `db:reset`+`seed` in between, produced 11 failures on the second run (down from 1) — every one of
  them stale-seed-state noise, not real bugs (bookings/matches/etc. the first run had already advanced
  past their starting state). **Verify a fix with exactly ONE clean run against freshly reset+seeded
  data, never a second consecutive full run on the same stack.**
- ~~**PHASE 2's RLS SUITE AND STANDALONE PROBE SCRIPT BOTH SIGN IN AS `grace@demo.local` — AND
  PHASE 3's E2E SUITE DEPENDS ON HER NEVER HAVING SIGNED IN.**~~ **FIXED 2026-08-20, and it was NOT
  a flake — it broke CI deterministically, every run.** Grace is the seed's *only* scoped nail-salon
  manager grant (`packages/db/src/seed.ts`), so `rls.test.ts`'s phase-2 block needs her as a real
  signed-in user to prove a SCOPED `{role, scope_ref}` pair survives the write path — but
  `apps/web/e2e/platform.spec.ts`'s phase-3 engagement test picks her BECAUSE she's an active member
  "this whole e2e suite never signs in as," and asserts she reads "never signed in." A real password
  sign-in advances her `last_sign_in_at`, which phase 1's capture trigger faithfully records. **This
  looked like it might be environment-specific flakiness — it passed clean in two separate local
  reproductions before the real mechanism was found** — but `.github/workflows/ci.yml` runs
  `pnpm --filter @platform/db test` immediately before `pnpm test:e2e` on the SAME database with NO
  reset in between, so it is 100% deterministic in CI, not a flake at all: the GitHub Actions run for
  `d653d4d` failed on exactly this test, and reproducing CI's literal step order locally (reset →
  seed → db test → e2e, no reset) reproduced the failure on demand. **Fixed at the root**: the
  phase-2 describe block's own `afterAll` now deletes grace's `login_events`/`login_rollup` rows via
  a raw owner-level connection (both tables are read-only to every api role including the superadmin,
  so this can't go through the ordinary RLS client) — the suite that dirties her state now cleans it
  up itself, so no downstream test ever sees the pollution regardless of run order. Verified by
  reproducing the exact CI sequence locally post-fix: 139/139 db, then 51/51 e2e, no reset between.
  **⚠ IT RECURRED 2026-10-02, AND THE LESSON IS THAT THE FIX DOES NOT GENERALISE — IT IS
  PER-BLOCK.** The census slice added a new `describe` that signs in as grace (she is the only
  plain-org-member holder of a SCOPED rank-2 grant, so the only subject that can isolate
  `module_has_manager_grant` from `is_org_admin`), and broke the SAME e2e test again. **The
  2026-08-20 fix is an `afterAll` on ONE block; it protects nothing else**, and a new block at
  the END of the file is strictly worse than the old one, because its pollution lands after the
  original's cleanup has already run. Found by running CI's exact order, not by review —
  neither adversarial reviewer looked at fixture side effects. → **Before signing in as grace
  anywhere, copy that `afterAll`** (raw owner connection; both tables are read-only to every
  api role including the superadmin, so an RLS client cannot do it). → And verify the cleanup
  with a CONTROL, or the check is vacuous: assert grace has 0 rows **and that other users have
  some** (measured: grace 0, ten other users non-zero), otherwise a dead capture trigger reads
  as a successful cleanup.
  **`scripts/verify-activity-capture.mts` still signs in as grace with no equivalent cleanup** — it's
  a standalone script never run by CI, but running it by hand before e2e with no reset in between
  will still reintroduce this. A `db:reset`+`seed` before e2e fixes it same as it always did (a
  targeted `delete from login_events/login_rollup where user_id = <grace>` also works and is faster,
  but only fixes that one run — a full reset is what
  actually restores a clean baseline for everything downstream, including e2e's own well-known
  non-idempotence).
- **`Prefer: return=representation` on an INSERT makes PostgREST also SELECT the row back —
  which fails with a generic RLS 42501 if the table has no self-read policy, even though the
  INSERT itself would have succeeded (2026-08-21).** Manually proving activity-capture worked on
  prod via a raw `curl` insert (as a real demo user, mirroring `recordActivity()`) failed with
  "new row violates row-level security policy," reproduced even locally — which correctly pointed
  at "my request differs from the app's," not "prod is broken." `activity_events` (like
  `login_events`/`superadmin_lookup_log`) deliberately has NO `user_id = auth.uid()` self-read
  arm, superadmin-only by design (§7.1's rank-0 trap) — so PostgREST's implicit post-insert SELECT
  has nothing to read and the whole request reports as an RLS failure. The real `recordActivity()`
  helper never chains `.select()` / requests representation, so it was never at risk; the bug was
  in the manual test, not the migration. **When hand-verifying an insert-only, no-self-read table
  via `curl`/PostgREST directly: omit `Prefer: return=representation`, or the false negative will
  send you hunting a schema bug that isn't there.** **The same mechanism, same false negative,
  shows up in raw SQL too, not just PostgREST** — this is how the true cause was actually found:
  a diagnostic `insert into activity_events (...) values (...) returning *` via a raw
  `postgres.js` connection (simulating the caller's session with `set local role authenticated`
  + `request.jwt.claims`) hit the identical 42501, for the identical reason — `RETURNING`
  requires the same SELECT-policy check as reading the row back afterward, regardless of whether
  the read-back is requested via PostgREST's `Prefer` header or SQL's own `RETURNING` clause.
  Dropping `RETURNING *` (or `RETURNING` any column) from a raw-SQL insert probe on a
  no-self-read table fixes the false negative exactly like dropping the `Prefer` header does over
  HTTP — same root cause, two different surfaces.**
- **`ON DELETE SET NULL` fires the referencing table's BEFORE UPDATE triggers** — Postgres implements the FK action as a real UPDATE. So an append-only `before update or delete ... raise exception` trigger silently makes every row the table has ever referenced UNDELETABLE (the parent DELETE aborts), including whole orgs via a cascading `org_id`. Enforce append-only with GRANTS instead (no UPDATE/DELETE to api roles → `42501`), which is why `vm_moderation_log` has no such trigger. Found live in the 2026-07-31 view-as review, one review after `set null` had been (correctly) required.
- **A passing NEGATIVE assertion proves nothing unless something nearby proves the subject
  exists** — the vacuity rule, generalised in docs/03 after it appeared three times in one
  session in three unrecognisably different forms (an RLS check on an empty table, a
  catalog query whose view silently excluded the `auth` schema and returned zero rows, and
  a `not.toBeVisible()` on text a wording change had deleted everywhere). A vacuous test
  does not just miss a bug, it reports the bug's absence. Full version + the three worked
  cases: docs/03 "Test discipline".
- **Don't edit files while a backgrounded `git add -A && git commit` is in flight** — the
  add races the edit and the change silently misses the commit while `git log` looks
  correct. Hit 2026-08-03; caught only because the next step grepped `git show HEAD` for
  the change rather than trusting that the commit had run.
- **NEVER `git add -A` WHEN ANOTHER CLAUDE SESSION MAY BE WORKING IN THIS REPO — STAGE PATHS
  EXPLICITLY (2026-08-09).** Two windows on one repo is normal here (it is why log-session needs a
  nonce probe), and `-A` stages THEIR in-progress work too. Hit live: a 3-line CLAUDE.md fix
  committed and pushed a concurrent session's unfinished 269-line `apps/web/lib/engagement.ts`
  under a docs message that never mentioned it. **It fails SILENTLY in the worst direction** — the
  commit succeeds, `git log` looks clean, and had that file not compiled, master would have gone
  red with the blame pointing at the wrong session. → `git add <path>` for what you actually
  touched, and read the commit's file count: if it exceeds what you edited, stop before pushing.
  → Corollary: once you tell the founder a session is finished, treat the repo as handed over.
  **AND `git add <path>` IS NOT ENOUGH — IT HAPPENED AGAIN 2026-09-04, THIS TIME WITH EXPLICIT
  PATHS.** `git commit` commits the whole INDEX, not just what you staged, so if the other session
  has already run `git add` on its own files, your explicit-path staging is irrelevant and their
  work rides along. Commit `33d5f20` is a 2-file docs change that shipped a concurrent session's
  230-line in-progress `video-room.tsx` plus two more of its files, under a message describing
  none of them. **The check that catches it was RUN and IGNORED:** `git diff --cached --name-only`
  printed five paths when two were expected, one command before the commit. → **Use a pathspec on
  the commit itself — `git commit -- <paths>` — which ignores everything else in the index**; or if
  you print `git diff --cached`, actually read the count and stop when it exceeds what you touched.
  → **The PUSH has the same trap (2026-10-19): `.git` is shared, so `git push` of master sends EVERY
  session's unpushed commits** — a pathspec only controls what YOU commit. A session nearly shipped
  another's app code before that session's migration was on prod. Before pushing, run
  `git log --oneline origin/master..HEAD` and ask the owner of any commit that is not yours.
  → And do not "fix" a sweep like this by reverting the other session's files: they may already
  have built on them, and a revert can destroy live work. Leave the code, correct the record, and
  TELL the founder, because that session's own git view now shows its work committed by someone
  else. **Confirmed from the other side of this exact incident (the speed-dating session whose
  files rode along):** nothing was lost, master still compiled, and the fix above (`git commit --
  <paths>`) is the one to use going forward — a same-session "add and commit back-to-back" habit
  is only a narrower window, not a closed one.
- **A one-off script run with `tsx` must live INSIDE the repo** — Node resolves
  dependencies from the script's own location, not the cwd, so a scratchpad script
  importing `@supabase/supabase-js` fails with ERR_MODULE_NOT_FOUND however you invoke it.
  Write it to the repo root and delete it after, or give it zero third-party imports.
- **`test.slow()` does NOT extend an `expect()` timeout** — it triples the TEST timeout only.
  A flaky Playwright assertion that reports `Expect "toBeVisible" with timeout 5000ms` is
  hitting the per-assertion default and will keep failing however slow you mark the test;
  pass `{ timeout: N }` to that assertion as well. Hit 2026-08-03 on the matchmaking flake.
  Related diagnostic that settled it in one step: **capture the DB state immediately after a
  UI-assertion failure.** If the data already shows the change, the write succeeded and the
  bug is a late re-render, not a lost mutation — which turns "mystery flake" into a timeout
  question and avoids patching blind.
- **Since slice 3, a test fixture that adds an org member must ACCEPT the invite** (`org_accept_invite`, as that user) or the member stays `pending` and satisfies no membership predicate. A negative assertion then passes for the mundane reason that the user isn't a member yet — proving nothing about the thing under test. Hit while verifying view-as scope isolation 2026-07-31: "a course-A professor cannot view a course-B student" passed vacuously until the fixture accepted.
- Tables created in CLI migrations do NOT inherit Supabase's default API-role grants — every migration must `grant` explicitly (see 20260706120000_core.sql). **Functions are the inverse trap and dev/prod DIVERGE:** Postgres grants `EXECUTE` to `PUBLIC` at CREATE (so anon can call), and on PROD `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` ALSO grants `EXECUTE` directly to `anon`/`authenticated` — which `revoke ... from public` does NOT remove. Local lacks that default, so a function locked down with only `revoke ... from public` looks closed locally but is open on prod (the 2026-07-22 `module_scope_covers` gap → `20260722010000`). Rule: state the full intended ACL explicitly (`revoke execute ... from public, anon, authenticated;` then `grant` to exactly who needs it), and verify security-sensitive ACLs against PROD — the local RLS suite can't catch this. See docs/03 convention #1. **`pnpm exec tsx scripts/prod-verify-migration.ts <path-to-migration.sql>` now automates that prod check** (read-only: per-function body md5, secdef, pinned search_path, real EXECUTE ACL incl. anon). **It takes a PATH, not a version — and it checks FUNCTIONS ONLY, so for a migration that defines none (a policy, a grant, an index) its "0 failures" is VACUOUS.** Hit 2026-08-07 on `20260806010000`, a policy-only migration: the run passed while asserting nothing about the policy. Verify those with a direct read-only `pg_policies` query against prod, and carry a control (count all policies) so an empty result is a real absence rather than a broken catalog read. **DO NOT HAND-ROLL THAT ANY MORE — `scripts/prod-verify-superadmin-log.mts` (2026-08-09) is the worked template**: no args, no app credentials (it uses the pooler + `SUPABASE_DB_PASSWORD`), and it checks the whole class the function-only script is blind to — real table ACL, each policy's expression, **the ABSENCE of a policy arm asserted as a negative**, the trigger being BOUND rather than merely defined, and every FK's delete action — each with its own control. Copy it per migration. **A second worked
  example, `scripts/prod-verify-login-events.mts` (2026-08-09), adds the beat that one lacks: a
  final check that the feature's DATA is actually arriving on prod** (it FAILS until a real sign-in
  has been captured). A migration can be structurally perfect and functionally dead — the whole
  reason docs/17 exists — so for anything that CAPTURES data, assert the capture, not just the
  schema.

## Key standing decisions

- **Stack:** TypeScript, Next.js (App Router), Supabase (Postgres+Auth+Storage+Realtime; local via `supabase start`), Drizzle, pg-boss worker, Tailwind+shadcn/ui, pnpm+Turborepo monorepo. Rationale + alternatives + exit ramps: docs/02.
- **Hosting:** managed-first (Supabase + Vercel free tiers), one small VPS for the worker later, cost phases in docs/05.
- **Security invariant:** every module table has `org_id` + RLS policy; web app queries as the user (RLS enforced); service-role key only in the worker.
- **Code style:** explicit over clever — the founder codes alongside AI (Apps Script/JS background; Copilot may be used too). Fewer abstractions, standard patterns, inline docs where intent isn't obvious.
- Module tables are prefixed (`mm_`, `cls_`, `syn_`, `vm_`, `sal_`, `sd_`); modules never import other modules; shared behavior goes through `packages/platform`.
- **exFAT constraint:** the repo drive (D:) can't do symlinks. NO `workspace:*` dependencies — internal packages are imported via `@platform/*` tsconfig path aliases, and `.npmrc` pins `node-linker=hoisted`. Details + deferred NTFS revert: docs/01.
  **The Sentry/Turbopack local-build blocker (2026-08-31 → 2026-09-06) IS RESOLVED — local
  `pnpm dev`/`build`/e2e all work again on D:, confirmed 2026-09-06 (Sonnet): build clean,
  typecheck 9/9, e2e 52/52.** Root cause: `@sentry/nextjs` declares `@sentry/node` as a
  dependency, which declares `import-in-the-middle`/`require-in-the-middle` (Next's
  `serverExternalPackages` default list) — Next/Turbopack needs a real filesystem
  junction/symlink to wire those up, which exFAT cannot create, full stop, for ANY package on
  that list, regardless of how it's imported (eight workarounds were tried and died on this
  exact wall before the actual fix was found — full list in the journal, not repeated here).
  **The fix: replaced `@sentry/nextjs` with a minimal hand-built client on `@sentry/core` +
  `@sentry/browser`** (`apps/web/instrumentation.ts`/`instrumentation-client.ts`/
  `app/global-error.tsx`) — neither has ANY dependency on the problem packages (verified via
  their own `package.json`). Real error capture and delivery survive on the same
  `NEXT_PUBLIC_SENTRY_DSN`; traded away is `@sentry/node`'s automatic third-party
  instrumentation and automatic route-change spans (this app's usage was already narrow/manual,
  so this is a minor loss). **Caveat, unchanged and still real:** if `pg`/`sharp`/`playwright`/
  etc. (Next's OTHER default-externalized packages) ever become genuine server-side imports,
  the identical class of crash reappears under a new package name — that's exFAT's structural
  limit, not a gap in this fix. Full investigation narrative (all 8 dead ends, the NTFS-clone
  side-investigation and its own repeatable script `scripts/verify-ntfs-build.ts`, and the
  actual fix): docs/history/platform-journal.md's 2026-09-04 → 09-06 entries. **The founder
  action (Sentry account + DSN into Vercel) is ALSO done now, same session** (docs/14, docs/18
  item 1) — Sentry is live in production, delivery verified via a real accepted test event, not
  just wired-and-inert.

## Founder profile & working style (canonical — mirror of any session memory)

- **Founder:** Jason (yarmishj@artisenergy.com; platform account jasonartisenergy@gmail.com).
  Google Apps Script/Sheets background; teaches a university course (module 2 mirrors his
  real class workflow); day job at Artis Energy (energy/utility domain — the prior-art
  codebases in docs/06 are his).
- **How he works with AI:** maximum autonomous momentum. His words (2026-07-07): "Ask me as
  little as possible for permissions. Even when you do have something to ask me, you can
  pause to ask but try to work on something else as well while you wait." Batch questions;
  keep an independent track moving while anything is pending; use background tasks and
  parallel agents freely; report outcomes, not requests for permission.
- **Interaction patterns that work:** numbered load-bearing questions (he answers inline,
  point by point); real client artifacts as specs; click-by-click walkthroughs for testing;
  plain-language explanations of infra concepts (he asks — answer directly, no jargon).
- **ASK CHOICES AS CONCRETE SCENARIOS, NOT AS ABSTRACTIONS (founder, 2026-08-11, after sending
  the same question back twice).** His words: *"This too is not clear what you are asking. Say I
  am asking if we should do A or B. Here is the scenario and if we do A then xyz, if we do B then
  ghj etc."* An `AskUserQuestion` option like "keep one bucket / split the buckets" is unanswerable
  — it asks him to hold the consequences in his head. What works: name a real situation with real
  seed users, then state what actually happens under each choice ("Charlie files a report March
  8th and never returns. Under A he reads as lapsed and gets a come-back email. Under B you see
  `report.filed` and don't send it, but the report's existence is now in a table you browse in
  bulk"). **Corollary that also came from that exchange: when he asks a question back rather than
  answering — "how would you define staff vs members?" — go and MEASURE the answer** (that one was
  settled by reading `docs/rank-admission-map.md` and finding rank cannot express it at all),
  rather than restating the question more carefully.
- **Code prefs:** explicit TypeScript over clever; few abstractions; inline docs where
  intent isn't obvious; he may read/modify code himself and Copilot may join.
- **Command execution on this machine:** run sandboxed by default — the sandbox-bypass
  flag triggers permission prompts every time and was the main prompt-fatigue source.
  Single commands starting with an allowlisted program (pnpm/git/node/tsx/docker/supabase);
  complex logic goes in script files, not shell one-liners.

## Model choice (founder preference, 2026-07-10; Fable tier added 2026-07-16)

- **Sonnet 5** for routine slices: UI/CRUD work, walkthrough-feedback fixes,
  docs, manifest copies.
- **Opus 4.8 (or better)** for anything touching `supabase/migrations/`, RLS
  policies, triggers, export/privacy rules, or gnarly multi-step debugging.
- **Fable 5 (limited credits — spend deliberately)** only when Opus-tier work
  has an extra reason to want the strongest model:
  - **Adversarial security review of a NOVEL RLS/trigger/privacy design**
    (a new mechanism, not a copy of an existing audited pattern) — tenancy
    isolation is existential, so the review step specifically is where the
    top model earns its cost. Routine "same shape as an existing audited
    policy" migrations stay Opus.
  - **Debugging that has already defeated one session** — a bug Opus/Sonnet
    investigated and misdiagnosed or couldn't reproduce, especially
    cross-layer ones (RLS + trigger + client + infra interacting).
  - **Big cross-cutting design/refactor passes** (extraction passes, a
    platform primitive touching every module) where one wrong abstraction
    is expensive to unwind.
  - NOT for: resuming well-documented in-flight work, building UIs on
    already-verified migrations, docs, seeds, e2e, feedback batches —
    that's Sonnet/Opus territory even when the session started on Fable.
- **Switching has a cost too**: don't churn models mid-task — a mid-session
  switch loses working context. Pick the tier when a work item STARTS; if a
  session's remaining work drops a tier, finish the session, then switch
  down for the next one.
- Whatever the model: the docs/03 #12 security rhythm (agent-draft →
  security-review → live verification) is the invariant, not the model.
- **Two-way say-so rule:** a lighter model whose task drifts into
  heavier territory must SAY SO and suggest switching up — never push
  through quietly. Symmetrically, **a heavier model (Opus/Fable) must say
  at the START of a turn when the requested work doesn't need its tier**
  and recommend the cheaper model for next session — never silently burn
  limited credits on routine work.
- Safeguards, never-do list, backups, recovery: [docs/12-safeguards.md](docs/12-safeguards.md).

## Session hygiene (subagents & fresh chats) — founder ask, 2026-07-27

- **Parallel subagents** — use for independent work that can run concurrently
  (adversarial security reviews, schema/code surveys, migration drafting, RLS-test
  authoring) AND to keep heavy reading/analysis OFF the main context. They trade
  MORE total tokens for parallelism + a leaner main window — they are NOT a way to
  save a token budget. Use only when quality won't suffer: the proven rhythm is
  agent-draft → the orchestrator READS the draft itself → independent 2-reviewer
  adversarial fan-out → test-author → live verify. The orchestrator ALWAYS reviews
  subagent output; the adversarial review + tests are the quality gate, never the
  subagent's own say-so. Token math: subagent overhead dominates in a SMALL context
  (self-do is cheaper there); in a LARGE context their fresh-start saving can
  outweigh it for heavy tasks. The reliable wins are parallelism + context-leanness,
  not budget.
  **A BROAD REVIEW AGENT CAN DIE ON THE SESSION LIMIT REPEATEDLY AND PRODUCE NOTHING —
  SPLIT IT (2026-09-10, after FOUR failed runs of the same task).** A single
  "review everything about X" agent hit *You've hit your session limit* four separate
  times, each time burning its whole run and returning one useless line. The same work
  as **two narrow agents, each with one question and an explicit word cap** ("answer only
  this; keep the report under 500 words") both finished first try. The tell is an agent
  that dies late with a partial trailing sentence rather than erroring early. → When a
  review agent fails on limits, do NOT simply retry it — **narrow the question and cap the
  output**, and prefer two focused agents over one exhaustive one.
- **Proactively recommend a fresh chat when THIS context grows large.** Per-turn
  cost scales with accumulated context, so a long session gets progressively more
  expensive. When the chat has grown big AND you're at a clean, committed, shipped
  boundary (nothing uncommitted/unpushed), TELL the founder it's a good time to
  start a fresh chat — don't wait to be asked. A fresh chat auto-loads this file +
  docs/15 + docs/03, so nothing is lost. Keep the current-state section above and
  the docs decision logs current so the handoff is always clean.
- **Keep this file (CLAUDE.md) lean — it auto-loads every session, so its size is a
  tax every future chat pays.** As part of the docs-update step when shipping a slice
  (docs/03 #12's final beat), do NOT append the full blow-by-blow to "## Current
  state." Instead: append the detailed dated entry to `docs/history/platform-journal.md`
  (newest-first), and update ONLY the compact "Now / Next / Standing rules" in the
  current-state section here. Durable decisions/conventions go to their real homes
  (docs/15 decision log, docs/03 conventions, docs/12 safeguards), not here. Same
  principle for the other always-loaded lists (gotchas, standing decisions): prune/merge
  rather than let them grow unbounded. A fresh chat should never pay for the full journal.
- **DELETING A WORKING NOTE IS A STATE MIGRATION, NOT A CLEANUP (learned 2026-08-07, after
  it nearly lost three things).** A handoff/scratch note holds two kinds of content: a task
  list, and STATE — open items, known gaps, findings parked for later. Ticking off the task
  list and running `git rm` silently drops the second kind. **Before deleting one, grep it
  for open-state markers** (`STILL`, `OPEN`, `NOT`, `left`, `gap`, `empty`, `deliberately`,
  `unresolved`, `follow-on`) **and check each hit against the repo.** Three real misses that
  session: `cls_exam_papers` (zero-row, unfalsifiable surface section) and the rank/tier-
  wrapper verification gap both lived ONLY in the deleted note; a third was self-inflicted.
  Two traps that made them hard to see, both worth knowing on their own:
  - **A grep that HITS is not proof the thing is documented — read the hits.** Searching
    "rank remap" returned four confident-looking matches, all about a DIFFERENT mechanism
    (the view-as pair check, which proves rank parity and pair coverage and says nothing
    about what a `rank >= N` wrapper admits). Adjacent vocabulary manufactured a false
    positive. This is the vacuity rule in search form: presence must be READ, not counted.
  - **A status change is a multi-file edit until proven otherwise.** Marking docs/13's
    read-only pair-grid viewer BUILT left CLAUDE.md still calling it parked, because the same
    fact lived in two places. After flipping any DONE/BUILT/SHIPPED claim, grep for every
    other reference to it.

- Never build platform primitives speculatively — extract them when a second module needs the same thing.
- Migrations: forward-only, additive-first, always run locally before cloud.
- Every module ships with seed data and critical-path e2e tests (each role completes its core task).
- Dated **decisions logs** in module specs record client choices — don't re-litigate them silently; if a decision must change, update the spec with a new dated entry.
