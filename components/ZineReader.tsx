'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Columns2, Download, Maximize2, Minimize2, Square, X } from 'lucide-react'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { renderPageToBlob, type PdfDocument } from '@/lib/pdfjs'

/**
 * The zine reader — a paged, full-screen reader over an open pdf.js document
 * (ZINE_READER_DESIGN.md §5). Serves public zines (bytes from Arweave via
 * the owned download in MomentZine) and, later, collectors-only ones (bytes
 * from the collector-file view route); it never fetches anything itself.
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
}

type PageRender =
  | { ok: true; url: string; aspect: number; cssWidth: number }
  | { ok: false; aspect: number }

const MIN_ZOOM = 1
const MAX_ZOOM = 4
const DOUBLE_TAP_ZOOM = 2.5
const SWIPE_PX = 40
const DOUBLE_TAP_MS = 300
const CHROME_HIDE_MS = 2500
/** Keep renders for pages within this distance of the one in view. */
const WINDOW = 2
/** Spreads need a landscape viewport at least this wide. */
const SPREAD_MIN_WIDTH = 900
const STAGE_PAD = 12
const SPREAD_GAP = 8
/** Fallback aspect (width / height) before a page's own size is known —
 *  A-series portrait, the common zine. */
const DEFAULT_ASPECT = 0.7071

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** The pages of the spread that contains `page`: the cover alone, then
 *  2–3, 4–5, …, the back cover alone — a stapled booklet opened flat. */
function spreadFor(page: number, pages: number): [number, number | null] {
  if (page <= 1) return [1, null]
  const left = page % 2 === 0 ? page : page - 1
  const right = left + 1 <= pages ? left + 1 : null
  return [left, right]
}

function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const compute = () => setReduce(mq.matches)
    compute()
    mq.addEventListener('change', compute)
    return () => mq.removeEventListener('change', compute)
  }, [])
  return reduce
}

