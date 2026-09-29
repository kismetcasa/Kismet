'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, X } from 'lucide-react'
import { MomentImage } from './MomentImage'
import { modelFetchUrls } from '@/lib/media/gateway'
import { thumbhashToBlurDataURL } from '@/lib/media/thumbhash'
import { MODEL_ENVIRONMENT, MODEL_SHADOW_INTENSITY, modelViewerBg } from '@/lib/media/modelMedia'
import {
  ModelFetchError,
  fetchModelBlob,
  isAbortError,
  modelLoadReadout,
  type ModelFetchProgress,
} from '@/lib/media/modelFetch'
import { configureModelViewerDecoders } from '@/lib/media/modelViewerConfig'

/**
 * The artwork detail view's 3D viewer — the ONE surface in the app that
 * mounts a WebGL context for a moment (GLB_3D_VIEWER_DESIGN.md, "one WebGL
 * context, ever").
 *
 * TAP TO LOAD, deliberately, and it buys three things at once:
 *   1. Memory. A GLB is not streamed — it downloads whole, parses into
 *      CPU-side buffers and uploads to the GPU, so peak cost is roughly 2x
 *      the file plus textures. Only a viewer who asked pays it. This
 *      codebase has already eaten iOS OOM crashes from animated GIFs
 *      holding decoders off-screen (see MomentCard), and the Mini App
 *      webview is the same WebKit.
 *   2. Bundle. `@google/model-viewer` is ~475 KB minified — a static import
 *      would push the artwork route ~37% past its bundle-baseline.json
 *      entry against a 10% guard. Behind the click it is a separate chunk
 *      the route never lists.
 *   3. First paint. The poster is a real JPEG on the same gateway-walking
 *      path as any still, so the artwork looks right immediately instead of
 *      after a multi-megabyte download.
 *
 * THE DOWNLOAD IS OURS, NOT model-viewer's (lib/media/modelFetch — the
 * reasons are recorded there: an aggregate progress figure that read "50%"
 * before a single byte, no timeout, no abort, and a cache that turns a
 * failed load into an instant failure on every retry). The tap fetches the
 * GLB with a cancel, a stall watchdog and a gateway walk, shows real bytes,
 * and only then mounts <model-viewer> on a blob: URL — so no WebGL context
 * exists until the model is actually in hand, either.
 *
 * The still STAYS VISIBLE beneath the viewer until the model's own `load`
 * fires — the `showPosterLayer` pattern MomentVideo already uses. The
 * artist's backdrop lives on the WRAPPER, never on the element: model-viewer's
 * host is `position: relative`, so it paints over the absolutely positioned
 * still, and an opaque background on the element itself hid the still from
 * the first frame on the white and dark backdrops — the empty white box the
 * artist reported. Pixel-checked in scripts/e2e/model-media.mjs.
 *
 * Exiting aborts a download in flight, releases the blob, and unmounts the
 * element, which is what actually releases the context — worth having on a
 * sticky media column a viewer may scroll past.
 */

type Phase = 'idle' | 'loading' | 'active' | 'error'

interface Props {
  /** Raw GLB URI (ar:// / ipfs:// / https://). */
  src: string
  /** Raw still URI. Absent on a model minted without one. */
  poster?: string
  thumbhash?: string
  alt: string
  /** The artist's chosen backdrop (`metadata.kismet_bg`). It is already baked
   *  into the poster JPEG, so the live viewer must render on the SAME one —
   *  otherwise tapping "view in 3D" swaps a white still for a model on the
   *  page's near-black, which reads as a bug rather than a choice. */
  background?: string
  /** Fires when neither the model nor its poster can be shown, so the
   *  parent can fall back to its own placeholder. */
  onAllError?: () => void
}

/**
 * Whether to auto-rotate. model-viewer has NO built-in reduced-motion
 * handling (verified against the installed package), so `auto-rotate` spins
 * indefinitely regardless of the OS setting — continuous, unstoppable motion
 * is exactly what WCAG 2.2 SC 2.2.2 addresses. Gated on `no-preference`
 * rather than `!reduce`, matching ProfileThemeBackdrop and globals.css so
 * every motion path in the app agrees on UAs that report neither value.
 */
function useAllowsMotion(): boolean {
  const [allow, setAllow] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: no-preference)')
    const compute = () => setAllow(mq.matches)
    compute()
    mq.addEventListener('change', compute)
    return () => mq.removeEventListener('change', compute)
  }, [])
  return allow
}

