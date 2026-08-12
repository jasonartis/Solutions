// LOCAL verifier for engagement monitoring phase 2 (20260810010000).
// Verifies the adversarial review's findings and the fixes applied on 2026-08-11
// against a real local stack, as real users, through PostgREST — which is the
// only layer that matters here, since `authenticated` reaches this table
// directly. Lives in the repo because tsx resolves
// dependencies from the script's own location (documented host gotcha).
// Run: pnpm exec tsx scripts/verify-activity-capture.mts (needs a seeded local stack).
// Re-runnable: it clears both activity tables as the owner before asserting.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import postgres from 'postgres'

// Read .env by hand — `dotenv` is not a root dependency here.
// `dirname(fileURLToPath(...))` and NOT `new URL(...).pathname`: the latter
// leaves the space in "D:\Solutions Platform" percent-encoded (host gotcha).
for (const line of readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '')
}

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const anonKey = process.env.SUPABASE_ANON_KEY ?? ''
const dbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

let pass = 0
let fail = 0
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

async function signIn(email: string): Promise<SupabaseClient> {
  const c = createClient(url, anonKey, { auth: { persistSession: false } })
  const { error } = await c.auth.signInWithPassword({ email, password: 'password123' })
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`)
  return c
}

const main = async () => {
  if (!anonKey) throw new Error('SUPABASE_ANON_KEY not set')

  const owner = await signIn('owner@demo.local')   // superadmin — the only reader
  const dana = await signIn('dana@demo.local')     // salon WORKER (rank 1)
  const charlie = await signIn('charlie@demo.local') // salon CUSTOMER (rank 0)
  const bob = await signIn('bob@demo.local')       // admin of Demo Org B — NOT a salon member

  const salon = (await owner.from('orgs').select('id').eq('slug', 'demo-salon').single()).data!.id as string
  const orgB = (await owner.from('orgs').select('id').eq('slug', 'demo-org-b').maybeSingle()).data?.id as string | undefined
  const danaId = (await owner.from('profiles').select('user_id').eq('email', 'dana@demo.local').single()).data!.user_id as string
  const charlieId = (await owner.from('profiles').select('user_id').eq('email', 'charlie@demo.local').single()).data!.user_id as string

  // Start from a clean slate so the probe is RE-RUNNABLE. Several assertions
  // below count rows exactly, and a second run against leftovers from the first
  // fails for a reason that has nothing to do with the schema — the documented
  // trap when reproducing a non-idempotent test. Only the owner can do this;
  // no api role holds DELETE on either table, which is itself asserted later.
  {
    const clean = postgres(dbUrl, { prepare: false, max: 1 })
    try {
      await clean`delete from public.activity_events`
      await clean`delete from public.activity_rollup`
    } finally { await clean.end() }
  }

  console.log('\n--- 1. CONTROL: capture actually works (everything below is vacuous without this)')
  const ins = await dana.from('activity_events').insert({
    org_id: salon, module_key: 'nail-salon', action: 'appointment.booked_by_staff',
  })
  ok('a salon worker can record an action', ins.error == null, JSON.stringify(ins.error))
  const evRows = (await owner.from('activity_events').select('*').eq('user_id', danaId)).data ?? []
  ok('the event is readable by the superadmin', evRows.length > 0)
  const roll = (await owner.from('activity_rollup').select('*').eq('user_id', danaId)).data ?? []
  ok('the rollup counted it', roll.length > 0 && Number(roll[0]!.observed_actions) >= 1)
  ok('rollup is keyed on action (the 2026-08-11 change)',
    roll.length > 0 && roll[0]!.action === 'appointment.booked_by_staff',
    JSON.stringify(roll[0]))

  console.log('\n--- 2. The guard stamps what the app cannot be trusted with')
  await dana.from('activity_events').insert({
    org_id: salon, module_key: 'nail-salon', action: 'bill.paid',
    user_id: charlieId,                                  // forged identity
    occurred_at: '2020-01-01T00:00:00Z',                 // forged time
    actor_grants: [{ role: 'admin', scope_ref: null }],  // forged authority
  } as never)
  const forged = (await owner.from('activity_events').select('*').eq('action', 'bill.paid')).data ?? []
  ok('a forged user_id is discarded — the row belongs to the caller',
    forged.length === 1 && forged[0]!.user_id === danaId, JSON.stringify(forged[0]?.user_id))
  ok('a forged occurred_at is discarded — server time is stamped',
    forged.length === 1 && new Date(forged[0]!.occurred_at as string).getFullYear() > 2020)
  const grants = (forged[0]?.actor_grants ?? []) as { role: string }[]
  ok('a forged actor_grants is discarded and the REAL grant derived',
    grants.some((g) => g.role === 'worker') && !grants.some((g) => g.role === 'admin'),
    JSON.stringify(grants))

  console.log('\n--- 3. FINDING 1 (HIGH): the permanent-rollup amplification is now bounded')
  const uuidAction = await dana.from('activity_events').insert({
    org_id: salon, module_key: 'nail-salon', action: crypto.randomUUID(),
  })
  ok('a random-uuid action is REFUSED (unbounded permanent rollup rows)',
    uuidAction.error != null, 'it was accepted')
  const longAction = await dana.from('activity_events').insert({
    org_id: salon, module_key: 'nail-salon', action: 'a.' + 'x'.repeat(500),
  })
  ok('an over-long action is REFUSED', longAction.error != null, 'it was accepted')
  const bigBlob = await dana.from('activity_events').insert({
    org_id: salon, module_key: 'nail-salon', action: 'bill.paid', dedupe_key: 'x'.repeat(5000),
  })
  ok('an over-long dedupe_key is REFUSED', bigBlob.error != null, 'it was accepted')
  const badModule = await dana.from('activity_events').insert({
    org_id: salon, module_key: 'not-a-module', action: 'bill.paid',
  })
  ok('an unknown module_key is REFUSED', badModule.error != null, 'it was accepted')
  const goodStillWorks = await dana.from('activity_events').insert({
    org_id: salon, module_key: 'nail-salon', action: 'walk_in.added',
  })
  ok('CONTROL: a well-formed NEW action still needs no migration',
    goodStillWorks.error == null, JSON.stringify(goodStillWorks.error))

  console.log('\n--- 4. FINDING 4 (LOW): whitespace-only dedupe_key no longer collapses history')
  await dana.from('activity_events').insert({
    org_id: salon, module_key: 'nail-salon', action: 'expense.added', dedupe_key: '\t',
  })
  await dana.from('activity_events').insert({
    org_id: salon, module_key: 'nail-salon', action: 'expense.added', dedupe_key: '\t',
  })
  const tabRows = (await owner.from('activity_events').select('id, dedupe_key').eq('action', 'expense.added')).data ?? []
  ok('a tab-only dedupe_key is normalised to null, so BOTH rows land',
    tabRows.length === 2 && tabRows.every((r) => r.dedupe_key === null),
    JSON.stringify(tabRows))

  console.log('\n--- 5. Tenancy: the guard verifies membership rather than trusting the caller')
  const crossOrg = await dana.from('activity_events').insert({
    org_id: orgB ?? '00000000-0000-0000-0000-000000000001', module_key: 'nail-salon', action: 'bill.paid',
  })
  ok('a non-member cannot record activity in another org', crossOrg.error != null, 'it was accepted')
  const placeholder = await dana.from('activity_events').insert({
    org_id: '00000000-0000-0000-0000-000000000000', module_key: 'nail-salon', action: 'bill.paid',
  })
  ok('the DERIVED_SCOPE_PLACEHOLDER is refused by name',
    placeholder.error != null && /placeholder/i.test(placeholder.error.message),
    placeholder.error?.message)

  console.log('\n--- 6. An EMPTY grant array is a real answer, not a defect')
  await charlie.from('activity_events').insert({
    org_id: salon, module_key: 'nail-salon', action: 'appointment.booked_by_customer',
  })
  const cRows = (await owner.from('activity_events').select('actor_grants, actor_org_role').eq('user_id', charlieId)).data ?? []
  ok('a customer booking their own appointment is recorded', cRows.length > 0, JSON.stringify(cRows))
  if (cRows.length) console.log(`        charlie's derived grants: ${JSON.stringify(cRows[0]!.actor_grants)}`)

  // NOTE WHAT THIS PROBE CANNOT SHOW, stated rather than faked: EVERY seeded
  // Demo Salon member holds some salon grant — charlie has an explicit
  // `customer` role, grace a SCOPED `manager` — so the empty-`actor_grants`
  // path the migration argues must be legal is NOT reachable from seed data.
  // It needs a purpose-made fixture (an org member with no module_roles row for
  // that module) and belongs in the RLS suite, not here. Asserting it against
  // these users would have passed for the wrong reason or failed misleadingly.
  //
  // What grace DOES prove, and it is the more valuable half: a SCOPED grant is
  // stamped with its scope_ref intact, so the {role, scope_ref} PAIRING that the
  // whole actor_grants design turns on is real and not a flattened role name.
  try {
    const grace = await signIn('grace@demo.local')
    const graceId = (await owner.from('profiles').select('user_id').eq('email', 'grace@demo.local').single()).data!.user_id as string
    const gIns = await grace.from('activity_events').insert({
      org_id: salon, module_key: 'nail-salon', action: 'walk_in.added',
    })
    ok('another salon member can record activity', gIns.error == null, JSON.stringify(gIns.error))
    const gRows = (await owner.from('activity_events').select('actor_grants, actor_org_role').eq('user_id', graceId)).data ?? []
    const gGrants = (gRows[0]?.actor_grants ?? []) as { role: string; scope_ref: string | null }[]
    ok('a SCOPED grant keeps its scope_ref paired with its role',
      gGrants.length > 0 && gGrants.every((g) => 'role' in g && 'scope_ref' in g) &&
      gGrants.some((g) => g.scope_ref != null),
      JSON.stringify(gGrants))
    ok('the org seat is recorded alongside the module grants',
      gRows.length > 0 && gRows[0]!.actor_org_role != null, JSON.stringify(gRows[0]?.actor_org_role))
  } catch (e) {
    ok('grace@demo.local is reachable', false, String(e))
  }

  console.log('\n--- 7. THE READ RULE: superadmin only, at any rank')
  for (const [who, c] of [['dana (worker)', dana], ['charlie (customer)', charlie], ['bob (other org admin)', bob]] as const) {
    ok(`${who} cannot read activity_events`, ((await c.from('activity_events').select('id')).data ?? []).length === 0)
    ok(`${who} cannot read activity_rollup`, ((await c.from('activity_rollup').select('user_id')).data ?? []).length === 0)
  }
  ok('dana cannot read her OWN activity (no self-read arm)',
    ((await dana.from('activity_events').select('id').eq('user_id', danaId)).data ?? []).length === 0)

  console.log('\n--- 8. Append-only: not even the superadmin may write')
  const anyRow = (await owner.from('activity_events').select('id').limit(1)).data![0]!
  ok('superadmin cannot UPDATE an event',
    (await owner.from('activity_events').update({ action: 'bill.paid' }).eq('id', anyRow.id)).error != null)
  ok('superadmin cannot DELETE an event',
    (await owner.from('activity_events').delete().eq('id', anyRow.id)).error != null)
  ok('superadmin cannot INSERT a rollup row directly',
    (await owner.from('activity_rollup').insert({
      user_id: danaId, org_id: salon, module_key: 'nail-salon', action: 'x.y',
      first_observed_at: new Date().toISOString(), last_activity_at: new Date().toISOString(), observed_actions: 99,
    } as never)).error != null)
  ok('CONTROL: the row survived those refusals',
    ((await owner.from('activity_events').select('id').eq('id', anyRow.id)).data ?? []).length === 1)

  console.log('\n--- 9. REVIEW FINDING 5, the part it could NOT test: PostgREST upsert vs the partial dedupe index')
  const up = await dana.from('activity_events').upsert(
    { org_id: salon, module_key: 'nail-salon', action: 'bill.created', dedupe_key: 'k1' } as never,
    { onConflict: 'user_id,org_id,module_key,action,dedupe_key' },
  )
  console.log(`        first upsert  -> ${up.error ? `${up.error.code}: ${up.error.message}` : 'accepted'}`)
  const up2 = await dana.from('activity_events').upsert(
    { org_id: salon, module_key: 'nail-salon', action: 'bill.created', dedupe_key: 'k1' } as never,
    { onConflict: 'user_id,org_id,module_key,action,dedupe_key' },
  )
  console.log(`        second upsert -> ${up2.error ? `${up2.error.code}: ${up2.error.message}` : 'ACCEPTED (investigate)'}`)
  // The answer is STRONGER than "the index held": PostgREST cannot aim ON
  // CONFLICT at a PARTIAL index at all (it cannot supply the index predicate),
  // so both upserts are refused outright with 42P10 and no row is written.
  // Confirms the review's reasoned-but-untested finding 5, empirically.
  ok('a PostgREST upsert cannot target the partial dedupe index (42P10)',
    up.error?.code === '42P10' && up2.error?.code === '42P10',
    `${up.error?.code} / ${up2.error?.code}`)
  const dupRows = (await owner.from('activity_events').select('id').eq('action', 'bill.created')).data ?? []
  ok('no row was written by the refused upserts', dupRows.length === 0, `${dupRows.length} rows`)

  console.log('\n--- 10. The pruner: 90-day literal, invoker, no api-role EXECUTE')
  const sql = postgres(dbUrl, { prepare: false, max: 1 })
  try {
    const fn = (await sql`
      select p.prosecdef, p.pronargs, pg_get_functiondef(p.oid) as def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'activity_events_prune'`) as unknown as
      { prosecdef: boolean; pronargs: number; def: string }[]
    ok('CONTROL: activity_events_prune exists', fn.length === 1)
    if (fn.length) {
      ok('the pruner is security INVOKER', fn[0]!.prosecdef === false)
      ok('the pruner takes no arguments', fn[0]!.pronargs === 0)
      ok('the 90-day window is a literal in the body', /interval\s+'90 days'/.test(fn[0]!.def))
    }
    const rollupFn = (await sql`
      select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'activity_rollup_apply'`) as unknown as { def: string }[]
    ok('CONTROL: activity_rollup_apply exists', rollupFn.length === 1)
    ok('THE FIX: the contending rollup upsert carries its own lock_timeout',
      rollupFn.length === 1 && /SET\s+lock_timeout/i.test(rollupFn[0]!.def))

    const acl = (await sql`
      select r.rolname,
             has_function_privilege(r.rolname, 'public.activity_events_prune()', 'execute') as prune,
             has_function_privilege(r.rolname, 'public.is_superadmin()', 'execute') as control
      from pg_roles r where r.rolname in ('postgres','authenticated','service_role','anon')`) as unknown as
      { rolname: string; prune: boolean; control: boolean }[]
    const of = (r: string) => acl.find((x) => x.rolname === r)
    ok('CONTROL: has_function_privilege reports true for a granted function', of('authenticated')?.control === true)
    ok('the owner CAN prune', of('postgres')?.prune === true)
    for (const r of ['authenticated', 'service_role', 'anon']) {
      ok(`${r} cannot EXECUTE the pruner`, of(r)?.prune === false)
    }

    const pol = (await sql`
      select tablename, policyname, cmd, qual, with_check from pg_policies
      where schemaname='public' and tablename in ('activity_events','activity_rollup')`) as unknown as
      { tablename: string; policyname: string; cmd: string; qual: string; with_check: string }[]
    const allPol = (await sql`select count(*)::int as n from pg_policies where schemaname='public'`) as unknown as { n: number }[]
    ok('CONTROL: pg_policies is populated', allPol[0]!.n > 100)
    ok('exactly three policies', pol.length === 3, JSON.stringify(pol.map((p) => `${p.policyname}:${p.cmd}`)))
    ok('no policy is FOR ALL', pol.every((p) => p.cmd === 'SELECT' || p.cmd === 'INSERT'))
    ok('no policy grew a module rank arm',
      pol.every((p) => !/module_position_rank|module_scope_covers/.test(`${p.qual} ${p.with_check}`)))

    const trg = (await sql`
      select t.tgname, t.tgenabled from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where c.relname = 'activity_events' and not t.tgisinternal`) as unknown as
      { tgname: string; tgenabled: string }[]
    ok('both triggers are BOUND and enabled, not merely defined',
      trg.length === 2 && trg.every((t) => t.tgenabled === 'O'), JSON.stringify(trg))
  } finally {
    await sql.end()
  }

  console.log(`\n${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