export function ZineReader({ doc, title, startPage, onClose, onPageChange, downloadUrl }: Props) {
  const pages = doc.numPages
  const [page, setPageState] = useState(() => clamp(Math.floor(startPage ?? 1) || 1, 1, pages))
  const [stage, setStage] = useState({ w: 0, h: 0 })
  const [spreadPref, setSpreadPref] = useState<'auto' | 'single'>('auto')
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [chrome, setChrome] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)
  const [, bump] = useState(0)
  const rerender = useCallback(() => bump((n) => n + 1), [])
  const reduceMotion = usePrefersReducedMotion()

  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const dprRef = useRef(1)
  // Rendered pages (fit-size) and the single zoomed render of the page in view.
  const rendersRef = useRef(new Map<number, PageRender>())
  const aspectsRef = useRef(new Map<number, number>())
  const pendingRef = useRef(new Set<number>())
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

  useFocusTrap(rootRef, true)

  // Body scroll lock that RESTORES what it found rather than clearing it: the
  // reader can open inside the in-app overlay route, which holds its own lock
  // for as long as the overlay is up, and a plain reset on close would hand
  // the page its scroll back under a still-open overlay.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  // Escape closes the reader and ONLY the reader. Captured on window so the
  // overlay route's own Escape listener (which navigates back) never sees
  // the key while a zine is open; the lightbox has the same stacking today.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      e.preventDefault()
      onCloseRef.current()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [])

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
  const [left, right] = spread ? spreadFor(page, pages) : [page, null]
  const visible = useMemo(() => (right ? [left, right] : [left]), [left, right])

  const aspectOf = useCallback((n: number) => aspectsRef.current.get(n) ?? aspectsRef.current.get(1) ?? DEFAULT_ASPECT, [])

  /** CSS size of a page's slot at zoom 1. */
  const fitBox = useCallback((n: number): { w: number; h: number } => {
    const availW = Math.max(1, (spread ? (stage.w - SPREAD_GAP) / 2 : stage.w) - STAGE_PAD * 2)
    const availH = Math.max(1, stage.h - STAGE_PAD * 2)
    const aspect = aspectOf(n)
    const w = Math.min(availW, availH * aspect)
    return { w, h: w / aspect }
  }, [spread, stage.w, stage.h, aspectOf])

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

  const ensureRendered = useCallback((n: number, cssWidth: number) => {
    const existing = rendersRef.current.get(n)
    // A render at (or close to) the needed width is reused; a much wider
    // viewport (a rotation, a window resize) gets a fresh one.
    if (existing && (!existing.ok || existing.cssWidth >= cssWidth * 0.8)) return
    if (pendingRef.current.has(n)) return
    pendingRef.current.add(n)
    enqueue(async (signal) => {
      try {
        const pdfPage = await doc.getPage(n)
        if (!aspectsRef.current.has(n)) {
          const vp = pdfPage.getViewport({ scale: 1 })
          aspectsRef.current.set(n, vp.width / vp.height)
        }
        const rendered = await renderPageToBlob(pdfPage, { cssWidth, dpr: dprRef.current, signal })
        if (!liveRef.current) {
          return
        }
        revokeRender(rendersRef.current.get(n))
        rendersRef.current.set(n, { ok: true, url: URL.createObjectURL(rendered.blob), aspect: rendered.aspect, cssWidth })
      } catch (err) {
        if (signal.aborted || !liveRef.current) return
        if (err && typeof err === 'object' && (err as { name?: string }).name === 'RenderingCancelledException') return
        rendersRef.current.set(n, { ok: false, aspect: aspectsRef.current.get(n) ?? DEFAULT_ASPECT })
      } finally {
        pendingRef.current.delete(n)
        if (liveRef.current) rerender()
      }
    })
  }, [doc, enqueue, rerender])

  // Render the pages in view first, then their neighbours; evict the rest.
  useEffect(() => {
    if (!stage.w || !stage.h) return
    const order: number[] = [...visible]
    for (let d = 1; d <= WINDOW; d++) {
      if (left - d >= 1) order.push(left - d)
      const after = (right ?? left) + d
      if (after <= pages) order.push(after)
    }
    for (const n of order) ensureRendered(n, fitBox(n).w)
    const keep = new Set(order)
    for (const [n, r] of rendersRef.current) {
      if (!keep.has(n)) {
        revokeRender(r)
        rendersRef.current.delete(n)
      }
    }
    // Pages queued but no longer wanted: abort by letting the job see a
    // stale window — cheap, and the queue is short by construction.
  }, [visible, left, right, pages, stage.w, stage.h, ensureRendered, fitBox])

  // Page sizes for the skeletons: learn the aspects of the pages in view
  // before their render lands, so the slot has the right shape from the
  // first frame.
  useEffect(() => {
    let cancelled = false
    for (const n of visible) {
      if (aspectsRef.current.has(n)) continue
      void doc.getPage(n).then((p) => {
        if (cancelled || !liveRef.current) return
        const vp = p.getViewport({ scale: 1 })
        aspectsRef.current.set(n, vp.width / vp.height)
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
        try {
          const pdfPage = await doc.getPage(page)
          const rendered = await renderPageToBlob(pdfPage, { cssWidth: want, dpr: dprRef.current, signal })
          if (!liveRef.current) return
          dropZoomRender()
          zoomRenderRef.current = { page, zoom, url: URL.createObjectURL(rendered.blob) }
          rerender()
        } catch {
          /* the fit-size render stays on screen */
        }
      })
    }, 220)
    return () => clearTimeout(zoomRenderTimerRef.current)
  }, [zoom, page, spread, doc, enqueue, fitBox, dropZoomRender, rerender])

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
    }
  }, [dropZoomRender])

  // ── navigation ────────────────────────────────────────────────────────
  const resetZoom = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  const setPage = useCallback((n: number) => {
    const next = clamp(Math.round(n), 1, pages)
    setPageState((cur) => {
      if (next === cur) return cur
      onPageChangeRef.current?.(next)
      return next
    })
    resetZoom()
  }, [pages, resetZoom])

  const step = useCallback((dir: 1 | -1) => {
    if (spread) {
      const [l, r] = spreadFor(page, pages)
      setPage(dir > 0 ? (r ?? l) + 1 : l - 1)
    } else {
      setPage(page + dir)
    }
  }, [spread, page, pages, setPage])

  const pokeChrome = useCallback(() => {
    setChrome(true)
    clearTimeout(chromeTimerRef.current)
    chromeTimerRef.current = setTimeout(() => setChrome(false), CHROME_HIDE_MS)
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
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
          e.preventDefault(); step(1); break
        case ' ':
          e.preventDefault(); step(e.shiftKey ? -1 : 1); break
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
        case 'Backspace':
          e.preventDefault(); step(-1); break
        case 'Home':
          e.preventDefault(); setPage(1); break
        case 'End':
          e.preventDefault(); setPage(pages); break
        case '+':
        case '=':
          e.preventDefault(); if (!spread) zoomAbout(zoom * 1.5, { x: 0, y: 0 }); break
        case '-':
          e.preventDefault(); if (!spread) zoomAbout(zoom / 1.5, { x: 0, y: 0 }); break
        case '0':
          e.preventDefault(); resetZoom(); break
        default:
          return
      }
      pokeChrome()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, setPage, pages, spread, zoom, zoomAbout, resetZoom, pokeChrome])

  // ── pointer gestures: tap zones, swipe, double-tap, pinch, drag-pan ────
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const gestureRef = useRef<{
    startX: number
    startY: number
    startPan: { x: number; y: number }
    moved: boolean
    pinch: { startDist: number; startZoom: number } | null
  } | null>(null)
  const lastTapRef = useRef<{ t: number; x: number; y: number } | null>(null)
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      gestureRef.current = { startX: e.clientX, startY: e.clientY, startPan: pan, moved: true, pinch: { startDist: dist, startZoom: zoom } }
      clearTimeout(tapTimerRef.current)
      return
    }
    gestureRef.current = { startX: e.clientX, startY: e.clientY, startPan: pan, moved: false, pinch: null }
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
    if (zoom > 1 && g.moved) {
      setPan(clampPan({ x: g.startPan.x + dx, y: g.startPan.y + dy }, zoom))
    }
  }

  const endPointer = (e: React.PointerEvent) => {
    const g = gestureRef.current
    pointersRef.current.delete(e.pointerId)
    if (!g) return
    if (g.pinch) {
      if (pointersRef.current.size === 0) gestureRef.current = null
      return
    }
    gestureRef.current = null
    const dx = e.clientX - g.startX
    const dy = e.clientY - g.startY
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return
    // A swipe turns the page only when the page is not zoomed (zoomed, the
    // same drag pans it).
    if (zoom === 1 && Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.2) {
      step(dx < 0 ? 1 : -1)
      pokeChrome()
      return
    }
    if (g.moved) return
    // A tap. Double-tap zooms; a single tap acts after the double-tap window
    // so the two never fight.
    const now = Date.now()
    const last = lastTapRef.current
    const c = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    if (last && now - last.t < DOUBLE_TAP_MS && Math.hypot(last.x - e.clientX, last.y - e.clientY) < 30) {
      clearTimeout(tapTimerRef.current)
      lastTapRef.current = null
      if (spread) {
        // Leave the spread for the tapped page, then zoom it.
        setSpreadPref('single')
        setPage(e.clientX < c.x ? left : (right ?? left))
      }
      if (zoom > 1) resetZoom()
      else zoomAbout(DOUBLE_TAP_ZOOM, { x: e.clientX - c.x, y: e.clientY - c.y })
      return
    }
    lastTapRef.current = { t: now, x: e.clientX, y: e.clientY }
    const frac = (e.clientX - rect.left) / rect.width
    clearTimeout(tapTimerRef.current)
    tapTimerRef.current = setTimeout(() => {
      lastTapRef.current = null
      if (zoom > 1) { pokeChrome(); return }
      if (frac < 1 / 3) step(-1)
      else if (frac > 2 / 3) step(1)
      else setChrome((v) => { if (!v) pokeChrome(); return !v })
    }, DOUBLE_TAP_MS)
  }

  // Wheel: ctrl/⌘ zooms about the cursor; otherwise a horizontal or vertical
  // flick turns the page (rate-limited so a trackpad does not skip ahead).
  const wheelCooldownRef = useRef(0)
  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      if (spread) return
      const c = stageCentre()
      zoomAbout(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), { x: e.clientX - c.x, y: e.clientY - c.y })
      return
    }
    if (zoom > 1) {
      setPan((p) => clampPan({ x: p.x - e.deltaX, y: p.y - e.deltaY }, zoom))
      return
    }
    const now = Date.now()
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    if (Math.abs(d) < 20 || now - wheelCooldownRef.current < 400) return
    wheelCooldownRef.current = now
    step(d > 0 ? 1 : -1)
  }

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

  // ── slide-in on page change ───────────────────────────────────────────
  const prevPageRef = useRef(page)
  const [slide, setSlide] = useState<0 | 1 | -1>(0)
  useLayoutEffect(() => {
    if (prevPageRef.current === page) return
    const dir = page > prevPageRef.current ? 1 : -1
    prevPageRef.current = page
    if (reduceMotion) return
    setSlide(dir)
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setSlide(0)))
    return () => cancelAnimationFrame(id)
  }, [page, reduceMotion])

  // ── render ────────────────────────────────────────────────────────────
  const counter = spread && right ? `${left}–${right} / ${pages}` : `${page} / ${pages}`
  const announce = spread && right ? `Pages ${left} and ${right} of ${pages}` : `Page ${page} of ${pages}`

  const renderPage = (n: number, zoomed: boolean) => {
    const box = fitBox(n)
    const r = rendersRef.current.get(n)
    const z = zoomed ? zoom : 1
    const hi = zoomed && zoomRenderRef.current && zoomRenderRef.current.page === n ? zoomRenderRef.current.url : null
    const style: React.CSSProperties = {
      width: box.w * z,
      height: box.h * z,
      transform: zoomed ? `translate(${pan.x}px, ${pan.y}px)` : undefined,
      boxShadow: '0 1px 2px rgba(0,0,0,.6), 0 8px 24px rgba(0,0,0,.5)',
    }
    if (!r) {
      return <div key={n} aria-hidden className="bg-white/[0.06] animate-pulse flex-shrink-0" style={style} />
    }
    if (!r.ok) {
      return (
        <div key={n} role="img" aria-label={`Page ${n} could not be rendered`} className="bg-white/[0.06] flex items-center justify-center flex-shrink-0" style={style}>
          <span className="text-[11px] font-mono text-muted text-center px-4">page {n} could not be rendered</span>
        </div>
      )
    }
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        key={n}
        src={hi ?? r.url}
        alt={`Page ${n} of ${title}`}
        draggable={false}
        className="flex-shrink-0 select-none bg-white"
        style={style}
      />
    )
  }

  const slideStyle: React.CSSProperties = slide
    ? { transform: `translateX(${slide * 6}%)`, opacity: 0 }
    : { transform: 'translateX(0)', opacity: 1, transition: reduceMotion ? undefined : 'transform 180ms ease-out, opacity 180ms ease-out' }

  const chromeClass = `absolute left-0 right-0 z-10 flex items-center gap-2 px-3 bg-gradient-to-b transition-opacity duration-200 ${chrome ? 'opacity-100' : 'opacity-0 pointer-events-none'}`

  const reader = (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Reading ${title}`}
      tabIndex={-1}
      className="fixed inset-0 z-[200] bg-[#0a0a0a] text-ink select-none outline-none"
      // A moving mouse (or pen) reveals the chrome. Pointer events, filtered,
      // rather than onMouseMove: a touch tap is followed by compatibility
      // mouse events, and a mousemove arriving right after the tap would
      // reveal the chrome a beat before the tap's own toggle hid it again.
      onPointerMove={(e) => { if (e.pointerType !== 'touch') pokeChrome() }}
    >
      {/* The stage. All gestures land here; touch-action: none because we
          own swipe, pinch and pan ourselves (body scroll is locked anyway). */}
      <div
        ref={stageRef}
        className="absolute inset-0 overflow-hidden"
        style={{ touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onWheel={onWheel}
      >
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{ padding: STAGE_PAD, gap: SPREAD_GAP, ...slideStyle }}
        >
          {spread ? visible.map((n) => renderPage(n, false)) : renderPage(page, true)}
        </div>
      </div>

      <p className="sr-only" aria-live="polite">{announce}</p>

      {/* Top chrome: title, counter, close. */}
      <div className={`${chromeClass} top-0 h-12 from-black/80 to-transparent`}>
        <p className="min-w-0 flex-1 truncate text-[11px] font-mono text-dim">{title}</p>
        <span className="text-[11px] font-mono text-muted tabular-nums">{counter}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close reader"
          className="w-8 h-8 flex items-center justify-center text-dim hover:text-ink transition-colors"
        >
          <X size={16} />
        </button>
      </div>

      {/* Bottom chrome: prev, scrubber, next, and the small controls. */}
      <div className={`${chromeClass} bottom-0 h-14 from-transparent to-black/85`}>
        <button
          type="button"
          onClick={() => step(-1)}
          disabled={page <= 1}
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
          disabled={page >= pages}
          aria-label="Next page"
          className="w-8 h-8 flex items-center justify-center text-dim hover:text-ink disabled:opacity-30 transition-colors"
        >
          <ChevronRight size={16} />
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
        {downloadUrl && (
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
        )}
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
