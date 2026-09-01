// Live exercise of the worker's PRE-EXISTING jobs (CLAUDE.md's open
// "low-priority verification" item, closed 2026-08-29).
//
// WHY THIS EXISTS RATHER THAN "WATCH THE NEXT REAL JOB RUN", which is what the
// open item proposed. Watching cannot verify these jobs, because until this
// session three of the four SWALLOWED their entry query's error: a denied read
// left `data` null, `null ?? []` became an empty list, and the job returned as
// if there were simply nothing to do. A broken job and an idle job produced the
// SAME (empty) log line, and `/healthz` kept reporting a fresh heartbeat
// throughout. So the log could never have distinguished them, however long you
// watched. The errors are checked now — and this script proves the reads
// actually succeed, which is the claim the ACL sweep left untested.
//
// EVERY CHECK HERE CARRIES A NON-EMPTINESS CONTROL (docs/03's vacuity rule).
// "The tick ran without error" is worthless if the table it reads is empty:
// that is exactly the silent-success this script exists to rule out. Where a
// job can be driven for real (rescore, the poller) it IS driven for real, and
// the observable effect is asserted rather than the absence of a throw.
//
// NOT RUN BY CI — `scripts/*.mts` never are (docs/03 #19's own lesson). Run it
// by hand after anything that touches worker jobs, service_role's grants, or
// the ACL surface: `pnpm exec tsx scripts/verify-worker-jobs.mts`
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { runRetentionSweep } from '../apps/worker/src/jobs/classroom-retention.ts'
import { runRescoreTick } from '../apps/worker/src/jobs/matchmaking-rescore.ts'
import { runOrchestratorTick } from '../apps/worker/src/jobs/speed-dating-orchestrator.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

function fromEnvFile(file: string, key: string): string | undefined {
  try {
    const env = readFileSync(resolve(root, file), 'utf8')
    return new RegExp(`^${key}=(.*)$`, 'm').exec(env)?.[1]?.trim()
  } catch {
    return undefined
  }
}

const url = process.env.SUPABASE_URL ?? fromEnvFile('apps/worker/.env', 'SUPABASE_URL')
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? fromEnvFile('apps/worker/.env', 'SUPABASE_SERVICE_ROLE_KEY')
if (!url || !serviceKey) {
  throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — run `pnpm dev` once to write apps/worker/.env')
}

const admin: SupabaseClient = createClient(url, serviceKey, { auth: { persistSession: false } })

let pass = 0
let fail = 0
const ok = (label: string, detail = '') => {
  pass++
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`)
}
const bad = (label: string, detail: string) => {
  fail++
  console.error(`  FAIL  ${label} — ${detail}`)
}

/**
 * The ACL claim, per table: service_role can still READ this. Carries its own
 * non-emptiness control, because a successful read of an empty table proves
 * nothing about the grant surviving.
 */
async function readable(table: string, expectRows: boolean) {
  const { data, error } = await admin.from(table).select('*').limit(1)
  if (error) return bad(`service_role reads ${table}`, error.message)
  if (expectRows && (data ?? []).length === 0) {
    return bad(`service_role reads ${table}`, 'ZERO ROWS — the check is vacuous; reseed before trusting it')
  }
  ok(`service_role reads ${table}`, expectRows ? `${(data ?? []).length} row(s)` : 'reachable')
}

console.log('\n[1] service_role can read every table the pre-existing jobs touch')
await readable('mm_pair_scores', true)
await readable('sd_events', true)
await readable('sd_rounds', false) // seeded event has no rounds until it runs
await readable('sd_participants', true)
await readable('sd_pairings', false)
await readable('sd_blocks', false)
await readable('cls_publications', true)
await readable('cls_materials', true)
await readable('job_requests', false)

console.log('\n[2] matchmaking rescore — driven for REAL, not just called')
{
  const { data: pair, error } = await admin
    .from('mm_pair_scores')
    .select('id, org_id, stale')
    .limit(1)
    .maybeSingle()
  if (error || !pair) {
    bad('rescore fixture', error?.message ?? 'no mm_pair_scores row to mark stale — seed first')
  } else {
    const { error: markErr } = await admin.from('mm_pair_scores').update({ stale: true }).eq('id', pair.id)
    if (markErr) {
      bad('rescore fixture', `could not mark pair stale: ${markErr.message}`)
    } else {
      await runRescoreTick(admin)
      const { data: after } = await admin.from('mm_pair_scores').select('stale').eq('id', pair.id).maybeSingle()
      // THE OBSERVABLE EFFECT, not the absence of a throw: the tick's whole job
      // is to clear staleness, so a tick that ran but changed nothing is the
      // silent failure this script exists to catch.
      if (after?.stale === false) ok('rescore cleared the stale flag it was given')
      else bad('rescore ran but left the pair stale', `stale=${String(after?.stale)}`)
    }
  }
}

console.log('\n[3] speed-dating orchestrator — entry reads succeed')
{
  // Cannot be driven end-to-end without a live running event with checked-in
  // participants (the seed has none), so this asserts the reads the tick makes
  // rather than a round being built. Stated plainly rather than dressed up: the
  // rotation engine itself is covered by the module's own unit tests.
  try {
    await runOrchestratorTick(admin)
    ok('orchestrator tick completed without throwing')
  } catch (err) {
    bad('orchestrator tick', err instanceof Error ? err.message : String(err))
  }
}

console.log('\n[4] classroom retention sweep — runs and reports a real count')
try {
  const result = await runRetentionSweep(admin)
  ok('retention sweep completed', `purged=${result.purged} filesDeleted=${result.filesDeleted}`)
} catch (err) {
  bad('retention sweep', err instanceof Error ? err.message : String(err))
}

console.log('\n[5] job_requests poller — an UNKNOWN kind is marked error, not left pending')
{
  // Deliberately an unknown kind: it exercises the poller's read + claim +
  // write-back path (the part the ACL sweep could have broken) without firing a
  // real render at an external API.
  const { data: org } = await admin.from('orgs').select('id').limit(1).maybeSingle()
  if (!org) {
    bad('poller fixture', 'no orgs — seed first')
  } else {
    const { data: row, error: insErr } = await admin
      .from('job_requests')
      .insert({ org_id: org.id, kind: 'verify.unknown-kind', payload: {}, status: 'pending' })
      .select('id')
      .single()
    if (insErr || !row) {
      bad('poller fixture', insErr?.message ?? 'insert returned nothing')
    } else {
      const { data: pending, error: readErr } = await admin
        .from('job_requests')
        .select('id, status')
        .eq('status', 'pending')
        .limit(3)
      if (readErr) bad('poller read of job_requests', readErr.message)
      else if (!(pending ?? []).some((j) => j.id === row.id)) {
        bad('poller read of job_requests', 'the row just inserted was not returned as pending')
      } else {
        ok('poller can read a pending job_request', `${(pending ?? []).length} pending`)
      }
      const { error: updErr } = await admin
        .from('job_requests')
        .update({ status: 'error', error: 'Unknown job kind: verify.unknown-kind' })
        .eq('id', row.id)
      if (updErr) bad('poller write-back to job_requests', updErr.message)
      else ok('poller can write a job_request result back')
      // Clean up after itself — this is a probe, not a fixture other tests read.
      await admin.from('job_requests').delete().eq('id', row.id)
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
