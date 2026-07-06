# Account Setup — GitHub, Supabase, Vercel

Self-serve checklist for the founder. Nothing here blocks local development — M0 is built and tested entirely locally. Do **Part 1 soon** (off-machine code backup); Parts 2–3 when we're ready to deploy (late M0).

## Part 1 — GitHub (do soon: this is the code backup)

1. Sign in / create account at github.com (any plan; private repos are free).
2. **New repository** → name e.g. `solutions-platform` → **Private** → do NOT initialize with README/.gitignore/license (the repo already exists locally).
3. Copy the repo URL (e.g. `https://github.com/<you>/solutions-platform.git`) and give it to Claude, who will run:
   ```
   git remote add origin <url>
   git push -u origin master
   ```
   (First push may prompt for GitHub login via browser — Git Credential Manager handles it.)
4. After the first push, in the repo settings:
   - **Settings → Branches → Add branch protection rule** for `master`: require pull request + require status checks (once CI exists). Can wait until a second person or CI is involved.
   - **Settings → Secrets and variables → Actions**: this is where deployment secrets will live later (Claude will provide the exact names when wiring CI — expect `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF`).

## Part 2 — Supabase (needed at first cloud deploy)

1. Create account at supabase.com (sign in with GitHub is easiest).
2. **New project**:
   - Organization: personal is fine.
   - Name: `solutions-platform-prod`.
   - **Database password: generate a strong one and save it in your password manager** — needed for CI migrations; Supabase won't show it again.
   - Region: US East (closest to clients).
   - Plan: Free.
3. Record for Claude (safe to share): the **Project Ref** (short id in the project URL) and the **Project URL** (`https://<ref>.supabase.co`).
4. Tokens (put these directly into GitHub Actions secrets / local `.env` files — never into chat or git):
   - **Access token** (for CI): supabase.com → Account → Access Tokens → generate, name it `ci`.
   - **API keys** (Project → Settings → API): `anon` key (public, used by the web app) and `service_role` key (SECRET — worker only).
5. Later, when real users exist: Authentication → SMTP settings (configure Resend) so auth emails come from our domain; and consider the Pro plan when we want daily backups (docs/05 Phase C).

## Part 3 — Vercel (needed at first cloud deploy)

1. Create account at vercel.com — **sign up with GitHub** (this is also how it gets repo access).
2. **Add New → Project** → import `solutions-platform`.
3. Configure the monorepo:
   - **Root Directory: `apps/web`**
   - Framework preset: Next.js (auto-detected). Build command/output: defaults.
4. Environment variables (from Part 2): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`. (Claude will give the exact list from `.env.example` when we deploy.)
5. Every push to `master` now auto-deploys production; every PR gets a preview URL.
6. Remember (docs/05): the Hobby plan is **non-commercial** — when clients pay, upgrade to Pro ($20/mo) or move the app to the VPS (Phase C decision point).

## Part 4 — Later accounts (not yet)

| Account | When | Notes |
|---|---|---|
| Resend (email) | Module 2/3 needs real email | Free 3k/month; verify our domain |
| Hetzner or DigitalOcean (VPS) | Worker goes to cloud (module 3 live) | ~$10–20/mo; Claude sets up Coolify on it |
| Backblaze B2 | Same time as VPS | Off-site backup target (free tier) |
| Sentry + UptimeRobot | Late M0 | Both free tiers; sign in with GitHub |
| Domain registrar | Branding decided | ~$15/yr; needed for public pages + email sending |
| Twilio / Stripe | Only if SMS / payments features get built | Documented future upgrades |

## Security rules (repeat of docs/05)

- Secrets go in password manager + GitHub/Vercel/host dashboards. **Never in git, never in chat, never in docs.**
- The `service_role` key never touches the web app or the browser — worker and CI only.
