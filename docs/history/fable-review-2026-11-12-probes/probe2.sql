\pset format unaligned
select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('account_signup_block_lookup','account_signup_blocks_list','account_request_deletion_for_email','account_remove_from_platform','content_report_submit','account_email_fingerprint');
select 'POLICIES content_reports';
select polname, polcmd, pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid), polroles::regrole[] from pg_policy where polrelid='public.content_reports'::regclass;
select 'POLICIES sal_customers';
select polname, polcmd, pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid), polroles::regrole[] from pg_policy where polrelid='public.sal_customers'::regclass;
select 'POLICIES account_signup_blocks';
select polname, polcmd, pg_get_expr(polqual, polrelid), polroles::regrole[] from pg_policy where polrelid='public.account_signup_blocks'::regclass;
select grantee, privilege_type from information_schema.role_table_grants where table_schema='public' and table_name in ('content_reports','account_signup_blocks') order by 1,2;
select 'EMAIL-LIKE COLUMN DATA elsewhere (contact/address columns)';
select table_name, column_name from information_schema.columns where table_schema='public' and (column_name ilike '%contact%' or column_name ilike '%address%') order by 1,2;
