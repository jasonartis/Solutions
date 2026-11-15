begin;
select count(*) as rollup_before from public.activity_rollup;
select set_config('request.jwt.claims', json_build_object('sub', u.id, 'role', 'authenticated')::text, true)
  from auth.users u where u.email = 'charlie@demo.local';
set local role authenticated;
insert into public.activity_events (org_id, module_key, action)
select o.id, 'classroom', 'a.' || translate(md5(g::text), '0123456789', 'abcdefghij')
  from public.orgs o, generate_series(1, 500) g
 where o.slug = 'demo-a';
reset role;
select count(*) as rollup_after from public.activity_rollup;
select pg_size_pretty(pg_total_relation_size('public.activity_rollup')) as rollup_size;
rollback;
