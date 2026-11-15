// Prod verification for 20261117010000_storage_upload_org_pin.sql (upload
// paths in cls-submissions and vm-images must name the uploader's real org).
//
//   node node_modules/tsx/dist/cli.mjs scripts/prod-verify-storage-upload-pin.mts
//   node node_modules/tsx/dist/cli.mjs scripts/prod-verify-storage-upload-pin.mts --local
//
// Run it BEFORE and AFTER `migrate:prod`: before, the function/policy checks
// and the misfiled-upload refusal fail while the CONTROLS pass; after,
// everything passes.
//
// [1] STRUCTURE: both helpers exist, bodies md5-match the migration, definer,
//     search_path pinned, EXECUTE for authenticated + service_role only.
// [2] POLICIES: both INSERT policies call the helper; the DELETE and READ
//     policies are untouched; no UPDATE policy exists on either bucket.
// [3] DATA: no object already sits under a folder [1] that is not its parent
//     row's org (a misfiled file from before the fix).
// [4] BEHAVIOUR as a real member, inside ONE transaction that is ALWAYS ROLLED
//     BACK: the correct path uploads (control), another org's id is refused.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL = process.argv.includes('--local')

let ref = '(local)'
let sql: ReturnType<typeof postgres>
if (LOCAL) {
  sql = postgres(process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres', { max: 1 })
} else {
  const env = readFileSync(resolve(root, '.env.deploy'), 'utf8')
  const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''
  ref = get('SUPABASE_PROJECT_REF')
  const pw = get('SUPABASE_DB_PASSWORD')
  if (!ref || !pw) throw new Error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD in .env.deploy')
  sql = postgres(
    `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`,
    { ssl: 'require', max: 1 },
  )
}

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${detail})`}`)
}

const text = readFileSync(resolve(root, 'supabase/migrations/20261117010000_storage_upload_org_pin.sql'), 'utf8')
const md5Of = (fn: string) => {
  const body = new RegExp(`create function public\\.${fn}\\([\\s\\S]*?\\nas \\$\\$([\\s\\S]*?)\\$\\$;`).exec(text)?.[1]
  return body ? createHash('md5').update(body).digest('hex') : ''
}
const FNS = ['cls_submission_upload_ok', 'vm_image_upload_ok']

