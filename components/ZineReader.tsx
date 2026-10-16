'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Columns2, Download, Maximize2, Minimize2, RotateCw, Square, X } from 'lucide-react'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { holdBodyScroll } from '@/lib/bodyScroll'
import { hapticSelection } from '@/lib/farcasterHaptics'
import { pageAspect, renderPageToBlob, type PdfDocument } from '@/lib/pdfjs'
import { DEFAULT_ASPECT, PAGE_SHADOW, REDUCED_MOTION, STAGE_PAD } from './ZineOpening'

/**
 * The zine reader — a paged, full-screen reader over an open pdf.js document
 * (ZINE_READER_DESIGN.md §5). Serves public zines (bytes from Arweave via
 * the owned download in MomentZine) and collectors-only ones (bytes from the
 * collector-file view route, via CollectorFileViewer); it never fetches
 * anything itself.
 *
 * THE MODEL IS A MAGAZINE, NOT A DOCUMENT VIEWER. One page (or one spread on
 * a wide screen) fills the viewport; swipe, edge taps, arrow keys and a
 * scrubber turn pages; double-tap and pinch zoom the page; a centre tap
 * toggles the chrome, which hides itself after a moment so the page is all
 * there is. No page-curl, no scrolling document.
 *
 * MEMORY IS THE CONSTRAINT, NOT CPU. Every render goes canvas → compressed
 * image blob → canvas zeroed (lib/pdfjs.renderPageToBlob), so what this
 * component holds is a window of small JPEGs, never bitmaps: a 1170 × 1560
 * canvas is ~7 MB, the same page as a JPEG ~300 KB, and iOS WebKit budgets
 * canvases per page and reclaims them lazily. Renders run one at a time so
 * a fast flip cannot pile work on the worker; a flip past an in-flight page
 * cancels it. On close every object URL is revoked.
 */

interface Props {
  doc: PdfDocument
  title: string
  /** 1-based page to open on. */
  startPage?: number
  onClose: () => void
  /** Fires on every page change (the parent owns the URL and the resume). */
  onPageChange?: (page: number) => void
  /** A world-readable URL for "Download PDF" (public zines only). */
  downloadUrl?: string
  /** Replaces the link with a button that the parent handles — a Mini App
   *  opens URLs through its host, not through target=_blank. */
  onDownload?: () => void
  /** Tick the host's selection haptic on every page turn (Mini App only;
   *  the helper is a no-op elsewhere but costs a chunk, so it is gated). */
  haptics?: boolean
  /** Extra rotation to open with (0 / 90 / 180 / 270) — a landscape scan a
   *  reader turned upright last time. */
  startRotation?: number
  onRotationChange?: (rotation: number) => void
  /** The reading room's background (components/ZineOpening `zineBackdrop`),
   *  the same one the opening frame used, so the handoff is seamless. */
  backdrop?: string
  /** Once, when the first view's pages have painted — the opening frame
   *  fades away on it. */
  onFirstPage?: () => void
}

type PageRender =
  | { ok: true; url: string; cssWidth: number; rotation: number }
  | { ok: false }

const MIN_ZOOM = 1
const MAX_ZOOM = 4
const DOUBLE_TAP_ZOOM = 2.5
const DOUBLE_TAP_MS = 300
const CHROME_HIDE_MS = 2500
/** Neighbouring views sit one stage-width plus this apart on the track, so
 *  two pages never touch while one slides over the other. */
const SLOT_GAP = 24
/** A finger has to travel this far before a drag picks an axis; under it,
 *  the touch is still a tap. */
const DRAG_SLOP = 8
/** Release rules — the consensus of Swiper, PhotoSwipe and Android's
 *  ViewPager: a throw of at least FLICK_VELOCITY px/ms the way the page
 *  travelled, after FLICK_MIN px of finger travel, turns; otherwise a drag
 *  turns once past half a view, unless the finger is already heading back
 *  faster than BACK_VELOCITY. */
const FLICK_VELOCITY = 0.4
const FLICK_MIN = 20
const BACK_VELOCITY = 0.1
/** A finger that was still this long before lifting threw nothing
 *  (Flutter's velocity tracker). */
const STILL_MS = 40
/** Settles: a turn crosses a whole view, a snap-back only part of one. */
const TURN_MS = 300
const SNAP_MS = 240
/** Double-tap and keyboard zoom animate (PhotoSwipe's curve); pinch and
 *  wheel track the hand. */
const ZOOM_MS = 300
const ZOOM_EASE = 'cubic-bezier(0.4, 0, 0.22, 1)'
/** Pulling a page down (touch) closes the reader past this fraction of the
 *  stage height, or at this downward speed in px/ms. */
const DISMISS_FRACTION = 0.2
const DISMISS_VELOCITY = 0.5
/** Keep renders for pages within this distance of the one in view. A phone
 *  pre-renders one neighbour each way: decoding and drawing an 8.7 MP scan
 *  measured ~150 ms in Chromium, which decodes JPEG natively, and Safari —
 *  no ImageDecoder, so pdf.js decodes JPEG in JavaScript — is several times
 *  slower; two each way after every turn is heat, battery and memory for
 *  pages the reader may never reach, and the next page is ready either way.
 *  A wide screen, which also shows spreads, keeps two. */
const WINDOW_WIDE = 2
const WINDOW_NARROW = 1
const NARROW_MAX_WIDTH = 700
/** Spreads need a landscape viewport at least this wide. */
const SPREAD_MIN_WIDTH = 900
/** A view that follows the last one within this long is a scrub passing
 *  through: its renders wait until the reader settles. */
const SCRUB_MS = 90
/** Position marks show one segment per page up to this count, a single
 *  line beyond it. */
const SEGMENT_MAX = 24

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** The views a stapled booklet opens to: the cover alone, then facing pairs
 *  — 2–3, 4–5, … — except that a page wider than tall is already an opening
 *  (a spread exported as one page) and stands alone, the pairing restarting
 *  after it; an unpaired last page stands alone too. IIIF's facing-pages
 *  rule, and how Komga pairs; Issuu pairs regardless, and pre-paired
 *  spreads come out paired twice. */
function pairViews(pages: number, wide: (n: number) => boolean): [number, number | null][] {
  const views: [number, number | null][] = [[1, null]]
  for (let n = 2; n <= pages; ) {
    if (n === pages || wide(n) || wide(n + 1)) {
      views.push([n, null])
      n += 1
    } else {
      views.push([n, n + 1])
      n += 2
    }
  }
  return views
}

/** iOS's rubber band: past an edge the page gives less the further it is
 *  pulled, never more than `dim`. */
function rubber(x: number, dim: number): number {
  const c = 0.55
  return Math.sign(x) * (1 - 1 / ((Math.abs(x) * c) / Math.max(1, dim) + 1)) * dim
}

/** A settle's easing: a critically damped spring's shape drawn as a
 *  cubic-bezier — WebKit runs CSS linear() on the main thread, a bezier
 *  stays on the compositor — opened at the finger's own speed, so a thrown
 *  page carries straight on. A bezier's opening slope is y1/x1, so over `ms`
 *  and `distance` it starts at (y1/x1)·distance/ms px/ms; from rest it
 *  opens at 1.2× the mean speed (≈ PhotoSwipe's 30 rad/s spring). */
function settleEase(speedTowardRest: number, ms: number, distance: number): string {
  const x1 = 0.25
  const y1 = speedTowardRest > 0 && distance > 0 ? Math.min(1, (x1 * speedTowardRest * ms) / distance) : 0.3
  return `cubic-bezier(${x1}, ${y1.toFixed(3)}, 0.08, 1)`
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const compute = () => setMatches(mq.matches)
    compute()
    mq.addEventListener('change', compute)
    return () => mq.removeEventListener('change', compute)
  }, [query])
  return matches
}

