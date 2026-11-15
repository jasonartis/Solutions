\set ON_ERROR_STOP off
\echo === [1] trigger + function catalog
select t.tgname, t.tgenabled, p.proname, pg_get_userbyid(p.proowner) owner, p.prosecdef, p.proconfig, p.proacl
from pg_trigger t join pg_proc p on p.oid = t.tgfoid
where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal;
\echo === [2] pruner catalog
select proname, pg_get_userbyid(proowner) owner, prosecdef, proconfig, proacl from pg_proc where proname = 'login_events_prune';
\echo === [3] table grants (control: profiles)
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) privs
from information_schema.role_table_grants
where table_schema='public' and table_name in ('login_events','login_rollup','profiles')
group by 1,2 order by 1,2;
\echo === [4] policies (control: total count)
select relname, polname, polcmd, pg_get_expr(polqual, polrelid) using_expr, polroles::regrole[] from pg_policy join pg_class on pg_class.oid=polrelid where relname in ('login_events','login_rollup');
select count(*) total_policies from pg_policy;
select relname, relrowsecurity, relforcerowsecurity from pg_class where relname in ('login_events','login_rollup');
\echo === [5] cron jobs mentioning prune
select jobname, schedule, command from cron.job where command ilike '%login_events%';
\echo === [6] FIRE as supabase_auth_admin (rolled back): does sign-in UPDATE succeed and capture?
begin;
set local role supabase_auth_admin;
select current_user;
select count(*) before_events from public.login_events;
update auth.users set last_sign_in_at = now() where email = 'owner@demo.local';
reset role;
select count(*) after_events from public.login_events;
select observed_logins, first_observed_login_at is not null has_first from public.login_rollup r join auth.users u on u.id=r.user_id where u.email='owner@demo.local';
rollback;
\echo === [7] FIRE with login_events made unwritable (table renamed away) — sign-in must still succeed
begin;
alter table public.login_events rename to login_events_gone;
set local role supabase_auth_admin;
update auth.users set last_sign_in_at = now() where email = 'owner@demo.local';
select 'signin update survived' as result;
reset role;
rollback;
\echo === [8] FIRE with a CHECK violation forced on the rollup (make existing row incoherent via owner) — must not block
begin;
alter table public.login_rollup drop constraint login_rollup_coherent;
update public.login_rollup set observed_logins = -5 where user_id = :'OWNER'::uuid;
alter table public.login_rollup add constraint login_rollup_coherent check (observed_logins >= 0) not valid;
set local role supabase_auth_admin;
update auth.users set last_sign_in_at = now() where email = 'owner@demo.local';
select 'signin update survived check-violation' as result;
reset role;
rollback;
\echo === [9] signup path: brand-new user with NO profiles row, then first sign-in update
begin;
set local role supabase_auth_admin;
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('11111111-1111-1111-1111-111111111111','00000000-0000-0000-0000-000000000000','authenticated','authenticated','probe-newuser@demo.local','x',now(),'{}','{}',now(),now());
update auth.users set last_sign_in_at = now() where id='11111111-1111-1111-1111-111111111111';
reset role;
select count(*) events_for_new from public.login_events where user_id='11111111-1111-1111-1111-111111111111';
select count(*) profiles_for_new from public.profiles where user_id='11111111-1111-1111-1111-111111111111';
rollback;
\echo === [10] api roles: authenticated insert/update/delete, anon select, service_role select
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub',:'OWNER'::uuid,'role','authenticated')::text, true);
insert into public.login_events (user_id) values (:'OWNER'::uuid);
update public.login_rollup set observed_logins = 99;
delete from public.login_events;
select count(*) visible_to_nonsuperadmin from public.login_events;
reset role;
set local role anon;
select count(*) from public.login_events;
reset role;
set local role service_role;
select count(*) from public.login_events;
select public.login_events_prune();
reset role;
rollback;
\echo === [11] superadmin read (control that the policy admits someone)
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub',(select user_id from public.user_private where is_superadmin limit 1),'role','authenticated')::text, true);
select count(*) visible_to_superadmin from public.login_events;
select count(*) rollup_visible_to_superadmin from public.login_rollup;
reset role;
rollback;
\echo === [12] user delete cascade as supabase_auth_admin
begin;
set local role supabase_auth_admin;
delete from auth.users where email='owner@demo.local';
select 'delete survived' r;
reset role;
rollback;
\echo === [13] trigger EXECUTE check: supabase_auth_admin cannot call the function directly
begin;
set local role supabase_auth_admin;
select has_function_privilege('supabase_auth_admin','public.capture_login()','execute');
reset role;
rollback;
