# 28 — Vendor accounts and evacuation plans

> **STATUS: REQUIREMENTS ONLY (founder, 2026-11-09). Nothing designed or built.**
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

## Known risks — must be protected against (recorded 2026-11-09, founder: "we need to protect against them")

Found while writing these requirements. **Each is open, with no fix chosen yet.** The
Part B planning session decides the fix, its cost and its order. Nobody should mistake
these for ideas.

| # | Risk | What happens if it fires | Likely protection (to be decided) |
|---|---|---|---|
| R1 | **We own no web address.** The site is `solutions-platform.vercel.app`, a name that belongs to Vercel. | If Vercel drops or blocks us, the site is gone **and so is its address**. Even after the app is running elsewhere, every link, bookmark and invite email points at a dead name. | Buy a domain we own (about $15/yr) at a registrar that isn't our host. Point it at Vercel, and use it in every link and email from then on. Moving host then means changing one DNS record. |
| R2 | **One Google login opens everything.** GitHub, Vercel and Supabase all sign in with `jasonartisenergy@gmail.com` (docs/14). | If Google locks, suspends or loses that account, the founder is locked out of code, hosting and the database **at the same moment**, with no way in to fix anything. | Give each of the three a second way in that doesn't depend on Google: its own password plus two-step verification, and recovery codes stored offline. Also consider a second trusted owner or admin on each. |
| R3 | **Supabase holds three jobs.** The database, user sign-in and stored files all live with one company. | Losing Supabase stops everything at once. The data can be restored elsewhere from our own backups, but sign-in (accounts and passwords) and uploaded files have no second home today. | Backups now in progress (B2, docs/12) cover the database. Files and sign-in each need an evacuation plan: copy uploaded files off-site, and a tested way to bring user accounts and password hashes to another provider. |
| R4 | **Sign-up and password-reset email depend on Supabase's built-in sender.** It was measured at 2 emails per hour (docs/18 item 7). | New users can't confirm their accounts, and nobody can reset a forgotten password. | A real mail provider on our own domain (needs R1), with a second provider ready to take over. |

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

### Starting inventory (from the repo, 2026-11-09 — the planning session re-measures)

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

## Suggested order

1. Part B planning session first (Opus — a cross-cutting design; an independent
   adversarial review of the result is worth a Fable subagent if credits allow).
2. The quick fixes it is likely to surface early: owning a domain, and a second way into
   the accounts that hang off one Google login.
3. Part A page (Opus, migration), seeded from Part B's inventory.
