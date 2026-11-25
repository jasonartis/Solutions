-- WHOLE-ACCOUNT VIEW AS — migration A (additive; safe while the OLD app is live)
-- (docs/13 "WHOLE-ACCOUNT VIEW AS — THE DESIGN", amended by "FOUR-WAY REVIEW OF
-- THE DESIGN (2026-11-24) AND THE REVISIONS IT FORCES", which wins where they
-- conflict; founder answers 2026-11-24: go on A + the app).
--
-- WHAT CHANGES (revision numbers are the four-way review's):
--   * A view can be of a PERSON, not one org's module: view_as_real_start(p_target)
--     (1-argument overload) opens a session with org_id/module_key NULL. The
--     3-argument form is KEPT unchanged until the app stops calling it (rev. 1).
--   * view_as_real_check: same signature and columns. A session WITH an org
--     behaves exactly as before (path prefix /o/<slug>/m/<module>, membership,
--     module on). A whole-account session is live while the person is not a
--     superadmin, not deleted/departed, not banned; in scope = /dashboard,
--     /account, /feedback (exact or + '/') and /o/… only (rev. 2).
--   * A second, STICKY view flag (rev. 9): the pre-request hook also sets
--     sp.view_as = 'on' for the transaction, so a definer that blanks
--     request.jwt.claims (pending_invite_apply*) cannot make "is this a view?"
--     answer no. in_view_as() = either flag.
--   * private_text(value, label): the general private-field rule. Real value
--     normally; '‹label · N characters›' under a view. sd_my_notes is the first
--     reader; the résumé vault adopts the same rule (docs/13).
--   * Render-time writers are view-aware, each branch AFTER the function's own
--     checks and immediately before the write (rev. 8): mm_ensure_answer
--     returns NULL without writing (migration B widens it to the stored row or
--     the computed default, behind view_as_may_read);
--     pending_invites_claim_mine returns 0 before its FOR UPDATE loop;
--     account_deletion_resume and feedback_mark_read do nothing.
--   * org_my_pending_invites / vm_my_pending_invites also return, under a view,
--     the person's unclaimed invitations that their own claim WOULD turn into
--     pending seats, shaped as those seats — so the screen matches (rev. 6).
--   * mm_my_answers(org): stored answers + the default (admin locks applied)
--     for every approved question without a row, writing nothing (rev. 5).
--   * view_as_may_read(org, module) (rev. 11): the ONE rule migration B puts in
--     the 46 `<table>_no_view_as` policies. Not used by any policy here.
--
-- WHAT DOES NOT CHANGE: the 46 restrictive `<table>_no_view_as` policies and
-- sd_notes_no_view_as (migration B, supabase/pending/, replaces the 46; sd_notes
-- stays dark for ever). The read-only gate. Storage write policies.
--
-- THE HOOK (docs/12 never-do): EVERY prod API request calls
-- public.view_as_pre_request(). It must never raise and has NO exception block
-- (a plpgsql EXCEPTION block is a subtransaction and leaving it reverts the
-- set_config, turning the gate off). in_view_as()/view_as_may_read() sit in RLS
-- policies too, so they are raise-free (JSON/uuid validated before any cast).
--
-- THE SESSION ROW IS THE PERMANENT STAFF-ACCESS RECORD (founder 2026-11-24,
-- docs/12 never-do, /privacy): never delete, prune or add a retention job to
-- public.view_as_real_sessions. Its foreign keys stay `set null`.
--
-- PRE-EXISTING GAP CHECKED (rev. 5): the review read mm_ensure_answer at
-- 20260709020000:447; the SAME migration re-creates it at :608 with
-- `mm_is_single(q.org_id)`, so the cross-org insert was already refused. The
-- check is kept below and view-as-whole-account.test.ts proves it.
--
-- ACLs: revoke before grant on every new and every re-created function
-- (docs/03 #27); classified in scripts/verify-acl-hardening.ts.

-- ---------------------------------------------------------------------------
-- 1. Sessions may be whole-account
-- ---------------------------------------------------------------------------
alter table public.view_as_real_sessions alter column module_key drop not null;
-- org_id was already nullable (`on delete set null`). A whole-account session
-- has BOTH null; a v1 session whose org was deleted keeps its module_key, so it
-- can never be mistaken for a whole-account one (view_as_real_check below).

-- End every open v1 (org-scoped) session. The app shipped with this migration
-- no longer understands v1 scope (it starts whole-account sessions only), so an
-- open v1 session would be a view nobody can see the edges of. Ending it keeps
-- the row (the permanent staff-access record — never deleted, docs/12); the
-- superadmin simply starts a new view.
update public.view_as_real_sessions
set ended_at = pg_catalog.now()
where ended_at is null
  and module_key is not null;

-- ---------------------------------------------------------------------------
-- 2. in_view_as() — either view flag
-- ---------------------------------------------------------------------------
create or replace function public.in_view_as()
returns boolean
language sql
stable
set search_path = ''
as $$
  select public.is_view_as_request()
      or coalesce(pg_catalog.current_setting('sp.view_as', true), '') = 'on';
$$;

revoke all on function public.in_view_as() from public, anon, authenticated, service_role;
grant execute on function public.in_view_as() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. The pre-request hook also sets the sticky flag (rev. 9)
-- ---------------------------------------------------------------------------
create or replace function public.view_as_pre_request()
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  if public.is_view_as_request() then
    perform pg_catalog.set_config('transaction_read_only', 'on', true);
    perform pg_catalog.set_config('sp.view_as', 'on', true);
  end if;
end;
-- NO exception handler here, on purpose: a plpgsql EXCEPTION block runs as a
-- subtransaction, and leaving it reverts the set_config above — the gate would
-- silently be OFF (caught by real-view-as.test.ts, 2026-11-12). The function
-- cannot raise because is_view_as_request() cannot (it validates the JSON first).
$$;

revoke all on function public.view_as_pre_request() from public, anon, authenticated, service_role;
grant execute on function public.view_as_pre_request() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. view_as_may_read(org, module) — the shared rule for migration B (rev. 11)
-- ---------------------------------------------------------------------------
-- True for every ordinary request. Under a view: true only when the token's
-- view_as.session is an open, unexpired WHOLE-ACCOUNT session (org and module
-- null) of THIS person, started by a superadmin, and the person is still
-- viewable — not a superadmin, not deleted/departed, not banned: the same
-- conjuncts view_as_real_check uses, so a still-valid 5-minute token stops
-- reading the moment the account is banned or leaves. An org-scoped (v1) session, a
-- forged/unknown session id, or a blanked-claims context answers false. The
-- arguments are unused today; the later STAFF version narrows by them.
-- Definer: it reads view_as_real_sessions/user_private, which the person cannot.
create or replace function public.view_as_may_read(p_org_id uuid, p_module text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with c as (
    select case
      when pg_catalog.pg_input_is_valid(coalesce(pg_catalog.current_setting('request.jwt.claims', true), ''), 'jsonb')
        then pg_catalog.current_setting('request.jwt.claims', true)::jsonb
    end as j
  ), k as (
    select
      case when pg_catalog.pg_input_is_valid(coalesce(c.j #>> '{view_as,session}', ''), 'uuid')
        then (c.j #>> '{view_as,session}')::uuid end as sid,
      case when pg_catalog.pg_input_is_valid(coalesce(c.j ->> 'sub', ''), 'uuid')
        then (c.j ->> 'sub')::uuid end as sub
    from c
  )
  select not public.in_view_as()
      or exists (
        select 1
        from k
        join public.view_as_real_sessions vs on vs.id = k.sid
        join public.user_private up on up.user_id = vs.actor_user_id and up.is_superadmin
        where vs.org_id is null
          and vs.module_key is null
          and vs.ended_at is null
          and vs.expires_at > pg_catalog.now()
          and vs.target_user_id = k.sub
          and not exists (select 1 from public.user_private t
                          where t.user_id = vs.target_user_id and t.is_superadmin)
          and exists (select 1 from auth.users u
                      where u.id = vs.target_user_id
                        and u.deleted_at is null
                        and (u.banned_until is null or u.banned_until <= pg_catalog.now()))
          and not public.account_has_left(vs.target_user_id)
      );
$$;

revoke all on function public.view_as_may_read(uuid, text) from public, anon, authenticated, service_role;
-- Every role: it will sit in RLS policies `to public` (migration B).
grant execute on function public.view_as_may_read(uuid, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. private_text(value, label) — the private-field rule
-- ---------------------------------------------------------------------------
create or replace function public.private_text(p_value text, p_label text)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_value is null then null
    when public.in_view_as()
      then '‹' || coalesce(p_label, 'private') || ' · ' || pg_catalog.char_length(p_value)::text || ' characters›'
    else p_value
  end;
$$;

revoke all on function public.private_text(text, text) from public, anon, authenticated, service_role;
grant execute on function public.private_text(text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. sd_my_notes(event) — the one reader of sd_notes
-- ---------------------------------------------------------------------------
-- The table's own owner rule (sd_notes_all_own: author = auth.uid()); the body
-- through private_text. Definer, so it reads past sd_notes_no_view_as (which
-- STAYS: a direct read with a view token returns nothing). view_as_may_read
-- keeps it dark to an org-scoped (v1) view, like every other sd_ table.
create or replace function public.sd_my_notes(p_event_id uuid)
returns table (about_user_id uuid, body text)
language sql
stable
security definer
set search_path = ''
as $$
  select n.about_user_id, public.private_text(n.body, 'private note')
  from public.sd_notes n
  where auth.uid() is not null
    and n.author_user_id = auth.uid()
    and n.event_id = p_event_id
    and public.view_as_may_read(n.org_id, 'speed-dating');
$$;

revoke all on function public.sd_my_notes(uuid) from public, anon, authenticated, service_role;
grant execute on function public.sd_my_notes(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Matchmaking (rev. 5)
-- ---------------------------------------------------------------------------
-- mm_my_answers: INVOKER, so the person's own RLS (and, under a view, the
-- `_no_view_as` policies / migration B's rule) decide what it reads. Stored
-- rows for this org, plus — for a single — the default mm_ensure_answer would
-- create (admin locks applied, auto = true) for each approved question that
-- has no row yet. Writes nothing.
create or replace function public.mm_my_answers(p_org_id uuid)
returns table (question_id uuid, "position" integer, care integer, dealbreaker boolean, share_with_match boolean, auto boolean)
language sql
stable
set search_path = ''
as $$
  select a.question_id, a.position, a.care, a.dealbreaker, a.share_with_match, a.auto
  from public.mm_answers a
  where a.org_id = p_org_id and a.user_id = auth.uid()
  union all
  select q.id,
         coalesce((q.admin_locks ->> 'answer')::int, pg_catalog.floor((pg_catalog.array_length(q.scale_labels, 1) - 1) / 2.0)::int),
         coalesce((q.admin_locks ->> 'care')::int, 0),
         coalesce((q.admin_locks ->> 'dealbreaker')::boolean, false),
         false,
         true
  from public.mm_questions q
  where q.org_id = p_org_id
    and q.status = 'approved'
    and auth.uid() is not null
    and public.mm_is_single(p_org_id)
    and not exists (select 1 from public.mm_answers a
                    where a.question_id = q.id and a.user_id = auth.uid());
$$;

revoke all on function public.mm_my_answers(uuid) from public, anon, authenticated, service_role;
grant execute on function public.mm_my_answers(uuid) to authenticated;

-- mm_ensure_answer: unchanged except the view branch, placed after the
-- question and single checks, immediately before the insert. Under a view it
-- returns NULL and writes nothing (B widens it — see the branch).
create or replace function public.mm_ensure_answer(check_question_id uuid)
returns public.mm_answers
language plpgsql
security definer
set search_path = public
as $$
declare
  q public.mm_questions%rowtype;
  result public.mm_answers%rowtype;
begin
  select * into q from public.mm_questions
  where id = check_question_id and status = 'approved';
  if not found then
    raise exception 'Unknown or unapproved question %', check_question_id;
  end if;

  if not public.mm_is_single(q.org_id) then
    raise exception 'Only singles answer questions';
  end if;

  if public.in_view_as() then
    -- A definer reads past mm_answers_no_view_as, so it applies the table rule
    -- itself (review 2026-11-24, MEDIUM: it used to return the stored row to
    -- ANY view, v1 included). Under this migration every view token is dark on
    -- mm_ tables, so: nothing, and no write. Migration B
    -- (supabase/pending/20261126010000_view_as_widen.sql) re-creates this
    -- function with the widened branch (view_as_may_read, then the stored row or
    -- the unsaved default).
    return null;
  end if;

  insert into public.mm_answers (org_id, question_id, user_id, position, care, dealbreaker, auto, share_with_match)
  values (
    q.org_id,
    q.id,
    auth.uid(),
    coalesce((q.admin_locks ->> 'answer')::int, floor((array_length(q.scale_labels, 1) - 1) / 2.0)::int),
    coalesce((q.admin_locks ->> 'care')::int, 0),
    coalesce((q.admin_locks ->> 'dealbreaker')::boolean, false),
    true,
    false
  )
  on conflict (question_id, user_id) do nothing
  returning * into result;

  if result.id is null then
    select * into result from public.mm_answers
    where question_id = check_question_id and user_id = auth.uid();
  end if;

  return result;
end;
$$;

revoke all on function public.mm_ensure_answer(uuid) from public, anon, authenticated, service_role;
grant execute on function public.mm_ensure_answer(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. Invites (rev. 6)
-- ---------------------------------------------------------------------------
-- pending_invite_would_apply(invite, invitee): would pending_invites_claim_mine,
-- run by `invitee` now, turn this 'org' or 'vm_conversation' invitation into a
-- pending seat? The same checks as the claim + pending_invite_apply /
-- pending_invite_apply_held, read-only. Internal: no api role may call it.
create or replace function public.pending_invite_would_apply(p_invite uuid, p_invitee uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select
      -- the claim's identity gate on the invitee
      me.email is not null
      and me.email_confirmed_at is not null
      and me.deleted_at is null
      and coalesce(me.is_anonymous, false) = false
      and (me.banned_until is null or me.banned_until <= pg_catalog.now())
      and inv.email = pg_catalog.lower(pg_catalog.btrim(me.email))
      and (select count(*) from auth.users u2
           where pg_catalog.lower(pg_catalog.btrim(u2.email)) = inv.email and u2.deleted_at is null) = 1
      and inv.expires_at > pg_catalog.now()
      -- the inviter can still make it
      and not exists (select 1 from auth.users u
                      where u.id = inv.invited_by
                        and (u.banned_until > pg_catalog.now() or u.deleted_at is not null))
      and not public.account_has_left(inv.invited_by)
      and case inv.kind
        when 'org' then
          (exists (select 1 from public.user_private up
                   where up.user_id = inv.invited_by and up.is_superadmin)
           or exists (select 1 from public.org_members ib
                      where ib.org_id = inv.org_id and ib.user_id = inv.invited_by
                        and ib.status = 'active'
                        and public.org_role_rank(ib.role) > public.org_role_rank(inv.role)))
          and not exists (select 1 from public.org_members m
                          where m.org_id = inv.org_id and m.user_id = p_invitee)
        when 'vm_conversation' then
          (select c.org_id from public.vm_conversations c where c.id = inv.target_id) is not distinct from inv.org_id
          and inv.org_id is not null
          and (exists (select 1 from public.user_private up
                       where up.user_id = inv.invited_by and up.is_superadmin)
               or exists (select 1 from public.org_members ib
                          where ib.org_id = inv.org_id and ib.user_id = inv.invited_by
                            and ib.status = 'active' and ib.role in ('owner', 'admin'))
               or (exists (select 1 from public.org_members ib
                           where ib.org_id = inv.org_id and ib.user_id = inv.invited_by
                             and ib.status = 'active')
                   and (exists (select 1 from public.module_roles r
                                where r.org_id = inv.org_id and r.user_id = inv.invited_by
                                  and r.module_key = 'visual-messaging' and r.role = 'admin'
                                  and r.scope_ref is null)
                        or (public.vm_user_is_module_member(inv.org_id, inv.invited_by)
                            and exists (select 1 from public.vm_conversation_members s
                                        where s.conversation_id = inv.target_id and s.user_id = inv.invited_by
                                          and s.status = 'active' and s.role = 'admin')))))
          and not exists (select 1 from public.vm_conversation_members s
                          where s.conversation_id = inv.target_id and s.user_id = p_invitee)
          and exists (select 1 from public.org_members m
                      where m.org_id = inv.org_id and m.user_id = p_invitee and m.status = 'active')
          and public.vm_user_is_module_member(inv.org_id, p_invitee)
        else false
      end
    from public.pending_invites inv
    join auth.users me on me.id = p_invitee
    where inv.id = p_invite
  ), false);
$$;

revoke all on function public.pending_invite_would_apply(uuid, uuid) from public, anon, authenticated, service_role;

-- org_my_pending_invites: + under a view, the org invitations the person's own
-- claim would turn into pending seats (invited_at = now(), as the claim sets).
create or replace function public.org_my_pending_invites()
returns table (org_id uuid, org_name text, org_slug text, invited_role text, invited_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select m.org_id, o.name, o.slug, m.role, m.invited_at
  from public.org_members m
  join public.orgs o on o.id = m.org_id
  where m.user_id = auth.uid()
    and m.status = 'pending'
  union all
  select x.org_id, x.name, x.slug, x.role, x.invited_at
  from (
    select distinct on (p.org_id) p.org_id, o.name, o.slug, p.role, now() as invited_at
    from public.pending_invites p
    join public.orgs o on o.id = p.org_id
    where public.in_view_as()
      and auth.uid() is not null
      and p.kind = 'org'
      and public.pending_invite_would_apply(p.id, auth.uid())
    order by p.org_id, p.created_at
  ) x;
$$;

revoke all on function public.org_my_pending_invites() from public, anon, authenticated, service_role;
grant execute on function public.org_my_pending_invites() to authenticated, service_role;

-- vm_my_pending_invites: + under a view, the chat invitations the claim would
-- turn into pending seats. The whole function is also kept dark to an
-- org-scoped (v1) view, like every vm_ table (view_as_may_read).
create or replace function public.vm_my_pending_invites(check_org_id uuid)
returns table (conversation_id uuid, title text, invited_by_name text, invited_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select y.conversation_id, y.title, y.invited_by_name, y.invited_at
  from (
    select m.conversation_id, c.title, p.display_name as invited_by_name, m.created_at as invited_at
    from public.vm_conversation_members m
    join public.vm_conversations c on c.id = m.conversation_id
    -- The inviter's name only while they are still an active member of this
    -- org: profiles_select_shared_org would not show it otherwise, and this
    -- must not be wider than that.
    left join public.profiles p
      on p.user_id = m.invited_by
     and exists (
       select 1 from public.org_members om
       where om.org_id = m.org_id and om.user_id = m.invited_by and om.status = 'active'
     )
    where m.user_id = auth.uid()
      and m.status = 'pending'
      and m.org_id = check_org_id
      and public.is_org_member(check_org_id)
    union all
    select x.conversation_id, x.title, x.invited_by_name, x.invited_at
    from (
      select distinct on (i.target_id) i.target_id as conversation_id, c.title, p.display_name as invited_by_name,
             now() as invited_at
      from public.pending_invites i
      join public.vm_conversations c on c.id = i.target_id
      left join public.profiles p
        on p.user_id = i.invited_by
       and exists (
         select 1 from public.org_members om
         where om.org_id = i.org_id and om.user_id = i.invited_by and om.status = 'active'
       )
      where public.in_view_as()
        and auth.uid() is not null
        and i.kind = 'vm_conversation'
        and i.org_id = check_org_id
        and public.is_org_member(check_org_id)
        and public.pending_invite_would_apply(i.id, auth.uid())
      order by i.target_id, i.created_at
    ) x
  ) y
  where public.view_as_may_read(check_org_id, 'visual-messaging')
  order by y.invited_at desc;
$$;

revoke all on function public.vm_my_pending_invites(uuid) from public, anon, authenticated, service_role;
grant execute on function public.vm_my_pending_invites(uuid) to authenticated, service_role;

-- pending_invites_claim_mine: unchanged except the view branch — after the
-- identity checks, BEFORE the FOR UPDATE loop (a locking read fails in a
-- read-only transaction).
create or replace function public.pending_invites_claim_mine()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_email   text;
  r         record;
  v_outcome text;
  v_applied integer := 0;
begin
  if v_uid is null then
    return 0;
  end if;

  select lower(btrim(u.email)) into v_email
  from auth.users u
  where u.id = v_uid
    and u.email is not null
    and u.email_confirmed_at is not null
    and u.deleted_at is null
    and coalesce(u.is_anonymous, false) = false
    and (u.banned_until is null or u.banned_until <= now());
  if v_email is null or v_email = '' then
    return 0;
  end if;

  if (select count(*) from auth.users u
      where lower(btrim(u.email)) = v_email and u.deleted_at is null) > 1 then
    return 0;
  end if;

  -- A view claims nothing; org_my_pending_invites / vm_my_pending_invites show
  -- what this claim would have made (20261125010000).
  if public.in_view_as() then
    return 0;
  end if;

  for r in
    select p.id, p.kind, p.org_id from public.pending_invites p
    where p.email = v_email and p.expires_at > now()
    order by case p.kind when 'org' then 0 when 'module_role' then 1 else 2 end, p.created_at
    for update skip locked
  loop
    begin
      if r.kind = 'org' then
        if public.pending_invite_apply(r.id, v_uid) then
          v_applied := v_applied + 1;
          -- Tie its module role (if any) to the seat just created.
          update public.pending_invites p
             set claimed_by = v_uid,
                 seat_invited_at = (select m.invited_at from public.org_members m
                                    where m.org_id = p.org_id and m.user_id = v_uid)
           where p.kind = 'module_role' and p.org_id = r.org_id and p.email = v_email
             and p.claimed_by is null;
        else
          -- The org part is dead or used up, so its module role is too.
          delete from public.pending_invites
           where kind = 'module_role' and org_id = r.org_id and email = v_email and claimed_by is null;
        end if;
        -- Used up whether or not it applied (slice 1).
        delete from public.pending_invites where id = r.id;
      else
        v_outcome := public.pending_invite_apply_held(r.id, v_uid);
        if v_outcome = 'applied' then
          v_applied := v_applied + 1;
        end if;
        if v_outcome in ('applied', 'dead') then
          delete from public.pending_invites where id = r.id;
        end if;
      end if;
    exception when others then
      -- Leave the row (it expires on its own) and never break the page. The
      -- address is deliberately NOT in this message.
      raise warning 'pending_invites_claim_mine: invite % not applied (%)', r.id, sqlstate;
    end;
  end loop;

  if auth.uid() is distinct from v_uid then
    raise exception 'pending_invites_claim_mine: caller identity was not restored';
  end if;

  return v_applied;
end;
$$;

revoke all on function public.pending_invites_claim_mine() from public, anon, authenticated, service_role;
grant execute on function public.pending_invites_claim_mine() to authenticated;

-- ---------------------------------------------------------------------------
-- 9. account_deletion_resume / feedback_mark_read: no-ops under a view (rev. 7, 8)
-- ---------------------------------------------------------------------------
create or replace function public.account_deletion_resume()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_n integer;
begin
  if v_uid is null then
    return jsonb_build_object('cancelled', false);
  end if;
  -- A view is not their sign-in (20261125010000).
  if public.in_view_as() then
    return jsonb_build_object('cancelled', false);
  end if;
  update public.account_deletions d
     set state = 'cancelled', cancelled_at = now(), cancel_reason = 'signed_in'
   where d.user_id = v_uid
     and d.state = 'departed'
     and d.initiated_via <> 'removal'   -- (20261008020000)
     and exists (
       select 1 from auth.users u
       where u.id = v_uid and u.last_sign_in_at > d.requested_at
     );
  get diagnostics v_n = row_count;
  return jsonb_build_object('cancelled', v_n > 0);
end;
$$;

revoke all on function public.account_deletion_resume() from public, anon, authenticated, service_role;
grant execute on function public.account_deletion_resume() to authenticated;

create or replace function public.feedback_mark_read(p_ticket_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  staff boolean := public.is_superadmin();
  owner uuid;
begin
  if me is null then
    raise exception 'Not signed in';
  end if;
  select created_by into owner from public.feedback_tickets where id = p_ticket_id;
  if owner is null or (owner <> me and not staff) then
    raise exception 'Ticket not found';
  end if;
  -- Opening a ticket while viewing does not mark it read for them (20261125010000).
  if public.in_view_as() then
    return;
  end if;
  update public.feedback_tickets
  set user_read_at = case when owner = me then clock_timestamp() else user_read_at end,
      staff_read_at = case when staff then clock_timestamp() else staff_read_at end
  where id = p_ticket_id;
end;
$$;

revoke all on function public.feedback_mark_read(uuid) from public, anon, authenticated, service_role;
grant execute on function public.feedback_mark_read(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 10. view_as_real_start(person) — whole-account; superadmin only
-- ---------------------------------------------------------------------------
create or replace function public.view_as_real_start(p_target uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null or not public.is_superadmin() or public.in_view_as() then
    raise exception 'Not allowed';
  end if;
  if p_target is null or p_target = auth.uid() then
    raise exception 'Choose someone else to view';
  end if;
  if exists (select 1 from public.user_private u where u.user_id = p_target and u.is_superadmin) then
    raise exception 'A superadmin cannot be viewed';
  end if;
  if not exists (
    select 1 from auth.users u
    where u.id = p_target and u.deleted_at is null
  ) or public.account_has_left(p_target) then
    raise exception 'That account does not exist or has been deleted';
  end if;
  if exists (select 1 from auth.users u where u.id = p_target and u.banned_until > pg_catalog.now()) then
    raise exception 'That account is banned';
  end if;

  update public.view_as_real_sessions
  set ended_at = pg_catalog.now()
  where actor_user_id = auth.uid() and ended_at is null;

  insert into public.view_as_real_sessions (actor_user_id, target_user_id, org_id, module_key)
  values (auth.uid(), p_target, null, null)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.view_as_real_start(uuid) from public, anon, authenticated, service_role;
grant execute on function public.view_as_real_start(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 11. view_as_real_check — org sessions unchanged; whole-account sessions added
-- ---------------------------------------------------------------------------
create or replace function public.view_as_real_check(p_session uuid, p_path text, p_log boolean)
returns table (
  target_user_id uuid,
  target_name text,
  org_id uuid,
  org_slug text,
  org_name text,
  module_key text,
  expires_at timestamptz,
  in_scope boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  s record;
  v_prefix text;
  v_in boolean;
begin
  if auth.uid() is null or not public.is_superadmin() or public.is_view_as_request() then
    return;
  end if;
  select vs.id, vs.target_user_id, vs.org_id, vs.module_key, vs.expires_at, o.slug, o.name
    into s
  from public.view_as_real_sessions vs
  left join public.orgs o on o.id = vs.org_id
  where vs.id = p_session
    and vs.actor_user_id = auth.uid()
    and vs.ended_at is null
    and vs.expires_at > pg_catalog.now()
    and vs.target_user_id is not null
    and not exists (select 1 from public.user_private u where u.user_id = vs.target_user_id and u.is_superadmin)
    and (
      -- An org session: exactly the v1 rule (an active member, the module on).
      (vs.org_id is not null
       and o.id is not null
       and exists (select 1 from public.org_members m
                   where m.org_id = vs.org_id and m.user_id = vs.target_user_id
                     and coalesce(m.status, 'active') = 'active')
       and exists (select 1 from public.org_modules m
                   where m.org_id = vs.org_id and m.module_key = vs.module_key and m.enabled))
      or
      -- A whole-account session (org AND module null — a v1 session whose org
      -- was deleted keeps its module_key and so is dead, not widened): the
      -- account still exists, has not left, is not banned. Re-checked per request.
      (vs.org_id is null
       and vs.module_key is null
       and exists (select 1 from auth.users u
                   where u.id = vs.target_user_id
                     and u.deleted_at is null
                     and (u.banned_until is null or u.banned_until <= pg_catalog.now()))
       and not public.account_has_left(vs.target_user_id))
    );
  if not found then
    return;
  end if;

  if s.org_id is null then
    -- The person's (app) pages only. Everything else — /console, /view-as,
    -- /auth, /login, the public pages (/, /privacy, /report, /s/…), /api —
    -- renders as the superadmin.
    v_in := p_path is not null and (
      p_path in ('/dashboard', '/account', '/feedback')
      or pg_catalog.starts_with(p_path, '/dashboard/')
      or pg_catalog.starts_with(p_path, '/account/')
      or pg_catalog.starts_with(p_path, '/feedback/')
      or pg_catalog.starts_with(p_path, '/o/')
    );
  else
    v_prefix := '/o/' || s.slug || '/m/' || s.module_key;
    v_in := p_path = v_prefix or pg_catalog.starts_with(p_path, v_prefix || '/');
  end if;
  v_in := coalesce(v_in, false);
  if v_in and coalesce(p_log, false) then
    insert into public.view_as_real_page_views (session_id, path)
    values (s.id, pg_catalog.left(p_path, 500));
  end if;

  return query
    select s.target_user_id,
           (select p.display_name from public.profiles p where p.user_id = s.target_user_id),
           s.org_id, s.slug::text, s.name::text, s.module_key, s.expires_at, v_in;
end;
$$;

revoke all on function public.view_as_real_check(uuid, text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.view_as_real_check(uuid, text, boolean) to authenticated;
