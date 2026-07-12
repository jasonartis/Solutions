'use client'

// The drawing/navigation surface (docs/02: Konva + perfect-freehand). Renders
// the root image with every ancestor layer's strokes composited on top, and
// runs in one of two modes (spec: gesture-driven, mobile-first):
//   VIEW — the default. Swipes navigate the layer tree: left = descend into
//          the first reply, right = peel back up to the parent, up/down =
//          cycle siblings. Sibling dots show where you are.
//   DRAW — entered via "Draw a reply". The pointer inks; Send creates the
//          reply layer; Cancel returns to view mode. Drafts never leave the
//          browser until Send.
// Stroke points are stored in IMAGE pixel space, so layers stay registered
// at any display scale (the plans/zoom use case).

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Stage, Layer, Line, Text as KonvaText, Image as KonvaImage } from 'react-konva'
import { getStroke } from 'perfect-freehand'

export type Stroke = { points: number[][]; color: string; size: number }
// x/y are the placed CENTER point in image pixel space (matches Stroke's
// registration approach); fontSize is also in image pixels, so stamps stay
// registered at any display scale, same as strokes.
export type Stamp = { emoji: string; x: number; y: number; fontSize: number }
// Styled text (spec: "styled text (color, angle)") — angle is degrees, same
// rotation convention as Konva's `rotation` prop.
export type TextStamp = { text: string; color: string; x: number; y: number; fontSize: number; angle: number }
// Image stamps (spec: "image stamps (upload, shrink/rotate/place)"). x/y are
// the placed TOP-LEFT corner, width/height the placed box, all image pixels.
// `url` is added by the page (a signed URL for the private vm-images path) —
// not part of what's stored.
export type ImageStamp = {
  path: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  opacity: number
}
export type ResolvedImageStamp = ImageStamp & { url: string }

export type LayerNav = {
  parentId: string | null
  firstChildId: string | null
  prevSiblingId: string | null
  nextSiblingId: string | null
  /** this layer + its siblings, in path order (for the dots) */
  siblings: { id: string; current: boolean }[]
}

const COLORS = ['#e11d48', '#2563eb', '#16a34a', '#f59e0b', '#111111', '#ffffff']
const EMOJIS = ['😀', '😍', '😂', '😢', '😡', '👍', '👎', '❤️', '🔥', '🎉', '⭐', '✅', '❌', '🤔']
const SWIPE_MIN = 60 // px of drag before a gesture counts as a swipe
// Spec's image-stamp guards: "default max stamp size relative to canvas
// (admin/org-tunable)" and "default slight transparency" — the tunable-per-
// org part is deferred (no settings UI yet); these are the fixed v1 defaults.
const IMAGE_STAMP_DEFAULT_FRACTION = 0.3 // of the root image's natural width
const IMAGE_STAMP_DEFAULT_OPACITY = 0.85

function strokeToPolygon(stroke: Stroke): number[] {
  const outline = getStroke(stroke.points, { size: stroke.size, thinning: 0.6, smoothing: 0.5 })
  return outline.flatMap((p) => [p[0]!, p[1]!])
}

