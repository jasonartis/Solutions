// Try request-format variations against the picky WCF endpoint.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const env = readFileSync(resolve(here, '../../../.env.deploy'), 'utf8')
const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''

const params = {
  user: get('MYZMANIM_USER'),
  key: get('MYZMANIM_KEY'),
  coding: 'JS',
  language: 'en',
  inputdate: '2025-12-12',
  locationid: 'US11210',
}
const qs = new URLSearchParams(params).toString()

async function attempt(label: string, fn: () => Promise<Response>) {
  try {
    const res = await fn()
    const text = await res.text()
    const ok = text.trimStart().startsWith('{')
    console.log(`${label}: HTTP ${res.status} ${ok ? 'JSON ✓' : 'not JSON'}`)
    if (ok) {
      const data = JSON.parse(text)
      console.log(`  ErrMsg: ${data.ErrMsg ?? '(none)'} | Zman fields: ${Object.keys(data.Zman ?? {}).length}`)
      if (data.Zman?.SunsetDefault) console.log(`  SunsetDefault: ${data.Zman.SunsetDefault}`)
    } else {
      console.log(`  ${text.slice(0, 120).replace(/\s+/g, ' ')}`)
    }
  } catch (e) {
    console.log(`${label}: threw ${(e as Error).message}`)
  }
}

await attempt('GET querystring', () =>
  fetch(`https://api.myzmanim.com/engine1.json.aspx/getDay?${qs}`),
)
await attempt('POST form (no charset)', () =>
  fetch('https://api.myzmanim.com/engine1.json.aspx/getDay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: qs,
  }),
)
await attempt('POST json body', () =>
  fetch('https://api.myzmanim.com/engine1.json.aspx/getDay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  }),
)
