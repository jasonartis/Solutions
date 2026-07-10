'use client'

// The drawing surface (docs/02: Konva + perfect-freehand). Renders the root
// image with every ancestor layer's strokes composited on top ("viewing layer
// L renders L on its ancestors only"), and optionally captures a new drawing.
// Stroke points are stored in IMAGE pixel space, so layers stay registered at
// any display scale (the plans/zoom use case).

import { useMemo, useRef, useState, useTransition } from 'react'
import { Stage, Layer, Line, Image as KonvaImage } from 'react-konva'
import { getStroke } from 'perfect-freehand'

export type Stroke = { points: number[][]; color: string; size: number }

const COLORS = ['#e11d48', '#2563eb', '#16a34a', '#f59e0b', '#111111', '#ffffff']

function strokeToPolygon(stroke: Stroke): number[] {
  const outline = getStroke(stroke.points, { size: stroke.size, thinning: 0.6, smoothing: 0.5 })
  return outline.flatMap((p) => [p[0]!, p[1]!])
}

export default function LayerCanvas(props: {
  imageUrl: string
  /** ancestor strokes, root-first; faded when xray is on */
  baseLayers: Stroke[][]
  /** the layer being viewed (rendered full-strength) */
  currentStrokes: Stroke[]
  drawable: boolean
  onSend?: (strokesJson: string) => Promise<void>
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [drawing, setDrawing] = useState(false)
  const [draft, setDraft] = useState<Stroke[]>([])
  const [color, setColor] = useState(COLORS[0]!)
  const [size, setSize] = useState(6)
  const [xray, setXray] = useState(false)
  const [pending, startTransition] = useTransition()
  const activeStroke = useRef<number[][] | null>(null)

  // Load the image once (no extra dependency; Konva takes a DOM image).
  useMemo(() => {
    if (typeof window === 'undefined') return
    const el = new window.Image()
    el.crossOrigin = 'anonymous'
    el.onload = () => setImg(el)
    el.src = props.imageUrl
  }, [props.imageUrl])

  const natural = { w: img?.naturalWidth || 800, h: img?.naturalHeight || 600 }
  const displayW = Math.min(640, natural.w)
  const scale = displayW / natural.w
  const displayH = natural.h * scale

  const toImageSpace = (stage: any): number[] | null => {
    const pos = stage?.getPointerPosition()
    if (!pos) return null
    return [pos.x / scale, pos.y / scale]
  }

  const handleDown = (e: any) => {
    if (!props.drawable) return
    const pt = toImageSpace(e.target.getStage())
    if (!pt) return
    activeStroke.current = [pt]
    setDrawing(true)
  }
  const handleMove = (e: any) => {
    if (!drawing || !activeStroke.current) return
    const pt = toImageSpace(e.target.getStage())
    if (!pt) return
    activeStroke.current.push(pt)
    // re-render with the live stroke
    setDraft((d) => [...d.filter((s) => s !== LIVE), { ...LIVE, points: [...activeStroke.current!], color, size }])
  }
  const LIVE = useMemo(() => ({ points: [] as number[][], color: '', size: 0 }), [])
  const handleUp = () => {
    if (!drawing || !activeStroke.current) return
    const pts = activeStroke.current
    activeStroke.current = null
    setDrawing(false)
    setDraft((d) => [...d.filter((s) => s !== LIVE && s.points.length > 0), { points: pts, color, size }])
  }

  const send = () => {
    if (!props.onSend || draft.length === 0) return
    const payload = JSON.stringify(draft.filter((s) => s.points.length >= 2))
    startTransition(async () => {
      await props.onSend!(payload)
      setDraft([])
    })
  }

  return (
    <div>
      <div
        className="inline-block overflow-hidden rounded border border-gray-300 bg-white"
        style={{ touchAction: props.drawable ? 'none' : 'auto' }}
      >
        <Stage
          width={displayW}
          height={displayH}
          scaleX={scale}
          scaleY={scale}
          onPointerDown={handleDown}
          onPointerMove={handleMove}
          onPointerUp={handleUp}
        >
          <Layer>
            {img && <KonvaImage image={img} width={natural.w} height={natural.h} />}
          </Layer>
          <Layer opacity={xray ? 0.15 : 1}>
            {props.baseLayers.flatMap((layerStrokes, li) =>
              layerStrokes.map((s, si) => (
                <Line key={`b${li}-${si}`} points={strokeToPolygon(s)} closed fill={s.color} />
              )),
            )}
          </Layer>
          <Layer opacity={xray ? 0.15 : 1}>
            {props.currentStrokes.map((s, i) => (
              <Line key={`c${i}`} points={strokeToPolygon(s)} closed fill={s.color} />
            ))}
          </Layer>
          <Layer>
            {draft
              .filter((s) => s.points.length >= 2)
              .map((s, i) => (
                <Line key={`d${i}`} points={strokeToPolygon(s)} closed fill={s.color} />
              ))}
          </Layer>
        </Stage>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        <button
          type="button"
          onMouseDown={() => setXray(true)}
          onMouseUp={() => setXray(false)}
          onMouseLeave={() => setXray(false)}
          className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600"
          title="Press and hold to fade the layers"
        >
          Hold to X-ray
        </button>
        {props.drawable && (
          <>
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className="h-6 w-6 rounded-full border"
                style={{ backgroundColor: c, outline: c === color ? '2px solid #2563eb' : 'none' }}
                aria-label={`pen ${c}`}
              />
            ))}
            <input
              type="range"
              min={2}
              max={24}
              value={size}
              onChange={(e) => setSize(Number(e.target.value))}
              className="w-24"
              aria-label="pen size"
            />
            <button
              type="button"
              onClick={() => setDraft([])}
              className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600"
            >
              Clear draft
            </button>
            <button
              type="button"
              onClick={send}
              disabled={pending || draft.length === 0}
              className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {pending ? 'Sending…' : 'Send reply'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
