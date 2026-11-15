\set ON_ERROR_STOP off
select id as owner from auth.users where email='owner@demo.local' \gset
select user_id as sa from public.user_private where is_superadmin limit 1 \gset
\echo === [6b] FIRE as supabase_auth_admin: capture happens, sign-in succeeds
begin;
select count(*) before_events from public.login_events where user_id = :'owner';
set local role supabase_auth_admin;
update auth.users set last_sign_in_at = now() where id = :'owner';
reset role;
select count(*) after_events from public.login_events where user_id = :'owner';
select observed_logins, first_observed_login_at is not null has_first from public.login_rollup where user_id = :'owner';
rollback;
\echo === [6c] same timestamp rewritten: no phantom row
begin;
set local role supabase_auth_admin;
update auth.users set last_sign_in_at = last_sign_in_at where id = :'owner';
reset role;
select count(*) events_after_noop from public.login_events where user_id = :'owner';
rollback;
\echo === [10a] authenticated INSERT
begin; set local role authenticated; insert into public.login_events (user_id) values (:'owner'); rollback;
\echo === [10b] authenticated UPDATE rollup
begin; set local role authenticated; update public.login_rollup set observed_logins = 99; rollback;
\echo === [10c] authenticated DELETE
begin; set local role authenticated; delete from public.login_events; rollback;
\echo === [10d] non-superadmin SELECT (owner@demo.local) — expect 0 rows while table has rows
begin; select count(*) real_rows from public.login_events;
set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub',:'owner','role','authenticated')::text, true);
select count(*) visible_to_owner from public.login_events; select count(*) rollup_visible_to_owner from public.login_rollup; rollback;
\echo === [10e] anon SELECT
begin; set local role anon; select count(*) from public.login_events; rollback;
\echo === [10f] service_role SELECT / prune (local: service_role has no grant; prod bypasses RLS but grant check same)
begin; set local role service_role; select count(*) from public.login_events; rollback;
begin; set local role service_role; select public.login_events_prune(); rollback;
begin; set local role authenticated; select public.login_events_prune(); rollback;
\echo === [11b] superadmin SELECT control
begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub',:'sa','role','authenticated')::text, true);
select count(*) visible_to_superadmin from public.login_events; select count(*) rollup_visible_to_superadmin from public.login_rollup; rollback;
\echo === [14] lock contention: another session holds login_rollup row lock — does sign-in survive within 50ms?
begin;
set local role supabase_auth_admin;
set local lock_timeout = '0';
select 'see [14b] run separately' note;
rollback;
\echo === [15] statement_timeout on this cluster
show statement_timeout;
select rolname, rolconfig from pg_roles where rolname in ('supabase_auth_admin','authenticator','postgres');
\echo === [16] later migrations touching the trigger: is capture_login still the bound function body? (md5 of def)
select md5(pg_get_functiondef('public.capture_login()'::regprocedure));
select tgname, pg_get_triggerdef(oid) from pg_trigger where tgname='on_auth_user_login';