try {
  console.log(`[1] structure — ${LOCAL ? 'LOCAL' : `PROD (${ref})`}`)
  const [{ n: allFns }] = await sql<{ n: number }[]>`select count(*)::int as n from pg_proc where pronamespace = 'public'::regnamespace`
  check('CONTROL: the catalog read works (public has functions)', allFns > 50, `${allFns}`)
  check('CONTROL: the migration file parsed', FNS.every((f) => md5Of(f).length === 32))
  for (const fn of FNS) {
    const [f] = await sql<{ secdef: boolean; config: string[] | null; acl: string | null; md5: string }[]>`
      select p.prosecdef as secdef, p.proconfig as config, p.proacl::text as acl, md5(p.prosrc) as md5
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = ${fn}`
    check(`${fn} exists`, !!f)
    check('  body md5 matches the migration', f?.md5 === md5Of(fn), `db=${f?.md5 ?? '-'}`)
    check('  SECURITY DEFINER, search_path pinned', f?.secdef === true && JSON.stringify(f?.config) === JSON.stringify(['search_path=public']), JSON.stringify(f?.config))
    const acl = f?.acl ?? ''
    check('  authenticated + service_role may EXECUTE', /authenticated=X\//.test(acl) && /service_role=X\//.test(acl), acl)
    check('  anon and PUBLIC may not', !/(^|[{,])anon=/.test(acl) && !/(^|[{,])=X\//.test(acl), acl)
  }

  console.log('[2] storage policies')
  const pols = await sql<{ policyname: string; cmd: string; permissive: string; qual: string | null; with_check: string | null }[]>`
    select policyname, cmd, permissive, qual, with_check from pg_policies where schemaname = 'storage' and tablename = 'objects'`
  check('CONTROL: storage.objects has policies', pols.length > 5, `${pols.length}`)
  const p = (n: string) => pols.find((r) => r.policyname === n)
  check('cls_submissions_storage_write calls cls_submission_upload_ok', /cls_submission_upload_ok/.test(p('cls_submissions_storage_write')?.with_check ?? ''))
  check('vm_images_write calls vm_image_upload_ok', /vm_image_upload_ok/.test(p('vm_images_write')?.with_check ?? ''))
  check('  delete policies unchanged (still by parent row)', /cls_submission_open/.test(p('cls_submissions_storage_delete')?.qual ?? '') && /vm_can_moderate/.test(p('vm_images_delete')?.qual ?? ''))
  check('  read policies still present', !!p('cls_submissions_storage_read') && !!p('vm_images_read'))
  const updates = pols.filter((r) => r.cmd === 'UPDATE' && /cls-submissions|vm-images/.test(`${r.qual} ${r.with_check}`))
  check('  no UPDATE policy on either bucket (files cannot be moved)', updates.length === 0, updates.map((r) => r.policyname).join(','))

  // Review LOW (2026-11-15): a policy made in the dashboard would not be in the
  // migrations. Every permissive INSERT policy must name its bucket.
  const loose = pols.filter((r) => r.cmd === 'INSERT' && r.permissive === 'PERMISSIVE' && !/bucket_id/.test(r.with_check ?? ''))
  check('  every INSERT policy on storage.objects names a bucket', loose.length === 0, loose.map((r) => r.policyname).join(','))

  console.log('[3] no misfiled object already exists')
  const [{ n: oddSpelling }] = await sql<{ n: number }[]>`
    select count(*)::int as n from storage.objects o, unnest((storage.foldername(o.name))[1:case o.bucket_id when 'cls-submissions' then 3 else 2 end]) f
    where o.bucket_id in ('cls-submissions', 'vm-images')
      and f !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`
  check('no id folder written in a non-canonical form', oddSpelling === 0, `${oddSpelling}`)

  // MISFILED = the parent row exists but in another org (or class). An ORPHAN
  // (parent row deleted, file left behind) is a separate, known issue — found
  // 2026-11-15: one vm-images file of a deleted demo conversation — reported, not failed.
  const [counts] = await sql<{ cls_all: number; cls_bad: number; cls_orphan: number; vm_all: number; vm_bad: number; vm_orphan: number }[]>`
    with cls as (
      select o.name, s.org_id::text as org, s.class_id::text as class,
             (storage.foldername(o.name))[1] as f1, (storage.foldername(o.name))[2] as f2
      from storage.objects o
      left join public.cls_submissions s on s.id::text = (storage.foldername(o.name))[3]
      where o.bucket_id = 'cls-submissions'),
    vm as (
      select o.name, c.org_id::text as org, (storage.foldername(o.name))[1] as f1
      from storage.objects o
      left join public.vm_conversations c on c.id::text = (storage.foldername(o.name))[2]
      where o.bucket_id = 'vm-images')
    select
      (select count(*)::int from cls) as cls_all,
      (select count(*)::int from cls where org is not null and (org <> f1 or class <> f2)) as cls_bad,
      (select count(*)::int from cls where org is null) as cls_orphan,
      (select count(*)::int from vm) as vm_all,
      (select count(*)::int from vm where org is not null and org <> f1) as vm_bad,
      (select count(*)::int from vm where org is null) as vm_orphan`
  check(`cls-submissions: 0 of ${counts.cls_all} objects misfiled`, counts.cls_bad === 0, `${counts.cls_bad}`)
  check(`vm-images: 0 of ${counts.vm_all} objects misfiled`, counts.vm_bad === 0, `${counts.vm_bad}`)
  console.log(`  info  orphans (parent row deleted, file left): cls-submissions ${counts.cls_orphan}, vm-images ${counts.vm_orphan}`)

  console.log('[4] behaviour as a real member (rolled back)')
  await sql
    .begin(async (tx) => {
      const claims = (id: string) => tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: id, role: 'authenticated' })}, true)`
      const seats = await tx<{ user_id: string; org_id: string; conv: string }[]>`
        select m.user_id, c.org_id, c.id as conv from public.vm_conversation_members m
        join public.vm_conversations c on c.id = m.conversation_id where m.status = 'active'`
      let seat: (typeof seats)[number] | undefined
      for (const s of seats) {
        await claims(s.user_id)
        const [r] = await tx<{ ok: boolean }[]>`select public.vm_can_post(${s.conv}) as ok`
        if (r.ok) { seat = s; break }
      }
      const [other] = seat ? await tx<{ id: string }[]>`select id from public.orgs where id <> ${seat.org_id} limit 1` : []
      check('CONTROL: a member who may post and a second org exist', !!seat && !!other)
      if (seat && other) {
        const upload = async (name: string) => {
          await tx.unsafe('savepoint u')
          try {
            await claims(seat.user_id)
            await tx.unsafe('set local role authenticated')
            await tx`insert into storage.objects (bucket_id, name, owner) values ('vm-images', ${name}, ${seat.user_id})`
            await tx.unsafe('release savepoint u')
            return ''
          } catch (e) {
            await tx.unsafe('rollback to savepoint u')
            return (e as { code?: string }).code ?? 'error'
          } finally {
            await tx.unsafe('reset role')
          }
        }
        check('  CONTROL: the correct path uploads', (await upload(`${seat.org_id}/${seat.conv}/verify-ok.png`)) === '')
        check('  another org id in folder [1] is refused (42501)', (await upload(`${other.id}/${seat.conv}/verify-bad.png`)) === '42501')
        check('  the own org in upper case is refused (42501)', (await upload(`${seat.org_id.toUpperCase()}/${seat.conv}/verify-case.png`)) === '42501')
      }
      throw new Error('__rollback__')
    })
    .catch((e: unknown) => {
      if ((e as Error)?.message !== '__rollback__') throw e
    })
} finally {
  await sql.end()
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
