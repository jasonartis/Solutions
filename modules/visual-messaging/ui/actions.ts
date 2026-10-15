'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { recordActivity } from '@platform/core'

// Visual-messaging actions. RLS + the vm_ guard triggers are the enforcement
// layer: the creator-insert policy + member bootstrap start a conversation;
// the reply guard assigns paths atomically server-side (client-supplied
// path/child_count are ignored); frozen/tombstoned parents reject replies.
//
// docs/03 #22: an expected refusal is a RETURN VALUE, never a throw. In a
// production build a thrown Server Action message is redacted to a generic one
// and the error boundary replaces the page — which loses a half-drawn reply.
// Every action here returns an ActionResult and the client (ActionForm / the
// canvas) shows `reason` inline, keeping whatever the person was doing.
export type ActionResult = { ok: true } | { ok: false; reason: string }
const refuse = (reason: string) => ({ ok: false as const, reason })
const failure = (error: { message: string } | null, what: string) =>
  error ? refuse(`${what}: ${error.message}`) : null

// Layer content vocabulary (Zod-light for v1; the canvas produces exactly
// this shape): a root layer carries the image; replies carry strokes and/or
// emoji stamps, both drawn in IMAGE pixel space so every zoom level stays
// registered.
export type Stroke = { points: number[][]; color: string; size: number }
export type Stamp = { emoji: string; x: number; y: number; fontSize: number; angle?: number }
export type TextStamp = { text: string; color: string; x: number; y: number; fontSize: number; angle: number }
// path is a vm-images storage object (uploaded via uploadImageStamp, private
// bucket — the page resolves it to a signed URL for rendering); x/y are the
// placed TOP-LEFT corner, width/height the placed size, all image pixels.
export type ImageStamp = {
  path: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  opacity: number
}

const IMAGE_STAMP_MAX_BYTES = 8 * 1024 * 1024
const IMAGE_STAMP_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']

// Upload an image to place as a stamp (spec: "image stamps (upload,
// shrink/rotate/place)"). The vm-images bucket + its vm_can_post-gated write
// policy already exist from the 2026-07-09 security review (T8) — this is
// the first UI to use them for anything other than the root image. Called
// programmatically from the canvas (not a <form> submit), so it takes the
// File directly rather than FormData.
export async function uploadImageStamp(
  orgSlug: string,
  conversationId: string,
  image: File,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  if (!image || image.size === 0) return refuse('Pick an image first')
  if (image.size > IMAGE_STAMP_MAX_BYTES) return refuse('Image is too large (max 8MB)')
  if (!IMAGE_STAMP_TYPES.includes(image.type)) return refuse('Unsupported image type')

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return refuse('Not signed in')
  const { data: org } = await supabase.from('orgs').select('id').eq('slug', orgSlug).single()
  if (!org) return refuse('Org not found')

  const path = `${org.id}/${conversationId}/stamp-${Date.now()}-${image.name}`
  const { error } = await supabase.storage.from('vm-images').upload(path, image)
  const failed = failure(error, 'Image upload failed')
  if (failed) return failed
  return { ok: true, path }
}

export async function createConversation(orgSlug: string, formData: FormData): Promise<ActionResult> {
  const title = String(formData.get('title') ?? '').trim()
  const image = formData.get('image') as File | null
  if (!title || !image || image.size === 0) return refuse('Title and a starting picture are required')

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return refuse('Not signed in')
  const { data: org } = await supabase.from('orgs').select('id').eq('slug', orgSlug).single()
  if (!org) return refuse('Org not found')

  const { data: conv, error: convErr } = await supabase
    .from('vm_conversations')
    .insert({ org_id: org.id, title, created_by: user.id })
    .select('id')
    .single()
  const convFailed = failure(convErr, 'Create conversation failed')
  if (convFailed) return convFailed

  // Creator bootstraps their own admin seat (the one self-insert the policy allows).
  const { error: memberErr } = await supabase.from('vm_conversation_members').insert({
    org_id: org.id,
    conversation_id: conv!.id,
    user_id: user.id,
    role: 'admin',
  })
  const memberFailed = failure(memberErr, 'Join own conversation failed')
  if (memberFailed) return memberFailed

  const path = `${org.id}/${conv!.id}/root-${Date.now()}-${image.name}`
  const { error: upErr } = await supabase.storage.from('vm-images').upload(path, image)
  const upFailed = failure(upErr, 'Image upload failed')
  if (upFailed) return upFailed

  // The root IS a layer (path '1', assigned server-side).
  const { error: rootErr } = await supabase.from('vm_layers').insert({
    org_id: org.id,
    conversation_id: conv!.id,
    author_id: user.id,
    path: 'server-assigned',
    content: { image: { path } },
  })
  const rootFailed = failure(rootErr, 'Create root layer failed')
  if (rootFailed) return rootFailed

  await recordActivity(supabase, {
    moduleKey: 'visual-messaging',
    action: 'conversation.created',
    orgSlug,
  })
  revalidatePath(`/o/${orgSlug}/m/visual-messaging`)
  return { ok: true }
}

