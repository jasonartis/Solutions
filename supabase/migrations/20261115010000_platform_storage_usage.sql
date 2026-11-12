-- PLATFORM STORAGE USAGE — real bytes per organization and per module, for the
-- Owner Console (founder, 2026-11-10: "row counts are enough to start; real
-- bytes per org are wanted"; journal "DASHBOARD PLATFORM TILE + ROW COUNTS").
--
-- ONE FUNCTION, superadmin only, read-only:
--   platform_storage_usage()
--     returns one row per (kind, name, org_id):
--       kind 'database' — the whole database, pg_database_size (what the
--                         hosting plan's "database size" limit counts);
--       kind 'table'    — a table in the public schema, split by org_id;
--       kind 'bucket'   — a storage bucket, split by the org that owns each file.
--     item_count = rows (table) or files (bucket); bytes = see below.
--
-- WHY AN ESTIMATE, AND WHICH ONE (Postgres does not record size per org):
--   * TABLE bytes are pg_total_relation_size (table + its indexes + TOAST),
--     split between orgs by their SHARE OF THE ROWS: an org holding 30% of a
--     table's rows is given 30% of its bytes ("rows × average row size").
--     Chosen over weighting each row by its own size (sum of pg_column_size)
--     because that reads and un-compresses every value of every row on every
--     page load, while a row count can use the org_id index; and because
--     indexes, page headers and free space belong to no one row anyway, so a
--     per-row weighting would still be an estimate. Where it is wrong: an org
--     whose rows are much longer than other orgs' (long messages) is
--     under-stated by the difference. Rows with no org_id, tables with no
--     org_id column, and the space of an empty table come back with org_id
--     null ("not attributable to an organization").
--   * BUCKET bytes are exact: the file size Supabase Storage records per
--     object (metadata.size), summed. A file belongs to an org when the first
--     folder of its path is that org's id — the convention every bucket's
--     policies already rely on (storage.foldername(name))[1]. Anything else
--     comes back with org_id null.
--   * The 'database' row is larger than the sum of the 'table' rows: it also
--     holds the auth, storage, cron and system schemas. The page shows the
--     difference as "platform and system".
--
-- SECURITY (docs/03 #13, #27):
--   * SECURITY DEFINER because it must see every org's rows and storage
--     objects; it re-checks is_superadmin() itself and raises for anyone else.
--   * It returns only COUNTS and SIZES — never a row, a file name or a path.
--   * Table names come from pg_catalog and are quoted with format('%I').
--   * EXECUTE: authenticated only (revoke before grant; the worker has no use
--     for it, anon never).
--   * search_path is empty; everything is schema-qualified.
--
-- PROD DEPENDENCY: the owner (postgres) must bypass RLS. storage.objects has
-- RLS on; without BYPASSRLS its policies would FILTER rather than raise, and
-- files would read as 0 bytes with no error. scripts/prod-verify-storage-usage.mts
-- asserts it, and compares the file count with a direct count.
--
-- COST: one count(*) ... group by org_id per public table (about 90 today) and
-- one pass over storage.objects. Milliseconds at today's size; the console
-- calls it only on the Overview page and the dashboard. Revisit (pg_class
-- reltuples, or a nightly snapshot table) if a table reaches millions of rows.

create or replace function public.platform_storage_usage()
returns table (kind text, name text, org_id uuid, item_count bigint, bytes bigint)
language plpgsql
stable
security definer
set search_path = ''
-- A migration holding a lock on one table must not hang the console page
-- until the API's statement timeout: give up after 2 s with a visible error.
set lock_timeout = '2s'
as $$
declare
  t record;
  v_total bigint;
  v_rows bigint;
  v_emitted bigint;
begin
  if auth.uid() is null or not public.is_superadmin() then
    raise exception 'Not allowed';
  end if;

  return query
    select 'database'::text, pg_catalog.current_database()::text, null::uuid, null::bigint,
           pg_catalog.pg_database_size(pg_catalog.current_database());

  for t in
    select c.oid, c.relname::text as relname,
           exists (
             select 1 from pg_catalog.pg_attribute a
             where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
               and a.atttypid = 'uuid'::pg_catalog.regtype
           ) as has_org
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    -- Ordinary tables only. A partitioned parent ('p') stores nothing itself
    -- (size 0); its partitions are ordinary tables and are counted here, so
    -- no byte disappears into "system" (correctness review, 2026-11-12).
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname
  loop
    v_total := pg_catalog.pg_total_relation_size(t.oid);
    if t.has_org then
      -- One statement, one snapshot: each org's rows and the table's total
      -- rows are counted together, so the shares always add up to 100%.
      return query execute pg_catalog.format(
        'select %L::text, %L::text, x.org_id, x.n, '
        || '(%s::numeric * x.n / sum(x.n) over ())::bigint '
        || 'from (select r.org_id, count(*)::bigint as n from public.%I r group by r.org_id) x',
        'table', t.relname, v_total, t.relname);
      get diagnostics v_emitted = row_count;
      if v_emitted = 0 then
        -- An empty table still occupies pages; nobody owns them.
        return query select 'table'::text, t.relname, null::uuid, 0::bigint, v_total;
      end if;
    else
      execute pg_catalog.format('select count(*)::bigint from public.%I', t.relname) into v_rows;
      return query select 'table'::text, t.relname, null::uuid, v_rows, v_total;
    end if;
  end loop;

  return query
    select 'bucket'::text, o.bucket_id::text, g.id, count(*)::bigint,
           coalesce(sum(case when (o.metadata ->> 'size') ~ '^[0-9]+$'
                             then (o.metadata ->> 'size')::bigint else 0 end), 0)::bigint
    from storage.objects o
    left join public.orgs g on g.id::text = pg_catalog.split_part(o.name, '/', 1)
    group by o.bucket_id, g.id;
end;
$$;

revoke all on function public.platform_storage_usage() from public, anon, authenticated, service_role;
grant execute on function public.platform_storage_usage() to authenticated;
