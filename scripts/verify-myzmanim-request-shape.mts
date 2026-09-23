// Is our myzmanim request SHAPED correctly, and is our subscription live?
//
//   pnpm exec tsx scripts/verify-myzmanim-request-shape.mts
//
// WHY THIS EXISTS. `NotAuthorizedSeeApiDashboardForDetails` is returned for TWO
// completely different causes, and they are indistinguishable from the error
// string alone:
//   (a) the subscription/key is not authorized, or
//   (b) the request was shaped so the API never SAW the credentials — it
//       ignores `user`/`key` supplied as URL query parameters, so they arrive
//       blank and it reports exactly the same thing.
// Our code shipped (b) from 2026-07-07 to 2026-09-23. A session chasing the
// outage could easily buy a new subscription and still see the same error.
//
// THE CONTROL that separates them: myzmanim publishes a demo user/key,
// pre-filled on their own public demo form at api.myzmanim.com/engine1.json.aspx.
// Those credentials are never authorized for data, but the API recognises them
// — and ONLY when it can actually read them:
//   POST form-urlencoded -> "DoNotUseDemoCredentials"   (credentials were READ)
//   GET  query params    -> "NotAuthorized..."          (credentials were BLANK)
// So the demo pair is a shape oracle that needs no subscription of our own.
//
// READ-ONLY: three GETs/POSTs, nothing stored, no credentials printed.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const API_URL = 'https://api.myzmanim.com/engine1.json.aspx/getDay'
// Published by myzmanim on their own public demo page — not a secret, and
// deliberately not usable for real data.
const DEMO_USER = '0001583267'
const DEMO_KEY =
  '94c8af54b8c190573f2dc0fed60bd2d1fd5e80ddd559b6a87f60fd2b1350864f179464977a084579'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? '  ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`) }
}

const fields = (user: string, key: string, inputdate: string, locationid: string) => ({
  user, key, coding: 'JS', language: 'en', inputdate, locationid,
})

type Result = { errMsg: string | null; realTimes: number; status: number }

async function callPost(f: Record<string, string>): Promise<Result> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(f),
  })
  return summarise(res)
}

async function callGet(f: Record<string, string>): Promise<Result> {
  const res = await fetch(`${API_URL}?${new URLSearchParams(f)}`)
  return summarise(res)
}

async function summarise(res: Response): Promise<Result> {
  const json = (await res.json().catch(() => null)) as
    | { ErrMsg?: string; Zman?: Record<string, unknown> }
    | null
  const zman = json?.Zman ?? {}
  // A "real" time is a string that is not the missing-value sentinel. The
  // sentinel is matched by PREFIX because the API and the original Apps Script
  // disagree about the trailing Z.
  const realTimes = Object.values(zman).filter(
    (v) => typeof v === 'string' && !v.startsWith('0001-01-01'),
  ).length
  return { errMsg: json?.ErrMsg || null, realTimes, status: res.status }
}

const today = new Date().toISOString().slice(0, 10)

console.log('\nmyzmanim request-shape verification\n')

try {
  // ---------------------------------------------------------------------
  console.log('[1] THE SHAPE ORACLE — demo credentials, both request shapes')
  const demoPost = await callPost(fields(DEMO_USER, DEMO_KEY, today, '27526341'))
  const demoGet = await callGet(fields(DEMO_USER, DEMO_KEY, today, '27526341'))

  check(
    'POST form-urlencoded: the API READ the credentials (recognised the demo pair)',
    demoPost.errMsg === 'DoNotUseDemoCredentials',
    `ErrMsg=${demoPost.errMsg}`,
  )
  check(
    'CONTROL: GET query params: the credentials arrive BLANK (generic not-authorized)',
    demoGet.errMsg !== null && demoGet.errMsg !== 'DoNotUseDemoCredentials',
    `ErrMsg=${demoGet.errMsg}`,
  )
  check(
    'the two shapes really do differ — this is what makes the oracle meaningful',
    demoPost.errMsg !== demoGet.errMsg,
    `${demoPost.errMsg} vs ${demoGet.errMsg}`,
  )

  // ---------------------------------------------------------------------
  console.log('\n[2] OUR credentials, using the shape proved correct above')
  const env = (() => {
    for (const f of ['apps/web/.env.local', '.env.deploy']) {
      try { return readFileSync(resolve(root, f), 'utf8') } catch { /* next */ }
    }
    return ''
  })()
  const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''
  const user = get('MYZMANIM_USER')
  const key = get('MYZMANIM_KEY')

  check('MYZMANIM_USER / MYZMANIM_KEY are present in an env file', !!user && !!key,
    `${user ? 'user set' : 'USER MISSING'}, ${key ? 'key set' : 'KEY MISSING'}`)

  if (user && key) {
    const ours = await callPost(fields(user, key, today, 'US11210'))
    const authorized = !ours.errMsg && ours.realTimes > 0
    check('OUR subscription returns real data', authorized,
      `ErrMsg=${ours.errMsg ?? 'none'}  realTimes=${ours.realTimes}`)

    if (!authorized) {
      console.log('\n  ---------------------------------------------------------------')
      console.log('  The request shape is correct (proved in [1]) and our key is still')
      console.log('  refused, so this is an ACCOUNT problem, not a code problem.')
      console.log('  Check the dashboard at https://www.myzmanim.com/apidemo.aspx')
      console.log('  Until it is resolved every schedule silently renders hebcal')
      console.log('  fallback times, which have NO candle-lighting at all.')
      console.log('  ---------------------------------------------------------------')
    }
  }

  console.log(`\n${pass} checks passed, ${fail} failed`)
} catch (err) {
  console.error('\nProbe failed outright:', err)
  fail++
}
process.exit(fail === 0 ? 0 : 1)
