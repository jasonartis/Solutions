/**
 * THE ACCEPTANCE TEST FOR THE EMAIL SLICE (docs/22 §16.7), runnable by a
 * non-engineer against a local stack that is up and seeded.
 *
 *   pnpm exec tsx scripts/verify-profile-visibility-local.mts
 *
 * It signs in as charlie@demo.local — a RANK-0 NAIL-SALON CUSTOMER, the
 * lowest-privilege real account seeded, holding no role of any kind — and then
 * asks the database exactly what his browser could ask it, with the token the
 * app itself issued. Before this slice that returned EIGHT people's names AND
 * EMAIL ADDRESSES, including the salon admin's.
 *
 * Every negative below carries a CONTROL, so a pass cannot be vacuous: if the
 * whole query surface were broken, or Charlie were not really signed in, or the
 * table were empty, the controls fail and the run is not green.
 */
const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const ANON =
  process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlLWRlbW8iLCJpYXQiOjE2NDE3NjkyMDAsImV4cCI6MTc5OTUzNTYwMH0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE'
const PASSWORD = process.env.VERIFY_DEMO_PASSWORD ?? 'password123'

let pass = 0
let fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) {
    pass++
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

async function signIn(email: string) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  if (!res.ok) throw new Error(`sign-in as ${email} failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as { access_token: string; user: { id: string; email: string } }
}

const rest = async (token: string, path: string) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: ANON, Authorization: `Bearer ${token}` },
  })
  return { status: res.status, body: await res.text() }
}

async function main() {
  console.log('THE ACCEPTANCE TEST — docs/22 §16.7, run as charlie@demo.local (rank-0 salon customer)\n')
  const charlie = await signIn('charlie@demo.local')
  console.log(`signed in as ${charlie.user.email} (${charlie.user.id})\n`)

  // --- CALL 1: the exact query from §16.7 -----------------------------------
  console.log('CALL 1  GET /rest/v1/profiles?select=display_name,email,is_superadmin')
  const call1 = await rest(charlie.access_token, 'profiles?select=display_name,email,is_superadmin')
  ok(
    'the columns do not exist — the query is REFUSED, not answered',
    call1.status >= 400 && /does not exist/i.test(call1.body),
    `${call1.status} ${call1.body.slice(0, 120)}`,
  )

  // --- CALL 2: the same query, asking for each moved column on its own ------
  console.log('\nCALL 2  the same read, one moved column at a time')
  for (const col of ['email', 'is_superadmin', 'settings']) {
    const r = await rest(charlie.access_token, `profiles?select=${col}`)
    ok(`profiles.${col} is gone`, r.status >= 400 && /does not exist/i.test(r.body), `${r.status}`)
  }

  // --- CONTROLS: the query surface works, and Charlie really is signed in ---
  console.log('\nCONTROLS — so the four negatives above are not vacuous')
  const names = await rest(charlie.access_token, 'profiles?select=display_name')
  const nameRows = names.status === 200 ? (JSON.parse(names.body) as unknown[]) : []
  ok(
    'CONTROL: the same table, same token, same request shape still ANSWERS',
    names.status === 200 && nameRows.length > 0,
    `${names.status}, ${nameRows.length} display_name rows — so the refusals above are about the COLUMNS, not a broken query, a bad token or an empty table`,
  )

  const selfPrivate = await rest(charlie.access_token, 'user_private?select=user_id,settings,is_superadmin')
  const selfRows = selfPrivate.status === 200 ? (JSON.parse(selfPrivate.body) as { user_id: string }[]) : []
  ok(
    'his own private row IS readable — exactly one, his own',
    selfPrivate.status === 200 && selfRows.length === 1 && selfRows[0].user_id === charlie.user.id,
    `${selfPrivate.status}, ${selfRows.length} row(s)`,
  )
  ok(
    'CONTROL: and NOT anyone else\'s — the companion table is not a new directory',
    selfRows.every((r) => r.user_id === charlie.user.id),
    `${selfRows.length} row(s) returned, ${nameRows.length} people are visible to him by name`,
  )

  // --- THE ONE THING THIS SLICE DELIBERATELY DOES NOT CHANGE ----------------
  console.log('\nNOT IN SCOPE, asserted so nobody mistakes it for a regression')
  ok(
    'he still reads co-members\' NAMES — profiles_select_shared_org is untouched',
    nameRows.length > 1,
    `${nameRows.length} names. Killing the blanket member directory is docs/22 §19.4 and it is BLOCKED on the founder-deferred entity-level question (§20.2). A name is the PUBLIC identity row and decision 6 keeps it.`,
  )

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
