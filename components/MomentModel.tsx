'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, X } from 'lucide-react'
import { MomentImage } from './MomentImage'
import { videoGatewayUrls } from '@/lib/media/gateway'
import { thumbhashToBlurDataURL } from '@/lib/media/thumbhash'

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
 * The still STAYS MOUNTED beneath the viewer until the model's own `load`
 * fires — the `showPosterLayer` pattern MomentVideo already uses. Without
 * it, tapping trades a finished artwork for an empty box for as long as a
 * 30 MB download takes, which is worst on exactly the connections this
 * feature is most exposed on. The progress readout covers the same case.
 *
 * Exiting unmounts the element, which is what actually releases the context
 * — worth having on a sticky media column a viewer may scroll past.
 */

type Phase = 'idle' | 'loading' | 'active' | 'error'

interface Props {
  /** Raw GLB URI (ar:// / ipfs:// / https://). */
  src: string
  /** Raw still URI. Absent on a model minted without one. */
  poster?: string
  thumbhash?: string
  alt: string
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

export function MomentModel({ src, poster, thumbhash, alt, onAllError }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState<string | null>(null)
  // The still and the model fail independently: a poster whose gateways are
  // all exhausted must NOT retract the "view in 3D" affordance, so it
  // degrades to the thumbhash blur in place rather than reporting upward.
  const [posterFailed, setPosterFailed] = useState(false)
  const [modelLoaded, setModelLoaded] = useState(false)
  const [progress, setProgress] = useState(0)
  // Gateway walk, mirroring useFallbackUrl. A GLB has the same fetch profile
  // as a video — one large binary pulled by an element we don't control — so
  // it takes videoGatewayUrls' rule verbatim: inside an iframe / WebKit-only
  // / RN webview a direct gateway fetch stalls on the shared HTTP/2 pool, so
  // lead with /api/img (no `w=`, which streams the bytes through untouched)
  // and keep the direct gateways behind it. Memoized because that helper
  // reads `window.top` and sniffs the UA on every call.
  const [gatewayIndex, setGatewayIndex] = useState(0)
  const urls = useMemo(() => videoGatewayUrls(src), [src])
  const url = gatewayIndex < urls.length ? urls[gatewayIndex] : null

  const allowsMotion = useAllowsMotion()
  const onAllErrorRef = useRef(onAllError)
  onAllErrorRef.current = onAllError

  const activate = useCallback(async () => {
    setPhase('loading')
    setMessage(null)
    setModelLoaded(false)
    setProgress(0)
    // Restart the walk. The likeliest real failure here is an Arweave
    // propagation 404 moments after a mint, which resolves on its own — so a
    // retry that only re-hit the last exhausted gateway would be the single
    // attempt least likely to succeed.
    setGatewayIndex(0)
    try {
      // Defined before <model-viewer> renders; see the bundle note above.
      const mod = await import('@google/model-viewer')
      // Point Draco/KTX2 at OUR copies — model-viewer otherwise fetches them
      // from www.gstatic.com at render time, an undeclared third-party origin
      // that would also break under an enforcing CSP. Draco compression is
      // the standard optimization for web-delivered GLBs, so this is the
      // routine path, not an edge case. See public/model-decoders/README.md.
      mod.ModelViewerElement.dracoDecoderLocation = '/model-decoders/draco/'
      mod.ModelViewerElement.ktx2TranscoderLocation = '/model-decoders/basis/'
      setPhase('active')
    } catch {
      setPhase('error')
      setMessage('Could not load the 3D viewer — check your connection and retry.')
    }
  }, [])

  // Events wired with addEventListener via a callback ref, NOT on*-props:
  // React's synthetic event system maps on*-props for known DOM elements,
  // NOT for custom elements, so the prop form would silently never fire.
  // `gatewayIndex` is read from this closure and declared as a dep, so the
  // walk keeps ONE source of truth; React re-runs the ref (cleanup first) on
  // each step, which is also exactly when the element's `src` changes.
  const attach = useCallback((node: HTMLElement | null) => {
    if (!node) return
    const onLoad = () => setModelLoaded(true)
    const onProgress = (e: Event) => {
      const total = (e as CustomEvent<{ totalProgress?: number }>).detail?.totalProgress
      if (typeof total === 'number') setProgress(total)
    }
    const onError = () => {
      // Walk to the next gateway before giving up — a 404 during Arweave
      // propagation, or one stalled host, shouldn't be terminal.
      if (gatewayIndex + 1 < urls.length) {
        setGatewayIndex(gatewayIndex + 1)
        return
      }
      setPhase('error')
      setMessage('This 3D model could not be loaded.')
    }
    node.addEventListener('load', onLoad)
    node.addEventListener('progress', onProgress)
    node.addEventListener('error', onError)
    return () => {
      node.removeEventListener('load', onLoad)
      node.removeEventListener('progress', onProgress)
      node.removeEventListener('error', onError)
    }
  }, [gatewayIndex, urls.length])

  // Nothing left to show: the model is unusable AND no still survived.
  const hasStill = !!poster && !posterFailed
  useEffect(() => {
    if (phase === 'error' && !hasStill) onAllErrorRef.current?.()
  }, [phase, hasStill])

  const blur = thumbhashToBlurDataURL(thumbhash)

  // One still layer, shared by the idle and active states — so promoting to
  // 3D never re-fetches it — faded out only once the model has actually
  // painted (a GLB with a transparent background would otherwise composite
  // over it).
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
      className="absolute inset-0 bg-surface bg-cover bg-center"
      style={blur ? { backgroundImage: `url(${blur})` } : undefined}
    />
  )

  if (phase === 'active' && url) {
    return (
      <div className="absolute inset-0">
        <div
          className={`absolute inset-0 transition-opacity duration-300 ${
            modelLoaded ? 'opacity-0' : 'opacity-100'
          }`}
        >
          {still}
        </div>
        {/* @ts-expect-error — custom element registered by the lazy import. */}
        <model-viewer
          ref={attach}
          src={url}
          alt={alt}
          camera-controls
          {...(allowsMotion ? { 'auto-rotate': true } : {})}
          touch-action="pan-y"
          style={{ width: '100%', height: '100%', backgroundColor: 'transparent' }}
        />
        {!modelLoaded && (
          <p className="absolute bottom-4 left-0 right-0 text-center text-[11px] font-mono text-muted pointer-events-none">
            loading 3D… {Math.round(progress * 100)}%
          </p>
        )}
        <button
          type="button"
          onClick={() => setPhase('idle')}
          aria-label="Exit 3D view"
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
          disabled={phase === 'loading' || !url}
          className="pointer-events-auto flex items-center gap-2 px-4 py-2 bg-[#0d0d0d]/85 border border-line text-xs font-mono uppercase tracking-wider text-dim hover:text-ink hover:border-muted transition-colors disabled:opacity-60"
        >
          <Box size={13} strokeWidth={1.5} />
          {phase === 'loading' ? 'loading 3D…' : phase === 'error' ? 'retry 3D' : 'view in 3D'}
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
