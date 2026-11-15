\set ON_ERROR_STOP off
begin;
select module_position_rank('classroom','professor') prof, module_position_rank('classroom','ga') ga, module_position_rank('classroom','student') student,
 module_position_rank('nail-salon','admin') sal_admin, module_position_rank('nail-salon','manager') sal_mgr, module_position_rank('nail-salon','cashier') cashier, module_position_rank('nail-salon','worker') worker;
create temp table ids as select email, id from auth.users where email in ('alice@demo.local','gabe@demo.local','charlie@demo.local','dana@demo.local','frank@demo.local','grace@demo.local','eve@demo.local');
grant select on ids to authenticated, anon;
create or replace function pg_temp.act(e text) returns void language plpgsql as $$
declare u uuid; begin select id into u from ids where email=e;
 perform set_config('request.jwt.claims', json_build_object('sub',u,'role','authenticated')::text, true);
 perform set_config('role','authenticated', true); end $$;
\echo --- P1 alice(prof,global) to charlie(student, scoped): EXPECT OK, actor/expires overwritten
savepoint p1; select pg_temp.act('alice@demo.local');
insert into view_as_sessions(org_id,module_key,actor_user_id,target_user_id,target_role,target_scope_ref,expires_at)
 values('70bc2fa6-2234-43b5-8220-4ac7a48c03fb','classroom',(select id from ids where email='gabe@demo.local'),(select id from ids where email='charlie@demo.local'),'student','69fab5c4-2e5f-4e20-9dfa-dcc9e977adb5', now()+interval '10 years')
 returning actor_user_id=(select id from ids where email='alice@demo.local') actor_is_alice, expires_at-now() < interval '31 minutes' expiry_stamped;
