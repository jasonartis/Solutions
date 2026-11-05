-- FEEDBACK AND TICKETS, v1 (docs/27; founder decisions 2026-10-28, built 2026-11-05).
--
-- One platform-wide ticket tool: a signed-in person sends a bug report,
-- suggestion or question from any page, with the page context attached, and
-- the conversation continues in the product. v1 is BETWEEN THE USER AND THE
-- PLATFORM OWNER ONLY (docs/27 decision 4). No email is sent.
--
-- WHO READS WHAT (RLS is the point — docs/00, tenancy isolation is existential):
--   * a person reads their OWN tickets, and only the non-internal messages on them;
--   * the superadmin reads every ticket and every message, internal notes included;
--   * NOBODY ELSE — no org admin, no module role. org_id on a ticket is CONTEXT
--     (where they were), never authority: being an org's admin gives no read
--     path. Routing to an org admin is a later, explicit, per-category opt-in
--     (docs/27 decision 5) and must never be a default, because a person may be
--     reporting that very admin.
--
-- WRITES go only through four SECURITY DEFINER functions; the tables grant
-- SELECT and nothing else to the API roles (revoke-before-grant, docs/03 #27).
-- So every author, status and timestamp column is set by the server and there
-- is no client-writable column to pin:
--   feedback_open(kind, title, body, org_id, module_key, context) -> ticket id
--   feedback_reply(ticket_id, body, internal)   owner (internal=false) or superadmin
--   feedback_set_status(ticket_id, status)      superadmin; the owner may only close
--   feedback_mark_read(ticket_id)               stamps the caller's read time
-- Every refusal on a ticket the caller cannot read says the same thing as one
-- that does not exist ("Ticket not found"), so ids cannot be probed.
--
-- WHAT IS NOT STORED: no copy of the person's activity trail. docs/27 lists the
-- trail as context; the superadmin console READS it live from activity_events
-- (already superadmin-only, already pruned at 90 days, already handled by
-- account deletion). Storing a copy here would create a second, unpruned,
-- deletion-blind record of what someone did.
--
-- ACCOUNT DELETION (docs/21, decided here per docs/27): a ticket and its
-- messages are the person's own words — a human act — so the silhouette rule
-- keeps them, as for every other human act; the author shows as "Former member"
-- through profiles. auth.users is never deleted by the product, so the FKs'
-- ON DELETE CASCADE only fires for a raw superadmin delete (tests).
-- `context` holds page/browser details, not identity, and is kept with the
-- ticket so a report stays reproducible.
--
-- ABUSE (docs/27 "volume"): at most 10 new tickets and 60 messages per person
-- per rolling 24 hours (the superadmin is exempt); sizes are capped by CHECKs.
-- No attachments in v1 (screenshots raise privacy and storage questions).
--
-- Times inside the functions are clock_timestamp(), not now(): now() is fixed
-- for a whole transaction, so a reply and a read (or two messages) in one
-- transaction would tie, and unread/ordering would be undefined.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.feedback_tickets (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users (id) on delete cascade,
  -- Where the person was when they wrote it (context, never authority).
  org_id uuid references public.orgs (id) on delete set null,
  module_key text check (module_key is null or module_key ~ '^[a-z0-9-]{1,40}$'),
  kind text not null check (kind in ('bug', 'suggestion', 'question', 'other')),
  status text not null default 'new'
    check (status in ('new', 'open', 'waiting_on_user', 'resolved', 'closed')),
  title text not null check (char_length(title) between 1 and 200),
  context jsonb not null default '{}'::jsonb
    check (jsonb_typeof(context) = 'object' and octet_length(context::text) <= 8000),
  -- null in v1 = the platform owner (docs/27). Nothing writes it yet.
  routed_to text,
  last_user_message_at timestamptz,
  last_staff_message_at timestamptz,   -- non-internal staff replies only
  user_read_at timestamptz,
  staff_read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index feedback_tickets_created_by_idx on public.feedback_tickets (created_by, created_at desc);
create index feedback_tickets_status_idx on public.feedback_tickets (status, updated_at desc);

create table public.feedback_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.feedback_tickets (id) on delete cascade,
  author_id uuid not null references auth.users (id) on delete cascade,
  author_kind text not null check (author_kind in ('user', 'staff')),
  body text not null check (char_length(body) between 1 and 5000),
  -- A staff-only note. Only staff can write one; the owner never reads one.
  internal boolean not null default false,
  created_at timestamptz not null default now(),
  check (not internal or author_kind = 'staff')
);
create index feedback_messages_ticket_idx on public.feedback_messages (ticket_id, created_at);
create index feedback_messages_author_idx on public.feedback_messages (author_id, created_at desc);

revoke all privileges on public.feedback_tickets from public, anon, authenticated, service_role;
revoke all privileges on public.feedback_messages from public, anon, authenticated, service_role;
grant select on public.feedback_tickets to authenticated;
grant select on public.feedback_messages to authenticated;

alter table public.feedback_tickets enable row level security;
alter table public.feedback_messages enable row level security;

create policy feedback_tickets_select_own_or_superadmin on public.feedback_tickets
  for select to authenticated
  using (created_by = auth.uid() or public.is_superadmin());

-- The ticket subquery is itself filtered by the ticket policy above, so an
-- owner reaches only their own tickets' messages.
create policy feedback_messages_select_own_or_superadmin on public.feedback_messages
  for select to authenticated
  using (
    public.is_superadmin()
    or (not internal and exists (
      select 1 from public.feedback_tickets t
      where t.id = ticket_id and t.created_by = auth.uid()
    ))
  );

-- ---------------------------------------------------------------------------
-- 2. feedback_open
-- ---------------------------------------------------------------------------
create or replace function public.feedback_open(
  p_kind text, p_title text, p_body text, p_org_id uuid, p_module_key text, p_context jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  new_id uuid;
begin
  if me is null then
    raise exception 'Not signed in';
  end if;
  if not public.is_superadmin() and (
    select count(*) from public.feedback_tickets
    where created_by = me and created_at > clock_timestamp() - interval '24 hours'
  ) >= 10 then
    raise exception 'Too many feedback tickets today; please add to an existing one';
  end if;
  -- An org on a ticket is only ever one the person belongs to (the page they
  -- were on). Context, never authority — but it must not be forgeable to point
  -- at an org they have nothing to do with.
  if p_org_id is not null and not public.is_org_member(p_org_id) then
    raise exception 'Unknown organization';
  end if;

  insert into public.feedback_tickets (created_by, org_id, module_key, kind, title, context, last_user_message_at, user_read_at)
  values (me, p_org_id, nullif(p_module_key, ''), p_kind, btrim(coalesce(p_title, '')),
          coalesce(p_context, '{}'::jsonb), clock_timestamp(), clock_timestamp())
  returning id into new_id;

  insert into public.feedback_messages (ticket_id, author_id, author_kind, body, internal, created_at)
  values (new_id, me, 'user', btrim(coalesce(p_body, '')), false, clock_timestamp());

  return new_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. feedback_reply
-- ---------------------------------------------------------------------------
create or replace function public.feedback_reply(p_ticket_id uuid, p_body text, p_internal boolean)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  staff boolean := public.is_superadmin();
  t_id uuid;
  t_owner uuid;
  msg_id uuid;
  kind text;
begin
  if me is null then
    raise exception 'Not signed in';
  end if;
  select id, created_by into t_id, t_owner from public.feedback_tickets where id = p_ticket_id for update;
  if t_id is null or (t_owner <> me and not staff) then
    raise exception 'Ticket not found';
  end if;
  if coalesce(p_internal, false) and not staff then
    raise exception 'Ticket not found';
  end if;
  if not staff and (
    select count(*) from public.feedback_messages
    where author_id = me and created_at > clock_timestamp() - interval '24 hours'
  ) >= 60 then
    raise exception 'Too many messages today';
  end if;

  -- The superadmin replying on someone else's ticket is staff. On their OWN
  -- ticket (testing the tool) they write as the user unless the note is internal.
  kind := case when staff and (t_owner <> me or coalesce(p_internal, false)) then 'staff' else 'user' end;

  insert into public.feedback_messages (ticket_id, author_id, author_kind, body, internal, created_at)
  values (p_ticket_id, me, kind, btrim(coalesce(p_body, '')), coalesce(p_internal, false), clock_timestamp())
  returning id into msg_id;

  if kind = 'user' then
    -- The person wrote back: the ball is with the platform again.
    update public.feedback_tickets
    set last_user_message_at = clock_timestamp(), user_read_at = clock_timestamp(), updated_at = clock_timestamp(),
        status = case when status in ('waiting_on_user', 'resolved', 'closed') then 'open' else status end
    where id = p_ticket_id;
  elsif not coalesce(p_internal, false) then
    update public.feedback_tickets
    set last_staff_message_at = clock_timestamp(), staff_read_at = clock_timestamp(), updated_at = clock_timestamp(),
        status = case when status in ('new', 'open') then 'waiting_on_user' else status end
    where id = p_ticket_id;
  else
    update public.feedback_tickets set staff_read_at = clock_timestamp(), updated_at = clock_timestamp() where id = p_ticket_id;
  end if;

  return msg_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. feedback_set_status
-- ---------------------------------------------------------------------------
create or replace function public.feedback_set_status(p_ticket_id uuid, p_status text)
returns void
language plpgsql
volatile
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
  -- The person may close their own ticket ("never mind"); every other move is staff's.
  if not staff and p_status is distinct from 'closed' then
    raise exception 'Only the platform team can change this status';
  end if;
  update public.feedback_tickets set status = p_status, updated_at = clock_timestamp() where id = p_ticket_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. feedback_mark_read
-- ---------------------------------------------------------------------------
create or replace function public.feedback_mark_read(p_ticket_id uuid)
returns void
language plpgsql
volatile
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
  update public.feedback_tickets
  set user_read_at = case when owner = me then clock_timestamp() else user_read_at end,
      staff_read_at = case when staff then clock_timestamp() else staff_read_at end
  where id = p_ticket_id;
end;
$$;

revoke execute on function public.feedback_open(text, text, text, uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke execute on function public.feedback_reply(uuid, text, boolean)               from public, anon, authenticated, service_role;
revoke execute on function public.feedback_set_status(uuid, text)                   from public, anon, authenticated, service_role;
revoke execute on function public.feedback_mark_read(uuid)                          from public, anon, authenticated, service_role;
grant execute on function public.feedback_open(text, text, text, uuid, text, jsonb) to authenticated;
grant execute on function public.feedback_reply(uuid, text, boolean)               to authenticated;
grant execute on function public.feedback_set_status(uuid, text)                   to authenticated;
grant execute on function public.feedback_mark_read(uuid)                          to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Catalog-only assertions (safe on an empty database).
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  f text;
  fn record;
begin
  foreach t in array array['feedback_tickets', 'feedback_messages'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception '% must have RLS enabled', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select') then
      raise exception 'anon can read %', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'insert')
       or has_table_privilege('authenticated', 'public.' || t, 'update')
       or has_table_privilege('authenticated', 'public.' || t, 'delete')
       or has_table_privilege('authenticated', 'public.' || t, 'truncate') then
      raise exception 'authenticated can write % directly', t;
    end if;
    if (select count(*) from pg_policies where schemaname = 'public' and tablename = t) <> 1 then
      raise exception '% must carry exactly one policy (SELECT)', t;
    end if;
  end loop;

  foreach f in array array[
    'feedback_open(text, text, text, uuid, text, jsonb)', 'feedback_reply(uuid, text, boolean)',
    'feedback_set_status(uuid, text)', 'feedback_mark_read(uuid)'
  ] loop
    select p.prosecdef, p.proconfig, p.proacl::text as acl into fn
    from pg_proc p where p.oid = ('public.' || f)::regprocedure;
    if not fn.prosecdef then raise exception '% must be SECURITY DEFINER', f; end if;
    if not ('search_path=public' = any (fn.proconfig)) then raise exception '% lost its pinned search_path', f; end if;
    if fn.acl ~ '(anon|service_role)=' or fn.acl ~ '(^|[{,])=X' then
      raise exception '% grants EXECUTE beyond authenticated: %', f, fn.acl;
    end if;
    if fn.acl !~ 'authenticated=X' then raise exception '% is not callable by authenticated', f; end if;
  end loop;
end $$;
