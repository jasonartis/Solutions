# External Accounts — the moving pieces, in one place

Every external service this platform depends on: what it is, where to sign in,
and what it's used for. **Credentials (usernames + passwords) are NOT here** —
they live in the git-ignored `.env.accounts` file at the repo root (template:
`.env.accounts.example`). This doc is the map; that file is the keychain.

- **Setup steps** (how each account was first created): [docs/07-account-setup.md](07-account-setup.md).
- **Security rules**: secrets never go in git, chat, or docs — only in
  `.env.accounts`, your password manager, and the service dashboards. The
  Supabase `service_role` key never touches the web app or browser (worker/CI only).
- **Adding a new service later:** add a row here, a block to `.env.accounts`
  **and** `.env.accounts.example`, and note it in [docs/07](07-account-setup.md) if it needs setup steps.

## Active accounts

| Service | Sign in / console | What it's for here | Account / notes |
|---|---|---|---|
| **GitHub** | https://github.com | Source code + CI/CD. The repo is **github.com/jasonartis/Solutions** (private). GitHub Actions runs the tests and, on green, deploys to Vercel. Deploy secrets live in the repo's **Settings → Secrets and variables → Actions**. | User `jasonartis`. Pushes authenticate via Git Credential Manager. |
| **Vercel** | https://vercel.com/dashboard | Hosts the Next.js web app at **https://solutions-platform.vercel.app**. Auto-deploys every push to `master`; each PR gets a preview URL. Root directory is `apps/web`. | Sign in **with GitHub**. Holds the app's public env vars (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`). |
| **Supabase** | https://supabase.com/dashboard | Production **database (Postgres) + Auth + Storage**. Everything the app stores. Project `solutions-platform-prod`, ref **`jbjqrkxdoiolwlglvoki`**. | Sign in **with GitHub**. Holds the `anon` key (public) and `service_role` key (SECRET). DB password is in `.env.accounts` + `.env.deploy`. |
| **Solutions Platform (the app itself)** | https://solutions-platform.vercel.app/login | Not an external vendor, but the login you use as the platform **superadmin** (create orgs, enable modules, manage everyone). | Superadmin = the platform Google email. Demo users (`*@demo.local`) use the prod demo password. Both in `.env.accounts`. |
| **UptimeRobot** | https://uptimerobot.com | Uptime monitoring — pings the live site every few minutes, emails you if it's down, and keeps the Supabase database from going idle. Monitor URL: `https://solutions-platform.vercel.app/s/pozne`. | Free account. (Set up during the 2-day founder-testing window — see `TESTING-TODO-2DAYS.md`.) |
| **myzmanim.com** | https://myzmanim.com | External API for authoritative Jewish prayer times (zmanim) per synagogue address — feeds the **synagogue-schedules** module. | Founder has a free account. API key is currently **parked** (not yet wired into the app; hebcal is the working fallback). |
| **Google** | https://myaccount.google.com | The platform's email identity (`jasonartisenergy@gmail.com`) — the superadmin app login and the likely single sign-on into GitHub/Vercel/Supabase. | Keep this account's own password + 2FA safe; it's the master key to most of the above. |

## Planned — not created yet

Sign these up only when the matching feature/phase arrives (details in
[docs/05-operations.md](05-operations.md) and [docs/07 Part 4](07-account-setup.md)).
When you do, move the block from the commented section of `.env.accounts` into
the active section and add a row above.

| Service | When needed | For |
|---|---|---|
| **Hetzner / DigitalOcean (VPS)** | When the background worker moves to the cloud (live synagogue exports, speed-dating orchestration) | Runs the pg-boss worker 24/7. ~$5–20/mo. Today the worker runs on your PC via `pnpm worker:prod`. |
| **Backblaze B2** | Same time as the VPS | Off-site database/file backups (free tier). |
| **Sentry** | Late polish / first real users | Error monitoring for the web app + worker (free tier; sign in with GitHub). |
| **Resend** | When modules need to send real email (classroom/synagogue notifications) | Transactional email from our own domain (free 3k/month). |
| **Domain registrar** | When branding is decided | A real domain for public pages + email sending (~$15/yr). |
| **Twilio / Stripe** | Only if SMS / payments features get built | Documented future upgrades. |
