-- =============================================================================
-- visual-messaging: per-conversation 'moderator' seat -> 'conversation_moderator'
-- =============================================================================
-- FOUNDER DECISION, docs/24 §4 item 4 (2026-09-25): RENAME, not just document.
-- The word `moderator` meant two unrelated things in this module:
--   * module_roles.role = 'moderator'  — ORG-WIDE content moderation, rank 1
--     (20260925030000), checked by vm_can_moderate_org via has_module_role.
--   * vm_conversation_members.role = 'moderator' — a seat in ONE conversation.
-- Same word, two tiers, two tables. The seat value becomes
-- `conversation_moderator`; the module role is untouched.
--
-- WHAT CHANGES:
--   1. the role CHECK on vm_conversation_members (value set renamed)
--   2. any existing 'moderator' seats rewritten (0 rows on prod, local and CI
--      as of 2026-10-07 — done anyway, so this cannot fail on a database that
--      somehow has one)
--   3. vm_can_post and vm_can_moderate — the only two live functions that name
--      the seat value — restated from 20260904010000 with the new word and
--      NOTHING else changed.
-- No policy names the seat value directly (verified by grep across
-- supabase/migrations: the only non-comment hits were the CHECK and these two
-- function bodies).
--
-- WHY THE PIN TRIGGER IS DISABLED FOR STEP 2: vm_members_a_pin
-- (vm_pin_member) does `new.role := old.role` unless the caller manages the
-- org — and a migration runs with no JWT, so it would SILENTLY revert the
-- rename and the new CHECK would then fail. Disabling it for one statement
-- inside this transaction is the explicit version of what the trigger's own
-- manage escape does for an org admin. It is re-enabled before the
-- transaction ends, and the assertion block checks that it is.
-- =============================================================================

alter table public.vm_conversation_members
  drop constraint vm_conversation_members_role_check;

alter table public.vm_conversation_members disable trigger vm_members_a_pin;
update public.vm_conversation_members
  set role = 'conversation_moderator'
  where role = 'moderator';
alter table public.vm_conversation_members enable trigger vm_members_a_pin;

alter table public.vm_conversation_members
  add constraint vm_conversation_members_role_check
  check (role in ('participant', 'viewer', 'conversation_moderator', 'admin'));

-- ---------------------------------------------------------------------------
-- vm_can_post — may DRAW (active seat, not a read-only viewer).
-- Restated from 20260904010000 §2; only the seat word changed.
-- ---------------------------------------------------------------------------
create or replace function public.vm_can_post(check_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.vm_conversation_members m
    where m.conversation_id = check_conversation_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role in ('participant', 'conversation_moderator', 'admin')
      and public.is_org_member(m.org_id)
  );
$$;

-- ---------------------------------------------------------------------------
-- vm_can_moderate — per-conversation moderator/admin seat, or org tier.
-- Restated from 20260904010000 §3; only the seat word changed.
-- ---------------------------------------------------------------------------
create or replace function public.vm_can_moderate(check_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.vm_conversation_members m
    where m.conversation_id = check_conversation_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role in ('conversation_moderator', 'admin')
      and public.is_org_member(m.org_id)
  )
  or exists (
    select 1 from public.vm_conversations c
    where c.id = check_conversation_id
      and public.vm_can_moderate_org(c.org_id)
  );
$$;

-- `create or replace` keeps the existing ACL, so nothing to restate — the
-- assertions below check it was not widened.

-- -----------------------------------------------------------------------------
-- Apply-time assertions — catalog only, so they pass on an EMPTY database.
-- -----------------------------------------------------------------------------
do $$
declare
  chk text;
  fn text;
begin
  select pg_get_constraintdef(oid) into chk
  from pg_constraint
  where conrelid = 'public.vm_conversation_members'::regclass
    and conname = 'vm_conversation_members_role_check';
  if chk is null or chk not like '%conversation_moderator%' or chk like '%''moderator''%' then
    raise exception 'role check not renamed: %', chk;
  end if;

  if exists (select 1 from public.vm_conversation_members where role = 'moderator') then
    raise exception 'a moderator seat survived the rename';
  end if;

  if exists (
    select 1 from pg_trigger
    where tgrelid = 'public.vm_conversation_members'::regclass
      and tgname = 'vm_members_a_pin' and tgenabled = 'D'
  ) then
    raise exception 'vm_members_a_pin was left disabled';
  end if;

  foreach fn in array array['vm_can_post', 'vm_can_moderate'] loop
    -- coalesce: a MISSING function must fail, not slip through as NULL.
    select coalesce(pg_get_functiondef(p.oid), '') into chk
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = fn;
    if coalesce(chk, '') not like '%''conversation_moderator''%' then
      raise exception '% does not name conversation_moderator', fn;
    end if;
    -- the quoted old word must be GONE, not merely joined by the new one
    if chk like '%''moderator''%' then
      raise exception '% still names the old seat word', fn;
    end if;
    if has_function_privilege('anon', format('public.%I(uuid)', fn), 'execute') then
      raise exception 'anon can execute %', fn;
    end if;
  end loop;
end $$;
