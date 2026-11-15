begin;
insert into public.module_roles (org_id, module_key, user_id, role)
select o.id, 'visual-messaging', u.id, 'admin' from public.orgs o, auth.users u
 where o.slug = 'demo-a' and u.email = 'charlie@demo.local';
-- controls computed as postgres BEFORE switching roles
select exists(select 1 from public.org_members m join auth.users u on u.id=m.user_id join public.orgs o on o.id=m.org_id
              where o.slug='demo-a' and u.email='bob@demo.local' and m.status='active') as control_bob_is_member_of_demo_a;
create temp table ids as select (select id from public.orgs where slug='demo-a') as org,
  (select id from auth.users where email='charlie@demo.local') as charlie,
  (select id from auth.users where email='bob@demo.local') as bob;
select set_config('request.jwt.claims', json_build_object('sub', charlie, 'role', 'authenticated')::text, true) from ids;
set local role authenticated;
select public.is_org_admin(org) as charlie_is_org_admin from ids;
insert into public.module_roles (org_id, module_key, user_id, role) select org, 'visual-messaging', bob, 'moderator' from ids;
reset role;
select count(*) as bob_vm_rows_in_demo_a from public.module_roles r, ids where r.user_id = ids.bob and r.org_id = ids.org;
rollback;