// Deep-link join (spec: a read-only viewer is what a deep-link visitor gets
// "before joining"). A logged-in org-module member who is NOT yet a
// conversation member lands on the conversation URL; if the conversation's
// joinPolicy is 'open' they can take a viewer seat. vm_join_conversation
// re-checks EVERYTHING server-side (open policy, org-module membership, ban)
// — the app never trusts a client claim. Invite-only conversations refuse,
// which is exactly the per-conversation "deep links work for non-members?"
// setting the spec calls for.
export async function joinConversation(orgSlug: string, conversationId: string): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase.rpc('vm_join_conversation', { check_conversation_id: conversationId })
  const failed = failure(error, 'Join failed')
  if (failed) return failed
  redirect(`/o/${orgSlug}/m/visual-messaging/conversations/${conversationId}`)
}

// Accept-first seats (20261007030000): being added to a conversation creates a
// PENDING seat that confers nothing until the invitee says yes. Accept goes
// through a definer because a pending invitee cannot see the conversation, so
// the scope trigger would refuse a direct UPDATE of their own seat.
export async function acceptConversationInvite(orgSlug: string, conversationId: string): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase.rpc('vm_accept_conversation_invite', { check_conversation_id: conversationId })
  const failed = failure(error, 'Accept invitation failed')
  if (failed) return failed
  revalidatePath(`/o/${orgSlug}/m/visual-messaging`)
  redirect(`/o/${orgSlug}/m/visual-messaging/conversations/${conversationId}`)
}

// Decline = delete your own pending seat (vm_members_delete_self). Deleting
// rather than marking it declined matches LEAVE, so a later re-invite works.
// Scoped to status 'pending' so this can never be used to leave by accident.
export async function declineConversationInvite(orgSlug: string, conversationId: string): Promise<ActionResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return refuse('Not signed in')
  const { error } = await supabase
    .from('vm_conversation_members')
    .delete()
    .eq('conversation_id', conversationId)
    .eq('user_id', user.id)
    .eq('status', 'pending')
  const failed = failure(error, 'Decline invitation failed')
  if (failed) return failed
  revalidatePath(`/o/${orgSlug}/m/visual-messaging`)
  redirect(`/o/${orgSlug}/m/visual-messaging`)
}

// Decline AND block (20261007050000): the seat is kept as a self-block
// (banned, self_blocked) instead of deleted, so this conversation cannot
// invite the person again — nobody else can lift, re-invite over, or delete
// it. Per CONVERSATION, not per inviter. A definer for the same reason as
// accept: a pending invitee cannot update their own seat directly.
export async function declineAndBlockConversationInvite(
  orgSlug: string,
  conversationId: string,
): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase.rpc('vm_decline_and_block_invite', { check_conversation_id: conversationId })
  const failed = failure(error, 'Decline and block failed')
  if (failed) return failed
  revalidatePath(`/o/${orgSlug}/m/visual-messaging`)
  redirect(`/o/${orgSlug}/m/visual-messaging`)
}

// Unblock = delete your own self-blocked seat (20261008010000). The guard
// (vm_guard_self_block) lets only the holder do this; the filters make sure
// it can only ever hit a SELF-block, never a moderation ban. After it, the
// conversation can invite you again.
export async function unblockConversation(orgSlug: string, conversationId: string): Promise<ActionResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return refuse('Not signed in')
  const { error } = await supabase
    .from('vm_conversation_members')
    .delete()
    .eq('conversation_id', conversationId)
    .eq('user_id', user.id)
    .eq('status', 'banned')
    .eq('self_blocked', true)
  const failed = failure(error, 'Unblock failed')
  if (failed) return failed
  revalidatePath(`/o/${orgSlug}/m/visual-messaging`)
  return { ok: true }
}

