'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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

export function MomentModel({ src, poster, thumbhash, alt, onAllError }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState<string | null>(null)
  // The still and the model fail independently: a poster whose gateways are
  // all exhausted must NOT retract the "view in 3D" affordance, so it
  // degrades to the thumbhash blur in place rather than reporting upward.
  const [posterFailed, setPosterFailed] = useState(false)
  // Gateway walk, mirroring useFallbackUrl. A GLB has the same fetch profile
  // as a video — one large binary pulled by an element we don't control — so
  // it takes videoGatewayUrls' rule verbatim: inside an iframe / WebKit-only
  // / RN webview a direct gateway fetch stalls on the shared HTTP/2 pool, so
  // lead with /api/img (no `w=`, which streams the bytes through untouched)
  // and keep the direct gateways behind it.
  const [gatewayIndex, setGatewayIndex] = useState(0)
  // Mirrored in a ref so the error handler can advance the walk without
  // doing it inside a setState updater — updaters must stay pure (React
  // may invoke one twice) and that one also has to decide "exhausted".
  const gatewayIndexRef = useRef(0)
  const urls = videoGatewayUrls(src)
  const url = gatewayIndex < urls.length ? urls[gatewayIndex] : null

  const elRef = useRef<HTMLElement | null>(null)
  const onAllErrorRef = useRef(onAllError)
  onAllErrorRef.current = onAllError

  const activate = useCallback(async () => {
    setPhase('loading')
    setMessage(null)
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

  // model-viewer reports load failures on its own `error` event. Attached
  // with addEventListener via a callback ref rather than an `onError` prop:
  // React's synthetic event system maps on*-props for known DOM elements,
  // NOT for custom elements, so the prop form would silently never fire.
  const attach = useCallback((node: HTMLElement | null) => {
    elRef.current = node
    if (!node) return
    const onError = () => {
      // Walk to the next gateway before giving up — a 404 during Arweave
      // propagation, or one stalled host, shouldn't be terminal.
      const next = gatewayIndexRef.current + 1
      if (next < urls.length) {
        gatewayIndexRef.current = next
        setGatewayIndex(next)
        return
      }
      setPhase('error')
      setMessage('This 3D model could not be loaded.')
    }
    node.addEventListener('error', onError)
    return () => node.removeEventListener('error', onError)
  }, [urls.length])

  // Nothing left to show: the model is unusable AND no still survived.
  const hasStill = !!poster && !posterFailed
  useEffect(() => {
    if (phase === 'error' && !hasStill) onAllErrorRef.current?.()
  }, [phase, hasStill])

  const blur = thumbhashToBlurDataURL(thumbhash)

  if (phase === 'active' && url) {
    return (
      <div className="absolute inset-0">
        {/* @ts-expect-error — custom element registered by the lazy import. */}
        <model-viewer
          ref={attach}
          src={url}
          alt={alt}
          camera-controls
          auto-rotate
          touch-action="pan-y"
          style={{ width: '100%', height: '100%', backgroundColor: 'transparent' }}
        />
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
      {poster && !posterFailed ? (
        <MomentImage
          src={poster}
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
      )}
      {/* The affordance. Centered over the still so it reads as "this
          artwork is 3D", not as a stray control. */}
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
