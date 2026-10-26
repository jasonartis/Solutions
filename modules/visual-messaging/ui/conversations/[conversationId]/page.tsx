import Link from 'next/link'
import { notFound } from 'next/navigation'
import { FORMER_MEMBER_LABEL, loadFormerMembers } from '@platform/core'
import { createClient } from '@/lib/supabase/server'
import { requireOrgModule } from '@/lib/module-gate'
import { PENDING_INVITE_WAITING_ON } from '@/lib/org-members'
import { resolveVisualMessagingSettings, type VisualMessagingSettings } from '@/lib/visual-messaging-settings'
import LayerCanvas, { type Stroke, type Stamp, type TextStamp, type ImageStamp } from '../../layer-canvas'
import LayerGrid from '../../layer-grid'
import { ActionForm } from '../../action-form'
import {
  acceptConversationInvite,
  addMember,
  cancelConversationInvite,
  declineAndBlockConversationInvite,
  declineConversationInvite,
  flagLayer,
  joinConversation,
  replyWithDrawing,
  resendConversationInvite,
  restoreLayer,
  renameConversation,
  reviewFlag,
  setBranchFrozen,
  setJoinPolicy,
  toggleReaction,
  tombstoneLayer,
  uploadImageStamp,
} from '../../actions'

type LayerRow = {
  id: string
  parent_layer_id: string | null
  path: string
  author_id: string
  content: {
    image?: { path: string }
    strokes?: Stroke[]
    stamps?: Stamp[]
    texts?: TextStamp[]
    images?: ImageStamp[]
  }
  tombstoned: boolean
  frozen: boolean
  created_at: string
  child_count: number
}

