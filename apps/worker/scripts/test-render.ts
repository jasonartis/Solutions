// Manual end-to-end test of the render job against the seeded Demo Synagogue.
// Run from apps/worker:  pnpm exec tsx scripts/test-render.ts
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { runSynagogueRender } from '../src/jobs/synagogue-render'

const here = dirname(fileURLToPath(import.meta.url))
const env = readFileSync(resolve(here, '../.env'), 'utf8')
const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1] ?? ''

const admin = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
})

async function main() {
  const { data: org } = await admin.from('orgs').select('id').eq('slug', 'demo-shul').single()
  if (!org) throw new Error('demo-shul not seeded')

  const now = new Date()
  const sunday = new Date(now)
  sunday.setDate(now.getDate() - now.getDay())
  const weekStart = `${sunday.getFullYear()}-${String(sunday.getMonth() + 1).padStart(2, '0')}-${String(sunday.getDate()).padStart(2, '0')}`

  console.log(`Rendering demo-shul week ${weekStart}…`)
  const result = await runSynagogueRender(admin, {
    id: 'test',
    org_id: org.id,
    payload: { weekStart },
  })
  console.log('Result:', JSON.stringify(result, null, 2))

  const { data: files } = await admin.storage.from('syn-exports').list(`${org.id}/${weekStart}`)
  console.log('Files in bucket:', files?.map((f) => `${f.name} (${JSON.stringify(f.metadata?.size)}b)`))
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
