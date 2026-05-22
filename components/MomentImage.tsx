'use client'

import { useState, useEffect, useMemo } from 'react'
import Image, { type ImageProps } from 'next/image'
import { useFallbackUrl, isProxiable, proxyUrl, isWebKitOnly, isInIframe } from '@/lib/media/gateway'
import { trackPerf } from '@/lib/telemetry'

interface CommonProps {
  /** Raw URI: ar://, ipfs://, https://, blob:, or data: */
  src: string
  /** Fired once every fallback has errored, so the parent can swap in a placeholder. */
  onAllError?: () => void
}

function isGifMime(mime?: string): boolean {
  return mime === 'image/gif'
}

// ar:// content is hash-addressed and has no extension at the URL level, so
// this only fires for the rare `https://.../foo.gif` — the mime hint is the
// reliable signal.
function isGifUri(url: string): boolean {
  return url.split(/[?#]/, 1)[0].toLowerCase().endsWith('.gif')
}

type DeliveryMode = 'optimized' | 'proxy' | 'direct'

type NextImageProps = CommonProps & {
  /** Content-type hint (`content.mime`). `image/gif` routes straight to the proxy. */
  mime?: string
  /**
   * Skip the optimizer attempt and go straight to the proxy. For cover-style
   * contexts where the source is typically heavy enough that the optimizer
   * 413's anyway — saves the failed-optimizer round-trip and replaces a
   * single-source arweave.net fetch with the proxy's parallel-gateway race.
   * Tradeoff: forgoes AVIF/WebP transcode + downscaling, so apply only for
   * medium-or-larger display sizes where unoptimized bytes are acceptable.
   */
  preferProxy?: boolean
  /**
   * Base64 thumbhash from moment metadata. Decoded inline and passed as
   * next/image's blurDataURL — paints an instant low-fi preview behind the
   * loading image, in place of the skeleton overlay.
   */
  thumbhash?: string
} & Omit<ImageProps, 'src' | 'onError'>

/**
 * next/image wrapper with three delivery modes:
 *   - 'optimized': next/image's optimizer (AVIF/WebP transcode + 31d edge cache)
 *   - 'proxy':     /api/img streams from the gateway pool with 1y immutable cache;
 *                  used for content the optimizer can't handle (animated GIFs, >4MB)
 *   - 'direct':    raw gateway URL with unoptimized=true; defense-in-depth fallback
 *
 * Transitions: optimized → proxy (ar:/ipfs:) | direct (else)
 *              proxy     → direct
 *              direct    → walk next gateway → onAllError
 */
export function MomentImage({ src, onAllError, mime, preferProxy, thumbhash: _thumbhash, priority, ...rest }: NextImageProps) {
  const { url, onError: walkGateway } = useFallbackUrl(src, onAllError)
  const proxiable = isProxiable(src)
  // Reads `src` (not `url`) so the decision is stable across gateway walks.
  const skipOptimizer = preferProxy || isGifMime(mime) || isGifUri(src)
  // Memoized once at mount — sniffing UA on every error would be wasteful.
  // Skip the direct-gateway-walk fallback on:
  //   - WebKit (Safari + iOS Mini App webview): stalls Safari's connection
  //     pool, see isWebKitOnly() in lib/media/gateway.ts
  //   - Any iframe context (Mini App on Farcaster web, Base App web,
  //     etc.): the iframe shares the parent page's HTTP/2 connection
  //     pool with Farcaster's own analytics + wallet + CDN calls, so
  //     even Chromium-in-iframe sees the same stalls — symptom: the
  //     console fills with permagate.io timeouts on desktop Mini App
  //     even though desktop Chrome standalone is fine.
  //
  // Top-level Chrome (kismet.art opened directly) is neither WebKit
  // nor in an iframe — `skipDirectWalk` is false and the existing
  // direct-walk fallback runs unchanged.
  const skipDirectWalk = useMemo(() => isWebKitOnly() || isInIframe(), [])

  const initialMode: DeliveryMode = skipOptimizer
    ? (proxiable ? 'proxy' : 'direct')
    : 'optimized'
  const [mode, setMode] = useState<DeliveryMode>(initialMode)
  // `url` is intentionally NOT a dep — walking gateways must stay in
  // 'direct' rather than restarting the state machine.
  useEffect(() => { setMode(initialMode) }, [src, initialMode])

  // 'proxy' uses one stable URL — the proxy fans out internally.
  const renderUrl = mode === 'proxy' ? proxyUrl(src) : url
  const unoptimized = mode !== 'optimized'

  const [loaded, setLoaded] = useState(false)
  useEffect(() => { setLoaded(false) }, [renderUrl, unoptimized])

  if (!renderUrl) return null

  const handleError = () => {
    if (mode === 'optimized') {
      // Optimizer 413'd or refused the format. Prefer proxy (edge-caches the
      // bytes); fall back to unoptimized direct for non-proxiable sources.
      // On WebKit + non-proxiable source we have to walk direct — no proxy
      // path available — but at least skipDirectWalk doesn't apply here
      // because there's no proxy attempt to short-circuit out of.
      //
      // Telemetry: record the optimizer-bypass event so we can spot
      // systemic content-type issues (e.g., creators uploading videos
      // as cover images) without trawling the production logs.
      trackPerf('optimizer_400', 1)
      setMode(proxiable ? 'proxy' : 'direct')
      return
    }
    if (mode === 'proxy') {
      // Proxy already raced every gateway; direct is mostly defensive,
      // handles a proxy-only outage (deploy in flight, etc.).
      //
      // EXCEPT on WebKit: stalled-but-not-yet-failed direct fetches hold
      // per-host HTTP/2 connections for the browser's full timeout window
      // (~30s) and stacked timeouts across a feed of cards saturate the
      // pool, freezing the whole UI (nav included). Skip straight to
      // onAllError on WebKit — the poster placeholder is a better outcome
      // than a frozen browser.
      if (skipDirectWalk) {
        onAllError?.()
        return
      }
      setMode('direct')
      return
    }
    walkGateway()
  }

  return (
    <>
      {/* Persistent branded skeleton — animates while loading, sits
          underneath the loaded image, and resurfaces if iOS WebKit
          evicts the decoded bytes on scroll-off. The accent-tinted
          fill is the codebase's brand color at 10% so it reads as a
          subtle Kismet shade instead of a bright placeholder. */}
      <span
        aria-hidden
        className={`absolute inset-0 bg-accent/10 pointer-events-none ${loaded ? '' : 'animate-pulse'}`}
      />
      {/* Key includes mode-derived flags so next/image actually remounts
          on transitions — without this, the failed src stays cached
          internally and onError won't refire. */}
      {/* eslint-disable-next-line jsx-a11y/alt-text */}
      <Image
        key={`${renderUrl}::${unoptimized}`}
        src={renderUrl}
        unoptimized={unoptimized}
        onError={handleError}
        onLoad={() => setLoaded(true)}
        decoding="async"
        // Force eager loading on iOS WebKit + iframe contexts. Native
        // loading="lazy" has a documented WebKit bug (bug 200764) that
        // fails to re-fetch/decode after scroll-back on Safari 15.4+,
        // producing the "skeleton stays stuck on scroll-back" symptom.
        // Use fetchPriority="auto" to avoid the high-priority side
        // effect that next/image normally pairs with `priority` —
        // we want eager loading without the LCP-boost (which would
        // make every card compete for bandwidth equally and defeat
        // first-row prioritisation).
        priority={priority || skipDirectWalk}
        fetchPriority={!priority && skipDirectWalk ? 'auto' : undefined}
        {...rest}
      />
    </>
  )
}

type ImgProps = CommonProps & Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onError'> & {
  /** Skip the `/api/img` proxy and go straight to the gateway pool.
   *  Trades the proxy's multi-gateway race + edge cache for zero
   *  bandwidth cost on our server — appropriate for high-volume
   *  surfaces (every video moment's poster image) where the bytes
   *  through the proxy add up across the user base. Gateway walking
   *  still happens via `useFallbackUrl` on error. */
  skipProxy?: boolean
  /** Above-the-fold hint — eager + fetchPriority="high" when true,
   *  loading="lazy" when false. Default-lazy means callers showing an
   *  image as soon as it mounts (lightbox, modals) need to pass true
   *  explicitly. */
  priority?: boolean
}

/**
 * Plain <img> for the lightbox + edit-preview thumbnail (raw <img> needed
 * for blob: URLs from the file picker, which next/image's optimizer rejects).
 * Two-stage: proxy first for ar://ipfs:// — shares the edge cache populated
 * by MomentImage — then walks the gateway pool on proxy error.
 *
 * `skipProxy` opts out of the proxy stage entirely. The image fetches
 * direct from the first gateway URL with onError → walk semantics. Used
 * by high-volume surfaces where streaming the image bytes through our
 * own server (CPU + egress on every fetch) outweighs the proxy's
 * resilience benefit.
 */
export function MomentImg({ src, onAllError, skipProxy, priority, ...rest }: ImgProps) {
  const { url: walkedUrl, onError: walkGateway } = useFallbackUrl(src, onAllError)
  const proxiable = isProxiable(src) && !skipProxy
  const [proxyFailed, setProxyFailed] = useState(false)
  useEffect(() => { setProxyFailed(false) }, [src])
  // Same gateway-walk short-circuit as MomentImage's proxy→direct
  // transition. Skip on WebKit OR in any iframe context — both share
  // the connection-pool-stall failure mode. See lib/media/gateway.ts.
  const skipDirectWalk = useMemo(() => isWebKitOnly() || isInIframe(), [])

  const useProxy = proxiable && !proxyFailed
  const renderUrl = useProxy ? proxyUrl(src) : walkedUrl
  if (!renderUrl) return null

  const handleError = useProxy
    ? () => {
        // Proxy failed: on WebKit, surrender to the poster fallback
        // instead of starting a direct-mode gateway walk that's likely
        // to stall the browser's connection pool. See gateway.ts.
        // skipProxy=true paths intentionally bypass proxy entirely and
        // walk directly — those callers (video posters etc.) accept
        // the trade-off knowingly and we don't override them.
        if (skipDirectWalk) {
          onAllError?.()
          return
        }
        setProxyFailed(true)
      }
    : walkGateway

  // alt comes through ...rest.
  return (
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    <img
      key={renderUrl}
      src={renderUrl}
      onError={handleError}
      decoding="async"
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : undefined}
      {...rest}
    />
  )
}
