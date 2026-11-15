\set ON_ERROR_STOP off
\pset format unaligned
begin;
-- helpers
create or replace function pg_temp.as_user(u uuid) returns void language sql as $$
  select set_config('role','authenticated',true),
         set_config('request.jwt.claims', json_build_object('sub',u,'role','authenticated')::text, true);
$$;
create or replace function pg_temp.as_pg() returns void language sql as $$
  select set_config('role','postgres',true), set_config('request.jwt.claims','',true);
$$;
\echo === 0 bypassrls
select rolname, rolbypassrls, rolsuper from pg_roles where rolname in ('postgres','authenticated','authenticator');

\echo === 1 ORACLE: bob(admin demo-b) issues existing account vs none
select pg_temp.as_user('fa2fb87a-5666-4e2a-9369-b0860e352207');
select 'has_account' k, public.pending_invite_issue_org('cd8a0f62-f183-4ccc-8bc6-89a456ca1ac6','charlie@demo.local','member');
select 'no_account' k, public.pending_invite_issue_org('cd8a0f62-f183-4ccc-8bc6-89a456ca1ac6','nobody-xyz@example.com','member');
select 'superadmin_addr' k, public.pending_invite_issue_org('cd8a0f62-f183-4ccc-8bc6-89a456ca1ac6','owner@demo.local','member');
select email, role, invited_by=auth.uid() mine from public.pending_invites order by email;
select 'list' k, email, waiting_on from public.pending_invites_list('cd8a0f62-f183-4ccc-8bc6-89a456ca1ac6') order by email;

\echo === 2 already_member includes PENDING seat; admin can read it anyway
select pg_temp.as_pg();
insert into public.org_members(org_id,user_id,role,status,invited_by,invited_at) values ('cd8a0f62-f183-4ccc-8bc6-89a456ca1ac6','9899506a-58f2-41b6-8793-edd1cb1da6fc','member','pending','fa2fb87a-5666-4e2a-9369-b0860e352207',now());
select pg_temp.as_user('fa2fb87a-5666-4e2a-9369-b0860e352207');
select 'pending_dana' k, public.pending_invite_issue_org('cd8a0f62-f183-4ccc-8bc6-89a456ca1ac6','dana@demo.local','member');
select 'profiles_shows_dana' k, count(*) from public.org_member_profiles('cd8a0f62-f183-4ccc-8bc6-89a456ca1ac6') where email='dana@demo.local';

\echo === 3 SILENT ADDRESS CAP: bob sees invited but no row
select pg_temp.as_pg();
insert into public.platform_settings(key,value) values ('pending_invites.caps','{"maxPerAddress":1}'::jsonb) on conflict (key) do update set value=excluded.value;
select pg_temp.as_user('0ab0d8f7-f17a-4205-8e63-60101baab7ee');
select 'alice_first' k, public.pending_invite_issue_org('70bc2fa6-2234-43b5-8220-4ac7a48c03fb','capped@example.com','member');
select pg_temp.as_user('fa2fb87a-5666-4e2a-9369-b0860e352207');
select 'bob_second' k, public.pending_invite_issue_org('cd8a0f62-f183-4ccc-8bc6-89a456ca1ac6','capped@example.com','member');
select 'bob_list_capped' k, count(*) from public.pending_invites_list('cd8a0f62-f183-4ccc-8bc6-89a456ca1ac6') where email='capped@example.com';
select 'bob_direct_capped' k, count(*) from public.pending_invites where email='capped@example.com';
select 'bob_control_nobody' k, count(*) from public.pending_invites where email='nobody-xyz@example.com';
select pg_temp.as_pg(); delete from public.platform_settings where key='pending_invites.caps';

