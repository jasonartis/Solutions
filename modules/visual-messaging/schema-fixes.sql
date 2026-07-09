-- Integration-review additions (2026-07-09 security review of the draft).
-- Builds the draft's flagged TODOs T1–T8. T9 (public deep-link definer fns)
-- ships with the UI phase, like syn_public_*; T10 decided: reactions and
-- flags stay POSSIBLE under a frozen branch (flagging frozen content is a
-- safety requirement; a reaction is harmless). Verified live before merge.

-- ---------------------------------------------------------------------------
-- T1 + parts of T3: reply guard, atomic path assignment, and column pins,
-- folded into ONE before-trigger pass. The draft's vm_layers_before_write is
-- replaced wholesale (same trigger name/order: vm_layers_scope).
--
-- INSERT: client-supplied path/child_count are IGNORED. A reply locks its
-- parent row via UPDATE ... RETURNING child_count (concurrent siblings
-- serialize on the row lock → no ordinal collisions; unique(conversation,
-- path) backstops). Replies to tombstoned or frozen-locked parents, or into
-- frozen conversations, are rejected.
--
-- UPDATE: internal maintenance (trigger depth > 1, e.g. the parent-counter
-- bump) passes through; org-manage passes; everyone else gets structure
-- pinned, with narrow carve-outs — moderators flip tombstoned (content blank
-- + stamps forced server-side on tombstone; restore re-supplies content),
-- conversation admins flip frozen, authors edit content only while the layer
-- is childless and untombstoned (spec: immutable once replied-on).
-- ---------------------------------------------------------------------------
create or replace function public.vm_layers_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent public.vm_layers%rowtype;
  conv public.vm_conversations%rowtype;
  ordinal integer;
begin
  if tg_op = 'INSERT' then
    new.child_count := 0; -- never client-supplied

    if new.parent_layer_id is not null then
      select * into parent from public.vm_layers where id = new.parent_layer_id;
      if not found then
        raise exception 'Unknown parent layer %', new.parent_layer_id;
      end if;
      if parent.tombstoned then
        raise exception 'Cannot reply to a removed layer';
      end if;
      if public.vm_layer_locked(parent.id) then
        raise exception 'This branch is frozen';
      end if;
      new.conversation_id := parent.conversation_id;

      -- Atomic ordinal: the row lock on the parent serializes siblings.
      update public.vm_layers
      set child_count = child_count + 1
      where id = new.parent_layer_id
      returning child_count into ordinal;
      new.path := parent.path || '.' || ordinal;
    else
      select * into conv from public.vm_conversations where id = new.conversation_id;
      if not found then
        raise exception 'Unknown conversation %', new.conversation_id;
      end if;
      if conv.frozen then
        raise exception 'This conversation is frozen';
      end if;
      new.path := '1'; -- one-root partial unique backstops
    end if;

    select c.org_id into new.org_id
    from public.vm_conversations c where c.id = new.conversation_id;
    if new.org_id is null then
      raise exception 'Unknown conversation %', new.conversation_id;
    end if;
    return new;
  end if;

  -- UPDATE ------------------------------------------------------------------
  if pg_trigger_depth() > 1 then
    return new; -- internal maintenance (counter bumps from this trigger / T2)
  end if;
  if public.vm_can_manage(old.org_id) then
    return new;
  end if;

  -- Structure is pinned for everyone below the org manage tier.
  new.org_id := old.org_id;
  new.conversation_id := old.conversation_id;
  new.parent_layer_id := old.parent_layer_id;
  new.path := old.path;
  new.child_count := old.child_count;
  new.author_id := old.author_id;

  -- frozen: conversation admins only.
  if new.frozen is distinct from old.frozen and not public.vm_is_conv_admin(old.conversation_id) then
    new.frozen := old.frozen;
  end if;

  -- tombstone lifecycle: moderators only; stamps forced server-side.
  if new.tombstoned is distinct from old.tombstoned then
    if not public.vm_can_moderate(old.conversation_id) then
      raise exception 'Only a moderator may remove or restore a layer';
    end if;
    if new.tombstoned then
      new.content := '{}'::jsonb;
      new.tombstoned_by := auth.uid();
      new.tombstoned_at := now();
    else
      new.tombstoned_by := null;
      new.tombstoned_at := null;
      -- restored content is supplied by the audited RPC (from the mod log)
    end if;
    return new;
  end if;
  new.tombstoned_by := old.tombstoned_by;
  new.tombstoned_at := old.tombstoned_at;

  -- content: the author, only while childless and untombstoned (immutable
  -- once replied-on); moderators do content changes via the tombstone path.
  if new.content is distinct from old.content then
    if not (old.author_id = auth.uid() and old.child_count = 0 and not old.tombstoned) then
      new.content := old.content;
    end if;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- T2: keep child_count honest on delete (author deletes own childless layer;
-- admin subtree delete cascades — parents inside the subtree are gone, so
-- their update is a no-op).
-- ---------------------------------------------------------------------------
create function public.vm_layers_after_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.parent_layer_id is not null then
    update public.vm_layers
    set child_count = greatest(child_count - 1, 0)
    where id = old.parent_layer_id;
  end if;
  return old;
