'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

// Visual-messaging actions. RLS + the vm_ guard triggers are the enforcement
// layer: the creator-insert policy + member bootstrap start a conversation;
// the reply guard assigns paths atomically server-side (client-supplied
// path/child_count are ignored); frozen/tombstoned parents reject replies.

function fail(error: { message: string } | null, what: string) {
  if (error) throw new Error(`${what}: ${error.message}`)
}

// Layer content vocabulary (Zod-light for v1; the canvas produces exactly
// this shape): a root layer carries the image; replies carry strokes and/or
// emoji stamps, both drawn in IMAGE pixel space so every zoom level stays
// registered.
export type Stroke = { points: number[][]; color: string; size: number }
export type Stamp = { emoji: string; x: number; y: number; fontSize: number }
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
export async function uploadImageStamp(orgSlug: string, conversationId: string, image: File): Promise<string> {
  if (!image || image.size === 0) throw new Error('Pick an image first')
  if (image.size > IMAGE_STAMP_MAX_BYTES) throw new Error('Image is too large (max 8MB)')
  if (!IMAGE_STAMP_TYPES.includes(image.type)) throw new Error('Unsupported image type')

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')
  const { data: org } = await supabase.from('orgs').select('id').eq('slug', orgSlug).single()
  if (!org) throw new Error('Org not found')

  const path = `${org.id}/${conversationId}/stamp-${Date.now()}-${image.name}`
  const { error } = await supabase.storage.from('vm-images').upload(path, image)
  fail(error, 'Image upload failed')
  return path
}

export async function createConversation(orgSlug: string, formData: FormData) {
  const title = String(formData.get('title') ?? '').trim()
  const image = formData.get('image') as File | null
  if (!title || !image || image.size === 0) throw new Error('Title and a starting picture are required')

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')
  const { data: org } = await supabase.from('orgs').select('id').eq('slug', orgSlug).single()
  if (!org) throw new Error('Org not found')

  const { data: conv, error: convErr } = await supabase
    .from('vm_conversations')
    .insert({ org_id: org.id, title, created_by: user.id })
    .select('id')
    .single()
  fail(convErr, 'Create conversation failed')

  // Creator bootstraps their own admin seat (the one self-insert the policy allows).
  const { error: memberErr } = await supabase.from('vm_conversation_members').insert({
    org_id: org.id,
    conversation_id: conv!.id,
    user_id: user.id,
    role: 'admin',
  })
  fail(memberErr, 'Join own conversation failed')

  const path = `${org.id}/${conv!.id}/root-${Date.now()}-${image.name}`
  const { error: upErr } = await supabase.storage.from('vm-images').upload(path, image)
  fail(upErr, 'Image upload failed')

  // The root IS a layer (path '1', assigned server-side).
  const { error: rootErr } = await supabase.from('vm_layers').insert({
    org_id: org.id,
    conversation_id: conv!.id,
    author_id: user.id,
    path: 'server-assigned',
    content: { image: { path } },
  })
  fail(rootErr, 'Create root layer failed')

  revalidatePath(`/o/${orgSlug}/m/visual-messaging`)
}

// Deep-link join (spec: a read-only viewer is what a deep-link visitor gets
// "before joining"). A logged-in org-module member who is NOT yet a
// conversation member lands on the conversation URL; if the conversation's
// joinPolicy is 'open' they can take a viewer seat. vm_join_conversation
// re-checks EVERYTHING server-side (open policy, org-module membership, ban)
// — the app never trusts a client claim. Invite-only conversations refuse,
// which is exactly the per-conversation "deep links work for non-members?"
// setting the spec calls for.
export async function joinConversation(orgSlug: string, conversationId: string) {
  const supabase = await createClient()
  const { error } = await supabase.rpc('vm_join_conversation', { check_conversation_id: conversationId })
  fail(error, 'Join failed')
  redirect(`/o/${orgSlug}/m/visual-messaging/conversations/${conversationId}`)
}

// A conversation admin opens or closes deep-link joining. Writes
// settings.joinPolicy; the vm_conversations_update_admin policy gates who,
// and vm_pin_conversation leaves settings free to change (it only pins
// org_id/created_by). Reads the current settings first so other keys survive.
export async function setJoinPolicy(orgSlug: string, conversationId: string, open: boolean) {
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
  fail(error, 'Update join policy failed')
  revalidatePath(`/o/${orgSlug}/m/visual-messaging/conversations/${conversationId}`)
}

export async function addMember(orgSlug: string, conversationId: string, formData: FormData) {
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  if (!email) throw new Error('Email is required')

  const supabase = await createClient()
  const { data: profile } = await supabase.from('profiles').select('user_id').eq('email', email).maybeSingle()
  if (!profile) throw new Error('No user with that email in your organization')
  const { data: org } = await supabase.from('orgs').select('id').eq('slug', orgSlug).single()

  const { error } = await supabase.from('vm_conversation_members').insert({
    org_id: org!.id,
    conversation_id: conversationId,
    user_id: profile.user_id,
    role: 'participant',
  })
  fail(error, 'Add member failed')
  revalidatePath(`/o/${orgSlug}/m/visual-messaging/conversations/${conversationId}`)
}

