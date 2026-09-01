'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Mint-form preview for a 3D moment: renders the picked GLB, lets the artist
 * pose it, and captures the framing they land on as the moment's poster.
 *
 * WHY CAPTURE HERE. A 3D moment ships the same metadata shape as a video one
 * (`image` still + `animation_url` + `content.mime`), so the still is what
 * every feed card, OG card, Farcaster embed, collection cover and thumbhash
 * actually renders — a posterless 3D mint would be invisible on every surface
 * but one. `<model-viewer>` exposes `toBlob()` over its own canvas, so the
 * element the artist is already looking at IS the poster source: no second
 * parse of the model (which would double peak memory, the feature's #1 risk)
 * and no server-side renderer.
 *
 * WHY CONTINUOUSLY, NOT AT SUBMIT. Capture reads the live drawing buffer, and
 * `modelIsVisible` gates rendering — an element scrolled out of view when the
 * artist hits mint may hold no current frame. So we capture on `load` and
 * again whenever the artist stops moving the camera, and hand the newest
 * result up. Submit then just uses what is already banked, and "the framing
 * you posed" is literally what ships.
 *
 * Capture is sound rather than lucky: model-viewer's renderer sets
 * `preserveDrawingBuffer: true`, and it dispatches `load` only AFTER awaiting
 * two rAFs specifically to "wait for shaders to compile and pixels to be
 * drawn" — so the first frame exists by the time we are called.
 *
 * Resolution tracks the element's rendered size (CSS px x devicePixelRatio x
 * model-viewer's dynamic render scale, which degrades to 0.5x under sustained
 * load). At the mint form's column width that lands roughly 500-1900px —
 * comfortably above every consumer, since the OG hero draws at 800x800 and
 * /api/img downscales to 2048. Same convention as extractVideoPoster, which
 * captures at the video's native size rather than a fixed one.
 */

/** Matches extractVideoPoster: JPEG, same quality. JPEG has no alpha, so the
 *  element paints an explicit opaque background (below) and a model with a
 *  transparent backdrop composites onto the site's surface color rather than
 *  onto accidental black. */
const POSTER_MIME = 'image/jpeg'
const POSTER_QUALITY = 0.85

/** Quiet period after the artist stops dragging before we re-capture. Long
 *  enough that an orbit costs one capture, not one per frame. */
const RECAPTURE_IDLE_MS = 400

interface ModelViewerElement extends HTMLElement {
  toBlob(options?: {
    mimeType?: string
    qualityArgument?: number
    idealAspect?: boolean
  }): Promise<Blob>
}

interface Props {
  /** Blob URL for the picked GLB. */
  src: string
  /** Source file name — the poster is named after it, like the video path. */
  fileName: string
  /** Fires with the newest captured poster, or null if capture failed. */
  onPoster: (poster: File | null) => void
  /** Fires when the model itself can't be displayed. */
  onError: (message: string) => void
}

export function ModelPreview({ src, fileName, onPoster, onError }: Props) {
  const [ready, setReady] = useState(false)
  const elRef = useRef<ModelViewerElement | null>(null)
  // Callbacks live in refs so the effect that wires DOM listeners doesn't
  // re-run (and re-capture) every time the parent re-renders.
  const onPosterRef = useRef(onPoster)
  onPosterRef.current = onPoster
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  // A capture is an async round-trip through toBlob. If the artist swaps
  // models mid-flight this instance is already unmounted by the time it
  // resolves, and reporting then would re-attach the OLD model's still to the
  // NEW pick — the parent has just cleared it precisely to avoid that.
  const liveRef = useRef(true)
  useEffect(() => {
    liveRef.current = true
    return () => { liveRef.current = false }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // The custom element must be defined before <model-viewer> renders.
        // Dynamically imported for two reasons: it touches `window` at module
        // scope (so it cannot be part of an SSR'd bundle), and it is ~475 KB
        // minified — a static import would blow the /mint route's entry in
        // bundle-baseline.json well past the 10% guard. Same pattern as
        // components/CollectorFileViewer.
        const mod = await import('@google/model-viewer')
        // Point Draco/KTX2 at OUR copies. model-viewer otherwise fetches these
        // from www.gstatic.com at render time — an undeclared third-party
        // origin that would also break under an enforcing CSP. See
        // public/model-decoders/README.md.
        mod.ModelViewerElement.dracoDecoderLocation = '/model-decoders/draco/'
        mod.ModelViewerElement.ktx2TranscoderLocation = '/model-decoders/basis/'
        if (!cancelled) setReady(true)
      } catch {
        if (!cancelled) onErrorRef.current('Could not load the 3D viewer — check your connection and retry.')
      }
    })()
    return () => { cancelled = true }
  }, [])

  const capture = useCallback(async () => {
    const el = elRef.current
    if (!el) return
    try {
      const blob = await el.toBlob({ mimeType: POSTER_MIME, qualityArgument: POSTER_QUALITY })
      if (!liveRef.current) return
      const base = fileName.replace(/\.[^.]+$/, '') || 'poster'
      onPosterRef.current(new File([blob], `${base}.jpg`, { type: POSTER_MIME }))
    } catch {
      if (!liveRef.current) return
      // Report the miss so the parent never holds a poster this element did
      // not produce; the mint gate turns a persistent failure into a refusal.
      onPosterRef.current(null)
    }
  }, [fileName])

  // Event wiring via a callback ref + addEventListener, NOT on*-props:
  // React's synthetic event system maps on*-props for known DOM elements
  // only, never for custom elements, so the prop form silently never fires.
  const attach = useCallback((node: HTMLElement | null) => {
    elRef.current = node as ModelViewerElement | null
    if (!node) return
    let idle: ReturnType<typeof setTimeout> | undefined
    const onLoad = () => { void capture() }
    const onCameraChange = (e: Event) => {
      // Only the artist's own orbiting should re-frame the poster; the
      // implicit camera settle after load already rides the `load` capture.
      const source = (e as CustomEvent<{ source?: string }>).detail?.source
      if (source !== 'user-interaction') return
      clearTimeout(idle)
      idle = setTimeout(() => { void capture() }, RECAPTURE_IDLE_MS)
    }
    const onModelError = () =>
      onErrorRef.current('This 3D model could not be displayed — try exporting it again as .glb')
    node.addEventListener('load', onLoad)
    node.addEventListener('camera-change', onCameraChange)
    node.addEventListener('error', onModelError)
    return () => {
      clearTimeout(idle)
      node.removeEventListener('load', onLoad)
      node.removeEventListener('camera-change', onCameraChange)
      node.removeEventListener('error', onModelError)
    }
  }, [capture])

  if (!ready) {
    return (
      <div className="aspect-square bg-surface flex items-center justify-center">
        <p className="text-[11px] font-mono text-muted">loading 3D viewer…</p>
      </div>
    )
  }

  return (
    // @ts-expect-error — custom element registered by the lazy import above.
    <model-viewer
      ref={attach}
      src={src}
      alt="3D model preview"
      camera-controls
      touch-action="pan-y"
      // Opaque, and the same token the surrounding form surfaces use, so the
      // JPEG capture (no alpha) composites predictably instead of onto black.
      style={{ width: '100%', aspectRatio: '1', display: 'block', backgroundColor: '#111' }}
    />
  )
}
