// Creates a LIVE speed-dating test event on PRODUCTION (demo-dating org) so a human can test a real call
// without a timer: organizer alice creates it, charlie and dana register, the event is started and
// round 1 is running with a LONG round. Prints the event name and when the round ends.
//
//   node scripts/prod-setup-live-event.mjs [roundMinutes=180] [name prefix="Live test"]
//   node scripts/prod-setup-live-event.mjs --delete "<event name or id>"     # clean up afterwards
//
// WHY THE LONG ROUND: round length defaults to 7 minutes and "Join video" disappears when the round's
// clock runs out (the page treats it as ended, and the video token is capped at the round end), so a
// hand test needs a long one. The create form does not expose it, so this PATCHes
// sd_events.round_duration_seconds with the service role (documented 2026-10-22, module-6 spec).
// Reads .env.deploy (PROD_DEMO_PASSWORD, SUPABASE_PROJECT_REF, SUPABASE_SERVICE_ROLE_KEY). Demo data only.
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.deploy', 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
)
const BASE = 'https://solutions-platform.vercel.app'
const MOD = BASE + '/o/demo-dating/m/speed-dating'
const rest = `https://${env.SUPABASE_PROJECT_REF}.supabase.co/rest/v1`
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' }

if (process.argv[2] === '--delete') {
  const target = process.argv[3] ?? ''
  const q = /^[0-9a-f-]{36}$/.test(target) ? `id=eq.${target}` : `name=eq.${encodeURIComponent(target)}`
  const r = await fetch(`${rest}/sd_events?${q}`, { method: 'DELETE', headers: H })
  console.log(r.status === 204 ? 'deleted' : `FAILED ${r.status}`, target)
  await new Promise((res) => setTimeout(res, 300)) // let the keep-alive socket close (Node/Windows libuv assertion otherwise)
  process.exit(r.status === 204 ? 0 : 1)
}

const minutes = Number(process.argv[2] ?? 180)
const NAME = `${process.argv[3] ?? 'Live test'} ${Date.now().toString().slice(-5)}`
const browser = await chromium.launch()
async function signIn(email) {
  const p = await (await browser.newContext()).newPage()
  await p.goto(BASE + '/login')
  await p.getByLabel('Email').fill(email)
  await p.getByLabel('Password').fill(env.PROD_DEMO_PASSWORD)
  await p.getByRole('button', { name: 'Sign in' }).click()
  await p.getByRole('heading', { name: 'Dashboard' }).waitFor({ timeout: 30000 })
  return p
}
const alice = await signIn('alice@demo.local')
const charlie = await signIn('charlie@demo.local')
const dana = await signIn('dana@demo.local')

await alice.goto(MOD)
await alice.locator('input[name="name"]').fill(NAME)
await alice.getByRole('button', { name: 'Create (draft)' }).click()
await alice.waitForTimeout(2500)
await alice.getByRole('link', { name: NAME }).first().click()
await alice.waitForURL(/events\//)
const evId = alice.url().split('/events/')[1].split('?')[0]
await fetch(`${rest}/sd_events?id=eq.${evId}`, { method: 'PATCH', headers: H, body: JSON.stringify({ round_duration_seconds: minutes * 60 }) })
await alice.getByRole('button', { name: 'Open registration' }).click()
await alice.getByRole('button', { name: 'Start event' }).waitFor()
for (const p of [charlie, dana]) {
  await p.goto(MOD)
  await p.getByRole('link', { name: NAME }).first().click()
  await p.getByRole('button', { name: 'Register for this event' }).click()
  await p.getByText('You are registered').waitFor({ timeout: 30000 })
}
await alice.reload()
await alice.getByRole('button', { name: 'Start event' }).click()
await alice.getByRole('button', { name: 'Run next round (pair everyone)' }).click()
await alice.getByText(/Rounds run: 1/).waitFor({ timeout: 30000 })
await dana.goto(`${MOD}/events/${evId}`)
const ok = await dana.getByRole('button', { name: 'Join video' }).waitFor({ timeout: 20000 }).then(() => true, () => false)
console.log(`EVENT "${NAME}" (${evId}) | Join video visible: ${ok} | round ends ${new Date(Date.now() + minutes * 60000).toISOString()}`)
console.log(`Sign in as dana@demo.local and charlie@demo.local (password = PROD_DEMO_PASSWORD in .env.deploy), open the event, click Join video.`)
console.log(`Clean up afterwards: node scripts/prod-setup-live-event.mjs --delete "${NAME}"`)
await browser.close()