end;
$$;

create trigger vm_layers_after_delete after delete on public.vm_layers
  for each row execute function public.vm_layers_after_delete();

-- ---------------------------------------------------------------------------
-- T4: audited moderation RPCs — the ONE path for tombstone/restore/freeze.
-- Each re-checks its gate internally (docs/03 #13), logs to
-- vm_moderation_log (original content preserved in detail), then mutates.
-- ---------------------------------------------------------------------------
create function public.vm_tombstone_layer(check_layer_id uuid, check_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare l public.vm_layers%rowtype;
begin
  select * into l from public.vm_layers where id = check_layer_id;
  if not found then raise exception 'Unknown layer %', check_layer_id; end if;
  if not public.vm_can_moderate(l.conversation_id) then
    raise exception 'Only a moderator may remove a layer';
  end if;
  if l.tombstoned then return; end if;

  insert into public.vm_moderation_log (org_id, conversation_id, layer_id, actor_user_id, action, detail)
  values (l.org_id, l.conversation_id, l.id, auth.uid(), 'tombstone',
          jsonb_build_object('reason', check_reason, 'original_content', l.content, 'path', l.path));

  update public.vm_layers
  set tombstoned = true, content = '{}'::jsonb, tombstoned_by = auth.uid(), tombstoned_at = now()
  where id = check_layer_id;
end;
$$;

create function public.vm_restore_layer(check_layer_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  l public.vm_layers%rowtype;
  original jsonb;
begin
  select * into l from public.vm_layers where id = check_layer_id;
  if not found then raise exception 'Unknown layer %', check_layer_id; end if;
  if not public.vm_can_moderate(l.conversation_id) then
    raise exception 'Only a moderator may restore a layer';
  end if;
  if not l.tombstoned then return; end if;

  -- The most recent tombstone log entry holds the blanked content.
  select detail -> 'original_content' into original
  from public.vm_moderation_log
  where layer_id = check_layer_id and action = 'tombstone'
  order by created_at desc limit 1;

  insert into public.vm_moderation_log (org_id, conversation_id, layer_id, actor_user_id, action, detail)
  values (l.org_id, l.conversation_id, l.id, auth.uid(), 'restore', '{}'::jsonb);

  update public.vm_layers
  set tombstoned = false, content = coalesce(original, '{}'::jsonb),
      tombstoned_by = null, tombstoned_at = null
  where id = check_layer_id;
end;
$$;

create function public.vm_set_branch_frozen(check_layer_id uuid, check_frozen boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare l public.vm_layers%rowtype;
begin
  select * into l from public.vm_layers where id = check_layer_id;
  if not found then raise exception 'Unknown layer %', check_layer_id; end if;
  if not public.vm_is_conv_admin(l.conversation_id) then
    raise exception 'Only a conversation admin may freeze a branch';
  end if;

  insert into public.vm_moderation_log (org_id, conversation_id, layer_id, actor_user_id, action, detail)
  values (l.org_id, l.conversation_id, l.id, auth.uid(),
          case when check_frozen then 'freeze_branch' else 'unfreeze_branch' end,
          jsonb_build_object('path', l.path));

  update public.vm_layers set frozen = check_frozen where id = check_layer_id;
end;
$$;

grant execute on function public.vm_tombstone_layer(uuid, text) to authenticated;
grant execute on function public.vm_restore_layer(uuid) to authenticated;
grant execute on function public.vm_set_branch_frozen(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- T5: membership join RPC (invite acceptance / deep-link join). Joins as a
-- read-only viewer when the conversation's settings allow open joining
-- (settings.joinPolicy = 'open'); banned members are refused. Everything
-- richer (invites) is app flow through the admin insert policy.
-- ---------------------------------------------------------------------------
create function public.vm_join_conversation(check_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare conv public.vm_conversations%rowtype;
begin
  select * into conv from public.vm_conversations where id = check_conversation_id;
  if not found then raise exception 'Unknown conversation %', check_conversation_id; end if;
  if coalesce(conv.settings ->> 'joinPolicy', 'invite') <> 'open' then
    raise exception 'This conversation is invite-only';
  end if;
  if not public.vm_is_module_member(conv.org_id) then
    raise exception 'Not a member of this organization''s module';
  end if;
  if exists (
    select 1 from public.vm_conversation_members
    where conversation_id = check_conversation_id and user_id = auth.uid() and status = 'banned'
  ) then
    raise exception 'You cannot join this conversation';
  end if;

  insert into public.vm_conversation_members (org_id, conversation_id, user_id, role)
  values (conv.org_id, check_conversation_id, auth.uid(), 'viewer')
  on conflict (conversation_id, user_id) do nothing;
end;
$$;

grant execute on function public.vm_join_conversation(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- T6: member + conversation pins ("..._a_pin" sorts before "..._scope").
-- ---------------------------------------------------------------------------
create function public.vm_pin_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 or public.vm_can_manage(old.org_id) then
    return new;
  end if;

  new.conversation_id := old.conversation_id;
  new.user_id := old.user_id;
  new.invited_by := old.invited_by;

  if public.vm_is_conv_admin(old.conversation_id) then
    -- Last-admin-standing: the seat keeping a conversation administrable
    -- cannot be demoted or banned away.
    if old.role = 'admin' and (new.role <> 'admin' or new.status <> 'active') then
      if not exists (
        select 1 from public.vm_conversation_members
        where conversation_id = old.conversation_id
          and role = 'admin' and status = 'active' and id <> old.id
      ) then
        raise exception 'A conversation must keep at least one admin';
      end if;
    end if;
    return new;
  end if;

  -- Self-service: last_seen_at only (no self-promotion / self-unban).
  new.role := old.role;
  new.status := old.status;
  return new;
end;
$$;

create trigger vm_members_a_pin before update on public.vm_conversation_members
  for each row execute function public.vm_pin_member();

create function public.vm_pin_conversation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.vm_can_manage(old.org_id) then
    return new;
  end if;
  new.org_id := old.org_id;
  new.created_by := old.created_by;
  return new; -- title/settings/frozen are the conv-admin's to change (RLS gates who)
end;
$$;

create trigger vm_conversations_a_pin before update on public.vm_conversations
  for each row execute function public.vm_pin_conversation();

-- ---------------------------------------------------------------------------
-- T7: flag triage pin — a moderator may only move state + review stamps
-- (stamped server-side); the report's substance is immutable.
-- ---------------------------------------------------------------------------
create function public.vm_pin_flag()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.vm_can_manage(old.org_id) then
    if new.state is distinct from old.state then
      new.reviewed_by := auth.uid();
      new.reviewed_at := coalesce(new.reviewed_at, now());
    end if;
    return new;
  end if;
  new.layer_id := old.layer_id;
  new.conversation_id := old.conversation_id;
  new.reporter_user_id := old.reporter_user_id;
  new.detail := old.detail;
  new.reason := old.reason;
  if new.state is distinct from old.state then
    new.reviewed_by := auth.uid();
    new.reviewed_at := coalesce(new.reviewed_at, now());
  end if;
  return new;
end;
$$;

create trigger vm_flags_a_pin before update on public.vm_flags
  for each row execute function public.vm_pin_flag();

-- ---------------------------------------------------------------------------
-- T8: the vm-images bucket (image stamps). Objects under
-- <org_id>/<conversation_id>/...; readable by conversation members and
-- moderators, writable by those who can post. NOT plain org membership —
-- the module-2 storage finding class.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('vm-images', 'vm-images', false)
on conflict (id) do nothing;

create policy vm_images_read on storage.objects
  for select using (
    bucket_id = 'vm-images'
    and (
      public.vm_is_conv_member(((storage.foldername(name))[2])::uuid)
      or public.vm_can_moderate(((storage.foldername(name))[2])::uuid)
    )
  );

create policy vm_images_write on storage.objects
  for insert with check (
    bucket_id = 'vm-images'
    and public.vm_can_post(((storage.foldername(name))[2])::uuid)
  );

create policy vm_images_delete on storage.objects
  for delete using (
    bucket_id = 'vm-images'
    and public.vm_can_moderate(((storage.foldername(name))[2])::uuid)
  );