// Loads arbitrary URLs into HTMLImageElements for Konva (signed vm-images
// URLs for already-sent stamps, plus local object URLs for an unsent draft —
// both need a real Image() to paint on canvas). Cache persists across
// renders so a URL already loaded isn't re-fetched.
export function useImageCache(urls: string[]): Record<string, HTMLImageElement> {
  const [cache, setCache] = useState<Record<string, HTMLImageElement>>({})
  const key = urls.filter(Boolean).join('|')
  useEffect(() => {
    if (typeof window === 'undefined') return
    for (const url of urls) {
      if (!url || cache[url]) continue
      const el = new window.Image()
      el.crossOrigin = 'anonymous'
      el.onload = () => setCache((c) => (c[url] ? c : { ...c, [url]: el }))
      el.src = url
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return cache
}

export default function LayerCanvas(props: {
  imageUrl: string
  baseLayers: Stroke[][]
  currentStrokes: Stroke[]
  baseStamps: Stamp[][]
  currentStamps: Stamp[]
  baseTexts: TextStamp[][]
  currentTexts: TextStamp[]
  baseImages: ResolvedImageStamp[][]
  currentImages: ResolvedImageStamp[]
  drawable: boolean
  nav: LayerNav
  onSend?: (payloadJson: string) => Promise<void>
  onUploadImage?: (file: File) => Promise<string>
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [mode, setMode] = useState<'view' | 'draw'>('view')
  const [tool, setTool] = useState<'pen' | 'emoji' | 'text' | 'image'>('pen')
  const [drawing, setDrawing] = useState(false)
  const [draft, setDraft] = useState<Stroke[]>([])
  const [stampDraft, setStampDraft] = useState<Stamp[]>([])
  const [textDraft, setTextDraft] = useState<TextStamp[]>([])
  const [imageDraft, setImageDraft] = useState<ImageStamp[]>([])
  const [color, setColor] = useState(COLORS[0]!)
  const [size, setSize] = useState(6)
  const [selectedEmoji, setSelectedEmoji] = useState(EMOJIS[0]!)
  const [stampSize, setStampSize] = useState(48)
  const [textValue, setTextValue] = useState('')
  const [textColor, setTextColor] = useState(COLORS[0]!)
  const [textFontSize, setTextFontSize] = useState(32)
  const [textAngle, setTextAngle] = useState(0)
  const [stagedImage, setStagedImage] = useState<{ path: string; naturalW: number; naturalH: number } | null>(null)
  const [imageObjectUrls, setImageObjectUrls] = useState<Record<string, string>>({})
  const [imageScale, setImageScale] = useState(1)
  const [imageRotation, setImageRotation] = useState(0)
  const [uploadingImage, setUploadingImage] = useState(false)
  const [xray, setXray] = useState(false)
  const [pending, startTransition] = useTransition()
  const activeStroke = useRef<number[][] | null>(null)
  const swipeStart = useRef<{ x: number; y: number } | null>(null)

  const imageCache = useImageCache([
    ...props.baseImages.flatMap((layer) => layer.map((i) => i.url)),
    ...props.currentImages.map((i) => i.url),
    ...Object.values(imageObjectUrls),
  ])

  const resetImageTool = () => {
    Object.values(imageObjectUrls).forEach((url) => URL.revokeObjectURL(url))
    setImageObjectUrls({})
    setStagedImage(null)
    setImageScale(1)
    setImageRotation(0)
  }

  const handleImageFile = async (file: File | null) => {
    if (!file || !props.onUploadImage) return
    setUploadingImage(true)
    try {
      const path = await props.onUploadImage(file)
      const url = URL.createObjectURL(file)
      const naturalSize = await new Promise<{ w: number; h: number }>((resolve) => {
        const el = new window.Image()
        el.onload = () => resolve({ w: el.naturalWidth, h: el.naturalHeight })
        el.src = url
      })
      setImageObjectUrls((m) => ({ ...m, [path]: url }))
      setStagedImage({ path, naturalW: naturalSize.w, naturalH: naturalSize.h })
    } finally {
      setUploadingImage(false)
    }
  }

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

  const goTo = (layerId: string | null) => {
    if (layerId) router.push(`${pathname}?layer=${layerId}`)
  }

  const toImageSpace = (stage: any): number[] | null => {
    const pos = stage?.getPointerPosition()
    if (!pos) return null
    return [pos.x / scale, pos.y / scale]
  }

  const handleDown = (e: any) => {
    const stage = e.target.getStage()
    if (mode === 'draw' && props.drawable) {
      const pt = toImageSpace(stage)
      if (!pt) return
      if (tool === 'emoji') {
        setStampDraft((d) => [...d, { emoji: selectedEmoji, x: pt[0]!, y: pt[1]!, fontSize: stampSize }])
        return
      }
      if (tool === 'text') {
        const text = textValue.trim()
        if (!text) return // nothing typed yet — a tap does nothing
        setTextDraft((d) => [...d, { text, color: textColor, x: pt[0]!, y: pt[1]!, fontSize: textFontSize, angle: textAngle }])
        return
      }
      if (tool === 'image') {
        if (!stagedImage) return // nothing uploaded yet — a tap does nothing
        const baseW = natural.w * IMAGE_STAMP_DEFAULT_FRACTION * imageScale
        const baseH = baseW * (stagedImage.naturalH / stagedImage.naturalW)
        setImageDraft((d) => [
          ...d,
          {
            path: stagedImage.path,
            x: pt[0]! - baseW / 2,
            y: pt[1]! - baseH / 2,
            width: baseW,
            height: baseH,
            rotation: imageRotation,
            opacity: IMAGE_STAMP_DEFAULT_OPACITY,
          },
        ])
        return
      }
      activeStroke.current = [pt]
      setDrawing(true)
    } else {
      const pos = stage?.getPointerPosition()
      if (pos) swipeStart.current = { x: pos.x, y: pos.y }
    }
  }
  const handleMove = (e: any) => {
    if (mode !== 'draw' || !drawing || !activeStroke.current) return
    const pt = toImageSpace(e.target.getStage())
    if (!pt) return
    activeStroke.current.push(pt)
    setDraft((d) => [...d.filter((s) => s !== LIVE), { ...LIVE, points: [...activeStroke.current!], color, size }])
  }
  const LIVE = useMemo(() => ({ points: [] as number[][], color: '', size: 0 }), [])
  const handleUp = (e: any) => {
    if (mode === 'draw') {
      if (!drawing || !activeStroke.current) return
      const pts = activeStroke.current
      activeStroke.current = null
      setDrawing(false)
      setDraft((d) => [...d.filter((s) => s !== LIVE && s.points.length > 0), { points: pts, color, size }])
      return
    }
    // VIEW mode: resolve the swipe (spec: left = descend, right = back up,
    // up/down = cycle siblings).
    const start = swipeStart.current
    swipeStart.current = null
    const pos = e.target.getStage()?.getPointerPosition()
    if (!start || !pos) return
    const dx = pos.x - start.x
    const dy = pos.y - start.y
    if (Math.abs(dx) < SWIPE_MIN && Math.abs(dy) < SWIPE_MIN) return // a tap, not a swipe
    if (Math.abs(dx) >= Math.abs(dy)) {
      if (dx < 0) goTo(props.nav.firstChildId)
      else goTo(props.nav.parentId)
    } else {
      if (dy < 0) goTo(props.nav.nextSiblingId)
      else goTo(props.nav.prevSiblingId)
    }
  }

  const send = () => {
    const strokes = draft.filter((s) => s.points.length >= 2)
    if (
      !props.onSend ||
      (strokes.length === 0 && stampDraft.length === 0 && textDraft.length === 0 && imageDraft.length === 0)
    ) {
      return
    }
    const payload = JSON.stringify({ strokes, stamps: stampDraft, texts: textDraft, images: imageDraft })
    startTransition(async () => {
      await props.onSend!(payload)
      setDraft([])
      setStampDraft([])
      setTextDraft([])
      setImageDraft([])
      resetImageTool()
      setMode('view')
    })
  }

  return (
    <div>
      <div
        className="inline-block overflow-hidden rounded border border-gray-300 bg-white"
        style={{ touchAction: 'none' }}
        data-canvas-mode={mode}
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
            {props.baseStamps.flatMap((layerStamps, li) =>
              layerStamps.map((st, si) => (
                <KonvaText
                  key={`bs${li}-${si}`}
                  text={st.emoji}
                  fontSize={st.fontSize}
                  x={st.x}
                  y={st.y}
                  offsetX={st.fontSize / 2}
                  offsetY={st.fontSize / 2}
                />
              )),
            )}
            {props.baseTexts.flatMap((layerTexts, li) =>
              layerTexts.map((t, ti) => (
                <KonvaText
                  key={`bt${li}-${ti}`}
                  text={t.text}
                  fontSize={t.fontSize}
                  fill={t.color}
                  rotation={t.angle}
                  x={t.x}
                  y={t.y}
                />
              )),
            )}
            {props.baseImages.flatMap((layerImages, li) =>
              layerImages.map(
                (im, ii) =>
                  imageCache[im.url] && (
                    <KonvaImage
                      key={`bi${li}-${ii}`}
                      image={imageCache[im.url]}
                      x={im.x}
                      y={im.y}
                      width={im.width}
                      height={im.height}
                      rotation={im.rotation}
                      opacity={im.opacity}
                    />
                  ),
              ),
            )}
          </Layer>
          <Layer opacity={xray ? 0.15 : 1}>
            {props.currentStrokes.map((s, i) => (
              <Line key={`c${i}`} points={strokeToPolygon(s)} closed fill={s.color} />
            ))}
            {props.currentStamps.map((st, i) => (
              <KonvaText
                key={`cs${i}`}
                text={st.emoji}
                fontSize={st.fontSize}
                x={st.x}
                y={st.y}
                offsetX={st.fontSize / 2}
                offsetY={st.fontSize / 2}
              />
            ))}
            {props.currentTexts.map((t, i) => (
              <KonvaText
                key={`ct${i}`}
                text={t.text}
                fontSize={t.fontSize}
                fill={t.color}
                rotation={t.angle}
                x={t.x}
                y={t.y}
              />
            ))}
            {props.currentImages.map(
              (im, i) =>
                imageCache[im.url] && (
                  <KonvaImage
                    key={`ci${i}`}
                    image={imageCache[im.url]}
                    x={im.x}
                    y={im.y}
                    width={im.width}
                    height={im.height}
                    rotation={im.rotation}
                    opacity={im.opacity}
                  />
                ),
            )}
          </Layer>
          <Layer>
            {draft
              .filter((s) => s.points.length >= 2)
              .map((s, i) => (
                <Line key={`d${i}`} points={strokeToPolygon(s)} closed fill={s.color} />
              ))}
            {stampDraft.map((st, i) => (
              <KonvaText
                key={`ds${i}`}
                text={st.emoji}
                fontSize={st.fontSize}
                x={st.x}
                y={st.y}
                offsetX={st.fontSize / 2}
                offsetY={st.fontSize / 2}
              />
            ))}
            {textDraft.map((t, i) => (
              <KonvaText
                key={`dt${i}`}
                text={t.text}
                fontSize={t.fontSize}
                fill={t.color}
                rotation={t.angle}
                x={t.x}
                y={t.y}
              />
            ))}
            {imageDraft.map((im, i) => {
              const url = imageObjectUrls[im.path]
              const el = url ? imageCache[url] : undefined
              return (
                el && (
                  <KonvaImage
                    key={`di${i}`}
                    image={el}
                    x={im.x}
                    y={im.y}
                    width={im.width}
                    height={im.height}
                    rotation={im.rotation}
                    opacity={im.opacity}
                  />
                )
              )
            })}
          </Layer>
        </Stage>
      </div>

      {/* Sibling dots: this layer among its siblings (carousel position). */}
      {props.nav.siblings.length > 1 && (
        <div className="mt-1 flex items-center gap-1" aria-label="sibling layers">
          {props.nav.siblings.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => goTo(s.id)}
              className={
                s.current
                  ? 'h-2.5 w-2.5 rounded-full bg-blue-600'
                  : 'h-2 w-2 rounded-full bg-gray-300 hover:bg-gray-400'
              }
              aria-label={s.current ? 'current sibling' : 'go to sibling'}
            />
          ))}
          <span className="ml-1 text-[10px] text-gray-400">swipe ↑/↓ to cycle</span>
        </div>
      )}

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

        {mode === 'view' && (
          <>
            <span className="text-[11px] text-gray-400">
              swipe ← dive into replies · swipe → back up
            </span>
            {props.drawable && (
              <button
                type="button"
                onClick={() => setMode('draw')}
                className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700"
              >
                Draw a reply
              </button>
            )}
          </>
        )}

        {mode === 'draw' && props.drawable && (
          <>
            <div className="flex overflow-hidden rounded border border-gray-300 text-xs">
              <button
                type="button"
                onClick={() => setTool('pen')}
                className={tool === 'pen' ? 'bg-blue-600 px-2 py-1 text-white' : 'bg-white px-2 py-1 text-gray-600'}
              >
                Pen
              </button>
              <button
                type="button"
                onClick={() => setTool('emoji')}
                className={tool === 'emoji' ? 'bg-blue-600 px-2 py-1 text-white' : 'bg-white px-2 py-1 text-gray-600'}
              >
                Emoji
              </button>
              <button
                type="button"
                onClick={() => setTool('text')}
                className={tool === 'text' ? 'bg-blue-600 px-2 py-1 text-white' : 'bg-white px-2 py-1 text-gray-600'}
              >
                Text
              </button>
              <button
                type="button"
                onClick={() => setTool('image')}
                className={tool === 'image' ? 'bg-blue-600 px-2 py-1 text-white' : 'bg-white px-2 py-1 text-gray-600'}
              >
                Image
              </button>
            </div>

            {tool === 'pen' && (
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
              </>
            )}

            {tool === 'emoji' && (
              <>
                {EMOJIS.map((e) => (
                  <button
                    key={e}
                    type="button"
                    onClick={() => setSelectedEmoji(e)}
                    className={
                      'rounded px-1 text-lg ' +
                      (e === selectedEmoji ? 'bg-blue-100 ring-2 ring-blue-400' : 'hover:bg-gray-100')
                    }
                    aria-label={`emoji ${e}`}
                  >
                    {e}
                  </button>
                ))}
                <input
                  type="range"
                  min={24}
                  max={120}
                  value={stampSize}
                  onChange={(e) => setStampSize(Number(e.target.value))}
                  className="w-24"
                  aria-label="emoji size"
                />
                <span className="text-[11px] text-gray-400">tap the picture to place {selectedEmoji}</span>
              </>
            )}

            {tool === 'text' && (
              <>
                <input
                  type="text"
                  value={textValue}
                  onChange={(e) => setTextValue(e.target.value)}
                  placeholder="Type text…"
                  aria-label="text content"
                  className="w-32 rounded border border-gray-300 px-2 py-1 text-sm"
                />
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setTextColor(c)}
                    className="h-6 w-6 rounded-full border"
                    style={{ backgroundColor: c, outline: c === textColor ? '2px solid #2563eb' : 'none' }}
                    aria-label={`text color ${c}`}
                  />
                ))}
                <input
                  type="range"
                  min={12}
                  max={96}
                  value={textFontSize}
                  onChange={(e) => setTextFontSize(Number(e.target.value))}
                  className="w-20"
                  aria-label="text size"
                />
                <input
                  type="range"
                  min={-180}
                  max={180}
                  value={textAngle}
                  onChange={(e) => setTextAngle(Number(e.target.value))}
                  className="w-20"
                  aria-label="text angle"
                />
                <span className="text-[11px] text-gray-400">
                  {textValue.trim() ? `tap the picture to place "${textValue.trim()}"` : 'type something first'}
                </span>
              </>
            )}

            {tool === 'image' && (
              <>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                  onChange={(e) => handleImageFile(e.target.files?.[0] ?? null)}
                  aria-label="upload image"
                  className="w-40 text-xs"
                />
                <span className="text-[11px] text-gray-500">Size</span>
                <input
                  type="range"
                  min={50}
                  max={250}
                  value={Math.round(imageScale * 100)}
                  onChange={(e) => setImageScale(Number(e.target.value) / 100)}
                  className="w-20"
                  aria-label="image size"
                />
                <span className="text-[11px] text-gray-500">Rotate</span>
                <input
                  type="range"
                  min={-180}
                  max={180}
                  value={imageRotation}
                  onChange={(e) => setImageRotation(Number(e.target.value))}
                  className="w-20"
                  aria-label="image rotation"
                />
                <span className="text-[11px] text-gray-400">
                  {uploadingImage
                    ? 'uploading…'
                    : stagedImage
                      ? 'tap the picture to place it'
                      : 'upload an image first'}
                </span>
              </>
            )}

            <button
              type="button"
              onClick={() => {
                setDraft([])
                setStampDraft([])
                setTextDraft([])
                setImageDraft([])
              }}
              className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600"
            >
              Clear draft
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft([])
                setStampDraft([])
                setTextDraft([])
                setImageDraft([])
                resetImageTool()
                setMode('view')
              }}
              className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={send}
              disabled={
                pending ||
                (draft.length === 0 && stampDraft.length === 0 && textDraft.length === 0 && imageDraft.length === 0)
              }
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
