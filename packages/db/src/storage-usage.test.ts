import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'
import {
  BUCKET_MODULE,
  dataBrowserDeclarations,
  moduleForTable,
  platformDataBrowser,
  type DataBrowserDeclaration,
} from '@platform/core'

// ---------------------------------------------------------------------------
// PLATFORM STORAGE USAGE (20261115010000) — the Owner Console's size estimate.
//
// Every probe runs AS a real role (anon, a signed-in member, the superadmin)
// inside a transaction that is ALWAYS rolled back; the two throwaway accounts
// are hard-deleted afterwards. Each refusal has a positive control beside it,
// and each sum is checked against the catalog itself (docs/03 vacuity rule).
//
//   s = made superadmin inside the transaction    m = an ordinary account
// ---------------------------------------------------------------------------

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const ownerDbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const sql = postgres(ownerDbUrl, { prepare: false, max: 1 })
const admin = () => createClient(url, serviceKey, { auth: { persistSession: false } })

const who = ['s', 'm'] as const
type Who = (typeof who)[number] | 'anon'
const ids: Record<(typeof who)[number], string> = { s: '', m: '' }

beforeAll(async () => {
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for this suite')
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  for (const k of who) {
    const { data, error } = await admin().auth.admin.createUser({
      email: `storage-${k}-${tag}@demo.local`, password: 'password123', email_confirm: true,
    })
    if (error) throw new Error(`createUser ${k}: ${error.message}`)
    ids[k] = data.user!.id
  }
})

afterAll(async () => {
  try {
    for (const id of Object.values(ids).filter(Boolean)) {
      const { error } = await admin().auth.admin.deleteUser(id)
      expect(error, 'could not hard-delete a probe account').toBeNull()
    }
  } finally {
    await sql.end()
  }
})

type Tx = postgres.TransactionSql
type Outcome = { error: string | null; data: postgres.Row[] }
type UsageRow = { kind: string; name: string; org_id: string | null; item_count: string | null; bytes: string }

async function rolledBack<T>(body: (tx: Tx) => Promise<T>): Promise<T> {
  let result!: T
  await sql
    .begin(async (tx) => {
      result = await body(tx)
      throw new Error('__rollback__')
    })
    .catch((e: unknown) => {
      if ((e as Error)?.message !== '__rollback__') throw e
    })
  return result
}

