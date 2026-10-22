// Sets (or rotates) the three JaaS video variables on VERCEL PRODUCTION and redeploys, so the new values
// take effect. NEVER prints a value. Reads .env.deploy: VERCEL_TOKEN, JAAS_APP_ID, JAAS_API_KEY_ID,
// JAAS_PRIVATE_KEY (the key as ONE line with literal backslash-n; config.ts also accepts a multi-line PEM,
// PKCS#1, CRLF and wrapping quotes). Leave SPEED_DATING_VIDEO_PROVIDER UNSET (JaaS is the default).
//
//   node scripts/prod-set-jaas-env.mjs            # upsert the 3 vars, redeploy production, wait for READY
//   node scripts/prod-set-jaas-env.mjs --no-redeploy
//
// ROTATION RECIPE (module-6 spec, 2026-10-22): JaaS console (jaas.8x8.vc) -> API Keys -> generate a new
// key pair -> download the .pk (private) -> put the AppID, the Key ID (".../xxxxxx") and the key into
// .env.deploy (key joined to one line with literal \n) -> run this script -> run
// scripts/prod-verify-video-call.mjs (fake-media call) -> delete the downloaded .pk (and empty the
// Recycle Bin) -> delete the OLD key in the JaaS console. WHY THE REDEPLOY: Vercel env vars apply only to
// NEW deployments.
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.deploy', 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
)
for (const k of ['VERCEL_TOKEN', 'JAAS_APP_ID', 'JAAS_API_KEY_ID', 'JAAS_PRIVATE_KEY']) {
  if (!env[k]) throw new Error(`${k} is missing from .env.deploy`)
}
const H = { Authorization: 'Bearer ' + env.VERCEL_TOKEN, 'Content-Type': 'application/json' }
const latest = (await (await fetch('https://api.vercel.com/v6/deployments?limit=1&target=production', { headers: H })).json()).deployments[0]
const team = latest.ownerId?.startsWith('team_') ? `&teamId=${latest.ownerId}` : ''
for (const key of ['JAAS_APP_ID', 'JAAS_API_KEY_ID', 'JAAS_PRIVATE_KEY']) {
  const r = await fetch(`https://api.vercel.com/v10/projects/${latest.projectId}/env?upsert=true${team}`, {
    method: 'POST', headers: H, body: JSON.stringify({ key, value: env[key], type: 'encrypted', target: ['production'] }),
  })
  console.log(key, r.ok ? 'set' : `FAILED ${r.status}`)
  if (!r.ok) process.exit(1)
}
if (process.argv.includes('--no-redeploy')) {
  await new Promise((res) => setTimeout(res, 300))
  process.exit(0)
}
const r = await fetch(`https://api.vercel.com/v13/deployments?forceNew=1&skipAutoDetectionConfirmation=1${team}`, {
  method: 'POST', headers: H, body: JSON.stringify({ name: latest.name, deploymentId: latest.uid, target: 'production' }),
})
const dep = await r.json()
console.log('redeploy', r.status, dep.id)
for (let i = 0; i < 40; i++) {
  await new Promise((res) => setTimeout(res, 10000))
  const s = await (await fetch(`https://api.vercel.com/v13/deployments/${dep.id}${team ? '?' + team.slice(1) : ''}`, { headers: H })).json()
  console.log(s.readyState)
  if (['READY', 'ERROR', 'CANCELED'].includes(s.readyState)) process.exit(s.readyState === 'READY' ? 0 : 1)
}
