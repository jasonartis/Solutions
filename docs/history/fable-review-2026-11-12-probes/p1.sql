\pset format unaligned
select 'GUARD', pg_get_functiondef('public.module_roles_guard_hierarchy'::regproc);
select 'APPLY_SLICE1', pg_get_functiondef('public.pending_invite_apply(uuid,uuid)'::regprocedure);
select 'VMMEM', pg_get_functiondef('public.vm_user_is_module_member'::regproc);
select 'ACCEPT', pg_get_functiondef('public.org_accept_invite'::regproc);
select 'AUTHUID', pg_get_functiondef('auth.uid'::regproc);
select 'TRIGGERS', tgrelid::regclass, tgname, tgenabled, tgfoid::regproc from pg_trigger where not tgisinternal and tgrelid in ('public.module_roles'::regclass,'public.vm_conversation_members'::regclass,'public.org_members'::regclass);
select 'ORGS', o.id, o.slug from public.orgs o;
select 'MEMBERS', m.org_id, m.user_id, u.email, m.role, m.status, m.invited_at from public.org_members m join auth.users u on u.id=m.user_id order by 2,3;
select 'MODROLES', r.org_id, u.email, r.module_key, r.role, r.scope_ref from public.module_roles r join auth.users u on u.id=r.user_id order by 1,2;
select 'CONVS', c.id, c.org_id, c.title from public.vm_conversations c;
select 'ORGMODS', org_id, module_key, enabled from public.org_modules where module_key='visual-messaging';
select 'USERS', id, email, email_confirmed_at is not null from auth.users order by email;
