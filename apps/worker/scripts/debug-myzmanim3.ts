// Documentation-exact request: POST form-encoded + Accept: application/json.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const env = readFileSync(resolve(here, '../../../.env.deploy'), 'utf8')
const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''

async function main() {
  const body = new URLSearchParams({
    user: get('MYZMANIM_USER'),
    key: get('MYZMANIM_KEY'),
    Coding: 'JS',
    language: 'en',
    locationid: 'US11210',
    inputdate: '2025-12-12',
  }).toString()

  const res = await fetch('https://api.myzmanim.com/engine1.json.aspx/getDay', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  })
  const text = await res.text()
  console.log(`HTTP ${res.status} ${res.headers.get('content-type')}`)
  if (text.trimStart().startsWith('{')) {
    const data = JSON.parse(text)
    console.log('ErrMsg:', data.ErrMsg ?? '(none)')
    console.log('SunsetDefault:', data.Zman?.SunsetDefault)
    console.log('Candles:', data.Zman?.Candles)
  } else {
    console.log(text.slice(0, 300))
  }
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