// A reply layer: strokes drawn on top of the layer being viewed. The reply
// guard derives conversation/org/path server-side and rejects frozen or
// removed parents.
export async function replyWithDrawing(
  orgSlug: string,
  conversationId: string,
  parentLayerId: string,
  payloadJson: string,
) {
  const payload = JSON.parse(payloadJson) as {
    strokes: Stroke[]
    stamps: Stamp[]
    texts: TextStamp[]
    images: ImageStamp[]
  }
  const strokes = Array.isArray(payload.strokes) ? payload.strokes : []
  const stamps = Array.isArray(payload.stamps) ? payload.stamps : []
  const texts = Array.isArray(payload.texts) ? payload.texts : []
  const images = Array.isArray(payload.images) ? payload.images : []
  if (strokes.length === 0 && stamps.length === 0 && texts.length === 0 && images.length === 0) {
    throw new Error('Draw or place something first')
  }
  for (const s of strokes) {
    if (!Array.isArray(s.points) || s.points.length < 2 || typeof s.color !== 'string' || typeof s.size !== 'number') {
      throw new Error('Malformed drawing')
    }
  }
  for (const st of stamps) {
    if (
      typeof st.emoji !== 'string' ||
      st.emoji.length === 0 ||
      st.emoji.length > 8 ||
      typeof st.x !== 'number' ||
      typeof st.y !== 'number' ||
      typeof st.fontSize !== 'number'
    ) {
      throw new Error('Malformed stamp')
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
      throw new Error('Malformed text')
    }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')
  const { data: org } = await supabase.from('orgs').select('id').eq('slug', orgSlug).single()
  if (!org) throw new Error('Org not found')

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
      throw new Error('Malformed image stamp')
    }
  }

  const { error } = await supabase.from('vm_layers').insert({
    org_id: org.id,
    conversation_id: conversationId,
    parent_layer_id: parentLayerId,
    author_id: user.id,
    path: 'server-assigned',
    content: { strokes, stamps, texts, images },
  })
  fail(error, 'Send reply failed')
  revalidatePath(`/o/${orgSlug}/m/visual-messaging/conversations/${conversationId}`)
}

// Any member may flag a layer for moderator attention (safety reporting is
// not a drawing privilege — RLS's vm_flags_insert_own only requires
// membership, per vm_is_conv_member).
export async function flagLayer(orgSlug: string, conversationId: string, layerId: string, formData: FormData) {
  const reason = String(formData.get('reason') ?? '').trim()
  const detail = String(formData.get('detail') ?? '').trim()
  if (!reason) throw new Error('A reason is required')

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')
  const { data: org } = await supabase.from('orgs').select('id').eq('slug', orgSlug).single()

  const { error } = await supabase.from('vm_flags').insert({
    org_id: org!.id,
    conversation_id: conversationId,
    layer_id: layerId,
    reporter_user_id: user.id,
    reason,
    detail: detail || null,
  })
  fail(error, 'Flag failed')
  revalidatePath(`/o/${orgSlug}/m/visual-messaging/conversations/${conversationId}`)
}

// Moderator triage on an open flag. The vm_flags_update_moderate policy pins
// every other column to OLD and a trigger stamps reviewed_by/reviewed_at
// server-side — this action only ever changes `state`.
export async function reviewFlag(
  orgSlug: string,
  conversationId: string,
  flagId: string,
  state: 'actioned' | 'dismissed',
) {
  const supabase = await createClient()
  const { error } = await supabase.from('vm_flags').update({ state }).eq('id', flagId)
  fail(error, 'Review flag failed')
  revalidatePath(`/o/${orgSlug}/m/visual-messaging/conversations/${conversationId}`)
}

// Moderator-only RPCs (vm_can_moderate / vm_is_conv_admin re-checked inside
// each definer function — the app never trusts a client-side "is moderator"
// flag).
export async function tombstoneLayer(orgSlug: string, conversationId: string, layerId: string, formData: FormData) {
  const reason = String(formData.get('reason') ?? '').trim()
  const supabase = await createClient()
  const { error } = await supabase.rpc('vm_tombstone_layer', {
    check_layer_id: layerId,
    check_reason: reason || null,
  })
  fail(error, 'Remove layer failed')
  revalidatePath(`/o/${orgSlug}/m/visual-messaging/conversations/${conversationId}`)
}

export async function restoreLayer(orgSlug: string, conversationId: string, layerId: string) {
  const supabase = await createClient()
  const { error } = await supabase.rpc('vm_restore_layer', { check_layer_id: layerId })
  fail(error, 'Restore layer failed')
  revalidatePath(`/o/${orgSlug}/m/visual-messaging/conversations/${conversationId}`)
}

export async function setBranchFrozen(orgSlug: string, conversationId: string, layerId: string, frozen: boolean) {
  const supabase = await createClient()
  const { error } = await supabase.rpc('vm_set_branch_frozen', { check_layer_id: layerId, check_frozen: frozen })
  fail(error, 'Freeze branch failed')
  revalidatePath(`/o/${orgSlug}/m/visual-messaging/conversations/${conversationId}`)
}

export async function toggleReaction(
  orgSlug: string,
  conversationId: string,
  layerId: string,
  kind: 'heart' | 'laugh',
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')

  const { data: existing } = await supabase
    .from('vm_reactions')
    .select('id')
    .eq('layer_id', layerId)
    .eq('user_id', user.id)
    .eq('kind', kind)
    .maybeSingle()

  if (existing) {
    const { error } = await supabase.from('vm_reactions').delete().eq('id', existing.id)
    fail(error, 'Remove reaction failed')
  } else {
    const { data: org } = await supabase.from('orgs').select('id').eq('slug', orgSlug).single()
    const { error } = await supabase.from('vm_reactions').insert({
      org_id: org!.id,
      conversation_id: conversationId,
      layer_id: layerId,
      user_id: user.id,
      kind,
    })
    fail(error, 'React failed')
  }
  revalidatePath(`/o/${orgSlug}/m/visual-messaging/conversations/${conversationId}`)
}
