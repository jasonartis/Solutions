begin;
-- ===== rank-map MEDIUM: vm admin (not org admin) grants a vm role to a NON-member
insert into public.module_roles (org_id, module_key, user_id, role)
select o.id, 'visual-messaging', u.id, 'admin' from public.orgs o, auth.users u
 where o.slug = 'demo-a' and u.email = 'charlie@demo.local';
select set_config('p.org', (select id::text from public.orgs where slug='demo-a'), true),
       set_config('p.charlie', (select id::text from auth.users where email='charlie@demo.local'), true),
       set_config('p.bob', (select id::text from auth.users where email='bob@demo.local'), true);
select exists(select 1 from public.org_members where org_id=current_setting('p.org')::uuid and user_id=current_setting('p.bob')::uuid and status='active') as control_bob_member_of_demo_a;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('p.charlie'), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.is_org_admin(current_setting('p.org')::uuid) as charlie_is_org_admin;
insert into public.module_roles (org_id, module_key, user_id, role)
values (current_setting('p.org')::uuid, 'visual-messaging', current_setting('p.bob')::uuid, 'moderator');
reset role;
select count(*) as bob_vm_rows_in_demo_a from public.module_roles where user_id=current_setting('p.bob')::uuid and org_id=current_setting('p.org')::uuid;
rollback;

begin;
-- ===== real view-as Q3: can the SUPERADMIN read the six cls tables that have self arms and no is_superadmin() in policy text?
select set_config('p.sa', (select user_id::text from public.user_private where is_superadmin limit 1), true);
select (select email from auth.users where id=current_setting('p.sa')::uuid) as local_superadmin;
select 'postgres' as who, (select count(*) from public.cls_submissions) s, (select count(*) from public.cls_grades) g, (select count(*) from public.cls_review_comments) rc, (select count(*) from public.cls_review_assignments) ra, (select count(*) from public.cls_survey_answers) sa, (select count(*) from public.cls_exam_papers) ep;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('p.sa'), 'role', 'authenticated')::text, true);
set local role authenticated;
select 'superadmin' as who, (select count(*) from public.cls_submissions) s, (select count(*) from public.cls_grades) g, (select count(*) from public.cls_review_comments) rc, (select count(*) from public.cls_review_assignments) ra, (select count(*) from public.cls_survey_answers) sa, (select count(*) from public.cls_exam_papers) ep;
reset role;
rollback;
