\pset format unaligned
\set ON_ERROR_ROLLBACK on
select relname, relrowsecurity from pg_class where relname in ('account_signup_blocks','content_reports','sd_matches','pending_invites');
select polname, polcmd, pg_get_expr(polqual, polrelid) from pg_policy where polrelid='public.sd_matches'::regclass;
select pg_get_functiondef('public.pending_invite_resend(uuid)'::regprocedure);
select pg_get_functiondef('public.is_org_admin(uuid)'::regprocedure);

-- ===== A. charlie (rank-0 member of demo-a, not admin anywhere)
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"57e0314b-2110-4c4f-802c-a91308340bec","role":"authenticated"}', true);
select 'A1 org_find_user_by_email as charlie' as probe, count(*) from public.org_find_user_by_email((select id from public.orgs where slug='demo-a'), 'alice@demo.local');
select 'A2 org_member_profiles(demo-a) as charlie' as probe, count(*) from public.org_member_profiles((select id from public.orgs where slug='demo-a'));
select 'A3 find_module_peer(demo-a, dana) co-member' as probe, public.find_module_peer((select id from public.orgs where slug='demo-a'), ' DANA@demo.local ');
select 'A4 find_module_peer(demo-a, bob) not in org' as probe, public.find_module_peer((select id from public.orgs where slug='demo-a'), 'bob@demo.local');
select 'A5 find_module_peer(demo-b, bob) caller not in org' as probe, public.find_module_peer((select id from public.orgs where slug='demo-b'), 'bob@demo.local');
select 'A6 find_module_peer(demo-a, nobody)' as probe, public.find_module_peer((select id from public.orgs where slug='demo-a'), 'nobody@nowhere.test');
select 'A7 direct pending_invites' as probe, count(*) from public.pending_invites;
select 'A8 direct content_reports' as probe, count(*) from public.content_reports;
select 'A9 direct account_signup_blocks' as probe, count(*) from public.account_signup_blocks;
select 'A10 superadmin_user_emails as charlie' as probe, count(*) from public.superadmin_user_emails(array['0ab0d8f7-f17a-4205-8e63-60101baab7ee'::uuid]);
select 'A11 mm_mutual_matches as charlie' as probe, count(*) from public.mm_mutual_matches();
select 'A12 pending_invites_list(demo-a) as charlie' as probe, count(*) from public.pending_invites_list((select id from public.orgs where slug='demo-a'));
select 'A13 sd_match_contacts as charlie, any event' as probe, count(*) from public.sd_match_contacts((select id from public.sd_events limit 1));
select 'A14 account_signup_block_lookup as charlie' as probe, count(*) from public.account_signup_block_lookup('alice@demo.local');
select 'A15 account_request_deletion_for_email as charlie' as probe, public.account_request_deletion_for_email('alice@demo.local');
rollback;

-- ===== B. bob (admin of demo-b): invite an address WITH an account vs WITHOUT -- same answer?
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"fa2fb87a-5666-4e2a-9369-b0860e352207","role":"authenticated"}', true);
select 'B1 org_find_user_by_email as org admin' as probe, count(*) from public.org_find_user_by_email((select id from public.orgs where slug='demo-b'), 'alice@demo.local');
select 'B2 issue to existing account (alice)' as probe, public.pending_invite_issue_org((select id from public.orgs where slug='demo-b'), 'alice@demo.local', 'member');
select 'B3 issue to no account' as probe, public.pending_invite_issue_org((select id from public.orgs where slug='demo-b'), 'nobody@nowhere.test', 'member');
select 'B4 list waiting_on' as probe, email, kind, waiting_on from public.pending_invites_list((select id from public.orgs where slug='demo-b'));
select 'B5 resend existing-account invite' as probe, public.pending_invite_resend((select id from public.pending_invites where email='alice@demo.local' and kind='org'));
select 'B6 resend no-account invite' as probe, public.pending_invite_resend((select id from public.pending_invites where email='nobody@nowhere.test' and kind='org'));
select 'B7 issue with module role to existing vs none' as probe,
  public.pending_invite_issue_org((select id from public.orgs where slug='demo-b'), 'alice2@demo.local', 'member', (select module_key from public.org_modules where org_id=(select id from public.orgs where slug='demo-b') and enabled limit 1), 'member');
select 'B8 list after module role' as probe, email, kind, waiting_on from public.pending_invites_list((select id from public.orgs where slug='demo-b'));
select 'B9 org_member_profiles(demo-b) as admin' as probe, email from public.org_member_profiles((select id from public.orgs where slug='demo-b'));
select 'B10 org_member_profiles(demo-a) as non-admin of a' as probe, count(*) from public.org_member_profiles((select id from public.orgs where slug='demo-a'));
rollback;

-- ===== C. anon
begin;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select 'C1 anon find_module_peer' as probe, public.find_module_peer((select id from public.orgs where slug='demo-a'), 'dana@demo.local');
select 'C2 anon org_member_profiles' as probe, count(*) from public.org_member_profiles((select id from public.orgs where slug='demo-a'));
select 'C3 anon profiles' as probe, count(*) from public.profiles;
select 'C4 anon pending_invites' as probe, count(*) from public.pending_invites;
rollback;

-- ===== D. is the module_role waiting_on an oracle for an address that has an account but no seat? (bob invites module role for alice who has an account elsewhere)
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"fa2fb87a-5666-4e2a-9369-b0860e352207","role":"authenticated"}', true);
select 'D1 module-role for existing account' as probe, public.pending_invite_issue_org((select id from public.orgs where slug='demo-b'), 'alice@demo.local', 'member', (select module_key from public.org_modules where org_id=(select id from public.orgs where slug='demo-b') and enabled limit 1), 'member');
select 'D2 module-role for no account' as probe, public.pending_invite_issue_org((select id from public.orgs where slug='demo-b'), 'nobody@nowhere.test', 'member', (select module_key from public.org_modules where org_id=(select id from public.orgs where slug='demo-b') and enabled limit 1), 'member');
select 'D3 waiting_on compare' as probe, email, kind, waiting_on from public.pending_invites_list((select id from public.orgs where slug='demo-b')) order by email, kind;
rollback;