\echo === 4 DEMOTED admin reads nothing
select pg_temp.as_pg();
insert into public.org_members(org_id,user_id,role,status) values ('cd8a0f62-f183-4ccc-8bc6-89a456ca1ac6','0ab0d8f7-f17a-4205-8e63-60101baab7ee','owner','active');
update public.org_members set role='member' where org_id='cd8a0f62-f183-4ccc-8bc6-89a456ca1ac6' and user_id='fa2fb87a-5666-4e2a-9369-b0860e352207';
select pg_temp.as_user('fa2fb87a-5666-4e2a-9369-b0860e352207');
select 'demoted_select' k, count(*) from public.pending_invites;
select 'demoted_list' k, count(*) from public.pending_invites_list('cd8a0f62-f183-4ccc-8bc6-89a456ca1ac6');
do $$ begin perform public.pending_invite_cancel((select id from public.pending_invites where email='charlie@demo.local' limit 1)); raise notice 'demoted_cancel: SUCCEEDED (bad)'; exception when others then raise notice 'demoted_cancel refused: %', sqlerrm; end $$;
select pg_temp.as_pg();
select 'control_rows_exist' k, count(*) from public.pending_invites;
update public.org_members set role='admin' where org_id='cd8a0f62-f183-4ccc-8bc6-89a456ca1ac6' and user_id='fa2fb87a-5666-4e2a-9369-b0860e352207';

\echo === 5 WRONG PERSON: dana cannot claim for charlie; charlie can
select pg_temp.as_user('9899506a-58f2-41b6-8793-edd1cb1da6fc');
select 'dana_claim' k, public.pending_invites_claim_mine();
select pg_temp.as_pg();
select 'row_still_there' k, count(*) from public.pending_invites where email='charlie@demo.local';
\echo --- 5b plus-address and case
select pg_temp.as_user('fa2fb87a-5666-4e2a-9369-b0860e352207');
select 'plus_issue' k, public.pending_invite_issue_org('cd8a0f62-f183-4ccc-8bc6-89a456ca1ac6','charlie+x@demo.local','member');
select pg_temp.as_pg();
update auth.users set email='Charlie@Demo.Local' where id='57e0314b-2110-4c4f-802c-a91308340bec';
select pg_temp.as_user('57e0314b-2110-4c4f-802c-a91308340bec');
select 'charlie_claim' k, public.pending_invites_claim_mine();
select 'uid_restored' k, auth.uid()='57e0314b-2110-4c4f-802c-a91308340bec';
select pg_temp.as_pg();
select 'seat' k, role, status, invited_by, accepted_at from public.org_members where org_id='cd8a0f62-f183-4ccc-8bc6-89a456ca1ac6' and user_id='57e0314b-2110-4c4f-802c-a91308340bec';
select 'rows_left' k, email from public.pending_invites where email like 'charlie%' order by 1,2;
update auth.users set email='charlie@demo.local' where id='57e0314b-2110-4c4f-802c-a91308340bec';

\echo === 6 UNCONFIRMED cannot claim
select pg_temp.as_user('fa2fb87a-5666-4e2a-9369-b0860e352207');
select 'issue_eve' k, public.pending_invite_issue_org('cd8a0f62-f183-4ccc-8bc6-89a456ca1ac6','eve@demo.local','member');
select pg_temp.as_pg();
update auth.users set email_confirmed_at=null where id='b6f46c25-3a38-4914-8a07-67a966f47460';
select pg_temp.as_user('b6f46c25-3a38-4914-8a07-67a966f47460');
select 'eve_unconfirmed_claim' k, public.pending_invites_claim_mine();
select pg_temp.as_pg();
select 'eve_row_remains' k, count(*) from public.pending_invites where email='eve@demo.local';
update auth.users set email_confirmed_at=now() where id='b6f46c25-3a38-4914-8a07-67a966f47460';

