'use client'

import { useState, useEffect, useMemo } from 'react'
import { gatewayUrls } from '@/lib/arweave/gateways'
import { isWebKitOnlyUaString } from '@/lib/deviceUA'
import { isReactNativeWebView } from '@/lib/miniAppEnv'

/**
 * Walk the AR.IO / IPFS gateway pool for `uri` on render error. Resets when
 * `uri` changes; calls `onAllError` once every gateway is exhausted.
 *
 * Shared by MomentImage, MomentImg, MomentVideo — every on-chain media
 * render path uses this same walker for consistent fallback semantics.
 */
export function useFallbackUrl(uri: string, onAllError?: () => void) {
  const urls = useMemo(() => gatewayUrls(uri), [uri])
  const [index, setIndex] = useState(0)
  useEffect(() => { setIndex(0) }, [uri])
  return {
    url: index < urls.length ? urls[index] : null,
    onError: () => {
      const next = index + 1
      if (next >= urls.length) onAllError?.()
      setIndex(next)
    },
  }
}

export function isProxiable(uri: string): boolean {
  return uri.startsWith('ar://') || uri.startsWith('ipfs://')
}

/**
 * URL for the `/api/img` proxy. Pass `width` to request a server-side downscale
 * — the NextImage optimizer→proxy fallback uses this so a source too large for
 * next/image (it 413s) still degrades to a small image instead of streaming the
 * full-res original. Omit it (video, the lightbox, posters, the detail prefetch)
 * to stream the bytes untouched.
 */
export function proxyUrl(uri: string, width?: number): string {
  const w = width && width > 0 ? `&w=${Math.round(width)}` : ''
  return `/api/img?u=${encodeURIComponent(uri)}${w}`
}

/**
 * Candidate URLs for a <video> element's `src`, in fallback order.
 *
 * In iframe / WebKit-only contexts (Farcaster + Base Mini App webviews and
 * web embeds) a <video> fetching straight from a public gateway stalls on
 * the shared HTTP/2 connection pool exactly the way <img> does — the
 * gateway request hangs without failing, `loadeddata` never fires, and the
 * pooled element stays `visibility:hidden`, so the video never appears.
 * This is the same failure mode `skipDirectWalk` guards against for images;
 * the difference is video had no proxy path at all. Route those contexts
 * through `/api/img`, which races the gateway pool server-side and forwards
 * Range requests for seek/resume. Direct gateways follow as a fallback so a
 * proxy-only outage still degrades to the old behaviour.
 *
 * Top-level browsing keeps the original direct-gateway list (no proxy
 * egress cost): standalone Chrome/Safari fetch video direct without stalls.
 */
export function videoGatewayUrls(uri: string, forceProxy = false): string[] {
  const direct = gatewayUrls(uri)
  // `forceProxy` is the SSR escape hatch: the iframe/WebKit/RN checks below
  // are all client-only (window/navigator are undefined on the server), so a
  // server-rendered committed <video> — the detail page — would otherwise
  // emit the DIRECT url for every proxy-first surface and only flip to the
  // proxy on hydration, wasting a doomed direct fetch (aborted when the src
  // flips) on exactly the constrained surfaces the proxy protects. The detail
  // page threads its server-computed isWebKitOnlyUA() here so the SSR src
  // already matches what the client will play (iOS Safari, and the warpcast
  // RN host whose UA is WebKit-only) — no wasted fetch, no hydration src
  // divergence. Desktop Mini App (iframe, desktop UA) isn't server-detectable
  // and keeps the client-side flip; it's Chromium, which tolerates it.
  //
  // RN WebView (the mobile Mini App host) shares the constrained-pool failure
  // mode with iframes and its UA may carry neither WebKit nor mobile tokens —
  // include it explicitly so its video rides the proxy.
  if (isProxiable(uri) && (forceProxy || isInIframe() || isWebKitOnly() || isReactNativeWebView())) {
    return [proxyUrl(uri), ...direct]
  }
  return direct
}

/**
 * True on Safari (desktop + iOS) and any other WebKit-only context — Chrome
 * iOS (CriOS), Mini App iOS WKWebView, etc. False on Chromium-based browsers
 * (Chrome, Edge, Brave, Opera) which all include "Chrome" in their UA.
 *
 * Used to short-circuit the 'direct' gateway-walk fallback in MomentImage /
 * MomentImg: on WebKit, a stalled-but-not-yet-failed gateway request holds a
 * connection in the per-host pool for the browser's full ~30s timeout, and
 * stacked-up timeouts across a feed of cards can starve the entire UI (the
 * symptom: nav unresponsive, Safari "can barely inspect element" reports).
 * Chromium handles the same scenario gracefully — it parallelises + cancels
 * stalled fetches more aggressively — so we leave its path unchanged.
 *
 * The proxy already races every gateway server-side; if it failed there's
 * almost no chance the client-side walk through the same gateways succeeds.
 * Skipping the walk on WebKit trades a near-zero-yield resilience layer for
 * not melting the UI.
 *
 * UA-sniffing is a last-resort tactic — used here because there's no clean
 * feature test for "stalls hard on a saturated HTTP/2 host pool".
 */
export function isWebKitOnly(): boolean {
  if (typeof navigator === 'undefined') return false
  // Shared with the server's isWebKitOnlyUA (lib/serverDevice) via
  // lib/deviceUA so SSR predictions (video preload target) and this runtime
  // decision can never disagree.
  return isWebKitOnlyUaString(navigator.userAgent)
}

/**
 * True when our page is running inside an iframe (the Mini App context
 * on Farcaster web, Base App web, any other host that embeds us). False
 * for top-level browsing.
 *
 * Used together with isWebKitOnly() to skip the direct-gateway-walk
 * fallback: an iframe shares the parent page's HTTP/2 connection pool
 * (Farcaster.xyz makes its own analytics/wallet/CDN calls in parallel
 * with ours). Stalled gateway requests pile up in that shared pool
 * even on Chromium, producing the same symptom as Safari standalone —
 * permagate.io timeouts visible in the iframe's console.
 *
 * Top-level Chrome browsing kismet.art directly does NOT match this
 * check (self === top) and keeps the original direct-walk fallback.
 *
 * Cross-origin `window.top` access throws — caught and treated as
 * "definitely in an iframe" because a same-origin frame wouldn't throw.
 */
export function isInIframe(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.self !== window.top
  } catch {
    return true
  }
}
