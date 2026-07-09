-- Module 4: Visual Messaging (key: 'visual-messaging', prefix vm_).
-- Spec: docs/modules/module-4-visual-messaging.md
--
-- DRAFT for review — NOT applied, NOT wired into supabase/migrations/. Becomes
-- supabase/migrations/<ts>_visual_messaging.sql once a human security-reviews
-- it and folds in a modules/visual-messaging/schema-fixes.sql (the established
-- rhythm from modules 1/2/5/6 — see 20260709050000_speed_dating.sql for the
-- biggest exemplar with its fixes folded in). Patterns copied EXACTLY from
-- modules/sample/schema-draft.sql (the living template) + the module 1/2/5/6
-- migrations:
--   * explicit grants BEFORE RLS (docs/03 #1 — CLI migrations do NOT inherit
--     Supabase's API-role grants; non-negotiable).
--   * RLS enabled on EVERY table; every table has org_id -> orgs cascade.
--   * staff checks delegate to public.is_org_admin() (docs/03 #9) plus
--     has_module_role(); the superadmin/org-owner tail is NEVER restated here.
--   * scope-sync BEFORE triggers derive org_id / conversation scope from the
--     FK chain server-side (docs/03 #10) — a client can never misfile a row
--     cross-org/cross-conversation with a bogus id.
--   * column-pin / lifecycle rules RLS can't express are flagged as precise
--     INTEGRATION NOTEs (docs/03 #11/#12) — the reviewer builds those in
--     schema-fixes.sql; trigger names must sort ("..._a_pin") BEFORE the
--     "..._scope" trigger (alphabetical same-event firing).
--   * a table's OWN policies use DIRECT column checks, never self-referential
--     definer lookups (docs/03 #15 — the INSERT ... RETURNING snapshot bug
--     found live in module 6).
--   * updated_at via the shared public.set_updated_at(); org config in
--     org_modules.settings (module_key 'visual-messaging'), no ad-hoc config
--     table.
--
-- Relies on platform objects that already exist:
--   public.is_superadmin(), public.is_org_member(), public.set_updated_at()  (core migration)
--   public.has_module_role(org, module_key, role)                            (module 3 migration)
--   public.is_org_admin(org)                                                 (20260709040000_platform_extraction)
--
-- Module key used throughout: 'visual-messaging'.
--
-- TENANCY DECISION (founder-pending, recommended): an ad-hoc person-to-person
-- group (the WhatsApp-style list in the spec's "Membership" section) is an
-- AUTO-CREATED LIGHTWEIGHT ORG — the app creates a minimal org row + org
-- memberships when a user starts a personal group. The schema therefore stays
-- PURELY org-scoped: no parallel "group" container, no second tenancy code
-- path, RLS identical for a family group and an engineering firm. If the
-- founder rejects this, a vm_groups container would need its own membership +
-- scoping layer — record the decision in the module spec either way.
--
-- ROLE MODEL (two levels — module_roles is ORG-level, but a conversation needs
-- PER-CONVERSATION membership, exactly like cls_class_members):
--   org-level module_roles ('visual-messaging'):
--     'admin'     -> vm_can_manage tier (org-wide module admin: sees/does all)
--     'moderator' -> vm_can_moderate_org tier (org-wide moderation: every
--                    conversation's flags/tombstones, without membership)
--     'member'    -> may CREATE conversations in the org
--   per-conversation roles (vm_conversation_members.role):
--     'participant' (draw/reply), 'viewer' (read-only — also what a deep-link
--     visitor gets after joining), 'moderator' (handles flags in THIS
--     conversation), 'admin' (membership + settings + freeze + everything).
--
-- ROOT IMAGE DECISION: the conversation's root picture IS A LAYER —
-- parent_layer_id NULL, path '1', content jsonb holding a single image object
-- that references the uploaded file. One rendering model (a view of layer L =
-- L composited on its ancestor chain, root included), one moderation model
-- (the root can be tombstoned/frozen like any layer), no special-case root
-- column on the conversation. Enforced: at most one root per conversation
-- (partial unique index below).
--
-- BRANCH-FREEZE DECISION: `frozen` is stored ON THE LAYER WHERE THE FREEZE WAS
-- APPLIED; effective lock = conversation.frozen OR any self-or-ancestor layer
-- frozen, computed via the materialized path (prefix match — see
-- vm_layer_locked()). Chosen over materializing a frozen flag onto every
-- descendant because: (a) freeze/unfreeze is ONE atomic row flip, no subtree
-- fan-out write that can partially fail or race with concurrent replies;
-- (b) the ancestor check is a cheap indexed prefix scan (frozen layers per
-- conversation are rare — partial index below); (c) unfreeze cannot leave
-- stale frozen descendants behind.
--
-- TOMBSTONE MODEL (spec: "blank content, keep the slot so descendants still
-- render"): tombstoned/tombstoned_by/tombstoned_at columns on the layer. The
-- row STAYS readable by members (the slot must render); the offending CONTENT
-- is blanked at tombstone time by a definer RPC (RLS cannot hide one column) —
-- see INTEGRATION NOTE T4. Subtree delete for severe cases = conversation-admin
-- DELETE of the branch root; parent_layer_id cascade removes the subtree.
--
-- Vector layer content (freehand strokes, styled text, emojis, image stamps)
-- is Zod-validated jsonb at the app layer (docs/03 #7) — never a CHECK here.
-- Image-stamp guards (max size relative to canvas, default transparency) are
-- app-layer Zod rules with defaults in org_modules.settings and per-conversation
-- overrides in vm_conversations.settings.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- A visual conversation. ROOT table: org_id is client-supplied and the RLS
-- write gate ties it to an org the caller may act in (same as smp_projects /
-- sd_events). settings jsonb (Zod-validated at the app layer) carries the
-- per-conversation knobs the spec names: who may invite ('admins'|'members'),
-- whether deep links work for non-members ('members_only'|'anyone_view'),
-- content rules, image-stamp overrides.
create table public.vm_conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  title text not null,
  -- Whole-conversation freeze (spec: freeze a conversation while others stay
  -- live). Branch freeze lives on vm_layers.frozen — see header decision.
  frozen boolean not null default false,
  settings jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The layer tree. Root layer: parent_layer_id NULL, path '1', content = the
-- root image object. Every reply is a child of the layer it was drawn on.
--   path        = materialized path of sibling ordinals, e.g. '1.3.2' —
--                 the spec's address + deep-link target. Assigned server-side
--                 at integration (INTEGRATION NOTE T1 — atomic ordinal).
--   child_count = number of direct children. Serves BOTH the atomic ordinal
--                 assignment (T1) and the delete-own-only-while-childless /
--                 immutable-once-replied-on rules as a DIRECT column check
--                 (docs/03 #15 — a policy on vm_layers must not look up
--                 vm_layers). Maintained by trigger at integration (T2).
--   content     = vector objects jsonb (strokes/text/emoji/image stamps),
--                 Zod-validated at the app layer. Image stamps reference files
--                 in the vm-images bucket (INTEGRATION NOTE T9).
--   frozen      = branch freeze applied AT this layer (locks its subtree).
--   tombstoned  = moderation blank: slot kept, content blanked by RPC (T4).
-- Layers are immutable once sent except the narrow carve-outs below; drafts
-- never reach the server (spec: a layer is local until sent).
create table public.vm_layers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  conversation_id uuid not null references public.vm_conversations (id) on delete cascade,
  parent_layer_id uuid references public.vm_layers (id) on delete cascade,
  path text not null check (path ~ '^[0-9]+(\.[0-9]+)*$'),
  child_count integer not null default 0 check (child_count >= 0),
  author_id uuid not null references auth.users (id) on delete cascade,
  content jsonb not null default '{}'::jsonb,
  frozen boolean not null default false,
  tombstoned boolean not null default false,
  tombstoned_by uuid references auth.users (id) on delete set null,
  tombstoned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (parent_layer_id is null or parent_layer_id <> id)
);

-- Per-conversation membership (module_roles is org-level; a conversation needs
-- its own roster — the cls_class_members pattern). status 'banned' keeps the
-- row so a removed-for-cause user cannot re-join via invite/deep-link (plain
-- removal = row delete). last_seen_at anchors the spec's "what's new since
-- last visit" grid indicators.
create table public.vm_conversation_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  conversation_id uuid not null references public.vm_conversations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'participant'
    check (role in ('participant', 'viewer', 'moderator', 'admin')),
  status text not null default 'active' check (status in ('active', 'banned')),
  invited_by uuid references auth.users (id) on delete set null,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (conversation_id, user_id)
);

-- Lightweight reactions (spec: heart/laugh on a layer without creating a
-- content layer). Vocabulary via CHECK — extend the CHECK in a later additive
-- migration when new kinds are decided (forward-only, additive-first).
-- Create/delete only: no updated_at (changing a reaction = delete + insert).
create table public.vm_reactions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  conversation_id uuid not null references public.vm_conversations (id) on delete cascade,
  layer_id uuid not null references public.vm_layers (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('heart', 'laugh')),
  created_at timestamptz not null default now(),
  unique (layer_id, user_id, kind)
);

-- Moderation queue (spec: flagged layers reviewed composited-on-ancestors,
-- one-tap tombstone/dismiss/ban). The reporter sees their own flags; the
-- FLAGGED AUTHOR never sees who reported them (no read path).
create table public.vm_flags (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  conversation_id uuid not null references public.vm_conversations (id) on delete cascade,
  layer_id uuid not null references public.vm_layers (id) on delete cascade,
  reporter_user_id uuid not null references auth.users (id) on delete cascade,
  reason text not null,
  detail text,
  state text not null default 'open' check (state in ('open', 'actioned', 'dismissed')),
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Append-only audit of moderation actions (spec: "audit log of all
-- moderation"). conversation_id/layer_id are NULLABLE with ON DELETE SET NULL
-- so the audit trail SURVIVES deletion of what it describes (an audit row that
-- cascades away with the offending conversation is no audit at all — see
-- ambiguity note in the final report). detail jsonb carries action context —
-- including the ORIGINAL content of a tombstoned layer (T4), which is why read
-- access is moderator-tier only. No update/delete grants for users: append-only
-- is enforced at the GRANT level, not just RLS.
create table public.vm_moderation_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  conversation_id uuid references public.vm_conversations (id) on delete set null,
  layer_id uuid references public.vm_layers (id) on delete set null,
  actor_user_id uuid references auth.users (id) on delete set null,
  action text not null check (action in (
    'tombstone', 'restore',
    'freeze_conversation', 'unfreeze_conversation',
    'freeze_branch', 'unfreeze_branch',
    'remove_member', 'ban_member', 'unban_member',
    'delete_layer', 'delete_conversation'
  )),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes (FK lookups + the query shapes the views need)
-- ---------------------------------------------------------------------------

create index vm_conversations_org_idx on public.vm_conversations (org_id);

-- Uniqueness of the address AND the subtree scan in one index: text_pattern_ops
-- supports both equality and the left-anchored `path like '1.3.%'` pattern the
-- branch/grid queries use (works regardless of DB collation).
create unique index vm_layers_conv_path_key
  on public.vm_layers (conversation_id, path text_pattern_ops);
-- Exactly one root layer per conversation.
create unique index vm_layers_one_root
  on public.vm_layers (conversation_id) where parent_layer_id is null;
create index vm_layers_parent_idx
  on public.vm_layers (parent_layer_id) where parent_layer_id is not null;
create index vm_layers_author_idx on public.vm_layers (author_id);
-- "What's new since last visit" scan.
create index vm_layers_conv_created_idx on public.vm_layers (conversation_id, created_at);
-- vm_layer_locked(): frozen layers per conversation are rare — partial index.
create index vm_layers_frozen_idx on public.vm_layers (conversation_id) where frozen;

create index vm_members_user_idx on public.vm_conversation_members (user_id);
-- (conversation_id lookups covered by the unique (conversation_id, user_id))

create index vm_reactions_layer_idx on public.vm_reactions (layer_id);
create index vm_reactions_conv_idx on public.vm_reactions (conversation_id);

-- Moderation queue scan: open flags per conversation.
create index vm_flags_conv_state_idx on public.vm_flags (conversation_id, state);
create index vm_flags_layer_idx on public.vm_flags (layer_id);

create index vm_modlog_conv_idx on public.vm_moderation_log (conversation_id, created_at);
create index vm_modlog_org_idx on public.vm_moderation_log (org_id, created_at);

-- ---------------------------------------------------------------------------
-- updated_at triggers (shared fn, never hand-rolled). Excluded: vm_reactions
-- (create/delete only) and vm_moderation_log (append-only) — neither has the
-- column.
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'vm_conversations', 'vm_layers', 'vm_conversation_members', 'vm_flags']
  loop
    execute format(
      'create trigger %I_updated_at before update on public.%I
         for each row execute function public.set_updated_at();',
      t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Grants FIRST (docs/03 #1: CLI migrations do NOT inherit API-role grants).
-- vm_moderation_log deliberately gets NO update/delete for authenticated —
-- append-only enforced at the grant level; service_role keeps full access
-- (worker cleanup/exports; it must filter by org_id explicitly, docs/01).
-- ---------------------------------------------------------------------------

grant select, insert, update, delete
  on public.vm_conversations, public.vm_layers, public.vm_conversation_members,
     public.vm_reactions, public.vm_flags
  to authenticated, service_role;

grant select, insert on public.vm_moderation_log to authenticated;
grant select, insert, update, delete on public.vm_moderation_log to service_role;

alter table public.vm_conversations        enable row level security;
alter table public.vm_layers               enable row level security;
alter table public.vm_conversation_members enable row level security;
alter table public.vm_reactions            enable row level security;
alter table public.vm_flags                enable row level security;
alter table public.vm_moderation_log       enable row level security;

-- ---------------------------------------------------------------------------
-- Role / ownership helpers (security definer: they read tables the caller may
-- not, and break RLS recursion — same technique as cls_/sd_/smp_ helpers).
-- docs/03 #9: the org-admin tail lives ONLY in is_org_admin().
-- ---------------------------------------------------------------------------

-- Manage tier: org owner/admin/superadmin (via is_org_admin) or org-level
-- module 'admin'. Sees and does everything in the module for that org.
create function public.vm_can_manage(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_admin(check_org_id)
      or public.has_module_role(check_org_id, 'visual-messaging', 'admin');
$$;

-- Org-wide moderation tier: manage plus org-level module 'moderator' —
-- moderates EVERY conversation in the org without needing a membership row.
create function public.vm_can_moderate_org(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.vm_can_manage(check_org_id)
      or public.has_module_role(check_org_id, 'visual-messaging', 'moderator');
$$;

-- May CREATE conversations in the org (org-level module 'member' or above).
create function public.vm_is_module_member(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_module_role(check_org_id, 'visual-messaging', 'member')
      or public.vm_can_moderate_org(check_org_id);
$$;

-- The caller belongs to this conversation (any active seat, viewer included)
-- or holds org-wide moderation. Gates ALL conversation-content reads.
create function public.vm_is_conv_member(check_conversation_id uuid)
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
  )
  or exists (
    select 1 from public.vm_conversations c
    where c.id = check_conversation_id
      and public.vm_can_moderate_org(c.org_id)
  );
$$;

-- The caller may DRAW in this conversation: an active seat that is not a
-- read-only viewer. Deliberately membership-row-only — org staff act through
-- the blanket manage policies, not by ghost-posting into rosters they never
-- joined.
create function public.vm_can_post(check_conversation_id uuid)
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
      and m.role in ('participant', 'moderator', 'admin')
  );
$$;

-- The caller moderates this conversation: per-conversation moderator/admin
-- seat, or org-wide moderation tier.
create function public.vm_can_moderate(check_conversation_id uuid)
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
      and m.role in ('moderator', 'admin')
  )
  or exists (
    select 1 from public.vm_conversations c
    where c.id = check_conversation_id
      and public.vm_can_moderate_org(c.org_id)
  );
$$;

-- The caller administers this conversation: per-conversation admin seat, or
-- the org manage tier (membership + settings + freeze + subtree delete).
create function public.vm_is_conv_admin(check_conversation_id uuid)
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
      and m.role = 'admin'
  )
  or exists (
    select 1 from public.vm_conversations c
    where c.id = check_conversation_id
      and public.vm_can_manage(c.org_id)
  );
$$;

-- The caller created this conversation (the membership-bootstrap check: lets
-- the creator insert their own admin seat — a lookup into ANOTHER table, so
-- docs/03 #15 is satisfied for policies on vm_conversation_members).
create function public.vm_created_conversation(check_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.vm_conversations c
    where c.id = check_conversation_id
      and c.created_by = auth.uid()
  );
$$;

-- Effective lock on a layer: the conversation is frozen, OR any self-or-
-- ancestor layer carries a branch freeze (materialized-path prefix match —
-- '.' is not a LIKE wildcard, and the path CHECK admits only digits and dots,
-- so no escaping is needed). Used by the reply guard (T1) and the UI; read
-- logic only, safe in the draft.
create function public.vm_layer_locked(check_layer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.vm_layers l
    join public.vm_conversations c on c.id = l.conversation_id
    where l.id = check_layer_id and c.frozen
  )
  or exists (
    select 1
    from public.vm_layers l
    join public.vm_layers a
      on a.conversation_id = l.conversation_id
     and a.frozen
     and (a.path = l.path or l.path like a.path || '.%')
    where l.id = check_layer_id
  );
$$;

-- ---------------------------------------------------------------------------
-- Scope-sync BEFORE triggers (docs/03 #10) — children derive org_id (and
-- conversation scope) from the FK chain server-side. Root table
-- (vm_conversations) has no parent: its RLS write gate is the guard.
-- Postgres evaluates RLS WITH CHECK AFTER BEFORE triggers, so the derived
-- org_id is what the policies see.
-- ---------------------------------------------------------------------------

-- Tables carrying conversation_id directly whose only derivable scope is
-- org_id: vm_conversation_members.
create function public.vm_sync_from_conversation()
returns trigger
language plpgsql
as $$
begin
  select c.org_id into new.org_id
  from public.vm_conversations c where c.id = new.conversation_id;
  if new.org_id is null then
    raise exception 'Unknown conversation %', new.conversation_id;
  end if;
  return new;
end;
$$;

-- vm_layers: a REPLY (parent_layer_id set) derives conversation_id from its
-- parent — a client cannot attach a child to a parent in another conversation.
-- A ROOT layer supplies conversation_id itself. org_id always derives from the
-- conversation. Definer: reads rows the author may not own.
-- (Path assignment / ordinal atomicity / frozen-parent rejection are the
-- integration-time reply guard — INTEGRATION NOTE T1 — layered onto this same
-- function or a sibling trigger; NOT built in the draft.)
create function public.vm_layers_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare parent public.vm_layers%rowtype;
begin
  if new.parent_layer_id is not null then
    select * into parent from public.vm_layers where id = new.parent_layer_id;
    if not found then
      raise exception 'Unknown parent layer %', new.parent_layer_id;
    end if;
    new.conversation_id := parent.conversation_id;
  end if;

  select c.org_id into new.org_id
  from public.vm_conversations c where c.id = new.conversation_id;
  if new.org_id is null then
    raise exception 'Unknown conversation %', new.conversation_id;
  end if;
  return new;
end;
$$;

-- vm_reactions / vm_flags: derive conversation_id + org_id from the layer.
create function public.vm_sync_from_layer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare l public.vm_layers%rowtype;
begin
  select * into l from public.vm_layers where id = new.layer_id;
  if not found then
    raise exception 'Unknown layer %', new.layer_id;
  end if;
  new.conversation_id := l.conversation_id;
  new.org_id := l.org_id;
  return new;
end;
$$;

-- vm_moderation_log: derive org from the conversation; validate an optional
-- layer reference belongs to it. conversation_id may be NULL only via the
-- ON DELETE SET NULL of a later cascade — a fresh insert must name one (the
-- insert policy requires it); on such a nulling update the org_id already set
-- is kept.
create function public.vm_modlog_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.conversation_id is not null then
    select c.org_id into new.org_id
    from public.vm_conversations c where c.id = new.conversation_id;
    if new.org_id is null then
      raise exception 'Unknown conversation %', new.conversation_id;
    end if;
    if new.layer_id is not null and not exists (
      select 1 from public.vm_layers l
      where l.id = new.layer_id and l.conversation_id = new.conversation_id
    ) then
      raise exception 'Layer % is not in conversation %', new.layer_id, new.conversation_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger vm_members_scope before insert or update on public.vm_conversation_members
  for each row execute function public.vm_sync_from_conversation();
create trigger vm_layers_scope before insert or update on public.vm_layers
  for each row execute function public.vm_layers_before_write();
create trigger vm_reactions_scope before insert or update on public.vm_reactions
  for each row execute function public.vm_sync_from_layer();
create trigger vm_flags_scope before insert or update on public.vm_flags
  for each row execute function public.vm_sync_from_layer();
create trigger vm_modlog_scope before insert or update on public.vm_moderation_log
  for each row execute function public.vm_modlog_before_write();

-- ---------------------------------------------------------------------------
-- Policies. Blanket manage-write + explicit per-role carve-outs.
-- ---------------------------------------------------------------------------

-- Uniform manage-write: the org manage tier has full control of the content
-- tables. DELIBERATELY EXCLUDES vm_moderation_log (append-only: insert-only
-- policy below; not even managers may rewrite the audit trail — service_role
-- retains maintenance access).
do $$
declare t text;
begin
  foreach t in array array[
    'vm_conversations', 'vm_layers', 'vm_conversation_members',
    'vm_reactions', 'vm_flags']
  loop
    execute format(
      'create policy %I_write_manage on public.%I for all
         using (public.vm_can_manage(org_id))
         with check (public.vm_can_manage(org_id));',
      t, t);
  end loop;
end $$;

-- --- Conversations -----------------------------------------------------------
-- Read: members (viewer seats included; org-wide moderators via the helper's
-- org tail), plus the creator DIRECTLY by column — the creator has no member
-- row yet inside their own INSERT ... RETURNING, and a definer lookup would
-- not see the uncommitted row (docs/03 #15 bootstrap).
create policy vm_conversations_select on public.vm_conversations
  for select using (
    created_by = auth.uid()
    or public.vm_is_conv_member(id)
  );

-- Create: any org-level module member starts a conversation as themselves.
-- (For ad-hoc personal groups the app creates the lightweight org first —
-- header decision.) The creator's admin membership row is inserted in the
-- same server action (bootstrap policy on vm_conversation_members below).
create policy vm_conversations_insert_creator on public.vm_conversations
  for insert with check (
    created_by = auth.uid()
    and public.vm_is_module_member(org_id)
  );

-- Conversation admins update title/settings/frozen.
-- INTEGRATION NOTE (T6 pin): RLS cannot restrict WHICH columns — add a BEFORE
-- UPDATE pin trigger reverting org_id/created_by (and id) to OLD for everyone
-- below the manage tier, so a conv-admin can only touch
-- title/settings/frozen. Name it to sort BEFORE any scope trigger
-- (root table has none today; keep the convention anyway).
create policy vm_conversations_update_admin on public.vm_conversations
  for update using (public.vm_is_conv_admin(id))
  with check (public.vm_is_conv_admin(id));

-- Conversation admins may delete the whole conversation (severe cases; spec
-- reserves destruction for admins). Cascade removes layers/members/reactions/
-- flags; vm_moderation_log rows survive with conversation_id nulled.
create policy vm_conversations_delete_admin on public.vm_conversations
  for delete using (public.vm_is_conv_admin(id));

-- --- Members -----------------------------------------------------------------
-- Read: own row DIRECTLY by column (INSERT ... RETURNING on the creator
-- bootstrap — docs/03 #15), plus the roster is visible to every member
-- (WhatsApp-style member list) and to org moderators via the helper tail.
create policy vm_members_select on public.vm_conversation_members
  for select using (
    user_id = auth.uid()
    or public.vm_is_conv_member(conversation_id)
  );

-- Insert: a conversation admin adds members (their own admin seat already
-- exists, so the definer lookup is safe), OR the CREATOR bootstraps their own
-- admin seat right after creating the conversation (lookup into
-- vm_conversations — another table — so #15 is satisfied).
-- INTEGRATION NOTE (T5): invite-acceptance and deep-link JOIN flows (gated on
-- settings: who may invite, deep-link visibility, and status<>'banned') are a
-- definer RPC at integration — RLS alone cannot read the settings jsonb
-- semantics. Do NOT widen this policy for self-joins.
create policy vm_members_insert on public.vm_conversation_members
  for insert with check (
    public.vm_is_conv_admin(conversation_id)
    or (
      user_id = auth.uid()
      and role = 'admin'
      and status = 'active'
      and public.vm_created_conversation(conversation_id)
    )
  );

-- Conversation admins manage the roster (role changes, ban/unban).
-- INTEGRATION NOTE (T6 pins): pin conversation_id/user_id on any member
-- update; for a SELF update (policy below) pin everything except last_seen_at
-- (a member must not promote themselves or lift their own ban); add a
-- last-admin-standing guard (cannot demote/remove the only active admin).
-- Pin trigger name must sort BEFORE vm_members_scope.
create policy vm_members_update_admin on public.vm_conversation_members
  for update using (public.vm_is_conv_admin(conversation_id))
  with check (public.vm_is_conv_admin(conversation_id));

-- Self-service: a member stamps their own last_seen_at ("what's new" anchor).
create policy vm_members_update_self on public.vm_conversation_members
  for update using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Removal: admins remove members; anyone may LEAVE (delete their own row).
-- Ban-for-cause keeps the row (status='banned') instead — deleting drops the
-- re-join block.
create policy vm_members_delete_admin on public.vm_conversation_members
  for delete using (public.vm_is_conv_admin(conversation_id));
create policy vm_members_delete_self on public.vm_conversation_members
  for delete using (user_id = auth.uid());

-- --- Layers ------------------------------------------------------------------
-- Read: every member of the conversation (viewers included). Tombstoned rows
-- REMAIN readable — the slot must render so descendants keep their context;
-- the offending content is blanked at tombstone time (T4), not hidden by RLS.
-- Deep-link visitors who are NOT members go through public definer functions
-- at integration (T10, the syn_public_* pattern) — no anon policy here.
create policy vm_layers_select on public.vm_layers
  for select using (public.vm_is_conv_member(conversation_id));

-- Reply/draw: the author inserts as themselves (DIRECT column check, #15) into
-- a conversation where they hold a drawing seat. Viewers have no insert path.
-- INTEGRATION NOTE (T1 — the reply guard, layered onto vm_layers_before_write):
-- concurrent replies to the same parent must get distinct ordinals atomically.
-- Recommended: inside the BEFORE INSERT trigger,
--   `update vm_layers set child_count = child_count + 1
--      where id = new.parent_layer_id returning child_count` —
-- the parent row lock serializes concurrent siblings; the returned count is
-- the new sibling ordinal and path := parent.path || '.' || ordinal.
-- (Alternative: pg_advisory_xact_lock(hashtextextended(parent_id::text, 0)) +
-- max(ordinal)+1; the child_count row lock is simpler and self-auditing. The
-- unique (conversation_id, path) index backstops both.) The same guard must
-- REJECT the insert when: parent is tombstoned (spec: tombstoned slots are not
-- reply targets), vm_layer_locked(parent) (conversation/branch frozen), or the
-- author supplied their own path/child_count (server-computed: pin to
-- computed values; roots get path '1'). Until T1 lands, path is
-- client-supplied — the draft is NOT integration-safe without it.
create policy vm_layers_insert_author on public.vm_layers
  for insert with check (
    author_id = auth.uid()
    and public.vm_can_post(conversation_id)
  );

-- Author touch-up while childless: the spec makes a layer immutable once
-- REPLIED ON; child_count = 0 is the DIRECT-column form of "no replies yet"
-- (#15 — no self-referential lookup). See ambiguity A2 in the review report:
-- the spec also says undo/eraser is pre-send only, so the reviewer may strike
-- this policy entirely.
-- INTEGRATION NOTE (T3 pin): for a non-moderator author this update must be
-- content-ONLY — pin path/parent_layer_id/conversation_id/author_id/
-- child_count/frozen/tombstone columns to OLD. Trigger sorts BEFORE
-- vm_layers_scope.
create policy vm_layers_update_author on public.vm_layers
  for update using (author_id = auth.uid() and child_count = 0)
  with check (author_id = auth.uid());

-- Moderator updates: tombstone/restore (and conv-admin branch freeze).
-- INTEGRATION NOTE (T3 pin): moderators may touch ONLY
-- tombstoned/tombstoned_by/tombstoned_at (stamped server-side to auth.uid()/
-- now()); `frozen` only for vm_is_conv_admin; everything else pinned to OLD.
-- Tombstoning should go through the T4 definer RPC so content-blank + audit
-- row are atomic — this policy exists so the RPC's caller passes RLS.
create policy vm_layers_update_moderate on public.vm_layers
  for update using (public.vm_can_moderate(conversation_id))
  with check (public.vm_can_moderate(conversation_id));

-- Delete own layer ONLY while childless (spec) and not under moderation
-- (a tombstoned slot must keep rendering for any future restore/audit).
-- child_count is a direct column check; its trigger-maintained accuracy is T2.
create policy vm_layers_delete_author on public.vm_layers
  for delete using (
    author_id = auth.uid()
    and child_count = 0
    and not tombstoned
  );

-- Severe-case subtree delete: conversation admins delete any layer; the
-- parent_layer_id ON DELETE CASCADE removes the whole subtree (FK cascades are
-- not themselves RLS-checked — deliberate: the admin's right to the root of
-- the branch is the authorization). Log via T4's RPC ('delete_layer').
create policy vm_layers_delete_admin on public.vm_layers
  for delete using (public.vm_is_conv_admin(conversation_id));

-- --- Reactions ---------------------------------------------------------------
-- Read: conversation members. Write: a drawing-seat member reacts as
-- themselves (DIRECT user_id check, #15); read-only viewers do NOT react
-- (ambiguity A4 — "watch, no draw" read literally; reviewer may relax to
-- vm_is_conv_member). Remove = delete own row; no update path (kind change is
-- delete + insert; the unique (layer, user, kind) makes both idempotent).
create policy vm_reactions_select on public.vm_reactions
  for select using (public.vm_is_conv_member(conversation_id));

create policy vm_reactions_insert_own on public.vm_reactions
  for insert with check (
    user_id = auth.uid()
    and public.vm_can_post(conversation_id)
  );

create policy vm_reactions_delete_own on public.vm_reactions
  for delete using (user_id = auth.uid());

-- --- Flags (moderation queue) --------------------------------------------------
-- Read: the reporter sees their own reports (DIRECT column); moderators see
-- the queue. The flagged layer's AUTHOR has no read path — they never learn
-- who reported them.
create policy vm_flags_select on public.vm_flags
  for select using (
    reporter_user_id = auth.uid()
    or public.vm_can_moderate(conversation_id)
  );

-- Any member — viewer seats included — may flag a layer (safety reporting is
-- not a drawing privilege).
create policy vm_flags_insert_own on public.vm_flags
  for insert with check (
    reporter_user_id = auth.uid()
    and public.vm_is_conv_member(conversation_id)
  );

-- Moderator triage: actioned/dismissed + review stamps.
-- INTEGRATION NOTE (T7 pin): a moderator may change ONLY state/reviewed_by/
-- reviewed_at; reporter_user_id/layer_id/reason/detail pinned to OLD;
-- reviewed_by := auth.uid() and reviewed_at := now() stamped server-side on
-- any state change (the sd_pin_report pattern). Trigger sorts BEFORE
-- vm_flags_scope.
create policy vm_flags_update_moderate on public.vm_flags
  for update using (public.vm_can_moderate(conversation_id))
  with check (public.vm_can_moderate(conversation_id));

-- --- Moderation log (append-only audit) ----------------------------------------
-- Read: moderators of the conversation (the detail jsonb can hold tombstoned
-- ORIGINAL content — never member-visible); manage tier reads org-wide,
-- including rows whose conversation was deleted (conversation_id nulled).
create policy vm_modlog_select on public.vm_moderation_log
  for select using (
    public.vm_can_manage(org_id)
    or (conversation_id is not null and public.vm_can_moderate(conversation_id))
  );

-- Append: a moderator logs their own action against a live conversation.
-- No UPDATE/DELETE policy exists for anyone — combined with the grant above,
-- the log is append-only for all API roles.
create policy vm_modlog_insert on public.vm_moderation_log
  for insert with check (
    actor_user_id = auth.uid()
    and conversation_id is not null
    and public.vm_can_moderate(conversation_id)
  );

-- ---------------------------------------------------------------------------
-- Deferred (documented, not built — extract-don't-speculate + shared platform
-- state stays out of module drafts):
--   * STORAGE: a 'vm-images' bucket for root images + image stamps, objects
--     under <org_id>/<conversation_id>/<uuid>. Bucket creation + storage.objects
--     policies are INTEGRATION-TIME (shared platform state — same reason the
--     classroom draft deferred cls-materials). Policies must mirror
--     conversation membership via a definer fn (vm_image_visible), NOT plain
--     org membership — the exact class of the module-2 security finding
--     (cls_material_storage_visible). Write = vm_can_post members into their
--     own conversation's prefix; delete = uploader while their layer is
--     childless + moderators.
--   * DEEP LINKS for non-members: security-definer functions
--     (vm_public_layer(conversation, path) etc.) exposing a layer + its
--     ancestor chain ONLY when the conversation's settings allow deep-link
--     visibility — the syn_public_weeks pattern (docs/03 #4). No anon table
--     policies, ever. Visitors who then JOIN get a 'viewer' seat via the T5
--     join RPC.
--   * WORKER: thumbnail rasterization for the zoomed-out grids (vector jsonb →
--     raster tiles) as a job_requests / pg-boss job, results to storage — the
--     established job pipeline (docs/03 #5); no schema needed beyond what
--     exists.
--   * NOTIFICATIONS ("what's new", mentions) — platform notification/email
--     primitives (docs/03 hard-rule #5), not inline.
--   * Image-stamp guard VALUES (max size vs canvas, default transparency):
--     app-layer Zod on content; defaults in org_modules.settings, overrides in
--     vm_conversations.settings. Not a DB constraint (vector jsonb is opaque
--     to SQL by design).
--
-- INTEGRATION-TIME TODO SUMMARY (guards RLS cannot express — for
-- schema-fixes.sql; each verified live against Postgres before merge):
--   T1. Reply guard + ATOMIC path assignment (BEFORE INSERT): parent
--       child_count increment-with-row-lock (or advisory lock) yields the
--       sibling ordinal; path server-computed ('1' for roots, parent.path ||
--       '.' || ordinal otherwise), client-supplied path/child_count ignored;
--       REJECT when parent tombstoned or vm_layer_locked(parent). The
--       unique (conversation_id, path) index backstops collisions.
--   T2. child_count maintenance: decrement on child DELETE (AFTER DELETE
--       trigger). T1+T2 must land together with T3 — the childless-only
--       author policies trust this column.
--   T3. vm_layers pins: author self-update = content only, while
--       child_count = 0 (or strike the policy — ambiguity A2); moderator
--       update = tombstone columns only, stamped server-side; frozen =
--       conv-admin only; path/parent/conversation/author/child_count pinned
--       for everyone below manage. Trigger sorts BEFORE vm_layers_scope.
--   T4. Tombstone/restore + freeze/unfreeze + delete as AUDITED definer RPCs:
--       copy original content into vm_moderation_log.detail, blank
--       vm_layers.content, stamp tombstoned_*, insert the log row — one
--       transaction. Definer fns must re-check vm_can_moderate/_is_conv_admin
--       internally (docs/03 #13).
--   T5. Membership join RPC: invite acceptance + deep-link join honoring
--       settings (who_may_invite, deep_link_visibility) and refusing
--       status = 'banned'. Draft policy admits only admin-adds + creator
--       bootstrap; keep it that narrow.
--   T6. Member/conversation pins: self-update = last_seen_at only (no
--       self-promotion / self-unban); pin conversation_id/user_id on all
--       member updates; last-admin-standing guard; conversation pin =
--       title/settings/frozen only below manage tier. Pins sort BEFORE
--       vm_members_scope.
--   T7. vm_flags triage pin + server-side reviewed_by/reviewed_at stamps.
--   T8. 'vm-images' bucket + membership-mirroring storage policies (see
--       Deferred above).
--   T9. Deep-link public definer functions (see Deferred above).
--  T10. Freeze semantics double-check: layer INSERTs under a frozen
--       conversation/branch are rejected by T1; decide whether reactions and
--       flags under a frozen branch are also rejected (draft allows them —
--       flagging must stay possible on frozen content; reactions arguable).
-- ---------------------------------------------------------------------------
