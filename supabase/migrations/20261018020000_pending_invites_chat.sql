-- PENDING INVITES, SLICE 2: CHAT (vm_conversation) PRE-INVITE, AND A MODULE
-- ROLE CARRIED ON AN ORG INVITE (2026-10-18, docs/25-pending-invites.md §12).
--
-- Builds on slice 1 (20261016010000). Read that header first: the claim is an
-- RPC the app calls (never a trigger on auth.users), and an applier writes on
-- the INVITER's behalf by clearing the caller's identity so the guard
-- triggers take their trusted service path. Applying always produces the
-- state the platform already uses — a PENDING conversation seat the person
-- still accepts (accept-first, 20261007030000), never an active one.
--
-- TWO NEW KINDS, BOTH "HELD"
--
--   vm_conversation  An address invited to one conversation (target_id = the
--                    conversation). A chat invite NEVER creates org membership
--                    (docs/25 §2 refinement 1). It waits until the person is
--                    an ACTIVE member of the conversation's org AND holds the
--                    visual-messaging module role (founder, docs/25 §6 answer
--                    4: held, not refused).
--   module_role      A module role an org admin attaches to an ORG invite
--                    (target_id = the org, module_key set). Slice 1's review
--                    (docs/25 §11.3 item 1) ruled that a module role must
--                    never be written while the org seat is only pending: it
--                    would outlive its inviter's authority. So it is its own
--                    row, applied only once the person has ACCEPTED (org seat
--                    active), with the inviter re-checked at that moment.
--                    Without it the founder's scenario 1 (pre-invite family
--                    to the org with a module role and to a chat, nothing
--                    manual in between) cannot happen: a chat maker cannot
--                    grant the module role the chat invite is waiting for.
--
-- A held row is re-evaluated every time pending_invites_claim_mine runs (the
-- dashboard, right after accepting an org invite, and the visual-messaging
-- pages). It is applied when its prerequisites are met, DELETED unused when it
-- is dead (inviter lost authority, conversation gone, the person already has a
-- seat in that conversation — which includes a self-block, so a self-block
-- always wins), and otherwise left alone until it expires. Deliberately no
-- trigger on org_members / module_roles: a failing trigger there would block
-- an org accept or a role grant, and it would run as whoever made the change.
--
-- NO ORACLE. pending_invite_issue_vm never reads auth.users or org_members for
-- the address and always answers 'invited'. Only an ORG ADMIN is told what a
-- held invite is waiting for, and that reason is computed from the org's own
-- seats, which an org admin already reads with addresses (org_member_profiles).
-- An ordinary inviter sees only their own rows, with no reason.

-- ---------------------------------------------------------------------------
-- 1. The table: two new kinds and a module_key column
-- ---------------------------------------------------------------------------
alter table public.pending_invites add column module_key text;

-- A module_role row belongs to ONE org invitation, not to an address
-- (adversarial review 2026-10-18): when its org invite turns into a pending
-- seat, the row is stamped with that person and that seat's invited_at, and it
-- applies only if THAT seat later becomes active. Otherwise a withdrawn or
-- declined invitation's role would ride in on somebody else's later invite, or
-- follow the address to whoever holds it next.
alter table public.pending_invites
  add column claimed_by uuid references auth.users (id) on delete cascade,
  add column seat_invited_at timestamptz;

alter table public.pending_invites drop constraint pending_invites_kind_check;
alter table public.pending_invites add constraint pending_invites_kind_check
  check (kind in ('org', 'module_role', 'vm_conversation'));

alter table public.pending_invites drop constraint pending_invites_org_shape;
alter table public.pending_invites add constraint pending_invites_org_shape check (
  kind <> 'org' or (org_id is not null and target_id = org_id and module_key is null
                    and role in ('owner', 'admin', 'member')));
alter table public.pending_invites add constraint pending_invites_module_role_shape check (
  kind <> 'module_role' or (org_id is not null and target_id = org_id
                            and char_length(module_key) between 1 and 64
                            and char_length(role) between 1 and 64));
