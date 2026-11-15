\pset format aligned
-- [1] every column whose name contains 'email' in any non-system schema, with api-role column privileges
select c.table_schema, c.table_name, c.column_name,
  has_column_privilege('anon', format('%I.%I', c.table_schema, c.table_name), c.column_name, 'select') as anon_sel,
  has_column_privilege('authenticated', format('%I.%I', c.table_schema, c.table_name), c.column_name, 'select') as auth_sel,
  has_column_privilege('service_role', format('%I.%I', c.table_schema, c.table_name), c.column_name, 'select') as svc_sel
from information_schema.columns c
where c.column_name ilike '%email%' and c.table_schema not in ('pg_catalog','information_schema')
order by 1,2,3;
-- [2] table-level privileges on auth.users
select r as role, has_table_privilege(r, 'auth.users', 'select') as sel from unnest(array['anon','authenticated','service_role','postgres']) r;
-- [3] non-system views
select schemaname, viewname from pg_views where schemaname not in ('pg_catalog','information_schema') order by 1,2;
select count(*) as all_views from pg_views;
-- [4] publication tables
select * from pg_publication_tables; select pubname from pg_publication;
-- [5] functions in public whose body mentions auth.users or email, with ACL
select p.proname, p.prosecdef as secdef,
  (select string_agg(a.grantee::regrole::text || '=' || a.privilege_type, ',') from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee::regrole::text in ('anon','authenticated','service_role','-')) as api_acl,
  p.proconfig,
  (p.prosrc ~* 'auth\.users') as refs_auth_users, (p.prosrc ~* 'email') as refs_email
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and (p.prosrc ~* 'auth\.users' or p.prosrc ~* 'email')
order by 1;
select count(*) as all_public_fns from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public';
-- [5b] policies + grants on pending_invites
select polname, polcmd, pg_get_expr(polqual, polrelid) as using_expr, pg_get_expr(polwithcheck, polrelid) as check_expr, polroles::regrole[] from pg_policy where polrelid = 'public.pending_invites'::regclass;
select grantee, privilege_type from information_schema.role_table_grants where table_name='pending_invites' and table_schema='public';
-- [6] seed users and memberships
select u.id, u.email, pr.display_name from auth.users u join public.profiles pr on pr.user_id=u.id order by u.email;
select o.slug, u.email, m.role, m.status from public.orgs o join public.org_members m on m.org_id=o.id join auth.users u on u.id=m.user_id order by o.slug, m.role, u.email;
select pg_get_functiondef('public.is_org_member(uuid)'::regprocedure);
