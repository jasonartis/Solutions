'use client'

// Zoomed-out tree view (module 4 spec: "zoom out to see the whole tree").
// Every layer renders as a small composited thumbnail — the root image plus
// the strokes of its ancestor chain and its own — laid out in path order and
// grouped by depth, each clickable to jump into that layer. Rendered fully
// client-side from data the conversation page already loads (no server
// rasterizer needed at this scale; a worker thumbnail job is the upgrade
// path if conversations grow into hundreds of layers).

import { useMemo, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Stage, Layer, Line, Text as KonvaText, Image as KonvaImage } from 'react-konva'
import { getStroke } from 'perfect-freehand'
import type { Stroke, Stamp } from './layer-canvas'

export type GridLayer = {
  id: string
  path: string
  parentId: string | null
  strokes: Stroke[]
  stamps: Stamp[]
  tombstoned: boolean
  author: string
}

const THUMB_W = 150

function strokeToPolygon(stroke: Stroke): number[] {
  const outline = getStroke(stroke.points, { size: stroke.size, thinning: 0.6, smoothing: 0.5 })
  return outline.flatMap((p) => [p[0]!, p[1]!])
}

export default function LayerGrid(props: {
  imageUrl: string
  layers: GridLayer[]
  currentId: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [img, setImg] = useState<HTMLImageElement | null>(null)

  useMemo(() => {
    if (typeof window === 'undefined') return
    const el = new window.Image()
    el.crossOrigin = 'anonymous'
    el.onload = () => setImg(el)
    el.src = props.imageUrl
  }, [props.imageUrl])

  const natural = { w: img?.naturalWidth || 800, h: img?.naturalHeight || 600 }
  const scale = THUMB_W / natural.w
  const thumbH = natural.h * scale

  // Ancestor-chain content per layer (composited context), computed once.
  const byId = useMemo(() => new Map(props.layers.map((l) => [l.id, l])), [props.layers])
  const chainStrokes = (layer: GridLayer): Stroke[] => {
    const acc: Stroke[] = []
    let cursor: GridLayer | undefined = layer
    while (cursor) {
      acc.unshift(...cursor.strokes)
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
    }
    return acc
  }
  const chainStamps = (layer: GridLayer): Stamp[] => {
    const acc: Stamp[] = []
    let cursor: GridLayer | undefined = layer
    while (cursor) {
      acc.unshift(...cursor.stamps)
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
    }
    return acc
  }

  // Group by depth so the grid reads as tree levels (path "1.2.1" = depth 3).
  const depths = new Map<number, GridLayer[]>()
  for (const l of props.layers) {
    const d = l.path.split('.').length
    if (!depths.has(d)) depths.set(d, [])
    depths.get(d)!.push(l)
  }

  return (
    <div data-testid="layer-grid">
      {[...depths.entries()]
        .sort(([a], [b]) => a - b)
        .map(([depth, layers]) => (
          <div key={depth} className="mb-4">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-400">
              Level {depth}
            </p>
            <div className="flex flex-wrap gap-3">
              {layers.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => router.push(`${pathname}?layer=${l.id}`)}
                  className={
                    'rounded border text-left ' +
                    (l.id === props.currentId
                      ? 'border-blue-600 ring-2 ring-blue-200'
                      : 'border-gray-300 hover:border-blue-400')
                  }
                  aria-label={`open layer ${l.path}`}
                >
                  <div className="overflow-hidden rounded-t bg-white" style={{ width: THUMB_W, height: thumbH }}>
                    <Stage width={THUMB_W} height={thumbH} scaleX={scale} scaleY={scale} listening={false}>
                      <Layer>
                        {img && <KonvaImage image={img} width={natural.w} height={natural.h} />}
                      </Layer>
                      <Layer>
                        {/* Tombstoned layers arrive with strokes/stamps=[]
                            from the page, so removed content never renders
                            here. */}
                        {chainStrokes(l).map((s, i) => (
                          <Line key={i} points={strokeToPolygon(s)} closed fill={s.color} />
                        ))}
                        {chainStamps(l).map((st, i) => (
                          <KonvaText
                            key={`s${i}`}
                            text={st.emoji}
                            fontSize={st.fontSize}
                            x={st.x}
                            y={st.y}
                            offsetX={st.fontSize / 2}
                            offsetY={st.fontSize / 2}
                          />
                        ))}
                      </Layer>
                    </Stage>
                  </div>
                  <p className="px-1.5 py-0.5 text-[11px] text-gray-500">
                    {l.path} · {l.author}
                    {l.tombstoned && <span className="ml-1 uppercase text-red-500">removed</span>}
                  </p>
                </button>
              ))}
            </div>
          </div>
        ))}
    </div>
  )
}
