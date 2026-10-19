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
//
// THE DRAFT IS ONE LIST (founder walkthrough 2026-10-14). Strokes, emoji, text
// and pictures all live in `doc.items`, each with an id, so one mechanism gives
// all of them: undo/redo (a snapshot history), tap-to-select, drag, live
// resize/rotate handles (Konva Transformer), and Delete. Pointer events only —
// the same code serves a mouse and a finger.

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Stage, Layer, Group, Line, Text as KonvaText, Image as KonvaImage, Transformer } from 'react-konva'
import { getStroke } from 'perfect-freehand'
import { runAction } from './action-form'
import { prepareImage } from './image-shrink'
import { navFor, type LayerNav, type TreeNode } from './layer-nav'

export type { LayerNav }

export type Stroke = { points: number[][]; color: string; size: number }
// x/y are the placed CENTER point in image pixel space (matches Stroke's
// registration approach); fontSize is also in image pixels, so stamps stay
// registered at any display scale, same as strokes. angle (degrees) is
// optional: replies sent before live rotation existed have none.
export type Stamp = { emoji: string; x: number; y: number; fontSize: number; angle?: number }
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

// Draft-only items. The id exists purely for selection / the Transformer on
// this client and is stripped before the payload is sent.
type DraftStroke = Stroke & { kind: 'stroke'; id: string }
type DraftStamp = Stamp & { kind: 'stamp'; id: string }
type DraftText = TextStamp & { kind: 'text'; id: string }
type DraftImage = ImageStamp & { kind: 'image'; id: string }
type DraftItem = DraftStroke | DraftStamp | DraftText | DraftImage
// The draft plus its undo/redo history, in ONE state value so a handler can
// never see items and history out of step.
type Doc = { items: DraftItem[]; past: DraftItem[][]; future: DraftItem[][] }
const EMPTY_DOC: Doc = { items: [], past: [], future: [] }
const HISTORY_LIMIT = 100

type Tool = 'pen' | 'select' | 'emoji' | 'text' | 'image'

// X-ray (founder 2026-10-15): a three-level toggle, not a hold. Level 0 = off,
// 1 = half, 2 = full. What it fades depends on the mode: VIEWING fades the
// replies so the picture shows through; DRAWING fades everything BELOW the reply
// being made (the picture and every layer under it), so what you are adding
// stands out and it is clear the lower layers are not yours to edit.
type XrayLevel = 0 | 1 | 2
const XRAY_FACTOR: Record<XrayLevel, number> = { 0: 1, 1: 0.5, 2: 0.15 }
const XRAY_LABEL: Record<XrayLevel, string> = { 0: 'off', 1: '50%', 2: 'full' }

// An eye whose lid shows the level: wide open (off), half-lidded (50%), shut (full).
function XrayEye({ level }: { level: XrayLevel }) {
  return (
    <svg width="22" height="16" viewBox="0 0 22 16" aria-hidden="true" className="shrink-0">
      {level === 2 ? (
        <>
          <path d="M2 8 Q11 15 20 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M5 11.5 L3.5 14 M11 13 L11 15.5 M17 11.5 L18.5 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </>
      ) : (
        <>
          <path d="M1 8 Q11 -1 21 8 Q11 17 1 8 Z" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="11" cy="8" r="3" fill="currentColor" />
          {level === 1 && <path d="M1 8 Q11 -1 21 8 L21 8 L1 8 Z" fill="currentColor" opacity="0.35" />}
        </>
      )}
    </svg>
  )
}

// Everything a layer shows, composed along its path from the root (flat): what
// the swipe slides in from a neighbouring layer while the finger is still down.
export type LayerContent = {
  strokes: Stroke[]
  stamps: Stamp[]
  texts: TextStamp[]
  images: ResolvedImageStamp[]
}
type SwipeDir = 'left' | 'right' | 'up' | 'down'

const COLORS = ['#e11d48', '#2563eb', '#16a34a', '#f59e0b', '#111111', '#ffffff']
const EMOJIS = ['😀', '😍', '😂', '😢', '😡', '👍', '👎', '❤️', '🔥', '🎉', '⭐', '✅', '❌', '🤔']
const SWIPE_MIN = 60 // px of drag before a quick flick counts as a swipe
const SWIPE_AXIS_LOCK = 10 // px before a drag picks horizontal or vertical
const FLICK_SPEED = 0.4 // px/ms — a fast flick completes even before halfway
const SWIPE_SETTLE_MS = 160
const EMOJI_SIZE = 64 // placed size, in image pixels — the handles change it live
const TEXT_SIZE = 32

const btn =
  'rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-white'

function strokeToPolygon(stroke: Stroke): number[] {
  const outline = getStroke(stroke.points, { size: stroke.size, thinning: 0.6, smoothing: 0.5 })
  return outline.flatMap((p) => [p[0]!, p[1]!])
}

// Loads arbitrary URLs into HTMLImageElements for Konva (signed vm-images
// URLs for already-sent stamps, plus local object URLs for an unsent draft —
// both need a real Image() to paint on canvas). Cache persists across
// renders so a URL already loaded isn't re-fetched.
//
// KEYED BY THE URL WITHOUT ITS QUERY STRING. A signed storage URL carries a fresh
// token on every server render, so keying by the whole URL made every navigation
// (every completed swipe) look like a brand-new set of pictures: stamps vanished
// until they re-downloaded, which read as "the image and the layers below it
// reload" (founder, 2026-10-19). The path part is stable; the token is not.
export const urlKey = (url: string) => url.split('?')[0]!

