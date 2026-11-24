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
| IDs | **User and org UUIDs are kept** (they are random `gen_random_uuid()` ids, so a copy never collides with itself); only identifying text is scrubbed. |
| Version 1 scope | **Everything, requested by the founder only.** Per-requester profiles, org/module/user subsets are DEFERRED until a second developer or a second real client exists (extract-don't-speculate). The one v1 filter is an exclude-org list for a client barred from development access; it needs the org-less-table rules in §6 before it can be trusted. |
| Expiry | The **saved scrubbed file expires after 30 days**; the next run of the script deletes expired files (the founder's PC has no always-on scheduler). The working database copy is the developer's own and is deleted on request. |
| Staff-access log | None for dev copies. |
| "Sign in as the user" for support | Real view-as exists on prod for **classroom**; whole-account is designed, not built (docs/13). A copy is stale and scrubbed, so it is NOT the answer to "my screen shows X". |
| "No development access" tier | Deferred; the exclude-org list is the switch. |

## 3. What the spikes proved (real prod, read-only, then deleted)

| Step | Result |
|---|---|
| Dump inside a throwaway container over the session pooler | Works, ~3 min, schema 0.8 MB + data 3.9 MB. The spikes dumped in separate runs; the build must use ONE snapshot (§5). |
| Restore (auth → public → auth; data with `session_replication_role = replica`) | 0 errors, 92 tables, ~1,284 rows, 13 users. 7 tables have circular foreign keys. **Replica mode turns foreign-key checks OFF, so "0 errors" does not prove the links hold**; the build adds a check (§5). |
| Privileges | Image defaults over-privilege `anon`. Blanket revoke, then replay the dump's GRANT/REVOKE lines → grant COUNTS equal prod's (the build compares the actual grants, not counts). |
| Role settings | NOT in a dump. `authenticator`'s `pgrst.db_pre_request = public.view_as_pre_request` had to be re-applied by hand; without it the read-only gate is silently off. |
| Scrub + email scan | Emails/passwords/names replaced; 0 real addresses after (10 before — a control proving the scan works). Real addresses also lived in `profiles`, `pending_invites`, `content_reports`, `sal_customers`, `vendor_accounts.owner_login`. **An email-only scan is not enough** (§6). |
| Real auth server on the copy | Up; sign-in 200 for a demo and a scrubbed user, wrong password 400. |
| PostgREST (RLS) | Correct for the users tried (demo user 7/9 orgs, superadmin 9/9, anon refused) — two users, not an RLS test; the real RLS suite is the proof. |
| Real Next app | Signed in at `/login`, dashboard rendered, the browser contacted only localhost (the database side was not network-audited). |
| Storage schema | The image's `storage` is an empty shell; prod's restores over it with 0 errors **as `supabase_admin`**. Buckets 5 / objects 18 / policies 16, identical to prod; the newest storage migration applies cleanly. No file bytes are in the database. |
| Migration rehearsal | 0 pending today, so untested end to end. |

## 4. Known walls and fixes

| Wall | Fix |
|---|---|
| **Prod's auth (GoTrue 2.198.0) and storage (1.96.4) are NEWER than the local images (2.193.0 / 1.65.1)** (also recorded in docs/12 "restore drill"). | A version check that **STOPS the script** when prod is ahead, reading prod's versions live every run (never hard-coded), and prints the fix (set `supabase/.temp/gotrue-version` / `storage-version`, restart). Tested check: `max(version)` of prod's `auth.schema_migrations` vs the newest migration file in the local auth image. |
| Files are not in the database. | The copy has no files; features that read files show them missing. Storage `owner`/`owner_id` hold real user ids with no foreign key: **set them to null or a kept fake user in the scrub.** Path segment 1 is an org uuid (kept). |
| `storage` restores only as `supabase_admin`; 3 auth triggers call `public.*`. | Restore as `supabase_admin`; replay the 3 trigger lines after `public`. |
| Settings outside the dump. | The script lists and **asserts each**: authenticator's pre-request hook, other role settings (e.g. the statement timeout on `authenticated`), database-level `ALTER DATABASE … SET`, role passwords, the supabase_migrations ledger (needed to know what is pending), extensions. The Before-User-Created sign-up hook is GoTrue config, not data: **not carried; the copy's sign-up behaviour differs from prod**. |
| **pg_cron jobs and `pgboss` jobs.** | **Unschedule all cron jobs and truncate `pgboss` in the copy**: otherwise the copy can run deletions or a local worker can replay jobs queued on prod, and job payloads may hold personal data. |
| Prod's pooler ignores read-only options. | The first statement on the prod connection is `set default_transaction_read_only = on` (verified). |
| The founder's real superadmin account is in the data. | Scrubbed like everyone else; in v1 it keeps its role in the copy (the founder is the only requester). |

## 5. Where it lives, and how it is run

- **A second stack, never the seed stack.** Own `project_id`, own ports (the 553xx range docs/12 already uses for the
  restore drill), own env file for the app. The founder's seeded local stack (5432x) is **never touched**; **db tests and
  e2e never run against the copy** (they assume a fresh seed; CI is unaffected). Switching = pointing the app at the other env file.
- **Only the local machine can reach it:** ports bound to `127.0.0.1`; a **random** password for every copied user and a
  **random** JWT secret/anon key per copy (never the public local default, never prod's). The script **refuses to run**
  unless the app's Supabase URL is localhost and no prod key is in the environment.
- **Where unscrubbed data may exist:** only in a throwaway container/volume, removed on ANY exit (including a crash) and
  asserted gone. Dump files never touch the repo (`backups/` is for the real backup job; **do not reuse
  `scripts/backup-restore-from-b2.mts`'s habit of writing plaintext into `backups/`**). The travelling SSD is
  unencrypted (BitLocker declined, docs/28 F13), so the copy and the saved file live on the internal disk.
- **One snapshot:** a single `pg_dump` (one transaction) of auth + public + storage + the ledger, not three runs; after the
  restore a check that **every foreign key resolves** (fail if any does not).
- **Credentials today:** `SUPABASE_PROJECT_REF` + `SUPABASE_DB_PASSWORD` (the full prod `postgres` role; no lower-privilege dump role exists). Fine for the founder alone.

## 6. The scrub (allowlist by default)

- **Auth:** truncate `sessions`, `refresh_tokens`, `one_time_tokens`, `mfa_*`, `flow_state`, `audit_log_entries` (IPs,
  browsers, emails; a refresh or recovery token copied out would still work against PROD); rewrite `identities.identity_data`;
  fake emails are **random per copy** (not a hash of the real address, which a dictionary attack reverses); recompute
  `email_fingerprint` from the fake address.
- **Public:** every column is classified (keep / replace / blank / drop). **Unclassified = blanked or excluded and
  reported**, enforced by a NEW test that lists every text/json column in every copied schema (the data-browser coverage
  test only catches foreign keys to users, not free text). `inet` columns nulled; free text (notes, safety and content
  reports, feedback, jsonb) blanked unless explicitly marked safe.
- **Tables with no `org_id`** (login/activity events and rollups, feedback, content reports, view-as sessions, lookup
  logs, signup blocks, storage rows whose org is in the path) each get an explicit rule — drop, or filter by the kept
  user/org set — before the exclude-org list can be trusted. A user in both a kept and an excluded org needs a rule too.
- **Leftover scan:** matches the real names, emails, phones and IPs taken from prod BEFORE the scrub (a list built up front
  and discarded), across every text/json column; fails on any hit; carries a before-scrub control.
- **The one risk the design cannot remove:** a place the column list did not predict. The allowlist default and the scan
  shrink it; they do not close it.

## 7. Second developer (later, not v1)

Do **not** hand out the prod database password, the B2 key or the `age` backup key (the key opens every backup ever made,
cannot be rotated for past files, and today sits on the founder's PC plus a cloud copy, docs/28 B.7). The founder runs the
script and gives the developer only the **scrubbed file encrypted to that developer's own `age` key**. A profile
(per-org/module subset) is built then, with its org-less-table rules, not before.

## 8. Order of the script (when built)

1. Version check (stop if prod ahead). 2. One read-only snapshot dump. 3. Throwaway database; restore auth → public →
storage (as `supabase_admin`), data in replica mode; replay the 3 triggers. 4. Foreign-key resolve check. 5. Blanket
revoke + replay grants; re-apply and assert settings; unschedule cron; truncate `pgboss`. 6. Apply exclusions. 7. Scrub
by allowlist. 8. Leftover scan. 9. Apply pending migrations (the rehearsal; verify the ledger first). 10. Save the
scrubbed file (`age`-encrypted, 30-day expiry; the next run deletes expired ones) and print a report: copied, excluded
and why, anything that did not restore. 11. Remove the throwaway container and assert nothing unscrubbed remains.

## 9. Not decided / not tested

- A real storage-api container against the restored storage schema.
- A rehearsal with migrations actually pending.
- The per-table scrub classification (a pass of the build, not done).
- Whether to keep real timestamps/UUIDs or re-map them per copy (kept in v1; re-identification risk acknowledged).
- Where a second developer's copy lives (local vs cloud) — decided when one exists.
