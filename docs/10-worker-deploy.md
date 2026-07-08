# Deploying the Worker to a VPS (Phase B)

> **Free stopgap available now:** `pnpm worker:prod` runs the worker on the dev
> PC against production (credentials from `.env.deploy`, session-pooler DB).
> Production exports/jobs process while it runs; while it's off, `job_requests`
> queue harmlessly. Verified 2026-07-09: rendered Pozna's real week to the prod
> `syn-exports` bucket (pdf + 2 jpg). The VPS below makes this always-on.

The worker is the always-on background process that runs jobs the website
can't: module 3's schedule exports (it drives a real Chromium browser to
render PDFs/JPGs), and later roster sync, matchmaking rescoring, and the
speed-dating event orchestrator. Until it's deployed, the production "Export"
button queues jobs that nothing picks up.

Everything here is provider-agnostic: the same steps work on a **Hetzner**
(x86, ~$5/mo, recommended — see the comparison below) or an **Oracle Cloud
free-tier** (ARM) server, because the Docker image is published for both CPU
types.

## Provider decision (recorded 2026-07-09)

- **Hetzner (recommended):** ~$4–6/mo (CPX11 or CX22 class, 2 vCPU / 2–4GB,
  Ashburn VA location is closest to the prod Supabase region). Boring,
  reliable, standard x86. The cost is the only downside.
- **Oracle Cloud Always Free:** genuinely $0 and the ARM shape (up to 4 cores /
  24GB) is powerful, but: free-capacity roulette at signup, Oracle reclaims
  idle free instances and has a reputation for abrupt account closures, and
  ARM adds occasional tooling friction. Fine as a sandbox; not what client
  exports should depend on.

## The Hetzner switch — complete runbook (decided in advance, 2026-07-09)

The plan of record: run `pnpm worker:prod` on the dev PC for free until
always-on matters (a client depending on weekly exports, or the first live
speed-dating event), then execute this runbook. Total time ≈ 30 minutes.
Nothing needs to be re-decided at switch time — just follow the steps.

### Part 1 — Hetzner account + server (~10 min, in the browser)

1. Go to **accounts.hetzner.com** → Register. Email + password; verify the
   email. New accounts sometimes get an identity check (ID or small card
   verification) — normal, usually instant.
2. Open **console.hetzner.com** (Cloud console) → default project appears →
   **Add Server**:
   - **Location:** Ashburn, VA (us-east; closest to users, fine with the
     us-west-2 Supabase — the worker is not latency-sensitive).
   - **Image:** Ubuntu 24.04.
   - **Type:** Shared vCPU → **CPX11** (2 vCPU AMD, 2GB) ≈ €4.35/mo. If the
     price list shows **CX22** (2 vCPU, 4GB) in Ashburn, prefer it — more
     headroom for Chromium at a similar price.
   - **SSH key:** paste a public key. On the dev PC PowerShell:
     `ssh-keygen -t ed25519` (accept defaults), then paste the contents of
     `C:\Users\<you>\.ssh\id_ed25519.pub`.
   - Leave volumes/networks/firewall/backups default (backups can be enabled
     later for ~20% of server price). **Create & Buy now.**
3. Copy the server's **public IP** from the console.

### Part 2 — install (~15 min, one terminal)

From the dev PC: `ssh root@<server-ip>` — then follow **"One-time server
setup"** below, steps 2–7 (Docker, clone, secrets, build, verify). All values
for `worker.env` already exist in the dev PC's `.env.deploy`; the session
pooler host is `aws-1-us-west-2.pooler.supabase.com` (verified 2026-07-09),
so the DATABASE_URL line is:

```
postgresql://postgres.jbjqrkxdoiolwlglvoki:<SUPABASE_DB_PASSWORD>@aws-1-us-west-2.pooler.supabase.com:5432/postgres
```

### Part 3 — cutover (~2 min)

1. Stop the local stopgap (Ctrl+C in the `pnpm worker:prod` window). Order
   doesn't matter and overlap is SAFE: `job_requests` claims are atomic (the
   pending→running flip), so two live workers never double-process a job.
2. Verify the VPS worker end-to-end: production site → synagogue schedules →
   **Export this week** → files appear in ~30s.
3. Add the UptimeRobot monitor on `http://<server-ip>:8901/healthz` (docs/05).
4. Done. From then on, "deploying worker changes" = the two-line update
   command in **"Updating to a new version"** below.

### Rollback

If the VPS misbehaves, the old stopgap is still the fallback: stop the VPS
container (`docker compose -f deploy/worker/docker-compose.yml down`) and run
`pnpm worker:prod` on the dev PC again. Queued jobs pick up wherever a worker
next runs.

## One-time server setup (~15 minutes)

1. **Create the server.** Ubuntu 24.04 LTS, smallest 2-vCPU shape, SSH key
   auth. On Hetzner: Ashburn (us-east). Note the server's public IP.
2. **SSH in and install Docker** (official convenience script):

   ```bash
   curl -fsSL https://get.docker.com | sh
   ```

3. **Get the code.** The repo is private, so create a GitHub fine-grained PAT
   with read-only Contents access to `jasonartis/Solutions`, then:

   ```bash
   git clone https://<PAT>@github.com/jasonartis/Solutions.git solutions
   cd solutions
   ```

4. **Write the secrets file** (values from the Supabase dashboard — the
   example file documents exactly which screen each one comes from):

   ```bash
   cp deploy/worker/worker.env.example deploy/worker/worker.env
   nano deploy/worker/worker.env
   ```

5. **Build and start:**

   ```bash
   docker compose -f deploy/worker/docker-compose.yml up -d --build
   ```

   First build takes a few minutes (it downloads the Playwright/Chromium
   image). Then verify:

   ```bash
   curl http://localhost:8901/healthz     # {"ok":true,...}
   docker compose -f deploy/worker/docker-compose.yml logs -f worker
   # expect: "Worker started", "Job-request poller active", heartbeats each minute
   ```

6. **Verify end-to-end:** open the production site, go to the synagogue
   schedules module, click **Export this week** — within ~30s the files
   should appear (the worker claims the `job_requests` row, renders, uploads
   to the `syn-exports` bucket).

7. **Monitoring (docs/05):** add an UptimeRobot HTTP monitor for
   `http://<server-ip>:8901/healthz`.

## Updating to a new version

```bash
cd solutions && git pull
docker compose -f deploy/worker/docker-compose.yml up -d --build
```

(Automating this from CI — a deploy job that SSHes in and runs exactly those
two lines — is a later nicety; manual pull is fine at current scale.)

## How the pieces fit

- `apps/worker/Dockerfile` — image built from the monorepo root on top of the
  official Playwright base (Chromium + OS deps preinstalled, amd64+arm64).
  The base image tag must match `playwright` in `apps/worker/package.json`.
- `deploy/worker/docker-compose.yml` — restart policy, health check, log
  rotation, `shm_size` (Chromium needs more than Docker's 64MB default),
  and the `worker.env` secrets file (git-ignored).
- The worker connects with the **service-role key** and therefore bypasses
  RLS — this is the ONLY place that key lives (security invariant, docs/01).
  `DATABASE_URL` must be the **session pooler** string: pg-boss keeps
  long-lived connections, and Supabase's direct connection is IPv6-only.
