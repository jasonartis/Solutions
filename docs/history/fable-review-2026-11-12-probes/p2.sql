\pset format unaligned
\set ON_ERROR_STOP off
select 'ISORGADMIN', pg_get_functiondef('public.is_org_admin'::regproc);
select 'VMINVITE', pg_get_functiondef('public.vm_invite_pending'::regproc);
select 'VMPIN', pg_get_functiondef('public.vm_pin_member'::regproc);
select 'VMCONVADMIN', pg_get_functiondef('public.vm_is_conv_admin'::regproc);
select 'ORGRANK', pg_get_functiondef('public.org_role_rank'::regproc);
select 'POLICIES', polname, polcmd, pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid) from pg_policy where polrelid='public.module_roles'::regclass;