export function ZineReader({
  doc,
  title,
  startPage,
  onClose,
  onPageChange,
  downloadUrl,
  onDownload,
  haptics = false,
  startRotation = 0,
  onRotationChange,
  backdrop,
  onFirstPage,
}: Props) {
  const pages = doc.numPages
  const [page, setPageState] = useState(() => clamp(Math.floor(startPage ?? 1) || 1, 1, pages))
  const [stage, setStage] = useState({ w: 0, h: 0 })
  const [spreadPref, setSpreadPref] = useState<'auto' | 'single'>('auto')
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [chrome, setChrome] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)
  // Extra rotation for the whole document: a scan of a landscape spread on a
  // portrait sheet reads sideways on a phone until it is turned. Every render
  // carries the rotation it was made at, and a change throws the cache away.
  const [rotation, setRotation] = useState(() => ([90, 180, 270].includes(startRotation) ? startRotation : 0))
  const rotationRef = useRef(rotation)
  const onRotationChangeRef = useRef(onRotationChange)
  onRotationChangeRef.current = onRotationChange
  const [tick, bump] = useState(0)
  const rerender = useCallback(() => bump((n) => n + 1), [])
  const reduceMotion = useMediaQuery(REDUCED_MOTION)
  const reduceMotionRef = useRef(reduceMotion)
  reduceMotionRef.current = reduceMotion
  const finePointer = useMediaQuery('(hover: hover) and (pointer: fine)')
  const [hoverEdge, setHoverEdge] = useState<-1 | 0 | 1>(0)
  // The first view's paint, reported once (the opening frame fades on it).
  const onFirstPageRef = useRef(onFirstPage)
  onFirstPageRef.current = onFirstPage
  const firstPaintedRef = useRef(false)
  const [painted, setPainted] = useState(false)
  const firePainted = useCallback(() => {
    if (firstPaintedRef.current) return
    firstPaintedRef.current = true
    setPainted(true)
    // A frame later, so the page has been on screen before the frame fades.
    requestAnimationFrame(() => onFirstPageRef.current?.())
  }, [])

  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const dprRef = useRef(1)
  // Rendered pages (fit-size) and the single zoomed render of the page in view.
  const rendersRef = useRef(new Map<number, PageRender>())
  const aspectsRef = useRef(new Map<number, number>())
  // Queued renders by page, with the controller that cancels each; the set
  // of pages the window wants right now, consulted when a job starts and
  // when its result lands, so a flip past a queued page costs nothing.
  const pendingRef = useRef(new Map<number, AbortController>())
  const wantedRef = useRef(new Set<number>())
  const zoomRenderRef = useRef<{ page: number; zoom: number; url: string } | null>(null)
  const zoomRenderTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // One render at a time; every render carries an abort signal the flip
  // logic and unmount can fire.
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const abortsRef = useRef(new Set<AbortController>())
  const liveRef = useRef(true)
  const chromeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const onPageChangeRef = useRef(onPageChange)
  onPageChangeRef.current = onPageChange
  // The current page, zoom and pan as refs, for handlers and jobs that must
  // read the latest value without re-subscribing on every change.
  const pageRef = useRef(page)
  pageRef.current = page
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const panRef = useRef(pan)
  panRef.current = pan

  useFocusTrap(rootRef, true)
  // Focus rests on the dialog itself rather than its first button: nothing
  // in the chrome holds focus at open, so the chrome can step aside; Tab
  // reaches it. (The trap above has already noted the opener to return to.)
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  // Body scroll lock, counted (lib/bodyScroll): the opening frame holds one
  // too while it hands off, and the in-app overlay route may hold its own —
  // the last release puts back exactly what the first hold found.
  useEffect(() => holdBodyScroll(), [])

  // Escape closes the reader and ONLY the reader. Captured on window so the
  // overlay route's own Escape listener (which navigates back) never sees
  // the key while a zine is open; the lightbox has the same stacking today.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  // The X and Escape fade the reader out before closing — an exit that
  // eases away as the cover eased in. (The back gesture closes at once: the
  // host animates that one itself.)
  const closingRef = useRef(false)
  const closeGently = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    const el = rootRef.current
    if (!el || reduceMotionRef.current) { onCloseRef.current(); return }
    const a = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-in', fill: 'forwards' })
    const done = () => {
      onCloseRef.current()
      // Still here a second later (a host that never popped): show again.
      setTimeout(() => {
        if (!liveRef.current) return
        closingRef.current = false
        a.cancel()
      }, 1000)
    }
    a.finished.then(done, done)
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      e.preventDefault()
      closeGently()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [closeGently])

  // ── geometry ──────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    dprRef.current = Math.min(window.devicePixelRatio || 1, 3)
    const el = stageRef.current
    if (!el) return
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const spread = spreadPref === 'auto' && pages > 1 && stage.w >= SPREAD_MIN_WIDTH && stage.w > stage.h
  /** Wider than tall as displayed (a quarter turn swaps the sides). A page
   *  whose size is not known yet counts as upright. */
  const isWide = useCallback((n: number) => {
    const a = aspectsRef.current.get(n)
    return a !== undefined && (rotation % 180 === 0 ? a : 1 / a) > 1.05
  }, [rotation])
  // Re-paired as page sizes arrive: they land in a ref, and `tick` is the
  // render that follows each one.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const views = useMemo(() => (spread ? pairViews(pages, isWide) : null), [spread, pages, isWide, tick])
  /** The pages of the view that shows `p`. */
  const viewOf = useCallback(
    (p: number): [number, number | null] => views?.find(([l, r]) => p === l || p === r) ?? [p, null],
    [views],
  )
  const [left, right] = viewOf(page)
  const visible = useMemo(() => (right ? [left, right] : [left]), [left, right])

  // Aspects are cached UNROTATED; the displayed aspect flips with the
  // rotation (a quarter turn swaps width and height).
  const aspectOf = useCallback((n: number) => {
    const base = aspectsRef.current.get(n) ?? aspectsRef.current.get(1) ?? DEFAULT_ASPECT
    return rotation % 180 === 0 ? base : 1 / base
  }, [rotation])

  /** CSS size of a page's slot at zoom 1. */
  const fitBox = useCallback((n: number): { w: number; h: number } => {
    // In a spread a page takes half the stage — unless it is wide, an opening
    // of its own, shown alone across the whole stage.
    const availW = Math.max(1, spread && !isWide(n) ? stage.w / 2 - STAGE_PAD : stage.w - STAGE_PAD * 2)
    const availH = Math.max(1, stage.h - STAGE_PAD * 2)
    const aspect = aspectOf(n)
    const w = Math.min(availW, availH * aspect)
    return { w, h: w / aspect }
  }, [spread, stage.w, stage.h, aspectOf, isWide])
  const fitBoxRef = useRef(fitBox)
  fitBoxRef.current = fitBox

  // ── rendering ─────────────────────────────────────────────────────────
  const revokeRender = (r: PageRender | undefined) => {
    if (r?.ok) URL.revokeObjectURL(r.url)
  }
  const dropZoomRender = useCallback(() => {
    if (zoomRenderRef.current) {
      URL.revokeObjectURL(zoomRenderRef.current.url)
      zoomRenderRef.current = null
    }
  }, [])

  const enqueue = useCallback((job: (signal: AbortSignal) => Promise<void>) => {
    const controller = new AbortController()
    abortsRef.current.add(controller)
    queueRef.current = queueRef.current
      .then(() => (liveRef.current && !controller.signal.aborted ? job(controller.signal) : undefined))
      .catch(() => {})
      .finally(() => abortsRef.current.delete(controller))
    return controller
  }, [])

  const ensureRendered = useCallback((n: number) => {
    const cssWidth = fitBoxRef.current(n).w
    const existing = rendersRef.current.get(n)
    // A render at (or close to) the needed width and at the current rotation
    // is reused; a much wider viewport (a window resize) gets a fresh one.
    if (existing && (!existing.ok || (existing.rotation === rotationRef.current && existing.cssWidth >= cssWidth * 0.8))) return
    if (pendingRef.current.has(n)) return
    const controller = enqueue(async (signal) => {
      // Queued for a page the reader has since left: nothing to do.
      if (!wantedRef.current.has(n)) return
      const rot = rotationRef.current
      try {
        const pdfPage = await doc.getPage(n)
        if (!aspectsRef.current.has(n)) aspectsRef.current.set(n, pageAspect(pdfPage, 0))
        // The width is taken NOW, with the aspect known: queued before it
        // was (the default, or page 1's), a landscape page on a landscape
        // viewport would be rendered for a slot half its size and stay soft.
        const width = fitBoxRef.current(n).w
        const rendered = await renderPageToBlob(pdfPage, { cssWidth: width, dpr: dprRef.current, rotation: rot, signal })
        // Turned, or flipped away, while this rendered: nobody is looking.
        if (!liveRef.current || rot !== rotationRef.current || !wantedRef.current.has(n)) return
        revokeRender(rendersRef.current.get(n))
        rendersRef.current.set(n, { ok: true, url: URL.createObjectURL(rendered.blob), cssWidth: width, rotation: rot })
      } catch (err) {
        if (signal.aborted || !liveRef.current) return
        if (err && typeof err === 'object' && (err as { name?: string }).name === 'RenderingCancelledException') return
        rendersRef.current.set(n, { ok: false })
      } finally {
        if (pendingRef.current.get(n) === controller) pendingRef.current.delete(n)
        if (liveRef.current) rerender()
      }
    })
    pendingRef.current.set(n, controller)
  }, [doc, enqueue, rerender])

  // Render the pages in view first, then their neighbours; evict the rest.
  // A scrub — views arriving faster than SCRUB_MS apart — renders only where
  // it lands: starting a page is a full JPEG decode in the worker even if it
  // is cancelled a moment later. (Fetching a page used to cost a worker
  // round trip that hid this; with every page's shape learned up front, the
  // pause has to be deliberate.) A reader turning at reading pace is never
  // made to wait.
  const lastLeftRef = useRef(left)
  const lastViewAtRef = useRef(0)
  const deferRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const orderRef = useRef<number[]>([])
  useEffect(() => {
    if (!stage.w || !stage.h) return
    const order: number[] = [...visible]
    const window = stage.w <= NARROW_MAX_WIDTH ? WINDOW_NARROW : WINDOW_WIDE
    for (let d = 1; d <= window; d++) {
      if (left - d >= 1) order.push(left - d)
      const after = (right ?? left) + d
      if (after <= pages) order.push(after)
    }
    const keep = new Set(order)
    wantedRef.current = keep
    // Pages queued for a view the reader has left: cancelled now, so a
    // scrubber drag across a long zine never renders every page it passed.
    for (const [n, c] of pendingRef.current) {
      if (!keep.has(n)) {
        c.abort()
        pendingRef.current.delete(n)
      }
    }
    for (const [n, r] of rendersRef.current) {
      if (!keep.has(n)) {
        revokeRender(r)
        rendersRef.current.delete(n)
      }
    }
    orderRef.current = order
    const moved = left !== lastLeftRef.current
    lastLeftRef.current = left
    if (moved) {
      // A page that failed to render gets another try once the reader moves
      // on — the failure may have been passing (canvas memory under
      // pressure on iOS). Once per move, never in a loop.
      for (const [n, r] of rendersRef.current) if (!r.ok) rendersRef.current.delete(n)
      const now = performance.now()
      const scrubbing = now - lastViewAtRef.current < SCRUB_MS
      lastViewAtRef.current = now
      clearTimeout(deferRef.current)
      deferRef.current = undefined
      if (scrubbing) {
        deferRef.current = setTimeout(() => {
          deferRef.current = undefined
          for (const n of orderRef.current) ensureRendered(n)
        }, SCRUB_MS)
        return
      }
    } else if (deferRef.current) {
      return // the scrub's own pass will render this view when it settles
    }
    for (const n of order) ensureRendered(n)
    // `tick` re-runs this when a render or an aspect lands, so a page whose
    // slot grew once its aspect was known is re-rendered for the real slot;
    // `rotation` re-runs it after a turn emptied the cache (rotateBy).
  }, [visible, left, right, pages, stage.w, stage.h, ensureRendered, tick, rotation])

  // Page sizes for the skeletons: learn the aspects of the pages in view
  // before their render lands, so the slot has the right shape from the
  // first frame.
  useEffect(() => {
    let cancelled = false
    for (const n of visible) {
      if (aspectsRef.current.has(n)) continue
      void doc.getPage(n).then((p) => {
        if (cancelled || !liveRef.current) return
        aspectsRef.current.set(n, pageAspect(p, 0))
        rerender()
      }).catch(() => {})
    }
    return () => { cancelled = true }
  }, [visible, doc, rerender])

  // A crisper render for the zoomed page, debounced behind the gesture.
  useEffect(() => {
    clearTimeout(zoomRenderTimerRef.current)
    if (zoom <= 1 || spread) {
      dropZoomRender()
      return
    }
    zoomRenderTimerRef.current = setTimeout(() => {
      const want = fitBox(page).w * zoom
      const have = zoomRenderRef.current
      if (have && have.page === page && Math.abs(have.zoom - zoom) < 0.05) return
      enqueue(async (signal) => {
        const rot = rotationRef.current
        try {
          const pdfPage = await doc.getPage(page)
          const rendered = await renderPageToBlob(pdfPage, { cssWidth: want, dpr: dprRef.current, rotation: rot, signal })
          // Turned, turned the page, or zoomed back out meanwhile: not wanted.
          if (!liveRef.current || rot !== rotationRef.current || pageRef.current !== page || zoomRef.current <= 1) return
          dropZoomRender()
          zoomRenderRef.current = { page, zoom, url: URL.createObjectURL(rendered.blob) }
          rerender()
        } catch {
          /* the fit-size render stays on screen */
        }
      })
    }, 220)
    return () => clearTimeout(zoomRenderTimerRef.current)
  }, [zoom, page, spread, rotation, doc, enqueue, fitBox, dropZoomRender, rerender])

  // Unmount: stop everything, release every URL. The maps are captured here
  // rather than read through the refs in the cleanup, which runs after the
  // refs could have been replaced.
  useEffect(() => {
    liveRef.current = true
    const aborts = abortsRef.current
    const renders = rendersRef.current
    return () => {
      liveRef.current = false
      for (const c of aborts) c.abort()
      aborts.clear()
      for (const r of renders.values()) revokeRender(r)
      renders.clear()
      dropZoomRender()
      clearTimeout(chromeTimerRef.current)
      clearTimeout(zoomRenderTimerRef.current)
      clearTimeout(zoomAnimTimerRef.current)
      clearTimeout(deferRef.current)
    }
  }, [dropZoomRender])

  // ── navigation ────────────────────────────────────────────────────────
  const resetZoom = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])
  // The next zoom change animates (a double tap, a key) — pinch, wheel and
  // pan never do: they follow the hand.
  const zoomAnimRef = useRef(false)
  const zoomAnimTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const animateZoomNext = useCallback(() => {
    if (reduceMotionRef.current) return
    zoomAnimRef.current = true
    clearTimeout(zoomAnimTimerRef.current)
    zoomAnimTimerRef.current = setTimeout(() => { zoomAnimRef.current = false }, ZOOM_MS + 60)
  }, [])

  const hapticsRef = useRef(haptics)
  hapticsRef.current = haptics
  const setPage = useCallback((n: number) => {
    const next = clamp(Math.round(n), 1, pages)
    resetZoom()
    // Compared against the ref, not inside the updater: StrictMode runs
    // updaters twice, and a page turn's side effects must happen once.
    if (next === pageRef.current) return
    pageRef.current = next
    setPageState(next)
    onPageChangeRef.current?.(next)
    // A page turn feels like one in a Mini App: the host's selection tick.
    if (hapticsRef.current) hapticSelection()
  }, [pages, resetZoom])

  // Turning the document invalidates every render. Done HERE, synchronously,
  // before the state update: the window effect that schedules fresh renders
  // runs on the commit that follows, and must find the cache empty and the
  // ref already turned — an effect that invalidated afterwards would abort
  // the very jobs that effect had just queued, and nothing would re-queue
  // them (the e2e caught exactly that: a skeleton forever after a rotate).
  const rotateBy = useCallback((delta: 90 | 270) => {
    const next = (rotationRef.current + delta) % 360
    rotationRef.current = next
    for (const c of abortsRef.current) c.abort()
    abortsRef.current.clear()
    pendingRef.current.clear()
    for (const r of rendersRef.current.values()) revokeRender(r)
    rendersRef.current.clear()
    dropZoomRender()
    onRotationChangeRef.current?.(next)
    setRotation(next)
    resetZoom()
  }, [dropZoomRender, resetZoom])
  /** The button and `r`: a quarter turn clockwise. `R` (shift) turns the
   *  other way — a scanned sheet that lands upside down after the first
   *  turn needed the counter-clockwise one, and three taps is the touch
   *  path; the turn is remembered per artwork, so it is set once. */
  const rotate = useCallback(() => rotateBy(90), [rotateBy])
  const rotateBack = useCallback(() => rotateBy(270), [rotateBy])

  // ── the track: one physical model for every turn ─────────────────────
  // The view in front and its neighbours sit side by side on a track. A drag
  // moves the track with the finger, and every turn — a released drag, a
  // key, an edge tap, a button, the wheel — is the track settling one view
  // over. The page commits at the START of a turn (counter, URL and haptic
  // respond at once) and the track is re-based in the same frame so nothing
  // on screen jumps; the settle is purely visual and interruptible: a new
  // turn, or a finger landing on the moving page, continues from wherever
  // it is.
  const trackRef = useRef<HTMLDivElement>(null)
  const settleRef = useRef<Animation | null>(null)
  const pendingFromRef = useRef<{ x: number; v: number } | null>(null)
  const spanRef = useRef(0)
  spanRef.current = stage.w + SLOT_GAP

  /** The page anchoring the next / previous view, or null at an end — the
   *  last spread may already end on the back cover: no phantom turn. */
  const nextAnchor = useCallback((p: number) => {
    const [l, r] = viewOf(p)
    const last = r ?? l
    return last < pages ? last + 1 : null
  }, [viewOf, pages])
  const prevAnchor = useCallback((p: number) => {
    const l = viewOf(p)[0]
    return l > 1 ? l - 1 : null
  }, [viewOf])

  const setTrack = (x: number) => {
    const el = trackRef.current
    if (el) el.style.transform = x ? `translate3d(${x}px,0,0)` : ''
  }
  /** Where the track is on screen right now, a settle included — and stop
   *  it there. */
  const grabTrack = useCallback((): number => {
    const el = trackRef.current
    if (!el) return 0
    const t = getComputedStyle(el).transform
    const x = t && t !== 'none' ? new DOMMatrixReadOnly(t).m41 : 0
    settleRef.current?.cancel()
    settleRef.current = null
    setTrack(x)
    return x
  }, [])
  /** Settle the track from `from` to rest; `v` is the finger's release
   *  velocity (px/ms), carried into the curve when it points at rest. */
  const settleTrack = useCallback((from: number, ms: number, v = 0) => {
    settleRef.current?.cancel()
    settleRef.current = null
    setTrack(0)
    const el = trackRef.current
    if (!el || !from || reduceMotionRef.current) return
    settleRef.current = el.animate(
      [{ transform: `translate3d(${from}px,0,0)` }, { transform: 'translate3d(0,0,0)' }],
      { duration: ms, easing: settleEase(-Math.sign(from) * v, ms, Math.abs(from)) },
    )
  }, [])

  /** Turn to `target` — the next or previous view's anchor — settling from
   *  `from` (a released drag) or from wherever the track is now. */
  const turnTo = useCallback((target: number, dir: 1 | -1, from?: number, v = 0) => {
    if (target === pageRef.current) return
    const x = from ?? grabTrack()
    pendingFromRef.current = { x: x + dir * spanRef.current, v }
    setPage(target)
  }, [grabTrack, setPage])

  const step = useCallback((dir: 1 | -1) => {
    // The page comes from the ref, not closed-over state: a key pressed
    // within a frame of the previous turn would otherwise still see the old
    // page and swallow the turn.
    const p = pageRef.current
    const target = dir > 0 ? nextAnchor(p) : prevAnchor(p)
    if (target !== null) turnTo(target, dir)
  }, [nextAnchor, prevAnchor, turnTo])

  // A committed page change re-bases the track before the browser paints: a
  // turn settles from where its pages were; a jump (the scrubber, Home/End,
  // a resume) lands at rest. Reduced motion: no slide, a short crossfade.
  useLayoutEffect(() => {
    const pending = pendingFromRef.current
    pendingFromRef.current = null
    if (pending === null || reduceMotionRef.current) {
      settleRef.current?.cancel()
      settleRef.current = null
      setTrack(0)
      if (pending !== null) trackRef.current?.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' })
      return
    }
    settleTrack(pending.x, TURN_MS, pending.v)
  }, [page, settleTrack])
  // A new layout (a resize, the spread toggle) is a new track: at rest.
  useLayoutEffect(() => {
    settleRef.current?.cancel()
    settleRef.current = null
    setTrack(0)
  }, [spread, stage.w])

  // The chrome answers to reading, not to a clock alone: it shows on open,
  // on a moving mouse and on a centre tap; a turn sends it away at once
  // (the position marks keep the place); and it never hides a control that
  // holds keyboard focus — a hidden focused button is a dead end.
  const chromeFocused = () => !!(document.activeElement as HTMLElement | null)?.closest?.('[data-chrome]')
  const pokeChrome = useCallback(() => {
    setChrome(true)
    clearTimeout(chromeTimerRef.current)
    const arm = () => {
      chromeTimerRef.current = setTimeout(() => (chromeFocused() ? arm() : setChrome(false)), CHROME_HIDE_MS)
    }
    arm()
  }, [])
  const hideChrome = useCallback(() => {
    if (chromeFocused()) return
    clearTimeout(chromeTimerRef.current)
    setChrome(false)
  }, [])
  useEffect(() => { pokeChrome() }, [pokeChrome])

  // Clamp the pan so the page never drifts out of the stage.
  const clampPan = useCallback((p: { x: number; y: number }, z: number) => {
    const box = fitBox(page)
    const overX = Math.max(0, (box.w * z - stage.w) / 2 + STAGE_PAD)
    const overY = Math.max(0, (box.h * z - stage.h) / 2 + STAGE_PAD)
    return { x: clamp(p.x, -overX, overX), y: clamp(p.y, -overY, overY) }
  }, [fitBox, page, stage.w, stage.h])

  /** Zoom about a point given relative to the stage centre, keeping the
   *  image point under it in place: p' = F − (F − p) · (z' / z). */
  const zoomAbout = useCallback((nextZoom: number, focal: { x: number; y: number }) => {
    const z1 = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM)
    setZoom((z0) => {
      const ratio = z1 / z0
      setPan((p) => clampPan({ x: focal.x - (focal.x - p.x) * ratio, y: focal.y - (focal.y - p.y) * ratio }, z1))
      return z1
    })
    if (z1 === 1) setPan({ x: 0, y: 0 })
  }, [clampPan])

  const stageCentre = useCallback(() => {
    const r = stageRef.current?.getBoundingClientRect()
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 0, y: 0 }
  }, [])

  // ── keyboard ──────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      // Browser and system shortcuts stay theirs: ⌘R reloads rather than
      // rotating, and ⌘+ / ⌘− / ⌘0 zoom the browser — the reader re-fits.
      if (e.ctrlKey || e.metaKey || e.altKey) return
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
          e.preventDefault(); step(1); hideChrome(); return
        case ' ':
          e.preventDefault(); step(e.shiftKey ? -1 : 1); hideChrome(); return
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
        case 'Backspace':
          e.preventDefault(); step(-1); hideChrome(); return
        case 'Home':
          e.preventDefault(); setPage(1); hideChrome(); return
        case 'End':
          e.preventDefault(); setPage(pages); hideChrome(); return
        case '+':
        case '=':
          e.preventDefault(); if (!spread) { animateZoomNext(); zoomAbout(zoomRef.current * 1.5, { x: 0, y: 0 }) } break
        case '-':
          e.preventDefault(); if (!spread) { animateZoomNext(); zoomAbout(zoomRef.current / 1.5, { x: 0, y: 0 }) } break
        case '0':
          e.preventDefault(); animateZoomNext(); resetZoom(); break
        case 'r':
          e.preventDefault(); rotate(); break
        case 'R':
          e.preventDefault(); rotateBack(); break
        default:
          return
      }
      pokeChrome()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, setPage, pages, spread, zoomAbout, resetZoom, rotate, rotateBack, pokeChrome, hideChrome, animateZoomNext])

  // ── pointer gestures ──────────────────────────────────────────────────
  // One finger at zoom 1: a horizontal drag moves the track with the finger;
  // on touch, a vertical pull draws the page down to close (the artwork page
  // shows through as the room fades). Zoomed, one finger pans. Two pinch. A
  // touch that never travels past the slop is a tap.
  type Gesture = {
    startX: number
    startY: number
    startPan: { x: number; y: number }
    /** The track's offset at the moment the drag took hold (a page caught
     *  mid-settle stays where it was caught). */
    baseX: number
    moved: boolean
    axis: 'x' | 'y' | null
    touch: boolean
    samples: { t: number; x: number; y: number }[]
    /** When the finger last actually moved. */
    lastMoveT: number
    pinch: { startDist: number; startZoom: number } | null
  }
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const gestureRef = useRef<Gesture | null>(null)
  const lastTapRef = useRef<{ t: number; x: number; y: number } | null>(null)
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const backdropRef = useRef<HTMLDivElement>(null)

  // Every sample the browser has, not one per frame: Chrome coalesces
  // pointermoves to the frame rate, and the in-between samples steady the
  // velocity a release is judged by.
  const sample = (g: Gesture, e: React.PointerEvent) => {
    const native = e.nativeEvent as PointerEvent
    const coalesced = native.getCoalescedEvents?.() ?? []
    for (const ev of coalesced.length ? coalesced : [native]) {
      const prev = g.samples[g.samples.length - 1]
      if (!prev || prev.x !== ev.clientX || prev.y !== ev.clientY) g.lastMoveT = ev.timeStamp
      g.samples.push({ t: ev.timeStamp, x: ev.clientX, y: ev.clientY })
    }
    while (g.samples.length > 3 && native.timeStamp - g.samples[0].t > 120) g.samples.shift()
  }
  /** Release velocity (px/ms): a least-squares line through the last 100 ms
   *  of samples (Flutter's tracker) — or 0 if the finger had been still for
   *  STILL_MS before it lifted. */
  const velocity = (g: Gesture, axis: 'x' | 'y'): number => {
    const s = g.samples
    const last = s[s.length - 1]
    if (!last || last.t - g.lastMoveT > STILL_MS) return 0
    const win = s.filter((q) => last.t - q.t <= 100)
    if (win.length < 2) return 0
    const at = (q: { x: number; y: number }) => (axis === 'x' ? q.x : q.y)
    const mt = win.reduce((a, q) => a + q.t, 0) / win.length
    const mp = win.reduce((a, q) => a + at(q), 0) / win.length
    let num = 0
    let den = 0
    for (const q of win) {
      num += (q.t - mt) * (at(q) - mp)
      den += (q.t - mt) * (q.t - mt)
    }
    return den > 0 ? num / den : 0
  }
  /** The track position for a raw drag offset: past either end of the zine
   *  it gives way like iOS's rubber band. */
  const resistX = (x: number) => {
    const p = pageRef.current
    if ((x < 0 && nextAnchor(p) === null) || (x > 0 && prevAnchor(p) === null)) return rubber(x, stage.w)
    return x
  }

  const pull = (dy: number) => {
    const y = dy > 0 ? dy : rubber(dy, stage.h * 0.2)
    const k = Math.min(1, Math.max(0, y) / Math.max(1, stage.h))
    const scale = reduceMotionRef.current ? '' : ` scale(${1 - k * 0.15})`
    if (trackRef.current) trackRef.current.style.transform = `translate3d(0,${y}px,0)${scale}`
    if (backdropRef.current) backdropRef.current.style.opacity = String(Math.max(0, 1 - k * 1.8))
  }
  const releasePull = (close: boolean) => {
    const el = trackRef.current
    const bd = backdropRef.current
    const from = el?.style.transform || 'none'
    const fromOpacity = bd ? Number(bd.style.opacity || '1') : 1
    if (close) {
      // Away down the screen — or, with motion reduced, a fade where it was
      // let go.
      const out = el?.animate(
        reduceMotionRef.current
          ? [{ opacity: 1 }, { opacity: 0 }]
          : [{ transform: from }, { transform: `translate3d(0,${stage.h}px,0) scale(0.85)` }],
        { duration: 220, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
      )
      bd?.animate([{ opacity: fromOpacity }, { opacity: 0 }], { duration: 220, easing: 'ease-in', fill: 'forwards' })
      const done = () => onCloseRef.current()
      if (out) out.finished.then(done, done)
      else done()
      return
    }
    if (el) {
      el.style.transform = ''
      if (!reduceMotionRef.current) el.animate([{ transform: from }, { transform: 'none' }], { duration: SNAP_MS, easing: settleEase(0, SNAP_MS, 1) })
    }
    if (bd) {
      bd.style.opacity = ''
      bd.animate([{ opacity: fromOpacity }, { opacity: 1 }], { duration: SNAP_MS, easing: 'ease-out' })
    }
  }
  /** Whatever one finger was doing, undone (a second finger, a cancel). */
  const abandonDrag = (g: Gesture | null) => {
    if (g?.axis === 'x') settleTrack(grabTrack(), SNAP_MS)
    if (g?.axis === 'y' && g.touch) releasePull(false)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    zoomAnimRef.current = false
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const base = { startX: e.clientX, startY: e.clientY, startPan: panRef.current, baseX: 0, axis: null, touch: e.pointerType === 'touch', samples: [], lastMoveT: e.timeStamp }
    if (pointersRef.current.size === 2) {
      abandonDrag(gestureRef.current)
      const [a, b] = [...pointersRef.current.values()]
      gestureRef.current = { ...base, moved: true, pinch: { startDist: Math.hypot(a.x - b.x, a.y - b.y), startZoom: zoomRef.current } }
      clearTimeout(tapTimerRef.current)
      return
    }
    const g: Gesture = { ...base, moved: false, pinch: null }
    sample(g, e)
    gestureRef.current = g
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gestureRef.current
    if (!g || !pointersRef.current.has(e.pointerId)) return
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (g.pinch && pointersRef.current.size >= 2) {
      const [a, b] = [...pointersRef.current.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      const c = stageCentre()
      const focal = { x: (a.x + b.x) / 2 - c.x, y: (a.y + b.y) / 2 - c.y }
      if (!spread) zoomAbout((g.pinch.startZoom * dist) / Math.max(1, g.pinch.startDist), focal)
      return
    }
    const dx = e.clientX - g.startX
    const dy = e.clientY - g.startY
    if (!g.moved && Math.hypot(dx, dy) > 6) g.moved = true
    if (zoomRef.current > 1) {
      if (g.moved) setPan(clampPan({ x: g.startPan.x + dx, y: g.startPan.y + dy }, zoomRef.current))
      return
    }
    sample(g, e)
    if (!g.axis && Math.hypot(dx, dy) > DRAG_SLOP) {
      g.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y'
      if (g.axis === 'x') {
        // Take hold of the track where it is — mid-settle included — so the
        // page under the finger does not jump to catch up. The edge hint
        // steps aside: the page is in hand, not waiting for a click.
        g.baseX = grabTrack() - dx
        setHoverEdge(0)
      } else if (g.touch) {
        settleRef.current?.cancel()
        settleRef.current = null
        setChrome(false)
      }
    }
    if (g.axis === 'x') setTrack(resistX(g.baseX + dx))
    else if (g.axis === 'y' && g.touch) pull(dy)
  }

  // A cancelled pointer (the browser took the gesture) acts on nothing; a
  // drag it interrupts settles back.
  const cancelPointer = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId)
    clearTimeout(tapTimerRef.current)
    if (pointersRef.current.size === 0) {
      abandonDrag(gestureRef.current)
      gestureRef.current = null
    }
  }

  const endPointer = (e: React.PointerEvent) => {
    const g = gestureRef.current
    pointersRef.current.delete(e.pointerId)
    if (!g) return
    if (g.pinch) {
      // A pinch that drops to one finger continues as a pan from where that
      // finger is now, not from the lifted finger's start.
      const rest = [...pointersRef.current.values()][0]
      gestureRef.current = rest
        ? { startX: rest.x, startY: rest.y, startPan: panRef.current, baseX: 0, moved: true, axis: null, touch: g.touch, samples: [], lastMoveT: 0, pinch: null }
        : null
      return
    }
    gestureRef.current = null
    sample(g, e)
    if (g.axis === 'x') {
      // The release: a throw the way the page travelled turns from a few
      // pixels; a slow drag turns once past the middle; a drag past the
      // middle whose finger is already heading home does not.
      const travel = e.clientX - g.startX
      const x = resistX(g.baseX + travel)
      const v = velocity(g, 'x')
      const half = spanRef.current / 2
      const p = pageRef.current
      const next = nextAnchor(p)
      const prev = prevAnchor(p)
      const toNext = (v <= -FLICK_VELOCITY && travel <= -FLICK_MIN) || (x < -half && v < BACK_VELOCITY)
      const toPrev = (v >= FLICK_VELOCITY && travel >= FLICK_MIN) || (x > half && v > -BACK_VELOCITY)
      if (toNext && next !== null) {
        turnTo(next, 1, x, v)
        hideChrome()
      } else if (toPrev && prev !== null) {
        turnTo(prev, -1, x, v)
        hideChrome()
      } else settleTrack(x, SNAP_MS, v)
      return
    }
    if (g.axis === 'y') {
      if (!g.touch) return
      const dy = e.clientY - g.startY
      releasePull(dy > stage.h * DISMISS_FRACTION || (velocity(g, 'y') > DISMISS_VELOCITY && dy > 24))
      return
    }
    if (g.moved) return
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return
    // A tap. A double tap zooms (or resets the zoom); a single tap at an
    // edge turns the page at once; a single tap in the centre acts after
    // the double-tap window, so the chrome toggle and the zoom never fight.
    const now = Date.now()
    const last = lastTapRef.current
    const c = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    if (last && now - last.t < DOUBLE_TAP_MS && Math.hypot(last.x - e.clientX, last.y - e.clientY) < 30) {
      clearTimeout(tapTimerRef.current)
      lastTapRef.current = null
      animateZoomNext()
      if (spread) {
        // Leave the spread for the tapped page, then zoom it.
        setSpreadPref('single')
        setPage(e.clientX < c.x ? left : (right ?? left))
      }
      if (zoomRef.current > 1) resetZoom()
      else zoomAbout(DOUBLE_TAP_ZOOM, { x: e.clientX - c.x, y: e.clientY - c.y })
      return
    }
    const frac = (e.clientX - rect.left) / rect.width
    clearTimeout(tapTimerRef.current)
    // Turning is the reader's most frequent act, and waiting out the
    // double-tap window first read as lag (300 ms on every turn, measured
    // in the showcase). Double-tap zoom lives in the centre third and in
    // the pinch; a second edge tap inside the window is simply the next turn.
    if (zoomRef.current === 1 && (frac < 1 / 3 || frac > 2 / 3)) {
      lastTapRef.current = null
      step(frac < 1 / 3 ? -1 : 1)
      hideChrome()
      return
    }
    lastTapRef.current = { t: now, x: e.clientX, y: e.clientY }
    tapTimerRef.current = setTimeout(() => {
      lastTapRef.current = null
      if (zoomRef.current > 1) { pokeChrome(); return }
      setChrome((v) => { if (!v) pokeChrome(); return !v })
    }, DOUBLE_TAP_MS)
  }

  const onHover = (e: React.PointerEvent) => {
    // Touch never reveals the chrome by moving; nor does a mouse dragging a
    // page — while a button is down, the pages have the stage.
    if (e.pointerType === 'touch' || e.buttons) return
    pokeChrome()
    if (!finePointer) return
    const r = stageRef.current?.getBoundingClientRect()
    if (!r) return
    const f = (e.clientX - r.left) / r.width
    const p = pageRef.current
    const zone: -1 | 0 | 1 =
      zoomRef.current > 1 ? 0 : f < 1 / 3 && prevAnchor(p) !== null ? -1 : f > 2 / 3 && nextAnchor(p) !== null ? 1 : 0
    setHoverEdge((z) => (z === zone ? z : zone))
  }

  // Every page's shape, learned once in the background (page dictionaries
  // only — nothing is rendered), so spreads pair right from the start: a
  // page exported as a spread stands alone wherever it falls in the zine.
  // Only spreads need the whole sequence; a phone never pairs. It waits for
  // the first view to paint: the worker's first job is the reader's first
  // page, never this.
  useEffect(() => {
    if (!spread || !painted) return
    let cancelled = false
    const t = setTimeout(async () => {
      let learned = false
      for (let n = 1; n <= pages && !cancelled && liveRef.current; n++) {
        if (aspectsRef.current.has(n)) continue
        try {
          const pg = await doc.getPage(n)
          if (cancelled || !liveRef.current) return
          aspectsRef.current.set(n, pageAspect(pg, 0))
          learned = true
        } catch {
          /* a page that will not open keeps the upright default */
        }
      }
      if (learned && !cancelled && liveRef.current) rerender()
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [spread, painted, pages, doc, rerender])

  // A front page that could not be rendered is still the first view painted.
  useEffect(() => {
    if (!firstPaintedRef.current && visible.some((n) => rendersRef.current.get(n)?.ok === false)) firePainted()
  }, [tick, visible, firePainted])

  // Wheel: ctrl/⌘ zooms about the cursor; otherwise a horizontal or vertical
  // flick turns the page (rate-limited so a trackpad does not skip ahead).
  // Attached natively with passive: false — React registers wheel as
  // passive, where preventDefault is a no-op and a trackpad pinch would
  // zoom the reader AND the page behind it.
  const wheelCooldownRef = useRef(0)
  const onWheelRef = useRef<(e: WheelEvent) => void>(() => {})
  onWheelRef.current = (e: WheelEvent) => {
    const z = zoomRef.current
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      if (spread) return
      const c = stageCentre()
      zoomAbout(z * (e.deltaY < 0 ? 1.15 : 1 / 1.15), { x: e.clientX - c.x, y: e.clientY - c.y })
      return
    }
    if (z > 1) {
      setPan((p) => clampPan({ x: p.x - e.deltaX, y: p.y - e.deltaY }, z))
      return
    }
    const now = Date.now()
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    if (Math.abs(d) < 20 || now - wheelCooldownRef.current < 400) return
    wheelCooldownRef.current = now
    step(d > 0 ? 1 : -1)
    hideChrome()
  }
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const h = (e: WheelEvent) => onWheelRef.current(e)
    el.addEventListener('wheel', h, { passive: false })
    return () => el.removeEventListener('wheel', h)
  }, [])

  // ── fullscreen ────────────────────────────────────────────────────────
  const fullscreenSupported = typeof document !== 'undefined' && !!document.fullscreenEnabled
  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void rootRef.current?.requestFullscreen?.().catch(() => {})
  }

  // ── render ────────────────────────────────────────────────────────────
  const counter = spread && right ? `${left}–${right} / ${pages}` : `${page} / ${pages}`
  const announce = spread && right ? `Pages ${left} and ${right} of ${pages}` : `Page ${page} of ${pages}`

  // The track's pages: the view in front and its neighbours as ONE flat
  // list keyed by page number, each placed absolutely in its slot — a page
  // that turns from neighbour to front stays the same element (no remount,
  // no second decode, no second fade-in).
  type Placed = { n: number; view: 'prev' | 'current' | 'next'; x: number; y: number; w: number; h: number; paired: boolean }
  // An opened spread casts ONE shadow, as a booklet does — two page shadows
  // would each fall across the other page at the fold.
  type Sheet = { key: string; x: number; y: number; w: number; h: number }
  const sheets: Sheet[] = []
  const span = stage.w + SLOT_GAP
  const place = (anchor: number, slot: -1 | 0 | 1, view: Placed['view']): Placed[] => {
    const [l, r] = viewOf(anchor)
    const ns = r ? [l, r] : [l]
    const boxes = ns.map((n) => fitBox(n))
    // Whole pixels: a page at a fractional edge is resampled (softer), and
    // two pages meeting at one would let the room show through the fold as
    // a hairline.
    let x = Math.round(slot * span + (stage.w - boxes.reduce((t, b) => t + b.w, 0)) / 2)
    const placedView = ns.map((n, i) => {
      const b = boxes[i]
      const w = Math.round(b.w)
      const h = Math.round(b.h)
      const at: Placed = { n, view, x, y: Math.round((stage.h - h) / 2), w, h, paired: ns.length === 2 }
      x += w
      return at
    })
    if (placedView.length === 2) {
      const [a, b] = placedView
      const top = Math.min(a.y, b.y)
      sheets.push({ key: `sheet-${a.n}`, x: a.x, y: top, w: a.w + b.w, h: Math.max(a.y + a.h, b.y + b.h) - top })
    }
    return placedView
  }
  const prevP = stage.w ? prevAnchor(page) : null
  const nextP = stage.w ? nextAnchor(page) : null
  const placed: Placed[] = stage.w
    ? [
        ...(prevP !== null ? place(prevP, -1, 'prev') : []),
        ...place(page, 0, 'current'),
        ...(nextP !== null ? place(nextP, 1, 'next') : []),
      ]
    : []

  const renderPlaced = (at: Placed) => {
    const front = at.view === 'current'
    const zoomed = front && !spread
    const z = zoomed ? zoom : 1
    const r = rendersRef.current.get(at.n)
    const hi = zoomed && zoomRenderRef.current && zoomRenderRef.current.page === at.n ? zoomRenderRef.current.url : null
    const w = at.w * z
    const h = at.h * z
    const ease = zoomAnimRef.current ? ZOOM_EASE : null
    const style: React.CSSProperties = {
      left: at.x - (w - at.w) / 2,
      top: at.y - (h - at.h) / 2,
      width: w,
      height: h,
      transform: zoomed && (pan.x || pan.y) ? `translate(${pan.x}px, ${pan.y}px)` : undefined,
      transition: zoomed && ease ? ['left', 'top', 'width', 'height', 'transform'].map((p) => `${p} ${ZOOM_MS}ms ${ease}`).join(', ') : undefined,
      boxShadow: at.paired ? undefined : PAGE_SHADOW,
      // iOS: a long press on an image otherwise opens the share/save sheet
      // mid-read (and fights the pan gesture).
      WebkitTouchCallout: 'none',
      WebkitUserSelect: 'none',
    }
    // While the opening frame is still up, the first page paints at full
    // opacity: the frame's own fade is the crossfade, and two fades at once
    // would dip to dark halfway through.
    const instant = front && !firstPaintedRef.current && !!onFirstPageRef.current
    return (
      <div
        key={at.n}
        data-view={at.view}
        aria-hidden={front ? undefined : true}
        className={`absolute bg-white/[0.06] ${r ? '' : 'animate-pulse'}`}
        style={style}
      >
        {r?.ok ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={hi ?? r.url}
            alt={`Page ${at.n} of ${title}`}
            draggable={false}
            decoding="async"
            className={`absolute inset-0 w-full h-full select-none bg-white ${instant ? '' : 'opacity-0 transition-opacity duration-200 data-[loaded]:opacity-100'}`}
            onLoad={(e) => {
              const el = e.currentTarget
              el.dataset.loaded = ''
              // Neighbours decode now, so the first frame of a drag that
              // reveals them is never blank.
              if (!front) void el.decode?.().catch(() => {})
              else firePainted()
            }}
          />
        ) : r ? (
          <div role="img" aria-label={`Page ${at.n} could not be rendered`} className="absolute inset-0 flex items-center justify-center">
            <span className="text-[11px] font-mono text-muted text-center px-4">page {at.n} could not be rendered</span>
          </div>
        ) : null}
      </div>
    )
  }

  // Announce the page a reader settles on, not every page a scrubber drag
  // passes over.
  const [announced, setAnnounced] = useState(announce)
  useEffect(() => {
    const t = setTimeout(() => setAnnounced(announce), 300)
    return () => clearTimeout(t)
  }, [announce])

  const chromeClass = `absolute left-0 right-0 z-10 flex items-center gap-2 px-3 bg-gradient-to-b transition-opacity duration-200 ${chrome ? 'opacity-100' : 'opacity-0 pointer-events-none'}`
  const lastShown = right ?? left

  const reader = (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Reading ${title}`}
      tabIndex={-1}
      className="fixed inset-0 z-[200] text-ink select-none outline-none"
      // iOS: no rubber-banding of the page behind a full-screen reader.
      style={{ overscrollBehavior: 'none' }}
      // A moving mouse (or pen) reveals the chrome and, on a desktop, the
      // edge it is near. Pointer events, filtered, rather than onMouseMove:
      // a touch tap is followed by compatibility mouse events, and a
      // mousemove arriving right after the tap would reveal the chrome a
      // beat before the tap's own toggle hid it again.
      onPointerMove={onHover}
      onPointerLeave={() => setHoverEdge(0)}
    >
      {/* The room. Its own layer so pulling the page down to close can fade
          it and let the artwork page show through. */}
      <div ref={backdropRef} className="absolute inset-0" style={{ background: backdrop ?? '#0a0a0a' }} />

      {/* The stage. All gestures land here; touch-action: none because we
          own swipe, pinch and pan ourselves (body scroll is locked anyway). */}
      <div
        ref={stageRef}
        className="absolute inset-0 overflow-hidden"
        // `clip`, not just `hidden`: the neighbouring pages wait off-stage on
        // the track, and a hidden-overflow box is still a scroll container —
        // anything that scrolls an element into view (find-in-page, a test
        // driver, assistive tech) would shift the whole track. `clip` clips
        // without scrolling; where it is unsupported the class's `hidden`
        // applies and the guard below puts any stray scroll back.
        style={{ touchAction: 'none', overflow: 'clip', cursor: hoverEdge ? 'pointer' : undefined }}
        onScroll={(e) => {
          const el = e.currentTarget
          if (el.scrollLeft || el.scrollTop) el.scrollTo(0, 0)
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={cancelPointer}
      >
        <div ref={trackRef} className="absolute inset-0" style={{ transformOrigin: '50% 50%' }}>
          {sheets.map((sh) => (
            <div key={sh.key} aria-hidden data-sheet="" className="absolute pointer-events-none bg-white" style={{ left: sh.x, top: sh.y, width: sh.w, height: sh.h, boxShadow: PAGE_SHADOW }} />
          ))}
          {placed.map(renderPlaced)}
        </div>
      </div>

      {/* Edge hints (mouse and trackpad): the side the cursor is on shows it
          turns the page, the way a hand hovers over a corner. */}
      {finePointer && (
        <>
          <div aria-hidden data-edge-hint="prev" className={`absolute left-0 inset-y-0 w-24 flex items-center pl-4 pointer-events-none transition-opacity duration-200 ${hoverEdge === -1 && chrome ? 'opacity-100' : 'opacity-0'}`}>
            <span className="w-10 h-10 rounded-full bg-black/50 flex items-center justify-center text-ink"><ChevronLeft size={20} /></span>
          </div>
          <div aria-hidden data-edge-hint="next" className={`absolute right-0 inset-y-0 w-24 flex items-center justify-end pr-4 pointer-events-none transition-opacity duration-200 ${hoverEdge === 1 && chrome ? 'opacity-100' : 'opacity-0'}`}>
            <span className="w-10 h-10 rounded-full bg-black/50 flex items-center justify-center text-ink"><ChevronRight size={20} /></span>
          </div>
        </>
      )}

      {/* Where you are, without the chrome: one mark per page (a long zine
          gets a single line), lit up to the page in view. */}
      <div
        aria-hidden
        data-position-marks=""
        className={`absolute inset-x-3 bottom-2 h-[2px] flex gap-[3px] pointer-events-none transition-opacity duration-300 ${chrome ? 'opacity-0' : 'opacity-100'}`}
      >
        {pages <= SEGMENT_MAX ? (
          Array.from({ length: pages }, (_, i) => (
            <span key={i} data-read={i < lastShown ? '' : undefined} className={`flex-1 rounded-full transition-colors duration-300 ${i < lastShown ? 'bg-white/55' : 'bg-white/15'}`} />
          ))
        ) : (
          <span className="flex-1 rounded-full bg-white/15 overflow-hidden">
            <span className={`block h-full bg-white/55 origin-left ${reduceMotion ? '' : 'transition-transform duration-300'}`} style={{ transform: `scaleX(${lastShown / pages})` }} />
          </span>
        )}
      </div>

      <p className="sr-only" aria-live="polite">{announced}</p>

      {/* Top chrome: title, counter, close. Keyboard focus landing on a
          hidden bar reveals it, so Tab never rests on an invisible control. */}
      <div data-chrome="" className={`${chromeClass} top-0 h-12 from-black/80 to-transparent`} onFocus={pokeChrome}>
        <p className="min-w-0 flex-1 truncate text-[11px] font-mono text-dim">{title}</p>
        <span className="text-[11px] font-mono text-muted tabular-nums">{counter}</span>
        <button
          type="button"
          onClick={closeGently}
          aria-label="Close reader"
          className="w-8 h-8 flex items-center justify-center text-dim hover:text-ink transition-colors"
        >
          <X size={16} />
        </button>
      </div>

      {/* Bottom chrome: prev, scrubber, next, and the small controls. */}
      <div data-chrome="" className={`${chromeClass} bottom-0 h-14 from-transparent to-black/85`} onFocus={pokeChrome}>
        <button
          type="button"
          onClick={() => step(-1)}
          disabled={left <= 1}
          aria-label="Previous page"
          className="w-8 h-8 flex items-center justify-center text-dim hover:text-ink disabled:opacity-30 transition-colors"
        >
          <ChevronLeft size={16} />
        </button>
        <input
          type="range"
          min={1}
          max={pages}
          value={page}
          aria-label="Page"
          aria-valuetext={announce}
          onChange={(e) => setPage(Number(e.target.value))}
          className="flex-1 min-w-0 accent-[#e8e8e8] h-1 cursor-pointer"
        />
        <button
          type="button"
          onClick={() => step(1)}
          disabled={(right ?? left) >= pages}
          aria-label="Next page"
          className="w-8 h-8 flex items-center justify-center text-dim hover:text-ink disabled:opacity-30 transition-colors"
        >
          <ChevronRight size={16} />
        </button>
        <button
          type="button"
          onClick={rotate}
          aria-label="Rotate pages"
          title="Rotate pages (r · shift+r turns the other way)"
          className="w-8 h-8 flex items-center justify-center text-dim hover:text-ink transition-colors"
        >
          <RotateCw size={14} />
        </button>
        {pages > 1 && stage.w >= SPREAD_MIN_WIDTH && stage.w > stage.h && (
          <button
            type="button"
            onClick={() => { setSpreadPref((v) => (v === 'auto' ? 'single' : 'auto')); resetZoom() }}
            aria-label={spread ? 'Show single pages' : 'Show spreads'}
            aria-pressed={spread}
            title={spread ? 'single pages' : 'spreads'}
            className="w-8 h-8 flex items-center justify-center text-dim hover:text-ink transition-colors"
          >
            {spread ? <Square size={14} /> : <Columns2 size={14} />}
          </button>
        )}
        {onDownload ? (
          <button
            type="button"
            onClick={onDownload}
            aria-label="Download PDF"
            title="Download PDF"
            className="w-8 h-8 flex items-center justify-center text-dim hover:text-ink transition-colors"
          >
            <Download size={14} />
          </button>
        ) : downloadUrl ? (
          <a
            href={downloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Download PDF"
            title="Download PDF"
            className="w-8 h-8 flex items-center justify-center text-dim hover:text-ink transition-colors"
          >
            <Download size={14} />
          </a>
        ) : null}
        {fullscreenSupported && (
          <button
            type="button"
            onClick={toggleFullscreen}
            aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            className="w-8 h-8 flex items-center justify-center text-dim hover:text-ink transition-colors"
          >
            {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        )}
      </div>
    </div>
  )

  return createPortal(reader, document.body)
}
