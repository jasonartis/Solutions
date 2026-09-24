// Fill the LOCAL zmanim cache to the horizon, and optionally COPY it to prod.
//
//   pnpm exec tsx scripts/zmanim-backfill.mts                 # fill local only
//   pnpm exec tsx scripts/zmanim-backfill.mts --to-prod       # fill local, then copy
//   pnpm exec tsx scripts/zmanim-backfill.mts --to-prod --copy-only
//
// WHY TWO PHASES RATHER THAN RUNNING THE SWEEP AGAINST PROD. The API calls are
// made from the development environment and only the RESULTING ROWS are copied
// to production — the founder's reading of the trial licence (2026-09-24),
// which turns on where the API is *used*. It is also simply safer: prod never
// needs credentials, and a bad response can never reach it, because phase 1's
// own validation (docs/23 section 5, never cache a failure) has already run.
//
// Zmanim for a (location, date) are a fixed astronomical fact, so a copied row
// is not stale data — it is the same answer the API would give again.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { runZmanimPrefetch } from '../apps/worker/src/jobs/zmanim-prefetch'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

for (const file of ['apps/web/.env.local', '.env.deploy']) {
  try {
    for (const line of readFileSync(resolve(root, file), 'utf8').split(/\r?\n/)) {
      const m = /^(MYZMANIM_[A-Z_]+)=(.*)$/.exec(line)
      if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  } catch { /* next */ }
}

const deployEnv = readFileSync(resolve(root, '.env.deploy'), 'utf8')
const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(deployEnv)?.[1]?.trim() ?? ''

const TO_PROD = process.argv.includes('--to-prod')
const COPY_ONLY = process.argv.includes('--copy-only')

const localUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
if (localUrl.includes('pooler.supabase.com')) throw new Error('DATABASE_URL points at prod; this script fills LOCAL')

const local = postgres(localUrl, { max: 1 })

async function main() {
  // -------------------------------------------------------------------------
  // PHASE 1 — fill the local cache using the local switch and the real API.
  // -------------------------------------------------------------------------
  if (!COPY_ONLY) {
    const saved = (await local`select value from public.platform_settings where key = 'zmanim.prefetch'`)[0]?.value
    if (!saved) throw new Error('no zmanim.prefetch settings row — is the migration applied locally?')

    console.log('Phase 1: filling the LOCAL cache from the API...\n')
    await local`
      update public.platform_settings
      set value = value || ${local.json({ enabled: true })}
      where key = 'zmanim.prefetch'`
    try {
      // One pass over the whole horizon. The sweep stops a location on its first
      // failure, so a partial result means something went wrong — re-run to
      // resume, since it only ever fetches what is still missing.
      const res = await runZmanimPrefetch(localUrl, { origin: 'backfill', budgetOverride: 400 })
      console.log(`\n  wrote ${res.written}, failed ${res.failed}, across ${res.locations} location(s)`)
    } finally {
      await local`
        update public.platform_settings set value = ${local.json(saved as never)}
        where key = 'zmanim.prefetch'`
      console.log('  (local switch restored to its previous value)')
    }
  }

  const localRows = await local<{ location_key: string; n: number; lo: string; hi: string }[]>`
    select location_key, count(*)::int as n,
           to_char(min(date), 'YYYY-MM-DD') as lo, to_char(max(date), 'YYYY-MM-DD') as hi
    from public.syn_zmanim_cache where source = 'myzmanim'
    group by location_key order by location_key`
  console.log('\nLOCAL cache now holds:')
  for (const r of localRows) console.log(`  ${r.location_key}: ${r.n} days, ${r.lo} .. ${r.hi}`)

  if (!TO_PROD) {
    console.log('\n(--to-prod not given; nothing was copied)')
    return
  }

  // -------------------------------------------------------------------------
  // PHASE 2 — copy those rows to production. No API calls, no credentials.
  // -------------------------------------------------------------------------
  const ref = get('SUPABASE_PROJECT_REF')
  const pw = get('SUPABASE_DB_PASSWORD')
  if (!ref || !pw) throw new Error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD in .env.deploy')
  const prod = postgres(
    `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`,
    { ssl: 'require', max: 1 },
  )

  try {
    console.log(`\nPhase 2: copying to PRODUCTION (${ref})...`)
    const before = (await prod<{ n: number }[]>`select count(*)::int as n from public.syn_zmanim_cache`)[0]!.n

    const all = await local<{ location_key: string; date: string; payload: unknown }[]>`
      select location_key, to_char(date, 'YYYY-MM-DD') as date, payload
      from public.syn_zmanim_cache where source = 'myzmanim' order by location_key, date`

    // Chunked upsert: one statement per 100 rows keeps the payloads well inside
    // any statement-size limit and makes progress visible on a slow link.
    const CHUNK = 100
    for (let i = 0; i < all.length; i += CHUNK) {
      const slice = all.slice(i, i + CHUNK)
      await prod`
        insert into public.syn_zmanim_cache ${prod(
          slice.map((r) => ({
            location_key: r.location_key,
            date: r.date,
            source: 'myzmanim',
            payload: r.payload as never,
          })),
          'location_key', 'date', 'source', 'payload',
        )}
        on conflict (location_key, date, source)
          do update set payload = excluded.payload, fetched_at = now()`
      process.stdout.write(`\r  ${Math.min(i + CHUNK, all.length)}/${all.length}`)
    }

    const after = await prod<{ location_key: string; n: number; lo: string; hi: string }[]>`
      select location_key, count(*)::int as n,
             to_char(min(date), 'YYYY-MM-DD') as lo, to_char(max(date), 'YYYY-MM-DD') as hi
      from public.syn_zmanim_cache where source = 'myzmanim'
      group by location_key order by location_key`
    console.log(`\n\nPRODUCTION cache: ${before} rows before, ${after.reduce((a, r) => a + r.n, 0)} after`)
    for (const r of after) console.log(`  ${r.location_key}: ${r.n} days, ${r.lo} .. ${r.hi}`)

    // A copied row is worthless if it did not survive the trip intact.
    const sane = await prod<{ zman_fields: number; has_place: boolean }[]>`
      select (select count(*) from jsonb_object_keys(payload -> 'Zman'))::int as zman_fields,
             (payload ? 'Place') as has_place
      from public.syn_zmanim_cache where source = 'myzmanim' limit 1`
    console.log(`  spot-check: ${sane[0]?.zman_fields} Zman fields, Place section ${sane[0]?.has_place ? 'present' : 'MISSING'}`)
  } finally {
    await prod.end()
  }
}

main()
  .catch((err) => { console.error('\n', err); process.exitCode = 1 })
  .finally(() => local.end())
