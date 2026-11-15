# Platform security review — plan, evidence pack, and the insurance question

**Founder ask, 2026-11-13 (Fable session, nearly out of usage):** "One major concern of this platform is
the security of the data of potential clients. I want a full review to make sure we are safe from cyber
attacks and data breaches and put in the maximal protections — no possibility of one org getting another
org's data; nobody external getting or compromising data or an account they should not; protection
from AI/bots trying combinations. Also analyse the type of data issues I may need insurance against."

**Status:** PLANNED. Evidence gathering is AUTOMATED and was started 2026-11-13 by
`scripts/security-evidence-run.sh` (no Claude usage; re-runnable). The judgement half waits for usage
to reset — see §4 for exactly how to resume, model by model.

---

## 1. Threat model — what "safe" has to mean here

| # | Threat | Where it would bite on THIS platform | Already measured (link) | Still to judge |
|---|---|---|---|---|
| T1 | **Cross-tenant read/write** (org A sees org B) | RLS on every `org_id` table; SECURITY DEFINER functions (247 in `public`, 33 touch `auth.users`); storage policies (two upload policies don't pin folder [1] to the uploader's org — CLAUDE.md 2026-11-12); realtime (0 published tables); exports; the data browser / view-as (superadmin only) | docs/15, 19, 22, 24, 25; `verify-acl-hardening.ts` 17/17; 2026-11-12 Fable re-review: 11 items, 2 MEDIUMs ([history/fable-review-2026-11-12.md](history/fable-review-2026-11-12.md)) | every definer not yet reviewed as a class; the storage folder pin; `module_roles` grantee gap; whether any policy relies on `auth.jwt()` claims a user can influence |
| T2 | **Unauthenticated external access** | `anon` grants (functions: only `content_report_submit`); public routes (`/report`, `/privacy`, `/terms`, `/login`, `/signup`); PostgREST exposure of the `public` schema; GraphQL endpoint; storage public buckets | ACL sweep 2026-07-29; email-definers review (anon has no table/function reach) | GraphQL on/off; `storage.buckets.public`; Vercel headers (HSTS, CSP); API keys in bundles (anon key is public BY DESIGN — RLS is the wall) |
| T3 | **Account takeover** | password change without current password (**OPEN**, CLAUDE.md "small"); recovery flow (docs/21 §7.12.1, one identical notice); the Before-User-Created hook (ON); session cookie attributes; 2FA deferred; GoTrue "secure email change" | docs/21 | GoTrue config (`mgmt-config_auth.json`): min password length, HIBP check, secure password change, refresh-token rotation/reuse interval, OTP expiry; whether `auth.sessions` has stale long-lived rows |
| T4 | **Bots / credential stuffing / enumeration** | GoTrue rate limits (sign-in, OTP, signup, verify); CAPTCHA (none today); the Vercel edge (no WAF on hobby); signup-oracle hygiene (docs/21); `find_module_peer` co-member oracle (declared); the invite silent-cap signal | 2026-11-12 review #7, #9 | the actual rate-limit numbers on prod; turning on hCaptcha/Turnstile at signup + recovery; a per-IP lockout; `login_events` as a brute-force detector (phase 3 shows logins — no failed-attempt capture exists; GoTrue audit log holds them) |
| T5 | **Supply chain / accounts / secrets** | `pnpm audit`; **GitHub 2FA OFF** (deferred to first customer, docs/28 B.4 #11); Vercel + Supabase + B2 + 8x8 accounts held by one person (docs/28); `.env.deploy` and **37 plaintext prod dumps on the travelling SSD** (F13, BitLocker declined); backup decryption key: PC + cloud, no paper | docs/28, docs/12 | the audit output; whether a stolen laptop = full prod compromise (it does today: `.env.deploy` holds the DB password and service-role key in plaintext) |
| T6 | **Privileged insider / superadmin** | lookup log, view-as logs (append-only, verified 2026-11-12); a second superadmin's scope (docs/12 item 9) | reviews #1, #3, #4, #11 | nothing structural — it is one person today |
| T7 | **Availability / abuse amplification** | `activity_rollup` amplification (MEDIUM); unbounded inserts on member-writable tables; storage quotas (Limits tile); the `pgrst.db_pre_request` single point of failure (real view-as, finding 3) | review #6, #11 | a sweep of every `authenticated`-INSERTable table for a per-user bound |
| T8 | **Backups / recovery** | nightly encrypted B2 (restore proven); **uploaded FILES have no backup**; retention prunes do not run on prod (no worker) | docs/12, docs/28 | nothing to judge; two known gaps to fund |

**What the platform already does right, so the review doesn't re-prove it:** RLS on every tenant table;
revoke-before-grant on every new object with `verify-acl-hardening.ts` as the regression check; service
role only in the worker; every migration prod-verified with controls; append-only security logs; an
encrypted offsite backup with a proven restore; signup/recovery notices that leak nothing.

## 2. The evidence pack (automated, no usage) — `D:\Jason_prompts\sessions\security-evidence-2026-11-13\`

Produced by `scripts/security-evidence-run.sh` (started 2026-11-13; re-run any time). Everything is
read-only. The directory is OUTSIDE the public repo on purpose.

| File | What it holds | Feeds |
|---|---|---|
| `catalog/*.json` | prod `pg_catalog` snapshot: roles + memberships + `rolconfig`, `pg_db_role_setting`, default ACLs, every table's RLS flag/owner/ACL, api-role table and column grants, every policy with its expressions, every function with owner/secdef/search_path/ACL/body md5/body, triggers, views, publications, extensions, storage buckets, cron jobs, approximate row counts, auth counts (no PII), `pgrst.*` settings, RLS-off tables | T1, T2, T6, T7 |
| `acl-preflight.log` | `verify-acl-hardening.ts --preflight` against prod | T1, T2 |
| `migration-parity.log` | `prod-verify-migration.ts` over EVERY migration (84 files, run 2026-11-15): prod function bodies vs the repo (md5), secdef, search_path, EXECUTE incl. anon. **Read it per FUNCTION, newest definition only:** 171 of its 172 FAIL lines are the expected class — an OLDER migration's body no longer matches prod because a later migration redefined it (`is_superadmin`, `is_org_member`, `sd_pin_participant` ×6 …), or a trigger function the script's definer checklist flags by shape (`set_updated_at`: invoker, no search_path). The 172nd is `20261116010000` correctly NOT on prod. A real finding is a function whose LAST definition in the repo mismatches prod. | T1 |
| `mgmt-*.json` | **NOT YET GATHERED.** Claude Code's auto-mode classifier refuses the Management-API GET (it reads `SUPABASE_ACCESS_TOKEN`) even with the founder's chat approval — a separate mechanism from chat permission (CLAUDE.md "AUTO MODE'S CLASSIFIER"). Founder runs `bash scripts/security-evidence-mgmt.sh` in his own terminal (~10 s, GET only), or adds an `autoMode.allow` entry for it. | T3, T4, T2 |
| `pnpm-audit.json`, `pnpm-outdated.json` | dependency vulnerabilities and staleness | T5 |
| `mgmt-config_auth.json` | GoTrue settings: rate limits, captcha, password policy, secure-change flags, hook config, OTP/JWT expiry, MFA | T3, T4 |
| `mgmt-network-restrictions.json`, `mgmt-ssl-enforcement.json`, `mgmt-config_database_*.json`, `mgmt-pgsodium.json` | DB exposure: IP allow-list, SSL enforcement, pooler mode | T2, T5 |
| `mgmt-api-keys.REDACT-BEFORE-SHARING.json` | the project's keys (anon/service) — so the review can confirm which key the browser bundle carries. **Never paste into a chat or commit.** | T2 |
| `public-surface.log`, `public-headers-login.txt` | HTTP status of the public routes and the response headers (HSTS/CSP/frame options) | T2 |

## 3. Known open items this review must fold in (already recorded elsewhere — do not re-derive)

1. `/account` password change does not ask for the CURRENT password (CLAUDE.md; likely fix = GoTrue "secure password change").
2. `module_roles` never checks the grantee is an active org member — MEDIUM, 2026-11-12 review #8.
3. `activity_rollup` amplification — MEDIUM, review #6.
4. Two upload policies don't pin storage folder [1] to the uploader's org (CLAUDE.md 2026-11-12, storage-usage session).
5. GitHub 2FA off; single-holder vendor accounts; plaintext dumps + `.env.deploy` on the travelling SSD (docs/28 F13, R1–R4).
6. Uploaded files have no backup (docs/28).
7. No CAPTCHA, no custom SMTP (docs/18 item 7), no always-on worker (prunes don't run on prod).
8. Real view-as: four LOW hardening items (docs/13 "FABLE REVIEW"), incl. the `db_pre_request` platform-wide dependency.

## 4. How to resume when usage resets — model by model, cheapest first

**Rule (founder 2026-11-13; memory `feedback-credit-frugality`):** Fable only for the judgement beat;
gathering on Sonnet/Opus; never re-answer what a doc already holds; batch probes; a dead Fable fork is
not resumed twice.

**Step A — Sonnet, one chat, no prod writes:** "Read docs/30 §2. Open the evidence pack at
`D:\Jason_prompts\sessions\security-evidence-2026-11-13\`. Produce `docs/30` §5 'Findings from the
evidence' as a table: for each file, the facts that matter for T1–T8 (numbers, names, file:line), with
anything surprising marked ⚠. Do not judge, do not fix. Then list, from `catalog/functions.json`,
every SECURITY DEFINER function executable by `authenticated` or `anon` whose body does NOT contain
`is_superadmin()`, `is_org_admin(`, `is_org_member(`, `auth.uid()` — that list is the Fable input."

**Step B — Opus, one chat each, migrations (founder go-ahead for each `migrate:prod`):** items 3.1–3.4
above, in that order (password change is a GoTrue setting, not a migration — do it first).

**Step C — Fable, ONE narrow question per fork, ≤700 words each, max three forks at a time (the 5-hour
limit killed 5 of 11 on 2026-11-12):**
1. The definer list from Step A: for each, can a caller widen past its own tenancy? (The class review
   the per-migration reviews never did.)
2. `auth.jwt()`/`request.jwt.claims` usage in every policy and function: is any claim trusted that a
   user can set (metadata, `email` before confirmation, `app_metadata` via any path)?
3. Storage: every `storage.objects` policy against the bucket list — can an authenticated user of org A
   read or write a path under org B? (Includes known item 3.4.)
4. GoTrue config from `mgmt-config_auth.json` + the Before-User-Created hook + docs/21: the account
   takeover and enumeration surface end to end, including what a bot gets per hour at the measured rate
   limits.
5. The laptop-theft scenario: with `.env.deploy` + the SSD, what exactly is compromised and what the
   recovery runbook (docs/28/29) does and does not cover.
6. Every table `authenticated` may INSERT into: which have no per-user bound (the amplification class).

**Step D — Sonnet:** fold the verdicts into this doc's §6 "Protections to add", ranked by (attack
likelihood × data sensitivity ÷ cost), and a `docs/12` never-do addendum.

## 5. Findings from the evidence — *(Step A writes this)*

## 6. Protections to add — *(Step D writes this; the candidates, so nothing is forgotten)*

- CAPTCHA (hCaptcha/Turnstile) on signup, sign-in and recovery — Supabase supports it natively; cheap.
- GoTrue: secure password change ON; HIBP password check ON; refresh-token rotation with a short reuse
  interval; tighten sign-in/OTP rate limits; MFA (TOTP) for the superadmin FIRST, org admins later.
- GitHub 2FA + branch protection now (the "first customer" deferral is the weakest link today — a
  push to master deploys prod).
- Encrypt `.env.deploy` at rest (age, same key as backups) and delete the 37 plaintext dumps — or keep
  the founder's decision and write it down as an ACCEPTED risk with its blast radius.
- Supabase network restrictions (DB reachable only from Vercel/the founder's IP) + SSL enforcement.
- Security headers on Vercel (HSTS, CSP, `X-Frame-Options`, `Referrer-Policy`).
- A failed-login signal: GoTrue's audit log → a daily console tile (bots show up as volume).
- Dependabot/`pnpm audit` in CI (fail on high).
- File backup to B2 (docs/28) and the worker host so prunes run.
- Data-minimisation pass: what is kept forever that need not be (retention is specced in docs/17 but
  does not run on prod).

---

## 7. Insurance — what the data makes you liable for, and what to insure

*Not legal or insurance advice; a starting brief for a broker conversation. Prices are assumptions,
labelled. Written for the founder, internal.*

### 7.1 The data classes this platform actually holds (from the schema, not aspiration)

| Class | Where | Why it matters |
|---|---|---|
| Account identifiers: email, display name, sign-in times, IPs (GoTrue audit) | `auth.*`, `profiles`, `login_events` | PII under every US state breach law; GDPR personal data |
| **Religious affiliation (inferable)** | synagogue-schedules, Jewish matchmaking, speed-dating context | GDPR Art. 9 "special category"; several US states treat it as sensitive; reputational if leaked |
| **Dating / relationship data**: interests, mutual matches, who met whom, safety reports, private notes, blocks | `mm_*`, `sd_*` | Highly sensitive; a leak is a safety issue, not just privacy; safety reports can name alleged misconduct |
| Education records: grades, submissions, peer-review comments, surveys | `cls_*` | If a US university is the client, FERPA flows down to you by contract as a "school official"; a grade leak is a contractual breach |
| Customer/commercial: salon customers, appointments, earnings, expenses | `sal_*` | Business-confidential; customer PII; NO card data (keep it that way — PCI DSS is a whole regime) |
| Content: chat images/stamps, future photos (module 9) | `vm_*`, storage | Copyright (DMCA), minors (13+ gate), CSAM reporting duties if photos ship |
| Platform telemetry about people: activity events, view-as logs, lookup logs | engagement, console | Employee/user monitoring questions for clients; must be disclosed in privacy text |
| Age: the 13+ gate | signup | COPPA avoided by design; keep it |

### 7.2 The regimes that attach (most likely first)

1. **US state breach-notification laws (all 50)** — notify affected residents (and often the AG) after a
   breach of name + email/password or similar; costs are per-person (notification, credit monitoring,
   call centre). NY SHIELD Act adds a "reasonable security" duty.
2. **FERPA** (via university contracts), **GDPR/UK GDPR** (if any EU/UK user — matchmaking communities
   often are cross-border), **state privacy acts** (CCPA/CPRA etc. mostly above your thresholds for now).
3. **Contractual**: every client contract will carry indemnities for data loss; insurers price those.
4. **Safety liability**: speed-dating/matchmaking — a leak of a safety report or a block list can cause
   real-world harm; that is a negligence claim, not a privacy fine.

### 7.3 What to insure (the names brokers use)

| Cover | Pays for | Needed? |
|---|---|---|
| **Cyber liability — first party** | forensics, breach notification, credit monitoring, PR, data restoration, business interruption, cyber extortion/ransomware | YES, from the first paying client |
| **Cyber liability — third party (privacy liability)** | claims by affected people and clients; regulatory defence and fines where insurable; PCI assessments (not needed if no card data) | YES |
| **Technology E&O (professional liability)** | the service failing or a defect causing a client loss (a wrong grade published, a match data mix-up) — distinct from a breach | YES, usually bundled with cyber for a SaaS |
| **Media liability** | copyright/defamation from user content (chat images, photos, reports) | worth adding once module 9 (photos) ships |
| General liability | bodily injury/property — does NOT cover cyber | only if a client contract demands it |
| D&O | directors' decisions | later, if there are investors/a board |

**Rough size** (assumption, US small SaaS, 2026): $1M/$1M cyber + tech E&O ≈ **$1,500–4,000/yr**; a
$2M limit roughly doubles it. The price moves more on CONTROLS than on revenue at this size.

### 7.4 What the application will ask — and where this platform stands today

| Control insurers require | Today | Gap |
|---|---|---|
| MFA on all admin/privileged accounts (email, cloud, code host) | **GitHub 2FA OFF**; Supabase/Vercel/B2 unknown | the single biggest pricing/eligibility item — fix before applying |
| Encrypted, offline/immutable backups, restore tested | YES (B2, age, compliance lock, drill 2026-11-09) — files excluded | add files |
| Endpoint protection + full-disk encryption on devices holding data | **plaintext dumps on an unencrypted SSD; BitLocker declined** | an insurer may decline or exclude; write it as accepted risk or fix it |
| Patch cadence / vulnerability scanning | `pnpm audit` ad hoc; Supabase/Vercel managed | put the audit in CI |
| Incident response plan, written | docs/12, docs/28 B (evacuation plans, UNPRACTISED) | drill one |
| Data inventory + retention policy | docs/22, docs/17 (retention does not run on prod) | run the prunes |
| Vendor list with access reviews | docs/28 vendor page (built) | ✓ |
| Privacy policy / terms published | DRAFT (docs/18 item 3) | finalise before the first client |

### 7.5 Recommendation

Buy cyber + tech E&O **when the first client signs**, not before (no revenue, no client data, no
claimant). Use the months before that to close the controls in 7.4 — they are the same items §6 lists
for security, so one piece of work serves both. Ask the broker for: (a) a FERPA-aware carrier if a
university is the first client; (b) whether "sensitive personal data" (religion, dating) changes the
rate; (c) social-engineering/funds-transfer cover is probably unnecessary (no payments flow).