// A conversation admin opens or closes deep-link joining. Writes
// settings.joinPolicy; the vm_conversations_update_admin policy gates who,
// and vm_pin_conversation leaves settings free to change (it only pins
// org_id/created_by). Reads the current settings first so other keys survive.
export async function setJoinPolicy(orgSlug: string, conversationId: string, open: boolean): Promise<ActionResult> {
  const supabase = await createClient()
  const { data: conv } = await supabase
    .from('vm_conversations')
    .select('settings')
    .eq('id', conversationId)
    .single()
  const settings = {
    ...((conv?.settings as Record<string, unknown>) ?? {}),
    joinPolicy: open ? 'open' : 'invite',
  }
  const { error } = await supabase.from('vm_conversations').update({ settings }).eq('id', conversationId)
  const failed = failure(error, 'Update join policy failed')
  if (failed) return failed
  revalidatePath(`/o/${orgSlug}/m/visual-messaging/conversations/${conversationId}`)
  return { ok: true }
}

// Rename = update `title`. The conversation admin may (vm_conversations_update_admin
// + the column grant; vm_pin_conversation leaves title free) — no migration.
// An UPDATE that RLS filters to zero rows is NOT an error, so ask for the row
// back and treat "nothing changed" as the refusal it is.
export async function renameConversation(
  orgSlug: string,
  conversationId: string,
  formData: FormData,
): Promise<ActionResult> {
  const title = String(formData.get('title') ?? '').trim()
  if (!title) return refuse('Give the conversation a name')
  if (title.length > 120) return refuse('That name is too long (120 characters at most)')
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('vm_conversations')
    .update({ title })
    .eq('id', conversationId)
    .select('id')
  const failed = failure(error, 'Rename failed')
  if (failed) return failed
  if (!data || data.length === 0) return refuse('Only a conversation admin can rename it')
  revalidatePath(`/o/${orgSlug}/m/visual-messaging/conversations/${conversationId}`)
  revalidatePath(`/o/${orgSlug}/m/visual-messaging`)
  return { ok: true }
}

export async function addMember(orgSlug: string, conversationId: string, formData: FormData): Promise<ActionResult> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  if (!email) return refuse('Email is required')

  const supabase = await createClient()

  // Derive the org from the CONVERSATION, not from the route slug: the
  // membership check below has to be about the org whose content this seat
  // would expose. (vm_members_scope overwrites any client-supplied org_id
  // from the conversation anyway, so this is also the value that will be
  // stored — passing the slug's org was always cosmetic.)
  const { data: conv } = await supabase
    .from('vm_conversations')
    .select('org_id')
    .eq('id', conversationId)
    .single()
  if (!conv) return refuse('Conversation not found')

  // The target must be an ACTIVE member of the conversation's org. A seat row
  // alone grants reads of every layer, reaction, roster row and vm-images
  // object in the conversation (the vm_is_conv_* predicates gate on the seat),
  // so without this an org member could hand a NON-member of that org full
  // access to its content. 20260904010000 is the real gate; this check exists
  // so the UI reports it as a clear error instead of an opaque RLS failure.
  //
  // The lookup and the bound are now ONE database call (docs/22 §3 R5):
  // `find_module_peer` returns an id only for an ACTIVE member of the named
  // org, which is why the separate `profiles`-by-email read that used to sit
  // above this — and whose own comment had to explain that it was not itself a
  // bound — is gone.
  const { data: peerId } = await supabase.rpc('find_module_peer', {
    check_org_id: conv.org_id,
    target_email: email,
  })
  if (!peerId) {
    return refuse(
      `No user found with email ${email} in this organization — add them as an org member first (and they must have accepted the invite)`,
    )
  }

  // Lands as an INVITATION: vm_members_c_invite forces status 'pending' and
  // stamps invited_by for any seat created for someone else, so the person
  // sees nothing of this conversation until they accept (20261007030000).
  const { error } = await supabase.from('vm_conversation_members').insert({
    org_id: conv.org_id,
    conversation_id: conversationId,
    user_id: peerId as string,
    role: 'participant',
  })

  // 23505 = unique_violation on (conversation_id, user_id): the person ALREADY
  // HAS A SEAT. That is deliberately NOT surfaced, because the two cases it
  // covers MUST be indistinguishable to the caller:
  //
  //   * they are already an active member — harmless, nothing to do; or
  //   * they SELF-BLOCKED. `20260910030000` deliberately KEEPS the seat row and
  //     flips it to 'banned'; that persistence is the entire mechanism, and is
  //     exactly what stops a conversation admin undoing the block by re-adding.
  //
  // Reporting the error told the admin the person has a row — and since LEAVING
  // deletes the row (so a re-add would succeed), an error meant "they did not
  // leave, they blocked you", handed to the very person self-block exists to
  // protect against. Self-block is the platform's only user-level block
  // (CLAUDE.md), so that confirmation is the whole thing worth withholding.
  //
  // Deliberate silence, not an oversight: the page renders no member roster
  // (it reads only the caller's own seat), so a no-op and a real add look
  // identical to the admin either way.
  if (error && error.code !== '23505') {
    const failed = failure(error, 'Add member failed')
    if (failed) return failed
  }
  revalidatePath(`/o/${orgSlug}/m/visual-messaging/conversations/${conversationId}`)
  return { ok: true }
}

