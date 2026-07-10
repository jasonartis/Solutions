import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { requireOrgModule } from '@/lib/module-gate'
import LayerCanvas, { type Stroke } from '../../layer-canvas'
import LayerGrid from '../../layer-grid'
import { addMember, replyWithDrawing, toggleReaction } from '../../actions'

type LayerRow = {
  id: string
  parent_layer_id: string | null
  path: string
  author_id: string
  content: { image?: { path: string }; strokes?: Stroke[] }
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
  const { supabase, org } = await requireOrgModule(orgSlug, 'visual-messaging')

  const { data: conversation } = await supabase
    .from('vm_conversations')
    .select('id, title, frozen')
    .eq('id', conversationId)
    .maybeSingle()
  if (!conversation) notFound()

  const [{ data: layers }, { data: reactions }, { data: profiles }, { data: canModerate }, { data: me }] =
    await Promise.all([
      supabase
        .from('vm_layers')
        .select('id, parent_layer_id, path, author_id, content, tombstoned, frozen, created_at, child_count')
        .eq('conversation_id', conversationId)
        .order('path'),
      supabase.from('vm_reactions').select('layer_id, kind').eq('conversation_id', conversationId),
      supabase.from('profiles').select('user_id, display_name, email'),
      supabase.rpc('vm_can_moderate', { check_conversation_id: conversationId }),
      supabase.auth.getUser().then(({ data }) => ({ data: data.user })),
    ])
  const rows = (layers ?? []) as LayerRow[]
  const root = rows.find((l) => l.parent_layer_id === null)
  if (!root) notFound()

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

  const nameOf = (id: string) => {
    const p = (profiles ?? []).find((pr) => pr.user_id === id)
    return p?.display_name || p?.email || 'Someone'
  }
  const children = rows.filter((l) => l.parent_layer_id === current.id)
  const reactionCount = (layerId: string, kind: string) =>
    (reactions ?? []).filter((r) => r.layer_id === layerId && r.kind === kind).length
  const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const locked = conversation.frozen || chain.some((l) => l.frozen)

  // Swipe-navigation targets (spec: left = descend, right = up, up/down =
  // cycle siblings). rows are path-ordered, so sibling order is stable.
  const siblings = current.parent_layer_id
    ? rows.filter((l) => l.parent_layer_id === current.parent_layer_id)
    : [current]
  const sibIndex = siblings.findIndex((l) => l.id === current.id)
  const nav = {
    parentId: current.parent_layer_id,
    firstChildId: children[0]?.id ?? null,
    prevSiblingId: sibIndex > 0 ? siblings[sibIndex - 1]!.id : null,
    nextSiblingId: sibIndex >= 0 && sibIndex < siblings.length - 1 ? siblings[sibIndex + 1]!.id : null,
    siblings: siblings.map((l) => ({ id: l.id, current: l.id === current.id })),
  }

  const sendReply = replyWithDrawing.bind(null, orgSlug, conversationId, current.id)

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <div className="mb-2 flex items-baseline gap-4">
        <h1 className="text-2xl font-semibold">{conversation.title}</h1>
        <Link href={`/o/${orgSlug}/m/visual-messaging`} className="text-sm text-blue-600 hover:underline">
          ← Conversations
        </Link>
      </div>

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
            tombstoned: l.tombstoned,
            author: nameOf(l.author_id),
          }))}
        />
      ) : (
        <LayerCanvas
          imageUrl={signed.signedUrl}
          baseLayers={chain.slice(0, -1).map((l) => l.content.strokes ?? [])}
          currentStrokes={current.content.strokes ?? []}
          drawable={!locked && !current.tombstoned && Boolean(me)}
          nav={nav}
          onSend={sendReply}
        />
      )}

      <div className="mt-3 flex items-center gap-3 text-sm">
        <form action={toggleReaction.bind(null, orgSlug, conversationId, current.id, 'heart')}>
          <button className="rounded border border-gray-200 px-2 py-0.5 hover:bg-gray-50">
            ❤️ {reactionCount(current.id, 'heart')}
          </button>
        </form>
        <form action={toggleReaction.bind(null, orgSlug, conversationId, current.id, 'laugh')}>
          <button className="rounded border border-gray-200 px-2 py-0.5 hover:bg-gray-50">
            😂 {reactionCount(current.id, 'laugh')}
          </button>
        </form>
      </div>

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
            Members (admin)
          </h2>
          <form action={addMember.bind(null, orgSlug, conversationId)} className="flex items-center gap-2">
            <input
              name="email"
              type="email"
              required
              placeholder="member@email"
              className="rounded border border-gray-300 px-2 py-1 text-sm"
            />
            <button className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700">
              Add member
            </button>
          </form>
        </section>
      )}
    </div>
  )
}