async function as(tx: Tx, user: Who, stmt: () => Promise<postgres.RowList<postgres.Row[]>>): Promise<Outcome> {
  await tx.unsafe('savepoint sp')
  let out: Outcome
  try {
    if (user === 'anon') {
      await tx.unsafe('set local role anon')
    } else {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: ids[user], role: 'authenticated' })}, true)`
      await tx.unsafe('set local role authenticated')
    }
    const r = await stmt()
    await tx.unsafe('release savepoint sp')
    out = { error: null, data: [...r] }
  } catch (e: unknown) {
    await tx.unsafe('rollback to savepoint sp')
    out = { error: String((e as Error).message), data: [] }
  }
  await tx.unsafe('reset role')
  await tx`select set_config('request.jwt.claims', '', true)`
  return out
}

const usage = (tx: Tx) => () => tx`select * from public.platform_storage_usage()`
const makeSuperadmin = (tx: Tx) => tx`update user_private set is_superadmin = true where user_id = ${ids.s}`

describe('platform_storage_usage — who may call it', () => {
  it('only the superadmin; a member and anon are refused', async () => {
    await rolledBack(async (tx) => {
      await makeSuperadmin(tx)
      const s = await as(tx, 's', usage(tx))
      expect(s.error).toBeNull()
      expect(s.data.length).toBeGreaterThan(10) // the positive control: real rows came back
      const m = await as(tx, 'm', usage(tx))
      expect(m.error).toMatch(/Not allowed/)
      const a = await as(tx, 'anon', usage(tx))
      expect(a.error).toMatch(/permission denied/)
    })
  })

  it('EXECUTE is granted to authenticated only (not anon, not service_role)', async () => {
    const [r] = await sql`
      select has_function_privilege('anon', 'public.platform_storage_usage()', 'execute') as anon,
             has_function_privilege('authenticated', 'public.platform_storage_usage()', 'execute') as auth,
             has_function_privilege('service_role', 'public.platform_storage_usage()', 'execute') as svc,
             p.prosecdef as secdef, p.proconfig as config
      from pg_proc p where p.oid = 'public.platform_storage_usage()'::regprocedure`
    expect(r).toMatchObject({ anon: false, auth: true, svc: false, secdef: true })
    expect(r!.config).toEqual(['search_path=""', 'lock_timeout=2s'])
  })
})

describe('platform_storage_usage — the numbers', () => {
  it('table bytes add up to every public table, each org share in proportion to its rows', async () => {
    await rolledBack(async (tx) => {
      await makeSuperadmin(tx)
      const out = await as(tx, 's', usage(tx))
      const rows = out.data as unknown as UsageRow[]
      const tables = rows.filter((r) => r.kind === 'table')
      const [cat] = await tx`
        select count(*)::int as n, sum(pg_total_relation_size(c.oid))::bigint as bytes
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'`
      // Every table appears, and no byte is lost or invented (each org row is
      // rounded, so allow one byte per row).
      expect(new Set(tables.map((t) => t.name)).size).toBe(cat!.n)
      const sum = tables.reduce((n, t) => n + Number(t.bytes), 0)
      expect(Math.abs(sum - Number(cat!.bytes))).toBeLessThanOrEqual(tables.length)

      // org_members has rows in several orgs: each org's bytes/rows is the same.
      const om = tables.filter((t) => t.name === 'org_members' && t.org_id)
      expect(om.length).toBeGreaterThan(1) // not vacuous: at least two orgs split it
      const per = om.map((t) => Number(t.bytes) / Number(t.item_count))
      for (const p of per) expect(Math.abs(p - per[0]!)).toBeLessThan(1)

      const db = rows.find((r) => r.kind === 'database')!
      expect(Number(db.bytes)).toBeGreaterThan(Number(cat!.bytes))
    })
  })

  it('files are summed by the org folder they sit in; others are unattributed', async () => {
    await rolledBack(async (tx) => {
      await makeSuperadmin(tx)
      const [org] = await tx`insert into orgs (name, slug) values ('Storage probe', ${'storage-probe-' + Date.now()}) returning id`
      await tx`insert into storage.objects (bucket_id, name, metadata) values
        ('vm-images', ${org!.id + '/c/one.png'}, '{"size": 1000}'),
        ('vm-images', ${org!.id + '/c/two.png'}, '{"size": 234}'),
        ('vm-images', 'not-an-org/x.png', '{"size": 99}')`
      const out = await as(tx, 's', usage(tx))
      const rows = out.data as unknown as UsageRow[]
      const mine = rows.find((r) => r.kind === 'bucket' && r.name === 'vm-images' && r.org_id === org!.id)
      expect(mine).toMatchObject({ item_count: '2', bytes: '1234' })
      const loose = rows.find((r) => r.kind === 'bucket' && r.name === 'vm-images' && r.org_id === null)
      expect(Number(loose?.bytes)).toBeGreaterThanOrEqual(99)
    })
  })
})

describe('module attribution covers the catalog', () => {
  it('every storage bucket is listed in BUCKET_MODULE', async () => {
    const buckets = await sql<{ id: string }[]>`select id from storage.buckets order by id`
    expect(buckets.length).toBeGreaterThan(0)
    for (const b of buckets) expect(Object.keys(BUCKET_MODULE), `bucket ${b.id}`).toContain(b.id)
  })

  it("every module's declared tables map to that module, and platform tables to none", () => {
    const decls: [string, DataBrowserDeclaration][] = Object.entries(dataBrowserDeclarations)
    let checked = 0
    for (const [key, decl] of decls) {
      for (const l of decl.lookups) {
        if (l.table === 'profiles') continue // a platform table some modules also look up
        expect(moduleForTable(l.table), `${key}: ${l.table}`).toBe(key)
        checked++
      }
    }
    for (const l of platformDataBrowser.lookups) expect(moduleForTable(l.table), l.table).toBeNull()
    expect(checked).toBeGreaterThan(20)
  })
})