// A reply layer: strokes drawn on top of the layer being viewed. The reply
// guard derives conversation/org/path server-side and rejects frozen or
// removed parents.
export async function replyWithDrawing(
  orgSlug: string,
  conversationId: string,
  parentLayerId: string,
  payloadJson: string,
): Promise<{ ok: true; layerId: string } | { ok: false; reason: string }> {
  let payload: {
    strokes: Stroke[]
    stamps: Stamp[]
    texts: TextStamp[]
    images: ImageStamp[]
  }
  try {
    payload = JSON.parse(payloadJson)
  } catch {
    return refuse('Malformed drawing')
  }
  const strokes = Array.isArray(payload.strokes) ? payload.strokes : []
  const stamps = Array.isArray(payload.stamps) ? payload.stamps : []
  const texts = Array.isArray(payload.texts) ? payload.texts : []
  const images = Array.isArray(payload.images) ? payload.images : []
  if (strokes.length === 0 && stamps.length === 0 && texts.length === 0 && images.length === 0) {
    return refuse('Draw or place something first')
  }
  for (const s of strokes) {
    if (!Array.isArray(s.points) || s.points.length < 2 || typeof s.color !== 'string' || typeof s.size !== 'number') {
      return refuse('Malformed drawing')
    }
  }
  for (const st of stamps) {
    if (
      typeof st.emoji !== 'string' ||
      st.emoji.length === 0 ||
      st.emoji.length > 8 ||
      typeof st.x !== 'number' ||
      typeof st.y !== 'number' ||
      typeof st.fontSize !== 'number' ||
      (st.angle !== undefined && typeof st.angle !== 'number')
    ) {
      return refuse('Malformed stamp')
    }
  }
  for (const t of texts) {
    if (
      typeof t.text !== 'string' ||
      t.text.trim().length === 0 ||
      t.text.length > 500 ||
      typeof t.color !== 'string' ||
      typeof t.x !== 'number' ||
      typeof t.y !== 'number' ||
      typeof t.fontSize !== 'number' ||
      typeof t.angle !== 'number'
    ) {
      return refuse('Malformed text')
    }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return refuse('Not signed in')
  const { data: org } = await supabase.from('orgs').select('id').eq('slug', orgSlug).single()
  if (!org) return refuse('Org not found')

  // Images must be objects THIS reply actually uploaded into THIS
  // conversation's folder — not an arbitrary storage path the client could
  // otherwise reference (uploadImageStamp is the only writer of this prefix).
  const expectedPrefix = `${org.id}/${conversationId}/`
  for (const img of images) {
    if (
      typeof img.path !== 'string' ||
      !img.path.startsWith(expectedPrefix) ||
      typeof img.x !== 'number' ||
      typeof img.y !== 'number' ||
      typeof img.width !== 'number' ||
      img.width <= 0 ||
      typeof img.height !== 'number' ||
      img.height <= 0 ||
      typeof img.rotation !== 'number' ||
      typeof img.opacity !== 'number'
    ) {
      return refuse('Malformed image stamp')
    }
  }

  const { data: newLayer, error } = await supabase
    .from('vm_layers')
    .insert({
      org_id: org.id,
      conversation_id: conversationId,
      parent_layer_id: parentLayerId,
      author_id: user.id,
      path: 'server-assigned',
      content: { strokes, stamps, texts, images },
    })
    .select('id')
    .single()
  const failed = failure(error, 'Send reply failed')
  if (failed) return failed
  await recordActivity(supabase, {
    moduleKey: 'visual-messaging',
    action: 'drawing.replied',
    orgSlug,
  })
  revalidatePath(`/o/${orgSlug}/m/visual-messaging/conversations/${conversationId}`)
  // Founder feedback (2026-07-11): after sending, land on the reply just
  // sent — not back on the parent, requiring a swipe to find it.
  return { ok: true, layerId: newLayer!.id as string }
}

// Any member may flag a layer for moderator attention (safety reporting is
// not a drawing privilege — RLS's vm_flags_insert_own only requires
// membership, per vm_is_conv_member).
export async function flagLayer(
  orgSlug: string,
  conversationId: string,
  layerId: string,
  formData: FormData,
): Promise<ActionResult> {
  const reason = String(formData.get('reason') ?? '').trim()
  const detail = String(formData.get('detail') ?? '').trim()
  if (!reason) return refuse('A reason is required')

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return refuse('Not signed in')
  const { data: org } = await supabase.from('orgs').select('id').eq('slug', orgSlug).single()
  if (!org) return refuse('Org not found')

  const { error } = await supabase.from('vm_flags').insert({
    org_id: org.id,
    conversation_id: conversationId,
    layer_id: layerId,
    reporter_user_id: user.id,
    reason,
    detail: detail || null,
  })
  const failed = failure(error, 'Flag failed')
  if (failed) return failed
  revalidatePath(`/o/${orgSlug}/m/visual-messaging/conversations/${conversationId}`)
  return { ok: true }
}

// Moderator triage on an open flag. The vm_flags_update_moderate policy pins
// every other column to OLD and a trigger stamps reviewed_by/reviewed_at
// server-side — this action only ever changes `state`.
export async function reviewFlag(
  orgSlug: string,
  conversationId: string,
  flagId: string,
  state: 'actioned' | 'dismissed',
): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase.from('vm_flags').update({ state }).eq('id', flagId)
  const failed = failure(error, 'Review flag failed')
  if (failed) return failed
  await recordActivity(supabase, {
    moduleKey: 'visual-messaging',
    action: 'flag.reviewed',
    orgSlug,
  })
  revalidatePath(`/o/${orgSlug}/m/visual-messaging/conversations/${conversationId}`)
  return { ok: true }
}