export function MomentModel({ src, poster, thumbhash, alt, background, onAllError }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState<string | null>(null)
  // The still and the model fail independently: a poster whose gateways are
  // all exhausted must NOT retract the "view in 3D" affordance, so it
  // degrades to the thumbhash blur in place rather than reporting upward.
  const [posterFailed, setPosterFailed] = useState(false)
  const [modelLoaded, setModelLoaded] = useState(false)
  // null until the response's headers arrive — the readout says "connecting"
  // rather than inventing a number for a request nothing has answered yet.
  const [download, setDownload] = useState<ModelFetchProgress | null>(null)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  // The in-flight download's cancel, the live object URL, and a session
  // token: a result from a load the viewer has since exited (or re-tapped)
  // must never install itself over the newer state.
  const abortRef = useRef<AbortController | null>(null)
  const blobUrlRef = useRef<string | null>(null)
  const sessionRef = useRef(0)
  // Progress lands per stream chunk (tens of KB), which on a 30 MB model is
  // a thousand-plus events; the readout only needs ~10 renders a second.
  const lastProgressAtRef = useRef(0)
  // Gateway walk, mirroring MomentVideo's — memoized because the helper
  // reads `window.top` and sniffs the UA on every call.
  const urls = useMemo(() => modelFetchUrls(src), [src])

  const allowsMotion = useAllowsMotion()
  const onAllErrorRef = useRef(onAllError)
  onAllErrorRef.current = onAllError

  const releaseBlob = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current)
      blobUrlRef.current = null
    }
    setBlobUrl(null)
  }, [])

  // Stop whatever is in flight and forget its result.
  const cancel = useCallback(() => {
    sessionRef.current++
    abortRef.current?.abort()
    abortRef.current = null
    releaseBlob()
  }, [releaseBlob])

  const activate = useCallback(async () => {
    cancel()
    const session = sessionRef.current
    const controller = new AbortController()
    abortRef.current = controller
    setPhase('loading')
    setMessage(null)
    setModelLoaded(false)
    setDownload(null)
    try {
      // The element definition and the bytes are independent; fetch both at
      // once so the ~475 KB chunk is not serialized behind a 30 MB download.
      const [, fetched] = await Promise.all([
        import('@google/model-viewer'),
        fetchModelBlob(urls, {
          signal: controller.signal,
          onProgress: (p) => {
            if (sessionRef.current !== session) return
            const now = Date.now()
            const final = p.total !== null && p.loaded >= p.total
            if (!final && now - lastProgressAtRef.current < 100) return
            lastProgressAtRef.current = now
            setDownload(p)
          },
        }),
      ])
      if (sessionRef.current !== session) return
      // Point Draco/KTX2 at OUR copies — model-viewer otherwise fetches them
      // from www.gstatic.com at render time, an undeclared third-party origin
      // that would also break under an enforcing CSP. Draco compression is
      // the standard optimization for web-delivered GLBs (the mint form now
      // offers it), so this is the routine path, not an edge case. Set on the
      // global config the element constructor reads (lib/media/
      // modelViewerConfig — the static setter never held). See
      // public/model-decoders/README.md.
      configureModelViewerDecoders()
      // A fresh blob: URL per attempt. model-viewer caches loads by URL —
      // including failed ones — so the element must never see the same URL
      // twice; and nothing here has touched its cache with a gateway URL.
      const url = URL.createObjectURL(fetched.blob)
      blobUrlRef.current = url
      setBlobUrl(url)
      setPhase('active')
    } catch (err) {
      // An element-definition failure must not leave the download running.
      controller.abort()
      if (sessionRef.current !== session || isAbortError(err)) return
      setPhase('error')
      setMessage(
        err instanceof ModelFetchError
          ? err.message
          : 'Could not load the 3D viewer — check your connection and retry.',
      )
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }, [urls, cancel])

  const exit = useCallback(() => {
    cancel()
    setPhase('idle')
    setMessage(null)
    setModelLoaded(false)
    setDownload(null)
  }, [cancel])

  // Unmount (navigation, a scrolled-away sticky column) stops the download
  // and drops the blob rather than letting a 30 MB fetch finish for nobody.
  useEffect(() => () => cancel(), [cancel])

  // Events wired with addEventListener via a callback ref, NOT on*-props:
  // React's synthetic event system maps on*-props for known DOM elements,
  // NOT for custom elements, so the prop form would silently never fire.
  const attach = useCallback((node: HTMLElement | null) => {
    if (!node) return
    const onLoad = () => {
      setModelLoaded(true)
      // Parsed: the blob's job is done. Revoking now releases the extra copy
      // while the model stays resident in the element. model-viewer only
      // re-reads `src` when it changes, and it never does after this.
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }
    }
    const onError = () => {
      // The bytes passed the GLB magic check, so another gateway would only
      // serve the same file: this is the model itself, not the network.
      releaseBlob()
      setPhase('error')
      setMessage('This 3D model could not be displayed.')
    }
    node.addEventListener('load', onLoad)
    node.addEventListener('error', onError)
    return () => {
      node.removeEventListener('load', onLoad)
      node.removeEventListener('error', onError)
    }
  }, [releaseBlob])

  // Nothing left to show: the model is unusable AND no still survived.
  const hasStill = !!poster && !posterFailed
  useEffect(() => {
    if (phase === 'error' && !hasStill) onAllErrorRef.current?.()
  }, [phase, hasStill])

  const blur = thumbhashToBlurDataURL(thumbhash)
  // The VIEWER colour, which may be `transparent` — distinct from the opaque
  // one baked into the poster. See MODEL_BACKGROUNDS.
  const bg = modelViewerBg(background)

  // One still layer, shared by every state — so promoting to 3D never
  // re-fetches it — faded out only once the model has actually painted (a
  // GLB with a transparent background would otherwise composite over it).
  const still = hasStill ? (
    <MomentImage
      src={poster!}
      alt={alt}
      fill
      className="object-contain"
      sizes="(max-width: 768px) 100vw, 50vw"
      priority
      thumbhash={thumbhash}
      onAllError={() => setPosterFailed(true)}
    />
  ) : (
    <div
      className="absolute inset-0 bg-cover bg-center"
      style={{ backgroundColor: bg, ...(blur ? { backgroundImage: `url(${blur})` } : {}) }}
    />
  )

  if (phase === 'loading' || (phase === 'active' && blobUrl)) {
    const parsing = phase === 'active' && !modelLoaded
    return (
      // The backdrop is on this wrapper, behind everything, so the still is
      // visible over it for as long as the download and the parse take.
      <div className="absolute inset-0" style={{ backgroundColor: bg }}>
        <div
          className={`absolute inset-0 transition-opacity duration-300 ${
            modelLoaded ? 'opacity-0' : 'opacity-100'
          }`}
        >
          {still}
        </div>
        {phase === 'active' && blobUrl ? (
          <>
            {/* @ts-expect-error — custom element registered by the lazy import. */}
            <model-viewer
              ref={attach}
              src={blobUrl}
              alt={alt}
              camera-controls
              {...(allowsMotion ? { 'auto-rotate': true } : {})}
              shadow-intensity={MODEL_SHADOW_INTENSITY}
              environment-image={MODEL_ENVIRONMENT}
              touch-action="pan-y"
              style={{ width: '100%', height: '100%' }}
            />
          </>
        ) : null}
        {!modelLoaded && (
          // Chipped rather than bare: the backdrop is artist-chosen, so this
          // text can sit on white as easily as on near-black and grey-on-white
          // would be sub-AA.
          <p className="absolute bottom-4 left-1/2 -translate-x-1/2 px-2.5 py-1 bg-[#0d0d0d]/85 text-[11px] font-mono text-dim pointer-events-none whitespace-nowrap">
            loading 3D… {modelLoadReadout(download, parsing)}
          </p>
        )}
        <button
          type="button"
          onClick={exit}
          aria-label={phase === 'active' ? 'Exit 3D view' : 'Cancel 3D load'}
          className="absolute top-2 right-2 z-10 w-8 h-8 bg-[#0d0d0d]/80 border border-line flex items-center justify-center text-dim hover:text-ink transition-colors"
        >
          <X size={14} />
        </button>
      </div>
    )
  }

  return (
    <div className="absolute inset-0">
      {still}
      {/* The affordance. Sits over the still so it reads as "this artwork is
          3D", not as a stray control. */}
      <div className="absolute inset-0 flex items-end justify-center p-4 pointer-events-none">
        <button
          type="button"
          onClick={activate}
          disabled={urls.length === 0}
          className="pointer-events-auto flex items-center gap-2 px-4 py-2 bg-[#0d0d0d]/85 border border-line text-xs font-mono uppercase tracking-wider text-dim hover:text-ink hover:border-muted transition-colors disabled:opacity-60"
        >
          <Box size={13} strokeWidth={1.5} />
          {phase === 'error' ? 'retry 3D' : 'view in 3D'}
        </button>
      </div>
      {message && (
        <p className="absolute bottom-16 left-0 right-0 px-4 text-center text-[11px] font-mono text-muted">
          {message}
        </p>
      )}
    </div>
  )
}
