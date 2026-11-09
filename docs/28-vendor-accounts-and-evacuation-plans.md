# 28 — Vendor accounts and evacuation plans

> **STATUS (2026-11-09): Part A BUILT, LOCAL ONLY — read "Part A AS BUILT" below; not on
> prod yet. Part B planned (see "Part B — THE PLAN").** Original requirements follow.
> Two pieces of work. Part A is a superadmin page and is small. Part B is a planning
> exercise and comes first in importance. The founder's own words are quoted where
> they set the goal. [docs/14](14-external-accounts.md) is the current account map and
> is the starting inventory for both.

## Why (founder, 2026-11-09)

> "everytime we have another external service, we become reliant on them and should
> anything go wrong, it could become a bottle neck to the platform."

His example: a video platform whose storage provider stopped hosting it. The site went
dark, its users moved to other platforms, and when it came back it had lost its
momentum. **The goal: a temporary loss of any one service must not make the platform
unusable.** "We can't risk a break in service if customers are relying on us."

## Part A — the accounts page (superadmin only)

One Owner Console page listing every account the platform depends on, so the founder
"can manage everything and stay on top of all accounts".

**For each account:**
- service, what it is used for, sign-in URL, and how you sign in (email and password, or
  "Sign in with GitHub/Google")
- which email or user owns it, and whether two-step verification is on
- plan or tier, monthly cost, how it is paid, last paid, next charge
- **dates the founder must not miss:** trial ends, token or key expiries, renewals
  (known examples: the myzmanim key was a trial that ended 2026-10-24; the
  `SUPABASE_ACCESS_TOKEN` expiry was never recorded; the JaaS key; the `VERCEL_TOKEN`)
- **last opened, recorded by clicking through (founder, 2026-11-09).** Each account
  has an **Open** link to its sign-in page. Clicking it records the date and time, then
  opens the vendor's site in a new tab. The founder goes to the vendor through this page
  every time, so the platform keeps the record. Show the last-opened date per account, and
  keep the history so the page can show how often each one is visited. Label it
  **"last opened"**, not "last logged in": the click proves he went there, not that he
  signed in. Most vendors give no API for real login dates; if one does, it can be added
  later beside this.
