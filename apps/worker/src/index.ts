import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import PgBoss from 'pg-boss'

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

async function main() {
  await boss.start()

  // Heartbeat: proves the job loop is alive.
  await boss.createQueue('platform.heartbeat')
  await boss.schedule('platform.heartbeat', '* * * * *')
  await boss.work('platform.heartbeat', async () => {
    lastHeartbeat = new Date().toISOString()
    console.log(`[heartbeat] ${lastHeartbeat}`)
  })

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