rollback to p1;
\echo --- P2 gabe(ga) to charlie(student): EXPECT REFUSED (no ga-student edge)
savepoint p2; select pg_temp.act('gabe@demo.local');
insert into view_as_sessions(org_id,module_key,target_user_id,target_role,target_scope_ref) values('70bc2fa6-2234-43b5-8220-4ac7a48c03fb','classroom',(select id from ids where email='charlie@demo.local'),'student','69fab5c4-2e5f-4e20-9dfa-dcc9e977adb5');
rollback to p2;
\echo --- P3 charlie(student) to dana(student peer): EXPECT REFUSED
savepoint p3; select pg_temp.act('charlie@demo.local');
insert into view_as_sessions(org_id,module_key,target_user_id,target_role,target_scope_ref) values('70bc2fa6-2234-43b5-8220-4ac7a48c03fb','classroom',(select id from ids where email='dana@demo.local'),'student','69fab5c4-2e5f-4e20-9dfa-dcc9e977adb5');
rollback to p3;
\echo --- P4 frank(not a demo-a member) to charlie: EXPECT REFUSED
savepoint p4; select pg_temp.act('frank@demo.local');
insert into view_as_sessions(org_id,module_key,target_user_id,target_role,target_scope_ref) values('70bc2fa6-2234-43b5-8220-4ac7a48c03fb','classroom',(select id from ids where email='charlie@demo.local'),'student','69fab5c4-2e5f-4e20-9dfa-dcc9e977adb5');
rollback to p4;
\echo --- P5 alice to charlie claiming target_scope_ref NULL (grant is scoped): EXPECT REFUSED
savepoint p5; select pg_temp.act('alice@demo.local');
insert into view_as_sessions(org_id,module_key,target_user_id,target_role,target_scope_ref) values('70bc2fa6-2234-43b5-8220-4ac7a48c03fb','classroom',(select id from ids where email='charlie@demo.local'),'student',null);
rollback to p5;
\echo --- P6 alice to charlie with module_key nail-salon (cross-module): EXPECT REFUSED
savepoint p6; select pg_temp.act('alice@demo.local');
insert into view_as_sessions(org_id,module_key,target_user_id,target_role,target_scope_ref) values('70bc2fa6-2234-43b5-8220-4ac7a48c03fb','nail-salon',(select id from ids where email='charlie@demo.local'),'student','69fab5c4-2e5f-4e20-9dfa-dcc9e977adb5');
rollback to p6;
\echo --- P7 grace(salon manager SCOPED) to dana(worker GLOBAL): EXPECT REFUSED
savepoint p7; select pg_temp.act('grace@demo.local');
insert into view_as_sessions(org_id,module_key,target_user_id,target_role,target_scope_ref) values('21d95348-d32b-44fd-8821-e79d188ed1d5','nail-salon',(select id from ids where email='dana@demo.local'),'worker',null);
rollback to p7;
\echo --- P8 alice(salon manager global) to dana(worker): EXPECT OK
savepoint p8; select pg_temp.act('alice@demo.local');
insert into view_as_sessions(org_id,module_key,target_user_id,target_role,target_scope_ref) values('21d95348-d32b-44fd-8821-e79d188ed1d5','nail-salon',(select id from ids where email='dana@demo.local'),'worker',null) returning 'ok';
rollback to p8;
\echo --- P9 eve(cashier) to dana(worker): EXPECT REFUSED
savepoint p9; select pg_temp.act('eve@demo.local');
insert into view_as_sessions(org_id,module_key,target_user_id,target_role,target_scope_ref) values('21d95348-d32b-44fd-8821-e79d188ed1d5','nail-salon',(select id from ids where email='dana@demo.local'),'worker',null);
rollback to p9;
\echo --- P10 alice to self: EXPECT REFUSED
savepoint p10; select pg_temp.act('alice@demo.local');
insert into view_as_sessions(org_id,module_key,target_user_id,target_role,target_scope_ref) values('70bc2fa6-2234-43b5-8220-4ac7a48c03fb','classroom',(select id from ids where email='alice@demo.local'),'professor',null);
rollback to p10;
\echo --- P11 alice UPDATE/DELETE own row: EXPECT 42501 twice
savepoint p11; select pg_temp.act('alice@demo.local');
insert into view_as_sessions(org_id,module_key,target_user_id,target_role,target_scope_ref) values('70bc2fa6-2234-43b5-8220-4ac7a48c03fb','classroom',(select id from ids where email='gabe@demo.local'),'ga',null);
update view_as_sessions set expires_at = now()+interval '1 year' where actor_user_id=(select id from ids where email='alice@demo.local');
delete from view_as_sessions where actor_user_id=(select id from ids where email='alice@demo.local');
rollback to p11;
\echo --- P12 anon insert: EXPECT 42501
savepoint p12; set local role anon;
insert into view_as_sessions(org_id,module_key,target_user_id,target_role,target_scope_ref) values('70bc2fa6-2234-43b5-8220-4ac7a48c03fb','classroom',(select id from ids where email='gabe@demo.local'),'ga',null);
rollback to p12;
\echo --- P13 target (charlie) reads the session about him: EXPECT 0; then list demo-a org admins
savepoint p13; select pg_temp.act('alice@demo.local');
insert into view_as_sessions(org_id,module_key,target_user_id,target_role,target_scope_ref) values('70bc2fa6-2234-43b5-8220-4ac7a48c03fb','classroom',(select id from ids where email='charlie@demo.local'),'student','69fab5c4-2e5f-4e20-9dfa-dcc9e977adb5');
select pg_temp.act('charlie@demo.local'); select count(*) charlie_sees from view_as_sessions;
reset role; select u.email, m.role from org_members m join auth.users u on u.id=m.user_id where m.org_id='70bc2fa6-2234-43b5-8220-4ac7a48c03fb' and m.role in ('owner','admin') and m.status='active';
rollback to p13;
\echo --- P14 session row outlives a revoked grant: alice opens, her professor grant is deleted (as postgres), row still there and unexpired
savepoint p14; select pg_temp.act('alice@demo.local');
insert into view_as_sessions(org_id,module_key,target_user_id,target_role,target_scope_ref) values('70bc2fa6-2234-43b5-8220-4ac7a48c03fb','classroom',(select id from ids where email='charlie@demo.local'),'student','69fab5c4-2e5f-4e20-9dfa-dcc9e977adb5');
reset role; delete from module_roles where user_id=(select id from ids where email='alice@demo.local') and module_key='classroom';
select count(*) rows_after_revoke, bool_and(expires_at > now()) still_live from view_as_sessions where actor_user_id=(select id from ids where email='alice@demo.local');
rollback to p14;
rollback;
