# Deploying the Worker to a VPS (Phase B)

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
