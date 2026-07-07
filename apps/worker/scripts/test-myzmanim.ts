// Live test of the myzmanim connector against the founder's pasted data dump:
// calls the real API for Friday 2025-12-12 (US11210) and compares key fields
// with the values printed in the founder's sheet.
//   pnpm exec tsx apps/worker/scripts/test-myzmanim.ts
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchMyzmanimDay } from '../../../modules/synagogue-schedules/src/myzmanim'
import { wallMinutes, formatMinutes } from '../../../modules/synagogue-schedules/src/evaluator'

const here = dirname(fileURLToPath(import.meta.url))
const env = readFileSync(resolve(here, '../../../.env.deploy'), 'utf8')
const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''

const creds = { user: get('MYZMANIM_USER'), key: get('MYZMANIM_KEY') }
if (!creds.key) {
  console.error('MYZMANIM_KEY is empty in .env.deploy — save the file and re-run.')
  process.exit(1)
}

// Expected values from the founder's dump for 2025-12-12 (EST wall clock).
const expected: Record<string, string> = {
  SunriseDefault: '7:10 AM',
  SunsetDefault: '4:28 PM',
  Candles: '4:10 PM',
  ShemaGra: '9:30 AM',
  PlagGra: '3:30 PM',
  Night72fix: '5:41 PM',
  NightShabbos: '5:15 PM',
}

async function main() {
  const zmanim = await fetchMyzmanimDay('2025-12-12', 'US11210', creds)
  console.log(`fields returned: ${Object.keys(zmanim).length}`)
  let pass = 0
  let fail = 0
  for (const [field, want] of Object.entries(expected)) {
    const d = zmanim[field]
    const got = d ? formatMinutes(wallMinutes(d, 'America/New_York')) : '(missing)'
    const ok = got === want
    if (ok) pass++
    else fail++
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${field}: got ${got}, expected ${want}`)
  }
  console.log(`\n${pass}/${pass + fail} fields match the founder's dump`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
