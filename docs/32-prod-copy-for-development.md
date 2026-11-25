# Prod copy for development — design (NOT BUILT)

> **Status 2026-11-24: design agreed in principle by the founder; nothing built.** Do not start building without the
> founder initiating it ("never start a slice unprompted"). Evidence: three throwaway spikes (2026-11-23/24) that restored
> a read-only dump of prod into disposable containers and deleted everything afterwards. Reviewed 2026-11-24 by two
> adversarial agents (security/privacy; feasibility/facts); their findings are folded in below.
> Open legal questions about dev copies: [docs/31](31-questions-for-a-lawyer.md) B1–B4, D6.
> Related recipe already proven for backups: [docs/12](12-safeguards.md) "restore drill" (separate stack, own ports).

## 1. The problem

A bug or feature often needs the SHAPE of real client data, and a migration should be rehearsed against real volume.
Seed data is tidy; prod is not. At the founder's previous company getting prod data into dev was a bottleneck: schemas
differed, ids collided, nobody said exactly what failed.

## 2. Decisions (founder, 2026-11-23/24)

| Decision | Detail |
|---|---|
| Direction | **One-way: prod → a local copy.** Code and migrations travel to prod as today. **Data never merges back.** A fix for real data reaches prod as a reviewed data-fix migration or app action (backup → dry run → founder go-ahead → prod verifier). |
| Why not "branch of prod, merge back" | Merging code works because git knows what changed. Prod data has many authors, rules that check each write, and keeps changing while a copy sits aside; the copy is scrubbed, so pasting it back would overwrite real data, revive deleted rows, skip the database's guard rules and cross tenants. |
| Dev environment | Stays local (Docker) for now; a cloud dev database only when a second developer arrives. |
| Real but scrubbed | Real shape, personal data replaced. **It is still personal data, not anonymous data** (UUIDs, timestamps and org structure are kept), so it is handled and disclosed as such (docs/31 B4). |
| IDs | **User and org UUIDs are kept** (they are random `gen_random_uuid()` ids, so a copy never collides with itself); only identifying text is scrubbed. **Measured 2026-11-25:** 83 `gen_random_uuid()` uses in the migrations; the ONLY non-uuid ids are two `bigint generated always as identity` tables, `content_report_intake` and `view_as_real_page_views` (both log-style). A dump carries their ids and sequence positions, so the copy keeps the same ids and new rows continue from the same counter — no collision, but a row added in the copy and one added on prod later would share an id, which is harmless because data never merges back. (The founder's old-company problem — "ids that generate themselves" — was this; here it is two log tables.) |
| Version 1 scope | **Everything, requested by the founder only.** Per-requester profiles, org/module/user subsets are DEFERRED until a second developer or a second real client exists (extract-don't-speculate). **No v1 filter at all:** the founder decided 2026-11-24 that a client barred from development access is never possible (not having access prevents development), so there is no exclude-org list. The org-less-table rules in §6 apply only if a subset is ever built (second developer, §7). |
| Expiry | The **saved scrubbed file expires after 30 days**; the next run of the script deletes expired files (the founder's PC has no always-on scheduler). **The working copy (the second stack) expires after 30 days too** (founder delegated the call, 2026-11-25: "whatever you recommend"; reason: a forgotten copy of client data is the risk this design exists to limit, and one command rebuilds it): the script warns when a copy is older than 30 days and the next run removes it unless the developer renews it. It can be deleted any time sooner. |
| Staff-access log | None for dev copies. |
| "Sign in as the user" for support | Real view-as exists on prod for **classroom**; whole-account is designed, not built (docs/13). A copy is stale and scrubbed, so it is NOT the answer to "my screen shows X". |
| "No development access" tier | **Rejected by the founder, 2026-11-24: "To not have access, prevents development, I don't think this is a possibility, ever."** Every client's data is reachable for development; the protection is contract, scrub and handling, not exclusion (docs/31 B1, B4). |

**The seven cases the design review tested (2026-11-24; winner per case):** (1) reproduce a bug from one client's data —
the copy (if the bug depends on a scrubbed field, read the real value through real view-as on prod instead); (2) rehearse a
migration on real volume — the copy, but a local rehearsal cannot prove ACLs (prod's default privileges differ), so keep
the per-migration `prod-verify-*.mts` before and after the prod apply; (3) build a feature on real data — explore on the
copy, **ship against `seed.ts`** (CI and e2e run on seed; use the copy only to find the shapes the seed rows should have);
(4) "my screen shows X" — neither: real view-as; (5) a client with a no-development-access clause — moot (rejected 2026-11-24);
(6) a copy forgotten on a laptop — the weak spot, mitigated by encryption at rest and expiry; (7) prod keeps taking writes
while a copy is used — a disposable copy may drift harmlessly (a merge-back would break). **Plain version of why data
cannot merge back:** merging code is like changing a restaurant's recipe (tested in a test kitchen, applies to every future
meal, touches nothing already served); merging data is like photocopying last week's order book, scribbling on the copy
(with names blacked out) and pasting it back while customers kept ordering — every pasted line either overwrites something
real or revives something deliberately removed. So a data fix returns as a new recipe step: a migration.

## 3. What the spikes proved (real prod, read-only, then deleted)

| Step | Result |
|---|---|
| Dump inside a throwaway container over the session pooler | Works, ~3 min, schema 0.8 MB + data 3.9 MB. The spikes dumped in separate runs; the build must use ONE snapshot (§5). |
| Restore (auth → public → auth; data with `session_replication_role = replica`) | 0 errors, 92 tables, ~1,284 rows, 13 users. 7 tables have circular foreign keys. **Replica mode turns foreign-key checks OFF, so "0 errors" does not prove the links hold**; the build adds a check (§5). |
| Privileges | Image defaults over-privilege `anon`. Blanket revoke, then replay the dump's GRANT/REVOKE lines → grant COUNTS equal prod's (the build compares the actual grants, not counts). |
| Role settings | NOT in a dump. `authenticator`'s `pgrst.db_pre_request = public.view_as_pre_request` had to be re-applied by hand; without it the read-only gate is silently off. |
| Scrub + email scan | Emails/passwords/names replaced; 0 real addresses after (10 before — a control proving the scan works). Real addresses also lived in `profiles`, `pending_invites`, `content_reports`, `sal_customers`, `vendor_accounts.owner_login`. **An email-only scan is not enough** (§6). |
| First spike's table/function counts | Of 135 dumped tables, 117 (every `public` and `auth` table that has rows) matched the dump exactly; the 18 not restored were `pgboss.*` (job queue — should not be copied anyway), `storage.*` (the image has no tables there until its schema is restored; spike 3 fixed that) and `auth.audit_log_entries`. Functions: 249 of 251 `public` functions restored — **the 2-function gap was never explained**; the build must diff function lists and report any missing one. |
| Real auth server on the copy | Up; sign-in 200 for a demo and a scrubbed user, wrong password 400. |
| PostgREST (RLS) | Correct for the users tried (demo user 7/9 orgs, superadmin 9/9, anon refused) — two users, not an RLS test; the real RLS suite is the proof. |
| Real Next app | Signed in at `/login`, dashboard rendered, the browser contacted only localhost (the database side was not network-audited). |
| Storage schema | The image's `storage` is an empty shell; prod's restores over it with 0 errors **as `supabase_admin`**. Buckets 5 / objects 18 / policies 16, identical to prod; the newest storage migration applies cleanly. No file bytes are in the database. |
| Migration rehearsal | 0 pending today, so untested end to end. |

## 4. Known walls and fixes

| Wall | Fix |
|---|---|
| **Prod's auth (GoTrue 2.198.0) and storage (1.96.4) are NEWER than the local images (2.193.0 / 1.65.1)** (docs/12 "restore drill" records older numbers, GoTrue 2.197.0 / storage 1.89.13, from 2026-11-09; the versions drift, so always read them live). | A version check that **STOPS the script** when prod is ahead, reading prod's versions live every run (never hard-coded), and prints the fix (set `supabase/.temp/gotrue-version` / `storage-version`, restart). Tested check: `max(version)` of prod's `auth.schema_migrations` vs the newest migration file in the local auth image. |
| Files are not in the database. | The copy has no files; features that read files show them missing. Storage `owner`/`owner_id` hold real user ids with no foreign key: **set them to null or a kept fake user in the scrub.** Path segment 1 is an org uuid (kept). |
| `storage` restores only as `supabase_admin`; 3 auth triggers call `public.*`. | Restore as `supabase_admin`; replay the 3 trigger lines after `public`. |
| Settings outside the dump. | The script lists and **asserts each**: authenticator's pre-request hook, other role settings (e.g. the statement timeout on `authenticated`), database-level `ALTER DATABASE … SET`, role passwords, the supabase_migrations ledger (needed to know what is pending), extensions. The Before-User-Created sign-up hook is GoTrue config, not data: **not carried; the copy's sign-up behaviour differs from prod**. |
| **pg_cron jobs and `pgboss` jobs.** | **Unschedule all cron jobs and truncate `pgboss` in the copy**: otherwise the copy can run deletions or a local worker can replay jobs queued on prod, and job payloads may hold personal data. |
| Prod's pooler ignores read-only options. | The first statement on the prod connection is `set default_transaction_read_only = on` (verified). |
| The founder's real superadmin account is in the data. | Scrubbed like everyone else; in v1 it keeps its role in the copy (the founder is the only requester). |

## 5. Where it lives, and how it is run

- **A second stack, never the seed stack.** Own `project_id`, own ports in a range of its own (**not** 553xx: the docs/12
  restore drill uses 553xx, db 55322, and the two could run together; the spikes used 55432/55433 for bare containers, so
  pick one documented range at build time), own env file for the app. The founder's seeded local stack (5432x) is **never touched**; **db tests and
  e2e never run against the copy** (they assume a fresh seed; CI is unaffected). Switching = pointing the app at the other env file.
- **Only the local machine can reach it:** ports bound to `127.0.0.1`; a **random** password for every copied user and a
  **random** JWT secret/anon key per copy (never the public local default, never prod's). The script **refuses to run**
  unless the app's Supabase URL is localhost and no prod key is in the environment.
- **Where unscrubbed data may exist:** only in a **bare Postgres container with no published ports, no network and NO
  auth or REST service** (so real auth rows and tokens are never served by GoTrue/PostgREST), with pg_cron jobs disabled and
  `pgboss` emptied BEFORE anything else runs; removed on ANY exit (including a crash) and asserted gone. The scrubbed result
  is then loaded into the §5 second stack as its own step. Dump files never touch the repo (`backups/` is for the real backup job; **do not reuse
  `scripts/backup-restore-from-b2.mts`'s habit of writing plaintext into `backups/`**). The travelling SSD is
  unencrypted (BitLocker declined, docs/28 F13), so the copy and the saved file live on the internal disk.
- **One snapshot:** a single `pg_dump` (one transaction) of auth + public + storage + the ledger, not three runs; after the
  restore a check that **every foreign key resolves** (fail if any does not).
- **Credentials today:** `SUPABASE_PROJECT_REF` + `SUPABASE_DB_PASSWORD` (the full prod `postgres` role; no lower-privilege dump role exists). Fine for the founder alone.

## 6. The scrub (allowlist by default)

- **Auth:** truncate `sessions`, `refresh_tokens`, `one_time_tokens`, `mfa_*`, `flow_state`, `audit_log_entries` (IPs,
  browsers, emails; a refresh or recovery token copied out would still work against PROD; sign-in creates new ones, so
  emptying them is safe). **On `auth.users` itself:** blank every token column (`confirmation_token`, `recovery_token`,
  `email_change_token_*`, `reauthentication_token`), scrub `raw_user_meta_data`/`raw_app_meta_data` (names, emails), `phone`
  and `email_change`; rewrite `identities.identity_data` (`sub` and `email` matching the fake). **Kept so password sign-in
  works:** `auth.users` `email`, `encrypted_password`, `email_confirmed_at`, `aud`, `role`, `instance_id`, and the email row
  in `identities` (`provider_id` = the user id). Fake emails are **random per copy** (not a hash of the real address, which a
  dictionary attack reverses). **The founder's own copied account gets a one-time random password printed once** by the
  script (every copied user gets a random password, so without this he could not sign in). Whether the spike sign-in ran
  with these tables emptied is not recorded: the build must prove sign-in AFTER the full scrub.
- **Public:** recompute `email_fingerprint` (a `public` column on `account_signup_blocks`/`pending_invites`) from the fake address.
- **Public:** every column is classified (keep / replace / blank / drop). **Unclassified = blanked or excluded and
  reported**, enforced by a NEW test that lists every text/json column in every copied schema (the data-browser coverage
  test only catches foreign keys to users, not free text). `inet` columns nulled; free text (notes, safety and content
  reports, feedback, jsonb) blanked unless explicitly marked safe.
- **Tables with no `org_id`** (login/activity events and rollups, feedback, content reports, view-as sessions, lookup
  logs, signup blocks, storage rows whose org is in the path) each get an explicit rule — drop, or filter by the kept
  user/org set — before any subset can be trusted. **This applies only to the §7 subset (a second developer); v1 copies
  everything and has no exclusions.**
- **Leftover scan:** matches the real names, emails, phones and IPs taken from prod BEFORE the scrub (a list built up front
  and discarded), across every text/json column **including `auth.users`**; fails on any hit; carries a before-scrub control; **runs again
  as the last step**, after any migration, so a new column cannot slip through.
- **The one risk the design cannot remove:** a place the column list did not predict. The allowlist default and the scan
  shrink it; they do not close it.

## 7. Second developer (later, not v1) — FOUNDER 2026-11-24: "don't forget it for when we have future developers"

**The founder's original requirements for the copy tool (2026-11-23), kept here so the deferred half is not lost:** make the
copy EASY to run (this was "a big bottleneck in my old company"); let the requester CHOOSE what is copied — "a specific
user/set of users and org, a module, an org-module combo"; **if the schema differs, tell the requester exactly what went
wrong or which subset can be copied, and copy what can be**; give the requester the choices over scrubbing "and whatever
else you think". v1 delivers the "exact report + copy what can be copied" half (§8 step 12) and everything-at-once; the
**choosable subset and the per-copy scrub choices are the deferred half**. "Subset pulls shelved" means exactly that:
the design stays on paper and is built only when prod is too big or too mixed (e.g. two real clients); a "keep only these
orgs" option applied after a full restore is the cheap first version of it.

**Why a developer needs no prod access (assistant reasoning, 2026-11-24, not yet a decision):** today `is_superadmin` is one
yes/no flag and a second superadmin is the recorded trigger to design a narrower tier (docs/12 item 9). The prod database
password is effectively god mode (it bypasses every app role), so the real boundary when developers are added is **who
holds production credentials**; developers working on the scrubbed copy never touch prod. When a real developer joins, a
narrower "developer" tier becomes a short design item: read-only, no deletes, no personal disclosures.

When a second developer is about to join, REOPEN this section before giving them anything: per-requester profiles (a
developer's copy built from the orgs/modules they are granted, no superadmin role), the org-less-table rules in §6, the
encrypted-to-their-own-key handoff below, and a cloud dev database decision. (A "no development access" tier was rejected 2026-11-24.)
Do **not** hand out the prod database password, the B2 key or the `age` backup key (the key opens every backup ever made,
cannot be rotated for past files, and today sits on the founder's PC plus a cloud copy, docs/28 B.7). The founder runs the
script and gives the developer only the **scrubbed file encrypted to that developer's own `age` key**. A profile
(per-org/module subset) is built then, with its org-less-table rules, not before.

## 8. Order of the script (when built)

1. Version check (stop if prod ahead). 2. One read-only snapshot dump. 3. **Bare** throwaway Postgres (no ports, no auth/REST
service; cron disabled, `pgboss` emptied first); restore auth → public → storage (as `supabase_admin`), data in replica
mode; replay the 3 triggers. 4. Foreign-key resolve check. 5. Blanket revoke + replay grants; re-apply and assert settings.
6. **Apply pending migrations here, BEFORE the scrub** (the rehearsal; verify the ledger first; the throwaway is isolated, so
real data is fine here and backfills see real values, not blanks). 7. Scrub by allowlist (§6). 8. Leftover scan (every
column incl. `auth.users`; fail on any hit). 9. Save the scrubbed file (`age`-encrypted to a **separate dev-copy key**, see
below; stamped to expire in 30 days). 10. Load the scrubbed file into the §5 second stack; prove password sign-in as the
founder's copied account. 11. Remove the bare container and assert nothing unscrubbed remains. 12. Print a report: what was
copied and anything that did not restore. **Expiry is enforced only when the script runs again** (it deletes expired files
then); nothing else deletes them.

**The saved file's key:** a SEPARATE dev-copy `age` key held by the founder (location to be decided at build, docs/28
B.7 style) — NOT the backup key, or whoever can open a dev copy could open every backup (§7).

## 9. Build brief (for the fresh chat that builds it)

**Model: Opus** (restore + scrub + grants are security-sensitive; docs/03 #12 rhythm applies: draft → adversarial review
→ prove it on a real restore → docs). Sonnet may write the tests and docs. Fable not needed. Paste-ready prompt:

> Build the prod-copy script designed in docs/32 (read it, docs/12 "restore drill", docs/31 B4, and CLAUDE.md first).
> Version 1 = founder only, everything, one snapshot, separate stack on its own ports, allowlist scrub, leftover scan,
> version check that stops when prod's auth/storage is ahead, 30-day expiry of the saved encrypted file. Start by
> classifying every table/column for the scrub (write the new text/json-column coverage test first). Do not apply
> anything to prod; read-only on prod. Report each step with evidence, then run the adversarial review, then update
> docs/32 and the journal. Do not build per-requester profiles or the second-developer path (docs/32 §7).

Spike recipes (so they are not rediscovered): run `pg_dump` INSIDE the throwaway container (the host needs no Postgres
client) against prod's session pooler; an md5 of two schema dumps differs every run because `pg_dump` writes a random
`\restrict` key — it is not evidence of change, diff with that line removed; the image's `postgres` role is not a
superuser (restore storage as `supabase_admin`); restore order auth → public → storage (as `supabase_admin`, not
`postgres`); drop the image's auth stub and comment out `CREATE SCHEMA` lines; blanket revoke + replay the dump's
GRANT/REVOKE; re-set `authenticator`'s `pgrst.db_pre_request`; set the auth/storage admin role passwords; `PGOPTIONS`
read-only is ignored by prod's pooler, so run `set default_transaction_read_only=on` first; Windows excluded port range
blocks 53000 (use another); Git Bash needs `MSYS_NO_PATHCONV=1`; a scrubbed copy signed in through the real Next app
(a 30-line proxy standing in for Kong, `next dev -p 3100`, env vars on the process).

## 10. Not decided / not tested

**Tensions with what docs/31 would promise a client — OPEN, for the founder and the lawyer (do not resolve silently):**
- **Deletion on exit (B4):** nothing can remove one org's data from saved files or from the working copy; the saved file
  AND the working copy expire in 30 days (decided 2026-11-25, §2), but neither can be pulled back from one org on request.
- **A record where staff touch a named person's account (B1) vs "Staff-access log: none" for dev copies (§2):** the founder
  decided no log for dev copies; B1's contract wording must not promise one for copies.
- **AI sessions will read the copy (B2):** disclosure and the vendor's retention terms (B8) apply to scrubbed data too.
- **The v1 build must prove sign-in after the full scrub** (§6) and pending-migration application on a bare database (§8).

- A real storage-api container against the restored storage schema.
- A rehearsal with migrations actually pending.
- The per-table scrub classification (a pass of the build, not done).
- Whether to keep real timestamps/UUIDs or re-map them per copy (kept in v1; re-identification risk acknowledged).
- Where a second developer's copy lives (local vs cloud) — decided when one exists.

## 11. Recovered detail from the planning chat (2026-11-25; the raw chat is deleted after 30 days, so this is the record)

Labels: FOUNDER = his words/decision; PROPOSED = assistant suggestion he did not explicitly accept; MEASURED = a number or fact checked at the time; OPEN = unanswered.

**Decisions and reasons not stated above**
- **FOUNDER rejected a "sandbox org per engagement" (2026-11-23):** "no. The way we did this was we fixed things up in a dev environment that had a copy of the prod data. The client only accessed prod." The idea rested on a real gap: acting as a manager inside the live org would write a real order row under her name. At his old company an org switcher was absent for a one-site client, showed only their own sites to a multi-site client, and staff could choose any client. What the console's org picker does today was never checked (OPEN).
- **FOUNDER's old company's layout (corrects an assistant assumption that "your laptop holds client data"):** local development against a CLOUD dev database, a deployed online dev front end, and a separate prod front end and database. Rungs agreed: a second Supabase dev project "would solve lots of things including development by multiple developers" but is not needed now; a cloud dev front end only "upon company expansion to multiple developers and testers"; a second dev Vercel deployment left open. Assistant notes (PROPOSED/unverified): a hosted dev project catches local-vs-prod divergences (default privileges, auth settings), gives a real URL to show a client, needs a second Supabase project (free tier allows two: UNVERIFIED), and a refresh that wipes dev first makes a departed client disappear.
- **Why no staff-access log for dev copies (FOUNDER):** "That is like logging the fact that someone is working on development today." Assistant's one carve-out (PROPOSED, decide then): a copy made to debug ONE named person's problem is close to the support lookup `/privacy` describes; org or module copies need no log.
- **The assistant's first five-question design, answered "1-4 sounds good" (only the log was dropped):** pointer pulls; **personal-disclosure tables (vault, notes, dating) excluded by default unless explicitly chosen, with a typed reason**; ~30-day expiry; "only you, always with a typed reason". The later full-copy design did not restate the exclusion of personal-disclosure tables. **OPEN: does that default survive into v1?** (v1 as written copies everything, scrubbed.)
- **FOUNDER on refresh (OPEN):** "its not so simple since Dev can have tables added or removed or schema changed. And the 'a client who leaves gets removed' we need to discuss, although we worked out the ghost user so that might cover the issues." Assistant reply: a refresh replaces its scope, so a person deleted on prod disappears from dev on the next refresh; a purge command would handle a client who leaves.
- **FOUNDER (2026-11-24):** "The copy should probably be based on the requestor's level of access, no?" — answered yes (founder gets everything with his admin role; a future developer only granted orgs/modules; scrub always on top); deferred to §7.
- **"Exactly what the client sees" has two meanings (PROPOSED):** *what they see now* = prod's deployed commit run against the restored copy with NO new migrations; *what they will see with a fix* = current code plus unshipped migrations (step 6). Running unshipped code shows the future, not their screen; the script should print which mode it is in.
- **Disk encryption (PROPOSED, unverified):** client data on the working copy makes disk encryption a requirement for the working copy, not only the saved file; a cloud dev database later would remove that. The doc relies on `age` for the saved file only.

**The shelved "subset pull" design in full (PROPOSED; built only if prod becomes too big or too mixed):** scopes — one or more orgs, org+module, specific users (memberships come along), a module across orgs, a time window, and a **pointer pull** ("this one booking and everything linked to it", for bug reports); always a dry run first; a saved, re-runnable "pull request"; a schema-mismatch report with OK / PARTIAL / SKIPPED / IGNORED lines and choices per item (supply a value, use "unknown", skip the table, apply migration X); rule **"never half-copy silently"**, comparing real table and column definitions, not the migration list; scrub chosen per category with a preset and per-field overrides (emails: stable fake or keep real; names: fake or keep; free text: keep / blank / placeholder / exclude table; files: copy / placeholder / skip; secrets: always excluded); a dedicated read-only prod role for pulls (a small prod change, security-tier work); the target verified as dev by project identity, not name; a console page only once someone other than the founder runs it; a purge command to remove an org or user from dev.

**MEASURED facts**
- `is_superadmin()` has 99 mentions across 33 migrations (an earlier count said 35; mentions not individually checked). Most policies appear to call the function rather than repeat the test, so a narrower developer tier would change the answer in a few central places; the later cost is one mechanical sweep plus tests. The assistant WITHDREW "adopt a shared-helper habit now" because the function exists: record the question, do nothing. Founder: "If you think it won't be so hard later then we'll develop it later."
- Spike 2: the grants fix replayed 749 GRANT/REVOKE lines → counts equal prod (authenticated 293 and service_role 480 table grants, anon 0, anon execute 7, authenticated execute 137); without it anon held 644 grants (7 privileges on 92 tables). 13 users restored (11 demo, 2 real). Prod's last auth migration `20261030120000` vs the image's newest `20260625000000` (prod has 7 more); storage migrations 81 on prod vs 61 local; 14 of 85 migrations touch `storage.objects` (re-running the last ones on the image's stub storage failed with "storage.objects does not exist"); repo migration files (85) equalled prod's ledger (85) so nothing was pending; dump 197 s, whole run ~12 minutes.
- The B2 backup (`backup-b2.yml` → `pnpm backup:prod`): the schema file EXCLUDES `auth` and `storage` entirely; the data file INCLUDES their data (users, buckets, object metadata) but not `auth.schema_migrations` or `storage.migrations` — so a restore needs auth/storage DDL from images matching prod (why the version check is mandatory). An earlier idea of a second developer holding a read-only B2 key plus the `age` key was superseded by the security review: hand over only a scrubbed file (§7).
- **Traps hit by the spikes:** running `next dev` for the copy used the shared `apps/web/.next/dev` cache, so no other Next dev server could run at the same time (free virtual memory was only 5.7 GB); a PowerShell `Set-Content` dropped a stray file named after the throwaway JWT secret at the repo root — scripts must never write secrets there.
