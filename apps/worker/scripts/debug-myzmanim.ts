// Debug: print the raw myzmanim response to see the actual error.
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
    coding: 'JS',
    language: 'en',
    inputdate: '2025-12-12',
    locationid: 'US11210',
  })
  const res = await fetch('https://api.myzmanim.com/engine1.json.aspx/getDay', {
    method: 'POST',
    body,
  })
  const text = await res.text()
  console.log(`HTTP ${res.status} ${res.headers.get('content-type')}`)
  console.log(text.slice(0, 600))
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
