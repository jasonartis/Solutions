// One-off (founder, 2026-11-15): add the vendor-page rows docs/28 F14–F16 found
// missing — Claude/Anthropic, Hetzner, a DNS host, and the accounts that hold
// copies of the backup keys. Generic names only: which service holds which key
// is filled in by the founder on the superadmin page, never in this public repo.
//
//   node node_modules/tsx/dist/cli.mjs scripts/prod-vendor-rows-2026-11-15.mts          (read only: list rows)
//   node node_modules/tsx/dist/cli.mjs scripts/prod-vendor-rows-2026-11-15.mts --apply  (insert, skip existing)
//
// Inserts run as the database owner; the secret-refusing trigger still fires.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APPLY = process.argv.includes('--apply')

const env = readFileSync(resolve(root, '.env.deploy'), 'utf8')
const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''
const ref = get('SUPABASE_PROJECT_REF')
const pw = get('SUPABASE_DB_PASSWORD')
if (!ref || !pw) throw new Error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD in .env.deploy')
const sql = postgres(
  `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`,
  { ssl: 'require', max: 1 },
)

type Row = {
  service: string
  status: 'active' | 'planned'
  used_for: string
  if_lost: 'platform_down' | 'feature_down' | 'invisible' | 'unclassified'
  breaks_if_lost: string | null
  part_b_ref: string | null
  sign_in_url: string | null
  notes: string | null
}

const ROWS: Row[] = [
  {
    service: 'Claude / Anthropic',
    status: 'active',
    used_for: 'The development team: Claude Code sessions build, review, migrate and run the drills (docs/28 F14).',
    if_lost: 'invisible',
    breaks_if_lost:
      'Users notice nothing. Building, fixing and the drills stop or slow down until another AI coding tool or a developer picks up from the docs.',
    part_b_ref: 'B.2',
    sign_in_url: 'https://claude.ai/login',
    notes: 'Exit plan: the docs in the repo are the standby (CLAUDE.md, docs/). Fill in plan, monthly cost and how it is paid.',
  },
  {
    service: 'Hetzner (standby servers)',
    status: 'planned',
    used_for:
      'Where the standby website (B.3-3), the Jitsi server (B.3-5) and the warm database copy (B.7 Q1) would run; likely also the worker VPS (docs/28 F15).',
    if_lost: 'invisible',
    breaks_if_lost: 'Nothing while nothing runs there. Once used, any other VPS provider can run the same scripts.',
    part_b_ref: 'B.3-3',
    sign_in_url: 'https://accounts.hetzner.com/login',
    notes: 'Open the account, put a card on file and turn on two-step BEFORE the first drill that needs a server.',
  },
  {
    service: 'DNS host',
    status: 'planned',
    used_for:
      'Holds the DNS records for our domain, if they are not kept at the registrar. Decide at the first customer (docs/28 B.4 #11, F15).',
    if_lost: 'unclassified',
    breaks_if_lost: null,
    part_b_ref: 'B.3-3',
    sign_in_url: null,
    notes: null,
  },
  {
    service: 'Cloud account holding the backup decryption key copy',
    status: 'active',
    used_for:
      'Holds one copy of the backup decryption key (docs/28 B.7 Q6, F16). Must not be the account holding the B2 read key, nor the snapshots cloud drive.',
    if_lost: 'invisible',
    breaks_if_lost:
      'One copy of a key nobody can regenerate is gone. With no other copy, every backup and snapshot becomes unreadable.',
    part_b_ref: 'B.8',
    sign_in_url: null,
    notes: 'Fill in which service and "Owned by". The paper copy at home is not made yet (docs/29).',
  },
  {
    service: 'Cloud account holding the B2 read key',
    status: 'active',
    used_for:
      'Holds the B2 read-only key used to download backups for a restore (docs/28 B.7 Q6, F16). Replaceable from the B2 website.',
    if_lost: 'invisible',
    breaks_if_lost: 'A restore first needs a new read key minted on the B2 website (minutes, if the B2 login still works).',
    part_b_ref: 'B.8',
    sign_in_url: null,
    notes: 'Fill in which service and "Owned by". Must be a different account from the decryption key copy.',
  },
  {
    service: 'Cloud drive for offsite snapshots',
    status: 'planned',
    used_for:
      'The cloud copy of the monthly snapshot pair (docs/28 B.8, F16). Must be a different account from the one holding the decryption key copy.',
    if_lost: 'invisible',
    breaks_if_lost: 'The USB stick at home is then the only offsite copy.',
    part_b_ref: 'B.8',
    sign_in_url: null,
    notes: 'Switch to active when pnpm backup:snapshot exists, together with the "Offsite snapshots" chore row.',
  },
]

try {
  const before = await sql<{ service: string; status: string }[]>`select service, status from public.vendor_accounts order by service`
  console.log(`prod (${ref}) has ${before.length} vendor rows:`)
  for (const r of before) console.log(`  ${r.status.padEnd(8)} ${r.service}`)

  const have = new Set(before.map((r) => r.service))
  const todo = ROWS.filter((r) => !have.has(r.service))
  console.log(`\nto add: ${todo.length} of ${ROWS.length}`)
  for (const r of todo) console.log(`  ${r.status.padEnd(8)} ${r.service}`)

  if (APPLY && todo.length > 0) {
    await sql.begin(async (tx) => {
      for (const r of todo) {
        await tx`
          insert into public.vendor_accounts (service, status, used_for, if_lost, breaks_if_lost, part_b_ref, sign_in_url, notes)
          values (${r.service}, ${r.status}, ${r.used_for}, ${r.if_lost}, ${r.breaks_if_lost}, ${r.part_b_ref}, ${r.sign_in_url}, ${r.notes})`
      }
    })
    const after = await sql<{ n: number }[]>`select count(*)::int as n from public.vendor_accounts`
    const added = await sql<{ service: string }[]>`select service from public.vendor_accounts where service in ${sql(ROWS.map((r) => r.service))}`
    console.log(`\napplied. rows now ${after[0]!.n} (was ${before.length}); ${added.length}/${ROWS.length} of this script's rows present`)
  }
} finally {
  await sql.end()
}