- **where its credentials live, by NAME only** (".env.deploy → JAAS_PRIVATE_KEY", "GitHub
  secret B2_APP_KEY"). **Never the secret itself — the page must not be able to hold a
  password or key.**
- what breaks if the service is lost, linking to its Part B row
- free-text notes

**Badges feed the superadmin dashboard** (module-9 spec §H): a date due within 30 days,
an account not checked in 90 days, a payment failing, two-step verification off.

**Build notes:** this needs a new superadmin-only table, so it is a migration (Opus,
docs/03 #12 rhythm). Copy the shape of an existing superadmin-only table
(`superadmin_lookup_log` / the feedback tables). Seed it from docs/14 and Part B's
inventory. Keep docs/14 as the written map, or retire it to point at the page; don't keep
two lists that can drift.

### Part A AS BUILT (2026-11-09, Opus) — LOCAL ONLY, not on prod yet

**Where:** `/console/vendors` (Owner Console nav → "Vendor accounts"). Migration
`20261113010000_vendor_accounts.sql`; page `apps/web/app/(app)/console/vendors/`; shared
logic `apps/web/lib/vendor-accounts.ts`; dashboard tile in `lib/console-dashboard.ts`.

**Tables (all superadmin-only, one `is_superadmin()` policy each; revoke-before-grant):**
- `vendor_accounts` — one row per account; every field in the list above. Never deleted
  (no DELETE grant): mark it **closed**, so its open history survives. `part_b_ref` names
  its Part B plan (e.g. `B.3-1`).
- `vendor_account_dates` — dates not to miss (trial end, key expiry, renewal). A date with
  no day recorded is itself flagged ("date not recorded"). "Mark done" closes one.
- `vendor_account_credentials` — **where** a credential lives: a store (`.env.deploy`,
  GitHub secret, Vercel variable, password manager, …) and a NAME. There is no value column.
- `vendor_account_opens` — one row per **Open** click. Append-only by grants: the API may
  insert only `account_id`; who and when are set by the database; nobody can update or
  delete a row. `opened_by` is `on delete set null`, like `superadmin_lookup_log`.

**Open:** a form posting to `/console/vendors/open` in a new tab. The route records the
click, then 303-redirects to the sign-in address **stored in the database** (never one
from the request, so it cannot redirect anywhere else), with `Referrer-Policy:
no-referrer`. POST, so link prefetchers and other sites cannot fake a visit.

**"Never a password or key" — what the database enforces:**
1. No column holds a secret; credential NAMES must be `UPPER_SNAKE`, at most 64
   characters, no unbroken run of 15+ (a key typed in capitals, a TOTP seed).
2. A BEFORE INSERT/UPDATE trigger runs `vendor_secret_reason()` over **every** text value in
   the row (read generically, so a column added later is covered). It refuses PEM blocks,
   JWTs, known vendor key prefixes, `user:password@` and `?token=` in links, "password: x"
   / "key = x" when x has a digit or symbol, long key-shaped runs, and short
   password-shaped words (upper + lower + digit + a real symbol, e.g. `Summer2026!`).
3. The sign-in address must be plain `https://` with no user:password, no `?query`, no
   `#fragment`.
- **Residual, stated on the page beside every free-text box:** a password that looks like
  text ("the password is hunter2", an all-lowercase `summer2026!`, a short recovery code, a
  key typed in spaced groups or split across two fields) passes. A 40-character commit id
  is refused as key-shaped (rephrase it).
- The filter's own cases (secrets refused, ordinary notes passed) are asserted inside the
  migration, so it cannot apply to a database where the filter is broken.

**Dashboard badges** (tile "Vendor accounts" + priority list), active accounts only: a
date due within 30 days (urgent within 7 or past), an expiry with no date recorded,
payment failing (urgent), two-step **off** (urgent; "not recorded" is shown on the page but
not badged), not opened in 90 days or never (one combined line, so a fresh page does not
bury the dated items).

**Recurring chores (added 2026-11-09 for B.8):** a row with "check every N days" gets a
**Done today** button; it is badged once more than N days pass since it was last done, and
is judged on that instead of "last opened". The seeded "Offsite snapshots (USB stick at
home + cloud drive)" row is every 30 days, **planned** until `pnpm backup:snapshot` exists:
switch it to active then and the badge starts (a badge for something that cannot yet be
done would only teach you to ignore it).

**Seed (in the migration, no secrets):** 10 active accounts (Supabase, Vercel, GitHub,
Google account, Google account (Vercel sign-in), JaaS, Backblaze B2, Sentry, UptimeRobot,
myzmanim) and 8 planned
(domain registrar, mail provider Resend + standby SES, password manager, second git host,
VPS, AI provider, offsite snapshots), from docs/14 and Part B's B.1/B.2/B.7/B.8; 29 credential names
(the Backblaze ones under their `BACKBLAZE_*` names); 4
dates (myzmanim trial ended 2026-10-24; SUPABASE_ACCESS_TOKEN, VERCEL_TOKEN and the JaaS
key, expiries never recorded). Accounts only: hebcal (a library), npm, container images and
Google Fonts have no account and no row. Costs, plans, two-step status and owners are
left "not recorded" for the founder to fill. **How each signs in (founder, 2026-11-09):**
Supabase signs in with the platform's GitHub account (`jasonartis`); Vercel signs in with
Google, using a DIFFERENT Google account from the superadmin one (which one is not yet
recorded, so it has its own row with "Owned by" blank). This corrects both docs/14 (which
said Vercel used GitHub) and R2 below. GitHub itself signs in with email and password
(two-step not recorded). The B2 row's notes say where the backup private key is kept
(a cloud document; paper copy at home decided, B.7 Q6).

**docs/14 is retired** to a pointer at this page (its security rules stay). From now on
the page is the list.

**Review (docs/03 #12):** two independent adversarial reviewers, 2026-11-09. Access: no
path for anyone but the superadmin, history unforgeable (one finding — `opened_by` was
`on delete cascade`, now `set null`). Filter: ~75 inputs; long keys from every vendor
tried were refused; the bypasses that mattered (`Summer2026!`, `P@ssw0rd`, quoted JSON,
`pw:`/`key:`, `?access_token=`, AWS keys with `/`) and the false positives that mattered
("Password: in 1Password", `S3-compatible`, `Pro-Plan2026`) are fixed and are now
assertions in the migration. Tests: `packages/db/src/vendor-accounts.test.ts` (16, each
refusal beside a superadmin control); e2e "owner console: vendor accounts"; local
`verify-acl-hardening.ts` 17/17.

**Still to do:** apply to prod (backup → dry run → founder go-ahead → apply → a
`scripts/prod-verify-vendor-accounts.mts` before/after). `20261111010000_content_reports`
(another session) sorts before it and must ship first or together.

## Known risks — must be protected against (recorded 2026-11-09, founder: "we need to protect against them")

Found while writing these requirements. **Each is open, with no fix chosen yet.** The
Part B planning session decides the fix, its cost and its order. Nobody should mistake
these for ideas.

| # | Risk | What happens if it fires | Likely protection (to be decided) |
|---|---|---|---|
| R1 | **We own no web address.** The site is `solutions-platform.vercel.app`, a name that belongs to Vercel. | If Vercel drops or blocks us, the site is gone **and so is its address**. Even after the app is running elsewhere, every link, bookmark and invite email points at a dead name. | Buy a domain we own (about $15/yr) at a registrar that isn't our host. Point it at Vercel, and use it in every link and email from then on. Moving host then means changing one DNS record. |
| R2 | **One Google login opens everything.** GitHub, Vercel and Supabase all sign in with `jasonartisenergy@gmail.com` (docs/14). **CORRECTED by the founder 2026-11-09: not so.** Supabase signs in with the platform's GitHub account, and Vercel with a *different* Google account from the superadmin one. The single key is now **GitHub**, which opens the code AND Supabase; how GitHub itself signs in is not recorded. The protection below still applies, aimed at GitHub and at the two Google accounts. | If Google locks, suspends or loses that account, the founder is locked out of code, hosting and the database **at the same moment**, with no way in to fix anything. | Give each of the three a second way in that doesn't depend on Google: its own password plus two-step verification, and recovery codes stored offline. Also consider a second trusted owner or admin on each. **Cheapest first step, two-step verification on the Google account itself: the founder deferred it on 2026-11-09 ("I will push that off for now").** |
| R3 | **Supabase holds three jobs.** The database, user sign-in and stored files all live with one company. | Losing Supabase stops everything at once. The data can be restored elsewhere from our own backups, but sign-in (accounts and passwords) and uploaded files have no second home today. | Backups now in progress (B2, docs/12) cover the database. Files and sign-in each need an evacuation plan: copy uploaded files off-site, and a tested way to bring user accounts and password hashes to another provider. |
| R4 | **Sign-up and password-reset email depend on Supabase's built-in sender.** It was measured at 2 emails per hour (docs/18 item 7). | New users can't confirm their accounts, and nobody can reset a forgotten password. | A real mail provider on our own domain (needs R1), with a second provider ready to take over. |

**Fixes chosen 2026-11-09:** Part B plan, B.3 and B.4 (R1 → B.4 #3; R2 → B.3-7 and B.4 #2;
R3 → B.3-1/2, plus finding F1: uploaded files have no backup at all; R4 → B.3-4, and
F2: email also carries link sign-in).

**Rule:** a risk is closed only when its protection is built **and** practised in a drill.
Record the drill's date here.

## Part B — dependency review and evacuation plans

For EVERY external service, listed or not, the planning session answers:

1. **Do we want to depend on an outside company for this at all, or run our own?**
   Weigh lock-in against the cost and work of running it ourselves.
2. **How paralysing is losing it?** Classify each one:
   - **platform down**: nobody can sign in or use anything
   - **feature down**: one module or ability stops (for example video)
   - **invisible to users**: monitoring, CI, backups, cost alerts
   And: if we lose it, how fast can we move to another provider that does the same job?
3. **For every service whose loss is "platform down" or "feature down": an evacuation
   plan** for switching with no break in service. What runs in standby, what data is
   already copied elsewhere, the exact switch steps, who runs them, and how long they
   take.
4. **Drills:** a scheduled mock switch for each critical piece ("mock drills every once in
   a while for each piece of the puzzle"), with the result recorded. A plan that has never
   been practised does not count.

**The founder's "elastic search" example** means a standby copy that takes over when the
main one fails (replication and failover). Elasticsearch itself is a search engine, not a
failover tool; the requirement is the standby, whatever technology provides it.

**Cost is part of the answer, not an afterthought.** Instant failover for everything is
expensive. Each service gets the level its classification justifies, and the cost goes
into [docs/costs](costs/README.md). The plan may conclude that some services should be
brought in-house; the founder left that call to the planning session.

### Starting inventory (from the repo, 2026-11-09 — SUPERSEDED by "B.1 Re-measured inventory" below; kept as written)

| Service | Used for | First impression, to be checked |
|---|---|---|
| Supabase | database, sign-in, file storage | **Platform down.** It holds data, sign-in AND files in one place. Data is portable (plain Postgres plus our own backups); sign-in and storage need their own plan. |
| Vercel | runs the website | **Platform down.** The app is standard Next.js and could run elsewhere, BUT the address is `solutions-platform.vercel.app`, which belongs to Vercel. **We own no domain**, so moving host means every link breaks. A domain we own is probably the first fix. |
| GitHub | code, tests, deploys, secrets | Users don't notice, but we can't ship fixes. Code also lives locally; the offsite-snapshot zips (docs/12) are related. |
| Google account (`jasonartisenergy@gmail.com`) | signs into GitHub, Vercel and Supabase | **A single key to everything.** If Google locks this account, the founder loses access to all three at once. |
| JaaS (8x8) | speed-dating video | **Feature down.** Self-hosted Jitsi is already one setting away (`SPEED_DATING_VIDEO_PROVIDER=jitsi`, docs/02 "Video"). |
| Backblaze B2 | off-site backups (being built) | Invisible. Its loss must never coincide with losing the database; it lives at a different company on purpose. |
| Sentry | error reports | Invisible. |
| UptimeRobot | uptime checks; keeps the free database awake | Invisible, but the free-tier database pauses after a week idle without it. |
| myzmanim / hebcal | prayer times | Feature degraded; prod already serves from cache (docs/23). |
| Supabase's built-in email | sign-up and password emails | **Sign-up and password reset stop**; already a go-live blocker at 2 emails/hour (docs/18 item 7). |
| Package registries (npm), container images | building and testing | Blocks shipping, not running. CI has already hit image rate limits. |
| Planned: AI provider (résumé builder), VPS for the worker, mail provider, domain registrar, payments | — | Each needs a row before it is adopted, not after. |

**Rule going forward:** before adopting any new external service, add its row here
(classification, way out, standby plan) — in the same session that adopts it.

## Part B — THE PLAN (planning session 2026-11-09, Opus; NOTHING BUILT)

> **STATUS: PLANNED, not built.** Founder decisions B.7 Q1–Q7 answered 2026-11-09 (Q3 later changed:
> no domain until the first customer). Offsite snapshots: B.8. Costs are in
> [docs/costs/resilience.md](costs/resilience.md). **Every plan below is UNPRACTISED.** By
> the founder's rule it does not count until its first drill is logged in B.6.

### B.1 Re-measured inventory: what the first list got wrong or missed

The inventory was re-checked against the code, not the docs: every `package.json`, the
names of every key in the env files, both CI workflows, every outbound URL in the source,
the login page, the backup scripts and `supabase/config.toml`. Corrections:

| # | Finding | Evidence | Why it matters |
|---|---|---|---|
| F1 | **Uploaded files have NO backup.** The nightly dump copies the database, including the list of stored files (`storage.objects` rows), but **not the files themselves.** | `scripts/prod-backup.ts` runs `supabase db dump` (schema + data) only. Buckets are created in `20260707100000`, `20260708010000`, `20260709100000`. | If Supabase loses storage, classroom materials, homework and exam uploads, visual-messaging images and synagogue exports are gone for good. R3 understated this. |
| F2 | **Email also signs people IN, not just up.** The login page has an "email me a sign-in link" mode (`signInWithOtp`), as well as sign-up confirmation and password reset. | `apps/web/app/login/page.tsx` | Losing email locks out everyone who uses link sign-in, not just new users. Raises email from "sign-up stops" to **partly platform down**. |
| F3 | **Self-hosted Jitsi is NOT "one setting away."** The code switch exists, but **no Jitsi server exists anywhere**: no `JITSI_DOMAIN` in any env file. | `modules/speed-dating/src/video/config.ts`; env key names | Flipping the setting today points at nothing. A server has to be built first (about half a day). |
| F4 | **hebcal is not a service.** It is a code library (`@hebcal/core`) that runs inside our app. | `modules/synagogue-schedules/package.json` | Nothing to lose. Prayer times are already in-house. myzmanim (trial key ended 2026-10-24) is the only outside zmanim source. |
| F5 | **The founder's PC is a dependency nobody listed.** It runs the background worker (`pnpm worker:prod`). It holds the only complete keychain (`.env.deploy`, `.env.accounts`, both git-ignored) and the local backups. The B2 backups can only be opened with a private key kept "offline with the founder". | CLAUDE.md "Next/open"; `.github/workflows/backup-b2.yml` header | **If that private key exists only on this PC and the PC dies, every B2 backup becomes unreadable at the same moment.** Ask the founder (B.7) where the key lives. |
| F6 | **Supabase dashboard settings are not in the repo.** These include the sign-up hook (ON deliberately, docs/21 §7.12.1), site URL and redirect list, email templates, SMTP and rate limits, and token lifetimes. `config.toml` only describes LOCAL. | `supabase/config.toml`; docs/21 | A restore into a new project brings back the data and nobody's settings. The sign-up hook in particular would come back **OFF**. A settings sheet is part of the evacuation kit. |
| F7 | **GitHub also runs the nightly backup** (`backup-b2.yml`) and holds deploy secrets. | workflows | Losing GitHub stops backups too, not only shipping. |
| F8 | **Google Fonts are downloaded at build time** (`next/font/google` in `apps/web/app/layout.tsx`). | layout.tsx | Build-time only, so it blocks shipping, not running. Bringing it in-house is free (B.2). |
| F9 | **Live updates (Supabase Realtime) are NOT used.** The source has no `.channel(` calls. | grep of apps/web, modules | One less thing to evacuate. Re-check when a module adopts it. |
| F10 | **Both prod platforms are on FREE plans whose terms are themselves a risk:** Vercel Hobby forbids commercial use, and Supabase Free pauses after a week idle with no automated backups (docs/12). | docs/05, docs/12 | "Lost" can mean **suspended for breaking the plan's terms**, not only an outage. The fix is the paid plans already in docs/18, at the first paying client. |
| F11 | **Once plans are paid, one bank card pays every vendor.** An expired card stops them all in the same week. | — (nothing paid yet) | Part A's "payment failing" badge, plus a second card on file wherever the vendor allows one. |
| F12 | **Supabase management token and CLI** run `migrate:prod` and the backups. The token's expiry was never recorded. | `.env.deploy` key names | Part A date to track. Without the token, nothing can be deployed to or backed up from the database. |

### B.2 Every service: how bad is losing it, and outside vs. our own

Loss classes as in the requirements. "Move today" is an honest estimate for the setup as it
is now, with no drill ever run. "Move when ready" is the target once B.4's preparation is
done and drilled.

| Service | Loss class | Move today | Move when ready | Outside or our own? (decided here) |
|---|---|---|---|---|
| **Supabase: database + sign-in** (one plan, B.3-1) | **Platform down** | A day or more, partly guesswork: the B2 backup is not proven yet, the dashboard settings are unrecorded (F6) | 2–4 h cold; under 1 h warm (B.7 Q1) | **Outside.** Self-hosted Supabase (open source, same software) is the **evacuation target**, not the main home. Running our own database and sign-in means patching, TLS and on-call duty for one person. The cost model's own switch point to self-run is about 5M users (docs/costs). |
| **Supabase: file storage** (B.3-2) | **Feature down** (classroom, visual messaging, synagogue exports) | **Not possible: the files are lost** (F1) | Same as the database, files at most a day old | Outside; nightly copy to B2. Files move to Cloudflare R2 at ~50k users anyway (cost model). |
| **Vercel** (B.3-3) | **Platform down** | App on another host in 2–4 h, **but the address dies** (R1) | About 1 h, plus minutes for DNS to spread | **Outside.** Our own server running the same app (`next start` in Docker) is the evacuation target. |
| **Domain + DNS** (to be bought, R1) | **Platform down** once adopted | n/a | Registrar ≠ host; auto-renew, multi-year prepay, transfer lock | Outside, **but the name is ours**: that is the whole point. |
| **Email sender** (B.3-4) | **Partly platform down** (F2) | Not possible without a domain; about 1 h once one exists | About 10 min: swap the SMTP settings in Supabase | **Outside, two providers.** Running our own mail server is never worth it: big providers silently junk mail from small senders. |
| **JaaS (8x8) video** (B.3-5) | **Feature down** (speed dating) | Half a day to build a Jitsi server (F3); an event in progress is lost either way | About 1 h from a tested script | Outside **for now**. Past ~32 monthly video users our own Jitsi becomes the MAIN home and JaaS becomes the standby (docs/02). |
| **GitHub** (B.3-6) | Invisible to users; **stops shipping AND backups** (F7) | ~30 min to deploy from the PC with the Vercel CLI (never tried); backups by hand | Mirror ready; deploy-from-PC recipe drilled | Outside, mirrored to a second free git host. |
| **Sign-in accounts: GitHub, two Google accounts** (R2, B.3-7; corrected 2026-11-09, see R2) | Invisible until it fires. **Losing the GitHub login locks the founder out of the code AND Supabase together**; a locked Google account takes out Vercel (its own Google account) or the superadmin email | Unknown: how GitHub itself signs in is not recorded | Each account has a second way in plus offline recovery codes | n/a: this is about access, not a service to replace. |
| **Founder's PC** (F5, B.3-7) | Worker stops; **keychain and backup key may be lost** | Unknown | Keychain in a password manager; backup key in 2 offline places; worker on a server | n/a |
| **Backblaze B2** | Invisible; dangerous only if lost **at the same time** as Supabase | — | A second copy of each month's backup on the founder's disk (already happens with `pnpm backup:prod`) | Outside, different company from Supabase on purpose. |
| **Sentry** | Invisible (we go blind to errors) | — | No standby. Vercel's live logs are the fallback | Outside, no plan needed. |
| **UptimeRobot** | Invisible; also keeps the free database awake | — | Not needed for that once Supabase is Pro | Outside, no plan needed. |
| **myzmanim** | Feature degraded (already serving from cache, docs/23) | — | hebcal (in-house) is the fallback already | Already effectively in-house. |
| **Google Fonts** (F8) | Blocks shipping only | — | — | **Bring in-house:** ship the two font files with the app (`next/font/local`). About 15 min, $0, one less dependency. |
| **npm, container images, GitHub Actions add-ons** | Blocks shipping only | Wait or rerun (CI has hit image rate limits) | The lockfile pins versions; nothing more | Outside, no plan beyond waiting. |
| **Planned:** AI provider (résumé builder), worker server, payments | Each **feature down** | — | — | Each gets its row **here, before adoption** (the rule above). The worker server doubles as the warm standby host if Q1 = warm. |

**Decided here, not founder calls** (technical judgments; the founder can overrule):
stay on managed services and keep our own copies as the **evacuation targets**; no
automatic hot failover at this size (B.5); fonts in-house; two email providers, never our own mail
server.

### B.3 Evacuation plans (every "platform down" and "feature down" service)

Each plan says: what is kept ready, what data is already copied, the switch steps, who
runs them, how long they take.

**B.3-1 Supabase database + sign-in, as ONE move.** They must move together: sign-in
records (`auth.users`, including password hashes) live in the same database.
- *Kept ready:* the nightly encrypted dump on B2 (once `backup-b2.yml` is green), which
  includes `auth.users` (docs/12); a **settings sheet** (F6) kept with the keychain;
  the restore script `scripts/backup-restore-from-b2.mts`. Warm option (Q1): a self-hosted
  Supabase on our own server, restored from each night's dump.
- *Switch:* (1) create the new home: a new Supabase project in another region, or the
  self-hosted standby. (2) Restore the latest dump. (3) Apply the settings sheet, **sign-up
  hook first**. (4) Put the new URL and keys into Vercel's env vars and redeploy. (5) Run
  the prod verifiers against the new home. (6) Tell users: "please sign in again".
- *What users notice:* everyone is signed out (the new home signs sessions with a new
  key). **Passwords keep working**, because the hashes move with the data. The drill must
  prove this. Anything written since the last backup is lost: **up to 24 h today**
  (backup at 09:00 UTC).
- *Who:* a Claude session runs it; the founder supplies the backup private key and the
  go-ahead (it is a prod action).
- *Not a fix for this:* Supabase's point-in-time recovery ($100/mo) protects against OUR
  mistakes (a bad migration, deleted rows), and only while Supabase itself is up.

**B.3-2 Supabase file storage.**
- *Kept ready:* a nightly copy of every storage bucket to the private B2 bucket,
  encrypted the same way as the dump (it holds student work and private images). It runs
  next to the database backup, so files and the file list come from the same night.
- *Switch:* part of B.3-1: recreate the buckets with their settings (from the settings
  sheet), upload the files, then check that every `storage.objects` row has its file.
- *Who / time:* same as B.3-1; adds minutes at today's size.

**B.3-3 Vercel → our own server.** (Prerequisite: the domain, R1.)
- *Kept ready:* the domain's DNS at the registrar (or Cloudflare), with a **5-minute
  TTL** on the site record so a change spreads quickly; a written recipe to build the app
  into a Docker image and run it on a Hetzner server; Vercel's env vars mirrored in the
  keychain.
- *Switch:* (1) start a server (or use the worker server if Q1 = warm). (2) Build and run the
  app with the env vars. (3) Check `/healthz` and a real sign-in. (4) Point the domain's
  DNS at the server. (5) Add the new address to Supabase's allowed redirect URLs.
- *Who / time:* a Claude session, about 1 h.

**B.3-4 Email.** (Prerequisite: the domain.)
- *Kept ready:* the main provider (Resend, already in the cost model) **and** a second
  one (Amazon SES, about $0 at our volume), both verified for our domain (their DNS
  records added ahead of time, which is the slow part).
- *Switch:* in Supabase's dashboard, change the SMTP host, user and password to the second
  provider's. Send a test password reset.
- *Who / time:* the founder or a session, about 10 min.

**B.3-5 Video (JaaS → our own Jitsi).**
- *Kept ready:* a script that builds a Jitsi server on Hetzner from nothing (docs/02 has
  the shape), plus a DNS name for it. **Nothing runs in standby**; at today's size a
  server sitting idle is not worth $20+/mo.
- *Switch:* (1) run the script, about 30–45 min. (2) Set `SPEED_DATING_VIDEO_PROVIDER=jitsi`
  and the `JITSI_*` vars in Vercel. (3) Redeploy. (4) Make a real two-device test call.
- *Honest limit:* an event already running when JaaS fails is lost either way; the plan
  saves the **next** event. Before each paid event, check 8x8's status page.

**B.3-6 GitHub.**
- *Kept ready:* the repo mirrored to a second free git host on every push; a recipe to
  deploy from the PC (`vercel deploy --prod` with `VERCEL_TOKEN`, which is already in
  `.env.deploy`); the backup runnable from the PC (`pnpm backup:prod` plus the B2 upload).
- *Who / time:* a session, about 30 min.

**B.3-7 Access: the sign-in accounts and the founder's PC (R2, F5).** These are not
services to swap; they are single keys. **Corrected 2026-11-09 (founder, see R2):** the
single key is the **GitHub login**, which opens the code AND Supabase (Supabase signs in
with GitHub). Vercel signs in with a separate Google account, not the superadmin one.
- **GitHub first:** two-step verification plus printed recovery codes, and a sign-in that
  does not depend on any one Google account (how it signs in today is not recorded).
  Then give Supabase its own way in that does not go through GitHub, if Supabase allows it.
- Each of Vercel, Sentry, B2 and the registrar, and **both** Google accounts, gets its own
  password plus two-step verification, with recovery codes printed and stored offline.
  (Two-step on the superadmin Google account: the founder deferred it, 2026-11-09, R2.)
- **Every credential in a password manager**, not only on this PC.
- **The backup private key in two offline places** (for example a USB stick in a safe
  and a printed copy), never only on the PC.
- The worker moves to a server (already planned, docs/10).
- Who else can get in: B.7 Q2.

### B.4 What to build, in order (each waits for the founder to start it)

| # | Step | Closes | Cost | Who |
|---|---|---|---|---|
| 1 | Fix the B2 key and **prove a restore** (in flight, docs/12) | B.3-1 prerequisite | $0 | session + founder |
| 2 | Second way into every account, password manager, recovery codes and backup key stored offline | R2, F5 | $0–100 once | **founder** (~1–2 h) |
| 3 | **Deferred to #11 (Q3).** Buy the domain; point it at Vercel; use it in every link | R1 | ~$15/yr | founder buys, session wires |
| 4 | Write the Supabase settings sheet (read-only through the Management API) | F6 | $0 | session |
| 5 | Nightly copy of storage files to B2 | F1, R3 | cents | session |
| 6 | Fonts in-house | F8 | $0 | session (15 min) |
| 7 | **Deferred to #11 (Q3).** Mail provider + a second provider on the domain | R4, F2 | ~$0 now | founder signs up, session wires |
| 8 | Git mirror + deploy-from-PC recipe | B.3-6 | $0 | session |
| 9 | Recipes for the standby web host and Jitsi (scripts, not running servers) | B.3-3, B.3-5 | $0 | session |
| 10 | First drill of each plan (B.6) | the "unpractised" rule | < $1 each | per Q4 |
| 11 | At the first paying client: **buy the domain (#3) and set up mail (#7)** (founder, Q3 changed 2026-11-09), then Supabase Pro + Vercel Pro (already in docs/18), plus the warm standby if Q1 = warm | F10 | see costs | founder |
| 12 | Offsite snapshots (B.8): `pnpm backup:snapshot`, `RESTORE.txt`, stick + cloud copy, first restore drill; BitLocker To Go on `D:` (F13) | F5, F13, docs/12 "TO BE PLANNED" | $0 | session builds; founder copies monthly, turns on BitLocker |

Steps 1, 2 and 12 matter most: without a proven backup, a way into the accounts and an off-SSD copy of the credentials, no other plan
can run.

### B.5 Protection levels and why not "instant failover everywhere"

| Level | What it means | Database + sign-in | Website | Cost |
|---|---|---|---|---|
| **Cold** (rebuild from backup) | Nothing running in standby; copies kept elsewhere; rebuilt when needed | 2–4 h, up to 24 h of data lost | ~1 h | ~$1.50/mo + one-off keys |
| **Warm** (a second copy running) | Our own server restored each night; switch is a few steps | under 1 h, up to 24 h of data lost (less with more frequent dumps) | minutes | + ~$23/mo (one Hetzner server) |
| **Hot** (automatic switch) | Live copy kept in sync; traffic moves by itself | minutes, almost no data lost | minutes | Supabase cannot replicate to another provider for us; this means running our own database, which the cost model puts at ~5M users |

**Recommendation:** cold for everything now, with drills; warm for database + sign-in +
website from the first paying client; hot not before the cost model's self-run point.
Downtime tolerance is a business call: **B.7 Q1**.

### B.6 Drills (each plan is UNPRACTISED until its first row here)

A drill never touches prod. It restores or switches into a scratch copy and proves the
copy works. The Owner Console dashboard (module-9 spec §H) should show a badge when a
drill is overdue (a Part A field).

| Drill | How often | Passes when | Run on |
|---|---|---|---|
| Database + sign-in restore | **every 3 months** (and after any big migration) | Last night's B2 dump is restored into a scratch Supabase project; row counts match prod's; **a demo user signs in with their real prod password**; the sign-up hook is on | scratch project, deleted afterwards |
| Storage restore | every 3 months, with the one above | Every `storage.objects` row has its file; 3 random files match prod's checksums | same |
| Website on our own server | every 3 months | The app runs on a throwaway Hetzner server under a test name (`standby.<domain>`); `/healthz` 200; a real sign-in works | hourly-billed server, deleted afterwards |
| Email switch | every 6 months | A password reset arrives through the SECOND provider | scratch Supabase project |
| Jitsi build | every 6 months, and before the first big paid event | The script builds a server; a real two-device call connects | throwaway server |
| Deploy without GitHub | every 6 months | A preview deploy from the PC succeeds; the mirror has the latest commit | Vercel preview, not prod |
| "Locked out of GitHub / Google" (tabletop) | yearly | From a different device, the founder signs into each account using only its backup way in (recovery codes, its own password), never the GitHub or Google login it normally uses | founder |
| Offsite snapshot restore (B.8) | every 3 months, with the database drill | The newest pair, taken FROM THE USB STICK OR THE CLOUD DRIVE (not D:), decrypts into a scratch folder on C:; the code clones from the bundle at the expected commit and typechecks; two read-only probes with the restored keys succeed (Vercel deployments list; database `select 1`); both off-site copies are under 31 days old | founder decrypts, session checks |
| "PC is gone" (real, not tabletop) | yearly | On a DIFFERENT computer, with only the USB stick (or the cloud drive), `age.exe` and the paper key, the founder restores both snapshots and runs `git log` plus one probe, following `RESTORE.txt` alone | founder (per Q4) |

**Drill log** (date · drill · result · time taken · what broke and what was fixed):

| Date | Drill | Result | Time | Notes |
|---|---|---|---|---|
| — | none yet | — | — | every plan above is UNPRACTISED |

### B.7 Founder decisions (asked 2026-11-09 as scenarios; answers recorded here)

Answered by the founder 2026-11-09 (Q1–Q4 first, then Q5–Q7 for B.8), each the recommended option; Q3 was later changed by him:

- **Q1 Downtime: DECIDED, cold now, warm from the first paying client.** Scenario asked: a
  5-hour Supabase outage 20 minutes into a client's 40-person event. Today: rebuild from
  backup, ~2–4 h. From the first paying client: a standby copy on our own server, under 1 h,
  +~$23/mo (docs/costs/resilience.md). Add the warm line to `cost-model.ts` at that point.
- **Q2 Who else can get in: DECIDED, only the founder, for now.** Hardware key and printed
  recovery codes at home. Accepted consequence: if Google locks him out while he is away,
  nobody can act until he is home. (The question was asked as a Google lockout, before the
  R2 correction. The same answer holds for the real single key, the GitHub login: a GitHub
  lockout while away stops code AND database access until he is home.) Revisit when a client is paying or a developer joins.
- **Q3 Domain: CHANGED 2026-11-09 (later), founder: "hold this but we will do this with the
  first customer".** No domain until the first customer. Accepted consequence until then:
  a Vercel suspension or move breaks every link (B.3-3 can only run with a new address),
  and email stays on Supabase's built-in sender (B.3-4 needs a domain). B.4 #3 and #7
  move to the first-customer step (#11).
- **Q4 Drills: DECIDED, Claude runs them and the founder supplies the key; once a year the
  founder runs one himself** from a click-by-click script.
- **Backup private key location: ANSWERED 2026-11-09, "it's saved in a cloud doc".** So it
  is not lost with the PC (F5 half-closed). Remaining gap: that is ONE copy, inside an online
  account whose two-step is deferred. Q6 below adds a paper copy at home; turning on two-step
  for the account holding the doc closes the rest.
- **GitHub sign-in: ANSWERED 2026-11-09, email and password** (no Google). Whether two-step
  is on is not recorded; since GitHub is the single key (R2), that is the first thing to check.
- **Q5 Where the offsite snapshots go: DECIDED, USB stick kept at home (never in the laptop
  bag) AND a cloud drive.** Scenario asked: the bag stolen with the SSD and the stick inside.
- **Q6 Where the decryption key lives: DECIDED, paper at home AND the cloud doc**, the doc
  only once two-step is on for that account. Scenario asked: the doc's Google account phished.
- **Q7 How often: DECIDED, made automatically, copied off-site monthly** with a 30-day
  reminder badge. Scenario asked: a key rotated on Tuesday, the SSD dying on Friday.

### B.8 Offsite snapshots: the two files on another drive (docs/12 "TO BE PLANNED", planned 2026-11-09)

The SSD (`D:`, a Samsung T5 over USB) holds the working copy, every credential file, the local
prod dumps and `env-backups/`, so `env-backups/` protects against a bad edit, not a lost drive.
**PLANNED, NOT BUILT** (founder initiates the build). Decisions Q5–Q7 above.

**Re-measured 2026-11-09:** git's real size is **58 MiB** (`git count-objects`; `du` says 885 MB
only because exFAT stores 6,962 loose objects in large clusters); `backups/` holds **37
plaintext prod dumps, 148 MB**, including `backups/github-artifacts/` (33 MB, the 2026-11-03
incident archive); `client-materials/` 256 KB; six credential files; `E:` (Kingston USB,
63 GB free).

**F13 (new): the plaintext prod dumps on the SSD are the bigger exposure.** The 37 dumps include
`auth.users` password hashes and personal data, unencrypted, on a drive that travels in a
laptop bag. Recommended fix (B.4 #12): turn on BitLocker To Go for `D:` (Windows 10 Pro
has it; it can auto-unlock on this PC), which also covers the `.env` files. Prune old dumps
once B2 restores are proven.

**What goes in each file:**

| | 1. Platform snapshot | 2. Credentials snapshot |
|---|---|---|
| Contents | a `git bundle` of every branch and commit (catches UNPUSHED work, which GitHub lacks); every uncommitted or untracked non-ignored file (in-progress work from any session); `client-materials/`; `founder-todo.md`, `founder-feedback.md`; the newest 3 prod dumps from `backups/`; Claude's memory folder for this project (on `C:`) | the six files `scripts/backup-envs.ts` lists; `.claude/settings.local.json`; the Supabase settings sheet once written (F6) |
| Left out | `node_modules`, `.next`, build output (rebuilt by `pnpm install`); the 33 MB incident archive (stays where it is, docs/12) | recovery codes (paper only) |
| Size | ~60–100 MB | under 100 KB |

**How they are protected: both are encrypted** (the platform file holds client material and
personal data too). Tool: **`age`**, already used by the B2 backup, encrypting to the SAME
public key (`scripts/backup-recipient.txt`). Making a snapshot then needs no secret, so it can
run automatically, and opening one needs the private key, which per Q6 lives on paper at home
and in the cloud doc. **One key opens the B2 backups and both snapshots**, which is deliberate:
one thing to keep safe, written down once. Not a password-protected `.zip`: Windows' built-in
zip encryption is weak, and 7-Zip is not installed. Files are named
`<date>-platform.tar.age` / `<date>-credentials.tar.age`.

**Stored next to them, unencrypted, on the stick and the cloud drive:** `age.exe` (the Windows
build) and `RESTORE.txt` (the steps, no secrets). That way a restore on a new computer needs
only the stick and the paper: no account, no Node, no repo.

**How often (Q7):** a `pnpm backup:snapshot` script (to build) runs automatically at the end of
`pnpm backup:envs` and `pnpm backup:prod`. A session that edits any credential file runs it
before ending (this becomes a docs/03 rule when built). It writes to a git-ignored
`snapshots/` folder and keeps the newest 3 pairs. **Monthly, the founder copies the newest pair**
to the USB stick (kept at home) and the cloud drive, keeping 3 pairs in each. The reminder is a row
on the vendor accounts page (Part A), "Offsite snapshots", with its "done today" button and
a 30-day badge on the dashboard. Prod cannot see local files, so the date is entered by hand.

**How a restore is tested:** two drills in B.6, "Offsite snapshot restore" every 3 months and
"PC is gone" yearly on a different computer. The private key is never pasted into a Claude
session: the founder runs the one decrypt command himself, and the session checks the result.

**Cost:** $0 (an existing stick; ~300 MB in a free cloud-drive tier). docs/costs/resilience.md.

## Suggested order

1. ~~Part B planning session first~~ **PLANNED 2026-11-09** (Part B "THE PLAN" above);
   B.7 decisions answered the same day. An independent review of the plan is still worth doing.
2. The quick fixes it is likely to surface early: owning a domain, and a second way into
   the accounts that hang off one Google login.
3. Part A page (Opus, migration), seeded from Part B's inventory.