\echo === 7 INVITER LOST AUTHORITY: bob banned, then bob demoted
update auth.users set banned_until=now()+interval '1 day' where id='fa2fb87a-5666-4e2a-9369-b0860e352207';
select pg_temp.as_user('b6f46c25-3a38-4914-8a07-67a966f47460');
select 'eve_claim_banned_inviter' k, public.pending_invites_claim_mine();
select pg_temp.as_pg();
select 'eve_row_after' k, count(*) from public.pending_invites where email='eve@demo.local';
select 'eve_seat_after' k, count(*) from public.org_members where org_id='cd8a0f62-f183-4ccc-8bc6-89a456ca1ac6' and user_id='b6f46c25-3a38-4914-8a07-67a966f47460';
update auth.users set banned_until=null where id='fa2fb87a-5666-4e2a-9369-b0860e352207';
-- demoted variant with frank
select pg_temp.as_user('fa2fb87a-5666-4e2a-9369-b0860e352207');
select 'issue_frank' k, public.pending_invite_issue_org('cd8a0f62-f183-4ccc-8bc6-89a456ca1ac6','frank@demo.local','member');
select pg_temp.as_pg();
update public.org_members set role='member' where org_id='cd8a0f62-f183-4ccc-8bc6-89a456ca1ac6' and user_id='fa2fb87a-5666-4e2a-9369-b0860e352207';
select pg_temp.as_user('5c511a63-c3ee-46c7-8580-6fdac4434f32');
select 'frank_claim_demoted_inviter' k, public.pending_invites_claim_mine();
select pg_temp.as_pg();
select 'frank_seat' k, count(*) from public.org_members where org_id='cd8a0f62-f183-4ccc-8bc6-89a456ca1ac6' and user_id='5c511a63-c3ee-46c7-8580-6fdac4434f32';
select 'frank_row' k, count(*) from public.pending_invites where email='frank@demo.local';
update public.org_members set role='admin' where org_id='cd8a0f62-f183-4ccc-8bc6-89a456ca1ac6' and user_id='fa2fb87a-5666-4e2a-9369-b0860e352207';

\echo === 8 DUPLICATE EMAIL (sso twin) -> nobody claims
select pg_temp.as_user('fa2fb87a-5666-4e2a-9369-b0860e352207');
select 'issue_gabe' k, public.pending_invite_issue_org('cd8a0f62-f183-4ccc-8bc6-89a456ca1ac6','gabe@demo.local','member');
select pg_temp.as_pg();
insert into auth.users(id, instance_id, aud, role, email, email_confirmed_at, is_sso_user, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
 values (gen_random_uuid(),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','gabe@demo.local',now(),true,'{}','{}',now(),now());
select pg_temp.as_user('81272ccb-a70b-4a6f-a421-387aa67eab7a');
select 'gabe_claim_twin' k, public.pending_invites_claim_mine();
select pg_temp.as_pg();
select 'gabe_seat' k, count(*) from public.org_members where org_id='cd8a0f62-f183-4ccc-8bc6-89a456ca1ac6' and user_id='81272ccb-a70b-4a6f-a421-387aa67eab7a';

\echo === 9 ACL + other email oracles reachable by authenticated
select proname, has_function_privilege('authenticated', p.oid, 'execute') auth_x, has_function_privilege('anon', p.oid,'execute') anon_x
from pg_proc p where pronamespace='public'::regnamespace and proname in ('pending_invites_claim_mine','pending_invite_apply','pending_invite_issue_org','org_find_user_by_email','pending_invites_prune_expired');
select 'tbl' k, has_table_privilege('anon','public.pending_invites','select') anon_sel, has_table_privilege('service_role','public.pending_invites','select') svc_sel, has_table_privilege('authenticated','public.pending_invites','insert') auth_ins;
\echo --- functions authenticated may call that read auth.users by email without is_superadmin
select proname from pg_proc p where pronamespace='public'::regnamespace
  and has_function_privilege('authenticated', p.oid, 'execute')
  and prosrc ~* 'auth\.users' and prosrc ~* 'email' and prosrc !~ 'is_superadmin'
order by 1;
rollback;