-- 'participant' only: the only role the app has ever invited as.
alter table public.pending_invites add constraint pending_invites_vm_shape check (
  kind <> 'vm_conversation' or (org_id is not null and target_id is not null and module_key is null
                                and role in ('participant')));

-- One row per (kind, target, module, address).
alter table public.pending_invites drop constraint pending_invites_one_per_target;
alter table public.pending_invites add constraint pending_invites_one_per_target
  unique nulls not distinct (kind, target_id, module_key, email);

create index pending_invites_target_idx on public.pending_invites (target_id);

-- ---------------------------------------------------------------------------
-- 2. Shared issue step: serialise, then the caps (docs/25 §6 answer 2)
-- ---------------------------------------------------------------------------
-- Returns 'new' (a new row may be stored), 'refresh' (the row exists; caps do
-- not apply to a refresh) or 'over_address_cap' (store NOTHING and answer the
-- inviter exactly as for a success). Raises with the inviter's OWN limit when
-- they are over it. module_role rows never count: they only ride along with
-- an org invite issued by the same person in the same call.
create or replace function public.pending_invite_slot(
  p_inviter uuid, p_email text, p_kind text, p_target uuid, p_module_key text
)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_max_inviter integer;
  v_max_address integer;
begin
  perform pg_advisory_xact_lock(hashtext('pending_invites:address:' || p_email));
  perform pg_advisory_xact_lock(hashtext('pending_invites:inviter:' || p_inviter::text));

  if exists (select 1 from public.pending_invites
             where kind = p_kind and target_id is not distinct from p_target
               and module_key is not distinct from p_module_key and email = p_email) then
    return 'refresh';
  end if;

  select case when s.value ->> 'maxPerInviter' ~ '^[0-9]{1,6}$'
              then (s.value ->> 'maxPerInviter')::integer else 100 end,
         case when s.value ->> 'maxPerAddress' ~ '^[0-9]{1,6}$'
              then (s.value ->> 'maxPerAddress')::integer else 20 end
    into v_max_inviter, v_max_address
  from (select 1) one
  left join public.platform_settings s on s.key = 'pending_invites.caps';

  if (select count(*) from public.pending_invites
      where invited_by = p_inviter and kind <> 'module_role' and expires_at > now()) >= v_max_inviter then
    raise exception 'You have reached your limit of % open invitations. Cancel some first.', v_max_inviter;
  end if;
  -- The ADDRESS cap counts distinct INVITERS, not rows (adversarial review
  -- 2026-10-18). Counting rows let one chat maker fill an address's cap alone
  -- by inviting it to many conversations, read off how many OTHER invitations
  -- exist from where her own stopped being stored, and watch for that number
  -- to drop — i.e. learn when the person signed up. Someone who already holds
  -- an invitation for the address is never stopped by it.
  if not exists (select 1 from public.pending_invites
                 where email = p_email and invited_by = p_inviter
                   and kind <> 'module_role' and expires_at > now())
     and (select count(distinct invited_by) from public.pending_invites
          where email = p_email and kind <> 'module_role' and expires_at > now()) >= v_max_address then
    return 'over_address_cap';
  end if;
  return 'new';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Issue — org (now optionally with ONE module role)
-- ---------------------------------------------------------------------------
-- DROP + CREATE (not replace): the parameter list grows. The two new
-- parameters default to NULL, so the deployed app's three-argument call keeps
-- resolving during the deploy window (migrate first, then push).
drop function public.pending_invite_issue_org(uuid, text, text);

