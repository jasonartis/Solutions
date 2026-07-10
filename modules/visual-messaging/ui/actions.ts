'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

// Visual-messaging actions. RLS + the vm_ guard triggers are the enforcement
// layer: the creator-insert policy + member bootstrap start a conversation;
// the reply guard assigns paths atomically server-side (client-supplied
// path/child_count are ignored); frozen/tombstoned parents reject replies.

function fail(error: { message: string } | null, what: string) {
  if (error) throw new Error(`${what}: ${error.message}`)
}

// Layer content vocabulary (Zod-light for v1; the canvas produces exactly
// this shape): a root layer carries the image; replies carry strokes drawn
// in IMAGE pixel space so every zoom level stays registered.
export type Stroke = { points: number[][]; color: string; size: number }

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
  strokesJson: string,
) {
  const strokes = JSON.parse(strokesJson) as Stroke[]
  if (!Array.isArray(strokes) || strokes.length === 0) throw new Error('Draw something first')
  for (const s of strokes) {
    if (!Array.isArray(s.points) || s.points.length < 2 || typeof s.color !== 'string' || typeof s.size !== 'number') {
      throw new Error('Malformed drawing')
    }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')
  const { data: org } = await supabase.from('orgs').select('id').eq('slug', orgSlug).single()

  const { error } = await supabase.from('vm_layers').insert({
    org_id: org!.id,
    conversation_id: conversationId,
    parent_layer_id: parentLayerId,
    author_id: user.id,
    path: 'server-assigned',
    content: { strokes },
  })
  fail(error, 'Send reply failed')
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
