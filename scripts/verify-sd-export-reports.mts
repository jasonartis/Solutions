// LOCAL check (2026-11-05) of the speed-dating export's "Safety reports I filed"
// data set (modules/speed-dating/ui/export.ts, key my-reports). Runs the real
// fetch with a real signed-in client, so RLS decides exactly as in /api/export.
//   charlie (filed the seeded report)  -> >= 1 row, only reporter-side columns
//   dana    (filed none)               -> 0 rows   (CONTROL for the above: the
//                                         set is not "everything readable")
//   charlie's rows must not carry reported_participant_id / reviewed_by.
// Read-only. Run: node node_modules/tsx/dist/cli.mjs scripts/verify-sd-export-reports.mts
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'
import { speedDatingExport } from '../modules/speed-dating/ui/export.ts'

for (const line of readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '')
}
const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const anonKey = process.env.SUPABASE_ANON_KEY ?? ''
const dbUrl = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

let fails = 0
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${cond || !detail ? '' : `  (${detail})`}`)
  if (!cond) fails++
}

const sql = postgres(dbUrl, { max: 1 })
const [org] = await sql<{ id: string }[]>`select id from orgs where slug = 'demo-dating'`
const idOf = async (email: string) => (await sql<{ id: string }[]>`select id from auth.users where email = ${email}`)[0]!.id
const [{ n: seeded }] = await sql<{ n: number }[]>`
  select count(*)::int as n from sd_reports r join sd_participants p on p.id = r.reporter_participant_id
  join auth.users u on u.id = p.user_id where u.email = 'charlie@demo.local' and r.org_id = ${org!.id}`
const ids = { charlie: await idOf('charlie@demo.local'), dana: await idOf('dana@demo.local') }
await sql.end()

const set = speedDatingExport.dataSets.find((d) => d.key === 'my-reports')!
check('the data set exists and is participant-only', !!set && set.hats.join() === 'participant')

async function as(email: 'charlie@demo.local' | 'dana@demo.local') {
  const c = createClient(url, anonKey, { auth: { persistSession: false } })
  const { error } = await c.auth.signInWithPassword({ email, password: 'password123' })
  if (error) throw new Error(`${email}: ${error.message}`)
  return set.fetch(c as never, { orgId: org!.id, userId: ids[email.split('@')[0] as 'charlie' | 'dana'] } as never)
}

const charlie = await as('charlie@demo.local')
check('CONTROL: charlie filed a report in the seed', seeded > 0, `seeded=${seeded}`)
check("charlie's export has exactly his reports", charlie.length === seeded, `got ${charlie.length}, expected ${seeded}`)
check('rows carry reason, state and the event name',
  charlie.length > 0 && charlie.every((r) => 'reason' in r && 'state' in r && (r.event as { name?: string } | null)?.name))
check('rows never carry who was reported or who reviewed',
  charlie.every((r) => !('reported_participant_id' in r) && !('reviewed_by' in r)))
const dana = await as('dana@demo.local')
check('dana (filed none) exports none', dana.length === 0, `got ${dana.length}`)

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED')
process.exit(fails ? 1 : 0)
