import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import PgBoss from 'pg-boss'
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js'
import { RENDER_KIND, runSynagogueRender } from './jobs/synagogue-render'
import { runRetentionSweep } from './jobs/classroom-retention'
import { runOrchestratorTick } from './jobs/speed-dating-orchestrator'
import { runRescoreTick } from './jobs/matchmaking-rescore'

// import.meta.dirname is undefined under tsx — derive it from the module URL.
const here = dirname(fileURLToPath(import.meta.url))

// Load apps/worker/.env (written by scripts/dev.ts) without a dotenv dependency.
try {
  const envFile = readFileSync(resolve(here, '../.env'), 'utf8')
  for (const line of envFile.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (match && match[1] && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2]
    }
  }
} catch {
  // no .env — rely on process env (cloud deployment)
}

// The worker owns all background jobs (docs/01). It connects with the
// service-role/database credentials and therefore bypasses RLS — every job
// must scope its queries by org explicitly.
const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('DATABASE_URL is not set. Run `pnpm dev` from the repo root (it writes .env files).')
  process.exit(1)
}

const boss = new PgBoss({ connectionString, schema: 'pgboss' })

boss.on('error', (err) => console.error('[pg-boss]', err))

const startedAt = new Date().toISOString()
let lastHeartbeat: string | null = null

// Health endpoint for `pnpm status` locally and UptimeRobot in the cloud (docs/05).
const healthPort = Number(process.env.WORKER_HEALTH_PORT ?? 8901)
createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, startedAt, lastHeartbeat }))
  } else {
    res.writeHead(404)
    res.end()
  }
}).listen(healthPort)

// --- job_requests poller (docs/01 job-result contract) ----------------------
// Web inserts rows as the user (RLS-checked); we process them with the
// service role and write status/result back.
const jobHandlers: Record<string, (admin: SupabaseClient, job: JobRow) => Promise<unknown>> = {
  [RENDER_KIND]: runSynagogueRender,
}

type JobRow = { id: string; org_id: string; kind: string; payload: Record<string, never> }

function makeAdminClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createSupabaseClient(url, key, { auth: { persistSession: false } })
}

async function pollJobRequests(admin: SupabaseClient) {
  const { data: jobs } = await admin
    .from('job_requests')
    .select('id, org_id, kind, payload')
    .eq('status', 'pending')
    .order('created_at')
    .limit(3)

  for (const job of jobs ?? []) {
    const handler = jobHandlers[job.kind]
    if (!handler) {
      await admin
        .from('job_requests')
        .update({ status: 'error', error: `Unknown job kind: ${job.kind}` })
        .eq('id', job.id)
      continue
    }
    // Claim: only proceed if we flipped it from pending (guards double-run).
    const { data: claimed } = await admin
      .from('job_requests')
      .update({ status: 'running' })
      .eq('id', job.id)
      .eq('status', 'pending')
      .select('id')
    if (!claimed || claimed.length === 0) continue

    console.log(`[job ${job.id}] ${job.kind} starting`)
    try {
      const result = await handler(admin, job as never)
      await admin.from('job_requests').update({ status: 'done', result }).eq('id', job.id)
      console.log(`[job ${job.id}] done`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await admin.from('job_requests').update({ status: 'error', error: message }).eq('id', job.id)
      console.error(`[job ${job.id}] failed: ${message}`)
    }
  }
}

async function main() {
  await boss.start()

  // Heartbeat: proves the job loop is alive.
  await boss.createQueue('platform.heartbeat')
  await boss.schedule('platform.heartbeat', '* * * * *')
  await boss.work('platform.heartbeat', async () => {
    lastHeartbeat = new Date().toISOString()
    console.log(`[heartbeat] ${lastHeartbeat}`)
  })

  // Module 2 retention sweep (spec: hide is RLS-enforced; purge is ours).
  // Daily at 04:00 server time — content deletions are not latency-sensitive.
  await boss.createQueue('classroom.retention-sweep')
  await boss.schedule('classroom.retention-sweep', '0 4 * * *')
  await boss.work('classroom.retention-sweep', async () => {
    const admin = makeAdminClient()
    if (!admin) {
      console.warn('[retention-sweep] skipped — no service-role credentials')
      return
    }
    await runRetentionSweep(admin)
  })

  const admin = makeAdminClient()
  if (admin) {
    // Speed-dating round clock (module 6): advance running events every 10s.
    let ticking = false
    setInterval(async () => {
      if (ticking) return
      ticking = true
      try {
        await runOrchestratorTick(admin)
      } catch (err) {
        console.error('[orchestrator]', err)
      } finally {
        ticking = false
      }
    }, 10_000)
    console.log('Speed-dating orchestrator active (every 10s).')

    // Matchmaking rescore (module 1): sweep stale pair scores every 30s.
    let rescoring = false
    setInterval(async () => {
      if (rescoring) return
      rescoring = true
      try {
        await runRescoreTick(admin)
      } catch (err) {
        console.error('[rescore]', err)
      } finally {
        rescoring = false
      }
    }, 30_000)
    console.log('Matchmaking rescore active (every 30s).')

    let polling = false
    setInterval(async () => {
      if (polling) return
      polling = true
      try {
        await pollJobRequests(admin)
      } catch (err) {
        console.error('[job poller]', err)
      } finally {
        polling = false
      }
    }, 5000)
    console.log('Job-request poller active (every 5s).')
  } else {
    console.warn('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — job poller disabled.')
  }

  console.log(`Worker started. Health: http://localhost:${healthPort}/healthz`)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    console.log(`${signal} received, shutting down…`)
    await boss.stop({ graceful: true })
    process.exit(0)
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