create function public.pending_invite_issue_org(
  check_org_id uuid,
  target_email text,
  invited_role text,
  with_module_key text default null,
  with_module_role text default null
)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_email text := lower(btrim(coalesce(target_email, '')));
  v_rank  integer;
  v_rows  integer;
  v_slot  text;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;
  if char_length(v_email) not between 3 and 320 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    raise exception 'Enter a valid email address';
  end if;
  if coalesce(invited_role, '') not in ('owner', 'admin', 'member') then
    raise exception 'Unknown role';
  end if;
  if (with_module_key is null) <> (with_module_role is null)
     or char_length(coalesce(with_module_role, 'x')) not between 1 and 64 then
    raise exception 'Unknown module role';
  end if;

  v_rank := public.org_caller_rank(check_org_id);
  if not public.is_org_admin(check_org_id) or v_rank <= public.org_role_rank(invited_role) then
    raise exception 'Not authorized';
  end if;
  -- The role's NAME is checked against the module's manifest by the app (as
  -- for a direct grant today; SQL has no vocabulary). Here: the module must be
  -- switched on for this org.
  if with_module_key is not null and not exists (
       select 1 from public.org_modules om
       where om.org_id = check_org_id and om.module_key = with_module_key and om.enabled) then
    raise exception 'Unknown module role';
  end if;

  -- Not an oracle: an org admin already reads every seat's address.
  if exists (
    select 1
    from public.org_members m
    join auth.users u on u.id = m.user_id
    where m.org_id = check_org_id
      and lower(btrim(u.email)) = v_email
  ) then
    return 'already_member';
  end if;

  v_slot := public.pending_invite_slot(v_uid, v_email, 'org', check_org_id, null);
  if v_slot = 'over_address_cap' then
    return 'invited';   -- silent (slice 1's CAPS note)
  end if;

  insert into public.pending_invites as p
    (kind, org_id, target_id, email, role, invited_by, expires_at)
  values
    ('org', check_org_id, check_org_id, v_email, invited_role, v_uid, now() + interval '30 days')
  on conflict (kind, target_id, module_key, email) do update
    set role       = excluded.role,
        invited_by = excluded.invited_by,
        created_at = now(),
        expires_at = excluded.expires_at
    where p.invited_by = v_uid
       or v_rank > public.org_role_rank(p.role);
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return 'exists';   -- and its module role, if any, is left exactly as it was
  end if;

  -- The module role rides with THIS issue of the org invitation: whatever an
  -- earlier issue attached is replaced, never merged (adversarial review: a
  -- caller must not add to or overwrite a companion they did not issue).
  delete from public.pending_invites
   where kind = 'module_role' and org_id = check_org_id and email = v_email;
  if with_module_key is not null then
    insert into public.pending_invites as p
      (kind, org_id, target_id, module_key, email, role, invited_by, expires_at)
    values
      ('module_role', check_org_id, check_org_id, with_module_key, v_email, with_module_role, v_uid,
       now() + interval '30 days');
  end if;

  return 'invited';
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Issue — chat
-- ---------------------------------------------------------------------------
-- Allowed iff the caller could add someone to this conversation directly
-- today: vm_is_conv_admin (an active admin seat, or a visual-messaging
-- manager of the org). Never asks whether the address has an account, is in
-- the org, has the module role, already has a seat or has blocked the
-- conversation: the answer is 'invited' in every one of those cases.
create or replace function public.pending_invite_issue_vm(
  check_conversation_id uuid,
  target_email text
)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_email text := lower(btrim(coalesce(target_email, '')));
  v_org   uuid;
  v_slot  text;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;
  if char_length(v_email) not between 3 and 320 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    raise exception 'Enter a valid email address';
  end if;

  select c.org_id into v_org from public.vm_conversations c where c.id = check_conversation_id;
  if v_org is null or not public.vm_is_conv_admin(check_conversation_id) then
    raise exception 'Not authorized';
  end if;

  v_slot := public.pending_invite_slot(v_uid, v_email, 'vm_conversation', check_conversation_id, null);
  if v_slot = 'over_address_cap' then
    return 'invited';
  end if;

  -- A second conversation admin re-inviting the same address takes the row
  -- over and resets its clock: either of them could have issued it.
  insert into public.pending_invites as p
    (kind, org_id, target_id, email, role, invited_by, expires_at)
  values
    ('vm_conversation', v_org, check_conversation_id, v_email, 'participant', v_uid, now() + interval '30 days')
  on conflict (kind, target_id, module_key, email) do update
    set invited_by = excluded.invited_by,
        created_at = now(),
        expires_at = excluded.expires_at;

  return 'invited';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Cancel and resend
-- ---------------------------------------------------------------------------
-- CANCEL: any current org admin of the invite's org, any kind (docs/25 §6
-- answer 3). Also the person who issued a CHAT invite, while they are still an
-- admin of that conversation. Cancelling an org invite also removes the module
-- role that rode along with it. Anything else reads as "not found".
create or replace function public.pending_invite_cancel(invite_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  inv public.pending_invites%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  select * into inv from public.pending_invites where id = invite_id for update;
  if not found
     or not (public.is_org_admin(inv.org_id)
             or (inv.kind = 'vm_conversation'
                 and inv.invited_by = auth.uid()
                 and public.vm_is_conv_admin(inv.target_id))) then
    raise exception 'Invitation not found';
  end if;
  delete from public.pending_invites where id = invite_id;
  if inv.kind = 'org' then
    delete from public.pending_invites
     where kind = 'module_role' and org_id = inv.org_id and email = inv.email;
  end if;
end;
$$;

-- RESEND = a fresh 30 days, re-issued by the caller (invited_by moves to them,
-- because the claim re-checks the inviter on the row). Held to each kind's
-- issue rule.
create or replace function public.pending_invite_resend(invite_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  inv public.pending_invites%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  select * into inv from public.pending_invites where id = invite_id for update;
  if not found then
    raise exception 'Invitation not found';
  end if;

  if inv.kind = 'org' then
    if not public.is_org_admin(inv.org_id)
       or not (inv.invited_by = auth.uid()
               or public.org_caller_rank(inv.org_id) > public.org_role_rank(inv.role)) then
      raise exception 'Invitation not found';
    end if;
    if public.org_caller_rank(inv.org_id) <= public.org_role_rank(inv.role) then
      raise exception 'Not authorized';
    end if;
    -- The module role that rides along is refreshed with it.
    update public.pending_invites
       set expires_at = now() + interval '30 days', invited_by = auth.uid()
     where id = invite_id
        or (kind = 'module_role' and org_id = inv.org_id and email = inv.email);
  elsif inv.kind = 'module_role' then
    if not public.is_org_admin(inv.org_id) then
      raise exception 'Invitation not found';
    end if;
    update public.pending_invites
       set expires_at = now() + interval '30 days', invited_by = auth.uid()
     where id = invite_id;
  else -- vm_conversation
    if not public.vm_is_conv_admin(inv.target_id)
       or not (inv.invited_by = auth.uid() or public.is_org_admin(inv.org_id)) then
      raise exception 'Invitation not found';
    end if;
    update public.pending_invites
       set expires_at = now() + interval '30 days', invited_by = auth.uid()
     where id = invite_id;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Apply a HELD invite (internal) — 'applied' | 'held' | 'dead'
-- ---------------------------------------------------------------------------
-- Never callable by an API role. Runs as the table owner, so RLS does NOT
-- apply to its writes: the checks below are the whole gate. Every predicate
-- here is about a THIRD party (the inviter, the invitee), so none of them is
-- a caller-relative helper (docs/03 #29) — vm_user_is_module_member takes the
-- user explicitly.
create or replace function public.pending_invite_apply_held(invite_id uuid, invitee uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  inv        public.pending_invites%rowtype;
  v_conv_org uuid;
  v_auth     boolean;
  v_result   text;
  old_claims text := current_setting('request.jwt.claims', true);
  old_sub    text := current_setting('request.jwt.claim.sub', true);
begin
  select * into inv from public.pending_invites where id = invite_id;
  if not found or inv.kind not in ('module_role', 'vm_conversation') then
    return 'held';   -- nothing of ours to decide
  end if;

  -- Defence in depth: the address must be the invitee's own confirmed one.
  if not exists (select 1 from auth.users u
                 where u.id = invitee
                   and u.email_confirmed_at is not null
                   and lower(btrim(u.email)) = inv.email) then
    return 'held';
  end if;

  if inv.kind = 'vm_conversation' then
    -- The conversation's CURRENT org, locked so it cannot be moved between
    -- these checks and the insert (vm_pin_conversation lets a manager change
    -- org_id, and vm_sync_from_conversation stamps the seat from it). An
    -- invitation was issued for one org; if the conversation has left it, or
    -- is gone, the invitation is dead (adversarial review 2026-10-18).
    select c.org_id into v_conv_org
    from public.vm_conversations c where c.id = inv.target_id
    for share;
    if v_conv_org is distinct from inv.org_id then
      return 'dead';
    end if;
  else
    -- A module role applies only through the org invitation it rode on: the
    -- seat that invitation created for THIS person, still the same seat
    -- (same invited_at), now active. Not yet claimed = still held; any other
    -- person, a removed seat or a different later seat = dead.
    if inv.claimed_by is null then
      return 'held';
    end if;
    if inv.claimed_by <> invitee
       or not exists (select 1 from public.org_members m
                      where m.org_id = inv.org_id and m.user_id = invitee
                        and m.invited_at is not distinct from inv.seat_invited_at) then
      return 'dead';
    end if;
  end if;

  -- AUTHORITY AT APPLY: could the inviter make this grant directly, now?
  select
    not exists (select 1 from auth.users u
                where u.id = inv.invited_by
                  and (u.banned_until > now() or u.deleted_at is not null))
    and not public.account_has_left(inv.invited_by)
    and (
      exists (select 1 from public.user_private up
              where up.user_id = inv.invited_by and up.is_superadmin)
      -- an active org owner/admin (vm_can_manage's is_org_admin arm; the only
      -- authority for a module_role invite)
      or exists (select 1 from public.org_members ib
                 where ib.org_id = inv.org_id and ib.user_id = inv.invited_by
                   and ib.status = 'active' and ib.role in ('owner', 'admin'))
      or (inv.kind = 'vm_conversation'
          and exists (select 1 from public.org_members ib
                      where ib.org_id = inv.org_id and ib.user_id = inv.invited_by
                        and ib.status = 'active')
          and (
            -- vm_can_manage's has_module_role(org, 'visual-messaging', 'admin') arm
            exists (select 1 from public.module_roles r
                    where r.org_id = inv.org_id and r.user_id = inv.invited_by
                      and r.module_key = 'visual-messaging' and r.role = 'admin'
                      and r.scope_ref is null)
            -- vm_is_conv_admin's seat arm
            or (public.vm_user_is_module_member(inv.org_id, inv.invited_by)
                and exists (select 1 from public.vm_conversation_members s
                            where s.conversation_id = inv.target_id and s.user_id = inv.invited_by
                              and s.status = 'active' and s.role = 'admin'))
          ))
    )
  into v_auth;
  if not coalesce(v_auth, false) then
    return 'dead';
  end if;

  if inv.kind = 'vm_conversation' then
    -- ANY existing seat uses the invite up — including a ban or a self-block,
    -- so a self-block always beats a pending invite (docs/25 §4.2.4).
    if exists (select 1 from public.vm_conversation_members s
               where s.conversation_id = inv.target_id and s.user_id = invitee) then
      return 'dead';
    end if;
  else
    if exists (select 1 from public.module_roles r
               where r.org_id = inv.org_id and r.user_id = invitee
                 and r.module_key = inv.module_key and r.role = inv.role and r.scope_ref is null) then
      return 'dead';
    end if;
  end if;

  -- PREREQUISITES: not met yet = held, untouched.
  if not exists (select 1 from public.org_members m
                 where m.org_id = inv.org_id and m.user_id = invitee and m.status = 'active') then
    return 'held';
  end if;
  if inv.kind = 'module_role' then
    if not exists (select 1 from public.org_modules om
                   where om.org_id = inv.org_id and om.module_key = inv.module_key and om.enabled) then
      return 'held';
    end if;
  elsif not public.vm_user_is_module_member(inv.org_id, invitee) then
    return 'held';
  end if;

  -- Write on the inviter's behalf with the caller's identity cleared (slice
  -- 1, choice 2): vm_invite_pending then keeps invited_by and status as given,
  -- and module_roles_guard_hierarchy takes its service path. ONE exit below;
  -- the handler restores before re-raising.
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    if inv.kind = 'vm_conversation' then
      insert into public.vm_conversation_members (org_id, conversation_id, user_id, role, status, invited_by)
      values (inv.org_id, inv.target_id, invitee, inv.role, 'pending', inv.invited_by);
    else
      insert into public.module_roles (org_id, user_id, module_key, role, granted_by)
      values (inv.org_id, invitee, inv.module_key, inv.role, inv.invited_by);
    end if;
    v_result := 'applied';
  exception when others then
    perform set_config('request.jwt.claims', coalesce(old_claims, ''), true);
    perform set_config('request.jwt.claim.sub', coalesce(old_sub, ''), true);
    raise;
  end;
  perform set_config('request.jwt.claims', coalesce(old_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(old_sub, ''), true);
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Claim — now also re-evaluates held invites
-- ---------------------------------------------------------------------------
-- Same signature and contract as slice 1. Order: org, then module_role, then
-- vm_conversation — so one run right after the person accepts an org invite
-- grants the module role and then creates the chat seat.
create or replace function public.pending_invites_claim_mine()
returns integer
language plpgsql
volatile
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

-- ---------------------------------------------------------------------------
-- 8. Listing, with what a held invite is waiting for (org admins only)
-- ---------------------------------------------------------------------------
-- Internal. Computed ONLY from the org's own seats and module grants, which an
-- org admin already reads (org_member_profiles gives every seat's address), so
-- it never says whether the address has an account anywhere else. 'org_membership'
-- covers "no account" and "an account not in this org" alike.
create or replace function public.pending_invite_waiting_on(invite_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  with inv as (select * from public.pending_invites where id = invite_id),
  seat as (
    select m.user_id, m.status
    from inv
    join auth.users u on lower(btrim(u.email)) = inv.email and u.deleted_at is null
    join public.org_members m on m.org_id = inv.org_id and m.user_id = u.id
    order by (m.status = 'active') desc
    limit 1
  )
  select case
    when inv.kind = 'org' then null
    when not exists (select 1 from seat) then 'org_membership'
    when (select status from seat) <> 'active' then 'org_acceptance'
    when inv.kind = 'module_role' then
      case when exists (select 1 from public.org_modules om
                        where om.org_id = inv.org_id and om.module_key = inv.module_key and om.enabled)
           then 'ready' else 'module_enabled' end
    when not public.vm_user_is_module_member(inv.org_id, (select user_id from seat)) then 'module_role'
    else 'ready'
  end
  from inv;
$$;

-- What the caller may see, for one org (optionally one target):
--   an org admin: every row, with waiting_on;
--   otherwise a CURRENT admin of the named conversation: only the chat
--   invitations they issued themselves, waiting_on NULL (the app shows a plain
--   "Pending" — a reason would say whether the address is in the org);
--   anyone else: nothing.
create or replace function public.pending_invites_list(check_org_id uuid, check_target_id uuid default null)
returns table (
  id uuid, kind text, target_id uuid, target_title text, email text, role text, module_key text,
  invited_by uuid, created_at timestamptz, expires_at timestamptz, waiting_on text
)
language sql
stable
security definer
set search_path = public
as $$
  with me as (select public.is_org_admin(check_org_id) as org_admin)
  select p.id, p.kind, p.target_id, c.title, p.email, p.role, p.module_key,
         p.invited_by, p.created_at, p.expires_at,
         case when me.org_admin then public.pending_invite_waiting_on(p.id) end
  from public.pending_invites p
  cross join me
  left join public.vm_conversations c on p.kind = 'vm_conversation' and c.id = p.target_id
  where auth.uid() is not null
    and p.org_id = check_org_id
    and (check_target_id is null or p.target_id = check_target_id)
    and (me.org_admin
         or (check_target_id is not null
             and p.kind = 'vm_conversation'
             and p.invited_by = auth.uid()
             and public.vm_is_conv_admin(check_target_id)))
  order by p.created_at desc;
$$;

-- ---------------------------------------------------------------------------
-- 9. Expiry: also drop chat invites whose conversation is gone
-- ---------------------------------------------------------------------------
-- target_id cannot carry a foreign key (it points at different tables per
-- kind), so a deleted conversation's invites are removed here, within the hour.
create or replace function public.pending_invites_prune_expired()
returns integer
language sql
volatile
security definer
set search_path = public
as $$
  with gone as (
    delete from public.pending_invites p
    where p.expires_at <= now()
       or exists (select 1 from public.account_deletions d
                  where d.user_id = p.invited_by and d.state = 'deleted')
       or (p.kind = 'vm_conversation'
           and not exists (select 1 from public.vm_conversations c where c.id = p.target_id))
    returning 1
  )
  select count(*)::integer from gone;
$$;

-- ---------------------------------------------------------------------------
-- 10. ACLs — the full intended ACL for every new or re-created function
-- ---------------------------------------------------------------------------
revoke execute on function public.pending_invite_slot(uuid, text, text, uuid, text)            from public, anon, authenticated, service_role;
revoke execute on function public.pending_invite_issue_org(uuid, text, text, text, text)       from public, anon, authenticated, service_role;
revoke execute on function public.pending_invite_issue_vm(uuid, text)                          from public, anon, authenticated, service_role;
revoke execute on function public.pending_invite_cancel(uuid)                                  from public, anon, authenticated, service_role;
revoke execute on function public.pending_invite_resend(uuid)                                  from public, anon, authenticated, service_role;
revoke execute on function public.pending_invite_apply_held(uuid, uuid)                        from public, anon, authenticated, service_role;
revoke execute on function public.pending_invites_claim_mine()                                 from public, anon, authenticated, service_role;
revoke execute on function public.pending_invite_waiting_on(uuid)                              from public, anon, authenticated, service_role;
revoke execute on function public.pending_invites_list(uuid, uuid)                             from public, anon, authenticated, service_role;
revoke execute on function public.pending_invites_prune_expired()                              from public, anon, authenticated, service_role;

grant execute on function public.pending_invite_issue_org(uuid, text, text, text, text) to authenticated;
grant execute on function public.pending_invite_issue_vm(uuid, text)                    to authenticated;
grant execute on function public.pending_invite_cancel(uuid)                            to authenticated;
grant execute on function public.pending_invite_resend(uuid)                            to authenticated;
grant execute on function public.pending_invites_claim_mine()                           to authenticated;
grant execute on function public.pending_invites_list(uuid, uuid)                       to authenticated;

-- ---------------------------------------------------------------------------
-- 11. Apply-time assertions (must hold on an EMPTY database)
-- ---------------------------------------------------------------------------
do $$
declare
  internal_fn text;
begin
  foreach internal_fn in array array[
    'public.pending_invite_slot(uuid, text, text, uuid, text)',
    'public.pending_invite_apply_held(uuid, uuid)',
    'public.pending_invite_apply(uuid, uuid)',
    'public.pending_invite_waiting_on(uuid)',
    'public.pending_invites_prune_expired()'
  ] loop
    if has_function_privilege('authenticated', internal_fn, 'execute')
       or has_function_privilege('anon', internal_fn, 'execute')
       or has_function_privilege('service_role', internal_fn, 'execute') then
      raise exception 'assert: an API role can call internal function %', internal_fn;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.pending_invite_issue_vm(uuid, text)', 'execute')
     or has_function_privilege('anon', 'public.pending_invites_list(uuid, uuid)', 'execute')
     or has_function_privilege('anon', 'public.pending_invite_issue_org(uuid, text, text, text, text)', 'execute') then
    raise exception 'assert: anon can reach a pending-invites function';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'pending_invite_issue_org' and p.pronargs = 3) then
    raise exception 'assert: the old three-argument pending_invite_issue_org still exists';
  end if;
  if has_table_privilege('authenticated', 'public.pending_invites', 'insert')
     or has_table_privilege('authenticated', 'public.pending_invites', 'update')
     or has_table_privilege('authenticated', 'public.pending_invites', 'delete')
     or has_table_privilege('anon', 'public.pending_invites', 'select') then
    raise exception 'assert: pending_invites table ACL widened';
  end if;
  if (select count(*) from pg_policy where polrelid = 'public.pending_invites'::regclass) <> 1 then
    raise exception 'assert: pending_invites must still have exactly one policy';
  end if;
end;
$$;