// Moderator-only RPCs (vm_can_moderate / vm_is_conv_admin re-checked inside
// each definer function — the app never trusts a client-side "is moderator"
// flag).
export async function tombstoneLayer(
  orgSlug: string,
  conversationId: string,
  layerId: string,
  formData: FormData,
): Promise<ActionResult> {
  const reason = String(formData.get('reason') ?? '').trim()
  const supabase = await createClient()
  const { error } = await supabase.rpc('vm_tombstone_layer', {
    check_layer_id: layerId,
    check_reason: reason || null,
  })
  const failed = failure(error, 'Remove layer failed')
  if (failed) return failed
  await recordActivity(supabase, {
    moduleKey: 'visual-messaging',
    action: 'layer.tombstoned',
    orgSlug,
  })
  revalidatePath(`/o/${orgSlug}/m/visual-messaging/conversations/${conversationId}`)
  return { ok: true }
}

export async function restoreLayer(orgSlug: string, conversationId: string, layerId: string): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase.rpc('vm_restore_layer', { check_layer_id: layerId })
  const failed = failure(error, 'Restore layer failed')
  if (failed) return failed
  await recordActivity(supabase, {
    moduleKey: 'visual-messaging',
    action: 'layer.restored',
    orgSlug,
  })
  revalidatePath(`/o/${orgSlug}/m/visual-messaging/conversations/${conversationId}`)
  return { ok: true }
}

export async function setBranchFrozen(
  orgSlug: string,
  conversationId: string,
  layerId: string,
  frozen: boolean,
): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase.rpc('vm_set_branch_frozen', { check_layer_id: layerId, check_frozen: frozen })
  const failed = failure(error, 'Freeze branch failed')
  if (failed) return failed
  await recordActivity(supabase, {
    moduleKey: 'visual-messaging',
    action: frozen ? 'branch.frozen' : 'branch.unfrozen',
    orgSlug,
  })
  revalidatePath(`/o/${orgSlug}/m/visual-messaging/conversations/${conversationId}`)
  return { ok: true }
}

export async function toggleReaction(
  orgSlug: string,
  conversationId: string,
  layerId: string,
  kind: 'heart' | 'laugh',
): Promise<ActionResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return refuse('Not signed in')

  const { data: existing } = await supabase
    .from('vm_reactions')
    .select('id')
    .eq('layer_id', layerId)
    .eq('user_id', user.id)
    .eq('kind', kind)
    .maybeSingle()

  if (existing) {
    const { error } = await supabase.from('vm_reactions').delete().eq('id', existing.id)
    const failed = failure(error, 'Remove reaction failed')
    if (failed) return failed
  } else {
    const { data: org } = await supabase.from('orgs').select('id').eq('slug', orgSlug).single()
    if (!org) return refuse('Org not found')
    const { error } = await supabase.from('vm_reactions').insert({
      org_id: org.id,
      conversation_id: conversationId,
      layer_id: layerId,
      user_id: user.id,
      kind,
    })
    const failed = failure(error, 'React failed')
    if (failed) return failed
  }
  revalidatePath(`/o/${orgSlug}/m/visual-messaging/conversations/${conversationId}`)
  return { ok: true }
}