export function useImageCache(urls: string[]): Record<string, HTMLImageElement> {
  const [cache, setCache] = useState<Record<string, HTMLImageElement>>({})
  const key = urls.filter(Boolean).map(urlKey).join('|')
  useEffect(() => {
    if (typeof window === 'undefined') return
    for (const url of urls) {
      const k = url && urlKey(url)
      if (!url || cache[k]) continue
      const el = new window.Image()
      el.crossOrigin = 'anonymous'
      el.onload = () => setCache((c) => (c[k] ? c : { ...c, [k]: el }))
      el.src = url
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  // Callers still index by the full URL (`cache[im.url]`); look it up by key.
  return useMemo(
    () => new Proxy(cache, { get: (t, p) => (typeof p === 'string' ? t[urlKey(p)] : undefined) }),
    [cache],
  )
}

export default function LayerCanvas(props: {
  imageUrl: string
  currentLayerId: string
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
  /** every layer (id + parent, path order) — lets the markers update at once on a swipe */
  tree: TreeNode[]
  /** what a layer ADDED (its own ink only, not the picture or its ancestors'),
   *  for the layer each of these swipes leads to. Right (back up) needs none: it
   *  slides the CURRENT layer's own ink away. */
  neighbours: Record<'left' | 'up' | 'down', LayerContent | null>
  // Both return {ok, ...} rather than throwing (docs/03 #22) — a refusal shows
  // inline and the draft stays on the canvas.
  onSend?: (payloadJson: string) => Promise<{ ok: true; layerId: string } | { ok: false; reason: string }>
  onUploadImage?: (file: File) => Promise<{ ok: true; path: string } | { ok: false; reason: string }>
  // Spec's image-stamp guards: "default max stamp size relative to canvas
  // (admin/org-tunable)" and "default slight transparency" — resolved by the
  // page from org_modules.settings (resolveVisualMessagingSettings), which
  // falls back to the v1 defaults (0.3 / 0.85) when unset.
  imageStampMaxFraction: number
  imageStampOpacity: number
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [mode, setMode] = useState<'view' | 'draw'>('view')
  const [tool, setTool] = useState<Tool>('pen')
  const [drawing, setDrawing] = useState(false)
  const [doc, setDoc] = useState<Doc>(EMPTY_DOC)
  // The stroke being drawn RIGHT NOW, kept apart from the finished ones so a
  // half-drawn line is never mistaken for (or sent as) a finished stroke.
  const [liveStroke, setLiveStroke] = useState<Stroke | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [color, setColor] = useState(COLORS[0]!)
  const [size, setSize] = useState(6)
  const [selectedEmoji, setSelectedEmoji] = useState(EMOJIS[0]!)
  const [textValue, setTextValue] = useState('')
  const [textColor, setTextColor] = useState(COLORS[0]!)
  const [stagedImage, setStagedImage] = useState<{ path: string; naturalW: number; naturalH: number } | null>(null)
  const [imageObjectUrls, setImageObjectUrls] = useState<Record<string, string>>({})
  const [uploadingImage, setUploadingImage] = useState(false)
  const [xrayLevel, setXrayLevel] = useState<XrayLevel>(0)
  const xrayFactor = XRAY_FACTOR[xrayLevel]
  // Entering or leaving drawing changes what X-ray means, so start each mode clear.
  useEffect(() => setXrayLevel(0), [mode])
  const [pending, startTransition] = useTransition()
  const activeStroke = useRef<number[][] | null>(null)
  // A swipe in progress: where it began, which axis it locked to, and recent
  // pointer samples (for the flick speed at release). `swipe` is what is drawn;
  // swipeRef mirrors it so the pointer handlers never read a stale copy.
  const swipeStart = useRef<{
    x: number
    y: number
    axis: 'x' | 'y' | null
    samples: { t: number; x: number; y: number }[]
  } | null>(null)
  const [swipe, setSwipe] = useState<{ dir: SwipeDir; offset: number } | null>(null)
  const swipeRef = useRef<{ dir: SwipeDir; offset: number } | null>(null)
  const showSwipe = (s: { dir: SwipeDir; offset: number } | null) => {
    swipeRef.current = s
    setSwipe(s)
  }
  // The layer we are navigating TO, from the moment a swipe/click commits until
  // the server's page for it arrives. The edge markers, dots and next swipe
  // targets follow it immediately (computed from the tree), so they no longer
  // lag a server round-trip behind the picture.
  const [pendingLayerId, setPendingLayerId] = useState<string | null>(null)
  const nav = useMemo(
    () => (pendingLayerId ? navFor(props.tree, pendingLayerId) : props.nav),
    [pendingLayerId, props.tree, props.nav],
  )
  const nextDraftId = useRef(0)
  const genId = () => `d${nextDraftId.current++}`
  const shapeRefs = useRef<Record<string, any>>({})
  const transformerRef = useRef<any>(null)
  // Slide-in transition on swipe navigation (founder Q2, 2026-07-11: "how
  // hard would it be to show the new layer sliding in from the swipe
  // direction" — answer was "not hard," this is that). The new layer
  // starts nudged in the direction it swiped FROM, then eases to rest —
  // a directional cue, not a scene transition, so the offset stays small.
  const lastSwipeDir = useRef<'left' | 'right' | 'up' | 'down' | null>(null)
  const prevLayerId = useRef(props.currentLayerId)
  const [slideStyle, setSlideStyle] = useState<{ transform: string; transition: string }>({
    transform: 'none',
    transition: 'none',
  })

  const items = doc.items
  // Undo/redo can remove the selected item; derive rather than trust the state.
  const selected = items.find((i) => i.id === selectedId) ?? null

  const imageCache = useImageCache([
    ...props.baseImages.flatMap((layer) => layer.map((i) => i.url)),
    ...props.currentImages.map((i) => i.url),
    ...Object.values(imageObjectUrls),
    ...Object.values(props.neighbours).flatMap((n) => (n ? n.images.map((i) => i.url) : [])),
  ])

  // ---- the draft: every change goes through commit() so undo sees it -------
  const commit = (change: (items: DraftItem[]) => DraftItem[]) =>
    setDoc((d) => ({
      items: change(d.items),
      past: [...d.past, d.items].slice(-HISTORY_LIMIT),
      future: [],
    }))
  const undo = () =>
    setDoc((d) =>
      d.past.length === 0
        ? d
        : { items: d.past[d.past.length - 1]!, past: d.past.slice(0, -1), future: [d.items, ...d.future] },
    )
  const redo = () =>
    setDoc((d) =>
      d.future.length === 0 ? d : { items: d.future[0]!, past: [...d.past, d.items], future: d.future.slice(1) },
    )
  const deleteSelected = () => {
    if (!selected) return
    commit((all) => all.filter((i) => i.id !== selected.id))
    setSelectedId(null)
  }
  const clearDraft = () => {
    if (items.length === 0) return
    commit(() => [])
    setSelectedId(null)
  }
  const resetDraft = () => {
    setDoc(EMPTY_DOC)
    setLiveStroke(null)
    setSelectedId(null)
    Object.values(imageObjectUrls).forEach((url) => URL.revokeObjectURL(url))
    setImageObjectUrls({})
    setStagedImage(null)
  }

  // Attach the Transformer's resize/rotate handles to whichever draft item is
  // selected (or detach when nothing is).
  useEffect(() => {
    const tr = transformerRef.current
    if (!tr) return
    const node = selected ? shapeRefs.current[selected.id] : null
    tr.nodes(node ? [node] : [])
    tr.getLayer()?.batchDraw()
  }, [selected, items, mode])

  // Runs after navigation actually lands on a new layer (props.currentLayerId
  // changed) — start the incoming view offset in the direction it swiped
  // from, then ease it to rest on the next two frames (the double rAF
  // ensures the browser paints the offset starting position before the
  // transition kicks in, or it'd snap instead of animating).
  useEffect(() => {
    if (props.currentLayerId === prevLayerId.current) return
    prevLayerId.current = props.currentLayerId
    // The navigation landed: the real layer replaces the sliding card.
    showSwipe(null)
    setPendingLayerId(null)
    const dir = lastSwipeDir.current
    lastSwipeDir.current = null
    if (!dir) return
    const offset = 24
    const startTransform =
      dir === 'left'
        ? `translateX(${offset}px)`
        : dir === 'right'
          ? `translateX(-${offset}px)`
          : dir === 'up'
            ? `translateY(${offset}px)`
            : `translateY(-${offset}px)`
    setSlideStyle({ transform: startTransform, transition: 'none' })
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setSlideStyle({ transform: 'none', transition: 'transform 200ms ease-out' })
      })
    })
  }, [props.currentLayerId])

  // A drag or a resize/rotate changes the Konva NODE (x/y/scale/rotation);
  // translate that back into our data and reset the node so nothing compounds.
  //   emoji/text: scale -> fontSize, plus angle
  //   picture:    scale -> width/height, plus rotation
  //   stroke:     the whole transform is BAKED into the points (so a stored
  //               stroke is still plain points, nothing the renderers need to
  //               know about) and the node goes back to identity.
  const commitNode = (id: string) => {
    const node = shapeRefs.current[id]
    const item = items.find((i) => i.id === id)
    if (!node || !item) return
    const scaleX = node.scaleX()
    const scaleY = node.scaleY()
    const avg = (scaleX + scaleY) / 2
    const rotation = node.rotation()
    const x = node.x()
    const y = node.y()
    let next: DraftItem
    if (item.kind === 'stroke') {
      const tr = node.getTransform()
      next = {
        ...item,
        points: item.points.map((p) => {
          const q = tr.point({ x: p[0]!, y: p[1]! })
          return [q.x, q.y]
        }),
        size: Math.max(1, item.size * avg),
      }
      node.setAttrs({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 })
    } else if (item.kind === 'image') {
      next = {
        ...item,
        width: Math.max(16, item.width * scaleX),
        height: Math.max(16, item.height * scaleY),
        rotation,
        x,
        y,
      }
      node.setAttrs({ scaleX: 1, scaleY: 1 })
    } else {
      next = { ...item, fontSize: Math.max(8, item.fontSize * avg), x, y, angle: rotation }
      node.setAttrs({ scaleX: 1, scaleY: 1 })
    }
    commit((all) => all.map((i) => (i.id === id ? next : i)))
  }

  useMemo(() => {
    if (typeof window === 'undefined') return
    const el = new window.Image()
    el.crossOrigin = 'anonymous'
    el.onload = () => setImg(el)
    el.src = props.imageUrl
    // Depends on the stable part of the URL only (see urlKey): a fresh token on
    // the same picture must not trigger a re-download and re-decode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlKey(props.imageUrl)])

  // Founder feedback (2026-07-12, "doesn't come out very well on phone/
  // tablet"): the canvas used to hard-cap at 640px regardless of viewport,
  // overflowing the page on any screen narrower than that. Measure the
  // actual available width via the wrapping container (itself capped at
  // 640px, shrinking to fit on narrower screens) instead of a constant.
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(640)
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width) setContainerWidth(width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const natural = { w: img?.naturalWidth || 800, h: img?.naturalHeight || 600 }
  const displayW = Math.min(640, natural.w, containerWidth || 640)
  const scale = displayW / natural.w
  const displayH = natural.h * scale

  const placeImage = (path: string, naturalW: number, naturalH: number, cx: number, cy: number) => {
    const width = natural.w * props.imageStampMaxFraction
    const height = width * (naturalH / naturalW)
    const id = genId()
    commit((all) => [
      ...all,
      {
        kind: 'image',
        id,
        path,
        x: cx - width / 2,
        y: cy - height / 2,
        width,
        height,
        rotation: 0,
        opacity: props.imageStampOpacity,
      },
    ])
    setSelectedId(id)
    setTool('select')
  }

  // A picture (chosen or pasted): shrink it, upload it, then drop it in the
  // middle of the canvas already selected, so the handles are right there to
  // move, resize and rotate it live.
  const handleImageFile = async (picked: File | null) => {
    if (!picked || !props.onUploadImage) return
    setUploadingImage(true)
    setActionError(null)
    try {
      // Shrink first: a Server Action's request body is capped (image-shrink.ts).
      const prepared = await prepareImage(picked)
      if (!prepared.ok) {
        setActionError(prepared.reason)
        return
      }
      const file = prepared.file
      const uploaded = await runAction(() => props.onUploadImage!(file))
      if (!uploaded.ok) {
        setActionError((uploaded as { reason: string }).reason)
        return
      }
      const path = (uploaded as { ok: true; path: string }).path
      const url = URL.createObjectURL(file)
      const naturalSize = await new Promise<{ w: number; h: number }>((resolve) => {
        const el = new window.Image()
        el.onload = () => resolve({ w: el.naturalWidth, h: el.naturalHeight })
        el.src = url
      })
      setImageObjectUrls((m) => ({ ...m, [path]: url }))
      setStagedImage({ path, naturalW: naturalSize.w, naturalH: naturalSize.h })
      placeImage(path, naturalSize.w, naturalSize.h, natural.w / 2, natural.h / 2)
    } finally {
      setUploadingImage(false)
    }
  }

  // Keyboard + paste while drawing. The handlers are re-made every render, so
  // the listeners read them through a ref instead of re-attaching each time.
  const latest = useRef({ mode, undo, redo, deleteSelected, handleImageFile, drawable: props.drawable })
  latest.current = { mode, undo, redo, deleteSelected, handleImageFile, drawable: props.drawable }
  useEffect(() => {
    const typingIn = (t: EventTarget | null) => {
      const el = t as HTMLElement | null
      return (
        !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
      )
    }
    const onKey = (e: KeyboardEvent) => {
      const L = latest.current
      if (L.mode !== 'draw' || !L.drawable) return
      // While typing (the text box), Ctrl-Z / Delete / Backspace belong to the field.
      if (typingIn(e.target)) return
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (mod && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) L.redo()
        else L.undo()
      } else if (mod && key === 'y') {
        e.preventDefault()
        L.redo()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        L.deleteSelected()
      }
    }
    const onPaste = (e: ClipboardEvent) => {
      const L = latest.current
      if (L.mode !== 'draw' || !L.drawable) return
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'))
      if (!file) return // plain text paste (into the text box) is not ours
      e.preventDefault()
      setTool('image')
      void L.handleImageFile(file)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('paste', onPaste)
    }
  }, [])

  const goTo = (layerId: string | null, dir?: 'left' | 'right' | 'up' | 'down') => {
    if (!layerId) return // no target — don't touch lastSwipeDir, a no-op swipe shouldn't taint the next real one
    if (dir) lastSwipeDir.current = dir
    setPendingLayerId(layerId)
    // If the navigation never lands, fall back to what the server last said.
    setTimeout(() => setPendingLayerId((p) => (p === layerId ? null : p)), 4000)
    // scroll:false — a swipe changes the layer, not the page; without it the
    // browser jumped back to the top whenever you were scrolled down a little.
    router.push(`${pathname}?layer=${layerId}`, { scroll: false })
  }

  const toImageSpace = (stage: any): number[] | null => {
    const pos = stage?.getPointerPosition()
    if (!pos) return null
    return [pos.x / scale, pos.y / scale]
  }

  const isTransformerPart = (node: any) => {
    for (let n = node; n; n = n.getParent?.()) {
      if (n.getClassName?.() === 'Transformer') return true
    }
    return false
  }
  const draftIdOf = (node: any): string | null => {
    for (const [id, n] of Object.entries(shapeRefs.current)) if (n === node) return id
    return null
  }

  const handleDown = (e: any) => {
    const stage = e.target.getStage()
    if (mode === 'draw' && props.drawable) {
      // A press on one of the Transformer's handles (resize/rotate) belongs to
      // the Transformer — without this it deselected the shape and dropped a
      // NEW emoji/stroke under the handle.
      if (isTransformerPart(e.target)) return
      // A press on an already-placed item SELECTS it (and Konva starts the drag)
      // — never places a new item or starts inking underneath it.
      // NOTE: e.target !== stage is the WRONG check — the background photo
      // is itself a KonvaImage node covering the whole canvas, so almost
      // every press would hit it (not the bare Stage). Only our tracked draft
      // shapes count. (Strokes are only targets in the Select tool.)
      const hitId = draftIdOf(e.target)
      if (hitId) {
        setSelectedId(hitId)
        return
      }
      setSelectedId(null) // pressing empty canvas deselects

      const pt = toImageSpace(stage)
      if (!pt) return
      if (tool === 'select') return
      if (tool === 'emoji') {
        const id = genId()
        commit((all) => [
          ...all,
          { kind: 'stamp', id, emoji: selectedEmoji, x: pt[0]!, y: pt[1]!, fontSize: EMOJI_SIZE, angle: 0 },
        ])
        setSelectedId(id)
        setTool('select') // placed: the next press selects/moves, it does not stamp another
        return
      }
      if (tool === 'text') {
        const text = textValue.trim()
        if (!text) return // nothing typed yet — a tap does nothing
        const id = genId()
        commit((all) => [
          ...all,
          { kind: 'text', id, text, color: textColor, x: pt[0]!, y: pt[1]!, fontSize: TEXT_SIZE, angle: 0 },
        ])
        setSelectedId(id)
        setTool('select')
        return
      }
      if (tool === 'image') {
        if (!stagedImage) return // nothing uploaded yet — a tap does nothing
        placeImage(stagedImage.path, stagedImage.naturalW, stagedImage.naturalH, pt[0]!, pt[1]!)
        return
      }
      activeStroke.current = [pt]
      setLiveStroke({ points: [pt], color, size })
      setDrawing(true)
    } else {
      const pos = stage?.getPointerPosition()
      if (pos) swipeStart.current = { x: pos.x, y: pos.y, axis: null, samples: [{ t: performance.now(), x: pos.x, y: pos.y }] }
    }
  }
  const targetFor = (dir: SwipeDir): string | null =>
    dir === 'left'
      ? nav.firstChildId
      : dir === 'right'
        ? nav.parentId
        : dir === 'up'
          ? nav.nextSiblingId
          : nav.prevSiblingId
  const extentOf = (dir: SwipeDir) => (dir === 'left' || dir === 'right' ? displayW : displayH)

  // Move the sliding card to `to` (screen px along the swipe axis), then call done.
  const settleSwipe = (dir: SwipeDir, from: number, to: number, done: () => void) => {
    const t0 = performance.now()
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / SWIPE_SETTLE_MS)
      const eased = 1 - (1 - k) * (1 - k)
      showSwipe({ dir, offset: from + (to - from) * eased })
      if (k < 1) requestAnimationFrame(tick)
      else done()
    }
    requestAnimationFrame(tick)
  }

  // VIEW mode, finger/mouse down and moving: the incoming layer follows the
  // pointer, see-through (spec + founder 2026-10-14: "the swipe should follow
  // the finger ... finishing past halfway and snapping back before it").
  const dragSwipe = (stage: any) => {
    const st = swipeStart.current
    const pos = stage?.getPointerPosition()
    if (!st || !pos) return
    st.samples.push({ t: performance.now(), x: pos.x, y: pos.y })
    if (st.samples.length > 8) st.samples.shift()
    const dx = pos.x - st.x
    const dy = pos.y - st.y
    if (!st.axis) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_AXIS_LOCK) return
      st.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y'
    }
    const raw = st.axis === 'x' ? dx : dy
    const dir: SwipeDir = st.axis === 'x' ? (raw < 0 ? 'left' : 'right') : raw < 0 ? 'up' : 'down'
    if (!targetFor(dir)) {
      if (swipeRef.current) showSwipe(null) // nowhere to go that way
      return
    }
    const extent = extentOf(dir)
    showSwipe({ dir, offset: Math.max(-extent, Math.min(extent, raw)) })
  }

  const releaseSwipe = () => {
    const st = swipeStart.current
    swipeStart.current = null
    const s = swipeRef.current
    if (!st || !s) return
    const target = targetFor(s.dir)
    const extent = extentOf(s.dir)
    const sign = s.dir === 'left' || s.dir === 'up' ? -1 : 1
    // Speed over the last ~120ms, in the direction of the swipe.
    const now = performance.now()
    const last = st.samples[st.samples.length - 1]
    const first = st.samples.find((p) => now - p.t <= 120) ?? last
    let speed = 0
    if (first && last && last.t > first.t) {
      const d = st.axis === 'x' ? last.x - first.x : last.y - first.y
      speed = (d * sign) / (last.t - first.t)
    }
    const complete =
      !!target && (Math.abs(s.offset) / extent > 0.5 || (Math.abs(s.offset) >= SWIPE_MIN && speed >= FLICK_SPEED))
    if (complete) {
      settleSwipe(s.dir, s.offset, sign * extent, () => {
        goTo(target)
        // If the navigation never lands, do not leave the card stuck on screen.
        setTimeout(() => showSwipe(null), 2500)
      })
    } else {
      settleSwipe(s.dir, s.offset, 0, () => showSwipe(null))
    }
  }
  const handleMove = (e: any) => {
    if (mode === 'view') {
      dragSwipe(e.target.getStage())
      return
    }
    if (mode !== 'draw' || !drawing || !activeStroke.current) return
    const pt = toImageSpace(e.target.getStage())
    if (!pt) return
    activeStroke.current.push(pt)
    // Copy the points HERE, not inside a setState updater: React runs updaters
    // later, at render, and a fast pointer-up in between nulls the ref — which
    // is the "K.current is not iterable" crash that lost the draft.
    const points = [...activeStroke.current]
    setLiveStroke({ points, color, size })
  }
  const handleUp = (e: any) => {
    if (mode === 'draw') {
      if (!drawing || !activeStroke.current) return
      const pts = [...activeStroke.current]
      activeStroke.current = null
      setDrawing(false)
      setLiveStroke(null)
      // A single tap leaves one point — not a line; drop it.
      if (pts.length >= 2) {
        const id = genId()
        commit((all) => [...all, { kind: 'stroke', id, points: pts, color, size }])
      }
      return
    }
    // VIEW mode: resolve the swipe (spec: left = descend, right = back up,
    // up/down = cycle siblings). A press with no drag is just a tap.
    releaseSwipe()
  }

  // A swipe that moves the current layer's own ink out of the way (not 'left',
  // which brings a child's ink IN over the top).
  const outgoing = swipe && swipe.dir !== 'left' ? swipe : null

  const strokeItems = items.filter((i): i is DraftStroke => i.kind === 'stroke')
  const stampItems = items.filter((i): i is DraftStamp => i.kind === 'stamp')
  const textItems = items.filter((i): i is DraftText => i.kind === 'text')
  const imageItems = items.filter((i): i is DraftImage => i.kind === 'image')

  const send = () => {
    if (!props.onSend || items.length === 0) return
    // Strip the local-only kind/id — the server has no use for them.
    const strokes = strokeItems.map(({ kind: _k, id: _i, ...s }) => s)
    const stamps = stampItems.map(({ kind: _k, id: _i, ...s }) => s)
    const texts = textItems.map(({ kind: _k, id: _i, ...t }) => t)
    const images = imageItems.map(({ kind: _k, id: _i, ...im }) => im)
    const payload = JSON.stringify({ strokes, stamps, texts, images })
    setActionError(null)
    startTransition(async () => {
      const result = await runAction(() => props.onSend!(payload))
      if (!result.ok) {
        // Keep everything on the canvas so the person can retry.
        setActionError((result as { reason: string }).reason)
        return
      }
      const newLayerId = (result as { ok: true; layerId: string }).layerId
      resetDraft()
      setMode('view')
      goTo(newLayerId) // land on the reply just sent, not the parent
    })
  }

  const reg = (id: string) => (node: any) => {
    if (node) shapeRefs.current[id] = node
    else delete shapeRefs.current[id]
  }

  const toolBtn = (t: Tool, label: string) => (
    <button
      type="button"
      // Switching tools keeps the selection (handles stay) — pressing empty
      // canvas is what deselects.
      onClick={() => setTool(t)}
      className={tool === t ? 'bg-blue-600 px-2 py-1 text-white' : 'bg-white px-2 py-1 text-gray-600'}
    >
      {label}
    </button>
  )

  return (
    <div>
      {mode === 'draw' && (
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-blue-600">
          Drawing mode — swipes are off
        </p>
      )}
      {/* Outer div is purely a width-measuring container (ResizeObserver
          reads its clientWidth so the canvas can shrink to fit a phone
          screen) — everything visual, including the swipe-arrow overlays,
          lives in the inner div below, sized to the actual displayW so
          arrows hug the canvas edges rather than a wider measuring box. */}
      <div ref={containerRef} className="w-full max-w-[640px]">
      <div className="relative" style={{ width: displayW }}>
        {/* Swipe-direction indicators (founder feedback, 2026-07-11): plain
            HTML overlays, not part of the Konva stage, so they always
            render above whatever's drawn underneath and are never obscured
            by ink. Each shows only when that direction has somewhere to go;
            the badge is how many consecutive swipes still work from here —
            not just "can I swipe" but "how many times." Clicking one
            navigates directly, same target as the matching swipe/dot. */}
        {mode === 'view' && (
          <>
            {nav.swipeCounts.left > 0 && (
              <button
                type="button"
                onClick={() => goTo(nav.firstChildId, 'left')}
                aria-label={`swipe left: ${nav.swipeCounts.left} deeper`}
                // Replies are pulled in from the RIGHT, so the marker sits on the
                // right edge pointing right: "N layers waiting that way".
                className="absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1 rounded-full bg-black/40 px-2 py-1 text-sm text-white hover:bg-black/60"
              >
                <span className="rounded-full bg-white/90 px-1.5 text-[10px] font-semibold text-gray-800">{nav.swipeCounts.left}</span> →
              </button>
            )}
            {nav.swipeCounts.right > 0 && (
              <button
                type="button"
                onClick={() => goTo(nav.parentId, 'right')}
                aria-label={`swipe right: ${nav.swipeCounts.right} back up`}
                className="absolute left-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1 rounded-full bg-black/40 px-2 py-1 text-sm text-white hover:bg-black/60"
              >
                ← <span className="rounded-full bg-white/90 px-1.5 text-[10px] font-semibold text-gray-800">{nav.swipeCounts.right}</span>
              </button>
            )}
            {nav.swipeCounts.up > 0 && (
              <button
                type="button"
                onClick={() => goTo(nav.nextSiblingId, 'up')}
                aria-label={`swipe up: ${nav.swipeCounts.up} siblings`}
                className="absolute bottom-1 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/40 px-2 py-1 text-sm text-white hover:bg-black/60"
              >
                ↓ <span className="rounded-full bg-white/90 px-1.5 text-[10px] font-semibold text-gray-800">{nav.swipeCounts.up}</span>
              </button>
            )}
            {nav.swipeCounts.down > 0 && (
              <button
                type="button"
                onClick={() => goTo(nav.prevSiblingId, 'down')}
                aria-label={`swipe down: ${nav.swipeCounts.down} siblings`}
                className="absolute left-1/2 top-1 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/40 px-2 py-1 text-sm text-white hover:bg-black/60"
              >
                <span className="rounded-full bg-white/90 px-1.5 text-[10px] font-semibold text-gray-800">{nav.swipeCounts.down}</span> ↑
              </button>
            )}
          </>
        )}
        <div
          className={
            'overflow-hidden rounded bg-white ' +
            (mode === 'draw' ? 'border-4 border-blue-500' : 'border border-gray-300')
          }
          style={{ touchAction: 'none', width: displayW, ...slideStyle }}
          data-canvas-mode={mode}
          // A pointer that leaves the canvas (or is cancelled) mid-swipe ends it,
          // else the card would stay stuck to a finger that is no longer there.
          onPointerLeave={() => mode === 'view' && releaseSwipe()}
          onPointerCancel={() => mode === 'view' && releaseSwipe()}
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
          <Layer opacity={mode === 'draw' ? xrayFactor : 1}>
            {img && <KonvaImage image={img} width={natural.w} height={natural.h} />}
          </Layer>
          <Layer opacity={xrayFactor}>
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
                  rotation={st.angle ?? 0}
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
          <Layer
            // What THIS layer added. On a right/up/down swipe it is what slides
            // away with the pointer, leaving the layer underneath (the parent's
            // picture) showing; on a left swipe it stays put.
            x={outgoing && outgoing.dir === 'right' ? outgoing.offset / scale : 0}
            y={outgoing && (outgoing.dir === 'up' || outgoing.dir === 'down') ? outgoing.offset / scale : 0}
            opacity={
              xrayFactor *
              (outgoing ? 1 - 0.45 * Math.min(1, Math.abs(outgoing.offset) / extentOf(outgoing.dir)) : 1)
            }
          >
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
                rotation={st.angle ?? 0}
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
            {/* The draft, in the same order the sent reply composes: strokes,
                then emoji, text, pictures. Each is selectable + draggable;
                strokes only listen in the Select tool, because the Pen has to
                be able to ink ACROSS an existing line. */}
            {strokeItems.map((s) => (
              <Line
                key={s.id}
                ref={reg(s.id)}
                points={strokeToPolygon(s)}
                closed
                fill={s.color}
                stroke={s.color}
                strokeWidth={1}
                hitStrokeWidth={Math.max(24 / scale, 1)}
                listening={tool === 'select'}
                draggable={tool === 'select'}
                onDragEnd={() => commitNode(s.id)}
                onTransformEnd={() => commitNode(s.id)}
              />
            ))}
            {liveStroke && liveStroke.points.length >= 2 && (
              <Line points={strokeToPolygon(liveStroke)} closed fill={liveStroke.color} listening={false} />
            )}
            {stampItems.map((st) => (
              <KonvaText
                key={st.id}
                ref={reg(st.id)}
                text={st.emoji}
                fontSize={st.fontSize}
                x={st.x}
                y={st.y}
                rotation={st.angle ?? 0}
                offsetX={st.fontSize / 2}
                offsetY={st.fontSize / 2}
                draggable
                onDragEnd={() => commitNode(st.id)}
                onTransformEnd={() => commitNode(st.id)}
              />
            ))}
            {textItems.map((t) => (
              <KonvaText
                key={t.id}
                ref={reg(t.id)}
                text={t.text}
                fontSize={t.fontSize}
                fill={t.color}
                rotation={t.angle}
                x={t.x}
                y={t.y}
                draggable
                onDragEnd={() => commitNode(t.id)}
                onTransformEnd={() => commitNode(t.id)}
              />
            ))}
            {imageItems.map((im) => {
              const url = imageObjectUrls[im.path]
              const el = url ? imageCache[url] : undefined
              return (
                el && (
                  <KonvaImage
                    key={im.id}
                    ref={reg(im.id)}
                    image={el}
                    x={im.x}
                    y={im.y}
                    width={im.width}
                    height={im.height}
                    rotation={im.rotation}
                    opacity={im.opacity}
                    draggable
                    onDragEnd={() => commitNode(im.id)}
                    onTransformEnd={() => commitNode(im.id)}
                  />
                )
              )
            })}
            {mode === 'draw' && <Transformer
                ref={transformerRef}
                rotateEnabled
                keepRatio
                // Corner handles only: with keepRatio the side handles do the same
                // job, and eight of them swamped a small emoji. Translucent so the
                // item stays visible underneath (founder 2026-10-14).
                enabledAnchors={['top-left', 'top-right', 'bottom-left', 'bottom-right']}
                anchorSize={12}
                anchorCornerRadius={6}
                anchorFill="rgba(255,255,255,0.55)"
                anchorStroke="rgba(37,99,235,0.75)"
                borderStroke="rgba(37,99,235,0.6)"
                borderDash={[4, 3]}
              />}
          </Layer>
          {swipe && swipe.dir !== 'right' && props.neighbours[swipe.dir] && (
            // The layer being swiped TO — just what it ADDED, as a see-through
            // sheet with no picture of its own — riding the pointer in from the
            // side it will arrive from. It firms up as it gets closer (0.55 -> 1.0).
            <Layer
              listening={false}
              opacity={0.55 + 0.45 * Math.pow(Math.min(1, Math.abs(swipe.offset) / extentOf(swipe.dir)), 2)}
            >
              <Group
                x={swipe.dir === 'left' ? natural.w + swipe.offset / scale : 0}
                y={
                  swipe.dir === 'up'
                    ? natural.h + swipe.offset / scale
                    : swipe.dir === 'down'
                      ? -natural.h + swipe.offset / scale
                      : 0
                }
              >
                {props.neighbours[swipe.dir]!.strokes.map((s, i) => (
                  <Line key={`ns${i}`} points={strokeToPolygon(s)} closed fill={s.color} />
                ))}
                {props.neighbours[swipe.dir]!.stamps.map((st, i) => (
                  <KonvaText
                    key={`nst${i}`}
                    text={st.emoji}
                    fontSize={st.fontSize}
                    x={st.x}
                    y={st.y}
                    rotation={st.angle ?? 0}
                    offsetX={st.fontSize / 2}
                    offsetY={st.fontSize / 2}
                  />
                ))}
                {props.neighbours[swipe.dir]!.texts.map((t, i) => (
                  <KonvaText
                    key={`nt${i}`}
                    text={t.text}
                    fontSize={t.fontSize}
                    fill={t.color}
                    rotation={t.angle}
                    x={t.x}
                    y={t.y}
                  />
                ))}
                {props.neighbours[swipe.dir]!.images.map(
                  (im, i) =>
                    imageCache[im.url] && (
                      <KonvaImage
                        key={`ni${i}`}
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
              </Group>
            </Layer>
          )}
        </Stage>
        </div>
      </div>
      </div>

      {/* Sibling dots: this layer among its siblings (carousel position). */}
      {nav.siblings.length > 1 && (
        <div className="mt-1 flex items-center gap-1" aria-label="sibling layers">
          {nav.siblings.map((s) => (
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

      {actionError && (
        <p role="alert" className="mt-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {actionError}
        </p>
      )}

      {/* Toolbar. Draw mode is three fixed rows — tools, the chosen tool's
          options, and actions — so nothing jumps around as items are placed
          or selected (Delete used to appear and wrap onto a new line). */}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        <button
          type="button"
          // A plain click, so it works for a finger as well as a mouse; each click
          // goes off -> 50% -> full -> off.
          onClick={() => setXrayLevel((l) => ((l + 1) % 3) as XrayLevel)}
          aria-label={`X-ray: ${XRAY_LABEL[xrayLevel]}`}
          data-xray-level={xrayLevel}
          title={
            mode === 'draw'
              ? 'X-ray: fade everything below your reply (click to change: off, 50%, full)'
              : 'X-ray: fade the replies so the picture shows through (click to change: off, 50%, full)'
          }
          className={
            'flex items-center gap-1.5 rounded border px-2 py-1 text-xs ' +
            (xrayLevel === 0 ? 'border-gray-300 text-gray-600' : 'border-blue-500 bg-blue-50 text-blue-700') +
            (mode === 'view' ? ' order-2' : '')
          }
        >
          <XrayEye level={xrayLevel} />
          <span>X-ray {XRAY_LABEL[xrayLevel]}</span>
        </button>

        {mode === 'view' && (
          <>
            <span className="order-1 min-w-0 flex-1 text-[11px] text-gray-400">
              swipe ← dive into replies · swipe → back up
            </span>
            {/* Its own full-width row on a phone, with a gap above it: when it sat
                right under X-ray the two looked alike and a tap meant for X-ray
                started a reply (founder, 2026-10-19). Different size, different
                colour, different place. */}
            {props.drawable && (
              <button
                type="button"
                onClick={() => setMode('draw')}
                className="order-3 mt-3 min-h-11 w-full rounded bg-blue-600 px-4 py-2 text-base font-medium text-white hover:bg-blue-700 sm:mt-0 sm:min-h-0 sm:w-auto sm:px-3 sm:py-1 sm:text-sm"
              >
                Draw a reply
              </button>
            )}
          </>
        )}

        {mode === 'draw' && props.drawable && (
          <>
            {/* Select is not a drawing tool, so it stands apart from them. */}
            <div className="flex overflow-hidden rounded border border-gray-300 text-xs">{toolBtn('select', 'Select')}</div>
            <span className="text-xs text-gray-400">Add:</span>
            <div className="flex overflow-hidden rounded border border-gray-300 text-xs">
              {toolBtn('pen', 'Pen')}
              {toolBtn('emoji', 'Emoji')}
              {toolBtn('text', 'Text')}
              {toolBtn('image', 'Image')}
            </div>
          </>
        )}
      </div>

      {mode === 'draw' && props.drawable && (
        <>
          <div className="mt-2 flex min-h-9 flex-wrap items-center gap-2 text-sm">
            {tool === 'pen' && (
              <>
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    className={
                      'h-8 w-8 rounded-full border-2 border-gray-300 ' +
                      (c === color ? 'ring-[3px] ring-offset-2 ring-black' : '')
                    }
                    style={{ backgroundColor: c }}
                    aria-label={`pen ${c}`}
                    aria-pressed={c === color}
                  />
                ))}
                <label className="flex items-center gap-2 text-xs text-gray-600">
                  Pen size
                  <input
                    type="range"
                    min={2}
                    max={24}
                    value={size}
                    onChange={(e) => setSize(Number(e.target.value))}
                    className="w-24"
                    aria-label="pen size"
                  />
                  <span className="w-5 tabular-nums">{size}</span>
                </label>
              </>
            )}

            {tool === 'select' && (
              <span className="text-[11px] text-gray-400">
                tap a pen stroke, emoji, text or picture to select it — drag to move, use the handles to resize and rotate
              </span>
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
                <span className="text-[11px] text-gray-400">
                  tap the picture to place {selectedEmoji}, then resize it with the handles
                </span>
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
                    className={
                      'h-8 w-8 rounded-full border-2 border-gray-300 ' +
                      (c === textColor ? 'ring-[3px] ring-offset-2 ring-black' : '')
                    }
                    style={{ backgroundColor: c }}
                    aria-label={`text color ${c}`}
                    aria-pressed={c === textColor}
                  />
                ))}
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
                  onChange={(e) => {
                    const input = e.target
                    void handleImageFile(input.files?.[0] ?? null)
                    input.value = '' // so picking the same file again still fires
                  }}
                  aria-label="upload image"
                  className="w-56 cursor-pointer text-xs text-gray-600 file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-blue-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-blue-700 hover:file:bg-blue-100"
                />
                <span className="text-[11px] text-gray-400">
                  {uploadingImage
                    ? 'uploading…'
                    : stagedImage
                      ? 'tap the picture to place another copy of the last picture (Ctrl+V pastes a new one)'
                      : 'choose a picture, or paste one with Ctrl+V'}
                </span>
              </>
            )}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <button type="button" onClick={undo} disabled={doc.past.length === 0} className={btn} title="Undo (Ctrl+Z)">
              Undo
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={doc.future.length === 0}
              className={btn}
              title="Redo (Ctrl+Shift+Z)"
            >
              Redo
            </button>
            <button
              type="button"
              onClick={deleteSelected}
              disabled={!selected}
              className="rounded border border-red-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:hover:bg-white"
              title="Delete the selected item (Delete key)"
            >
              Delete selected
            </button>
            <button type="button" onClick={clearDraft} disabled={items.length === 0} className={btn}>
              Clear draft
            </button>
            <button
              type="button"
              onClick={() => {
                resetDraft()
                setMode('view')
              }}
              className={btn}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={send}
              disabled={pending || items.length === 0}
              className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {pending ? 'Sending…' : 'Send reply'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