// One conversation: view a layer composited on its ancestors, descend into
// replies, reply by drawing. ?layer=<id> selects the viewed layer (root by
// default). Navigation v1 is click-based (breadcrumb up, reply list down);
// the swipe/gesture PWA shell comes later.
export default async function ConversationPage(props: {
  params: Promise<{ orgSlug: string; conversationId: string }>
  searchParams: Promise<{ layer?: string; view?: string }>
}) {
  const { orgSlug, conversationId } = await props.params
  const { layer: layerParam, view } = await props.searchParams
  const treeView = view === 'tree'
  const { supabase, org, settings } = await requireOrgModule(orgSlug, 'visual-messaging')
  const { imageStampMaxFraction, imageStampOpacity } = resolveVisualMessagingSettings(
    settings as VisualMessagingSettings | undefined,
  )

  const { data: conversation } = await supabase
    .from('vm_conversations')
    .select('id, title, frozen, settings')
    .eq('id', conversationId)
    .maybeSingle()

  // A null row here means the caller is past requireOrgModule (so they're an
  // org-module member) but is NOT a member of THIS conversation — RLS hid it.
  // Offer a deep-link join: vm_join_conversation grants a viewer seat only if
  // the conversation's joinPolicy is 'open' (invite-only / banned / unknown
  // all refuse server-side). We can't reveal the title — no read access yet.
  if (!conversation) {
    // Invited but not yet accepted? The seat row is readable to its holder
    // (vm_members_select's user_id = auth.uid() arm) even though the
    // conversation is not, so offer accept/decline instead of a deep-link join.
    // The title comes from the same definer the landing page uses.
    // Invitations held for this person's ADDRESS turn into pending seats first
    // (docs/25 §12), so one that just became ready shows up here. Never allowed
    // to break the page; log the code only, never the address.
    const { error: claimError } = await supabase.rpc('pending_invites_claim_mine')
    if (claimError) console.error('pending_invites_claim_mine failed', claimError.code)
    const { data: invites } = await supabase.rpc('vm_my_pending_invites', { check_org_id: org.id })
    const invite = ((invites ?? []) as { conversation_id: string; title: string; invited_by_name: string | null }[]).find(
      (i) => i.conversation_id === conversationId,
    )
    if (invite) {
      return (
        <div className="mx-auto max-w-md py-12 text-center">
          <p className="mb-1 text-sm text-gray-400">{org.name}</p>
          <h1 className="mb-3 text-xl font-semibold">You&apos;re invited to “{invite.title}”</h1>
          <p className="mb-6 text-sm text-gray-500">
            {invite.invited_by_name ?? 'A member'} invited you. You won&apos;t see its pictures or replies until you
            accept.
          </p>
          <div className="flex justify-center gap-2">
            <ActionForm action={acceptConversationInvite.bind(null, orgSlug, conversationId)}>
              <button className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
                Accept
              </button>
            </ActionForm>
            <ActionForm action={declineConversationInvite.bind(null, orgSlug, conversationId)}>
              <button className="rounded border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50">Decline</button>
            </ActionForm>
            <ActionForm action={declineAndBlockConversationInvite.bind(null, orgSlug, conversationId)}>
              <button className="rounded border border-red-200 px-4 py-2 text-sm text-red-700 hover:bg-red-50">
                Decline and block
              </button>
            </ActionForm>
          </div>
        </div>
      )
    }
    return (
      <div className="mx-auto max-w-md py-12 text-center">
        <p className="mb-1 text-sm text-gray-400">{org.name}</p>
        <h1 className="mb-3 text-xl font-semibold">Join this conversation?</h1>
        <p className="mb-6 text-sm text-gray-500">
          You reached a shared link to a conversation you haven&apos;t joined. If its owner has
          opened it up, you can join as a read-only viewer.
        </p>
        <ActionForm action={joinConversation.bind(null, orgSlug, conversationId)}>
          <button className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
            Join conversation
          </button>
        </ActionForm>
        <Link
          href={`/o/${orgSlug}/m/visual-messaging`}
          className="mt-4 inline-block text-sm text-blue-600 hover:underline"
        >
          ← Back to conversations
        </Link>
      </div>
    )
  }
  const joinOpen = (conversation.settings as { joinPolicy?: string } | null)?.joinPolicy === 'open'

  const [
    { data: layers },
    { data: reactions },
    { data: profiles },
    { data: canModerate },
    { data: canAdmin },
    { data: me },
  ] = await Promise.all([
    supabase
      .from('vm_layers')
      .select('id, parent_layer_id, path, author_id, content, tombstoned, frozen, created_at, child_count')
      .eq('conversation_id', conversationId)
      .order('path'),
    supabase.from('vm_reactions').select('layer_id, kind').eq('conversation_id', conversationId),
    supabase.from('profiles').select('user_id, display_name'),
    // vm_can_moderate: tombstone/restore/flag-triage. vm_is_conv_admin:
    // add-member, freeze branch, join policy — those RLS paths require the
    // admin tier, so the UI must gate on it too or a plain moderator would
    // see buttons that error.
    supabase.rpc('vm_can_moderate', { check_conversation_id: conversationId }),
    supabase.rpc('vm_is_conv_admin', { check_conversation_id: conversationId }),
    supabase.auth.getUser().then(({ data }) => ({ data: data.user })),
  ])
  const rows = (layers ?? []) as LayerRow[]
  const root = rows.find((l) => l.parent_layer_id === null)
  if (!root) notFound()

  // A viewer seat may watch but not draw (vm_can_post gates the RLS insert
  // policy the same way) — fetched separately since it needs `me`'s id,
  // which the parallel batch above doesn't have until it resolves.
  const { data: myMembership } = me
    ? await supabase
        .from('vm_conversation_members')
        .select('role, status')
        .eq('conversation_id', conversationId)
        .eq('user_id', me.id)
        .maybeSingle()
    : { data: null }
  // Status matters too: a creator always resolves the conversation (the
  // created_by arm), so their seat may be pending or banned — vm_can_post
  // would refuse, and the button must not offer what RLS denies.
  // Invitations waiting to be used (docs/25 §12). An org admin gets every one
  // for this conversation with what it is waiting for; any other conversation
  // admin gets only the ones they sent, with no reason (a reason would say
  // whether the address is in the org). The database decides which.
  const { data: heldInviteRows } = canAdmin
    ? await supabase.rpc('pending_invites_list', { check_org_id: org.id, check_target_id: conversationId })
    : { data: [] }
  const heldInvites = (heldInviteRows ?? []) as {
    id: string
    email: string
    expires_at: string
    invited_by: string
    waiting_on: string | null
  }[]

  const canPost =
    myMembership?.status === 'active' &&
    (myMembership.role === 'participant' || myMembership.role === 'conversation_moderator' || myMembership.role === 'admin')

  const current = rows.find((l) => l.id === layerParam) ?? root
  const byId = new Map(rows.map((l) => [l.id, l]))

  // Ancestor chain root→current (composited under the current layer).
  const chain: LayerRow[] = []
  let cursor: LayerRow | undefined = current
  while (cursor) {
    chain.unshift(cursor)
    cursor = cursor.parent_layer_id ? byId.get(cursor.parent_layer_id) : undefined
  }
  const imagePath = root.content.image?.path
  const { data: signed } = imagePath
    ? await supabase.storage.from('vm-images').createSignedUrl(imagePath, 3600)
    : { data: null }

  // Image stamps (attached photos, distinct from the root background above)
  // reference private storage paths — sign every distinct one across the
  // WHOLE conversation in one batch (tree view needs every layer's, not just
  // the current chain's).
  const stampPaths = [...new Set(rows.flatMap((l) => (l.content.images ?? []).map((im) => im.path)))]
  const { data: signedStamps } = stampPaths.length
    ? await supabase.storage.from('vm-images').createSignedUrls(stampPaths, 3600)
    : { data: null }
  const stampUrl = new Map((signedStamps ?? []).map((s) => [s.path, s.signedUrl]))
  const resolveImages = (images: ImageStamp[]) =>
    images
      .map((im) => ({ ...im, url: stampUrl.get(im.path) ?? '' }))
      .filter((im) => im.url)

  const nameOf = (id: string) => {
    if (formerIds.has(id)) return FORMER_MEMBER_LABEL
    const p = (profiles ?? []).find((pr) => pr.user_id === id)
    return p?.display_name || 'Someone'
  }
  const children = rows.filter((l) => l.parent_layer_id === current.id)
  const reactionCount = (layerId: string, kind: string) =>
    (reactions ?? []).filter((r) => r.layer_id === layerId && r.kind === kind).length
  const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const locked = conversation.frozen || chain.some((l) => l.frozen)

  // THE CAROUSEL (founder, 2026-10-19: "every layer and the layers it can swipe to should
  // be loaded and ready"). The canvas switches layers ITSELF the instant a swipe completes,
  // so it is given the layer TREE plus the OWN content (a reply is stored as just what it
  // added — no picture, no ancestors) of a WINDOW of layers: every ancestor of the layer on
  // screen (they are composited under it) and everything within two hops of it (parent,
  // children, siblings, and one step beyond), so two swipes in a row still need nothing from
  // the server. The server's page then catches up quietly (breadcrumb, replies list).
  // A very large conversation stays bounded: the window, not the whole tree.
  const tree = rows.map((l) => ({
    id: l.id,
    parentId: l.parent_layer_id,
    frozen: l.frozen,
    tombstoned: l.tombstoned,
  }))
  const neighbours = new Map<string, string[]>()
  for (const l of rows) {
    if (!l.parent_layer_id) continue
    neighbours.set(l.id, [...(neighbours.get(l.id) ?? []), l.parent_layer_id])
    neighbours.set(l.parent_layer_id, [...(neighbours.get(l.parent_layer_id) ?? []), l.id])
  }
  // Walk two hops from the layer on screen. The walk keeps its OWN visited set: the ancestors
  // are in the window anyway, and seeding the walk with them stopped it at the parent, so the
  // siblings (parent's other children — what an up/down swipe needs) were never reached.
  const visited = new Set<string>([current.id])
  let frontier = [current.id]
  for (let hop = 0; hop < 2; hop++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const n of neighbours.get(id) ?? []) {
        if (!visited.has(n)) {
          visited.add(n)
          next.push(n)
        }
      }
    }
    frontier = next
  }
  const windowIds = new Set<string>([...chain.map((l) => l.id), ...visited]) // ancestors + the walk
  const layersContent = Object.fromEntries(
    [...windowIds].map((id) => {
      const l = byId.get(id)!
      return [
        id,
        {
          strokes: l.content.strokes ?? [],
          stamps: l.content.stamps ?? [],
          texts: l.content.texts ?? [],
          images: resolveImages(l.content.images ?? []),
        },
      ]
    }),
  )

  const sendReply = replyWithDrawing.bind(null, orgSlug, conversationId)
  const pathOf = (id: string) => byId.get(id)?.path ?? '?'

  // Moderation queue: only fetched for moderators (vm_flags RLS would only
  // return the caller's own reports otherwise, which isn't useful here).
  const { data: flags } = canModerate
    ? await supabase
        .from('vm_flags')
        .select('id, layer_id, reporter_user_id, reason, detail, state, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
    : { data: null }
  const openFlagCount = (flags ?? []).filter((f) => f.state === 'open').length
  // docs/21 §7.5 — THE CASE THAT STARTED IT. A deleted author's layers are
  // kept (others drew underneath them), but a silhouette has no org membership,
  // so its profile row is invisible and `nameOf` would print "Someone" — the
  // same thing a live member with an unreadable profile prints. Former members
  // get their own label. Declared here, after `flags`, so abuse reporters are
  // covered too; `nameOf` above only runs during render, after this line.
  const formerIds = await loadFormerMembers(supabase, [
    ...rows.map((l) => l.author_id),
    ...(flags ?? []).map((f) => f.reporter_user_id),
  ])

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <div className="mb-2 flex items-baseline gap-4">
        <h1 className="text-2xl font-semibold">{conversation.title}</h1>
        <Link href={`/o/${orgSlug}/m/visual-messaging`} className="text-sm text-blue-600 hover:underline">
          ← Conversations
        </Link>
      </div>
      {/* Rename: the conversation admin's (vm_conversations_update_admin). */}
      {canAdmin && (
        <details className="mb-3 text-sm">
          <summary className="cursor-pointer text-gray-400 hover:text-gray-600">Rename this conversation</summary>
          <ActionForm
            action={renameConversation.bind(null, orgSlug, conversationId)}
            className="mt-2 flex flex-wrap items-center gap-2"
            submitLabel="Save name"
            doneLabel="Saved ✓"
            submitClassName="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700"
            doneClassName="rounded bg-green-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-100"
          >
            <input
              name="title"
              required
              maxLength={120}
              defaultValue={conversation.title}
              aria-label="conversation name"
              className="min-w-56 rounded border border-gray-300 px-2 py-1 text-sm"
            />
          </ActionForm>
        </details>
      )}

      {/* Breadcrumb: the layer address, each segment linking up the chain. */}
      <p className="mb-4 text-sm text-gray-500">
        <Link
          href={treeView ? `?layer=${current.id}` : `?layer=${current.id}&view=tree`}
          className="mr-3 rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50"
        >
          {treeView ? 'Back to layer' : 'Tree view'}
        </Link>
        Layer{' '}
        {chain.map((l, i) => (
          <span key={l.id}>
            {i > 0 && ' · '}
            <Link href={`?layer=${l.id}`} className={l.id === current.id ? 'font-semibold text-gray-700' : 'text-blue-600 hover:underline'}>
              {l.path}
            </Link>
          </span>
        ))}
        <span className="ml-3 text-xs text-gray-400">
          by {nameOf(current.author_id)} · {fmt.format(new Date(current.created_at))}
          {current.tombstoned && <span className="ml-2 uppercase text-red-500">removed</span>}
          {locked && <span className="ml-2 uppercase text-amber-600">frozen</span>}
        </span>
      </p>

      {!signed?.signedUrl ? (
        <p className="text-sm text-gray-500">The root image is unavailable.</p>
      ) : treeView ? (
        <LayerGrid
          imageUrl={signed.signedUrl}
          currentId={current.id}
          layers={rows.map((l) => ({
            id: l.id,
            path: l.path,
            parentId: l.parent_layer_id,
            strokes: l.tombstoned ? [] : (l.content.strokes ?? []),
            stamps: l.tombstoned ? [] : (l.content.stamps ?? []),
            texts: l.tombstoned ? [] : (l.content.texts ?? []),
            images: l.tombstoned ? [] : resolveImages(l.content.images ?? []),
            tombstoned: l.tombstoned,
            author: nameOf(l.author_id),
          }))}
        />
      ) : (
        <LayerCanvas
          imageUrl={signed.signedUrl}
          currentLayerId={current.id}
          tree={tree}
          layersContent={layersContent}
          canPost={canPost}
          conversationFrozen={conversation.frozen}
          onSend={sendReply}
          onUploadImage={uploadImageStamp.bind(null, orgSlug, conversationId)}
          imageStampMaxFraction={imageStampMaxFraction}
          imageStampOpacity={imageStampOpacity}
        />
      )}

      <div className="mt-3 flex items-center gap-3 text-sm">
        <ActionForm action={toggleReaction.bind(null, orgSlug, conversationId, current.id, 'heart')}>
          <button className="rounded border border-gray-200 px-2 py-0.5 hover:bg-gray-50">
            ❤️ {reactionCount(current.id, 'heart')}
          </button>
        </ActionForm>
        <ActionForm action={toggleReaction.bind(null, orgSlug, conversationId, current.id, 'laugh')}>
          <button className="rounded border border-gray-200 px-2 py-0.5 hover:bg-gray-50">
            😂 {reactionCount(current.id, 'laugh')}
          </button>
        </ActionForm>
      </div>

      {me && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-gray-400 hover:text-gray-600">Flag this layer</summary>
          <ActionForm
            action={flagLayer.bind(null, orgSlug, conversationId, current.id)}
            className="mt-2 flex flex-col gap-2 rounded border border-gray-200 p-3 sm:flex-row sm:items-center"
            submitLabel="Flag"
            doneLabel="Flagged ✓"
            successMessage="Thanks — a moderator will take a look."
            submitClassName="rounded border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50"
            doneClassName="rounded border border-green-600 bg-green-50 px-3 py-1 text-sm text-green-700"
          >
            <select name="reason" required className="rounded border border-gray-300 px-2 py-1 text-sm">
              <option value="">Reason…</option>
              <option value="inappropriate">Inappropriate content</option>
              <option value="harassment">Harassment</option>
              <option value="spam">Spam</option>
              <option value="other">Other</option>
            </select>
            <input
              name="detail"
              placeholder="Details (optional)"
              className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
            />
          </ActionForm>
        </details>
      )}

      <section className="mt-6">
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-gray-500">
          Replies to this layer ({children.length})
        </h2>
        <ul className="space-y-1 text-sm">
          {children.map((c) => (
            <li key={c.id}>
              <Link href={`?layer=${c.id}`} className="text-blue-600 hover:underline">
                Layer {c.path}
              </Link>{' '}
              <span className="text-gray-400">
                by {nameOf(c.author_id)} · {c.child_count} repl{c.child_count === 1 ? 'y' : 'ies'}
                {c.tombstoned && <span className="ml-1 uppercase text-red-500">removed</span>}
              </span>
            </li>
          ))}
          {children.length === 0 && <li className="text-gray-400">No replies yet — draw one above.</li>}
        </ul>
      </section>

      {canModerate && (
        <section className="mt-8 border-t border-gray-100 pt-4">
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-gray-500">
            Moderation
          </h2>
          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
            {current.tombstoned ? (
              <ActionForm action={restoreLayer.bind(null, orgSlug, conversationId, current.id)}>
                <button className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50">
                  Restore this layer
                </button>
              </ActionForm>
            ) : (
              <ActionForm
                action={tombstoneLayer.bind(null, orgSlug, conversationId, current.id)}
                className="flex flex-wrap items-center gap-2"
              >
                <input
                  name="reason"
                  placeholder="Reason (optional)"
                  className="rounded border border-gray-300 px-2 py-1 text-xs"
                />
                <button className="rounded border border-red-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50">
                  Remove this layer
                </button>
              </ActionForm>
            )}
            {/* Freeze requires the conversation-admin tier (vm_set_branch_frozen). */}
            {canAdmin && (
              <ActionForm action={setBranchFrozen.bind(null, orgSlug, conversationId, current.id, !current.frozen)}>
                <button className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50">
                  {current.frozen ? 'Unfreeze this branch' : 'Freeze this branch'}
                </button>
              </ActionForm>
            )}
          </div>

          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-400">
            Flagged content ({openFlagCount} open)
          </h3>
          <ul className="mb-6 space-y-2 text-sm">
            {(flags ?? []).map((f) => (
              <li key={f.id} className="rounded border border-gray-200 p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`?layer=${f.layer_id}`} className="text-blue-600 hover:underline">
                    Review layer {pathOf(f.layer_id)}
                  </Link>
                  <span className="text-gray-500">
                    {f.reason}
                    {f.detail ? ` — ${f.detail}` : ''} · reported by {nameOf(f.reporter_user_id)}
                  </span>
                  <span
                    className={
                      f.state === 'open'
                        ? 'text-amber-600'
                        : f.state === 'actioned'
                          ? 'text-red-600'
                          : 'text-gray-400'
                    }
                  >
                    {f.state}
                  </span>
                </div>
                {f.state === 'open' && (
                  <div className="mt-1 flex gap-2">
                    <ActionForm action={reviewFlag.bind(null, orgSlug, conversationId, f.id, 'actioned')}>
                      <button className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50">
                        Mark actioned
                      </button>
                    </ActionForm>
                    <ActionForm action={reviewFlag.bind(null, orgSlug, conversationId, f.id, 'dismissed')}>
                      <button className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50">
                        Dismiss
                      </button>
                    </ActionForm>
                  </div>
                )}
              </li>
            ))}
            {(flags ?? []).length === 0 && <li className="text-gray-400">No flags in this conversation.</li>}
          </ul>

          {/* Membership + join policy require the conversation-admin tier
              (vm_members_insert / vm_conversations_update_admin) — a plain
              moderator sees the moderation controls above but not these. */}
          {canAdmin && (
            <>
              <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-gray-500">
                Members (admin)
              </h2>

              {/* Deep-link join policy: whether an org member with the link can
                  join as a viewer without an explicit invite (spec setting). */}
              <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-gray-500">
                  Link joining: <span className="font-medium">{joinOpen ? 'open' : 'invite-only'}</span>
                </span>
                <ActionForm action={setJoinPolicy.bind(null, orgSlug, conversationId, !joinOpen)}>
                  <button className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50">
                    {joinOpen ? 'Make invite-only' : 'Open to anyone with the link'}
                  </button>
                </ActionForm>
              </div>

              <ActionForm
                action={addMember.bind(null, orgSlug, conversationId)}
                className="flex flex-wrap items-center gap-2"
                submitLabel="Invite member"
                doneLabel="Invited ✓"
                // Same words for every address — no account, not in the org,
                // already here, or blocked this conversation. The action
                // deliberately does not tell the admin which (docs/25 §4.2.3).
                successMessage="Invitation saved. No email is sent, so let them know. They will see it in Visual Messaging once they sign in with that address and can use Visual Messaging here."
                submitClassName="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700"
            doneClassName="rounded bg-green-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-100"
              >
                <input
                  name="email"
                  type="email"
                  required
                  placeholder="member@email"
                  className="rounded border border-gray-300 px-2 py-1 text-sm"
                />
              </ActionForm>

              <h3 className="mb-2 mt-4 text-xs font-medium text-gray-600">Invitations waiting to be used</h3>
              {heldInvites.length === 0 ? (
                <p className="text-xs text-gray-400">None right now.</p>
              ) : (
                <ul className="space-y-2">
                  {heldInvites.map((inv) => {
                    const left = Math.ceil((new Date(inv.expires_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000))
                    return (
                      <li
                        key={inv.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded border border-dashed border-gray-300 bg-white p-2 text-sm"
                      >
                        <span>
                          <span className="font-medium">{inv.email}</span>
                          <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                            {PENDING_INVITE_WAITING_ON[inv.waiting_on ?? ''] ?? 'Pending'}
                          </span>
                          <span className="ml-2 text-xs text-gray-400">
                            {inv.invited_by === me?.id ? 'by you · ' : ''}
                            {left <= 0 ? 'expired' : left === 1 ? 'expires within a day' : `expires in ${left} days`}
                          </span>
                        </span>
                        <span className="flex items-center gap-2">
                          <ActionForm action={resendConversationInvite.bind(null, orgSlug, conversationId, inv.id)}>
                            <button className="text-xs text-blue-600 hover:underline">Resend (30 more days)</button>
                          </ActionForm>
                          <ActionForm action={cancelConversationInvite.bind(null, orgSlug, conversationId, inv.id)}>
                            <button className="text-xs text-red-600 hover:underline">Cancel</button>
                          </ActionForm>
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
              <p className="mt-2 max-w-xl text-xs text-gray-400">
                An invitation and the address in it are deleted when it is used, cancelled, or 30 days after it was
                last sent. Inviting someone here never adds them to the organization.
              </p>
            </>
          )}
        </section>
      )}
    </div>
  )
}
