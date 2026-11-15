\pset format unaligned
\set ON_ERROR_ROLLBACK on
select slug, id from public.orgs where slug in ('demo-a','demo-visual');
select o.slug, om.module_key, om.enabled from public.org_modules om join public.orgs o on o.id=om.org_id where o.slug in ('demo-a','demo-visual');
-- control for A11: charlie's mutual pair in demo-match
select 'MM control' as probe, mine.target_user_id, (select email from auth.users where id=mine.target_user_id) from public.mm_interests mine join public.mm_interests theirs on theirs.user_id=mine.target_user_id and theirs.target_user_id=mine.user_id where mine.user_id='57e0314b-2110-4c4f-802c-a91308340bec';

-- ===== D. alice (owner of demo-a): module-role invite for an address WITH an account elsewhere (bob) vs NO account
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"0ab0d8f7-f17a-4205-8e63-60101baab7ee","role":"authenticated"}', true);
select 'D1 module-role existing account' as probe, public.pending_invite_issue_org((select id from public.orgs where slug='demo-a'), 'bob@demo.local', 'member', (select module_key from public.org_modules where org_id=(select id from public.orgs where slug='demo-a') and enabled limit 1), 'member');
select 'D2 module-role no account' as probe, public.pending_invite_issue_org((select id from public.orgs where slug='demo-a'), 'nobody@nowhere.test', 'member', (select module_key from public.org_modules where org_id=(select id from public.orgs where slug='demo-a') and enabled limit 1), 'member');
select 'D3 waiting_on' as probe, email, kind, module_key, waiting_on from public.pending_invites_list((select id from public.orgs where slug='demo-a')) order by email, kind;
-- chat invite in demo-visual (alice owner): existing vs none
select 'D4 vm existing' as probe, public.pending_invite_issue_vm((select id from public.vm_conversations where org_id=(select id from public.orgs where slug='demo-visual') limit 1), 'bob@demo.local');
select 'D5 vm none' as probe, public.pending_invite_issue_vm((select id from public.vm_conversations where org_id=(select id from public.orgs where slug='demo-visual') limit 1), 'nobody@nowhere.test');
select 'D6 vm waiting_on' as probe, email, kind, waiting_on from public.pending_invites_list((select id from public.orgs where slug='demo-visual')) order by email;
rollback;

-- ===== C. anon with literal ids (EXECUTE denial is the test)
begin;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select 'C1 anon find_module_peer' as probe, public.find_module_peer('00000000-0000-0000-0000-000000000000'::uuid, 'dana@demo.local');
select 'C2 anon org_member_profiles' as probe, count(*) from public.org_member_profiles('00000000-0000-0000-0000-000000000000'::uuid);
select 'C3 anon superadmin_user_emails' as probe, count(*) from public.superadmin_user_emails(array['0ab0d8f7-f17a-4205-8e63-60101baab7ee'::uuid]);
select 'C4 anon pending_invites_claim_mine' as probe, public.pending_invites_claim_mine();
select 'C5 anon org_find_user_by_email' as probe, count(*) from public.org_find_user_by_email('00000000-0000-0000-0000-000000000000'::uuid, 'alice@demo.local');
rollback;
